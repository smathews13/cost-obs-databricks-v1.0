"""App settings endpoints - Cloud infrastructure connections management."""

import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)

# Captured at module load time — proxy for "when this app process started",
# which in Databricks Apps corresponds to the most recent deployment.
_SERVER_START_TIME = datetime.utcnow().strftime("%Y-%m-%d %H:%M") + " UTC"


def _require_admin(request: Request) -> str:
    """Raise 403 if the requesting user is not an admin. Returns email on success."""
    email = request.headers.get("X-Forwarded-Email", os.getenv("USER", "dev@local"))
    perms = _load_user_permissions()
    admins = perms.get("admins", [])
    # Mirror user.py::_get_user_role: if no admins configured yet, everyone is
    # admin (fresh deploy). Only enforce the list once admins have been set.
    if admins and email not in admins:
        raise HTTPException(status_code=403, detail="Admin role required")
    return email

# In-process cache for /api/settings/tables — expensive parallel SQL + owner lookups
_tables_cache: dict | None = None
_tables_cache_ts: float = 0.0
_TABLES_CACHE_TTL = 15 * 60  # 15 minutes — prewarm fills this at startup; 5 min expired too fast

# Separate long-lived cache for table owner lookups (SDK REST call per table).
# Owners rarely change — 1-hour TTL means re-checks after the tables cache expires
# skip the 7 SDK calls entirely, cutting non-cached load time by ~1-2 s.
_owner_cache: dict[str, str | None] = {}
_owner_cache_ts: dict[str, float] = {}
_OWNER_CACHE_TTL = 60 * 60  # 1 hour


def _get_table_owner_cached(fqn: str) -> str | None:
    """Fetch table owner via Unity Catalog REST API with a 1-hour in-process cache."""
    cached_at = _owner_cache_ts.get(fqn, 0.0)
    if fqn in _owner_cache and (time.time() - cached_at) < _OWNER_CACHE_TTL:
        return _owner_cache[fqn]
    plain = fqn.replace("`", "")
    try:
        from server.db import get_workspace_client
        info = get_workspace_client().tables.get(plain)
        owner = info.owner or None
        logger.debug(f"[owner] SP client {plain} -> {owner!r}")
    except Exception as e:
        logger.debug(f"[owner] SP client {plain} failed: {e}")
        owner = None
    _owner_cache[fqn] = owner
    _owner_cache_ts[fqn] = time.time()
    return owner


def _prewarm_tables_cache() -> None:
    """Populate the tables status cache proactively at startup.

    Called from startup_tasks() after the warehouse is warm so that the first
    user to open the Config tab sees instant results instead of a 10-30s spinner.
    Runs in a background thread — creates its own event loop to call the async
    endpoint, which is safe for non-main threads.
    """
    global _tables_cache, _tables_cache_ts
    if _tables_cache is not None and (time.time() - _tables_cache_ts) < _TABLES_CACHE_TTL:
        return  # already warm
    import asyncio

    class _FakeRequest:
        class headers:
            @staticmethod
            def get(key, default=""):
                return default

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(get_tables_status(_FakeRequest(), no_cache=True))
    finally:
        loop.close()

# File-based storage (fallback / dev only — production uses Delta tables)
SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
CLOUD_CONNECTIONS_FILE = os.path.join(SETTINGS_DIR, "cloud_connections.json")
WEBHOOK_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "webhook_settings.json")
WAREHOUSE_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "warehouse_settings.json")
PRICING_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "pricing_settings.json")
USER_PERMISSIONS_FILE = os.path.join(SETTINGS_DIR, "user_permissions.json")
SCHEDULE_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "schedule_settings.json")
ALERT_THRESHOLDS_FILE = os.path.join(SETTINGS_DIR, "alert_thresholds.json")
# Legacy file path for backward compatibility
AZURE_CONNECTIONS_FILE = os.path.join(SETTINGS_DIR, "azure_connections.json")


# ── Delta table helpers (config tables that survive deploys) ──────────────────

def _config_table(name: str) -> str:
    from server.db import get_catalog_schema, validate_app_storage_target, StorageConfigurationError
    catalog, schema = get_catalog_schema()
    try:
        validate_app_storage_target(catalog, schema)
    except StorageConfigurationError as e:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=503,
            detail=f"App storage configuration is invalid — {e}",
        )
    return f"`{catalog}`.`{schema}`.`{name}`"


def _table_missing(e: Exception) -> bool:
    s = str(e)
    return "TABLE_OR_VIEW_NOT_FOUND" in s or "42P01" in s


_ensured_tables: set[str] = set()
_ensure_lock = __import__("threading").Lock()


def _ensure_config_table(ddl: str) -> None:
    if ddl in _ensured_tables:
        return
    with _ensure_lock:
        if ddl in _ensured_tables:
            return
        from server.db import execute_write
        execute_write(ddl, None)
        _ensured_tables.add(ddl)


def _ensure_contract_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_contract_settings')} "
        f"(start_date STRING, end_date STRING, total_commit_usd DOUBLE, "
        f"notes STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_connections_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_cloud_connections')} "
        f"(id STRING NOT NULL, name STRING, provider STRING, created_at STRING, "
        f"config_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_webhook_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_webhook_settings')} "
        f"(slack_webhook_url STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_alert_thresholds_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_alert_thresholds')} "
        f"(settings_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_schedule_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_schedule_settings')} "
        f"(settings_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_pricing_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_pricing_settings')} "
        f"(settings_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


# ── Workspace filter pool (survives deploys via Delta) ────────────────────────

def _ensure_workspace_filter_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_workspace_filter')} "
        f"(workspace_ids_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def save_workspace_filter_to_table(workspace_ids: list) -> None:
    """Persist workspace filter pool to the app Delta config table."""
    import json as _json
    from server.db import execute_write
    _ensure_workspace_filter_table()
    table = _config_table("app_workspace_filter")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (workspace_ids_json, updated_at) "
        f"VALUES (:ws_json, current_timestamp())",
        {"ws_json": _json.dumps(workspace_ids)},
    )
    logger.info("Workspace filter pool saved to Delta: %d ids", len(workspace_ids))


def restore_workspace_filter_from_delta() -> None:
    """Read saved workspace filter pool from Delta and write to .settings file. Called at startup."""
    import json as _json
    try:
        from server.db import execute_query
        table = _config_table("app_workspace_filter")
        rows = execute_query(f"SELECT workspace_ids_json FROM {table} LIMIT 1", None, no_cache=True)
        if not rows or not rows[0].get("workspace_ids_json"):
            return
        workspace_ids = _json.loads(rows[0]["workspace_ids_json"])
        settings_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
        settings_path = os.path.join(settings_dir, "workspace_filter.json")
        os.makedirs(settings_dir, exist_ok=True)
        with open(settings_path, "w") as f:
            _json.dump({"workspace_ids": workspace_ids}, f)
        logger.info("Restored workspace filter pool from Delta: %d ids", len(workspace_ids))
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not restore workspace filter from Delta (not yet created): %s", e)
        else:
            logger.warning(f"Could not restore workspace filter from Delta (non-fatal): {e}")


# ── Refresh log persistence (survives deploys via Delta) ──────────────────────

def _ensure_refresh_log_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_refresh_log')} "
        f"(log_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def save_refresh_log_to_delta(log_data: dict) -> None:
    """Persist mv_refresh_log.json content to Delta so it survives redeployments."""
    import json as _json
    from server.db import execute_write
    _ensure_refresh_log_table()
    table = _config_table("app_refresh_log")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (log_json, updated_at) VALUES (:log_json, current_timestamp())",
        {"log_json": _json.dumps(log_data)},
    )
    logger.info("Refresh log saved to Delta (status=%s)", log_data.get("status"))


def restore_refresh_log_from_delta() -> None:
    """Read saved refresh log from Delta and write to .settings file. Called at startup."""
    import json as _json
    try:
        from server.db import execute_query
        table = _config_table("app_refresh_log")
        rows = execute_query(f"SELECT log_json FROM {table} LIMIT 1", None, no_cache=True)
        if not rows or not rows[0].get("log_json"):
            return
        log_data = _json.loads(rows[0]["log_json"])
        log_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
        log_path = os.path.join(log_dir, "mv_refresh_log.json")
        os.makedirs(log_dir, exist_ok=True)
        with open(log_path, "w") as f:
            _json.dump(log_data, f)
        logger.info("Restored refresh log from Delta (last_refresh=%s)", log_data.get("last_refresh_utc"))
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not restore refresh log from Delta (not yet created): %s", e)
        else:
            logger.warning(f"Could not restore refresh log from Delta (non-fatal): {e}")


class CloudConnectionCreate(BaseModel):
    name: str
    provider: str  # "azure", "aws", "gcp"
    # Azure fields
    tenant_id: Optional[str] = None
    subscription_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    # AWS fields
    aws_account_id: Optional[str] = None
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = None
    region: Optional[str] = None
    # GCP fields
    project_id: Optional[str] = None
    service_account_key: Optional[str] = None


def _load_connections_from_table() -> list[dict]:
    from server.db import execute_query
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    try:
        rows = execute_query(f"SELECT * FROM {table} ORDER BY created_at", None, no_cache=True)
    except Exception as e:
        if "TABLE_OR_VIEW_NOT_FOUND" in str(e):
            _ensured_tables.clear()
        raise
    result = []
    for r in rows:
        conn: dict = {
            "id": r["id"],
            "name": r["name"],
            "provider": r["provider"],
            "created_at": r["created_at"],
        }
        if r.get("config_json"):
            try:
                conn.update(json.loads(r["config_json"]))
            except Exception:
                pass
        result.append(conn)
    return result


def _save_all_connections_to_table(connections: list[dict]) -> None:
    from server.db import execute_write
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    execute_write(f"DELETE FROM {table}", None)
    _top_level = {"id", "name", "provider", "created_at"}
    for conn in connections:
        config = {k: v for k, v in conn.items() if k not in _top_level}
        execute_write(
            f"INSERT INTO {table} (id, name, provider, created_at, config_json, updated_at) "
            f"VALUES (:id, :name, :provider, :created_at, :config_json, current_timestamp())",
            {
                "id": conn.get("id", ""),
                "name": conn.get("name", ""),
                "provider": conn.get("provider", ""),
                "created_at": conn.get("created_at", ""),
                "config_json": json.dumps(config),
            },
        )


def _upsert_connection_to_table(conn: dict) -> None:
    from server.db import execute_write
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    _top_level = {"id", "name", "provider", "created_at"}
    config = {k: v for k, v in conn.items() if k not in _top_level}
    execute_write(f"DELETE FROM {table} WHERE id = :id", {"id": conn["id"]})
    execute_write(
        f"INSERT INTO {table} (id, name, provider, created_at, config_json, updated_at) "
        f"VALUES (:id, :name, :provider, :created_at, :config_json, current_timestamp())",
        {
            "id": conn["id"],
            "name": conn.get("name", ""),
            "provider": conn.get("provider", ""),
            "created_at": conn.get("created_at", ""),
            "config_json": json.dumps(config),
        },
    )


def _delete_connection_from_table(connection_id: str) -> None:
    from server.db import execute_write
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    execute_write(f"DELETE FROM {table} WHERE id = :id", {"id": connection_id})


def _load_connections() -> list[dict]:
    """Load cloud connections from Delta table, falling back to local file."""
    try:
        conns = _load_connections_from_table()
        if conns:
            return conns
        # Table empty — check file for migration data
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load connections from Delta table (not yet created): %s", e)
        else:
            logger.warning(f"Could not load connections from Delta table: {e}")

    # Fallback: local file
    file_conns = _load_connections_from_file()
    if file_conns:
        try:
            _save_all_connections_to_table(file_conns)
            logger.info(f"Migrated {len(file_conns)} cloud connection(s) from file to Delta table")
        except Exception as e:
            logger.warning(f"Could not migrate connections to Delta: {e}")
    return file_conns


def _load_connections_from_file() -> list[dict]:
    """Load cloud connections from local JSON files (legacy / dev fallback)."""
    if os.path.exists(CLOUD_CONNECTIONS_FILE):
        try:
            with open(CLOUD_CONNECTIONS_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return []
    if os.path.exists(AZURE_CONNECTIONS_FILE):
        try:
            with open(AZURE_CONNECTIONS_FILE) as f:
                connections = json.load(f)
            for conn in connections:
                if "provider" not in conn:
                    conn["provider"] = "azure"
            _save_connections_to_file(connections)
            return connections
        except (json.JSONDecodeError, IOError):
            return []
    return []


def _save_connections_to_file(connections: list[dict]) -> None:
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(CLOUD_CONNECTIONS_FILE, "w") as f:
        json.dump(connections, f, indent=2)


def _save_connections(connections: list[dict]) -> None:
    """Save cloud connections to Delta table (primary) and file (dev fallback)."""
    try:
        _save_all_connections_to_table(connections)
    except Exception as e:
        logger.warning(f"Could not save connections to Delta table: {e}")
    _save_connections_to_file(connections)


def _mask_connection(conn: dict) -> dict:
    """Mask sensitive fields in a connection for API response."""
    masked = dict(conn)
    for secret_field in ("client_secret", "secret_access_key", "service_account_key"):
        val = masked.get(secret_field)
        if val and len(val) > 4:
            masked[secret_field] = "***" + val[-4:]
        elif val:
            masked[secret_field] = "****"
    return masked


def _get_git_sha() -> str:
    """Return the current git commit SHA (short form). Empty string if unavailable."""
    try:
        import subprocess as _sp
        sha = _sp.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=_sp.DEVNULL,
            cwd=os.path.dirname(__file__),
        ).decode().strip()
        return sha
    except Exception:
        return os.getenv("COMMIT_SHA", "")


def _get_git_info() -> dict:
    """Return git branch, repo remote URL, and commit date.

    In Databricks Apps, the deployed directory has no .git history, so git
    commands fail. Falls back to env vars and then to the server process start
    time (a reliable proxy for the last deployment).
    """
    import subprocess as _sp
    _cwd = os.path.dirname(__file__)
    def _run(cmd: list[str]) -> str:
        try:
            return _sp.check_output(cmd, stderr=_sp.DEVNULL, cwd=_cwd).decode().strip()
        except Exception:
            return ""
    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    repo = _run(["git", "remote", "get-url", "origin"])
    commit_date = _run(["git", "log", "-1", "--format=%ci", "HEAD"])
    # Strip seconds+tz for brevity: "2026-05-25 14:30:00 +0000" → "2026-05-25 14:30"
    if commit_date and len(commit_date) >= 16:
        commit_date = commit_date[:16]
    # Databricks Apps doesn't ship .git history, so git log always fails there.
    # Fall back to server start time — the process restarts on every deploy, so
    # this is a reliable proxy for "when was this version last deployed".
    return {
        "branch": branch or os.getenv("GIT_BRANCH", ""),
        "repo": repo or os.getenv("GIT_REPO", ""),
        "commit_date": commit_date or os.getenv("COMMIT_DATE", _SERVER_START_TIME),
    }


_warehouse_cache: dict | None = None  # in-process cache; cleared on server restart


@router.get("/config")
async def get_app_config():
    """Return current app configuration. Warehouse name fetched from SDK; other fields are instant from env vars."""
    import asyncio as _asyncio
    from server.db import get_catalog_schema

    # Warehouse: resolve ID from env vars, then look up name/state via SDK.
    warehouse_id_resource = os.getenv("DATABRICKS_WAREHOUSE_ID", "")
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")

    if warehouse_id_resource:
        warehouse_source = "app_resource"
        warehouse_id = warehouse_id_resource
    elif http_path and "/" in http_path:
        warehouse_source = "http_path"
        warehouse_id = http_path.rstrip("/").split("/")[-1]
    elif http_path:
        warehouse_source = "http_path"
        warehouse_id = http_path
    else:
        warehouse_source = "none"
        warehouse_id = ""

    warehouse: dict = (
        {"id": warehouse_id, "name": None, "size": None, "state": "UNKNOWN", "source": warehouse_source}
        if warehouse_id
        else {"id": None, "name": None, "size": None, "state": "NOT_CONFIGURED", "source": "none"}
    )

    if warehouse_id:
        global _warehouse_cache
        if _warehouse_cache and _warehouse_cache.get("_id") == warehouse_id:
            warehouse.update({k: v for k, v in _warehouse_cache.items() if k != "_id"})
        else:
            def _fetch_warehouse():
                try:
                    from server.db import get_workspace_client
                    w = get_workspace_client()
                    wh = w.warehouses.get(warehouse_id)
                    return {
                        "name": wh.name or None,
                        "size": wh.cluster_size or None,
                        "state": str(wh.state.value) if wh.state else "UNKNOWN",
                    }
                except Exception:
                    return {}
            loop = _asyncio.get_running_loop()
            try:
                detail = await _asyncio.wait_for(loop.run_in_executor(None, _fetch_warehouse), timeout=3)
                if detail:
                    _warehouse_cache = {"_id": warehouse_id, **detail}
                    warehouse.update(detail)
            except Exception:
                pass  # timeout or SDK error — warehouse ID is still shown

    # Identity: SP client ID from env var (no current_user.me() call)
    sp_client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
    identity = {"display_name": sp_client_id, "user_name": sp_client_id} if sp_client_id else None

    # Storage location: pure env var / override file read
    storage_location = None
    try:
        catalog, schema = get_catalog_schema()
        storage_location = {
            "catalog": catalog,
            "schema": schema,
            "catalog_source": "env_var" if os.getenv("COST_OBS_CATALOG") else "default",
            "schema_source": "env_var" if os.getenv("COST_OBS_SCHEMA") else "default",
        }
    except Exception as e:
        logger.warning(f"Could not fetch catalog/schema: {e}")

    git = _get_git_info()
    return {
        "warehouse": warehouse,
        "identity": identity,
        "storage_location": storage_location,
        "version": {
            "commit_sha": _get_git_sha(),
            "branch": git["branch"],
            "repo": git["repo"],
            "commit_date": git["commit_date"],
        },
    }


@router.get("/tables")
async def get_tables_status(request: Request, no_cache: bool = False):
    """Return status of each MV table: exists, row count, max date, days behind."""
    global _tables_cache, _tables_cache_ts
    if not no_cache and _tables_cache is not None and (time.time() - _tables_cache_ts) < _TABLES_CACHE_TTL:
        return _tables_cache

    try:
        return await _get_tables_status_inner(request)
    except Exception as e:
        logger.exception("get_tables_status: unhandled exception")
        return {"catalog": None, "schema": None, "tables": [], "error": str(e), "auth_error": None, "refresh_status": None}


async def _get_tables_status_inner(request: Request):
    global _tables_cache, _tables_cache_ts
    from server.db import get_catalog_schema, execute_query, _user_token

    # Read the raw forwarded token directly — _auth_mode may be locked to "sp"
    # (e.g. warehouse was cold on startup and the scope check failed), which forces
    # _user_token to "" even when x-forwarded-access-token IS present.  Reading the
    # header directly bypasses that lock and ensures table checks always run as the
    # user when the SQL scope is configured.
    _captured_token = (
        request.headers.get("x-forwarded-access-token", "")
        or _user_token.get()
    )

    MV_TABLES = [
        "daily_usage_summary",
        "daily_product_breakdown",
        "daily_workspace_breakdown",
        "sql_tool_attribution",
        "daily_query_stats",
        "dbsql_cost_per_query",
        "app_user_permissions",
    ]
    # Which tables are conceptually "materialized views" (rebuilt on schedule)
    # vs persistent managed tables
    MV_SET = {
        "daily_usage_summary", "daily_product_breakdown", "daily_workspace_breakdown",
        "sql_tool_attribution", "daily_query_stats", "dbsql_cost_per_query",
    }

    try:
        catalog, schema = get_catalog_schema()
    except Exception as e:
        return {"catalog": None, "schema": None, "tables": [], "error": str(e)}

    from datetime import date

    # Tables that don't have a usage_date column — use an alternate date expression or skip date
    date_expr_overrides = {
        "dbsql_cost_per_query": "CAST(MAX(start_time) AS DATE)",
    }
    no_date_tables = {
        "app_user_permissions",
    }

    min_date_expr_overrides = {
        "dbsql_cost_per_query": "CAST(MIN(start_time) AS DATE)",
    }

    def check_table(table_name: str, fqn: str, table_type: str) -> dict:
        # Force SP auth — SP owns all app tables so it always has SELECT.
        # User token lacks the sql OAuth scope in Databricks Apps, causing
        # "Error during request to server" when used for warehouse queries.
        tok = _user_token.set("")
        try:
            return _check_table_inner(table_name, fqn, table_type)
        finally:
            _user_token.reset(tok)

    # Owner lookups use the module-level cached function — avoids repeating SDK REST
    # calls on every non-cached tables check (owners change rarely; TTL = 1 hour).

    def _check_table_inner(table_name: str, fqn: str, table_type: str) -> dict:
        # Owner is fetched in a separate parallel pool — not here — to avoid
        # the SDK REST call serialising before the SQL query and doubling latency.
        skip_date = table_name in no_date_tables
        _not_found_signals = ("TABLE_OR_VIEW_NOT_FOUND",)

        if skip_date:
            # Single existence probe — avoids a separate DESCRIBE TABLE round-trip.
            try:
                execute_query(f"SELECT 1 FROM {fqn} LIMIT 1")
                return {"name": table_name, "table_type": table_type, "exists": True, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "owner": None}
            except Exception as e:
                err = str(e)
                if any(s in err for s in _not_found_signals) or "does not exist" in err.lower() or "not found" in err.lower():
                    return {"name": table_name, "table_type": table_type, "exists": False, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "owner": None}
                return {"name": table_name, "table_type": table_type, "exists": None, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "owner": None, "error": err[:200]}

        # Single query: SELECT MAX/MIN returns NULL on an empty table and raises
        # TABLE_OR_VIEW_NOT_FOUND if the table doesn't exist — no DESCRIBE needed.
        # Use "TABLE_OR_VIEW_NOT_FOUND" and "table or view" as not-found signals;
        # do NOT use the generic "not found" which also matches COLUMN_NOT_FOUND
        # and would incorrectly mark an existing table with schema drift as absent.
        _table_not_found = lambda e: ("TABLE_OR_VIEW_NOT_FOUND" in e or "table or view" in e.lower())
        try:
            max_expr = date_expr_overrides.get(table_name, "MAX(usage_date)")
            min_expr = min_date_expr_overrides.get(table_name, "MIN(usage_date)")
            rows = execute_query(f"SELECT {max_expr} as max_date, {min_expr} as min_date, COUNT(*) as row_count FROM {fqn}")
            if not rows:
                return {"name": table_name, "table_type": table_type, "exists": True, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "owner": None}
            max_date = rows[0].get("max_date")
            min_date = rows[0].get("min_date")
            row_count = rows[0].get("row_count")
            max_date_str = str(max_date) if max_date else None
            min_date_str = str(min_date) if min_date else None
            days_behind = None
            if max_date_str:
                from datetime import date as _date
                try:
                    delta = _date.today() - _date.fromisoformat(max_date_str[:10])
                    days_behind = delta.days
                except Exception:
                    pass
            return {"name": table_name, "table_type": table_type, "exists": True, "row_count": row_count, "min_date": min_date_str, "max_date": max_date_str, "days_behind": days_behind, "owner": None}
        except Exception as e:
            err = str(e)
            if _table_not_found(err):
                return {"name": table_name, "table_type": table_type, "exists": False, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "owner": None}
            return {"name": table_name, "table_type": table_type, "exists": True, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "owner": None, "error": err[:200]}

    # Config tables are created lazily on first save — not existing yet is expected
    CONFIG_TABLES: set[str] = set()

    # Build task list: (table_name, fqn, table_type)
    tasks = [
        (t, f"`{catalog}`.`{schema}`.`{t}`", "Materialized View" if t in MV_SET else "Table")
        for t in MV_TABLES
    ]

    results = []
    _TABLE_CHECK_TIMEOUT = 12  # seconds — was 25; fail-fast on cold warehouse for better UX
    import asyncio as _asyncio
    loop = _asyncio.get_running_loop()

    # Use run_in_executor so the event loop is freed while SQL queries run.
    # A blocking ThreadPoolExecutor context manager would hold the event loop
    # for up to an hour on a cold warehouse (executor.__exit__ waits for all threads).
    sql_futures_map: dict = {
        loop.run_in_executor(None, check_table, name, fqn, ttype): (name, fqn, ttype)
        for name, fqn, ttype in tasks
    }
    owner_futures_map: dict = {
        loop.run_in_executor(None, _get_table_owner_cached, fqn): name
        for name, fqn, _ in tasks
    }

    # Wait for SQL checks without blocking the event loop
    sql_done, sql_pending = await _asyncio.wait(
        set(sql_futures_map.keys()), timeout=_TABLE_CHECK_TIMEOUT
    )
    for fut in sql_done:
        try:
            results.append(fut.result())
        except Exception:
            pass  # check_table catches all exceptions internally

    if sql_pending:
        for fut, (name, _fqn, ttype) in sql_futures_map.items():
            if fut in sql_pending:
                results.append({
                    "name": name, "table_type": ttype, "exists": None,
                    "row_count": None, "min_date": None, "max_date": None, "days_behind": None,
                    "owner": None, "error": "timed out — warehouse may be starting up",
                })
        logger.warning("Table status check timed out — warehouse likely cold")

    # Merge owner results — cached owners resolve in microseconds, uncached get 1.5 s
    owner_done, _ = await _asyncio.wait(set(owner_futures_map.keys()), timeout=1.5)
    owner_map: dict = {}
    for fut in owner_done:
        name = owner_futures_map[fut]
        try:
            owner_map[name] = fut.result()
        except Exception:
            owner_map[name] = None
    for r in results:
        r["owner"] = owner_map.get(r["name"])

    # Preserve original order and tag optional config tables
    order = {name: i for i, (name, _, _) in enumerate(tasks)}
    results.sort(key=lambda r: order.get(r["name"], 99))
    for r in results:
        if r["name"] in CONFIG_TABLES:
            r["optional"] = True

    # Detect auth/permission failures — surface a top-level auth_error so the UI
    # can show an actionable message instead of per-row ⚠ icons.
    _PERM_SIGNALS = ("PERMISSION_DENIED", "INSUFFICIENT_PRIVILEGES", "not authorized",
                     "Not authorized", "Unauthorized", "User does not have", "403")
    perm_errors = [
        r for r in results
        if r.get("error") and any(s in r["error"] for s in _PERM_SIGNALS)
    ]
    auth_error = None
    if perm_errors and len(perm_errors) >= len(tasks) // 2:
        auth_error = (
            "The app service principal lacks permission to read these tables. "
            "Open the Setup wizard and run the Permissions step to grant the SP access to the required system tables and app catalog."
        )

    # Read MV refresh log (atomic write guarantees no partial read)
    refresh_status = None
    _log_path = os.path.join(os.path.dirname(__file__), "..", "..", ".settings", "mv_refresh_log.json")
    try:
        with open(_log_path) as _f:
            _log = json.load(_f)
        from datetime import datetime as _dt, timezone as _tz
        _last = _dt.strptime(_log["last_refresh_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_tz.utc)
        _hours = (_dt.now(_tz.utc) - _last).total_seconds() / 3600
        refresh_status = {
            "last_refresh_utc": _log["last_refresh_utc"],
            "duration_seconds": _log.get("duration_seconds"),
            "hours_since_refresh": round(_hours, 1),
            "stale": _hours > 26,
            "status": _log.get("status", "unknown"),
            "lookback_days": _log.get("lookback_days"),
            "refresh_history": _log.get("refresh_history", []),
        }
        if _log.get("error"):
            refresh_status["error"] = _log["error"]
    except (FileNotFoundError, KeyError, ValueError, OSError):
        pass

    result = {"catalog": catalog, "schema": schema, "tables": results, "auth_error": auth_error, "refresh_status": refresh_status}
    _tables_cache = result
    _tables_cache_ts = time.time()
    return result


_CONTRACT_SETTINGS_FILE = os.path.join(
    os.path.dirname(__file__), "..", "..", ".settings", "contract_settings.json"
)

_CONTRACT_EMPTY = {"start_date": None, "end_date": None, "total_commit_usd": None, "notes": ""}


def _load_contract_settings() -> dict:
    """Load contract settings from Delta table, falling back to local file."""
    try:
        from server.db import execute_query
        table = _config_table("app_contract_settings")
        rows = execute_query(f"SELECT * FROM {table} LIMIT 1", None, no_cache=True)
        if rows:
            r = rows[0]
            return {
                "start_date": r.get("start_date"),
                "end_date": r.get("end_date"),
                "total_commit_usd": r.get("total_commit_usd"),
                "notes": r.get("notes") or "",
            }
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load contract from Delta table (not yet created): %s", e)
        else:
            logger.warning(f"Could not load contract from Delta table: {e}")

    # Fallback: local file — migrate to Delta if data present
    try:
        with open(_CONTRACT_SETTINGS_FILE) as f:
            data = json.load(f)
        if data.get("start_date"):
            try:
                _save_contract_to_table(data)
                logger.info("Migrated contract settings from file to Delta table")
            except Exception as e:
                logger.warning(f"Could not migrate contract settings to Delta: {e}")
        return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _CONTRACT_EMPTY.copy()


def _save_contract_to_table(data: dict) -> None:
    from server.db import execute_write
    _ensure_contract_table()
    table = _config_table("app_contract_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (start_date, end_date, total_commit_usd, notes, updated_at) "
        f"VALUES (:start_date, :end_date, :total_commit_usd, :notes, current_timestamp())",
        {
            "start_date": data["start_date"],
            "end_date": data["end_date"],
            "total_commit_usd": float(data["total_commit_usd"]),
            "notes": data.get("notes") or "",
        },
    )


@router.get("/contract")
async def get_contract_settings():
    """Return saved contract terms (or empty defaults)."""
    return _load_contract_settings()


@router.post("/contract")
async def save_contract_settings(body: dict):
    """Persist contract terms after basic validation."""
    from datetime import date as _date
    errors = []
    start = body.get("start_date") or ""
    end = body.get("end_date") or ""
    commit = body.get("total_commit_usd")
    try:
        _date.fromisoformat(start)
    except (ValueError, TypeError):
        errors.append("start_date must be a valid ISO date (YYYY-MM-DD)")
    try:
        _date.fromisoformat(end)
    except (ValueError, TypeError):
        errors.append("end_date must be a valid ISO date (YYYY-MM-DD)")
    if commit is None or not isinstance(commit, (int, float)) or commit <= 0:
        errors.append("total_commit_usd must be a positive number")
    if errors:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="; ".join(errors))
    data = {
        "start_date": start,
        "end_date": end,
        "total_commit_usd": float(commit),
        "notes": (body.get("notes") or "").strip(),
    }
    # Write to Delta table (primary) and file (dev fallback)
    try:
        _save_contract_to_table(data)
    except Exception as e:
        logger.warning(f"Could not save contract to Delta table: {e}")
    os.makedirs(os.path.dirname(_CONTRACT_SETTINGS_FILE), exist_ok=True)
    with open(_CONTRACT_SETTINGS_FILE, "w") as f:
        json.dump(data, f)
    return data


@router.get("/catalog")
async def get_catalog_settings():
    """Return current catalog/schema and whether it's from an override or env vars."""
    from server.db import get_catalog_schema_info
    return get_catalog_schema_info()


@router.post("/catalog")
async def save_catalog_settings(body: dict):
    """Save catalog/schema override from the Setup Wizard."""
    import asyncio as _asyncio
    from fastapi import HTTPException
    from server.db import save_catalog_schema, StorageConfigurationError
    catalog = (body.get("catalog") or "").strip()
    schema = (body.get("schema") or "").strip()
    if not catalog or not schema:
        raise HTTPException(status_code=400, detail="catalog and schema are required")
    try:
        loop = _asyncio.get_running_loop()
        await _asyncio.wait_for(
            loop.run_in_executor(None, save_catalog_schema, catalog, schema),
            timeout=25.0,
        )
    except _asyncio.TimeoutError:
        raise HTTPException(
            status_code=503,
            detail="Server timed out saving configuration. The workspace may be under load — please retry.",
        )
    except StorageConfigurationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"catalog": catalog, "schema": schema, "source": "override"}


@router.post("/refresh-mvs")
async def trigger_mv_refresh(background_tasks: BackgroundTasks, lookback_days: int = 180, force_full: bool = True):
    """Kick off an MV rebuild in the background and return immediately.

    lookback_days: how many days of history to include (default 180 = 6 months).
    force_full: when True (default for UI-triggered rebuilds), bypass incremental MERGE
                and always run full CREATE OR REPLACE for every table.
    """
    global _tables_cache, _tables_cache_ts
    from server.app import _run_mv_refresh
    # Clear cache immediately so the next Status poll reflects fresh SQL results
    _tables_cache = None
    _tables_cache_ts = 0.0
    background_tasks.add_task(_run_mv_refresh, lookback_days=lookback_days, force_full=force_full)
    return {"status": "queued", "lookback_days": lookback_days, "force_full": force_full}


@router.get("/auth-status")
async def get_auth_status_endpoint():
    """Return current auth mode for the settings UI indicator."""
    import os as _os
    import asyncio as _asyncio
    from server.db import get_auth_status, get_workspace_client
    status = get_auth_status()
    # Add SP identity and catalog/schema so the UI renders accurate GRANT SQL without placeholders
    def _fetch_me():
        return get_workspace_client().current_user.me()
    try:
        loop = _asyncio.get_running_loop()
        me = await _asyncio.wait_for(loop.run_in_executor(None, _fetch_me), timeout=4.0)
        # user_name is the SP's applicationId (its actual identity); display_name is the human label
        status["sp_user_name"] = me.user_name or ""
        status["sp_display_name"] = me.display_name or me.user_name or ""
        status["sp_client_id"] = _os.getenv("DATABRICKS_CLIENT_ID", me.user_name or "")
    except Exception:
        status["sp_user_name"] = ""
        status["sp_display_name"] = ""
        status["sp_client_id"] = _os.getenv("DATABRICKS_CLIENT_ID", "")
    try:
        from server.db import get_catalog_schema
        cat, sch = get_catalog_schema()
        status["catalog"] = cat
        status["schema"] = sch
    except Exception:
        status["catalog"] = ""
        status["schema"] = ""
    return status


@router.get("/billing-access")
async def check_billing_access():
    """Test whether the SP can read system.billing.usage.

    Always runs as the service principal (clears user token) so the result
    reflects SP grants, not the current user's OAuth permissions.
    Used by the frontend to detect missing post-deploy SP grants.

    Returns reason: "warehouse_access" when the SP can't use the SQL endpoint,
    "grants_missing" when UC table privileges are missing.
    Includes warehouse_id so the frontend can show the exact grant command.
    """
    import os as _os
    from server.db import _user_token, execute_query
    tok = _user_token.set("")
    try:
        await asyncio.to_thread(execute_query, "SELECT 1 FROM system.billing.usage LIMIT 1", no_cache=True)
        return {"ok": True}
    except Exception as e:
        err = str(e)
        http_path = _os.environ.get("DATABRICKS_HTTP_PATH", "")
        warehouse_id = http_path.rstrip("/").split("/")[-1] if "/" in http_path else ""
        sp_client_id = _os.environ.get("DATABRICKS_CLIENT_ID", "")
        # Warehouse CAN_USE failure — distinct from UC table grant failure
        if "not authorized to use this sql endpoint" in err.lower() or (
            "permission_denied" in err.lower() and "sql endpoint" in err.lower()
        ):
            return {
                "ok": False,
                "reason": "warehouse_access",
                "warehouse_id": warehouse_id,
                "sp_client_id": sp_client_id,
            }
        if any(s in err.lower() for s in ("permission_denied", "insufficient_privileges", "not authorized", "user does not have")):
            return {"ok": False, "reason": "grants_missing", "sp_client_id": sp_client_id}
        return {"ok": False, "reason": "error", "error": err[:200]}
    finally:
        _user_token.reset(tok)


class AuthModeRequest(BaseModel):
    mode: str  # "sp" only — OAuth disabled


@router.post("/auth-mode")
async def set_auth_mode(body: AuthModeRequest):
    """Auth mode endpoint — OAuth is currently disabled.

    Only 'sp' is accepted. 'auto' is rejected until OAuth is re-enabled.
    """
    if body.mode == "auto":
        raise HTTPException(
            status_code=422,
            detail="OAuth / auto-detect mode is disabled. The app runs exclusively as the service principal."
        )
    if body.mode != "sp":
        raise HTTPException(status_code=422, detail="mode must be 'sp'")
    # set_auth_mode_override is a no-op when already SP, but call for log visibility
    from server.db import set_auth_mode_override
    set_auth_mode_override(body.mode)
    return {"status": "ok", "mode": "sp"}


@router.get("/warehouses")
async def list_warehouses():
    """List all SQL warehouses the user has access to."""
    from server.db import get_user_workspace_client

    current_http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    current_id = current_http_path.split("/")[-1] if current_http_path else None

    try:
        w = get_user_workspace_client()
        warehouses = list(w.warehouses.list())

        result = []
        for wh in warehouses:
            state = str(wh.state.value) if wh.state else "UNKNOWN"
            result.append({
                "id": wh.id,
                "name": wh.name,
                "size": wh.cluster_size,
                "state": state,
                "is_current": wh.id == current_id,
            })

        # If the user token returned nothing, merge in warehouses visible to the SP.
        # Common during first-time setup: the admin granted CAN_USE only to the SP
        # (not to the user personally), so the user's OAuth token sees an empty list
        # even though the app will work fine once a warehouse is selected.
        if not result:
            from server.db import get_workspace_client as _get_sp_client
            try:
                sp_warehouses = list(_get_sp_client().warehouses.list())
                for wh in sp_warehouses:
                    state = str(wh.state.value) if wh.state else "UNKNOWN"
                    result.append({
                        "id": wh.id,
                        "name": wh.name,
                        "size": wh.cluster_size,
                        "state": state,
                        "is_current": wh.id == current_id,
                    })
                if result:
                    logger.info(f"User token saw 0 warehouses; SP token found {len(result)} — using SP list for setup")
            except Exception as sp_err:
                logger.warning(f"SP warehouse list fallback also failed: {sp_err}")

        # If the currently configured warehouse isn't in the list (token visibility gap),
        # try fetching it directly — first with the user token, then fall back to the
        # SP M2M client (handles cases where forwarded OAuth token has narrower scope).
        if current_id and not any(r["id"] == current_id for r in result):
            from server.db import get_workspace_client as _get_sp_client
            wh_info = None
            for label, client in [("user", w), ("sp", _get_sp_client())]:
                try:
                    wh = client.warehouses.get(current_id)
                    state = str(wh.state.value) if wh.state else "UNKNOWN"
                    wh_info = {"id": wh.id, "name": wh.name, "size": wh.cluster_size, "state": state, "is_current": True}
                    break
                except Exception as e2:
                    logger.warning(f"Could not fetch warehouse {current_id} ({label} token): {e2}")
            result.insert(0, wh_info or {"id": current_id, "name": None, "size": None, "state": "UNKNOWN", "is_current": True})

        # Sort: current first, then running, then by name
        result.sort(key=lambda x: (not x["is_current"], x["state"] != "RUNNING", x["name"] or ""))
        return result
    except Exception as e:
        logger.error(f"Failed to list warehouses: {e}")
        # User token raised an exception (e.g. OAuth token lacks all-apis scope).
        # Try the SP M2M client for listing — covers first-time setup where no
        # warehouse is configured yet (current_id is None).
        from server.db import get_workspace_client as _sp
        try:
            sp_client = _sp()
            sp_whs = list(sp_client.warehouses.list())
            if sp_whs:
                logger.info(f"User token warehouses.list() failed; SP found {len(sp_whs)} warehouse(s)")
                sp_result = []
                for wh in sp_whs:
                    state = str(wh.state.value) if wh.state else "UNKNOWN"
                    sp_result.append({"id": wh.id, "name": wh.name, "size": wh.cluster_size, "state": state, "is_current": wh.id == current_id})
                sp_result.sort(key=lambda x: (not x["is_current"], x["state"] != "RUNNING", x["name"] or ""))
                return sp_result
        except Exception as sp_err:
            logger.warning(f"SP warehouses.list() fallback also failed: {sp_err}")
        # Both failed — last resort: return the currently configured warehouse by ID
        if current_id:
            try:
                wh = _sp().warehouses.get(current_id)
                state = str(wh.state.value) if wh.state else "STOPPED"
                return [{"id": wh.id, "name": wh.name, "size": wh.cluster_size, "state": state, "is_current": True}]
            except Exception as e2:
                logger.warning(f"SP warehouses.get fallback also failed: {e2}")
                return [{"id": current_id, "name": None, "size": None, "state": "UNKNOWN", "is_current": True}]
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/cloud-provider")
async def get_cloud_provider():
    """Detect the base cloud provider from the Databricks workspace host URL."""
    from server.db import get_workspace_client

    host = os.getenv("DATABRICKS_HOST", "")
    # Try getting host from workspace client if env var is empty
    if not host:
        try:
            w = get_workspace_client()
            host = w.config.host or ""
        except Exception:
            pass

    host = host.lower()
    if ".azuredatabricks.net" in host or "adb-" in host:
        provider = "azure"
    elif ".gcp.databricks.com" in host:
        provider = "gcp"
    else:
        # Default to AWS (.cloud.databricks.com and others)
        provider = "aws"

    return {"provider": provider, "host": host}


@router.get("/cloud-connections")
async def list_cloud_connections():
    """List all cloud connections (secrets are masked)."""
    connections = _load_connections()
    return [_mask_connection(c) for c in connections]


# Keep legacy endpoint for backward compatibility
@router.get("/azure-connections")
async def list_azure_connections():
    """List Azure connections (legacy endpoint, returns all connections)."""
    connections = _load_connections()
    return [_mask_connection(c) for c in connections]


@router.post("/cloud-connections")
async def create_cloud_connection(request: Request, conn: CloudConnectionCreate):
    """Create a new cloud connection."""
    _require_admin(request)
    if conn.provider not in ("azure", "aws", "gcp"):
        raise HTTPException(status_code=400, detail="Invalid provider. Must be azure, aws, or gcp.")

    connections = _load_connections()

    new_conn = {
        "id": str(uuid.uuid4())[:8],
        "name": conn.name,
        "provider": conn.provider,
        "created_at": datetime.utcnow().isoformat(),
    }

    if conn.provider == "azure":
        new_conn.update({
            "tenant_id": conn.tenant_id,
            "subscription_id": conn.subscription_id,
            "client_id": conn.client_id,
            "client_secret": conn.client_secret,
        })
    elif conn.provider == "aws":
        new_conn.update({
            "aws_account_id": conn.aws_account_id,
            "access_key_id": conn.access_key_id,
            "secret_access_key": conn.secret_access_key,
            "region": conn.region,
        })
    elif conn.provider == "gcp":
        new_conn.update({
            "project_id": conn.project_id,
            "service_account_key": conn.service_account_key,
        })

    connections.append(new_conn)
    try:
        _upsert_connection_to_table(new_conn)
    except Exception as e:
        logger.warning(f"Could not save connection to Delta table: {e}")
    _save_connections_to_file(connections)

    logger.info(f"Created {conn.provider.upper()} connection: {conn.name}")

    return _mask_connection(new_conn)


# Keep legacy endpoint for backward compatibility
@router.post("/azure-connections")
async def create_azure_connection(conn: CloudConnectionCreate):
    """Create an Azure connection (legacy endpoint)."""
    conn.provider = "azure"
    return await create_cloud_connection(conn)


@router.delete("/cloud-connections/{connection_id}")
async def delete_cloud_connection(request: Request, connection_id: str):
    """Delete a cloud connection."""
    _require_admin(request)
    connections = _load_connections()
    original_count = len(connections)
    connections = [c for c in connections if c.get("id") != connection_id]

    if len(connections) == original_count:
        raise HTTPException(status_code=404, detail="Connection not found")

    try:
        _delete_connection_from_table(connection_id)
    except Exception as e:
        logger.warning(f"Could not delete connection from Delta table: {e}")
    _save_connections_to_file(connections)
    logger.info(f"Deleted cloud connection: {connection_id}")
    return {"status": "deleted", "id": connection_id}


# Keep legacy endpoint for backward compatibility
@router.delete("/azure-connections/{connection_id}")
async def delete_azure_connection(connection_id: str):
    """Delete an Azure connection (legacy endpoint)."""
    return await delete_cloud_connection(connection_id)


# ── Webhook Settings ─────────────────────────────────────────────────────

class WebhookSettings(BaseModel):
    slack_webhook_url: str = ""


def _load_webhook_settings() -> dict:
    """Load webhook settings from Delta table, falling back to local file."""
    try:
        from server.db import execute_query
        table = _config_table("app_webhook_settings")
        rows = execute_query(f"SELECT * FROM {table} LIMIT 1", None, no_cache=True)
        if rows:
            return {"slack_webhook_url": rows[0].get("slack_webhook_url") or ""}
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load webhook settings from Delta table (not yet created): %s", e)
        else:
            logger.warning(f"Could not load webhook settings from Delta table: {e}")

    # Fallback: file
    if os.path.exists(WEBHOOK_SETTINGS_FILE):
        try:
            with open(WEBHOOK_SETTINGS_FILE) as f:
                data = json.load(f)
            if data.get("slack_webhook_url"):
                try:
                    _save_webhook_to_table(data)
                    logger.info("Migrated webhook settings from file to Delta table")
                except Exception as e:
                    logger.warning(f"Could not migrate webhook settings to Delta: {e}")
            return data
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _save_webhook_to_table(settings: dict) -> None:
    from server.db import execute_write
    _ensure_webhook_table()
    table = _config_table("app_webhook_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (slack_webhook_url, updated_at) "
        f"VALUES (:url, current_timestamp())",
        {"url": settings.get("slack_webhook_url") or ""},
    )


def _save_webhook_settings(settings: dict) -> None:
    """Save webhook settings to Delta table (primary) and file (dev fallback)."""
    try:
        _save_webhook_to_table(settings)
    except Exception as e:
        logger.warning(f"Could not save webhook settings to Delta table: {e}")
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(WEBHOOK_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


@router.get("/webhook")
async def get_webhook_settings() -> dict[str, Any]:
    """Get current webhook settings."""
    settings = _load_webhook_settings()
    # Mask the URL for security
    url = settings.get("slack_webhook_url", "")
    masked = ""
    if url:
        # Only show scheme+host to confirm it's configured without exposing path tokens
        masked = "https://hooks.slack.com/services/****" if "hooks.slack.com" in url else "****"
    return {"slack_webhook_url": masked, "configured": bool(url)}


@router.post("/webhook")
async def save_webhook_settings(request: Request, settings: WebhookSettings) -> dict[str, Any]:
    """Save webhook settings."""
    _require_admin(request)
    _save_webhook_settings({"slack_webhook_url": settings.slack_webhook_url})
    logger.info("Webhook settings updated")
    return {"status": "saved"}


@router.post("/webhook/test")
async def test_webhook(request: Request) -> dict[str, Any]:
    """Send a test message to the configured Slack webhook."""
    _require_admin(request)
    settings = _load_webhook_settings()
    url = settings.get("slack_webhook_url", "")
    if not url:
        return {"success": False, "error": "No webhook URL configured"}

    payload = {
        "text": "Cost Observability & Control - Test notification. Your webhook is working!"
    }
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                return {"success": True, "message": "Test message sent"}
            return {"success": False, "error": f"Slack returned status {resp.status_code}"}
    except Exception as e:
        logger.error(f"Webhook test failed: {e}")
        return {"success": False, "error": str(e)}


@router.post("/webhook/send-alert")
async def send_webhook_alert(alert_data: dict[str, Any]) -> dict[str, Any]:
    """Send an alert notification to the configured Slack webhook."""
    settings = _load_webhook_settings()
    url = settings.get("slack_webhook_url", "")
    if not url:
        return {"success": False, "error": "No webhook URL configured"}

    # Format alert message
    alert_type = alert_data.get("alert_type", "alert")
    usage_date = alert_data.get("usage_date", "unknown")
    daily_spend = alert_data.get("daily_spend", 0)
    change_pct = alert_data.get("change_percent", 0)

    text = (
        f":rotating_light: *Cost Alert: {alert_type.title()}*\n"
        f"Date: {usage_date}\n"
        f"Daily Spend: ${daily_spend:,.2f}\n"
    )
    if change_pct:
        text += f"Change: {change_pct:+.1f}%\n"

    payload = {"text": text}
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                return {"success": True}
            return {"success": False, "error": f"Slack returned status {resp.status_code}"}
    except Exception as e:
        logger.error(f"Webhook alert failed: {e}")
        return {"success": False, "error": str(e)}


# ── User Permissions ──────────────────────────────────────────────────────────

class UserPermissionsModel(BaseModel):
    admins: list[str] = []
    consumers: list[str] = []


def _permissions_table() -> str:
    """Return the fully-qualified Delta table name for user permissions."""
    from server.db import get_catalog_schema
    catalog, schema = get_catalog_schema()
    return f"`{catalog}`.`{schema}`.`app_user_permissions`"


def _ensure_permissions_table() -> None:
    """Create the permissions table if it doesn't exist."""
    from server.db import execute_write
    table = _permissions_table()
    execute_write(
        f"CREATE TABLE IF NOT EXISTS {table} "
        f"(role STRING NOT NULL, email STRING NOT NULL, "
        f"updated_at TIMESTAMP) "
        f"USING DELTA",
        None,
    )


def _load_user_permissions() -> dict:
    """Load permissions from Delta table, then local file."""
    try:
        from server.db import execute_query
        _ensure_permissions_table()
        table = _permissions_table()
        rows = execute_query(f"SELECT role, email FROM {table}", None, no_cache=True)
        admins = [r["email"] for r in rows if r.get("role") == "admin"]
        consumers = [r["email"] for r in rows if r.get("role") == "consumer"]
        if admins or consumers:
            logger.info(f"Loaded permissions from Delta table ({len(admins)} admins, {len(consumers)} consumers)")
            return {"admins": admins, "consumers": consumers}
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load permissions from Delta table (not yet created): %s", e)
        else:
            logger.warning(f"Could not load permissions from Delta table: {e}")

    # Fallback: local file (ephemeral — only useful in dev)
    try:
        if os.path.exists(USER_PERMISSIONS_FILE):
            with open(USER_PERMISSIONS_FILE) as f:
                data = json.load(f)
            return {"admins": data.get("admins", []), "consumers": data.get("consumers", [])}
    except (json.JSONDecodeError, IOError):
        pass
    return {"admins": [], "consumers": []}


def _save_user_permissions_to_table(admins: list[str], consumers: list[str]) -> None:
    """Write permissions to Delta table (replaces all rows)."""
    from server.db import execute_write, clear_query_cache
    # Ensure the table exists before writing. If this raises, the SP lacks
    # CREATE TABLE permission — propagate so the caller gets a clear error.
    _ensure_permissions_table()
    table = _permissions_table()
    execute_write(f"DELETE FROM {table}", None)
    rows = [("admin", e) for e in admins] + [("consumer", e) for e in consumers]
    if rows:
        for role, email in rows:
            execute_write(
                f"INSERT INTO {table} (role, email) VALUES (:role, :email)",
                {"role": role, "email": email},
            )
    # Invalidate cached permission reads so the change is visible immediately
    clear_query_cache("perms")
    logger.info(f"Saved user permissions to Delta table ({len(admins)} admins, {len(consumers)} consumers)")


@router.get("/user-permissions")
async def get_user_permissions(request: Request) -> dict:
    """Return the admin and consumer user lists."""
    perms = _load_user_permissions()
    try:
        from server.db import get_catalog_schema
        catalog, schema = get_catalog_schema()
        perms["table_location"] = f"{catalog}.{schema}.app_user_permissions"
    except Exception:
        perms["table_location"] = None
    # Tell the UI who the current user is so it can show implicit admin status
    perms["current_user"] = request.headers.get("X-Forwarded-Email", os.getenv("USER", "dev@local"))
    return perms


@router.post("/user-permissions")
async def save_user_permissions(request: Request, data: UserPermissionsModel) -> dict:
    """Save permissions to Delta table."""
    _require_admin(request)
    try:
        from server.db import get_catalog_schema
        catalog, schema = get_catalog_schema()
        if not catalog or not schema:
            raise HTTPException(
                status_code=400,
                detail="App storage location not configured — complete the Setup Wizard before managing permissions.",
            )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="App storage location not configured — complete the Setup Wizard before managing permissions.",
        )
    try:
        _save_user_permissions_to_table(data.admins, data.consumers)
        logger.info(f"Permissions saved to Delta table ({len(data.admins)} admins, {len(data.consumers)} consumers)")
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Failed to save permissions: {e}")
        raise HTTPException(status_code=500, detail="Failed to save permissions — check server logs")


# ── Refresh Schedule ─────────────────────────────────────────────────────────

_SCHEDULE_DEFAULTS: dict = {"enabled": True, "frequency": "nightly", "hour_utc": 9, "lookback_days": 180}


def _save_schedule_to_table(settings: dict) -> None:
    from server.db import execute_write
    _ensure_schedule_table()
    table = _config_table("app_schedule_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (settings_json, updated_at) VALUES (:s, current_timestamp())",
        {"s": json.dumps(settings)},
    )


def load_schedule_settings() -> dict:
    """Load schedule settings — Delta first (survives redeploys), file fallback."""
    try:
        from server.db import execute_query
        table = _config_table("app_schedule_settings")
        rows = execute_query(f"SELECT settings_json FROM {table} LIMIT 1", None, no_cache=True)
        if rows and rows[0].get("settings_json"):
            return {**_SCHEDULE_DEFAULTS, **json.loads(rows[0]["settings_json"])}
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load schedule settings from Delta (not yet created): %s", e)
        else:
            logger.warning("Could not load schedule settings from Delta (storage may not be configured yet): %s", e)

    # Fallback: local file (dev / first run before table exists)
    try:
        if os.path.exists(SCHEDULE_SETTINGS_FILE):
            with open(SCHEDULE_SETTINGS_FILE) as f:
                data = json.load(f)
            # Migrate to Delta opportunistically
            try:
                _save_schedule_to_table(data)
                logger.info("Migrated schedule settings from file to Delta")
            except Exception:
                pass
            return {**_SCHEDULE_DEFAULTS, **data}
    except Exception:
        pass

    # Neither Delta nor file — persist defaults to Delta so they survive the next redeploy
    defaults = dict(_SCHEDULE_DEFAULTS)
    try:
        _save_schedule_to_table(defaults)
        logger.info("Initialized schedule settings in Delta with defaults")
    except Exception:
        pass
    return defaults


@router.get("/schedule")
async def get_schedule_settings() -> dict:
    return load_schedule_settings()


@router.post("/schedule")
async def save_schedule_endpoint(request: Request, data: dict) -> dict:
    _require_admin(request)
    settings = {
        "enabled": bool(data.get("enabled", True)),
        "frequency": data.get("frequency", "nightly"),
        "hour_utc": max(0, min(23, int(data.get("hour_utc", 5)))),
        "lookback_days": int(data.get("lookback_days", 180)),
    }
    if settings["frequency"] not in ("nightly", "weekly", "monthly"):
        settings["frequency"] = "nightly"
    if settings["lookback_days"] not in (180, 365, 730, 1095):
        settings["lookback_days"] = 180
    try:
        _save_schedule_to_table(settings)
    except Exception as e:
        logger.warning("Could not save schedule settings to Delta: %s", e)
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(SCHEDULE_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)
    logger.info("Schedule settings saved: %s", settings)
    return settings


# ── Alert Thresholds ──────────────────────────────────────────────────────────

_ALERT_THRESHOLD_DEFAULTS: dict = {
    "spike_threshold_percent": 20,
    "daily_budget": 50000,
    "workspace_budget": 10000,
}


def _load_alert_thresholds() -> dict:
    """Load alert thresholds — Delta first, file fallback, then hardcoded defaults."""
    try:
        from server.db import execute_query
        table = _config_table("app_alert_thresholds")
        rows = execute_query(f"SELECT settings_json FROM {table} LIMIT 1", None, no_cache=True)
        if rows and rows[0].get("settings_json"):
            return {**_ALERT_THRESHOLD_DEFAULTS, **json.loads(rows[0]["settings_json"])}
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load alert thresholds from Delta (not yet created): %s", e)
        else:
            logger.warning("Could not load alert thresholds from Delta: %s", e)

    try:
        if os.path.exists(ALERT_THRESHOLDS_FILE):
            with open(ALERT_THRESHOLDS_FILE) as f:
                data = json.load(f)
            try:
                _save_alert_thresholds(data)
                logger.info("Migrated alert thresholds from file to Delta")
            except Exception:
                pass
            return {**_ALERT_THRESHOLD_DEFAULTS, **data}
    except Exception:
        pass

    return dict(_ALERT_THRESHOLD_DEFAULTS)


def _save_alert_thresholds(settings: dict) -> None:
    try:
        from server.db import execute_write
        _ensure_alert_thresholds_table()
        table = _config_table("app_alert_thresholds")
        execute_write(f"DELETE FROM {table}", None)
        execute_write(
            f"INSERT INTO {table} (settings_json, updated_at) VALUES (:s, current_timestamp())",
            {"s": json.dumps(settings)},
        )
    except Exception as e:
        logger.warning("Could not save alert thresholds to Delta: %s", e)
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(ALERT_THRESHOLDS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


@router.get("/alert-thresholds")
async def get_alert_thresholds() -> dict:
    return _load_alert_thresholds()


@router.post("/alert-thresholds")
async def save_alert_thresholds_endpoint(request: Request) -> dict:
    _require_admin(request)
    data = await request.json()
    settings = {
        "spike_threshold_percent": max(5.0, min(100.0, float(data.get("spike_threshold_percent", 20)))),
        "daily_budget": max(0.0, float(data.get("daily_budget", 50000))),
        "workspace_budget": max(0.0, float(data.get("workspace_budget", 10000))),
    }
    _save_alert_thresholds(settings)
    logger.info("Alert thresholds saved: %s", settings)
    return {"status": "saved"}


# ── Customer Discounts ────────────────────────────────────────────────────────

_ACCOUNT_PRICES_SQL = """
SELECT
  sku_name,
  cloud,
  currency_code,
  usage_unit,
  pricing.default        AS list_price,
  TRY(pricing.effective_list.default) AS effective_list_price,
  price_start_time       AS start_time,
  price_end_time         AS end_time
FROM system.billing.account_prices
WHERE price_end_time IS NULL
   OR price_end_time > CURRENT_TIMESTAMP
ORDER BY sku_name, cloud
"""

_LIST_PRICES_SQL = """
SELECT
  sku_name,
  cloud,
  currency_code,
  usage_unit,
  pricing.default        AS list_price,
  TRY(pricing.effective_list.default) AS effective_list_price,
  price_start_time       AS start_time,
  price_end_time         AS end_time
FROM system.billing.list_prices
WHERE price_end_time IS NULL
   OR price_end_time > CURRENT_TIMESTAMP
ORDER BY sku_name, cloud
"""


@router.get("/account-prices")
async def get_account_prices() -> dict[str, Any]:
    """Return customer-specific account prices from system.billing.account_prices.

    Falls back to system.billing.list_prices if account_prices is not available
    (the table is currently in private preview).
    """
    from server.db import execute_query as _exec

    _TRANSIENT_ERRORS = ("table", "not found", "does not exist", "cannot resolve", "http_path", "warehouse")

    # Try account_prices first (negotiated rates, private preview)
    try:
        rows = _exec(_ACCOUNT_PRICES_SQL)
        source = "account_prices"
    except Exception as e:
        err = str(e).lower()
        if any(kw in err for kw in _TRANSIENT_ERRORS):
            logger.info(f"system.billing.account_prices not available ({e}), falling back to list_prices")
            try:
                rows = _exec(_LIST_PRICES_SQL)
                source = "list_prices"
            except Exception as e2:
                logger.debug(f"system.billing.list_prices also unavailable: {e2}")
                return {"available": False, "prices": [], "source": None,
                        "message": "Billing price tables not accessible"}
        else:
            logger.warning(f"account_prices query failed: {e}")
            return {"available": False, "prices": [], "source": None, "message": str(e)}

    prices = [
        {
            "sku_name": r.get("sku_name") or "",
            "cloud": r.get("cloud") or "",
            "currency_code": r.get("currency_code") or "USD",
            "usage_unit": r.get("usage_unit") or "DBU",
            "list_price": float(r.get("list_price") or 0),
            "effective_list_price": float(r.get("effective_list_price") or r.get("list_price") or 0),
            "start_time": str(r.get("start_time")) if r.get("start_time") else None,
            "end_time": str(r.get("end_time")) if r.get("end_time") else None,
        }
        for r in rows
    ]
    return {"available": True, "prices": prices, "source": source, "count": len(prices)}


# ── Pricing Mode ──────────────────────────────────────────────────────────────

def _save_pricing_to_table(settings: dict) -> None:
    from server.db import execute_write
    _ensure_pricing_table()
    table = _config_table("app_pricing_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (settings_json, updated_at) VALUES (:s, current_timestamp())",
        {"s": json.dumps(settings)},
    )


def _load_pricing_settings() -> dict:
    """Load pricing settings — Delta first (survives redeploys), file fallback."""
    try:
        from server.db import execute_query
        table = _config_table("app_pricing_settings")
        rows = execute_query(f"SELECT settings_json FROM {table} LIMIT 1", None, no_cache=True)
        if rows and rows[0].get("settings_json"):
            return json.loads(rows[0]["settings_json"])
    except Exception as e:
        if _table_missing(e):
            logger.debug("Could not load pricing settings from Delta (not yet created): %s", e)
        else:
            logger.warning("Could not load pricing settings from Delta (storage may not be configured yet): %s", e)

    try:
        with open(PRICING_SETTINGS_FILE) as f:
            data = json.load(f)
        try:
            _save_pricing_to_table(data)
            logger.info("Migrated pricing settings from file to Delta")
        except Exception:
            pass
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Neither Delta nor file — persist defaults to Delta so they survive the next redeploy
    defaults = {"use_account_prices": False}
    try:
        _save_pricing_to_table(defaults)
        logger.info("Initialized pricing settings in Delta with defaults")
    except Exception:
        pass
    return defaults


def _save_pricing_settings(settings: dict) -> None:
    try:
        _save_pricing_to_table(settings)
    except Exception as e:
        logger.warning("Could not save pricing settings to Delta: %s", e)
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(PRICING_SETTINGS_FILE, "w") as f:
        json.dump(settings, f)


@router.get("/pricing-mode")
async def get_pricing_mode() -> dict[str, Any]:
    """Return the current pricing mode setting."""
    settings = _load_pricing_settings()
    return {
        "use_account_prices": settings.get("use_account_prices", False),
    }


@router.put("/pricing-mode")
async def set_pricing_mode(data: dict) -> dict[str, Any]:
    """Save the pricing mode setting."""
    use_account_prices = bool(data.get("use_account_prices", False))
    _save_pricing_settings({"use_account_prices": use_account_prices})
    return {"use_account_prices": use_account_prices, "status": "ok"}


# Usage-weighted blended account price multiplier query
_ACCOUNT_PRICE_MULTIPLIER_SQL = """
WITH recent_usage AS (
  SELECT
    u.sku_name,
    u.cloud,
    SUM(u.usage_quantity) AS total_quantity
  FROM system.billing.usage u
  WHERE u.usage_date >= CURRENT_DATE - INTERVAL 30 DAY
    AND u.usage_quantity > 0
  GROUP BY u.sku_name, u.cloud
),
price_comparison AS (
  SELECT
    cu.sku_name,
    cu.total_quantity,
    COALESCE(lp.pricing.default, 0)   AS list_price,
    COALESCE(ap.pricing.default, 0)   AS account_price
  FROM recent_usage cu
  LEFT JOIN system.billing.list_prices lp
    ON cu.sku_name = lp.sku_name AND cu.cloud = lp.cloud AND lp.price_end_time IS NULL
  LEFT JOIN system.billing.account_prices ap
    ON cu.sku_name = ap.sku_name AND cu.cloud = ap.cloud AND ap.price_end_time IS NULL
  WHERE lp.pricing.default > 0
    AND ap.pricing.default > 0
)
SELECT
  SUM(total_quantity * account_price) / NULLIF(SUM(total_quantity * list_price), 0) AS multiplier,
  COUNT(DISTINCT sku_name) AS sku_count,
  SUM(total_quantity * list_price)   AS weighted_list_spend,
  SUM(total_quantity * account_price) AS weighted_account_spend
FROM price_comparison
"""


@router.get("/account-price-multiplier")
async def get_account_price_multiplier() -> dict[str, Any]:
    """Compute a usage-weighted blended account price multiplier.

    Returns the ratio of account-negotiated prices to list prices,
    weighted by recent usage quantity. Used by the frontend to scale
    all spend figures when 'use_account_prices' is enabled.

    Returns multiplier=1.0 if account_prices table is unavailable.
    """
    from server.db import execute_query as _exec

    pricing_settings = _load_pricing_settings()
    use_account_prices = pricing_settings.get("use_account_prices", False)

    if not use_account_prices:
        return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0}

    try:
        rows = _exec(_ACCOUNT_PRICE_MULTIPLIER_SQL)
        if not rows or rows[0].get("multiplier") is None:
            return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0}
        row = rows[0]
        multiplier = float(row["multiplier"])
        sku_count = int(row.get("sku_count") or 0)
        discount_percent = round((1.0 - multiplier) * 100, 2)
        return {
            "multiplier": multiplier,
            "available": True,
            "sku_count": sku_count,
            "discount_percent": discount_percent,
            "weighted_list_spend": float(row.get("weighted_list_spend") or 0),
            "weighted_account_spend": float(row.get("weighted_account_spend") or 0),
        }
    except Exception as e:
        err = str(e).lower()
        if any(kw in err for kw in ("table", "not found", "does not exist", "cannot resolve")):
            logger.info("system.billing.account_prices not available for multiplier computation")
            return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0,
                    "message": "system.billing.account_prices not available (private preview)"}
        logger.warning(f"Account price multiplier computation failed: {e}")
        return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0}
