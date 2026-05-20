"""Databricks SQL connection factory."""

import hashlib
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Generator

# Per-request user token set by UserAuthMiddleware when x-forwarded-access-token
# is present (Databricks Apps user authorization preview). Empty string = use SP.
_user_token: ContextVar[str] = ContextVar("_user_token", default="")

# Persisted auth-mode override file (written by POST /api/settings/auth-mode)
_AUTH_MODE_OVERRIDE_FILE = os.path.join(
    os.path.dirname(__file__), "..", ".settings", "auth_mode_override.json"
)


def _load_auth_mode_override() -> str:
    """Read the persisted auth mode preference. Returns 'sp' or 'unknown'."""
    try:
        if os.path.exists(_AUTH_MODE_OVERRIDE_FILE):
            with open(_AUTH_MODE_OVERRIDE_FILE) as f:
                data = json.load(f)
            if data.get("mode") == "sp":
                return "sp"
    except Exception:
        pass
    return "unknown"


# Auth mode is permanently locked to "sp". OAuth/user-token auth is preserved in
# the codebase for future use but is not active. The UserAuthMiddleware already
# gates on this value and will not forward user tokens when mode is "sp".
_auth_mode: str = "sp"  # always "sp" — OAuth disabled until further notice


def _lock_auth_mode(mode: str) -> None:
    """No-op — auth mode is permanently 'sp'. Kept for call-site compatibility."""
    if mode != "sp":
        logger.debug("_lock_auth_mode('%s') ignored — OAuth disabled, always SP.", mode)


def set_auth_mode_override(mode: str) -> None:
    """No-op stub — OAuth is disabled; auth mode is permanently 'sp'.

    Kept for call-site compatibility. The override file and Delta table writes
    are skipped. When OAuth is re-enabled in the future, restore the original
    implementation from git history.
    """
    if mode != "sp":
        logger.warning(
            "set_auth_mode_override('%s') ignored — OAuth is disabled. "
            "Auth mode is permanently locked to 'sp'.", mode
        )
    # Always keep _auth_mode as "sp" — no mutation needed

from cachetools import TTLCache
from databricks import sql
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import (
    CreateWarehouseRequestWarehouseType,
    EndpointInfoWarehouseType,
    SpotInstancePolicy,
    State,
)

logger = logging.getLogger(__name__)


def get_host_url() -> str:
    """Return the Databricks workspace URL with https:// prefix.

    Handles the common case where DATABRICKS_HOST is set to just the hostname
    (e.g. 'fevm-cmegdemos.cloud.databricks.com') without a protocol prefix,
    as well as when the full URL is provided. Falls back to SDK config.
    """
    host = os.getenv("DATABRICKS_HOST", "")
    if not host:
        # Try SDK workspace client (works in Databricks Apps with OAuth)
        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            host = w.config.host or ""
        except Exception:
            pass
    if not host:
        return ""
    host = host.rstrip("/")
    if not host.startswith("https://") and not host.startswith("http://"):
        host = f"https://{host}"
    return host


def get_catalog_schema() -> tuple[str, str]:
    """Return the catalog and schema for cost observability tables.

    Source: COST_OBS_CATALOG / COST_OBS_SCHEMA env vars (set in app.yaml).
    Defaults to main.cost_obs when env vars are absent.
    """
    catalog = os.getenv("COST_OBS_CATALOG", "main")
    schema = os.getenv("COST_OBS_SCHEMA", "cost_obs")
    return catalog, schema


# ── MV table name overrides ─────────────────────────────────────────────────

_MV_OVERRIDES_FILE = os.path.join(
    os.path.dirname(__file__), "..", ".settings", "mv_table_overrides.json"
)


def get_mv_table_overrides() -> dict[str, str]:
    """Load per-table overrides mapping logical name → fully-qualified table path.

    Returns empty dict when no overrides are configured.
    """
    try:
        with open(_MV_OVERRIDES_FILE) as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str) and v.strip()}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_mv_table_overrides(overrides: dict[str, str]) -> None:
    """Persist MV table overrides."""
    os.makedirs(os.path.dirname(_MV_OVERRIDES_FILE), exist_ok=True)
    with open(_MV_OVERRIDES_FILE, "w") as f:
        json.dump(overrides, f, indent=2)
    logger.info("MV table overrides saved: %s", list(overrides.keys()))


def apply_mv_overrides(sql: str, catalog: str, schema: str) -> str:
    """Replace default table references with custom overrides in a SQL string."""
    overrides = get_mv_table_overrides()
    if not overrides:
        return sql
    for logical_name, full_path in overrides.items():
        sql = sql.replace(f"{catalog}.{schema}.{logical_name}", full_path)
        sql = sql.replace(f"`{catalog}`.`{schema}`.`{logical_name}`", full_path)
    return sql


def get_catalog_schema_info() -> dict:
    """Return catalog/schema info for the settings read-only display."""
    catalog = os.getenv("COST_OBS_CATALOG", "main")
    schema = os.getenv("COST_OBS_SCHEMA", "cost_obs")
    return {"catalog": catalog, "schema": schema, "source": "env"}


# Dedicated warehouse configuration
DEDICATED_WAREHOUSE_NAME = "Cost Observability App"
DEDICATED_WAREHOUSE_SIZE = "Large"  # Large for 14+ parallel queries
DEDICATED_WAREHOUSE_MIN_CLUSTERS = 1
DEDICATED_WAREHOUSE_MAX_CLUSTERS = 2
DEDICATED_WAREHOUSE_AUTO_STOP_MINS = 10

# Bounded TTL cache for query results (2 hour TTL, max 500 entries, ~1GB limit)
# Using cachetools.TTLCache to prevent unbounded memory growth
_CACHE_MAX_SIZE = 500  # Max number of cached queries
_CACHE_TTL = 4 * 60 * 60  # 4 hours - cost data doesn't change intra-day
_query_cache: TTLCache = TTLCache(maxsize=_CACHE_MAX_SIZE, ttl=_CACHE_TTL)

# SQL connection timeout in seconds
# Set high to accommodate slow system table scans (system.query.history 30-day range)
_CONNECTION_TIMEOUT = 300


def clear_query_cache(pattern: str | None = None) -> int:
    """Clear the query cache.

    Args:
        pattern: Optional string pattern to match cache keys.
                 If provided, only clears matching entries.
                 If None, clears entire cache.

    Returns:
        Number of entries cleared
    """
    global _query_cache
    if pattern is None:
        count = len(_query_cache)
        _query_cache.clear()
        logger.info(f"Cleared entire query cache ({count} entries)")
        return count
    else:
        # Clear entries matching pattern
        keys_to_clear = [k for k in _query_cache.keys() if pattern in k]
        for key in keys_to_clear:
            del _query_cache[key]
        logger.info(f"Cleared {len(keys_to_clear)} cache entries matching '{pattern}'")
        return len(keys_to_clear)

# Singleton WorkspaceClient instance
_workspace_client: WorkspaceClient | None = None


def get_workspace_client() -> WorkspaceClient:
    """Get or create a singleton WorkspaceClient instance.

    This prevents creating a new client on every request, which is expensive.
    The client is thread-safe and can be shared across requests.
    """
    global _workspace_client

    if _workspace_client is None:
        token = os.getenv("DATABRICKS_TOKEN")
        host = os.getenv("DATABRICKS_HOST")

        if token and host:
            # Local development with explicit credentials
            _workspace_client = WorkspaceClient(host=host, token=token)
        else:
            # Databricks App environment - use default auth
            _workspace_client = WorkspaceClient()

        logger.info("Created WorkspaceClient singleton")

    return _workspace_client


def get_user_workspace_client() -> WorkspaceClient:
    """Get a WorkspaceClient using the current request's OAuth token if available.

    Falls back to the SP singleton when no user token is in context.
    Used for SDK calls (warehouse listing, etc.) that should run as the user
    rather than the SP so they respect the user's permissions.
    """
    user_token = _user_token.get()
    if user_token and _auth_mode != "sp":
        host = os.getenv("DATABRICKS_HOST", "")
        if host:
            # Databricks Apps injects DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET for
            # the SP, so any WorkspaceClient() call also picks them up from env.  When we
            # ALSO pass token=user_token the SDK sees two auth methods ("pat" + "oauth") and
            # raises "more than one authorization method configured".
            #
            # Setting auth_type="pat" is the SDK-supported escape hatch: _validate() returns
            # early when auth_type is set (line 668 of config.py), and init_auth() then uses
            # the PAT credential provider, ignoring the M2M OAuth env vars.
            return WorkspaceClient(host=host, token=user_token, auth_type="pat")
    return get_workspace_client()


def ensure_dedicated_warehouse() -> tuple[str, str]:
    """Ensure a dedicated serverless SQL warehouse exists for the app.

    Creates a Large serverless warehouse if one doesn't exist with the expected name.
    Returns the warehouse ID and HTTP path.

    Returns:
        Tuple of (warehouse_id, http_path)
    """
    w = get_workspace_client()

    # Check if dedicated warehouse already exists
    logger.info(f"Checking for dedicated warehouse: {DEDICATED_WAREHOUSE_NAME}")
    existing_warehouses = list(w.warehouses.list())

    for warehouse in existing_warehouses:
        if warehouse.name == DEDICATED_WAREHOUSE_NAME:
            warehouse_id = warehouse.id
            http_path = f"/sql/1.0/warehouses/{warehouse_id}"
            logger.info(f"Found existing dedicated warehouse: {warehouse_id} ({warehouse.cluster_size})")

            # Check if warehouse needs to be started
            if warehouse.state in [State.STOPPED, State.STOPPING]:
                logger.info(f"Starting warehouse {warehouse_id}...")
                w.warehouses.start(warehouse_id)

            # Check if it's undersized and warn
            size_order = ["2X-Small", "X-Small", "Small", "Medium", "Large", "X-Large", "2X-Large", "3X-Large", "4X-Large"]
            current_idx = size_order.index(warehouse.cluster_size) if warehouse.cluster_size in size_order else -1
            target_idx = size_order.index(DEDICATED_WAREHOUSE_SIZE) if DEDICATED_WAREHOUSE_SIZE in size_order else 4

            if current_idx < target_idx:
                logger.warning(
                    f"Dedicated warehouse is sized {warehouse.cluster_size}, "
                    f"but {DEDICATED_WAREHOUSE_SIZE} is recommended. Consider resizing for better performance."
                )

            return warehouse_id, http_path

    # Create new dedicated warehouse
    logger.info(f"Creating dedicated serverless warehouse: {DEDICATED_WAREHOUSE_NAME} ({DEDICATED_WAREHOUSE_SIZE})")

    try:
        warehouse = w.warehouses.create(
            name=DEDICATED_WAREHOUSE_NAME,
            cluster_size=DEDICATED_WAREHOUSE_SIZE,
            warehouse_type=CreateWarehouseRequestWarehouseType.PRO,
            enable_serverless_compute=True,
            min_num_clusters=DEDICATED_WAREHOUSE_MIN_CLUSTERS,
            max_num_clusters=DEDICATED_WAREHOUSE_MAX_CLUSTERS,
            auto_stop_mins=DEDICATED_WAREHOUSE_AUTO_STOP_MINS,
            spot_instance_policy=SpotInstancePolicy.COST_OPTIMIZED,
        )

        warehouse_id = warehouse.id
        http_path = f"/sql/1.0/warehouses/{warehouse_id}"

        logger.info("=" * 60)
        logger.info("Created Dedicated SQL Warehouse")
        logger.info("=" * 60)
        logger.info(f"  Name: {DEDICATED_WAREHOUSE_NAME}")
        logger.info(f"  ID: {warehouse_id}")
        logger.info(f"  Size: {DEDICATED_WAREHOUSE_SIZE}")
        logger.info(f"  Type: Serverless")
        logger.info(f"  Min Clusters: {DEDICATED_WAREHOUSE_MIN_CLUSTERS}")
        logger.info(f"  Max Clusters: {DEDICATED_WAREHOUSE_MAX_CLUSTERS}")
        logger.info(f"  Auto-Stop: {DEDICATED_WAREHOUSE_AUTO_STOP_MINS} minutes")
        logger.info("=" * 60)

        return warehouse_id, http_path

    except Exception as e:
        logger.error(f"Failed to create dedicated warehouse: {e}")
        raise


def setup_warehouse_connection() -> str:
    """Set up the warehouse connection for the app.

    Priority:
    1. DATABRICKS_HTTP_PATH env var (explicit path set in app.yaml)
    2. DATABRICKS_WAREHOUSE_ID env var — injected by Databricks Apps when a
       sql_warehouse resource is declared with valueFrom in app.yaml

    The warehouse is fixed at deploy time and cannot be changed via the settings
    UI. To switch warehouses, update the app resource binding and redeploy.

    Returns:
        The HTTP path being used
    """
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")

    if http_path and http_path.lower() != "auto":
        logger.info(f"Using configured warehouse: {http_path}")
        return http_path

    # Databricks Apps sql_warehouse resource binding
    warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID", "")
    if warehouse_id:
        http_path = f"/sql/1.0/warehouses/{warehouse_id}"
        os.environ["DATABRICKS_HTTP_PATH"] = http_path
        logger.info(f"Using warehouse from DATABRICKS_WAREHOUSE_ID resource: {http_path}")
        return http_path

    raise ValueError(
        "No SQL warehouse configured. Set DATABRICKS_HTTP_PATH to an explicit warehouse path "
        "(e.g. /sql/1.0/warehouses/<id>) in app.yaml, or add a sql_warehouse resource binding "
        "so DATABRICKS_WAREHOUSE_ID is injected automatically."
    )


def _get_cache_key(query: str, params: dict[str, Any] | None, *, tag: str | None = None) -> str:
    """Generate a cache key from query and params.

    When running under user authorization, the token hash is included so each
    user's results are cached independently (respects row/column-level security).

    Args:
        tag: Optional prefix for pattern-based cache invalidation (e.g. "use_case").
    """
    key_data = query + json.dumps(params or {}, sort_keys=True)
    token = _user_token.get()
    if token:
        # Use first 16 chars of token hash — enough to distinguish users without
        # exposing the token itself in log output or cache inspection.
        token_prefix = hashlib.md5(token.encode()).hexdigest()[:16]
        key_data = token_prefix + ":" + key_data
    hash_key = hashlib.md5(key_data.encode()).hexdigest()
    return f"{tag}:{hash_key}" if tag else hash_key


def _strip_host_scheme(host: str) -> str:
    """Strip https:// or http:// from a hostname."""
    if host.startswith("https://"):
        return host[8:]
    elif host.startswith("http://"):
        return host[7:]
    return host


def _is_scope_error(exc: Exception) -> bool:
    """Return True if exception indicates the token lacks the 'sql' OAuth scope."""
    msg = str(exc).lower()
    return "required scopes" in msg or "does not have required scopes" in msg


def _is_permission_error(exc: Exception) -> bool:
    """Return True if exception indicates the user token lacks table/schema privileges."""
    msg = str(exc).lower()
    return any(s in msg for s in (
        "permission_denied", "insufficient_privileges", "not authorized",
        "user does not have", "does not have privilege",
    ))


@contextmanager
def get_connection() -> Generator[Any, None, None]:
    """Get a Databricks SQL connection as a context manager.

    Auth priority:
    1. Per-request user token from x-forwarded-access-token (user authorization
       preview — set by UserAuthMiddleware when the feature is enabled).
    2. DATABRICKS_TOKEN env var (local dev with explicit PAT/token).
    3. SP OAuth via WorkspaceClient (standard Databricks Apps SP identity).
    """
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")

    if not http_path:
        # Startup warehouse resolution may have failed — try again lazily.
        # This handles cases where DATABRICKS_WAREHOUSE_ID is injected by the
        # Apps resource binding but setup_warehouse_connection() failed at boot.
        try:
            http_path = setup_warehouse_connection()
        except Exception as e:
            raise ValueError(
                "SQL warehouse not configured. "
                "Add a SQL warehouse resource (key: sql-warehouse) in the Databricks Apps UI, "
                "or set DATABRICKS_HTTP_PATH explicitly in app.yaml."
            ) from e

    # 1. User authorization (Databricks Apps preview feature)
    user_token = _user_token.get()
    if user_token:
        host = os.getenv("DATABRICKS_HOST", "")
        if not host:
            w = get_workspace_client()
            host = w.config.host or ""
        conn = sql.connect(
            server_hostname=_strip_host_scheme(host),
            http_path=http_path,
            access_token=user_token,
            _socket_timeout=_CONNECTION_TIMEOUT,
        )
        try:
            yield conn
        finally:
            conn.close()
        return

    dev_token = os.getenv("DATABRICKS_TOKEN")
    dev_host = os.getenv("DATABRICKS_HOST")

    if dev_token and dev_host:
        # 2. Local development with explicit credentials
        conn = sql.connect(
            server_hostname=_strip_host_scheme(dev_host),
            http_path=http_path,
            access_token=dev_token,
            _socket_timeout=_CONNECTION_TIMEOUT,
        )
    else:
        # 3. Databricks App environment — use SP OAuth token from SDK
        w = get_workspace_client()
        config = w.config
        server_hostname = _strip_host_scheme(config.host)

        # config.authenticate() returns {"Authorization": "Bearer <token>"}
        headers = config.authenticate()
        access_token = headers.get("Authorization", "").replace("Bearer ", "")
        if not access_token:
            raise ValueError("Failed to get OAuth token from WorkspaceClient")

        conn = sql.connect(
            server_hostname=server_hostname,
            http_path=http_path,
            access_token=access_token,
            _socket_timeout=_CONNECTION_TIMEOUT,
        )

    try:
        yield conn
    finally:
        conn.close()


def execute_write(query: str, params: dict[str, Any] | None = None) -> int:
    """Execute a write operation (INSERT/UPDATE/DELETE) and return affected rows.

    Does not cache results as these are write operations.
    Delta tables auto-commit every DML statement; explicit commit() is not needed
    and may raise NotSupportedError on some connector versions.
    """
    start_time = time.time()

    def _run(force_sp: bool = False) -> int:
        ctx_tok = _user_token.set("") if force_sp else None
        try:
            with get_connection() as conn:
                with conn.cursor() as cursor:
                    if params:
                        cursor.execute(query, params)
                    else:
                        cursor.execute(query)
                    return cursor.rowcount if cursor.rowcount is not None else 0
        finally:
            if ctx_tok is not None:
                _user_token.reset(ctx_tok)

    try:
        affected_rows = _run()
        if _user_token.get() and _auth_mode == "unknown":
            _lock_auth_mode("user")
    except Exception as exc:
        if _is_scope_error(exc) and _user_token.get():
            _lock_auth_mode("sp")
            affected_rows = _run(force_sp=True)
        elif _is_permission_error(exc) and _user_token.get():
            logger.warning(f"User token permission denied on write, retrying as SP: {exc}")
            affected_rows = _run(force_sp=True)
        else:
            raise

    elapsed = time.time() - start_time
    logger.info(f"Write query executed in {elapsed:.2f}s ({affected_rows} rows affected)")
    return affected_rows


def execute_query(query: str, params: dict[str, Any] | None = None, *, cache_tag: str | None = None, no_cache: bool = False) -> list[dict[str, Any]]:
    """Execute a SQL query and return results as a list of dicts.

    Results are cached for 10 minutes to reduce load on Databricks.

    Args:
        cache_tag: Optional tag for pattern-based cache invalidation (e.g. "use_case").
        no_cache: If True, skip cache read/write entirely (use for security-sensitive queries).
    """
    start_time = time.time()

    # Check cache first (TTLCache handles expiration automatically)
    if not no_cache:
        cache_key = _get_cache_key(query, params, tag=cache_tag)
        if cache_key in _query_cache:
            logger.info(f"Cache hit - returned in {(time.time() - start_time)*1000:.0f}ms")
            return _query_cache[cache_key]

    def _run(force_sp: bool = False) -> list[dict[str, Any]]:
        """Execute the query. force_sp=True forces SP identity for this call."""
        ctx_tok = _user_token.set("") if force_sp else None
        try:
            with get_connection() as conn:
                with conn.cursor() as cursor:
                    if params:
                        cursor.execute(query, params)
                    else:
                        cursor.execute(query)
                    if cursor.description is not None:
                        columns = [desc[0] for desc in cursor.description]
                        rows = cursor.fetchall()
                        return [dict(zip(columns, row)) for row in rows]
                    return []
        finally:
            if ctx_tok is not None:
                _user_token.reset(ctx_tok)

    # Execute query — detect and lock auth mode on first use.
    try:
        result = _run()
        # Lock to user mode on first successful user-token query
        if _user_token.get() and _auth_mode == "unknown":
            _lock_auth_mode("user")
    except Exception as exc:
        if _is_scope_error(exc) and _user_token.get():
            # Token present but lacks sql scope — lock to SP for all future requests
            _lock_auth_mode("sp")
            result = _run(force_sp=True)
        elif _is_permission_error(exc) and _user_token.get():
            # Token has sql scope but user lacks table privileges — retry as SP.
            # Don't lock permanently: this may be table-specific and the admin
            # can resolve it by setting Force SP in Settings → Permissions.
            logger.warning(f"User token permission denied, retrying as SP: {exc}")
            result = _run(force_sp=True)
        else:
            raise

    # Cache the result (TTLCache handles expiration automatically)
    if not no_cache:
        cache_key = _get_cache_key(query, params, tag=cache_tag)
        _query_cache[cache_key] = result
    elapsed = time.time() - start_time
    logger.info(f"Query executed in {elapsed:.2f}s ({len(result)} rows)")
    return result


def get_auth_status() -> dict:
    """Return current auth mode for the settings UI auth indicator.

    Reads the in-process auth state without touching the database.
    """
    token = _user_token.get()
    locked_to_sp = _auth_mode == "sp"
    token_present = bool(token)
    user_token_active = token_present and not locked_to_sp

    if user_token_active:
        identity = "user_oauth"
    else:
        identity = "service_principal"

    # Attempt to decode JWT claims (no verification — informational only)
    has_sql_scope: bool | None = None
    user_email: str | None = None
    token_scopes: list[str] = []
    if token:
        try:
            import base64
            payload_b64 = token.split(".")[1]
            padded = payload_b64 + "=" * (-len(payload_b64) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded))
            scp = payload.get("scp", payload.get("scope", ""))
            token_scopes = scp.split() if isinstance(scp, str) else list(scp)
            has_sql_scope = "sql" in token_scopes
            user_email = payload.get("upn") or payload.get("email") or payload.get("preferred_username") or None
        except Exception:
            pass

    # Check whether a manual override is saved on disk
    override_mode: str | None = None
    try:
        if os.path.exists(_AUTH_MODE_OVERRIDE_FILE):
            with open(_AUTH_MODE_OVERRIDE_FILE) as f:
                override_mode = json.load(f).get("mode")
    except Exception:
        pass

    return {
        # Simplified fields used by the header badge
        "user_token_active": user_token_active,
        "identity": identity,
        "locked_to_sp": locked_to_sp,
        "has_sql_scope": has_sql_scope,
        # Richer fields for the Permissions settings panel
        "auth_mode": _auth_mode,          # "unknown" | "user" | "sp"
        "token_present": token_present,   # OAuth header received from Databricks Apps
        "token_scopes": token_scopes,     # scopes decoded from the JWT
        "user_email": user_email,         # email from JWT claims
        "override_mode": override_mode,   # "sp" | "auto" | None (manual override on disk)
    }


def execute_queries_parallel(
    query_funcs: list[tuple[str, Callable[[], list[dict[str, Any]]]]]
) -> dict[str, list[dict[str, Any]] | None]:
    """Execute multiple queries in parallel using ThreadPoolExecutor.

    Args:
        query_funcs: List of (name, lambda) tuples where lambda executes the query

    Returns:
        Dictionary mapping query names to results

    Example:
        queries = [
            ("summary", lambda: execute_query(SUMMARY_QUERY, params)),
            ("products", lambda: execute_query(PRODUCTS_QUERY, params)),
        ]
        results = execute_queries_parallel(queries)
        summary_data = results["summary"]
    """
    start_time = time.time()
    results: dict[str, list[dict[str, Any]] | None] = {}

    # Use ThreadPoolExecutor for parallel execution
    # Max 6 workers to avoid overwhelming the warehouse
    with ThreadPoolExecutor(max_workers=10) as executor:
        # Submit all queries
        future_to_name = {
            executor.submit(func): name
            for name, func in query_funcs
        }

        # Collect results as they complete
        for future in as_completed(future_to_name):
            name = future_to_name[future]
            query_start = time.time()
            try:
                results[name] = future.result()
                query_elapsed = time.time() - query_start
                logger.info(f"✓ {name}: {query_elapsed:.2f}s")
            except Exception as e:
                logger.error(f"✗ {name} failed: {e}")
                results[name] = None

    total_elapsed = time.time() - start_time
    logger.info(f"Parallel execution completed: {total_elapsed:.2f}s total ({len(results)} queries)")

    return results
