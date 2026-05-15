"""Debugger endpoint — parallel health checks for common deployment issues."""

import logging
import os

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

router = APIRouter()
logger = logging.getLogger(__name__)

_CHECK_TIMEOUT = 25  # seconds per individual check


# ── Individual check functions ────────────────────────────────────────────────

def _check_billing_usage() -> dict:
    try:
        from server.db import execute_query
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.billing.usage LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {
                "status": "warn",
                "detail": "system.billing.usage is accessible but has no rows",
                "fix": "Billing data may take 24–48h after workspace creation. Verify your account has active workloads.",
            }
        return {"status": "pass", "detail": f"{cnt:,} rows accessible"}
    except Exception as e:
        err = str(e)
        if "PERMISSION_DENIED" in err or "permission" in err.lower() or "AnalysisException" in err:
            fix = (
                "Grant access to the app identity:\n"
                "  GRANT USE CATALOG ON CATALOG system TO `<identity>`;\n"
                "  GRANT USE SCHEMA ON SCHEMA system.billing TO `<identity>`;\n"
                "  GRANT SELECT ON TABLE system.billing.usage TO `<identity>`"
            )
        else:
            fix = "Check that the SQL warehouse is running and the app identity has SELECT on system.billing.usage"
        return {"status": "fail", "detail": err[:250], "fix": fix}


def _check_list_prices() -> dict:
    try:
        from server.db import execute_query
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.billing.list_prices LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        status = "pass" if cnt > 0 else "warn"
        detail = f"{cnt:,} rows accessible" if cnt > 0 else "Table accessible but empty — cost calculations may show $0"
        return {"status": status, "detail": detail, "fix": "Grant SELECT on system.billing.list_prices to the app identity" if cnt == 0 else ""}
    except Exception as e:
        return {
            "status": "fail",
            "detail": str(e)[:250],
            "fix": "Grant SELECT on system.billing.list_prices to the app identity",
        }


def _check_query_history() -> dict:
    try:
        from server.db import execute_query
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.query.history LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        status = "pass" if cnt > 0 else "warn"
        return {"status": status, "detail": f"{cnt:,} rows accessible"}
    except Exception as e:
        return {
            "status": "fail",
            "detail": str(e)[:250],
            "fix": "Grant USE SCHEMA on system.query and SELECT on system.query.history to the app identity. SQL tab data depends on this.",
        }


def _check_workspaces_table() -> dict:
    try:
        from server.db import execute_query
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.access.workspaces_latest LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        status = "pass" if cnt > 0 else "warn"
        detail = f"{cnt:,} rows accessible — workspace names resolve correctly" if cnt > 0 else "Table accessible but empty"
        return {"status": status, "detail": detail}
    except Exception as e:
        return {
            "status": "warn",
            "detail": f"system.access.workspaces_latest not accessible: {str(e)[:150]}",
            "fix": (
                "Enable the system.access schema via Databricks CLI:\n"
                "  databricks unity-catalog system-schemas enable --schema access\n"
                "Workspace names will display as IDs until enabled. Non-critical."
            ),
        }


def _check_mv_existence() -> dict:
    from server.materialized_views import _MV_TABLES
    from server.db import get_catalog_schema, get_workspace_client

    catalog, schema = get_catalog_schema()
    try:
        wc = get_workspace_client()
        existing = {t.name for t in wc.tables.list(catalog_name=catalog, schema_name=schema)}
    except Exception as e:
        return {
            "status": "fail",
            "detail": f"Could not list tables in {catalog}.{schema}: {e}",
            "fix": "Verify the app identity has USE CATALOG and USE SCHEMA on the app catalog/schema",
        }

    missing = [t for t in _MV_TABLES if t not in existing]
    if not missing:
        return {"status": "pass", "detail": f"All {len(_MV_TABLES)} materialized view tables present in {catalog}.{schema}"}
    return {
        "status": "fail",
        "detail": f"Missing: {', '.join(missing)}",
        "fix": "Click 'Rebuild Materialized Views' below. This is the most common cause of zeros across the entire dashboard.",
        "missing_tables": missing,
    }


def _check_mv_populated() -> dict:
    try:
        from server.db import execute_query, get_catalog_schema
        catalog, schema = get_catalog_schema()
        result = execute_query(
            f"SELECT COUNT(*) AS cnt, MAX(usage_date) AS latest "
            f"FROM {catalog}.{schema}.daily_usage_summary LIMIT 1",
            None, no_cache=True
        )
        row = (result or [{}])[0]
        cnt = int(row.get("cnt", 0))
        latest = row.get("latest")
        if cnt == 0:
            return {
                "status": "fail",
                "detail": "daily_usage_summary exists but has no rows",
                "fix": "The MV tables were created but the ETL did not complete. Click 'Rebuild Materialized Views' below.",
            }
        return {"status": "pass", "detail": f"{cnt:,} rows, latest usage_date: {latest}"}
    except Exception as e:
        return {
            "status": "warn",
            "detail": f"Could not query daily_usage_summary: {str(e)[:200]}",
            "fix": "Rebuild materialized views if they were recently dropped or are missing",
        }


def _check_recent_billing_data() -> dict:
    try:
        from server.db import execute_query
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.billing.usage "
            "WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30) LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {
                "status": "warn",
                "detail": "No billing rows in the last 30 days — dashboard will show $0 for default date range",
                "fix": (
                    "Billing data has a 24–48h lag. If the workspace is new, wait 48h.\n"
                    "Also verify active workloads exist. Try extending the date range back further."
                ),
            }
        return {"status": "pass", "detail": f"{cnt:,} billing rows in the last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Could not check recent data: {str(e)[:200]}"}


def _check_warehouse_configured() -> dict:
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    if not http_path or http_path == "auto":
        return {
            "status": "warn",
            "detail": "DATABRICKS_HTTP_PATH not set — app will auto-create a warehouse on startup",
            "fix": "Set DATABRICKS_HTTP_PATH in the Databricks App configuration for a specific warehouse (avoids cold-start delay)",
        }
    wh_id = http_path.split("/")[-1] if "/" in http_path else http_path
    try:
        from server.db import get_workspace_client
        wc = get_workspace_client()
        wh = wc.warehouses.get(wh_id)
        state = str(wh.state or "").upper()
        if state == "RUNNING":
            return {"status": "pass", "detail": f"Warehouse '{wh.name}' ({wh.cluster_size}) is running"}
        return {
            "status": "warn",
            "detail": f"Warehouse '{wh.name}' ({wh.cluster_size}) is {state} — first query will start it",
        }
    except Exception as e:
        return {"status": "warn", "detail": f"Warehouse {wh_id} configured but could not verify: {e}"}


def _check_sp_identity() -> dict:
    client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
    if not client_id:
        return {
            "status": "warn",
            "detail": "DATABRICKS_CLIENT_ID not set — app runs as the deploying user identity, not a dedicated service principal",
            "fix": "Set DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET in App config for a dedicated SP. Required for scheduled MV refreshes.",
        }
    client_secret = os.getenv("DATABRICKS_CLIENT_SECRET", "")
    if not client_secret:
        return {
            "status": "warn",
            "detail": f"SP client_id is set ({client_id}) but DATABRICKS_CLIENT_SECRET is missing",
            "fix": "Set DATABRICKS_CLIENT_SECRET in the App configuration",
        }
    return {"status": "pass", "detail": f"Service principal configured: {client_id}"}


def _check_workspace_pool() -> dict:
    import json
    settings_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
    settings_path = os.path.join(settings_dir, "workspace_filter.json")
    try:
        with open(settings_path) as f:
            data = json.load(f)
        ws_ids = data.get("workspace_ids", [])
        if ws_ids:
            return {"status": "pass", "detail": f"Workspace pool: {len(ws_ids)} workspace(s) configured"}
        return {"status": "pass", "detail": "No workspace pool configured — all workspaces visible in the filter dropdown"}
    except FileNotFoundError:
        return {"status": "pass", "detail": "No workspace pool configured — all workspaces visible in the filter dropdown"}
    except Exception as e:
        return {"status": "warn", "detail": f"Could not read workspace_filter.json: {e}"}


# Ordered check registry
_CHECKS = [
    {"id": "sp_identity",        "category": "configuration",      "label": "Service principal identity",              "fn": _check_sp_identity},
    {"id": "warehouse",          "category": "configuration",      "label": "SQL warehouse configured",                "fn": _check_warehouse_configured},
    {"id": "workspace_pool",     "category": "configuration",      "label": "Workspace filter pool",                   "fn": _check_workspace_pool},
    {"id": "billing_usage",      "category": "permissions",        "label": "system.billing.usage access",             "fn": _check_billing_usage},
    {"id": "list_prices",        "category": "permissions",        "label": "system.billing.list_prices access",       "fn": _check_list_prices},
    {"id": "query_history",      "category": "permissions",        "label": "system.query.history access",             "fn": _check_query_history},
    {"id": "workspaces_table",   "category": "permissions",        "label": "system.access.workspaces_latest access",  "fn": _check_workspaces_table},
    {"id": "mv_existence",       "category": "materialized_views", "label": "Materialized view tables exist",          "fn": _check_mv_existence},
    {"id": "mv_populated",       "category": "materialized_views", "label": "Materialized views have data",            "fn": _check_mv_populated},
    {"id": "recent_billing_data","category": "data",               "label": "Recent billing data (last 30 days)",      "fn": _check_recent_billing_data},
]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/run")
async def run_diagnostics() -> dict:
    """Run all diagnostic checks in parallel and return structured results."""
    import asyncio

    loop = asyncio.get_event_loop()

    async def _run_one(check: dict) -> dict:
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, check["fn"]),
                timeout=_CHECK_TIMEOUT,
            )
        except asyncio.TimeoutError:
            result = {"status": "warn", "detail": f"Check timed out after {_CHECK_TIMEOUT}s"}
        except Exception as exc:
            result = {"status": "fail", "detail": f"Unexpected error: {exc}"}

        return {
            "id": check["id"],
            "category": check["category"],
            "label": check["label"],
            "status": result.get("status", "fail"),
            "detail": result.get("detail", ""),
            "fix": result.get("fix", ""),
            **{k: v for k, v in result.items() if k not in ("status", "detail", "fix")},
        }

    results = list(await asyncio.gather(*[_run_one(c) for c in _CHECKS]))

    passed = sum(1 for r in results if r["status"] == "pass")
    failed = sum(1 for r in results if r["status"] == "fail")
    warned = sum(1 for r in results if r["status"] == "warn")

    return {
        "checks": results,
        "summary": {"passed": passed, "failed": failed, "warned": warned, "total": len(results)},
    }


@router.post("/rebuild-mvs")
async def rebuild_mvs(background_tasks: BackgroundTasks, request: Request) -> dict:
    """Trigger a full MV rebuild in the background. Admin only."""
    from server.routers.user import _get_user_role
    user_email = request.headers.get("X-Forwarded-Email", os.getenv("USER", ""))
    if _get_user_role(user_email) != "admin":
        raise HTTPException(status_code=403, detail="Admin access required to rebuild materialized views")

    from server.db import _user_token as _db_user_token, get_catalog_schema
    from server.materialized_views import refresh_materialized_views

    user_token = _db_user_token.get()
    catalog, schema = get_catalog_schema()

    def _do_rebuild():
        import contextlib
        ctx_tok = None
        try:
            if user_token:
                ctx_tok = _db_user_token.set(user_token)
            logger.info("Debugger-triggered MV rebuild starting for %s.%s", catalog, schema)
            results = refresh_materialized_views(catalog, schema)
            failed = [k for k, v in results.items() if isinstance(v, str) and v.startswith("error:")]
            if failed:
                logger.error("Debugger MV rebuild: %d tables failed: %s", len(failed), failed)
            else:
                logger.info("Debugger MV rebuild complete")
            # Invalidate caches
            with contextlib.suppress(Exception):
                from server.routers.billing import _mv_cache
                _mv_cache["available"] = None
            with contextlib.suppress(Exception):
                from server.db import clear_query_cache
                clear_query_cache()
        except Exception as exc:
            logger.error("Debugger MV rebuild failed: %s", exc)
        finally:
            if ctx_tok is not None:
                _db_user_token.reset(ctx_tok)

    background_tasks.add_task(_do_rebuild)
    return {"status": "started", "message": "MV rebuild started in background — re-run diagnostics in a few minutes to verify"}
