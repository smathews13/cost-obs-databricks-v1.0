"""Setup API endpoints for initializing materialized views."""

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request

from server.materialized_views import (
    _MV_TABLES,
    check_materialized_views_exist,
    create_materialized_views,
    drop_materialized_views,
    get_catalog_schema,
    refresh_materialized_views,
)
from server.db import get_workspace_client, _user_token as _db_user_token

router = APIRouter()
logger = logging.getLogger(__name__)

SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
GENIE_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "genie_settings.json")

# Written when the setup wizard completes. This file lives in .settings/ which is
# wiped on every Databricks Apps git redeploy — ensuring the wizard always runs on
# a fresh deployment, even if tables already exist from a previous run.
SETUP_DONE_FILE = os.path.join(SETTINGS_DIR, "setup_done.json")

# Simple in-process state for the background create-tables task
_create_task_state: dict = {"status": "idle", "error": None, "started_at": None, "elapsed_seconds": None}  # idle | running | done | error

# Core billing tables — must exist for the dashboard to be functional.
# Used by get_setup_status to gate the "ready" state.
_CORE_REQUIRED_TABLES = frozenset({
    "daily_usage_summary",
    "daily_product_breakdown",
    "daily_workspace_breakdown",
})

# Auto-fail bootstrap after this many seconds to prevent infinite spinner
_BOOTSTRAP_TIMEOUT_SECONDS = 25 * 60  # 25 minutes


SYSTEM_TABLE_GRANTS = [
    ("USE CATALOG", "CATALOG", "system"),
    ("USE SCHEMA",  "SCHEMA",  "system.billing"),
    ("SELECT",      "TABLE",   "system.billing.usage"),
    ("SELECT",      "TABLE",   "system.billing.list_prices"),
    ("SELECT",      "TABLE",   "system.billing.account_prices"),
    ("USE SCHEMA",  "SCHEMA",  "system.query"),
    ("SELECT",      "TABLE",   "system.query.history"),
    ("USE SCHEMA",  "SCHEMA",  "system.compute"),
    ("SELECT",      "TABLE",   "system.compute.clusters"),
    ("USE SCHEMA",  "SCHEMA",  "system.lakeflow"),
    ("SELECT",      "TABLE",   "system.lakeflow.pipelines"),
    ("USE SCHEMA",  "SCHEMA",  "system.serving"),
    ("SELECT",      "TABLE",   "system.serving.served_entities"),
]


def _grant_sp_schema_access(catalog: str, schema: str) -> dict:
    """Grant the app SP required permissions via SQL GRANT statements.

    Uses the SQL warehouse (JDBC) instead of the UC REST API to avoid the
    'unity-catalog' OAuth scope requirement — forwarded user tokens and SP
    m2m tokens do not carry that scope in Databricks Apps.

    Runs as the calling user (set via _user_token ContextVar by the caller).
    Returns {"ok": bool, "sp_client_id": str, "applied": int, "failed": int, "errors": list}
    """
    from server.db import _user_token

    sp_client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
    if not sp_client_id:
        logger.warning("DATABRICKS_CLIENT_ID not set — skipping SP grants")
        return {"ok": False, "sp_client_id": "", "applied": 0, "failed": 0,
                "errors": ["DATABRICKS_CLIENT_ID not set — app has no service principal to grant"]}

    p = sp_client_id  # principal name in GRANT statements

    # Build (sql, label) pairs for every privilege we need to apply.
    grant_stmts: list[tuple[str, str]] = [
        (f"GRANT USE CATALOG ON CATALOG `system` TO `{p}`", "CATALOG/system"),
    ]
    for _, obj_type, obj_name in SYSTEM_TABLE_GRANTS:
        parts = obj_name.split(".")
        q = ".".join(f"`{part}`" for part in parts)
        if obj_type == "SCHEMA":
            grant_stmts.append((f"GRANT USE SCHEMA ON SCHEMA {q} TO `{p}`", f"SCHEMA/{obj_name}"))
        elif obj_type == "TABLE":
            grant_stmts.append((f"GRANT SELECT ON TABLE {q} TO `{p}`", f"TABLE/{obj_name}"))

    grant_stmts += [
        (f"GRANT USE CATALOG ON CATALOG `{catalog}` TO `{p}`",                           f"CATALOG/{catalog}"),
        (f"GRANT CREATE SCHEMA ON CATALOG `{catalog}` TO `{p}`",                         f"CREATE_SCHEMA/{catalog}"),
        (f"GRANT USE SCHEMA ON SCHEMA `{catalog}`.`{schema}` TO `{p}`",                  f"SCHEMA/{catalog}.{schema}"),
        (f"GRANT CREATE TABLE ON SCHEMA `{catalog}`.`{schema}` TO `{p}`",                f"CREATE_TABLE/{catalog}.{schema}"),
        (f"GRANT SELECT ON SCHEMA `{catalog}`.`{schema}` TO `{p}`",                      f"SELECT/{catalog}.{schema}"),
    ]

    ok = failed = 0
    errors: list[str] = []

    # Use execute_query (not get_connection directly) so that scope errors on
    # the forwarded user token automatically fall back to the SP — which has
    # the sql OAuth scope and, in most deployments, sufficient privileges to
    # run GRANT statements.
    from server.db import execute_query as _exec
    for sql_stmt, label in grant_stmts:
        try:
            _exec(sql_stmt, no_cache=True)
            ok += 1
            logger.info(f"SQL GRANT ok: {label} → {p}")
        except Exception as e:
            err_lower = str(e).lower()
            if any(kw in err_lower for kw in ("not found", "does not exist", "already")):
                ok += 1
                logger.debug(f"GRANT skipped (already applied / object missing): {label}: {e}")
            else:
                msg = _clean_sdk_error(str(e))
                logger.warning(f"SQL GRANT failed: {label}: {msg}")
                errors.append(f"{label}: {msg}")
                failed += 1

    logger.info(f"SP SQL grants: {ok} ok, {failed} failed for {p}")

    # Warehouse CAN_USE via REST API — uses /api/2.0/permissions/ (not UC API,
    # no unity-catalog scope required).
    try:
        user_tok = _user_token.get()
        host = os.getenv("DATABRICKS_HOST", "")
        if user_tok and host:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient(host=host, token=user_tok, auth_type="pat")
        else:
            w = get_workspace_client()
        _grant_warehouse_can_use(w, sp_client_id)
    except Exception as e:
        logger.warning(f"Warehouse CAN_USE grant failed (non-fatal): {e}")

    return {
        "ok": failed == 0,
        "sp_client_id": sp_client_id,
        "applied": ok,
        "failed": failed,
        "errors": errors,
    }


def _grant_warehouse_can_use(w, sp_client_id: str) -> None:
    """Grant CAN_USE on the configured SQL warehouse to the app SP via REST API.

    Called from _grant_sp_schema_access on every /api/setup/status load when
    a user OAuth token is present. Idempotent — re-running after a redeploy
    that creates a new SP re-grants without any manual intervention.
    """
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    if not http_path:
        logger.warning("DATABRICKS_HTTP_PATH not set — skipping warehouse CAN_USE grant")
        return

    # Extract warehouse ID from path like /sql/1.0/warehouses/{id}
    parts = http_path.strip("/").split("/")
    warehouse_id = parts[-1] if parts and parts[-1] != "warehouses" else ""
    if not warehouse_id:
        logger.warning(f"Cannot parse warehouse ID from http_path: {http_path}")
        return

    try:
        w.api_client.do(
            "PATCH",
            f"/api/2.0/permissions/warehouses/{warehouse_id}",
            body={
                "access_control_list": [{
                    "service_principal_name": sp_client_id,
                    "permission_level": "CAN_USE",
                }]
            },
        )
        logger.info(f"Granted CAN_USE on warehouse {warehouse_id} to SP {sp_client_id}")
    except Exception as e:
        logger.warning(f"Failed to grant warehouse CAN_USE on {warehouse_id}: {e}")


@router.get("/status")
async def get_setup_status() -> dict[str, Any]:
    """Check setup status for the wizard gate.

    setup_done.json lives in .settings/ which is wiped on every Databricks Apps
    git redeploy. If the file is absent the wizard always shows, regardless of
    whether tables already exist from a previous deployment.

    The only exception: if a table-creation task is actively running (the wizard
    is on the create-tables step and polling), return 'initializing' so it keeps
    polling instead of resetting back to the wizard start.
    """
    import asyncio as _asyncio

    # While table creation is running (wizard polling mid-flow), keep returning
    # initializing regardless of setup_done state so the wizard doesn't reset.
    if _create_task_state["status"] == "running":
        import time as _time
        catalog, schema = get_catalog_schema()
        started = _create_task_state.get("started_at") or _time.monotonic()
        elapsed = int(_time.monotonic() - started)
        _create_task_state["elapsed_seconds"] = elapsed
        if elapsed > _BOOTSTRAP_TIMEOUT_SECONDS:
            _create_task_state["status"] = "error"
            _create_task_state["error"] = (
                f"Table creation timed out after {elapsed // 60} minutes. "
                "The warehouse may be cold or the billing dataset is very large. "
                "Use the Setup wizard to retry, or check app logs for details."
            )
            logger.error(f"Bootstrap timed out after {elapsed}s — marking as error")
        else:
            return {
                "catalog": catalog,
                "schema": schema,
                "tables": {},
                "all_tables_exist": False,
                "missing_tables": [],
                "status": "initializing",
                "task": _create_task_state.copy(),
            }

    catalog, schema = get_catalog_schema()

    # No catalog configured — wizard must run first.
    if not catalog or not schema:
        return {
            "catalog": catalog,
            "schema": schema,
            "tables": {},
            "all_tables_exist": False,
            "missing_tables": [],
            "status": "setup_required",
            "task": _create_task_state.copy(),
        }

    loop = _asyncio.get_running_loop()
    tables = await loop.run_in_executor(None, check_materialized_views_exist, catalog, schema)

    # setup_done.json absent (wiped on every git redeploy).
    # Auto-heal: if core tables already exist, recreate the file so the dashboard
    # loads immediately instead of forcing the wizard again.
    if not os.path.exists(SETUP_DONE_FILE):
        core_ok = all(tables.get(t, False) for t in _CORE_REQUIRED_TABLES)
        if core_ok:
            try:
                import datetime as _dt, json as _json
                os.makedirs(SETTINGS_DIR, exist_ok=True)
                with open(SETUP_DONE_FILE, "w") as f:
                    _json.dump({"completed_at": _dt.datetime.utcnow().isoformat(), "auto_healed": True}, f)
                logger.info("setup_done.json auto-healed on redeploy — tables already exist")
            except Exception as e:
                logger.warning(f"Could not auto-heal setup_done.json: {e}")
        else:
            missing_t = [name for name, exists in tables.items() if not exists]
            return {
                "catalog": catalog,
                "schema": schema,
                "tables": tables,
                "all_tables_exist": False,
                "missing_tables": missing_t,
                "status": "setup_required",
                "task": _create_task_state.copy(),
            }

    # Core billing tables gate the "ready" state — without them the dashboard has nothing to show.
    core_exist = all(tables.get(t, False) for t in _CORE_REQUIRED_TABLES)
    all_exist = all(tables.values())
    missing = [name for name, exists in tables.items() if not exists]

    if not core_exist:
        return {
            "catalog": catalog,
            "schema": schema,
            "tables": tables,
            "all_tables_exist": False,
            "missing_tables": missing,
            "status": "setup_required",
            "task": _create_task_state.copy(),
        }

    # Tables exist — but if a user OAuth token is present, re-run SP grants in the
    # background. Each git deploy creates a new SP with no grants; auto-bootstrap only
    # fires when tables are missing. Re-granting here is idempotent and non-fatal.
    if all_exist:
        user_token = _db_user_token.get()
        if user_token:
            import threading as _threading
            _token_snap = user_token
            _catalog_snap = catalog
            _schema_snap = schema
            def _bg_grant():
                tok = _db_user_token.set(_token_snap)
                try:
                    _grant_sp_schema_access(_catalog_snap, _schema_snap)
                finally:
                    _db_user_token.reset(tok)
            _threading.Thread(target=_bg_grant, daemon=True).start()

    return {
        "catalog": catalog,
        "schema": schema,
        "tables": tables,
        "all_tables_exist": all_exist,
        "missing_tables": missing,
        "status": "ready" if all_exist else "setup_required",
        "task": _create_task_state.copy(),
    }


@router.post("/complete")
async def mark_setup_complete() -> dict[str, Any]:
    """Write setup_done.json to mark wizard completion for this deployment.

    Called by the frontend when the user clicks 'Complete' in the setup wizard.
    Without this file, every fresh git redeploy will show the wizard.
    """
    try:
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        with open(SETUP_DONE_FILE, "w") as f:
            import time as _time
            json.dump({"completed_at": _time.time()}, f)
        logger.info("Setup wizard marked complete — setup_done.json written")
        return {"ok": True}
    except Exception as e:
        logger.error(f"Failed to write setup_done.json: {e}")
        return {"ok": False, "error": str(e)}


@router.post("/reset-bootstrap")
async def reset_bootstrap_state() -> dict[str, Any]:
    """Reset the in-process bootstrap state so auto-init can retry.

    Call this if the app is stuck on the 'Setting up your workspace' spinner.
    Resets the internal task state to 'idle' so the next /status poll will
    attempt auto-bootstrap again (or fall through to setup_required if no
    user token is available).
    """
    prev = _create_task_state.copy()
    _create_task_state["status"] = "idle"
    _create_task_state["error"] = None
    logger.info(f"Bootstrap state manually reset (was: {prev})")
    return {"ok": True, "previous": prev, "current": _create_task_state.copy()}


@router.get("/bootstrap-state")
async def get_bootstrap_state() -> dict[str, Any]:
    """Return current in-process bootstrap task state for debugging."""
    return _create_task_state.copy()


@router.post("/grant-sp-system-access")
async def grant_sp_system_access(request: Request) -> dict[str, Any]:
    """Re-run all SP grants using the current user's OAuth token.

    Call this after a git deploy when the new SP is missing system table or
    app schema grants. Requires the calling user to be a metastore admin or
    account admin so the GRANT statements succeed on system tables.
    Returns a summary of how many grants were applied.
    """
    from server.materialized_views import get_catalog_schema

    # Set the user token explicitly so _grant_sp_schema_access bypasses auth_mode lock
    user_token = request.headers.get("x-forwarded-access-token", "")
    ctx_tok = _db_user_token.set(user_token)
    try:
        catalog, schema = get_catalog_schema()
        result = _grant_sp_schema_access(catalog, schema)
    finally:
        _db_user_token.reset(ctx_tok)

    result["catalog"] = catalog
    result["schema"] = schema
    result["status"] = "ok" if result["ok"] else "partial"
    return result


def _clean_sdk_error(msg: str) -> str:
    """Strip Databricks SDK config debug blob from exception messages.

    SDK exceptions append '. Config: host=..., client_id=...' to every error.
    That leaks credentials and is not useful to display in the UI.
    """
    for marker in (". Config:", " Config: ", "\nConfig:"):
        idx = msg.find(marker)
        if idx > 0:
            return msg[:idx]
    return msg


def _execute_as_sp(sql: str) -> list[dict]:
    """Execute a query as the SP — explicitly clears the user token from context."""
    from server.db import execute_query, _user_token
    tok = _user_token.set("")
    try:
        return execute_query(sql, no_cache=True) or []
    finally:
        _user_token.reset(tok)


def _preflight_catalog_check(catalog: str) -> dict:
    """Verify the target catalog exists using the UC SDK (no warehouse needed).

    Returns {"ok": bool, "status": str, "message": str}.
    Statuses: invalid_config | catalog_missing | catalog_check_failed | ready
    """
    if not catalog:
        return {
            "ok": False,
            "status": "invalid_config",
            "message": "No catalog configured — return to the Storage step.",
        }
    try:
        w = get_workspace_client()
        w.catalogs.get(catalog)
        return {"ok": True, "status": "ready", "message": f"Catalog `{catalog}` is accessible."}
    except Exception as e:
        msg = _clean_sdk_error(str(e))
        if any(kw in msg.lower() for kw in ("not found", "does not exist", "404", "catalog_not_found")):
            return {
                "ok": False,
                "status": "catalog_missing",
                "message": (
                    f"Catalog `{catalog}` does not exist. "
                    "Create it in Unity Catalog before continuing."
                ),
            }
        return {
            "ok": False,
            "status": "catalog_check_failed",
            "message": f"Could not verify catalog `{catalog}`: {msg}",
        }


def _verify_built_objects_as_sp(catalog: str, schema: str) -> dict:
    """Probe every MV table with SELECT 1 as the SP to confirm UC grants propagated.

    Returns {"ok": bool, "failed": list[str], "errors": dict[str, str]}
    """
    failed: list[str] = []
    errors: dict[str, str] = {}
    for table in _MV_TABLES:
        try:
            _execute_as_sp(f"SELECT 1 FROM `{catalog}`.`{schema}`.`{table}` LIMIT 1")
        except Exception as e:
            failed.append(table)
            errors[table] = _clean_sdk_error(str(e))
    return {"ok": len(failed) == 0, "failed": failed, "errors": errors}


@router.post("/create-tables")
async def create_tables(
    request: Request,
    background_tasks: BackgroundTasks,
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Create all materialized view tables.

    This will create pre-aggregated tables from system tables for fast queries.
    Tables are created with 180 days (6 months) of historical data.

    WARNING: This operation can take several minutes on large accounts.
    Set run_in_background=true (default) to run asynchronously.
    """
    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if run_in_background:
        import time as _time
        _create_task_state["status"] = "running"
        _create_task_state["error"] = None
        _create_task_state["started_at"] = _time.monotonic()
        _create_task_state["elapsed_seconds"] = 0
        # Read the raw header token directly — _auth_mode may have been locked to "sp"
        # (e.g. after a scope error on a previous request), which forces _db_user_token
        # to "" even when x-forwarded-access-token IS present in the request.
        # Setup operations must always run as the user, not the SP.
        _token_snap = (
            request.headers.get("x-forwarded-access-token", "")
            or _db_user_token.get()
        )
        background_tasks.add_task(
            _create_tables_task, target_catalog, target_schema, _token_snap
        )
        return {
            "status": "started",
            "message": "Table creation started in background. Check /api/setup/status for progress.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        # Run synchronously (blocking)
        results = create_materialized_views(target_catalog, target_schema)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _create_tables_task(catalog: str, schema: str, user_token: str = ""):
    """Background task: grants → build → verify.

    The catalog-existence check is done by the frontend endpoint (user token)
    before this task starts. This task does NOT re-check via the SP because the
    SP has no USE CATALOG until the pre-creation grants run.

    Pre-grants: Apply USE CATALOG + CREATE SCHEMA to the SP first. The
      permissions step may have silently no-op'd these when the catalog didn't
      exist at grant time; re-applying now that it exists is the authoritative fix.
    3s sleep: brief propagation wait between grants and warehouse ops.
    Phase 2 — Build: create_materialized_views runs as SP.
    Post-grants: Apply schema-level privileges now that the schema exists.
    Phase 3 — Verify: SELECT 1 probe on every MV table as SP with retry backoff.
      UC grant propagation can take 10-60s; [0,10,20,30]s delays = 60s budget.
    Only marks "done" after Phase 3 passes.
    """
    import time as _time

    logger.info(f"Starting background table creation for {catalog}.{schema}")

    if not catalog or not schema:
        _create_task_state["status"] = "error"
        _create_task_state["error"] = "Catalog and schema must be configured before creating tables."
        return

    try:
        # Pre-creation grants — must run before create_materialized_views.
        # The SP needs USE CATALOG + CREATE SCHEMA before it can create the schema.
        if user_token:
            pre_tok = _db_user_token.set(user_token)
            try:
                pre_grant = _grant_sp_schema_access(catalog, schema)
                logger.info(
                    f"Pre-creation grants: ok={pre_grant['ok']} "
                    f"applied={pre_grant['applied']} failed={pre_grant['failed']}"
                )
                # Only hard-fail if zero grants landed — partial system-table
                # failures are non-fatal for table creation in the app catalog.
                if pre_grant.get("applied", 0) == 0 and pre_grant.get("failed", 0) > 0:
                    _create_task_state["status"] = "error"
                    _create_task_state["error"] = (
                        f"Could not grant SP catalog access to `{catalog}`: "
                        + "; ".join(pre_grant.get("errors", []))
                    )
                    return
            finally:
                _db_user_token.reset(pre_tok)
            # Brief propagation pause before the SP hits the warehouse.
            _time.sleep(3)
        else:
            logger.warning(
                "No user token for pre-creation grants — SP may lack USE CATALOG. "
                "Proceeding; if table creation fails with a permission error, "
                "re-run the wizard with an authenticated browser session."
            )

        # Phase 2: Build — no user token in context; all queries run as SP.
        results = create_materialized_views(catalog, schema)
        logger.info(f"Table creation completed: {results}")

        all_errors = {
            k: v for k, v in results.items()
            if k != "__mv_timings__" and isinstance(v, str) and v.startswith("error:")
        }
        if all_errors:
            first_error = next(iter(all_errors.values()))
            _create_task_state["status"] = "error"
            _create_task_state["error"] = first_error.replace("error: ", "", 1)
            return

        # Post-creation grants — schema now exists so schema-level privileges
        # (USE SCHEMA, CREATE TABLE, SELECT) actually land in UC.
        if user_token:
            post_tok = _db_user_token.set(user_token)
            try:
                _grant_sp_schema_access(catalog, schema)
            finally:
                _db_user_token.reset(post_tok)

        # Phase 3: Verify with retry backoff for grant propagation.
        retry_delays = [0, 10, 20, 30]
        last_verify: dict = {}
        for delay in retry_delays:
            if delay > 0:
                _time.sleep(delay)
            last_verify = _verify_built_objects_as_sp(catalog, schema)
            logger.info(
                f"SP verification (delay +{delay}s): ok={last_verify['ok']} "
                f"failed={last_verify.get('failed', [])}"
            )
            if last_verify["ok"]:
                break

        if last_verify.get("ok"):
            _create_task_state["status"] = "done"
            _create_task_state["error"] = None
        else:
            failed = last_verify.get("failed", [])
            errors_map = last_verify.get("errors", {})
            first_fail = failed[0] if failed else "unknown"
            first_err = _clean_sdk_error(errors_map.get(first_fail, "SP cannot read table"))
            _create_task_state["status"] = "error"
            _create_task_state["error"] = (
                f"SP verification failed on `{first_fail}`: {first_err}. "
                "Retry table creation in 1-2 minutes if grants were just applied."
            )
            logger.error(f"Phase 3 verification failed: {_create_task_state['error']}")

    except Exception as e:
        _create_task_state["status"] = "error"
        _create_task_state["error"] = _clean_sdk_error(str(e))
        logger.error(f"Table creation failed: {e}")


@router.post("/refresh-tables")
async def refresh_tables(
    background_tasks: BackgroundTasks,
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Refresh all materialized view tables with latest data.

    This rebuilds all tables from scratch with current data.
    Should be run daily to keep data fresh.
    """
    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if run_in_background:
        background_tasks.add_task(
            _refresh_tables_task, target_catalog, target_schema
        )
        return {
            "status": "started",
            "message": "Table refresh started in background. Check /api/setup/status for progress.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        results = refresh_materialized_views(target_catalog, target_schema)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _refresh_tables_task(catalog: str, schema: str):
    """Background task to refresh tables."""
    logger.info(f"Starting background table refresh for {catalog}.{schema}")
    try:
        results = refresh_materialized_views(catalog, schema)
        logger.info(f"Table refresh completed: {results}")
    except Exception as e:
        logger.error(f"Table refresh failed: {e}")


# ============================================================================
# AWS CUR Setup Endpoints
# ============================================================================

@router.get("/aws-cur/status")
async def get_aws_cur_status() -> dict[str, Any]:
    """Check the status of AWS CUR integration.

    Returns information about:
    - Available external locations that might contain CUR data
    - Existing CUR tables (bronze/silver/gold)
    - Whether the system is ready for CUR setup
    """
    from server.aws_cur_setup import check_cur_prerequisites, get_catalog_schema

    catalog, schema = get_catalog_schema()
    prerequisites = check_cur_prerequisites(catalog, schema)

    return {
        "catalog": catalog,
        "schema": schema,
        "external_locations": prerequisites["external_locations"],
        "existing_tables": prerequisites["existing_tables"],
        "tables_exist": len(prerequisites["existing_tables"]) == 3,
        "ready_for_setup": prerequisites["ready"],
        "status": "configured" if len(prerequisites["existing_tables"]) == 3 else "not_configured",
    }


@router.post("/aws-cur/create-tables")
async def create_aws_cur_tables(
    background_tasks: BackgroundTasks,
    s3_path: str = Query(default=None, description="S3 path to CUR data (e.g., s3://bucket/cur-reports/)"),
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    load_data: bool = Query(default=False, description="Load data from S3 after creating tables"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Create AWS CUR medallion tables (bronze/silver/gold).

    This creates the table structure for processing AWS Cost and Usage Reports.

    Prerequisites:
    1. CUR 2.0 must be enabled in AWS Billing Console
    2. CUR data must be exported to S3 (Parquet format)
    3. Unity Catalog External Location must exist pointing to the CUR bucket
    4. Storage Credential must have read access to the S3 bucket

    Args:
        s3_path: S3 path where CUR data is stored (required if load_data=True)
        catalog: Target catalog for tables
        schema: Target schema for tables
        load_data: If True, also loads data from S3 into bronze table
        run_in_background: Run table creation in background
    """
    from server.aws_cur_setup import create_cur_tables, get_catalog_schema

    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if load_data and not s3_path:
        return {
            "status": "error",
            "message": "s3_path is required when load_data=True",
        }

    if run_in_background:
        background_tasks.add_task(
            _create_cur_tables_task, target_catalog, target_schema, s3_path, load_data
        )
        return {
            "status": "started",
            "message": "AWS CUR table creation started in background. Check /api/setup/aws-cur/status for progress.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        results = create_cur_tables(target_catalog, target_schema, s3_path, load_data)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _create_cur_tables_task(catalog: str, schema: str, s3_path: str | None, load_data: bool):
    """Background task to create CUR tables."""
    from server.aws_cur_setup import create_cur_tables

    logger.info(f"Starting background CUR table creation for {catalog}.{schema}")
    try:
        results = create_cur_tables(catalog, schema, s3_path, load_data)
        logger.info(f"CUR table creation completed: {results}")
    except Exception as e:
        logger.error(f"CUR table creation failed: {e}")


@router.post("/aws-cur/refresh")
async def refresh_aws_cur_tables(
    background_tasks: BackgroundTasks,
    s3_path: str = Query(default=None, description="S3 path to CUR data"),
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Refresh AWS CUR tables with latest data.

    This incrementally loads new CUR data from S3 and refreshes
    the silver and gold tables.
    """
    from server.aws_cur_setup import refresh_cur_tables, get_catalog_schema

    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if run_in_background:
        background_tasks.add_task(
            _refresh_cur_tables_task, target_catalog, target_schema, s3_path
        )
        return {
            "status": "started",
            "message": "AWS CUR table refresh started in background.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        results = refresh_cur_tables(target_catalog, target_schema, s3_path)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _refresh_cur_tables_task(catalog: str, schema: str, s3_path: str | None):
    """Background task to refresh CUR tables."""
    from server.aws_cur_setup import refresh_cur_tables

    logger.info(f"Starting background CUR table refresh for {catalog}.{schema}")
    try:
        results = refresh_cur_tables(catalog, schema, s3_path)
        logger.info(f"CUR table refresh completed: {results}")
    except Exception as e:
        logger.error(f"CUR table refresh failed: {e}")


# ============================================================================
# Bootstrap Admin (called on first-run wizard completion)
# ============================================================================


@router.post("/bootstrap-admin")
async def bootstrap_admin(request: Request) -> dict[str, Any]:
    """Save the deploying user as admin on first-run setup completion."""
    # X-Forwarded-Email is injected by Databricks Apps on Azure but may be absent on AWS.
    # Fall back to resolving identity from the forwarded OAuth token via the SDK.
    user_email = request.headers.get("X-Forwarded-Email", "")
    if not user_email:
        try:
            from server.db import get_user_workspace_client
            import asyncio as _asyncio
            loop = _asyncio.get_running_loop()
            me = await loop.run_in_executor(
                None, lambda: get_user_workspace_client().current_user.me()
            )
            user_email = me.user_name or ""
        except Exception as e:
            logger.warning(f"Could not resolve user identity for bootstrap-admin: {e}")
    if not user_email:
        return {"status": "skipped", "reason": "no user email available"}

    try:
        from server.routers.settings import _load_user_permissions, _save_user_permissions_to_table

        perms = _load_user_permissions()
        if user_email in perms.get("admins", []):
            return {"status": "ok", "email": user_email, "role": "admin", "note": "already admin"}

        admins = perms.get("admins", []) + [user_email]
        consumers = perms.get("consumers", [])

        _save_user_permissions_to_table(admins, consumers)
        logger.info(f"Bootstrapped admin in Delta table: {user_email}")
        return {"status": "ok", "email": user_email, "role": "admin"}

    except Exception as e:
        logger.error(f"Bootstrap admin failed: {e}")
        return {"status": "error", "message": str(e)}


# ============================================================================
# Catalog creation (storage step — must succeed before permissions step)
# ============================================================================


@router.post("/ensure-catalog")
async def ensure_catalog(request: Request) -> dict[str, Any]:
    """Create the target catalog if it doesn't already exist.

    Runs as the SP using the UC SDK (M2M token has unity-catalog scope).
    SQL warehouse CREATE CATALOG is NOT used — it silently no-ops on permission
    errors and SHOW CATALOGS LIKE has underscore wildcard bugs.
    """
    import asyncio as _asyncio

    catalog, _ = get_catalog_schema()

    if not catalog:
        raise HTTPException(status_code=400, detail="No catalog configured.")

    def _create():
        w = get_workspace_client()  # SP M2M — has unity-catalog scope
        try:
            w.catalogs.create(name=catalog)
            logger.info(f"Catalog `{catalog}` created via SDK as SP")
        except Exception as e:
            msg = _clean_sdk_error(str(e))
            lower = msg.lower()
            if any(kw in lower for kw in ("already exists", "already_exists", "already exist")):
                logger.info(f"Catalog `{catalog}` already exists — ok")
            elif any(kw in lower for kw in ("permission", "privilege", "forbidden", "unauthorized", "insufficient", "does not have")):
                sp_id = os.getenv("DATABRICKS_CLIENT_ID", "<sp-client-id>")
                return {
                    "ok": False, "catalog": catalog,
                    "message": (
                        f"The app service principal (client ID: {sp_id}) lacks CREATE CATALOG. "
                        f"Run this in Databricks SQL then retry: "
                        f"GRANT CREATE CATALOG ON METASTORE TO `{sp_id}`"
                    ),
                }
            else:
                logger.warning(f"ensure-catalog SDK create failed for `{catalog}`: {msg}")
                return {"ok": False, "catalog": catalog, "message": f"Could not create catalog: {msg}"}

        # Verify via SDK get() — avoids SHOW CATALOGS LIKE wildcard bug where
        # underscore in catalog name matches unrelated catalogs.
        try:
            w.catalogs.get(catalog)
            logger.info(f"Catalog `{catalog}` verified")
            return {"ok": True, "catalog": catalog, "message": f"Catalog `{catalog}` is ready."}
        except Exception as e:
            msg = _clean_sdk_error(str(e))
            logger.warning(f"ensure-catalog verify failed for `{catalog}`: {msg}")
            return {"ok": False, "catalog": catalog, "message": f"Could not verify catalog `{catalog}`: {msg}"}

    loop = _asyncio.get_running_loop()
    return await loop.run_in_executor(None, _create)


@router.post("/ensure-schema")
async def ensure_schema(request: Request) -> dict[str, Any]:
    """Create the target schema if it doesn't already exist.

    Runs as the SP via UC SDK. The SP owns the catalog after ensure-catalog
    creates it, so CREATE SCHEMA succeeds without any extra privilege grant.
    """
    import asyncio as _asyncio

    catalog, schema = get_catalog_schema()

    if not catalog or not schema:
        raise HTTPException(status_code=400, detail="No catalog/schema configured.")

    def _create():
        w = get_workspace_client()  # SP M2M — has unity-catalog scope
        try:
            w.schemas.create(name=schema, catalog_name=catalog)
            logger.info(f"Schema `{catalog}`.`{schema}` created via SDK as SP")
        except Exception as e:
            msg = _clean_sdk_error(str(e))
            lower = msg.lower()
            if any(kw in lower for kw in ("already exists", "already_exists", "already exist")):
                logger.info(f"Schema `{catalog}`.`{schema}` already exists — ok")
            else:
                logger.warning(f"ensure-schema SDK create failed: {msg}")
                return {"ok": False, "schema": f"{catalog}.{schema}", "message": f"Could not create schema: {msg}"}

        # Verify via SDK get() — avoids SHOW SCHEMAS LIKE underscore wildcard bug.
        try:
            w.schemas.get(f"{catalog}.{schema}")
            logger.info(f"Schema `{catalog}`.`{schema}` verified")
            return {"ok": True, "schema": f"{catalog}.{schema}",
                    "message": f"Schema `{catalog}.{schema}` is ready."}
        except Exception as e:
            msg = _clean_sdk_error(str(e))
            logger.warning(f"ensure-schema verify failed: {msg}")
            return {"ok": False, "schema": f"{catalog}.{schema}", "message": f"Could not verify schema: {msg}"}

    loop = _asyncio.get_running_loop()
    return await loop.run_in_executor(None, _create)


# ============================================================================
# Catalog Permission Grant (setup wizard helper)
# ============================================================================


@router.post("/grant-catalog-access")
async def grant_catalog_access(request: Request) -> dict[str, Any]:
    """Attempt to grant the current user CREATE SCHEMA on the target catalog.

    Called from the setup wizard when table creation fails with a permission
    error. Uses the user's OAuth token — only succeeds if they are a metastore
    admin or catalog owner. Returns ok=True/False with a message so the frontend
    can either show success and let them retry, or confirm they need an admin.
    """
    import asyncio as _asyncio

    catalog, _ = get_catalog_schema()
    user_email = request.headers.get("X-Forwarded-Email", "")

    try:
        from server.db import get_user_workspace_client
        from databricks.sdk.service.catalog import SecurableType

        loop = _asyncio.get_running_loop()

        def _do_grants():
            w = get_user_workspace_client()
            if not user_email:
                me = w.current_user.me()
                principal = me.user_name or ""
            else:
                principal = user_email

            errors = []
            for privilege, securable_type, full_name in [
                ("USE CATALOG",   SecurableType.CATALOG, catalog),
                ("CREATE SCHEMA", SecurableType.CATALOG, catalog),
            ]:
                try:
                    # Use raw REST API — w.grants.update() raises "unable to parse
                    # response" on success because the SDK fails to deserialize the
                    # minimal PATCH response body (same bug as SP grants).
                    w.api_client.do(
                        "PATCH",
                        f"/api/2.1/unity-catalog/permissions/{securable_type.value}/{full_name}",
                        body={"changes": [{"principal": principal, "add": [privilege]}]},
                    )
                except Exception as e:
                    err = str(e).lower()
                    if "already" not in err:
                        errors.append(f"{privilege}: {e}")

            return principal, errors

        principal, errors = await loop.run_in_executor(None, _do_grants)

        if errors:
            return {
                "ok": False,
                "message": f"Could not apply all grants — you may not have metastore admin rights. "
                           f"Errors: {'; '.join(errors)}",
                "sql": (
                    f"GRANT USE CATALOG ON CATALOG `{catalog}` TO `{principal}`;\n"
                    f"GRANT CREATE SCHEMA ON CATALOG `{catalog}` TO `{principal}`;"
                ),
            }

        return {
            "ok": True,
            "message": f"Granted USE CATALOG and CREATE SCHEMA on `{catalog}` to `{principal}`. "
                       f"Click Create Tables to continue.",
        }

    except Exception as e:
        catalog, _ = get_catalog_schema()
        user = user_email or "your-user@example.com"
        return {
            "ok": False,
            "message": f"Grant attempt failed: {e}",
            "sql": (
                f"GRANT USE CATALOG ON CATALOG `{catalog}` TO `{user}`;\n"
                f"GRANT CREATE SCHEMA ON CATALOG `{catalog}` TO `{user}`;"
            ),
        }


# ============================================================================
# Token Generation (for local development)
# ============================================================================


@router.post("/generate-token")
async def generate_token() -> dict[str, Any]:
    """Generate a Databricks PAT using the app's OAuth credentials.

    Useful for local development: once the app is running with OAuth,
    generate a token to use as DATABRICKS_TOKEN in a local .env file.
    """
    try:
        w = get_workspace_client()
        host = w.config.host or os.getenv("DATABRICKS_HOST", "")
        response = w.tokens.create(
            comment="cost-obs local development",
            lifetime_seconds=7776000,  # 90 days
        )
        token_value = response.token_value
        expiry = response.token_info.expiry_time if response.token_info else None
        return {
            "status": "created",
            "token": token_value,
            "host": host,
            "expiry_time": expiry,
        }
    except Exception as e:
        logger.error(f"Failed to generate token: {e}")
        return {"status": "error", "message": str(e)}


# ============================================================================
# Genie Space Setup
# ============================================================================


def _load_genie_settings() -> dict:
    """Load Genie settings from file."""
    if os.path.exists(GENIE_SETTINGS_FILE):
        with open(GENIE_SETTINGS_FILE, "r") as f:
            return json.load(f)
    return {}


def _save_genie_settings(settings: dict) -> None:
    """Save Genie settings to file."""
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(GENIE_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


@router.get("/genie-space/status")
async def get_genie_space_status() -> dict[str, Any]:
    """Check if a Genie Space has been created for this app."""
    settings = _load_genie_settings()
    space_id = settings.get("space_id", "") or os.getenv("GENIE_SPACE_ID", "")
    return {
        "configured": bool(space_id),
        "space_id": space_id or None,
    }


@router.post("/create-genie-space")
async def create_genie_space() -> dict[str, Any]:
    """Create a Genie Space for cost analytics during first-time setup.

    Uses the pre-configured genie_space_config.json to create a space
    via the Databricks Genie API. Stores the resulting space_id in
    .settings/genie_settings.json for the genie router to use.
    """
    # Check if already created
    settings = _load_genie_settings()
    existing_id = settings.get("space_id", "") or os.getenv("GENIE_SPACE_ID", "")
    if existing_id:
        return {
            "status": "already_exists",
            "space_id": existing_id,
            "message": "Genie Space already configured.",
        }

    # Load genie space config
    config_path = os.path.join(os.path.dirname(__file__), "..", "..", "genie_space_config.json")
    config_path = os.path.normpath(config_path)
    if not os.path.exists(config_path):
        return {
            "status": "error",
            "message": "genie_space_config.json not found. Cannot create Genie Space.",
        }

    with open(config_path, "r") as f:
        genie_config = json.load(f)

    # Get auth from workspace client
    try:
        w = get_workspace_client()
        host = w.config.host or ""
        header = w.config.authenticate()
        token = header.get("Authorization", "").replace("Bearer ", "")
    except Exception as e:
        logger.error(f"Failed to get workspace client for Genie setup: {e}")
        return {
            "status": "error",
            "message": f"Failed to authenticate with workspace: {e}",
        }

    if not host.startswith("http"):
        host = f"https://{host}"

    # Get a warehouse ID
    try:
        warehouses = list(w.warehouses.list())
        if not warehouses:
            return {
                "status": "error",
                "message": "No SQL warehouses found. A warehouse is required for the Genie Space.",
            }
        warehouse_id = warehouses[0].id
        logger.info(f"Using warehouse {warehouses[0].name} ({warehouse_id}) for Genie Space")
    except Exception as e:
        logger.error(f"Failed to list warehouses: {e}")
        return {
            "status": "error",
            "message": f"Failed to list SQL warehouses: {e}",
        }

    # Add warehouse_id to config
    genie_config["warehouse_id"] = warehouse_id

    # Create the Genie Space
    import httpx

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{host}/api/2.0/genie/spaces",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=genie_config,
            )

            if response.status_code not in (200, 201):
                logger.error(f"Genie API error: {response.text}")
                return {
                    "status": "error",
                    "message": f"Genie API error ({response.status_code}): {response.text[:200]}",
                }

            space_data = response.json()
            space_id = space_data.get("space_id", "")

            if not space_id:
                return {
                    "status": "error",
                    "message": "Genie API returned success but no space_id.",
                }

            # Save to settings file
            _save_genie_settings({"space_id": space_id, "warehouse_id": warehouse_id})
            logger.info(f"Genie Space created: {space_id}")

            # Grant the app's service principal CAN_RUN on the Genie Space
            try:
                sp_client_id = w.config.client_id or os.getenv("DATABRICKS_CLIENT_ID", "")
                if sp_client_id:
                    perm_response = await client.patch(
                        f"{host}/api/2.0/permissions/genie/{space_id}",
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Content-Type": "application/json",
                        },
                        json={
                            "access_control_list": [{
                                "service_principal_name": sp_client_id,
                                "permission_level": "CAN_RUN",
                            }]
                        },
                    )
                    if perm_response.status_code == 200:
                        logger.info(f"Granted CAN_RUN to service principal {sp_client_id}")
                    else:
                        logger.warning(f"Failed to grant Genie permissions: {perm_response.text[:200]}")
            except Exception as perm_err:
                logger.warning(f"Could not grant Genie permissions to service principal: {perm_err}")

            return {
                "status": "created",
                "space_id": space_id,
                "message": "Genie Space created successfully.",
            }

    except httpx.RequestError as e:
        logger.error(f"Failed to create Genie Space: {e}")
        return {
            "status": "error",
            "message": f"Request to Genie API failed: {e}",
        }



# ============================================================================
# Readiness Checks
# ============================================================================

import re as _re
import threading
import time
from concurrent.futures import Future as _Future
from dataclasses import dataclass
from enum import Enum


class CheckStatus(str, Enum):
    HEALTHY = "healthy"
    NOT_CONFIGURED = "not_configured"
    TIMEOUT_STARTING = "timeout_starting"
    PERMISSION_DENIED = "permission_denied"
    INTERNAL_ERROR = "internal_error"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class WarehouseCheckResult:
    status: CheckStatus
    ok: bool
    message: str
    warehouse_id: str | None = None
    source: str | None = None


@dataclass
class TimedWarehouseCheckCache:
    result: WarehouseCheckResult
    expires_at: float

    def is_valid(self) -> bool:
        return time.monotonic() < self.expires_at


_CORE_TABLES = {"system.billing.usage", "system.billing.list_prices"}

# Persistent single-worker executor — prevents shutdown(wait=True) from blocking
# the request thread when a cold-warehouse future is abandoned on timeout.
_wh_check_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wh_check")
_wh_check_lock = threading.Lock()
_wh_check_inflight: _Future | None = None
_wh_check_cache: TimedWarehouseCheckCache | None = None

# Short TTLs for transient states prevent repeated slow callers from pile-up.
_WH_TTL_BY_STATUS: dict[CheckStatus, int] = {
    CheckStatus.HEALTHY: 300,
    CheckStatus.PERMISSION_DENIED: 300,
    CheckStatus.NOT_CONFIGURED: 3600,
    CheckStatus.TIMEOUT_STARTING: 15,
    CheckStatus.INTERNAL_ERROR: 5,
    CheckStatus.UNAVAILABLE: 15,
}
_WH_CHECK_TIMEOUT = 30  # seconds the caller blocks waiting for a warehouse response

# Table checks run as SP — result doesn't vary by user, 5-min cache is safe.
_table_readiness_cache: dict[str, Any] | None = None
_table_readiness_cache_ts: float = 0.0
_TABLE_CACHE_TTL = 300


def _resolve_warehouse_config() -> tuple[str, str]:
    """Return (source, warehouse_id). Source is 'app_resource', 'http_path', or 'none'."""
    wh_env_id = os.getenv("DATABRICKS_WAREHOUSE_ID", "")
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    if wh_env_id:
        return "app_resource", wh_env_id
    if http_path and http_path.lower() != "auto":
        parts = http_path.strip("/").split("/")
        wh_id = parts[-1] if parts and parts[-1] != "warehouses" else ""
        return "http_path", wh_id
    return "none", ""


def _run_blocking_warehouse_check() -> WarehouseCheckResult:
    """Execute a test query as the SP. Runs inside _wh_check_executor.

    Classifies exceptions into typed CheckStatus so callers can apply the
    right cache TTL and surface a useful error message.
    Guards against misconfigured callers: returns NOT_CONFIGURED immediately
    if no warehouse is resolvable, instead of letting execute_query fail
    with an unhelpful connection error.
    """
    from server.db import execute_query, _user_token
    source, warehouse_id = _resolve_warehouse_config()
    if source == "none":
        return WarehouseCheckResult(
            status=CheckStatus.NOT_CONFIGURED,
            ok=False,
            message="No warehouse configured",
            source="none",
        )
    tok = _user_token.set("")
    try:
        execute_query("SELECT current_user()", no_cache=True)
        return WarehouseCheckResult(
            status=CheckStatus.HEALTHY,
            ok=True,
            message="",
            warehouse_id=warehouse_id,
            source=source,
        )
    except Exception as exc:
        msg = str(exc)
        logger.error("Warehouse readiness check failed: %s", msg, exc_info=True)
        lower = msg.lower()
        if any(kw in lower for kw in ("permission", "denied", "unauthorized", "forbidden", "privilege")):
            status = CheckStatus.PERMISSION_DENIED
        elif any(kw in lower for kw in ("timeout", "timed out", "starting", "unavailable", "connection")):
            status = CheckStatus.TIMEOUT_STARTING
        else:
            status = CheckStatus.INTERNAL_ERROR
        return WarehouseCheckResult(status=status, ok=False, message=msg, warehouse_id=warehouse_id, source=source)
    finally:
        _user_token.reset(tok)


def _cache_ttl_for_warehouse(result: WarehouseCheckResult) -> int:
    return _WH_TTL_BY_STATUS.get(result.status, 15)


def _get_cached_warehouse_check() -> WarehouseCheckResult | None:
    with _wh_check_lock:
        if _wh_check_cache is not None and _wh_check_cache.is_valid():
            return _wh_check_cache.result
        return None


def _set_cached_warehouse_check(result: WarehouseCheckResult) -> None:
    global _wh_check_cache
    ttl = _cache_ttl_for_warehouse(result)
    with _wh_check_lock:
        _wh_check_cache = TimedWarehouseCheckCache(
            result=result,
            expires_at=time.monotonic() + ttl,
        )


def _get_or_start_warehouse_check_future() -> _Future:
    """Single-flight: reuse in-flight future if one is already running."""
    global _wh_check_inflight
    with _wh_check_lock:
        if _wh_check_inflight is not None and not _wh_check_inflight.done():
            return _wh_check_inflight
        future = _wh_check_executor.submit(_run_blocking_warehouse_check)
        _wh_check_inflight = future
        return future


def check_warehouse_readiness() -> WarehouseCheckResult:
    """Return a WarehouseCheckResult via cache → single-flight → timeout.

    NOT_CONFIGURED flows through the same cache path as other statuses so that
    the 3600s TTL is respected instead of re-reading env vars on every request.
    """
    from concurrent.futures import TimeoutError as _FutureTimeout
    cached = _get_cached_warehouse_check()
    if cached is not None:
        return cached
    future = _get_or_start_warehouse_check_future()
    try:
        result = future.result(timeout=_WH_CHECK_TIMEOUT)
    except _FutureTimeout:
        logger.warning("Warehouse readiness timed out after %ds (may be starting up)", _WH_CHECK_TIMEOUT)
        result = WarehouseCheckResult(
            status=CheckStatus.TIMEOUT_STARTING,
            ok=False,
            message="Warehouse check timed out — warehouse may be starting up. Try re-checking once running.",
        )
    except Exception as exc:
        logger.error("Warehouse check future raised: %s", exc, exc_info=True)
        result = WarehouseCheckResult(
            status=CheckStatus.INTERNAL_ERROR,
            ok=False,
            message=str(exc),
        )
    _set_cached_warehouse_check(result)
    return result


def _uc_identifier(part: str) -> str:
    """Quote a single UC identifier part only when it requires backtick quoting."""
    if _re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", part):
        return part
    escaped = part.replace("`", "``")
    return f"`{escaped}`"


def _build_fix_sql(table: str, sp_client_id: str) -> str:
    """Return GRANT statements to fix SP access. Uses per-part identifier quoting."""
    if not sp_client_id:
        return ""
    parts = table.split(".")
    if len(parts) == 3:
        q0, q1, q2 = _uc_identifier(parts[0]), _uc_identifier(parts[1]), _uc_identifier(parts[2])
        return (
            f"GRANT USE CATALOG ON CATALOG {q0} TO `{sp_client_id}`;\n"
            f"GRANT USE SCHEMA ON SCHEMA {q0}.{q1} TO `{sp_client_id}`;\n"
            f"GRANT SELECT ON TABLE {q0}.{q1}.{q2} TO `{sp_client_id}`;"
        )
    q_table = ".".join(_uc_identifier(p) for p in parts)
    return f"GRANT SELECT ON TABLE {q_table} TO `{sp_client_id}`;"


def _check_table_as_sp(table: str) -> tuple[bool, str]:
    """Run check_table_access with the user token cleared (forces SP auth)."""
    from server.routers.permissions import check_table_access
    from server.db import _user_token
    tok = _user_token.set("")
    try:
        return check_table_access(table)
    finally:
        _user_token.reset(tok)


def _safe_table_check_result(table_name: str, future: _Future) -> tuple[bool, str, CheckStatus]:
    """Resolve a table check future and return (ok, error_msg, status_str).

    Logs full tracebacks for internal errors so they don't disappear silently.
    """
    try:
        ok, msg = future.result()
        if ok:
            return True, "", CheckStatus.HEALTHY
        lower = msg.lower()
        if any(kw in lower for kw in ("permission", "denied", "privilege", "unauthorized", "forbidden")):
            return False, msg, CheckStatus.PERMISSION_DENIED
        return False, msg, CheckStatus.INTERNAL_ERROR
    except Exception as exc:
        logger.error("Table check future for %s raised: %s", table_name, exc, exc_info=True)
        return False, str(exc), CheckStatus.INTERNAL_ERROR


def _build_warehouse_item(
    wh_result: WarehouseCheckResult, warehouse_id: str, sp_client_id: str
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "name": "SQL Warehouse",
        "description": "Service principal can execute queries on the configured warehouse",
        "category": "core",
        "source": wh_result.source or "none",
        "granted": wh_result.ok,
    }
    if not wh_result.ok:
        item["error"] = wh_result.message
        if sp_client_id and warehouse_id:
            item["fix_sql"] = f"GRANT CAN_USE ON WAREHOUSE `{warehouse_id}` TO `{sp_client_id}`;"
    return item


def _calc_overall(
    core_tables_pass: bool,
    warehouse_pass: bool,
    enhanced_all_pass: bool,
    core_checks: list[dict],
) -> str:
    if core_tables_pass and warehouse_pass and enhanced_all_pass:
        return "ready"
    if core_tables_pass and warehouse_pass:
        return "core_ready"
    if core_tables_pass or any(c["granted"] for c in core_checks):
        return "needs_action"
    return "not_ready"


def _check_readiness_sync(bypass_cache: bool = False) -> dict[str, Any]:
    """Run all readiness checks as the SP and return a categorized result."""
    from concurrent.futures import as_completed
    from server.routers.permissions import REQUIRED_PERMISSIONS

    global _table_readiness_cache, _table_readiness_cache_ts

    if bypass_cache:
        reset_readiness_caches()

    sp_client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
    _, warehouse_id = _resolve_warehouse_config()

    # Snapshot the table cache reference once — prevents TOCTOU if a concurrent
    # bypass_cache=True request calls reset_readiness_caches() between the
    # is-None check and the subsequent ["core"] / ["enhanced"] reads.
    cached_tables = _table_readiness_cache
    table_cache_valid = (
        cached_tables is not None
        and (time.monotonic() - _table_readiness_cache_ts) < _TABLE_CACHE_TTL
    )
    wh_cached = _get_cached_warehouse_check()

    # Both caches fresh — merge and return immediately without any blocking calls.
    if table_cache_valid and wh_cached is not None:
        wh_item = _build_warehouse_item(wh_cached, warehouse_id, sp_client_id)
        overall = _calc_overall(
            all(c["granted"] for c in cached_tables["core"]),  # type: ignore[index]
            wh_item["granted"],
            all(c["granted"] for c in cached_tables["enhanced"]),  # type: ignore[index]
            cached_tables["core"],  # type: ignore[index]
        )
        return {
            "overall": overall,
            "warehouse": wh_item,
            "core": cached_tables["core"],  # type: ignore[index]
            "enhanced": cached_tables["enhanced"],  # type: ignore[index]
            "sp_client_id": sp_client_id,
        }

    # Kick off the warehouse future before table checks so both run concurrently.
    source, _ = _resolve_warehouse_config()
    if source != "none" and wh_cached is None:
        _get_or_start_warehouse_check_future()

    if not table_cache_valid:
        with ThreadPoolExecutor(max_workers=len(REQUIRED_PERMISSIONS)) as pool:
            table_futures: dict = {
                pool.submit(_check_table_as_sp, perm["table"]): perm
                for perm in REQUIRED_PERMISSIONS
            }
            access_results: dict[str, tuple[bool, str, str]] = {}
            for future in as_completed(table_futures):
                perm = table_futures[future]
                ok, msg, status = _safe_table_check_result(perm["table"], future)
                access_results[perm["table"]] = (ok, msg, status)

        core_checks: list[dict] = []
        enhanced_checks: list[dict] = []
        for perm in REQUIRED_PERMISSIONS:
            ok, msg, _ = access_results[perm["table"]]
            is_core = perm["table"] in _CORE_TABLES
            check: dict[str, Any] = {
                "table": perm["table"],
                "name": perm["name"],
                "description": perm["description"],
                "required": perm["required"],
                "granted": ok,
                "category": "core" if is_core else "enhanced",
            }
            if not ok:
                check["fix_sql"] = _build_fix_sql(perm["table"], sp_client_id)
                if msg:
                    check["error"] = msg
            if is_core:
                core_checks.append(check)
            else:
                enhanced_checks.append(check)

        _table_readiness_cache = {
            "core": core_checks,
            "enhanced": enhanced_checks,
            "sp_client_id": sp_client_id,
        }
        _table_readiness_cache_ts = time.monotonic()
    else:
        # cached_tables snapshot taken above — safe from concurrent reset
        core_checks = cached_tables["core"]  # type: ignore[index]
        enhanced_checks = cached_tables["enhanced"]  # type: ignore[index]

    # Collect warehouse result — reuses the in-flight future started above.
    wh_result = check_warehouse_readiness()
    wh_item = _build_warehouse_item(wh_result, warehouse_id, sp_client_id)
    overall = _calc_overall(
        all(c["granted"] for c in core_checks),
        wh_item["granted"],
        all(c["granted"] for c in enhanced_checks),
        core_checks,
    )
    return {
        "overall": overall,
        "warehouse": wh_item,
        "core": core_checks,
        "enhanced": enhanced_checks,
        "sp_client_id": sp_client_id,
    }


def shutdown_readiness_executor() -> None:
    """Shut down the warehouse check executor on app shutdown."""
    global _wh_check_inflight
    with _wh_check_lock:
        _wh_check_inflight = None
    _wh_check_executor.shutdown(wait=False)
    logger.info("Readiness executor shut down")


def reset_readiness_caches() -> None:
    """Clear all readiness caches. Used in tests and forced re-check."""
    global _table_readiness_cache, _table_readiness_cache_ts, _wh_check_cache, _wh_check_inflight
    with _wh_check_lock:
        _table_readiness_cache = None
        _table_readiness_cache_ts = 0.0
        _wh_check_cache = None
        _wh_check_inflight = None


@router.get("/readiness")
async def get_readiness(refresh: bool = False) -> dict[str, Any]:
    """Structured readiness report for the setup wizard and Settings → Permissions.

    All checks run as the service principal regardless of auth_mode or request
    headers.  Cached with status-appropriate TTLs.  Pass ?refresh=true to force
    a live re-check.
    """
    import asyncio as _asyncio
    loop = _asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda: _check_readiness_sync(bypass_cache=refresh),
    )


@router.get("/list-workspaces")
async def list_workspaces() -> dict:
    """Return all workspaces in the account for the setup wizard workspace picker.

    Queries the app's own daily_workspace_breakdown table (already created by
    the time the wizard reaches this step) rather than system.access.workspaces_latest,
    which requires a separate schema grant the SP does not hold.
    """
    from server.db import execute_query, get_catalog_schema
    try:
        catalog, schema = get_catalog_schema()
        rows = execute_query(f"""
            SELECT
                CAST(workspace_id AS STRING) AS workspace_id,
                MAX(COALESCE(workspace_name, CAST(workspace_id AS STRING))) AS workspace_name
            FROM `{catalog}`.`{schema}`.daily_workspace_breakdown
            WHERE workspace_id IS NOT NULL
            GROUP BY workspace_id
            ORDER BY workspace_name
        """)
        return {
            "workspaces": [
                {"id": r["workspace_id"], "name": r["workspace_name"]}
                for r in (rows or [])
                if r.get("workspace_id")
            ]
        }
    except Exception as e:
        logger.warning("list-workspaces failed: %s", e)
        return {"workspaces": [], "error": str(e)}


@router.get("/preflight-catalog")
async def preflight_catalog_endpoint(request: Request) -> dict:
    """Check the configured catalog exists before table creation.

    Uses SP credentials + SHOW CATALOGS SQL so we avoid the unity-catalog OAuth
    scope requirement (forwarded user tokens from Databricks Apps don't carry it).
    Distinguishes "catalog missing" from "SP has no USE privilege" by error text.
    """
    import asyncio as _asyncio

    catalog, schema = get_catalog_schema()

    def _check():
        if not catalog:
            return {"ok": False, "status": "invalid_config",
                    "message": "No catalog configured — return to the Storage step."}
        try:
            w = get_workspace_client()
            w.catalogs.get(catalog)
            return {"ok": True, "status": "ready", "message": f"Catalog `{catalog}` is accessible."}
        except Exception as e:
            msg = _clean_sdk_error(str(e))
            msg_lower = msg.lower()
            # "not found" / "does not exist" / CATALOG_NOT_FOUND → catalog genuinely absent
            if any(kw in msg_lower for kw in ("not found", "does not exist", "404", "catalog_not_found")):
                return {
                    "ok": False,
                    "status": "catalog_missing",
                    "message": f"Catalog `{catalog}` does not exist. Create it in Unity Catalog before continuing.",
                }
            # SP has no USE CATALOG yet — grants haven't landed or weren't applied.
            # Treat this as OK for preflight; the pre-creation grant in _create_tables_task
            # will apply USE CATALOG before create_materialized_views runs.
            if any(kw in msg_lower for kw in ("permission", "privilege", "unauthorized", "forbidden", "403", "insufficient")):
                return {"ok": True, "status": "ready",
                        "message": f"Catalog `{catalog}` exists (SP permissions will be applied at build time)."}
            return {
                "ok": False,
                "status": "catalog_check_failed",
                "message": f"Could not verify catalog `{catalog}`: {msg}",
            }

    loop = _asyncio.get_running_loop()
    return await loop.run_in_executor(None, _check)


@router.get("/workspace-filter")
async def get_workspace_filter() -> dict:
    """Return the current workspace filter and whether it is locked (already configured during setup)."""
    settings_path = os.path.join(SETTINGS_DIR, "workspace_filter.json")
    import re as _re
    workspace_ids: list[str] = []
    try:
        with open(settings_path) as f:
            data = json.load(f)
        workspace_ids = [str(i) for i in data.get("workspace_ids", []) if _re.match(r'^[a-zA-Z0-9_\-\.]+$', str(i))]
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Locked = Delta table has a row (written on first save, survives redeploys)
    locked = False
    try:
        from server.db import execute_query, get_catalog_schema
        catalog, schema = get_catalog_schema()
        rows = execute_query(
            f"SELECT workspace_ids FROM `{catalog}`.`{schema}`.app_workspace_filter LIMIT 1",
            no_cache=True,
        )
        if rows:
            locked = True
            if not workspace_ids and rows[0].get("workspace_ids"):
                workspace_ids = [
                    i.strip() for i in str(rows[0]["workspace_ids"]).split(",")
                    if i.strip() and _re.match(r'^[a-zA-Z0-9_\-\.]+$', i.strip())
                ]
    except Exception:
        pass

    return {"workspace_ids": workspace_ids, "locked": locked}


def restore_workspace_filter_from_delta() -> None:
    """Restore workspace filter from Delta to the settings file on startup.

    The .settings/ directory is ephemeral in Databricks Apps — wiped on every
    git deploy. This function reads the last-saved filter from the Delta table
    and writes it back to the file so workspace_filter.py can read it normally.
    Safe to call when the table doesn't exist yet (first deploy).
    """
    settings_path = os.path.join(SETTINGS_DIR, "workspace_filter.json")
    if os.path.exists(settings_path):
        return
    try:
        from server.db import execute_query, get_catalog_schema
        catalog, schema = get_catalog_schema()
        rows = execute_query(
            f"SELECT workspace_ids FROM `{catalog}`.`{schema}`.app_workspace_filter LIMIT 1",
            no_cache=True,
        )
        if rows and rows[0].get("workspace_ids"):
            ids = [i.strip() for i in str(rows[0]["workspace_ids"]).split(",") if i.strip()]
            os.makedirs(SETTINGS_DIR, exist_ok=True)
            with open(settings_path, "w") as f:
                json.dump({"workspace_ids": ids}, f)
            logger.info("Workspace filter restored from Delta: %d workspace(s)", len(ids))
        else:
            logger.info("No workspace filter saved in Delta — showing all workspaces")
    except Exception as e:
        logger.warning("Workspace filter restore from Delta failed (non-fatal): %s", e)


@router.post("/save-workspace-filter")
async def save_workspace_filter(request: Request) -> dict:
    """Persist selected workspace IDs to .settings/workspace_filter.json and Delta. Admin only."""
    import time as _time
    import re as _re
    t0 = _time.monotonic()

    from server.routers.user import _get_user_role
    user_email = request.headers.get("X-Forwarded-Email", os.getenv("USER", ""))
    logger.info("save-workspace-filter: request from %s", user_email or "(unknown)")

    role = _get_user_role(user_email)
    logger.info("save-workspace-filter: user role=%s (%.1fms)", role, (_time.monotonic() - t0) * 1000)
    if role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required to modify the workspace filter pool")

    body = await request.json()
    raw_ids: list = body.get("workspace_ids", [])
    valid_ids = [str(i) for i in raw_ids if _re.match(r'^[a-zA-Z0-9_\-\.]+$', str(i))]
    logger.info("save-workspace-filter: validated %d/%d ids (%.1fms)", len(valid_ids), len(raw_ids), (_time.monotonic() - t0) * 1000)

    # Lock check — workspace filter is one-time, set during initial setup only
    try:
        from server.db import execute_query, get_catalog_schema
        _catalog, _schema = get_catalog_schema()
        _rows = execute_query(
            f"SELECT COUNT(*) as cnt FROM `{_catalog}`.`{_schema}`.app_workspace_filter",
            no_cache=True,
        )
        if _rows and int(_rows[0].get("cnt", 0)) > 0:
            raise HTTPException(
                status_code=409,
                detail="Workspace filter is already configured and cannot be changed after initial setup.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # Table doesn't exist yet — first save, proceed normally

    # Write to file (fast path for running workers)
    settings_path = os.path.join(SETTINGS_DIR, "workspace_filter.json")
    try:
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        with open(settings_path, "w") as f:
            json.dump({"workspace_ids": valid_ids}, f)
        elapsed_ms = (_time.monotonic() - t0) * 1000
        logger.info("save-workspace-filter: wrote %s in %.1fms — ids=%s", settings_path, elapsed_ms, valid_ids)
    except Exception as e:
        elapsed_ms = (_time.monotonic() - t0) * 1000
        logger.error("save-workspace-filter: write failed after %.1fms — path=%s error=%s", elapsed_ms, settings_path, e)
        raise HTTPException(status_code=500, detail=f"Failed to persist workspace filter: {e}")

    # Write to Delta (survives redeploys — restored to file on next startup)
    try:
        from server.db import execute_query, get_catalog_schema
        catalog, schema = get_catalog_schema()
        ids_csv = ",".join(valid_ids)
        execute_query(
            f"CREATE TABLE IF NOT EXISTS `{catalog}`.`{schema}`.app_workspace_filter "
            f"(workspace_ids STRING) USING DELTA",
            no_cache=True,
        )
        execute_query(
            f"MERGE INTO `{catalog}`.`{schema}`.app_workspace_filter AS t "
            f"USING (SELECT '{ids_csv}' AS workspace_ids) AS s ON TRUE "
            f"WHEN MATCHED THEN UPDATE SET t.workspace_ids = s.workspace_ids "
            f"WHEN NOT MATCHED THEN INSERT (workspace_ids) VALUES (s.workspace_ids)",
            no_cache=True,
        )
        logger.info("save-workspace-filter: persisted to Delta in %.1fms", (_time.monotonic() - t0) * 1000)
    except Exception as e:
        logger.warning("save-workspace-filter: Delta write failed (non-fatal — file is primary): %s", e)

    return {"saved": valid_ids}


@router.delete("/drop-materialized-views")
async def drop_mvs() -> dict:
    """Drop all app-managed materialized view tables. Irreversible — use with caution."""
    from server.db import get_catalog_schema
    catalog, schema = get_catalog_schema()
    results = drop_materialized_views(catalog, schema)
    all_dropped = all(v == "dropped" for v in results.values())
    return {"ok": all_dropped, "results": results, "catalog": catalog, "schema": schema}


@router.get("/mv-overrides")
async def get_mv_overrides() -> dict:
    """Return current MV table name overrides and the default table names."""
    from server.db import get_mv_table_overrides, get_catalog_schema
    catalog, schema = get_catalog_schema()
    overrides = get_mv_table_overrides()
    tables = []
    for name in _MV_TABLES:
        default_path = f"{catalog}.{schema}.{name}"
        tables.append({
            "logical_name": name,
            "default_path": default_path,
            "override_path": overrides.get(name, ""),
            "is_overridden": name in overrides,
        })
    return {"tables": tables, "overrides": overrides}


@router.post("/mv-overrides")
async def save_mv_overrides(request: Request) -> dict:
    """Persist MV table name overrides. Send {} or omit a key to clear an override."""
    from server.db import save_mv_table_overrides, get_mv_table_overrides
    body = await request.json()
    overrides_raw: dict = body.get("overrides", {})
    # Only keep non-empty string values for known logical names
    valid = {
        k: v.strip()
        for k, v in overrides_raw.items()
        if k in _MV_TABLES and isinstance(v, str) and v.strip()
    }
    save_mv_table_overrides(valid)
    return {"ok": True, "saved": valid, "cleared": [k for k in _MV_TABLES if k not in valid]}
