"""App settings endpoints - Cloud infrastructure connections management."""

import asyncio
import json
import logging
import os
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server.feedback import safe_feedback_slack_url

router = APIRouter()
logger = logging.getLogger(__name__)
_MV_SHARE_RUNBOOK = (
    Path(__file__).resolve().parents[1]
    / "assets"
    / "cost_obs_mv_share_publisher.py"
)

# Captured at module load time — proxy for "when this app process started",
# which in Databricks Apps corresponds to the most recent deployment.
_SERVER_START_TIME = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M") + " UTC"

_APP_STATE_TABLES = (
    "app_cloud_connections",
    "app_mv_refresh_state",
    "app_mv_sources",
    "app_refresh_log",
    "app_settings",
    "app_unified_views",
    "app_user_permissions",
)

_APP_RESPONSE_CACHE_TABLE = "app_response_cache"


def _managed_table_inventory() -> tuple[str, ...]:
    """Canonical aggregate + durable state inventory for one app storage schema."""
    from server.db import MV_UNIFIED_TABLE_NAMES

    return tuple(dict.fromkeys((
        *MV_UNIFIED_TABLE_NAMES,
        *_APP_STATE_TABLES,
        _APP_RESPONSE_CACHE_TABLE,
    )))


def _require_admin(request: Request) -> str:
    """Synchronous compatibility wrapper around the centralized fail-closed policy."""
    from server.auth import require_admin_sync

    return require_admin_sync(request)


async def _require_admin_async(request: Request) -> str:
    """Authorize an admin without running blocking permission SQL on the event loop."""
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_require_admin, request),
            timeout=8.0,
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Administrator authorization timed out",
        ) from exc


@router.get("/materialized-view-runbook")
async def download_materialized_view_runbook(request: Request) -> FileResponse:
    """Download the generated standalone publisher/share Run All notebook."""
    await _require_admin_async(request)
    if not _MV_SHARE_RUNBOOK.is_file():
        raise HTTPException(status_code=404, detail="Materialized view runbook is unavailable")
    return FileResponse(
        _MV_SHARE_RUNBOOK,
        media_type="text/x-python",
        filename="cost_obs_mv_share_publisher.py",
    )

# In-process cache for /api/settings/tables — expensive parallel SQL + owner lookups
_tables_cache: dict | None = None
_tables_cache_ts: float = 0.0
_TABLES_CACHE_TTL = 15 * 60  # 15 minutes — prewarm fills this at startup; 5 min expired too fast
_refresh_log_lock = threading.RLock()
_refresh_log_persistence_error: str | None = None
_refresh_log_restore_error: str | None = None
_settings_write_thread_lock = threading.RLock()


@contextmanager
def _settings_write_lock(name: str):
    """Serialize read-merge-overwrite settings operations across workers."""
    import fcntl

    os.makedirs(SETTINGS_DIR, exist_ok=True)
    lock_path = os.path.join(SETTINGS_DIR, f"{name}.lock")
    with _settings_write_thread_lock:
        with open(lock_path, "a+") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)


def _atomic_json_write(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(temp_path, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp_path, path)

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
    user to open Data & tables sees instant results instead of a 10-30s spinner.
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
    from server.db import StorageConfigurationError, get_catalog_schema, validate_app_storage_target
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


def _ensure_connections_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_cloud_connections')} "
        f"(id STRING NOT NULL, name STRING, provider STRING, created_at STRING, "
        f"config_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


_APP_SETTINGS_NAMESPACES = frozenset({
    "app",
    "alerts",
    "webhook",
    "pricing",
    "schedule",
    "workspace_filter",
})


def _ensure_app_settings_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_settings')} "
        f"(id STRING NOT NULL, settings_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _load_settings_namespace(namespace: str) -> dict | None:
    if namespace not in _APP_SETTINGS_NAMESPACES:
        raise ValueError(f"Unknown app settings namespace: {namespace}")
    try:
        from server.db import execute_query

        table = _config_table("app_settings")
        rows = execute_query(
            f"SELECT settings_json FROM {table} WHERE id = :id LIMIT 1",
            {"id": namespace},
            no_cache=True,
        )
        if rows and rows[0].get("settings_json"):
            value = json.loads(rows[0]["settings_json"])
            return value if isinstance(value, dict) else None
    except Exception as e:
        if _table_missing(e):
            logger.debug("app_settings table not yet created: %s", e)
        else:
            logger.warning("Could not load app_settings namespace %s: %s", namespace, e)
    return None


def _write_settings_namespace(namespace: str, settings: dict) -> None:
    if namespace not in _APP_SETTINGS_NAMESPACES:
        raise ValueError(f"Unknown app settings namespace: {namespace}")
    from server.db import execute_write

    _ensure_app_settings_table()
    table = _config_table("app_settings")
    execute_write(
        f"MERGE INTO {table} AS target "
        f"USING (SELECT :id AS id, :settings_json AS settings_json, "
        f"current_timestamp() AS updated_at) AS source "
        f"ON target.id = source.id "
        f"WHEN MATCHED THEN UPDATE SET settings_json = source.settings_json, "
        f"updated_at = source.updated_at "
        f"WHEN NOT MATCHED THEN INSERT (id, settings_json, updated_at) "
        f"VALUES (source.id, source.settings_json, source.updated_at)",
        {"id": namespace, "settings_json": json.dumps(settings)},
    )


def _save_settings_namespace(namespace: str, settings: dict) -> None:
    with _settings_write_lock(f"app-settings:{namespace}"):
        _write_settings_namespace(namespace, settings)


# ── Workspace filter pool (survives deploys via Delta) ────────────────────────

def save_workspace_filter_to_table(workspace_ids: list) -> None:
    """Persist workspace filter pool in its app_settings namespace."""
    _save_settings_namespace("workspace_filter", {"workspace_ids": workspace_ids})
    logger.info("Workspace filter pool saved to Delta: %d ids", len(workspace_ids))


def restore_workspace_filter_from_delta() -> None:
    """Read saved workspace filter namespace and write the startup file mirror."""
    import json as _json
    try:
        settings = _load_settings_namespace("workspace_filter")
        if not settings or not isinstance(settings.get("workspace_ids"), list):
            return
        workspace_ids = settings["workspace_ids"]
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
    """Append a refresh-log snapshot to Delta so it survives redeployments.

    The original DELETE+INSERT pair exposed an empty table between statements and
    let concurrent workers erase one another. Appending snapshots is atomic and
    backward-compatible with the existing ``(log_json, updated_at)`` table.
    Readers select the newest snapshot.
    """
    global _refresh_log_persistence_error
    import json as _json

    from server.db import execute_write
    try:
        _ensure_refresh_log_table()
        table = _config_table("app_refresh_log")
        execute_write(
            f"INSERT INTO {table} (log_json, updated_at) "
            f"VALUES (:log_json, current_timestamp())",
            {"log_json": _json.dumps(log_data)},
        )
        _refresh_log_persistence_error = None
        logger.info("Refresh log appended to Delta (status=%s)", log_data.get("status"))
    except Exception as e:
        _refresh_log_persistence_error = str(e)[:500]
        raise


def _refresh_log_path() -> str:
    return os.path.join(SETTINGS_DIR, "mv_refresh_log.json")


def _read_refresh_log_file() -> dict | None:
    try:
        with open(_refresh_log_path()) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _write_refresh_log_file(log_data: dict) -> None:
    """Atomically replace the local refresh-log cache."""
    path = _refresh_log_path()
    tmp = path + ".tmp"
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(log_data, f)
    os.replace(tmp, path)


def load_refresh_log(*, restore_if_missing: bool = True) -> dict | None:
    """Read the local log, lazily restoring the newest Delta snapshot if absent."""
    data = _read_refresh_log_file()
    if data is not None or not restore_if_missing:
        return data
    return restore_refresh_log_from_delta()


def classify_refresh_history_entry(entry: dict) -> str:
    """Return the user-facing operation class for a durable history entry."""
    explicit = entry.get("operation")
    if explicit:
        return str(explicit)
    trigger = str(entry.get("trigger") or "")
    note = str(entry.get("note") or "")
    if trigger in {"manual", "scheduled", "startup"}:
        return "rebuild"
    if trigger == "config" and note.startswith("Added shared source"):
        return "source_added"
    if trigger == "config" and note.startswith("Removed shared source"):
        return "source_removed"
    return "other"


def visible_refresh_history(entries: Any) -> list[dict]:
    """Normalize and filter history for Settings.

    Startup freshness checks are maintenance probes, not rebuild attempts. Keep
    actual automatic/manual rebuild results and successful source additions.
    """
    if not isinstance(entries, list):
        return []
    visible: list[dict] = []
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        entry = dict(raw)
        operation = classify_refresh_history_entry(entry)
        entry["operation"] = operation
        if (
            entry.get("trigger") == "startup"
            and entry.get("status") == "skipped"
        ):
            continue
        if operation not in {"rebuild", "source_added"}:
            continue
        visible.append(entry)
    return visible


def persist_refresh_log(log_data: dict, history_entry: dict | None = None) -> dict:
    """Persist one refresh result and optionally append exactly one history entry."""
    global _tables_cache, _tables_cache_ts
    with _refresh_log_lock:
        import fcntl
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        lock_path = os.path.join(SETTINGS_DIR, "mv_refresh_log.lock")
        with open(lock_path, "w") as lock_file:
            # Cross-process lock: config events, manual requests, startup, and
            # scheduler workers cannot read-modify-write the local history at once.
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                current = load_refresh_log() or {}
                merged = dict(current)
                merged.update(log_data)
                if history_entry is not None:
                    history_entry = dict(history_entry)
                    history_entry.setdefault("id", uuid.uuid4().hex)
                    history_entry.setdefault(
                        "operation", classify_refresh_history_entry(history_entry)
                    )
                    prior = current.get("refresh_history")
                    history = list(prior) if isinstance(prior, list) else []
                    history.append(history_entry)
                    merged["refresh_history"] = history[-20:]
                _write_refresh_log_file(merged)
                try:
                    save_refresh_log_to_delta(merged)
                except Exception as e:
                    # Local history remains useful in this process. The API exposes
                    # this durability failure rather than implying it was persisted.
                    logger.warning("Could not persist refresh log to Delta: %s", e)
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)
        _tables_cache = None
        _tables_cache_ts = 0.0
        return merged


def append_refresh_history(status: str, trigger: str, *, lookback_days: int | None = None,
                           duration_seconds: float = 0, note: str | None = None,
                           error: str | None = None,
                           block_reason: str | None = None,
                           operation: str | None = None) -> None:
    """Append one entry to the rebuild-history log (file + Delta), keeping the last 20.

    Used for refresh runs that don't go through app._run_mv_refresh (the startup/auto
    build) and for config/lineage events like adding or removing a shared MV source, so
    the Rebuild history reflects everything that changed the managed tables — not only
    manual "Rebuild now" and nightly runs.
    """
    from datetime import datetime, timezone
    try:
        entry: dict = {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "status": status,
            "duration_seconds": round(duration_seconds, 1),
            "lookback_days": lookback_days,
            "trigger": trigger,
        }
        if note:
            entry["note"] = note
        if error:
            entry["error"] = error[:200]
        if block_reason:
            entry["block_reason"] = block_reason[:500]
        if operation:
            entry["operation"] = operation
        persist_refresh_log({}, entry)
    except Exception as e:
        logger.debug("append_refresh_history (non-fatal): %s", e)


def restore_refresh_log_from_delta() -> dict | None:
    """Restore the newest saved refresh-log snapshot from Delta.

    Returns the decoded log so callers such as ``/tables`` can use it even if the
    local cache write fails.
    """
    global _refresh_log_restore_error
    import json as _json
    try:
        from server.db import execute_query
        table = _config_table("app_refresh_log")
        rows = execute_query(
            f"SELECT log_json FROM {table} ORDER BY updated_at DESC LIMIT 50",
            None,
            no_cache=True,
        )
        if not rows or not rows[0].get("log_json"):
            _refresh_log_restore_error = None
            return None
        # The newest row supplies top-level status. Merge history from recent
        # snapshots so two processes appending at nearly the same time cannot
        # hide one another. Legacy single-row snapshots work unchanged.
        snapshots: list[dict] = []
        for row in reversed(rows):
            raw = row.get("log_json")
            if not raw:
                continue
            parsed = _json.loads(raw)
            if isinstance(parsed, dict):
                snapshots.append(parsed)
        if not snapshots:
            return None
        log_data = dict(snapshots[-1])
        merged_history: list[dict] = []
        seen: set[str] = set()
        for snapshot in snapshots:
            entries = snapshot.get("refresh_history")
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                key = str(entry.get("id") or _json.dumps(entry, sort_keys=True, default=str))
                if key in seen:
                    continue
                seen.add(key)
                merged_history.append(entry)
        log_data["refresh_history"] = merged_history[-20:]
        if not isinstance(log_data, dict):
            raise ValueError("latest app_refresh_log row is not a JSON object")
        try:
            _write_refresh_log_file(log_data)
        except OSError as e:
            logger.warning("Refresh log read from Delta but local cache write failed: %s", e)
        _refresh_log_restore_error = None
        logger.info("Restored refresh log from Delta (last_refresh=%s)", log_data.get("last_refresh_utc"))
        return log_data
    except Exception as e:
        _refresh_log_restore_error = str(e)[:500]
        if _table_missing(e):
            logger.debug("Could not restore refresh log from Delta (not yet created): %s", e)
        else:
            logger.warning(f"Could not restore refresh log from Delta (non-fatal): {e}")
        return None


def get_refresh_log_status(*, block_reason: str | None = None) -> dict | None:
    """Return the API refresh status, including durability and restore failures."""
    log_data = load_refresh_log()
    if log_data is None and not block_reason and not _refresh_log_persistence_error and not _refresh_log_restore_error:
        return None

    log_data = log_data or {}
    last_refresh = log_data.get("last_refresh_utc")
    hours_since: float | None = None
    if last_refresh:
        try:
            from datetime import datetime as _dt
            from datetime import timezone as _tz
            last = _dt.strptime(last_refresh, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_tz.utc)
            hours_since = round((_dt.now(_tz.utc) - last).total_seconds() / 3600, 1)
        except (TypeError, ValueError):
            hours_since = None

    effective_block = block_reason or log_data.get("block_reason")
    status = log_data.get("status", "blocked" if effective_block else "unknown")
    result: dict[str, Any] = {
        "last_refresh_utc": last_refresh,
        "last_attempt_utc": log_data.get("last_attempt_utc"),
        "duration_seconds": log_data.get("duration_seconds"),
        "hours_since_refresh": hours_since,
        "stale": hours_since is None or hours_since > 26,
        "status": status,
        "lookback_days": log_data.get("lookback_days"),
        "refresh_history": visible_refresh_history(
            log_data.get("refresh_history", [])
        ),
    }
    if log_data.get("error"):
        result["error"] = log_data["error"]
    if effective_block:
        result["block_reason"] = effective_block
    persistence_error = _refresh_log_persistence_error or _refresh_log_restore_error
    if persistence_error:
        result["persistence_error"] = persistence_error
    return result


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

    # Storage location: env var / override file read. On GCP after a redeploy this can
    # be empty (env unset, .settings wiped, DBFS disabled) until autodiscovery has run —
    # which left the "Catalog & schema" chip showing just ".". Self-heal by discovering
    # the location from where the MV tables already live, same as startup.
    storage_location = None
    try:
        catalog, schema = get_catalog_schema()
        if not (catalog and schema):
            try:
                from server.routers.setup import autodiscover_storage_location
                discovered = autodiscover_storage_location()
                if discovered:
                    catalog, schema = discovered
            except Exception as _disc_err:
                logger.debug("Config storage auto-discovery skipped (non-fatal): %s", _disc_err)
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
    from server.db import _user_token, execute_query, get_catalog_schema_status

    # Read the raw forwarded token directly — _auth_mode may be locked to "sp"
    # (e.g. warehouse was cold on startup and the scope check failed), which forces
    # _user_token to "" even when x-forwarded-access-token IS present.  Reading the
    # header directly bypasses that lock and ensures table checks always run as the
    # user when the SQL scope is configured.
    _captured_token = (
        request.headers.get("x-forwarded-access-token", "")
        or _user_token.get()
    )

    MV_TABLES = list(_managed_table_inventory())
    # Which tables are conceptually "materialized views" (rebuilt on schedule)
    # vs persistent managed tables
    MV_SET = {
        "daily_usage_summary", "daily_product_breakdown", "daily_workspace_breakdown",
        "sql_tool_attribution", "daily_query_stats", "dbsql_cost_per_query",
        "daily_tag_summary", "daily_tag_coverage_summary", "daily_apps_summary",
    }

    try:
        storage_status = get_catalog_schema_status()
        catalog = storage_status["catalog"]
        schema = storage_status["schema"]
    except Exception as e:
        return {"catalog": None, "schema": None, "tables": [], "error": str(e)}

    if not catalog or not schema:
        block_reason = storage_status.get("block_reason") or "App storage location is not configured."
        result = {
            "catalog": None,
            "schema": None,
            "tables": [],
            "error": block_reason,
            "storage_block_reason": block_reason,
            "auth_error": None,
            "refresh_status": get_refresh_log_status(block_reason=block_reason),
        }
        _tables_cache = result
        _tables_cache_ts = time.time()
        return result


    # Tables that don't have a usage_date column — use an alternate date expression or skip date
    date_expr_overrides = {
        "dbsql_cost_per_query": "CAST(MAX(start_time) AS DATE)",
    }
    no_date_tables = set(_APP_STATE_TABLES) | {_APP_RESPONSE_CACHE_TABLE}

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
        def _table_not_found(error: str) -> bool:
            return "TABLE_OR_VIEW_NOT_FOUND" in error or "table or view" in error.lower()

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
    CONFIG_TABLES: set[str] = set(no_date_tables)

    # Build task list: (table_name, fqn, table_type)
    tasks = [
        (t, f"`{catalog}`.`{schema}`.`{t}`", "Materialized View" if t in MV_SET else "Table")
        for t in MV_TABLES
    ]

    results = []
    # 30s — a warming warehouse (e.g. right after adding a shared source kicks off a
    # unified-view rebuild) can take >12s to answer per-table probes; the old 12s
    # produced spurious "?" error rows on healthy tables. Base-table probes are fast
    # once warm, so this only extends the cold/contended case.
    _TABLE_CHECK_TIMEOUT = 30
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

    # The local file is only a cache. If it was wiped by a redeploy, this lazily
    # restores the newest Delta snapshot and exposes any restore/durability error.
    refresh_status = get_refresh_log_status()

    result = {"catalog": catalog, "schema": schema, "tables": results, "auth_error": auth_error, "refresh_status": refresh_status}
    _tables_cache = result
    _tables_cache_ts = time.time()
    return result


@router.get("/catalog")
async def get_catalog_settings():
    """Return current catalog/schema and whether it's from an override or env vars."""
    from server.db import get_catalog_schema_info
    return get_catalog_schema_info()


@router.get("/app-links")
async def get_app_links() -> dict:
    """URLs for the Settings → Config card: the app's source code in the customer
    workspace, and the app's page in Databricks Apps (its "backend").

    Best-effort and never raises — any field that can't be resolved is left "".
    The app asks the Apps API about ITSELF (SP identity), so this works even when
    the viewer is not a workspace admin. A Git-deployed app has no workspace source
    folder, so its source link falls back to the Databricks Apps page.
    """
    import asyncio
    import re as _re

    host = (os.getenv("DATABRICKS_HOST") or "").rstrip("/")
    if host and not host.startswith("http"):
        host = "https://" + host
    app_name = (os.getenv("DATABRICKS_APP_NAME") or "").strip()
    out: dict[str, Any] = {
        "host": host, "app_name": app_name,
        "app_url": "", "app_page_url": "", "source_code_url": "",
    }
    if not host or not app_name:
        return out

    def _resolve() -> dict:
        from server.db import get_workspace_client
        w = get_workspace_client()
        body = w.api_client.do("GET", f"/api/2.0/apps/{app_name}") or {}
        folder_id = ""
        # Uploaded / bundle deploys carry a /Workspace path we can turn into the
        # folder-browser id. Git deploys report a repo path (no workspace object).
        dep = body.get("active_deployment") or {}
        app_git_repository = body.get("git_repository") or {}
        git_backed = bool(dep.get("git_source") or app_git_repository)
        # Git deploy: the source lives in the Git repo, not a workspace folder.
        git_url = ""
        if git_backed:
            gs = dep.get("git_source") or {}
            git_url = ((gs.get("git_repository") or {}).get("url")
                       or app_git_repository.get("url") or "")
        src_path = "" if git_backed else (dep.get("source_code_path") or "")
        if isinstance(src_path, str) and src_path.startswith("/Workspace/"):
            try:
                st = w.api_client.do("GET", "/api/2.0/workspace/get-status", query={"path": src_path}) or {}
                oid = st.get("object_id") if st.get("object_id") is not None else st.get("resource_id")
                if oid is not None:
                    folder_id = str(oid)
            except Exception as exc:
                logger.info("app-links: could not resolve folder id for %s: %s", src_path, exc)
        return {"body": body, "folder_id": folder_id, "git_url": git_url}

    try:
        resolved = await asyncio.to_thread(_resolve)
    except Exception as e:
        logger.warning("app-links: could not fetch app %s: %s", app_name, e)
        out["error"] = str(e)
        return out

    body = resolved.get("body") or {}
    app_url = body.get("url") or ""
    out["app_url"] = app_url

    # Workspace id, read off the app's own hostname
    # (<name>-<workspace-id>.<cloud>.databricksapps.com) — nothing hands the
    # container a workspace id directly.
    m = _re.search(r"-(\d{6,})\.", app_url)
    wsid = m.group(1) if m else (os.getenv("DATABRICKS_WORKSPACE_ID") or "").strip()
    org = f"?o={wsid}" if wsid else ""

    # The app's page in Databricks Apps (apps-v2 UI) — compute, logs, deployments.
    out["app_page_url"] = f"{host}/apps-v2/app/{app_name}/overview{org}"

    # Source code: the workspace folder that holds what is serving, when the
    # workspace resolved one; otherwise the Git repository the app deploys from
    # (a Git deploy has no workspace folder). Left blank if neither — never the
    # same target as the backend link.
    fid = resolved.get("folder_id") or ""
    git_url = resolved.get("git_url") or ""
    if fid:
        out["source_code_url"] = f"{host}/browse/folders/{fid}{org}"
    elif git_url:
        out["source_code_url"] = git_url
    else:
        out["source_code_url"] = ""
    return out


def _safe_identity_url(host: str, object_id: str) -> str:
    """Return the workspace SCIM identity URL, or an empty string if unsafe."""
    parsed = urlparse((host or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not object_id
    ):
        return ""
    clean_host = f"{parsed.scheme}://{parsed.netloc}"
    return (
        f"{clean_host}/api/2.0/preview/scim/v2/ServicePrincipals/"
        f"{quote(str(object_id), safe='')}"
    )


def _safe_resource_link(value: str) -> str:
    """Keep HTTPS resource links while dropping credentials and unsafe queries."""
    parsed = urlparse((value or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        return ""
    query = parsed.query
    if query and not (
        query.startswith("o=") and query.removeprefix("o=").isdigit()
    ):
        query = ""
    return parsed._replace(query=query, fragment="").geturl()


def _resource_connection_metadata(limit: int = 100) -> list[dict[str, Any]]:
    """Read only non-secret connection fields with a hard result bound."""
    rows: list[dict[str, Any]] = []
    try:
        from server.db import execute_query

        rows = execute_query(
            "SELECT id, name, provider, created_at "
            f"FROM {_config_table('app_cloud_connections')} "
            f"ORDER BY created_at LIMIT {int(limit)}",
            None,
            no_cache=True,
        )
    except Exception as exc:
        logger.debug("Resource connection metadata falling back to local state: %s", exc)
        rows = _load_connections_from_file()[:limit]
    return [
        {
            key: connection.get(key)
            for key in ("id", "name", "provider", "created_at")
            if connection.get(key) is not None
        }
        for connection in rows[:limit]
    ]


def _resource_shared_source_metadata(limit: int = 100) -> list[dict[str, Any]]:
    """Read safe shared-source metadata from Delta with a hard result bound."""
    try:
        from server.db import execute_query, get_catalog_schema

        catalog, schema = get_catalog_schema()
        if not catalog or not schema:
            return []
        rows = execute_query(
            f"SELECT label, catalog, schema, tables, workspace_ids, cloud, added_at "
            f"FROM `{catalog}`.`{schema}`.`app_mv_sources` LIMIT {int(limit)}",
            None,
            no_cache=True,
        )
    except Exception as exc:
        logger.debug("Shared-source resource metadata is unavailable: %s", exc)
        return []

    sources = []
    for row in rows[:limit]:
        tables = row.get("tables")
        if isinstance(tables, str):
            try:
                tables = json.loads(tables)
            except (TypeError, json.JSONDecodeError):
                tables = None
        source = {
            key: row.get(key)
            for key in ("label", "catalog", "schema", "cloud", "added_at")
            if row.get(key) is not None
        }
        if isinstance(tables, list):
            source["tables"] = [str(table) for table in tables[:100]]
        workspace_ids = row.get("workspace_ids")
        if isinstance(workspace_ids, str):
            try:
                workspace_ids = json.loads(workspace_ids)
            except (TypeError, json.JSONDecodeError):
                workspace_ids = None
        if isinstance(workspace_ids, list):
            source["workspace_ids"] = [str(value) for value in workspace_ids[:100]]
        sources.append(source)
    return sources


def _resource_unified_views(limit: int = 100) -> list[str]:
    """List routed view names through one bounded information-schema query."""
    try:
        from server.db import MV_UNIFIED_SUFFIX, execute_query, get_catalog_schema

        catalog, schema = get_catalog_schema()
        if not catalog or not schema:
            return []
        rows = execute_query(
            "SELECT table_name FROM system.information_schema.views "
            "WHERE table_catalog = :catalog AND table_schema = :schema "
            "AND table_name LIKE :pattern "
            f"ORDER BY table_name LIMIT {int(limit)}",
            {
                "catalog": catalog,
                "schema": schema,
                "pattern": f"%{MV_UNIFIED_SUFFIX}",
            },
            no_cache=True,
        )
        return [
            str(row["table_name"])[: -len(MV_UNIFIED_SUFFIX)]
            for row in rows[:limit]
            if str(row.get("table_name") or "").endswith(MV_UNIFIED_SUFFIX)
        ]
    except Exception as exc:
        logger.debug("Unified-view resource metadata is unavailable: %s", exc)
        return []


_RESOURCES_SUBSECTION_TIMEOUT_SECONDS = 3.0
_RESOURCES_ENDPOINT_DEADLINE_SECONDS = 9.0


def _resource_subsection_status(available: bool) -> dict[str, Any]:
    if available:
        return {"available": True}
    return {"available": False, "reason": "temporarily_unavailable"}


async def _bounded_resource_call(
    name: str,
    awaitable,
    fallback: Any,
) -> tuple[Any, dict[str, Any]]:
    try:
        value = await asyncio.wait_for(
            awaitable,
            timeout=_RESOURCES_SUBSECTION_TIMEOUT_SECONDS,
        )
        return value, _resource_subsection_status(True)
    except asyncio.TimeoutError:
        logger.warning(
            "Settings Resources subsection %s timed out after %.1fs",
            name,
            _RESOURCES_SUBSECTION_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning("Settings Resources subsection %s failed: %s", name, exc)
    return fallback, _resource_subsection_status(False)


async def _bounded_resource_thread(
    name: str,
    operation,
    fallback: Any,
) -> tuple[Any, dict[str, Any]]:
    return await _bounded_resource_call(
        name,
        asyncio.to_thread(operation),
        fallback,
    )


async def _bounded_async_resource(
    name: str,
    operation,
    fallback: Any,
) -> tuple[Any, dict[str, Any]]:
    """Isolate async handlers too, because some contain blocking SDK/file work."""
    return await _bounded_resource_thread(
        name,
        lambda: asyncio.run(operation()),
        fallback,
    )


def _resource_inventory_from_parts(
    sources: list[dict[str, Any]],
    connections: list[dict[str, Any]],
    routed_views: list[str],
    workspace_ids: list[str],
) -> dict[str, Any]:
    from server import db
    from server.db import MV_UNIFIED_TABLE_NAMES

    with db._query_cache_lock:
        process_cache_entries = len(db._query_cache)

    observed_tables = None
    if (
        _tables_cache is not None
        and (time.time() - _tables_cache_ts) < _TABLES_CACHE_TTL
    ):
        observed_tables = {
            "checked_at": datetime.fromtimestamp(
                _tables_cache_ts, tz=timezone.utc
            ).isoformat(),
            "available": sum(
                1 for table in _tables_cache.get("tables", [])
                if table.get("exists") is True
            ),
            "total": len(_tables_cache.get("tables", [])),
        }

    return {
        "inventory": {
            "aggregates": {
                "count": len(MV_UNIFIED_TABLE_NAMES),
                "names": list(MV_UNIFIED_TABLE_NAMES),
            },
            "state": {
                "count": len(_APP_STATE_TABLES),
                "names": list(_APP_STATE_TABLES),
            },
            "cache": {
                "count": 2,
                "names": ["in-process query cache", "app_response_cache"],
                "process_entries": process_cache_entries,
                "process_max_entries": db._CACHE_MAX_SIZE,
                "process_ttl_seconds": db._CACHE_TTL,
            },
            "unified_views": {
                "count": len(routed_views),
                "names": list(routed_views),
            },
            "observed_tables": observed_tables,
        },
        "shared_data_sources": sources,
        "cloud_cost_connections": connections,
        "workspace_filter": {
            "mode": "restricted" if workspace_ids else "all_workspaces",
            "count": len(workspace_ids),
        },
    }


def _resource_inventory_snapshot() -> dict[str, Any]:
    """Collect bounded resource metadata without scanning managed data."""
    from server.workspace_filter import get_configured_workspace_ids

    return _resource_inventory_from_parts(
        _resource_shared_source_metadata(),
        _resource_connection_metadata(),
        _resource_unified_views(),
        get_configured_workspace_ids(),
    )


async def _resource_inventory_snapshot_bounded() -> tuple[
    dict[str, Any],
    dict[str, dict[str, Any]],
]:
    """Run independent SQL/config inventory probes concurrently and fail open."""
    from server.workspace_filter import get_configured_workspace_ids

    (
        (sources, sources_status),
        (connections, connections_status),
        (views, views_status),
        (workspace_ids, workspace_status),
    ) = await asyncio.gather(
        _bounded_resource_thread(
            "shared_data_sources",
            _resource_shared_source_metadata,
            [],
        ),
        _bounded_resource_thread(
            "cloud_cost_connections",
            _resource_connection_metadata,
            [],
        ),
        _bounded_resource_thread(
            "unified_views",
            _resource_unified_views,
            [],
        ),
        _bounded_resource_thread(
            "workspace_filter",
            get_configured_workspace_ids,
            [],
        ),
    )
    return (
        _resource_inventory_from_parts(
            sources,
            connections,
            views,
            workspace_ids,
        ),
        {
            "shared_data_sources": sources_status,
            "cloud_cost_connections": connections_status,
            "unified_views": views_status,
            "workspace_filter": workspace_status,
        },
    )


def _resource_refresh_snapshot() -> dict[str, Any]:
    return {
        "schedule": load_schedule_settings(),
        "status": get_refresh_log_status(),
    }


@router.get("/resources")
async def get_resources() -> dict[str, Any]:
    """Return partial safe metadata within a hard Settings deadline."""
    from server.routers.health import (
        _deployment_metadata_from_process_start,
        deployment_metadata,
    )

    empty_config = {
        "storage_location": {},
        "warehouse": None,
        "version": {},
    }
    empty_links = {
        "app_name": os.getenv("DATABRICKS_APP_NAME", ""),
        "app_url": "",
        "app_page_url": "",
        "source_code_url": "",
    }
    empty_refresh = {
        "schedule": {
            "enabled": False,
            "frequency": "nightly",
            "hour_utc": 5,
            "lookback_days": 180,
        },
        "status": None,
    }
    calls = asyncio.gather(
        _bounded_async_resource("config", get_app_config, empty_config),
        _bounded_async_resource(
            "service_principal",
            get_auth_status_endpoint,
            {},
        ),
        _bounded_async_resource("app_links", get_app_links, empty_links),
        _bounded_async_resource(
            "deployment",
            deployment_metadata,
            _deployment_metadata_from_process_start(),
        ),
        _resource_inventory_snapshot_bounded(),
        _bounded_resource_thread(
            "refresh",
            _resource_refresh_snapshot,
            empty_refresh,
        ),
    )
    try:
        (
            (config, config_status),
            (auth_status, auth_status_status),
            (links, links_status),
            (deployment, deployment_status),
            (inventory, inventory_statuses),
            (refresh, refresh_status),
        ) = await asyncio.wait_for(
            calls,
            timeout=_RESOURCES_ENDPOINT_DEADLINE_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error(
            "Settings Resources exceeded its %.1fs hard deadline",
            _RESOURCES_ENDPOINT_DEADLINE_SECONDS,
        )
        config, config_status = empty_config, _resource_subsection_status(False)
        auth_status, auth_status_status = {}, _resource_subsection_status(False)
        links, links_status = empty_links, _resource_subsection_status(False)
        deployment = _deployment_metadata_from_process_start()
        deployment_status = _resource_subsection_status(False)
        inventory = _resource_inventory_from_parts([], [], [], [])
        inventory_statuses = {
            name: _resource_subsection_status(False)
            for name in (
                "shared_data_sources",
                "cloud_cost_connections",
                "unified_views",
                "workspace_filter",
            )
        }
        refresh, refresh_status = empty_refresh, _resource_subsection_status(False)

    storage = config.get("storage_location") or {}
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "subsections": {
            "config": config_status,
            "service_principal": auth_status_status,
            "app_links": links_status,
            "deployment": deployment_status,
            **inventory_statuses,
            "refresh": refresh_status,
        },
        "app": {
            "name": links.get("app_name") or os.getenv("DATABRICKS_APP_NAME", ""),
            "url": _safe_resource_link(links.get("app_url") or ""),
            "page_url": _safe_resource_link(links.get("app_page_url") or ""),
            "source_code_url": _safe_resource_link(
                links.get("source_code_url") or ""
            ),
            "deployment": deployment,
            "version": {
                key: (config.get("version") or {}).get(key)
                for key in ("commit_sha", "branch", "commit_date")
                if (config.get("version") or {}).get(key)
            },
        },
        "service_principal": {
            "display_name": auth_status.get("sp_display_name") or "",
            "client_id": auth_status.get("sp_client_id") or "",
            "object_id": auth_status.get("sp_object_id") or "",
            "user_name": auth_status.get("sp_user_name") or "",
            "identity_url": auth_status.get("sp_identity_url") or "",
            "execution_identity": "service_principal",
            "execution_explanation": (
                "Dashboard queries and managed-data maintenance run as this "
                "Databricks Apps service principal, not as an interactive user."
            ),
            "effective_oauth_scopes": auth_status.get(
                "effective_oauth_scopes", []
            ),
            "oauth_scope_source": auth_status.get("oauth_scope_source"),
        },
        "warehouse": config.get("warehouse"),
        "storage": {
            "catalog": storage.get("catalog") or "",
            "schema": storage.get("schema") or "",
            "permissions_table": (
                f"{storage.get('catalog')}.{storage.get('schema')}."
                "app_user_permissions"
                if storage.get("catalog") and storage.get("schema")
                else ""
            ),
        },
        "refresh": refresh,
        **inventory,
    }


# ── Additional MV sources (union of Delta-shared / cross-workspace MVs) ───────

def _invalidate_mv_caches() -> None:
    """Clear caches so a just-changed set of MV sources is reflected immediately."""
    try:
        from server.db import clear_query_cache, delta_cache_invalidate
        clear_query_cache()
        delta_cache_invalidate()
    except Exception as exc:
        logger.debug("MV cache invalidation (non-fatal): %s", exc)
    try:
        from server.routers.billing import _mv_cache
        _mv_cache["available"] = None
        _mv_cache["checked_at"] = 0
    except Exception:
        pass


def _detect_source_cloud(catalog: str) -> str | None:
    """Best-effort detect which cloud a Delta-shared catalog originates from
    ('gcp' | 'aws' | 'azure'), via its provider's cloud/region. None if unknown."""
    try:
        from server.db import get_workspace_client
        w = get_workspace_client()
        provider_name = getattr(w.catalogs.get(catalog), "provider_name", None)
        if not provider_name:
            return None
        prov = w.providers.get(provider_name)
        hint = " ".join(str(getattr(prov, a, "") or "") for a in ("cloud", "region")).lower()
        # recipient_profile can also carry a region/endpoint hint
        rp = getattr(prov, "recipient_profile", None)
        if rp:
            hint += " " + str(getattr(rp, "endpoint", "") or "").lower()
        if "gcp" in hint or "google" in hint:
            return "gcp"
        if "azure" in hint:
            return "azure"
        if "aws" in hint or "amazon" in hint:
            return "aws"
    except Exception as e:
        logger.debug("Source cloud detection failed for %s (non-fatal): %s", catalog, e)
    # Provider metadata can be hidden from the app SP even when the shared
    # catalog itself is readable. Preserve common cloud/region hints in the
    # catalog name so a source does not lose its icon after being re-saved.
    name_hint = (catalog or "").lower().replace("-", "").replace("_", "")
    if any(marker in name_hint for marker in ("gcp", "google", "west4", "central1", "east1", "east4")):
        return "gcp"
    if any(marker in name_hint for marker in ("azure", "eastus", "westus", "westeurope")):
        return "azure"
    if any(marker in name_hint for marker in ("aws", "useast", "uswest", "euwest")):
        return "aws"
    return None


def _current_workspace_cloud() -> str:
    from server.db import get_host_url

    host = get_host_url().lower()
    if "gcp.databricks.com" in host:
        return "gcp"
    if "azuredatabricks.net" in host:
        return "azure"
    return "aws"


def _share_last_updated(catalog: str, schema: str, tables: list[str] | None) -> str | None:
    """Best-effort latest lastModified across the source's shared tables (ISO string)."""
    from datetime import datetime, timezone

    from server.db import execute_query
    from server.materialized_views import _MV_TABLES

    latest: tuple[datetime, str] | None = None
    for t in (tables or _MV_TABLES):
        try:
            rows = execute_query(f"DESCRIBE DETAIL `{catalog}`.`{schema}`.`{t}`", None, no_cache=True)
            if rows and rows[0].get("lastModified"):
                raw = rows[0]["lastModified"]
                if isinstance(raw, datetime):
                    parsed = raw
                else:
                    parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                parsed = (
                    parsed.replace(tzinfo=timezone.utc)
                    if parsed.tzinfo is None
                    else parsed.astimezone(timezone.utc)
                )
                candidate = (parsed, str(raw))
                if latest is None or candidate[0] > latest[0]:
                    latest = candidate
        except Exception:
            continue
    return latest[1] if latest else None


def _catalog_explorer_table_links(
    catalog: str, schema: str, tables: list[str] | None
) -> list[dict[str, str]]:
    """Build workspace-local Catalog Explorer links for exact shared tables."""
    from server.db import get_host_url
    from server.materialized_views import _MV_TABLES

    host = get_host_url().rstrip("/")
    if not host or not catalog or not schema:
        return []
    links = []
    for table in tables or _MV_TABLES:
        if not table:
            continue
        fqn = f"{catalog}.{schema}.{table}"
        path = "/".join(quote(part, safe="") for part in (catalog, schema, table))
        links.append(
            {
                "fqn": fqn,
                "url": f"{host}/explore/data/{path}",
            }
        )
    return links


def _catalog_explorer_schema_url(catalog: str, schema: str) -> str:
    """Build a workspace-local Catalog Explorer link for a shared schema."""
    from server.db import get_host_url

    host = get_host_url().rstrip("/")
    if not host or not catalog or not schema:
        return ""
    path = "/".join(quote(part, safe="") for part in (catalog, schema))
    return f"{host}/explore/data/{path}"


def _visible_shared_tables(catalog: str, schema: str) -> set[str]:
    """List shared objects separately from SELECT-based column validation."""
    from server.db import get_workspace_client

    try:
        return {
            str(table.name).lower()
            for table in get_workspace_client().tables.list(
                catalog_name=catalog,
                schema_name=schema,
            )
            if getattr(table, "name", None)
        }
    except Exception as exc:
        logger.info(
            "Could not list shared objects in %s.%s: %s",
            catalog,
            schema,
            exc,
        )
        return set()


def _shared_source_workspace_candidates(catalog: str, schema: str) -> list[dict[str, str]]:
    """List the bounded workspace scope published by a shared source."""
    from server.db import execute_query

    if not catalog or not schema:
        return []
    try:
        rows = execute_query(
            "SELECT DISTINCT CAST(workspace_id AS STRING) AS workspace_id, "
            "workspace_name "
            f"FROM `{catalog}`.`{schema}`.`daily_workspace_breakdown` "
            "WHERE workspace_id IS NOT NULL",
            None,
            no_cache=True,
        )
    except Exception as exc:
        logger.debug(
            "Could not infer workspace scope for shared source %s (non-fatal): %s",
            f"{catalog}.{schema}",
            exc,
        )
        return []

    return [
        {
            "workspace_id": str(row.get("workspace_id") or "").strip(),
            "workspace_name": str(row.get("workspace_name") or "").strip(),
        }
        for row in (rows or [])
        if str(row.get("workspace_id") or "").strip()
    ]


def _infer_shared_source_workspace_ids(source: dict[str, Any]) -> list[str]:
    """Use the workspace scope published by the shared aggregate itself."""
    catalog = str(source.get("catalog") or "").strip()
    schema = str(source.get("schema") or "").strip()
    if not catalog or not schema:
        return []
    candidates = _shared_source_workspace_candidates(catalog, schema)
    return list(dict.fromkeys(
        candidate["workspace_id"] for candidate in candidates
    ))


_MV_SCOPE_REPAIR_FAILURE_RETRY_SECONDS = 15
_MV_SCOPE_REPAIR_STATE_FILE = os.path.join(
    SETTINGS_DIR,
    "mv_scope_repair_state.json",
)


def _repair_missing_shared_source_workspace_scopes(
    sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Repair legacy unmapped shares during normal app loading.

    Older source registrations may predate workspace-scope persistence. The
    navigation source request runs before dashboard filters, so repairing here
    makes a redeploy sufficient; customers do not need to discover the hidden
    Settings detail/re-check path first.
    """
    if not any(not source.get("workspace_ids") for source in sources):
        return sources

    from server.db import get_catalog_schema, get_mv_sources, save_mv_sources
    from server.materialized_views import (
        _rebuild_unified_views_locked,
        unified_views_rebuild_lock,
    )

    # This file lock and completion-based timestamp are shared by every uvicorn
    # worker. Queued callers re-check the timestamp after taking the lock, so a
    # slow failure cannot trigger back-to-back warehouse rebuilds.
    with _settings_write_lock("mv_scope_repair"):
        try:
            with open(_MV_SCOPE_REPAIR_STATE_FILE) as state_file:
                next_attempt_at = float(
                    (json.load(state_file) or {}).get("next_attempt_at") or 0
                )
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            next_attempt_at = 0.0
        if time.time() < next_attempt_at:
            # Another worker may have completed the repair while this request
            # waited for the shared lock. Return the durable registry, not the
            # stale pre-lock snapshot used to decide that repair was needed.
            return get_mv_sources()

        retry_seconds = _MV_SCOPE_REPAIR_FAILURE_RETRY_SECONDS
        try:
            with unified_views_rebuild_lock():
                current_sources = get_mv_sources()
                repaired_sources = [dict(source) for source in current_sources]
                changed = False
                for source in repaired_sources:
                    if source.get("workspace_ids"):
                        continue
                    workspace_ids = _infer_shared_source_workspace_ids(source)
                    if workspace_ids:
                        source["workspace_ids"] = workspace_ids
                        changed = True
                if not changed:
                    return current_sources

                catalog, schema = get_catalog_schema()
                summary = _rebuild_unified_views_locked(
                    catalog,
                    schema,
                    sources_override=repaired_sources,
                    persist_registry=False,
                )
                if not summary.get("ok"):
                    logger.warning(
                        "Could not activate repaired shared-source workspace mappings: %s",
                        summary.get("error") or summary,
                    )
                    _rebuild_unified_views_locked(
                        catalog,
                        schema,
                        sources_override=current_sources,
                        persist_registry=False,
                    )
                    return current_sources

                try:
                    save_mv_sources(repaired_sources)
                except Exception:
                    _rebuild_unified_views_locked(
                        catalog,
                        schema,
                        sources_override=current_sources,
                        persist_registry=False,
                    )
                    raise
                _invalidate_mv_caches()
                logger.info("Repaired workspace mappings for legacy shared sources")
                return repaired_sources
        finally:
            try:
                _atomic_json_write(
                    _MV_SCOPE_REPAIR_STATE_FILE,
                    {"next_attempt_at": time.time() + retry_seconds},
                )
            except OSError as error:
                logger.warning("Could not persist shared-source repair backoff: %s", error)


def _shared_source_grants(catalog: str, schema: str) -> list[str]:
    principal = os.getenv("DATABRICKS_CLIENT_ID", "").strip()
    if not principal:
        return []
    escaped = {
        key: value.replace("`", "``")
        for key, value in {
            "catalog": catalog,
            "schema": schema,
            "principal": principal,
        }.items()
    }
    return [
        f"GRANT USE CATALOG ON CATALOG `{escaped['catalog']}` TO `{escaped['principal']}`;",
        f"GRANT USE SCHEMA ON SCHEMA `{escaped['catalog']}`.`{escaped['schema']}` TO `{escaped['principal']}`;",
        f"GRANT SELECT ON SCHEMA `{escaped['catalog']}`.`{escaped['schema']}` TO `{escaped['principal']}`;",
    ]


@router.get("/mv-sources")
async def get_mv_sources_endpoint(detail: bool = False) -> dict:
    """Additional MV source locations unioned into every MV read, plus this
    workspace's own label (used for its rows in the source_label column).

    `detail=1` (used by the settings modal, not the top-nav filter) adds each
    source's `share_last_updated` via a DESCRIBE DETAIL probe — kept off the default
    path so the frequently-polled nav filter stays fast."""
    from server.db import (
        get_catalog_schema,
        get_local_source_label,
        get_mv_sources,
        save_mv_sources,
    )
    sources = get_mv_sources()
    if not detail and any(not source.get("workspace_ids") for source in sources):
        try:
            sources = await asyncio.to_thread(
                _repair_missing_shared_source_workspace_scopes,
                sources,
            )
        except Exception as error:
            logger.warning(
                "Could not repair shared-source workspace mappings during app load: %s",
                error,
            )
    if detail:
        def _enrich():
            from server.materialized_views import (
                _MV_TABLES,
                _rebuild_unified_views_locked,
                _table_columns,
                unified_views_rebuild_lock,
            )

            # Back-fill the `cloud` tag for any source missing it — sources added
            # before cloud detection existed (or when it transiently missed at add
            # time) have no cloud, so the settings card renders no logo and the label
            # in default color. Detect now and PERSIST, so the fast nav path (which
            # never re-detects) gets it too. Detection is cheap and this path (the
            # settings modal) is infrequent.
            with unified_views_rebuild_lock():
                current_sources = get_mv_sources()
                changed = False
                workspace_scope_changed = False
                for s in current_sources:
                    current_cloud = str(s.get("cloud") or "").strip().lower()
                    if current_cloud not in {"aws", "azure", "gcp"}:
                        detected_cloud = _detect_source_cloud(s.get("catalog"))
                        if detected_cloud:
                            s["cloud"] = detected_cloud
                            changed = True
                    inferred_workspace_ids = _infer_shared_source_workspace_ids(s)
                    current_workspace_ids = [
                        str(value).strip()
                        for value in (s.get("workspace_ids") or [])
                        if str(value).strip()
                    ]
                    if (
                        inferred_workspace_ids
                        and set(inferred_workspace_ids) != set(current_workspace_ids)
                    ):
                        s["workspace_ids"] = inferred_workspace_ids
                        changed = True
                        workspace_scope_changed = True
                if changed:
                    try:
                        save_mv_sources(current_sources)
                        if workspace_scope_changed:
                            catalog, schema = get_catalog_schema()
                            _rebuild_unified_views_locked(
                                catalog,
                                schema,
                                sources_override=current_sources,
                                persist_registry=False,
                            )
                    except Exception as e:
                        logger.debug("Could not persist/rebuild back-filled source metadata (non-fatal): %s", e)
                for s in current_sources:
                    configured_tables = s.get("tables")
                    s["missing_tables"] = (
                        [
                            table_name
                            for table_name in _MV_TABLES
                            if table_name not in configured_tables
                        ]
                        if isinstance(configured_tables, list)
                        else []
                    )
                    s["shared_view_total"] = len(_MV_TABLES)
                    s["share_last_updated"] = _share_last_updated(
                        s.get("catalog"), s.get("schema"), s.get("tables")
                    )
                    s["catalog_explorer_tables"] = _catalog_explorer_table_links(
                        s.get("catalog"), s.get("schema"), s.get("tables")
                    )
                    s["catalog_explorer_schema_url"] = _catalog_explorer_schema_url(
                        s.get("catalog"), s.get("schema")
                    )
                    expected_tables = list(dict.fromkeys([
                        *(s.get("tables") or _MV_TABLES),
                        "daily_workspace_breakdown",
                    ]))
                    visible_tables = _visible_shared_tables(
                        s.get("catalog"), s.get("schema")
                    )
                    unreadable_tables = [
                        table_name
                        for table_name in expected_tables
                        if (
                            table_name.lower() in visible_tables
                            and _table_columns(
                                f"`{s.get('catalog')}`.`{s.get('schema')}`.`{table_name}`"
                            ) is None
                        )
                    ]
                    s["required_grants"] = (
                        _shared_source_grants(s.get("catalog"), s.get("schema"))
                        if unreadable_tables
                        else []
                    )
                return current_sources
        sources = await asyncio.to_thread(_enrich)
    return {
        "sources": sources,
        "local_label": get_local_source_label(),
        "local_cloud": _current_workspace_cloud(),
        "recipient_refresh": {
            "supported": False,
            "mode": "provider_managed",
            "check_action": "metadata_and_local_bindings_only",
        },
    }


@router.get("/mv-sources/preview")
async def preview_mv_source(catalog: str, schema: str) -> dict:
    """Probe a candidate source location: for each MV table, whether it exists
    there and matches the local structure (so the Browse UI can show readiness)."""
    from server.db import get_catalog_schema
    from server.materialized_views import _MV_TABLES, _table_columns

    cat, sch = get_catalog_schema()
    src_cat, src_sch = (catalog or "").strip(), (schema or "").strip()
    if not src_cat or not src_sch:
        raise HTTPException(status_code=400, detail="catalog and schema are required")

    def _probe() -> list[dict]:
        visible_tables = _visible_shared_tables(src_cat, src_sch)
        out = []
        for t in _MV_TABLES:
            local_cols = _table_columns(f"`{cat}`.`{sch}`.`{t}`")
            src_cols = _table_columns(f"`{src_cat}`.`{src_sch}`.`{t}`")
            if src_cols is None:
                status = "unreadable" if t.lower() in visible_tables else "absent"
            elif local_cols and src_cols == local_cols:
                status = "match"
            else:
                status = "mismatch"
            out.append({"table": t, "status": status})
        return out

    tables = await asyncio.to_thread(_probe)
    workspace_candidates = await asyncio.to_thread(
        _shared_source_workspace_candidates, src_cat, src_sch
    )
    matched = sum(1 for x in tables if x["status"] == "match")
    unreadable = sum(1 for x in tables if x["status"] == "unreadable")
    return {"catalog": src_cat, "schema": src_sch, "tables": tables,
            "matched": matched, "total": len(_MV_TABLES),
            "workspace_candidates": workspace_candidates,
            "required_grants": _shared_source_grants(src_cat, src_sch) if unreadable else []}


@router.post("/mv-sources/check")
async def check_mv_source_freshness(request: Request, label: str) -> dict:
    """Re-probe one read-only shared source and rebuild its local union views.

    Delta Sharing recipients cannot force the provider to publish new data. This
    action verifies what is currently visible, refreshes the local view bindings,
    and returns the provider table's latest metadata timestamp.
    """
    await _require_admin_async(request)
    from datetime import datetime, timezone

    from server.db import get_catalog_schema, get_mv_sources, save_mv_sources
    from server.materialized_views import (
        _MV_TABLES,
        _rebuild_unified_views_locked,
        _table_columns,
        unified_views_rebuild_lock,
    )

    def _check() -> dict:
        with unified_views_rebuild_lock():
            sources = get_mv_sources()
            source = next(
                (item for item in sources if item.get("label") == label),
                None,
            )
            if source is None:
                raise HTTPException(status_code=404, detail="Shared source not found")
            if not source.get("workspace_ids"):
                workspace_ids = _infer_shared_source_workspace_ids(source)
                if workspace_ids:
                    source["workspace_ids"] = workspace_ids
                    save_mv_sources(sources)
            if not source.get("workspace_ids"):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "The app cannot read the workspace mapping from this share yet. "
                        "Apply the grants shown in Settings, then re-check metadata."
                    ),
                )
            local_catalog, local_schema = get_catalog_schema()
            selected_tables = source.get("tables") or _MV_TABLES
            visible_tables = _visible_shared_tables(source["catalog"], source["schema"])
            statuses = []
            for table_name in _MV_TABLES:
                local_cols = _table_columns(f"`{local_catalog}`.`{local_schema}`.`{table_name}`")
                source_cols = _table_columns(f"`{source['catalog']}`.`{source['schema']}`.`{table_name}`")
                status = (
                    "unreadable"
                    if source_cols is None and table_name.lower() in visible_tables
                    else "absent"
                    if source_cols is None
                    else "match"
                    if local_cols and source_cols == local_cols
                    else "mismatch"
                )
                statuses.append({"table": table_name, "status": status})
            build = _rebuild_unified_views_locked(local_catalog, local_schema)
            return {
                "ok": bool(build.get("ok")),
                "label": label,
                "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "share_last_updated": _share_last_updated(
                    source.get("catalog"), source.get("schema"), selected_tables,
                ),
                "matched": sum(1 for item in statuses if item["status"] == "match"),
                "total": len(statuses),
                "tables": statuses,
                "missing_tables": [
                    item["table"] for item in statuses if item["status"] != "match"
                ],
                "workspace_ids": source.get("workspace_ids") or [],
                "build": build,
                "required_grants": (
                    _shared_source_grants(source["catalog"], source["schema"])
                    if any(item["status"] == "unreadable" for item in statuses)
                    else []
                ),
            }

    result = await asyncio.to_thread(_check)
    if not result.get("ok"):
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Shared source check failed; the existing routing configuration remains active.",
                "result": result,
            },
        )
    _invalidate_mv_caches()
    return result


@router.post("/mv-sources")
async def add_mv_source(request: Request, body: dict) -> dict:
    """Add (or replace by label) an additional MV source and rebuild the unified
    views. The source's tables must match the app's MV structure.

    The source list and dependent view rebuild are one admin-only ordered
    operation across every server worker."""
    await _require_admin_async(request)
    from server.db import get_catalog_schema, get_mv_sources, save_mv_sources
    from server.materialized_views import (
        _MV_TABLES,
        _rebuild_unified_views_locked,
        unified_views_rebuild_lock,
    )

    label = (body.get("label") or "").strip()
    catalog = (body.get("catalog") or "").strip()
    schema = (body.get("schema") or "").strip()
    if not (label and catalog and schema):
        raise HTTPException(status_code=400, detail="label, catalog and schema are required")
    cat, sch = get_catalog_schema()
    if catalog == cat and schema == sch:
        raise HTTPException(status_code=400, detail="Source cannot be the app's own catalog.schema.")

    # Optional per-source view selection (multiselect in the Browse UI). None means
    # "include every matching view" (backward-compatible with pre-picker sources).
    tables = body.get("tables")
    if tables is not None:
        tables = [t for t in tables if t in _MV_TABLES]
        if not tables:
            raise HTTPException(status_code=400, detail="Select at least one view to include.")

    def _add() -> tuple[list[dict], dict]:
        from datetime import datetime, timezone

        from server.db import save_unified_view_tables

        with unified_views_rebuild_lock():
            previous_sources = get_mv_sources()
            sources = [s for s in previous_sources if s.get("label") != label]
            entry = {
                "label": label,
                "catalog": catalog,
                "schema": schema,
                "added_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            if tables is not None:
                entry["tables"] = tables
            requested_workspace_ids = body.get("workspace_ids")
            if isinstance(requested_workspace_ids, list):
                workspace_ids = list(dict.fromkeys(
                    str(value).strip()
                    for value in requested_workspace_ids
                    if str(value).strip()
                ))
                entry["workspace_ids"] = workspace_ids
            if not entry.get("workspace_ids"):
                inferred_workspace_ids = _infer_shared_source_workspace_ids(entry)
                if inferred_workspace_ids:
                    entry["workspace_ids"] = inferred_workspace_ids
            if not entry.get("workspace_ids"):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Select at least one workspace before activating this shared source. "
                        "Unmapped sources are not queried because that could mix unrelated "
                        "workspace spend."
                    ),
                )
            cloud = _detect_source_cloud(catalog)
            if not cloud:
                prior = next(
                    (
                        item
                        for item in previous_sources
                        if (
                            item.get("catalog") == catalog
                            and item.get("schema") == schema
                        )
                        or item.get("label") == label
                    ),
                    None,
                )
                cloud = prior.get("cloud") if prior else None
            if cloud:
                entry["cloud"] = cloud
            sources.append(entry)
            summary = _rebuild_unified_views_locked(
                cat,
                sch,
                sources_override=sources,
                persist_registry=False,
            )
            if not summary.get("ok"):
                _rebuild_unified_views_locked(
                    cat, sch, sources_override=previous_sources
                )
                raise HTTPException(
                    status_code=503,
                    detail={
                        "message": "Shared source was not activated because unified-view validation failed.",
                        "build": summary,
                    },
                )
            try:
                save_mv_sources(sources)
                save_unified_view_tables(
                    summary.get("routed_tables") or [], strict=True
                )
            except Exception as exc:
                try:
                    save_mv_sources(previous_sources)
                except Exception as rollback_exc:
                    logger.error(
                        "Could not roll back shared-source configuration: %s",
                        rollback_exc,
                    )
                _rebuild_unified_views_locked(
                    cat, sch, sources_override=previous_sources
                )
                raise HTTPException(
                    status_code=503,
                    detail="Shared source was not activated because configuration persistence failed.",
                ) from exc
            return sources, summary

    sources, summary = await asyncio.to_thread(_add)
    _invalidate_mv_caches()
    # Record the source addition as a config/lineage step in the rebuild history.
    n_views = len(tables) if tables is not None else len(_MV_TABLES)
    await asyncio.to_thread(
        append_refresh_history, "config", "config",
        note=f"Added shared source '{label}' ({catalog}.{schema}, {n_views} view{'s' if n_views != 1 else ''})",
        operation="source_added",
    )
    return {"ok": True, "sources": sources, "build": summary}


@router.delete("/mv-sources")
async def remove_mv_source(request: Request, label: str = None) -> dict:
    """Remove an additional MV source by label and rebuild unified views."""
    await _require_admin_async(request)
    from server.db import get_catalog_schema, get_mv_sources, save_mv_sources
    from server.materialized_views import (
        _rebuild_unified_views_locked,
        unified_views_rebuild_lock,
    )

    if not label:
        raise HTTPException(status_code=400, detail="label query param is required")
    def _remove() -> tuple[list[dict], dict]:
        from server.db import save_unified_view_tables

        with unified_views_rebuild_lock():
            previous_sources = get_mv_sources()
            sources = [s for s in previous_sources if s.get("label") != label]
            cat, sch = get_catalog_schema()
            summary = _rebuild_unified_views_locked(
                cat,
                sch,
                sources_override=sources,
                persist_registry=False,
            )
            if not summary.get("ok"):
                _rebuild_unified_views_locked(
                    cat, sch, sources_override=previous_sources
                )
                raise HTTPException(
                    status_code=503,
                    detail={
                        "message": "Shared source was not removed because unified-view validation failed.",
                        "build": summary,
                    },
                )
            try:
                save_mv_sources(sources)
                save_unified_view_tables(
                    summary.get("routed_tables") or [], strict=True
                )
            except Exception as exc:
                try:
                    save_mv_sources(previous_sources)
                except Exception as rollback_exc:
                    logger.error(
                        "Could not roll back shared-source configuration: %s",
                        rollback_exc,
                    )
                _rebuild_unified_views_locked(
                    cat, sch, sources_override=previous_sources
                )
                raise HTTPException(
                    status_code=503,
                    detail="Shared source was not removed because configuration persistence failed.",
                ) from exc
            return sources, summary

    sources, summary = await asyncio.to_thread(_remove)
    _invalidate_mv_caches()
    await asyncio.to_thread(
        append_refresh_history, "config", "config",
        note=f"Removed shared source '{label}'",
        operation="source_removed",
    )
    return {"ok": True, "sources": sources, "build": summary}


@router.post("/catalog")
async def save_catalog_settings(request: Request, body: dict):
    """Save catalog/schema override from the Setup Wizard."""
    # Initial setup reaches this route before the durable permissions table can
    # exist. The verified provisional setup owner is the only allowed fallback.
    from server.auth import require_setup_admin
    await require_setup_admin(request)
    import asyncio as _asyncio

    from fastapi import HTTPException

    from server.db import StorageConfigurationError, save_catalog_schema
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
async def trigger_mv_refresh(
    request: Request,
    background_tasks: BackgroundTasks,
    lookback_days: int = 180,
    force_full: bool = True,
):
    """Kick off an MV rebuild in the background and return immediately.

    lookback_days: how many days of history to include (default 180 = 6 months).
    force_full: when True (default for UI-triggered rebuilds), bypass incremental MERGE
                and always run full CREATE OR REPLACE for every table.
    """
    await _require_admin_async(request)
    global _tables_cache, _tables_cache_ts
    from server.app import _run_mv_refresh
    def _run_manual_locked() -> dict:
        import fcntl
        lock_path = "/tmp/cost-obs-mv-refresh.lock"
        with open(lock_path, "w") as lock_file:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                reason = "Another rebuild is already running."
                append_refresh_history(
                    "skipped",
                    "manual",
                    lookback_days=lookback_days,
                    note=reason,
                    block_reason=reason,
                )
                return {"status": "skipped", "error": reason}
            try:
                return _run_mv_refresh(
                    lookback_days=lookback_days,
                    force_full=force_full,
                    trigger="manual",
                )
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)

    # Clear cache immediately so the next Status poll reflects fresh SQL results
    _tables_cache = None
    _tables_cache_ts = 0.0
    background_tasks.add_task(_run_manual_locked)
    return {"status": "queued", "lookback_days": lookback_days, "force_full": force_full}


@router.get("/auth-status")
async def get_auth_status_endpoint():
    """Return current auth mode for the settings UI indicator."""
    import asyncio as _asyncio
    import os as _os

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
        status["sp_object_id"] = str(getattr(me, "id", "") or "")
    except Exception:
        status["sp_user_name"] = ""
        status["sp_display_name"] = ""
        status["sp_client_id"] = _os.getenv("DATABRICKS_CLIENT_ID", "")
        status["sp_object_id"] = ""
    host = (_os.getenv("DATABRICKS_HOST") or "").rstrip("/")
    status["sp_identity_url"] = _safe_identity_url(
        host, status["sp_object_id"]
    )
    # Databricks Apps service-principal authentication uses OAuth M2M. Its
    # runtime token requests use the documented all-apis scope; this is app
    # execution scope, deliberately separate from forwarded user token scopes.
    status["effective_oauth_scopes"] = (
        ["all-apis"] if status["sp_client_id"] else []
    )
    status["oauth_scope_source"] = (
        "databricks_apps_oauth_m2m" if status["sp_client_id"] else "unavailable"
    )
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
async def set_auth_mode(request: Request, body: AuthModeRequest):
    """Auth mode endpoint — OAuth is currently disabled.

    Only 'sp' is accepted. 'auto' is rejected until OAuth is re-enabled.
    """
    await _require_admin_async(request)
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
    await _require_admin_async(request)
    if conn.provider not in ("azure", "aws", "gcp"):
        raise HTTPException(status_code=400, detail="Invalid provider. Must be azure, aws, or gcp.")
    if conn.provider == "gcp":
        raise HTTPException(
            status_code=422,
            detail=(
                "Google Cloud actual costs use a Unity Catalog BigQuery foreign "
                "catalog. Configure GCP_COST_CATALOG, GCP_COST_SCHEMA, and "
                "GCP_COST_TABLE on the Databricks App; service-account JSON is "
                "not stored by cost-obs."
            ),
        )

    connections = _load_connections()

    new_conn = {
        "id": str(uuid.uuid4())[:8],
        "name": conn.name,
        "provider": conn.provider,
        "created_at": datetime.now(timezone.utc).isoformat(),
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
async def create_azure_connection(request: Request, conn: CloudConnectionCreate):
    """Create an Azure connection (legacy endpoint)."""
    conn.provider = "azure"
    return await create_cloud_connection(request, conn)


@router.delete("/cloud-connections/{connection_id}")
async def delete_cloud_connection(request: Request, connection_id: str):
    """Delete a cloud connection."""
    await _require_admin_async(request)
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
async def delete_azure_connection(request: Request, connection_id: str):
    """Delete an Azure connection (legacy endpoint)."""
    return await delete_cloud_connection(request, connection_id)


# ── Webhook Settings ─────────────────────────────────────────────────────

class WebhookSettings(BaseModel):
    slack_webhook_url: str = ""


def _load_webhook_settings() -> dict:
    """Load webhook settings from app_settings, falling back to the local file."""
    durable = _load_settings_namespace("webhook")
    if durable is not None:
        return {"slack_webhook_url": durable.get("slack_webhook_url") or ""}

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
    _save_settings_namespace(
        "webhook",
        {"slack_webhook_url": settings.get("slack_webhook_url") or ""},
    )


def _save_webhook_settings(settings: dict) -> None:
    """Save webhook settings to Delta table (primary) and file (dev fallback)."""
    delta_error: Exception | None = None
    try:
        _save_webhook_to_table(settings)
    except Exception as e:
        delta_error = e
        logger.warning(f"Could not save webhook settings to Delta table: {e}")
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(WEBHOOK_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)
    if delta_error is not None:
        raise AppSettingsDurabilityError(
            "Webhook settings were not saved durably because Delta storage is unavailable. "
            "A local fallback was written."
        ) from delta_error


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
    await _require_admin_async(request)
    try:
        _save_webhook_settings({"slack_webhook_url": settings.slack_webhook_url})
    except AppSettingsDurabilityError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    logger.info("Webhook settings updated")
    return {"status": "saved"}


@router.post("/webhook/test")
async def test_webhook(request: Request) -> dict[str, Any]:
    """Send a test message to the configured Slack webhook."""
    await _require_admin_async(request)
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
async def send_webhook_alert(
    request: Request, alert_data: dict[str, Any]
) -> dict[str, Any]:
    """Send an alert notification to the configured Slack webhook."""
    await _require_admin_async(request)
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


@router.post("/alerts/run")
async def run_alerts(request: Request, send: bool = True) -> dict[str, Any]:
    """Evaluate the configured cost-alert thresholds against the latest spend and,
    when a Slack webhook is set and `send`, post any breaches. Admin-only. This is the
    manual trigger for the same check the nightly scheduler runs."""
    await _require_admin_async(request)
    from server.alerting import run_alert_check
    return await asyncio.to_thread(run_alert_check, send)


# ── User Permissions ──────────────────────────────────────────────────────────

class UserPermissionsModel(BaseModel):
    admins: list[str] = []
    consumers: list[str] = []


def _permissions_table() -> str:
    """Return the fully-qualified Delta table name for user permissions."""
    return _config_table("app_user_permissions")


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
    """Compatibility wrapper for centralized, stateful permission loading."""
    from server.auth import get_permission_snapshot_sync

    return get_permission_snapshot_sync().as_dict()


def _save_user_permissions_to_table(
    admins: list[str],
    consumers: list[str],
    *,
    owner: str | None = None,
) -> None:
    """Atomically replace permissions without exposing a zero-admin state."""
    from server.db import clear_query_cache, execute_write
    if not admins:
        raise ValueError("At least one administrator is required.")
    # Ensure the table exists before writing. If this raises, the SP lacks
    # CREATE TABLE permission — propagate so the caller gets a clear error.
    _ensure_permissions_table()
    table = _permissions_table()
    normalized_admins = list(dict.fromkeys(email.strip().lower() for email in admins))
    normalized_consumers = [
        email
        for email in dict.fromkeys(item.strip().lower() for item in consumers)
        if email not in normalized_admins
    ]
    normalized_owner = (owner or "").strip().lower()
    if normalized_owner not in normalized_admins:
        normalized_owner = normalized_admins[0]
    # Keep one durable singleton owner row. It is both the first administrator
    # and the compare-and-set marker that permanently disables fresh bootstrap.
    rows = [("owner", normalized_owner)]
    rows.extend(
        ("admin", email) for email in normalized_admins
        if email != normalized_owner
    )
    rows.extend(("consumer", email) for email in normalized_consumers)
    params: dict[str, str] = {}
    values: list[str] = []
    for index, (role, email) in enumerate(rows):
        values.append(f"(:role_{index}, :email_{index})")
        params[f"role_{index}"] = role
        params[f"email_{index}"] = email
    execute_write(
        f"INSERT OVERWRITE {table} "
        "SELECT source.role, source.email, current_timestamp() AS updated_at "
        f"FROM VALUES {', '.join(values)} AS source(role, email)",
        params,
    )
    # Invalidate cached permission reads so the change is visible immediately.
    from server.auth import reset_permission_cache

    reset_permission_cache()
    clear_query_cache("perms")
    logger.info(
        "Saved user permissions to Delta table (%d admins, %d consumers)",
        len(normalized_admins),
        len(normalized_consumers),
    )


async def _permission_owner(perms: dict[str, Any]) -> dict[str, Any]:
    """Resolve the UI persona owner without changing the authorization policy."""
    admins = [
        str(email).strip().lower()
        for email in perms.get("admins", [])
        if str(email).strip()
    ]
    durable_owner = str(perms.get("owner") or "").strip().lower()
    deployment: dict[str, Any] = {}
    try:
        from server.routers.health import deployment_metadata

        deployment = await deployment_metadata()
    except Exception as exc:
        logger.debug("Deployment creator unavailable for permission personas: %s", exc)
    deployment_creator = str(deployment.get("deployer") or "").strip().lower()

    if deployment_creator and deployment_creator in admins:
        return {
            "email": deployment_creator,
            "source": deployment.get("source") or "deployment_metadata",
            "verified": deployment.get("source") == "databricks_apps_api",
            "deployment_creator": deployment_creator,
        }
    if durable_owner and durable_owner in admins:
        return {
            "email": durable_owner,
            "source": "permission_store",
            "verified": False,
            "deployment_creator": deployment_creator or None,
        }
    return {
        "email": admins[0] if admins else None,
        "source": "first_configured_admin" if admins else "unavailable",
        "verified": False,
        "deployment_creator": deployment_creator or None,
    }


@router.get("/user-permissions")
async def get_user_permissions(request: Request) -> dict:
    """Return the admin and consumer user lists."""
    from server.auth import PermissionStoreUnavailable, request_identity

    try:
        perms = await asyncio.to_thread(_load_user_permissions)
    except PermissionStoreUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail="Permission state is temporarily unavailable",
        ) from exc
    try:
        from server.db import get_catalog_schema
        catalog, schema = get_catalog_schema()
        perms["table_location"] = f"{catalog}.{schema}.app_user_permissions"
    except Exception:
        perms["table_location"] = None
    # Tell the UI who the current user is and expose the same capability policy
    # used by /api/user/me. Protected mutation routes still enforce _require_admin.
    current_user = request_identity(request)
    current_role = (
        "admin"
        if current_user in perms.get("admins", [])
        else "consumer"
    )
    from server.routers.user import ROLE_CAPABILITIES

    perms["current_user"] = current_user
    perms["current_role"] = current_role
    perms["role_capabilities"] = {
        role: dict(capabilities)
        for role, capabilities in ROLE_CAPABILITIES.items()
    }
    perms["owner"] = await _permission_owner(perms)
    return perms


@router.post("/user-permissions")
async def save_user_permissions(request: Request, data: UserPermissionsModel) -> dict:
    """Save permissions to Delta table."""
    await _require_admin_async(request)
    normalized_admins = list(dict.fromkeys(
        email.strip() for email in data.admins if email.strip()
    ))
    normalized_consumers = list(dict.fromkeys(
        email.strip() for email in data.consumers
        if email.strip() and email.strip() not in normalized_admins
    ))
    if not normalized_admins:
        raise HTTPException(
            status_code=400,
            detail="At least one explicit admin must remain once permissions are configured.",
        )
    try:
        current_permissions = await asyncio.to_thread(_load_user_permissions)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Permission state is temporarily unavailable",
        ) from exc
    owner = await _permission_owner(current_permissions)
    owner_email = str(owner.get("email") or "").strip().lower()
    if owner_email and owner_email not in {
        email.lower() for email in normalized_admins
    }:
        raise HTTPException(
            status_code=400,
            detail="The Owner must remain an administrator.",
        )
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
        _save_user_permissions_to_table(
            normalized_admins,
            normalized_consumers,
            owner=owner_email or None,
        )
        logger.info(
            "Permissions saved to Delta table (%s admins, %s consumers)",
            len(normalized_admins),
            len(normalized_consumers),
        )
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Failed to save permissions: {e}")
        raise HTTPException(status_code=500, detail="Failed to save permissions — check server logs")


# ── Refresh Schedule ─────────────────────────────────────────────────────────

_SCHEDULE_DEFAULTS: dict = {"enabled": True, "frequency": "nightly", "hour_utc": 5, "lookback_days": 180}


def _save_schedule_to_table(settings: dict) -> None:
    _save_settings_namespace("schedule", settings)


def load_schedule_settings() -> dict:
    """Load schedule settings from app_settings, then the local fallback."""
    durable = _load_settings_namespace("schedule")
    if durable is not None:
        return {**_SCHEDULE_DEFAULTS, **durable}

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
    await _require_admin_async(request)
    with _settings_write_lock("schedule-settings"):
        current = load_schedule_settings()
        merged = {**current, **{
            key: data[key]
            for key in ("enabled", "frequency", "hour_utc", "lookback_days")
            if key in data
        }}
        settings = {
            "enabled": bool(merged.get("enabled", True)),
            "frequency": merged.get("frequency", "nightly"),
            "hour_utc": max(0, min(23, int(merged.get("hour_utc", 5)))),
            "lookback_days": int(merged.get("lookback_days", 180)),
        }
        if settings["frequency"] not in ("nightly", "weekly", "monthly"):
            settings["frequency"] = "nightly"
        if settings["lookback_days"] not in (180, 365, 730, 1095):
            settings["lookback_days"] = 180
        try:
            _save_schedule_to_table(settings)
        except Exception as e:
            logger.warning("Could not save schedule settings to Delta: %s", e)
            raise HTTPException(
                status_code=503,
                detail="Schedule settings were not saved durably because Delta storage is unavailable.",
            ) from e
        _atomic_json_write(SCHEDULE_SETTINGS_FILE, settings)
    logger.info("Schedule settings saved: %s", settings)
    return settings


# ── Alert Thresholds ──────────────────────────────────────────────────────────

_ALERT_THRESHOLD_DEFAULTS: dict = {
    "spike_threshold_percent": 20,
    "daily_budget": 50000,
    "workspace_budget": 10000,
}


def _load_alert_thresholds() -> dict:
    """Load alert thresholds from app_settings, then file/default fallbacks."""
    durable = _load_settings_namespace("alerts")
    if durable is not None:
        return {**_ALERT_THRESHOLD_DEFAULTS, **durable}

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


def _save_alert_thresholds_to_table(settings: dict) -> None:
    _save_settings_namespace("alerts", settings)


def _save_alert_thresholds(settings: dict) -> None:
    delta_error: Exception | None = None
    try:
        _save_alert_thresholds_to_table(settings)
    except Exception as e:
        delta_error = e
        logger.warning("Could not save alert thresholds to Delta: %s", e)
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(ALERT_THRESHOLDS_FILE, "w") as f:
        json.dump(settings, f, indent=2)
    if delta_error is not None:
        raise AppSettingsDurabilityError(
            "Alert thresholds were not saved durably because Delta storage is unavailable. "
            "A local fallback was written."
        ) from delta_error


@router.get("/alert-thresholds")
async def get_alert_thresholds() -> dict:
    return _load_alert_thresholds()


@router.post("/alert-thresholds")
async def save_alert_thresholds_endpoint(request: Request) -> dict:
    await _require_admin_async(request)
    data = await request.json()
    settings = {
        "spike_threshold_percent": max(5.0, min(100.0, float(data.get("spike_threshold_percent", 20)))),
        "daily_budget": max(0.0, float(data.get("daily_budget", 50000))),
        "workspace_budget": max(0.0, float(data.get("workspace_budget", 10000))),
    }
    try:
        _save_alert_thresholds(settings)
    except AppSettingsDurabilityError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
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
    _save_settings_namespace("pricing", settings)


def _load_pricing_settings() -> dict:
    """Load pricing settings from app_settings, then the local fallback."""
    durable = _load_settings_namespace("pricing")
    if durable is not None:
        return durable

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
    delta_error: Exception | None = None
    try:
        _save_pricing_to_table(settings)
    except Exception as e:
        delta_error = e
        logger.warning("Could not save pricing settings to Delta: %s", e)
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(PRICING_SETTINGS_FILE, "w") as f:
        json.dump(settings, f)
    if delta_error is not None:
        raise AppSettingsDurabilityError(
            "Pricing settings were not saved durably because Delta storage is unavailable. "
            "A local fallback was written."
        ) from delta_error


@router.get("/pricing-mode")
async def get_pricing_mode() -> dict[str, Any]:
    """Return the current pricing mode setting."""
    settings = _load_pricing_settings()
    return {
        "use_account_prices": settings.get("use_account_prices", False),
    }


@router.put("/pricing-mode")
async def set_pricing_mode(request: Request, data: dict) -> dict[str, Any]:
    """Save the pricing mode setting."""
    await _require_admin_async(request)
    use_account_prices = bool(data.get("use_account_prices", False))
    try:
        _save_pricing_settings({"use_account_prices": use_account_prices})
    except AppSettingsDurabilityError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
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


# ── Unified app settings (Phase 2 aggregator) ─────────────────────────────────
# One namespaced settings table. General preferences use id='app'; the alert,
# webhook, pricing, schedule, and workspace-filter domains use sibling rows.
# Permissions and multi-row operational data remain in dedicated tables.

_DEFAULT_TAB_VISIBILITY: dict = {
    "dbu": True, "infra": True, "optimizer": True, "kpis": True, "aiml": True,
    "sql": True, "apps": True, "tagging": True, "users-groups": True,
}

_APP_SETTINGS_DEFAULTS: dict = {
    "company_name": "",
    "app_display_name": "",
    "default_date_range_days": 30,
    "default_landing_tab": "dbu",
    "auto_refresh_minutes": 0,
    "density": "comfortable",
    "theme": "light",
    "show_workspace_names": True,
    "anomaly_sensitivity": "medium",
    "exp_setup_wizard_link": False,
    "exp_debugger_link": False,
    "enable_architecture_view": True,
    "enable_mv_share_runbook": True,
    "anonymize_users": False,
    "tab_visibility": _DEFAULT_TAB_VISIBILITY,
    "feedback_slack_url": None,
}

# Keys internal settings handlers may persist in app_settings.
_APP_SETTINGS_ALLOWED = set(_APP_SETTINGS_DEFAULTS.keys())

APP_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "app_settings.json")


class AppSettingsDurabilityError(RuntimeError):
    """The local fallback may be updated, but the durable Delta write failed."""


def _sanitize_app_settings(data: dict) -> dict:
    """Remove settings for features that are no longer part of the app."""
    clean = dict(data)
    clean.pop("enable_use_case_tracking", None)
    clean.pop("enable_accuracy_checks", None)
    clean["enable_architecture_view"] = (
        clean.get("enable_architecture_view")
        if isinstance(clean.get("enable_architecture_view"), bool)
        else True
    )
    clean["enable_mv_share_runbook"] = (
        clean.get("enable_mv_share_runbook")
        if isinstance(clean.get("enable_mv_share_runbook"), bool)
        else True
    )
    feedback_slack_url = clean.get("feedback_slack_url")
    clean["feedback_slack_url"] = (
        safe_feedback_slack_url(feedback_slack_url)
        if isinstance(feedback_slack_url, str)
        else None
    )
    if isinstance(clean.get("tab_visibility"), dict):
        clean["tab_visibility"] = dict(clean["tab_visibility"])
        clean["tab_visibility"].pop("use-cases", None)
    return clean


def get_app_settings() -> dict:
    """App-wide prefs — Delta first (survives redeploys), file fallback, then defaults."""
    durable = _load_settings_namespace("app")
    if durable is not None:
        return _sanitize_app_settings({**_APP_SETTINGS_DEFAULTS, **durable})
    try:
        if os.path.exists(APP_SETTINGS_FILE):
            with open(APP_SETTINGS_FILE) as f:
                data = json.load(f)
            return _sanitize_app_settings({**_APP_SETTINGS_DEFAULTS, **data})
    except (json.JSONDecodeError, IOError):
        pass
    return _sanitize_app_settings(_APP_SETTINGS_DEFAULTS)


def save_app_settings(partial: dict) -> dict:
    """Merge and persist app settings, failing if the durable Delta write does not land."""
    with _settings_write_lock("app-settings"):
        current = get_app_settings()
        clean = {k: v for k, v in (partial or {}).items() if k in _APP_SETTINGS_ALLOWED}
        if "feedback_slack_url" in clean and clean["feedback_slack_url"] is not None:
            if not isinstance(clean["feedback_slack_url"], str):
                raise ValueError("Slack feedback URL must be a string or null.")
            validated_slack_url = safe_feedback_slack_url(clean["feedback_slack_url"])
            if not validated_slack_url:
                raise ValueError(
                    "Slack feedback URL must be a complete Slack user deep link "
                    "or HTTPS member profile URL."
                )
            clean["feedback_slack_url"] = validated_slack_url
        if isinstance(clean.get("tab_visibility"), dict):
            current_visibility = current.get("tab_visibility")
            if not isinstance(current_visibility, dict):
                current_visibility = _DEFAULT_TAB_VISIBILITY
            merged_visibility = {
                **_DEFAULT_TAB_VISIBILITY,
                **{k: bool(v) for k, v in current_visibility.items() if k in _DEFAULT_TAB_VISIBILITY},
                **{k: bool(v) for k, v in clean["tab_visibility"].items() if k in _DEFAULT_TAB_VISIBILITY},
            }
            if not any(merged_visibility.values()):
                raise ValueError("At least one dashboard tab must remain visible.")
            clean["tab_visibility"] = merged_visibility
        merged = {**current, **clean}
        delta_error: Exception | None = None
        try:
            _write_settings_namespace("app", merged)
        except Exception as e:
            delta_error = e
            logger.warning("Could not persist app_settings to Delta: %s", e)
        local_saved = False
        try:
            _atomic_json_write(APP_SETTINGS_FILE, merged)
            local_saved = True
        except OSError as e:
            logger.warning("Could not persist app_settings local fallback: %s", e)
        if delta_error is not None:
            fallback = " A local fallback was written." if local_saved else ""
            raise AppSettingsDurabilityError(
                f"Settings were not saved durably because Delta storage is unavailable.{fallback}"
            ) from delta_error
        return merged


def workspace_names_enabled() -> bool:
    """Whether resolved workspace display names should be shown (else IDs). Default True."""
    try:
        return bool(get_app_settings().get("show_workspace_names", True))
    except Exception:
        return True


# Sensitivity → spike-threshold multiplier. High = more sensitive => lower threshold.
_ANOMALY_MULTIPLIER = {"low": 1.5, "medium": 1.0, "high": 0.5}


def anomaly_spike_threshold() -> float:
    """Effective day-over-day spike threshold (%) = base threshold × sensitivity multiplier."""
    base = float(_load_alert_thresholds().get("spike_threshold_percent", 20) or 20)
    sens = str(get_app_settings().get("anomaly_sensitivity", "medium")).lower()
    return round(base * _ANOMALY_MULTIPLIER.get(sens, 1.0), 2)


def _is_admin(request: Request) -> bool:
    """Non-raising, fail-closed admin capability check."""
    try:
        _require_admin(request)
        return True
    except HTTPException:
        return False


# Cheap capability probes cached in-process (avoid a SQL round-trip on every settings load).
_cap_cache: dict[str, tuple[float, bool]] = {}
_CAP_TTL = 10 * 60


def _cached_probe(key: str, sql: str) -> bool:
    hit = _cap_cache.get(key)
    if hit and (time.time() - hit[0]) < _CAP_TTL:
        return hit[1]
    ok = False
    try:
        from server.db import execute_query
        execute_query(sql, None, no_cache=True)
        ok = True
    except Exception:
        ok = False
    _cap_cache[key] = (time.time(), ok)
    return ok


def _capabilities(request: Request) -> dict:
    return {
        "smtp_configured": bool(os.getenv("SMTP_HOST")),
        "workspace_names_available": _cached_probe("ws_names", "SELECT 1 FROM system.access.workspaces_latest LIMIT 1"),
        "account_prices_available": _cached_probe("acct_prices", "SELECT 1 FROM system.billing.account_prices LIMIT 1"),
        "is_admin": _is_admin(request),
    }


def _webhook_masked() -> dict:
    settings = _load_webhook_settings()
    url = settings.get("slack_webhook_url", "")
    masked = ("https://hooks.slack.com/services/****" if "hooks.slack.com" in url else "****") if url else None
    return {"configured": bool(url), "masked_url": masked}


def _settings_snapshot(request: Request) -> dict:
    """Compose the full settings object from the per-domain stores + app_settings."""
    app = get_app_settings()
    thresholds = _load_alert_thresholds()
    general_keys = (
        "company_name", "app_display_name", "default_date_range_days", "default_landing_tab",
        "auto_refresh_minutes", "density", "theme", "show_workspace_names",
        "anonymize_users",
    )
    return {
        "general": {k: app.get(k) for k in general_keys},
        "tab_visibility": app.get("tab_visibility", _DEFAULT_TAB_VISIBILITY),
        "thresholds": {
            "spike_threshold_percent": thresholds.get("spike_threshold_percent", 20),
            "daily_budget": thresholds.get("daily_budget", 50000),
            "workspace_budget": thresholds.get("workspace_budget", 10000),
            "anomaly_sensitivity": app.get("anomaly_sensitivity", "medium"),
        },
        "webhook": _webhook_masked(),
        "feedback": {
            "slack_configured": bool(app.get("feedback_slack_url")),
        },
        "pricing": {"use_account_prices": bool(_load_pricing_settings().get("use_account_prices", False))},
        "schedule": load_schedule_settings(),
        "experimental": {
            "exp_setup_wizard_link": bool(app.get("exp_setup_wizard_link", False)),
            "exp_debugger_link": bool(app.get("exp_debugger_link", False)),
            "enable_architecture_view": bool(app.get("enable_architecture_view", True)),
            "enable_mv_share_runbook": bool(app.get("enable_mv_share_runbook", True)),
        },
        "capabilities": _capabilities(request),
    }


@router.get("")
async def get_unified_settings(request: Request) -> dict:
    """Aggregated settings for the settings modal (Phase 2). Read-only; safe for all users."""
    return await asyncio.to_thread(_settings_snapshot, request)


@router.put("")
async def put_unified_settings(request: Request) -> dict:
    """Partial settings update — dispatches each sub-object to its domain store. Admin-only."""
    await _require_admin_async(request)
    body = await request.json()

    feedback_has_slack_url = False
    feedback_slack_url: str | None = None
    if "feedback" in body:
        feedback = body["feedback"]
        if not isinstance(feedback, dict):
            raise HTTPException(status_code=422, detail="feedback must be an object.")
        if "slack_url" in feedback:
            feedback_has_slack_url = True
            raw_slack_url = feedback["slack_url"]
            if raw_slack_url is None:
                feedback_slack_url = None
            elif isinstance(raw_slack_url, str):
                feedback_slack_url = safe_feedback_slack_url(raw_slack_url)
                if not feedback_slack_url:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            "feedback.slack_url must be a complete Slack user deep link "
                            "or HTTPS member profile URL."
                        ),
                    )
            else:
                raise HTTPException(
                    status_code=422,
                    detail="feedback.slack_url must be a string or null.",
                )

    def _apply() -> dict:
        # app_settings-backed groups (general prefs, tab visibility, experimental, sensitivity)
        app_partial: dict = {}
        updated_count = 0
        app_updated_count = 0
        domain_results: dict[str, dict[str, Any]] = {}

        def _run_domain(name: str, operation) -> bool:
            try:
                operation()
                domain_results[name] = {"ok": True}
                return True
            except Exception as exc:
                domain_results[name] = {"ok": False, "error": str(exc)}
                return False
        general = body.get("general")
        if isinstance(general, dict):
            for k in (
                "company_name", "app_display_name", "default_date_range_days", "default_landing_tab",
                "auto_refresh_minutes", "density", "theme", "show_workspace_names",
                "anonymize_users",
            ):
                if k in general:
                    app_partial[k] = general[k]
                    app_updated_count += 1
        exp = body.get("experimental")
        if isinstance(exp, dict):
            for k in (
                "exp_setup_wizard_link",
                "exp_debugger_link",
                "enable_architecture_view",
                "enable_mv_share_runbook",
            ):
                if k in exp:
                    app_partial[k] = bool(exp[k])
                    app_updated_count += 1
        tv = body.get("tab_visibility")
        if isinstance(tv, dict):
            changed_tv = {k: bool(v) for k, v in tv.items() if k in _DEFAULT_TAB_VISIBILITY}
            if changed_tv:
                app_partial["tab_visibility"] = changed_tv
                app_updated_count += len(changed_tv)
        if feedback_has_slack_url:
            app_partial["feedback_slack_url"] = feedback_slack_url
            app_updated_count += 1

        thresholds = body.get("thresholds")
        if isinstance(thresholds, dict):
            if "anomaly_sensitivity" in thresholds:
                s = str(thresholds["anomaly_sensitivity"]).lower()
                app_partial["anomaly_sensitivity"] = s if s in _ANOMALY_MULTIPLIER else "medium"
                app_updated_count += 1
            threshold_keys = {
                k for k in ("spike_threshold_percent", "daily_budget", "workspace_budget")
                if k in thresholds
            }
            if threshold_keys:
                cur = _load_alert_thresholds()
                threshold_payload = {
                    "spike_threshold_percent": max(1.0, min(500.0, float(thresholds.get("spike_threshold_percent", cur.get("spike_threshold_percent", 20))))),
                    "daily_budget": max(0.0, float(thresholds.get("daily_budget", cur.get("daily_budget", 50000)))),
                    "workspace_budget": max(0.0, float(thresholds.get("workspace_budget", cur.get("workspace_budget", 10000)))),
                }
                if _run_domain(
                    "thresholds",
                    lambda: _save_alert_thresholds(threshold_payload),
                ):
                    updated_count += len(threshold_keys)

        if app_partial:
            def _save_app_domain() -> None:
                save_app_settings(app_partial)
                if feedback_has_slack_url:
                    from server.routers.user import invalidate_feedback_settings_cache

                    invalidate_feedback_settings_cache()

            if _run_domain("app", _save_app_domain):
                updated_count += app_updated_count

        webhook = body.get("webhook")
        if isinstance(webhook, dict) and "slack_webhook_url" in webhook:
            if _run_domain(
                "webhook",
                lambda: _save_webhook_settings(
                    {"slack_webhook_url": webhook["slack_webhook_url"]}
                ),
            ):
                updated_count += 1

        pricing = body.get("pricing")
        if isinstance(pricing, dict) and "use_account_prices" in pricing:
            if _run_domain(
                "pricing",
                lambda: _save_pricing_settings(
                    {"use_account_prices": bool(pricing["use_account_prices"])}
                ),
            ):
                updated_count += 1

        schedule = body.get("schedule")
        if isinstance(schedule, dict):
            def _save_schedule_domain() -> None:
                with _settings_write_lock("schedule-settings"):
                    # Read and merge after taking the cross-process lock. Otherwise
                    # two partial unified-settings requests can both read the same
                    # old row and the later overwrite discards the earlier update.
                    current_schedule = load_schedule_settings()
                    merged_schedule = {
                        **current_schedule,
                        **{
                            key: schedule[key]
                            for key in ("enabled", "frequency", "hour_utc", "lookback_days")
                            if key in schedule
                        },
                    }
                    lookback_days = int(merged_schedule.get("lookback_days", 180))
                    sched = {
                        "enabled": bool(merged_schedule.get("enabled", True)),
                        "frequency": merged_schedule.get("frequency", "nightly")
                        if merged_schedule.get("frequency") in ("nightly", "weekly", "monthly")
                        else "nightly",
                        "hour_utc": max(0, min(23, int(merged_schedule.get("hour_utc", 5)))),
                        "lookback_days": lookback_days
                        if lookback_days in (180, 365, 730, 1095)
                        else 180,
                    }
                    _save_schedule_to_table(sched)
                    _atomic_json_write(SCHEDULE_SETTINGS_FILE, sched)

            if _run_domain("schedule", _save_schedule_domain):
                updated_count += len({
                    k for k in ("enabled", "frequency", "hour_utc", "lookback_days")
                    if k in schedule
                })

        response = {
            "status": "saved",
            "updated_count": updated_count,
            "domains": domain_results,
        }
        failures = [
            name for name, result in domain_results.items() if not result["ok"]
        ]
        if failures:
            response["status"] = "partial_failure"
            raise HTTPException(
                status_code=503,
                detail=response,
            )
        return response

    try:
        return await asyncio.to_thread(_apply)
    except AppSettingsDurabilityError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
