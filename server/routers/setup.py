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

# Simple in-process state for the background create-tables task
_create_task_state: dict = {"status": "idle", "error": None, "started_at": None, "elapsed_seconds": None}  # idle | running | done | error

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
    """Grant the app's SP identity all required permissions via UC REST API.

    Uses the SDK grants API directly — no SQL warehouse required, so this
    works even when the warehouse is stopped or the SP has no CAN_USE yet.
    Warehouse CAN_USE is granted via the permissions REST API.

    Always uses the user OAuth token when present, bypassing any auth_mode lock,
    because the granting user (not the SP) needs metastore admin privileges.

    Returns {"ok": bool, "sp_client_id": str, "applied": int, "failed": int, "errors": list}
    """
    from server.db import _user_token, get_workspace_client
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.catalog import SecurableType, PermissionsChange, Privilege

    _PRIV_MAP = {
        "USE CATALOG": Privilege.USE_CATALOG,
        "USE SCHEMA": Privilege.USE_SCHEMA,
        "SELECT": Privilege.SELECT,
        "CREATE TABLE": Privilege.CREATE_TABLE,
    }

    sp_client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
    if not sp_client_id:
        logger.warning("DATABRICKS_CLIENT_ID not set — skipping SP grants")
        return {"ok": False, "sp_client_id": "", "applied": 0, "failed": 0,
                "errors": ["DATABRICKS_CLIENT_ID not set — app has no service principal to grant"]}

    # Always use user token for grants — the user needs metastore admin, not the SP.
    # Bypass auth_mode lock intentionally: even if queries are locked to SP mode,
    # the grant operation must run as the human user who has the privileges.
    user_token = _user_token.get()
    host = os.getenv("DATABRICKS_HOST", "")
    if user_token and host:
        w = WorkspaceClient(host=host, token=user_token, auth_type="pat")
    else:
        w = get_workspace_client()

    ok = failed = 0
    errors: list[str] = []

    def _uc_grant(securable_type: SecurableType, full_name: str, *privileges: str):
        nonlocal ok, failed
        try:
            priv_values = [_PRIV_MAP[p].value for p in privileges if p in _PRIV_MAP]
            # Use raw REST API instead of w.grants.update() to avoid the Databricks SDK
            # "unable to parse response" bug — the UC grants PATCH returns a minimal body
            # that the SDK fails to deserialize even on success.
            w.api_client.do(
                "PATCH",
                f"/api/2.1/unity-catalog/permissions/{securable_type.value}/{full_name}",
                body={"changes": [{"principal": sp_client_id, "add": priv_values}]},
            )
            ok += 1
            logger.info(f"Granted {privileges} on {securable_type.value}/{full_name} to {sp_client_id}")
        except Exception as e:
            err = str(e).lower()
            if "already" in err or "not found" in err or "does not exist" in err:
                ok += 1
                logger.debug(f"Grant already applied for {full_name}: {e}")
            else:
                logger.warning(
                    f"UC grant failed — {type(e).__name__} on {securable_type.value}/{full_name} "
                    f"for principal {sp_client_id}: {e}"
                )
                errors.append(f"{securable_type.value}/{full_name}: {e}")
                failed += 1

    # System catalog + schemas + tables
    _uc_grant(SecurableType.CATALOG, "system", "USE CATALOG")
    for _, obj_type, obj_name in SYSTEM_TABLE_GRANTS:
        if obj_type == "SCHEMA":
            _uc_grant(SecurableType.SCHEMA, obj_name, "USE SCHEMA")
        elif obj_type == "TABLE":
            _uc_grant(SecurableType.TABLE, obj_name, "SELECT")

    # App catalog + schema
    _uc_grant(SecurableType.CATALOG, catalog, "USE CATALOG")
    _uc_grant(SecurableType.SCHEMA, f"{catalog}.{schema}",
              "USE SCHEMA", "CREATE TABLE", "SELECT")

    logger.info(f"SP grants via SDK API: {ok} ok, {failed} failed for {sp_client_id}")

    # Grant CAN_USE on the SQL warehouse via REST API (not SQL — works even
    # when the SP has no warehouse access yet, making it self-healing on redeploy)
    _grant_warehouse_can_use(w, sp_client_id)

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
    """Check the status of materialized views.

    If tables are missing and a user OAuth token is present (git-deploy / first load),
    automatically kick off table creation in a background thread using the user's
    token — no wizard interaction required. Returns status='initializing' in that case.
    """
    import asyncio as _asyncio
    catalog, schema = get_catalog_schema()
    # Run the blocking SDK call (tables.list) in a thread executor so it doesn't
    # block the async event loop — the frontend polls this every few seconds.
    loop = _asyncio.get_running_loop()
    tables = await loop.run_in_executor(None, check_materialized_views_exist, catalog, schema)

    all_exist = all(tables.values())
    missing = [name for name, exists in tables.items() if not exists]

    if not all_exist:
        # If bootstrap is already running (started by a prior request), keep returning
        # "initializing" so the frontend continues polling instead of showing the wizard.
        if _create_task_state["status"] == "running":
            import time as _time
            started = _create_task_state.get("started_at") or _time.monotonic()
            elapsed = int(_time.monotonic() - started)
            _create_task_state["elapsed_seconds"] = elapsed
            # Auto-fail after timeout so the wizard shows instead of spinning forever
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
                    "tables": tables,
                    "all_tables_exist": False,
                    "missing_tables": missing,
                    "status": "initializing",
                    "task": _create_task_state.copy(),
                }

        # If bootstrap previously errored or "done" but tables still missing,
        # fall through to setup_required so the wizard shows instead of looping forever.
        if _create_task_state["status"] in ("error", "done"):
            return {
                "catalog": catalog,
                "schema": schema,
                "tables": tables,
                "all_tables_exist": False,
                "missing_tables": missing,
                "status": "setup_required",
                "task": _create_task_state.copy(),
            }

        # Auto-bootstrap: tables missing + user OAuth active + not already creating
        user_token = _db_user_token.get()
        if user_token:
            import threading, time as _time
            _create_task_state["status"] = "running"
            _create_task_state["error"] = None
            _create_task_state["started_at"] = _time.monotonic()
            _create_task_state["elapsed_seconds"] = 0
            _token_snap = user_token
            _catalog_snap = catalog
            _schema_snap = schema

            def _auto_bootstrap():
                tok = _db_user_token.set(_token_snap)
                try:
                    logger.info("Auto-bootstrapping materialized views with user OAuth token...")
                    results = create_materialized_views(_catalog_snap, _schema_snap)
                    errors = {k: v for k, v in results.items() if isinstance(v, str) and v.startswith("error:")}
                    if errors:
                        first_err = next(iter(errors.values()))
                        _create_task_state["status"] = "error"
                        _create_task_state["error"] = first_err.replace("error: ", "", 1)
                        logger.error(f"Auto-bootstrap failed: {first_err}")
                    else:
                        _create_task_state["status"] = "done"
                        _create_task_state["error"] = None
                        logger.info("Auto-bootstrap complete — granting SP schema access")
                        _grant_sp_schema_access(_catalog_snap, _schema_snap)
                except Exception as exc:
                    _create_task_state["status"] = "error"
                    _create_task_state["error"] = str(exc)
                    logger.error(f"Auto-bootstrap exception: {exc}")
                finally:
                    _db_user_token.reset(tok)

            threading.Thread(target=_auto_bootstrap, daemon=True).start()
            return {
                "catalog": catalog,
                "schema": schema,
                "tables": tables,
                "all_tables_exist": False,
                "missing_tables": missing,
                "status": "initializing",
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
    Tables are created with 365 days of historical data.

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
    """Background task to create tables (wizard path).

    Runs as the user (not the SP) so CREATE SCHEMA and CREATE TABLE succeed
    on fresh deployments where the SP has no grants yet.
    """
    logger.info(f"Starting background table creation for {catalog}.{schema}")
    tok = _db_user_token.set(user_token) if user_token else None
    try:
        results = create_materialized_views(catalog, schema)
        logger.info(f"Table creation completed: {results}")

        errors = {k: v for k, v in results.items() if isinstance(v, str) and v.startswith("error:")}
        if errors:
            first_error = next(iter(errors.values()))
            _create_task_state["status"] = "error"
            _create_task_state["error"] = first_error.replace("error: ", "", 1)
        else:
            _create_task_state["status"] = "done"
            _create_task_state["error"] = None
            _grant_sp_schema_access(catalog, schema)
    except Exception as e:
        _create_task_state["status"] = "error"
        _create_task_state["error"] = str(e)
        logger.error(f"Table creation failed: {e}")
    finally:
        if tok is not None:
            _db_user_token.reset(tok)


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
    """
    from server.db import execute_query, _user_token
    source, warehouse_id = _resolve_warehouse_config()
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
    """Return a WarehouseCheckResult via cache → single-flight → timeout."""
    from concurrent.futures import TimeoutError as _FutureTimeout
    source, _ = _resolve_warehouse_config()
    if source == "none":
        return WarehouseCheckResult(
            status=CheckStatus.NOT_CONFIGURED,
            ok=False,
            message="No warehouse configured",
            source="none",
        )
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
    """Return all workspaces with billing activity for the setup wizard workspace picker."""
    from server.db import execute_query
    try:
        rows = execute_query("""
            SELECT
                CAST(u.workspace_id AS STRING) as workspace_id,
                COALESCE(ws.workspace_name, CAST(u.workspace_id AS STRING)) as workspace_name,
                SUM(u.usage_quantity) as total_dbus
            FROM system.billing.usage u
            LEFT JOIN system.access.workspaces_latest ws ON u.workspace_id = ws.workspace_id
            WHERE u.usage_date >= CURRENT_DATE - 90
              AND u.usage_quantity > 0
              AND u.workspace_id IS NOT NULL
            GROUP BY u.workspace_id, ws.workspace_name
            HAVING workspace_id IS NOT NULL AND workspace_id != ''
            ORDER BY total_dbus DESC
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
