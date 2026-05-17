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
        # SDK returns a State enum — str() gives "State.RUNNING"; check with "in"
        state_str = str(wh.state or "").upper()
        if "RUNNING" in state_str:
            return {"status": "pass", "detail": f"Warehouse '{wh.name}' ({wh.cluster_size}) is running"}
        if "STARTING" in state_str or "RESIZING" in state_str:
            return {"status": "warn", "detail": f"Warehouse '{wh.name}' ({wh.cluster_size}) is starting up — queries will queue briefly"}
        return {
            "status": "warn",
            "detail": f"Warehouse '{wh.name}' ({wh.cluster_size}) is stopped — first query will auto-start it (may take ~30s)",
        }
    except Exception as e:
        return {"status": "warn", "detail": f"Warehouse {wh_id} configured but could not verify state: {e}"}


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


def _check_warehouse_list_access() -> dict:
    """Check that at least one warehouse is visible to list_warehouses — the root cause of 'No warehouses found'."""
    from server.db import get_workspace_client, get_user_workspace_client

    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    configured_id = http_path.split("/")[-1] if http_path and "/" in http_path else None

    user_count = sp_count = 0
    user_error = sp_error = None

    # Test user OAuth token listing
    try:
        user_client = get_user_workspace_client()
        user_whs = list(user_client.warehouses.list())
        user_count = len(user_whs)
    except Exception as e:
        user_error = str(e)[:200]

    # Test SP M2M token listing
    try:
        sp_client = get_workspace_client()
        sp_whs = list(sp_client.warehouses.list())
        sp_count = len(sp_whs)
    except Exception as e:
        sp_error = str(e)[:200]

    # If at least one returns warehouses, the UI will work
    if user_count > 0 or sp_count > 0:
        parts = []
        if user_count > 0:
            parts.append(f"{user_count} via user OAuth")
        if sp_count > 0:
            parts.append(f"{sp_count} via SP")
        return {"status": "pass", "detail": f"Warehouses visible: {', '.join(parts)}"}

    # Both empty — this is the 'No warehouses found' bug
    fix_lines = [
        "The 'No warehouses found' error means neither the user OAuth token nor the",
        "service principal has CAN_USE permission on any SQL warehouse.",
        "",
        "Fix — grant CAN_USE on the app warehouse to the service principal:",
        "  1. In Databricks: SQL Warehouses → select the warehouse → Permissions",
        "  2. Add the SP (client ID or display name) with 'Can use' permission",
        "  3. Alternatively, grant via REST API:",
        f"     PUT /api/2.0/permissions/warehouses/<warehouse-id>",
        f"     Body: {{\"access_control_list\": [{{\"service_principal_name\": \"<SP-client-id>\", \"permission_level\": \"CAN_USE\"}}]}}",
        "",
        "If using User OAuth mode, the end-user also needs CAN_USE on the warehouse.",
    ]
    if configured_id:
        fix_lines.insert(0, f"Configured warehouse ID: {configured_id}")

    detail_parts = ["warehouses.list() returned 0 for both user OAuth and SP tokens"]
    if user_error:
        detail_parts.append(f"user token error: {user_error}")
    if sp_error:
        detail_parts.append(f"SP token error: {sp_error}")

    return {
        "status": "fail",
        "detail": "; ".join(detail_parts),
        "fix": "\n".join(fix_lines),
    }


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


def _check_mv_consistency() -> dict:
    """Cross-check spend totals across core MV tables to catch partial build failures.

    This is the root cause of the 'some tabs show $0, others show real data' pattern:
    some tables built successfully, others timed out or errored during the initial build.
    """
    from server.db import execute_query, get_catalog_schema
    catalog, schema = get_catalog_schema()

    _TABLES = {
        "daily_usage_summary":    f"SELECT COUNT(*) AS cnt, COALESCE(SUM(total_spend),0) AS spend FROM {catalog}.{schema}.daily_usage_summary WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30)",
        "daily_product_breakdown":f"SELECT COUNT(*) AS cnt, COALESCE(SUM(total_spend),0) AS spend FROM {catalog}.{schema}.daily_product_breakdown WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30)",
        "daily_workspace_breakdown":f"SELECT COUNT(*) AS cnt, COALESCE(SUM(total_spend),0) AS spend FROM {catalog}.{schema}.daily_workspace_breakdown WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30)",
    }

    stats: dict = {}
    for tbl, sql in _TABLES.items():
        try:
            row = (execute_query(sql, None, no_cache=True) or [{}])[0]
            stats[tbl] = {"cnt": int(row.get("cnt", 0)), "spend": float(row.get("spend") or 0)}
        except Exception as exc:
            stats[tbl] = {"cnt": -1, "spend": -1, "error": str(exc)[:120]}

    valid = {t: s for t, s in stats.items() if s["cnt"] >= 0}
    max_spend = max((s["spend"] for s in valid.values()), default=0)

    # Tables that exist but are completely empty
    empty = [t for t, s in valid.items() if s["cnt"] == 0]
    # Tables with rows but $0 spend (list_prices was missing when MVs were built)
    zero_spend = [t for t, s in valid.items() if s["cnt"] > 0 and s["spend"] == 0]
    # Errors (table doesn't exist or query failed)
    errored = [t for t, s in stats.items() if s.get("cnt", -1) == -1]

    if not empty and not zero_spend and not errored:
        summary = "; ".join(f"{t.split('_',1)[1]}: {s['cnt']:,}r/${s['spend']:,.0f}" for t, s in valid.items())
        return {
            "status": "pass",
            "detail": f"All core MV tables consistent — {summary}",
            "table_summary": {t: {"rows": s.get("cnt", -1), "spend": round(s.get("spend", 0), 2)} for t, s in stats.items()},
        }

    issues = []
    if empty and max_spend > 0:
        issues.append(f"Partial build failure — empty tables while others have data: {', '.join(empty)}")
    elif empty:
        issues.append(f"Empty tables (no data in last 30 days): {', '.join(empty)}")
    if zero_spend:
        issues.append(f"Rows present but $0 spend (list_prices missing at build time): {', '.join(zero_spend)}")
    if errored:
        issues.append(f"Tables missing or inaccessible: {', '.join(errored)}")

    fix_parts = [
        "This causes the 'some tabs show $0, others show real data' pattern.",
        "Root cause: the initial MV build partially failed — some tables timed out or",
        "errored mid-build while others completed.",
        "",
        "Fix: click 'Rebuild Materialized Views' in this Debugger or the Configuration tab.",
        "The rebuild recreates all tables from scratch and is safe to re-run.",
    ]
    if zero_spend:
        fix_parts += [
            "",
            "If $0 spend persists after rebuild: system.billing.list_prices may have been",
            "empty when the MVs first built. Wait for list_prices to populate then rebuild again.",
        ]

    status = "fail" if (empty and max_spend > 0) or errored else "warn"
    return {
        "status": status,
        "detail": "; ".join(issues),
        "fix": "\n".join(fix_parts),
        "table_summary": {t: {"rows": s.get("cnt", -1), "spend": round(s.get("spend", 0), 2)} for t, s in stats.items()},
    }


# ── Per-tab visualization health checks ──────────────────────────────────────

def _tab_dbu() -> dict:
    from server.db import execute_query, get_catalog_schema
    catalog, schema = get_catalog_schema()
    try:
        result = execute_query(
            f"SELECT COUNT(*) AS cnt, COALESCE(SUM(total_spend), 0) AS spend "
            f"FROM {catalog}.{schema}.daily_usage_summary "
            f"WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30) LIMIT 1",
            None, no_cache=True
        )
        row = (result or [{}])[0]
        cnt, spend = int(row.get("cnt", 0)), float(row.get("spend") or 0)
        if cnt == 0:
            return {"status": "fail", "detail": "No rows in last 30 days — all charts will show $0", "fix": "Rebuild materialized views. Confirm system.billing.usage has recent data."}
        if spend == 0:
            return {"status": "warn", "detail": f"{cnt:,} rows but $0 spend — list_prices may be missing", "fix": "Verify system.billing.list_prices has data (see Permissions section)"}
        return {"status": "pass", "detail": f"${spend:,.0f} spend across {cnt:,} day-workspace rows in last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed: {str(e)[:200]}", "fix": "Verify the app identity has SELECT on the daily_usage_summary materialized view. If the table is missing or schema is stale, rebuild materialized views from the Configuration tab."}


def _tab_kpis() -> dict:
    from server.db import execute_query, get_catalog_schema
    catalog, schema = get_catalog_schema()
    try:
        result = execute_query(
            f"SELECT COUNT(*) AS cnt FROM {catalog}.{schema}.daily_query_stats "
            f"WHERE query_date >= DATE_SUB(CURRENT_DATE(), 30) LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {"status": "warn", "detail": "No query stats rows in last 30 days — KPI metrics relying on query history will show 0", "fix": "Verify system.query.history access and rebuild MVs"}
        return {"status": "pass", "detail": f"{cnt:,} query-stat rows in last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed: {str(e)[:200]}", "fix": "Verify the app identity has SELECT on daily_query_stats. If the column schema looks wrong, rebuild materialized views. Also check that system.query.history access is granted (see Permissions section)."}


def _tab_sql() -> dict:
    from server.db import execute_query, get_catalog_schema
    catalog, schema = get_catalog_schema()
    try:
        r1 = execute_query(
            f"SELECT COUNT(*) AS cnt FROM {catalog}.{schema}.sql_tool_attribution "
            f"WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30) LIMIT 1",
            None, no_cache=True
        )
        r2 = execute_query(
            f"SELECT COUNT(*) AS cnt FROM {catalog}.{schema}.dbsql_cost_per_query "
            f"WHERE query_date >= DATE_SUB(CURRENT_DATE(), 30) LIMIT 1",
            None, no_cache=True
        )
        cnt1 = int((r1 or [{}])[0].get("cnt", 0))
        cnt2 = int((r2 or [{}])[0].get("cnt", 0))
        if cnt1 == 0 and cnt2 == 0:
            return {"status": "warn", "detail": "No SQL attribution or per-query cost data in last 30 days — SQL tab charts will be empty", "fix": "Verify system.query.history access. SQL tab requires active DBSQL warehouse usage."}
        parts = []
        if cnt1 > 0: parts.append(f"{cnt1:,} tool-attribution rows")
        if cnt2 > 0: parts.append(f"{cnt2:,} per-query cost rows")
        return {"status": "pass", "detail": ", ".join(parts) + " in last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed: {str(e)[:200]}", "fix": "Verify the app identity has SELECT on the SQL MV tables (sql_tool_attribution, dbsql_cost_per_query). If the column schema is stale, rebuild materialized views from the Configuration tab."}


def _tab_aiml() -> dict:
    from server.db import execute_query
    try:
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.billing.usage "
            "WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30) "
            "AND (product_category LIKE '%Model Serving%' OR product_category LIKE '%Foundation Model%' "
            "     OR product_category LIKE '%Inference%' OR product_category LIKE '%Vector Search%') LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {"status": "warn", "detail": "No AI/ML usage rows in last 30 days — AIML tab will show $0", "fix": "AIML tab only shows data if your account uses Model Serving, Foundation Model APIs, or Vector Search. This may be expected if those features aren't in use."}
        return {"status": "pass", "detail": f"{cnt:,} AI/ML billing rows in last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed: {str(e)[:200]}", "fix": "Verify the app identity has USE SCHEMA on system.billing and SELECT on system.billing.usage. If the catalog is inaccessible, grant USE CATALOG on the system catalog. See the Permissions section for detailed grant SQL."}


def _tab_apps() -> dict:
    from server.db import execute_query
    try:
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.billing.usage "
            "WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30) "
            "AND product_category LIKE '%Apps%' LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {"status": "warn", "detail": "No Databricks Apps usage rows in last 30 days — Apps tab will show $0", "fix": "Apps tab only shows data if your account runs Databricks Apps. Expected to be empty if Apps aren't deployed."}
        return {"status": "pass", "detail": f"{cnt:,} Apps billing rows in last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed: {str(e)[:200]}", "fix": "Verify the app identity has USE SCHEMA on system.billing and SELECT on system.billing.usage. If the catalog is inaccessible, grant USE CATALOG on the system catalog. See the Permissions section for detailed grant SQL."}


def _tab_tagging() -> dict:
    from server.db import execute_query
    try:
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.compute.clusters "
            "WHERE last_event_time >= DATE_SUB(CURRENT_DATE(), 30) LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {"status": "warn", "detail": "No cluster activity in last 30 days — Tagging tab untagged resource lists will be empty", "fix": "Tagging tab requires system.compute.clusters access and active clusters. Verify the app identity has SELECT on system.compute.clusters."}
        return {"status": "pass", "detail": f"{cnt:,} cluster events in last 30 days — untagged resource analysis available"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed (system.compute.clusters may not be accessible): {str(e)[:200]}", "fix": "Grant SELECT on system.compute.clusters to the app identity"}


def _tab_infra() -> dict:
    from server.db import execute_query
    try:
        # Check for any cloud cost data (AWS/Azure/GCP actual cost tables)
        result = execute_query(
            "SELECT COUNT(*) AS cnt FROM system.billing.usage "
            "WHERE usage_date >= DATE_SUB(CURRENT_DATE(), 30) "
            "AND product_category NOT IN ('All Purpose Compute', 'Jobs Compute', 'SQL', 'DLT') LIMIT 1",
            None, no_cache=True
        )
        cnt = int((result or [{}])[0].get("cnt", 0))
        if cnt == 0:
            return {"status": "warn", "detail": "No infrastructure/cloud cost data found in last 30 days", "fix": "Infra tab shows cloud provider actual costs (AWS CUR, Azure, GCP billing exports). Configure cloud cost exports in the Configuration tab."}
        return {"status": "pass", "detail": f"{cnt:,} infrastructure billing rows in last 30 days"}
    except Exception as e:
        return {"status": "warn", "detail": f"Query failed: {str(e)[:200]}", "fix": "Verify the app identity has USE SCHEMA on system.billing and SELECT on system.billing.usage. If the catalog is inaccessible, grant USE CATALOG on the system catalog. See the Permissions section for detailed grant SQL."}


# Ordered check registry
_CHECKS = [
    {"id": "sp_identity",          "category": "configuration",      "label": "Service principal identity",                      "fn": _check_sp_identity},
    {"id": "warehouse",            "category": "configuration",      "label": "SQL warehouse configured",                        "fn": _check_warehouse_configured},
    {"id": "warehouse_list_access","category": "configuration",      "label": "Warehouse list access (Switch Warehouse UI)",      "fn": _check_warehouse_list_access},
    {"id": "workspace_pool",       "category": "configuration",      "label": "Workspace filter pool",                           "fn": _check_workspace_pool},
    {"id": "billing_usage",        "category": "permissions",        "label": "system.billing.usage access",                     "fn": _check_billing_usage},
    {"id": "list_prices",          "category": "permissions",        "label": "system.billing.list_prices access",               "fn": _check_list_prices},
    {"id": "query_history",        "category": "permissions",        "label": "system.query.history access",                     "fn": _check_query_history},
    {"id": "workspaces_table",     "category": "permissions",        "label": "system.access.workspaces_latest access",          "fn": _check_workspaces_table},
    {"id": "mv_existence",         "category": "materialized_views", "label": "Materialized view table presence",                "fn": _check_mv_existence},
    {"id": "mv_populated",         "category": "materialized_views", "label": "Materialized view data availability",             "fn": _check_mv_populated},
    {"id": "mv_consistency",       "category": "materialized_views", "label": "MV table spend consistency (partial-zeros check)", "fn": _check_mv_consistency},
    {"id": "recent_billing_data",  "category": "data",               "label": "Recent billing data (last 30 days)",              "fn": _check_recent_billing_data},
    {"id": "tab_dbu",            "category": "tab_health",         "label": "DBU & Billing tab",                       "fn": _tab_dbu},
    {"id": "tab_kpis",           "category": "tab_health",         "label": "Platform KPIs tab",                       "fn": _tab_kpis},
    {"id": "tab_sql",            "category": "tab_health",         "label": "SQL Warehousing tab",                     "fn": _tab_sql},
    {"id": "tab_aiml",           "category": "tab_health",         "label": "AI/ML tab",                               "fn": _tab_aiml},
    {"id": "tab_apps",           "category": "tab_health",         "label": "Apps tab",                                "fn": _tab_apps},
    {"id": "tab_tagging",        "category": "tab_health",         "label": "Tagging tab",                             "fn": _tab_tagging},
    {"id": "tab_infra",          "category": "tab_health",         "label": "Infrastructure (Cloud Costs) tab",        "fn": _tab_infra},
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
