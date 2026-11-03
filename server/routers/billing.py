"""Billing API endpoints for cost observability."""

import asyncio
import logging
import os
import re
import threading
import time
from typing import Any

from cachetools import TTLCache
from fastapi import APIRouter, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from server import cache_ttls
from server.cloud_pricing import (
    get_cloud_display_name,
    get_instance_family,
)
from server.db import (
    BundleOverloadedError,
    SourceScopeUnsupportedError,
    SQLExecutionError,
    apply_mv_overrides,
    bundle_cache_key,
    bundle_compute_is_pending,
    capture_cache_generation,
    delta_cache_get,
    delta_cache_put,
    execute_queries_parallel,
    get_catalog_schema,
    get_current_workspace_id,
    get_host_url,
    get_local_source_label,
    get_workspace_client,
    recover_optional_bundle_queries,
    selected_source_labels,
    source_label_filter_clause,
    start_bundle_compute,
)
from server.db import (
    execute_query as _execute_query,
)
from server.materialized_views import (
    MV_BILLING_BY_PRODUCT,
    MV_BILLING_BY_WORKSPACE_BASIC,
    MV_BILLING_SUMMARY,
    MV_BILLING_TIMESERIES,
    MV_BILLING_TOTAL_TIMESERIES,
    MV_ETL_BREAKDOWN,
    MV_PLATFORM_KPIS,
    MV_SQL_TOOL_ATTRIBUTION,
    check_materialized_views_exist,
)
from server.queries import (
    ACCOUNT_INFO,
    AVG_DAILY_MODELS,
    AVG_DAILY_QUERY_USERS_MV,
    AVG_DAILY_WORKSPACES,
    AWS_COST_BY_INSTANCE_TYPE,
    BILLING_BY_PRODUCT,
    BILLING_BY_PRODUCT_FAST,
    BILLING_BY_PRODUCT_WORKSPACE,
    BILLING_BY_WORKSPACE,
    BILLING_KPIS_FAST,
    BILLING_SUMMARY,
    BILLING_TIMESERIES,
    BILLING_TIMESERIES_FAST,
    ETL_BREAKDOWN,
    INFRA_COST_ESTIMATE,
    INFRA_COST_TIMESERIES,
    INTERACTIVE_BREAKDOWN,
    LAKEFLOW_JOB_STATS,
    PIPELINE_OBJECTS,
    PLATFORM_KPIS,
    PLATFORM_KPIS_FAST,
    SKU_BREAKDOWN,
    SPEND_ANOMALIES,
    SQL_TOOL_ATTRIBUTION,
    TOTAL_WORKSPACES_ALLTIME,
)
from server.queries.pricing import apply_current_list_price_join
from server.request_limits import default_date_range, parse_workspace_ids, validate_date_range
from server.workspace_filter import EMPTY_WORKSPACE_SCOPE_ID

router = APIRouter()
logger = logging.getLogger(__name__)


def execute_query(sql: str, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    """Execute billing SQL after expanding the compatible current-price marker."""
    return _execute_query(apply_current_list_price_join(sql), *args, **kwargs)

# Stale fallback: stores the last successful non-zero kpis_response per exact
# date/workspace/source scope so one source selection can never leak into another.
_kpis_stale: TTLCache = TTLCache(maxsize=500, ttl=cache_ttls.STALE_KPI)
_cloud_bundle_failures: TTLCache = TTLCache(maxsize=100, ttl=2)
_cloud_bundle_failures_lock = threading.Lock()
_CLOUD_FAILURE_MESSAGES = {
    "SQL_OVERLOADED": "Cloud cost data is busy. Wait a moment and retry.",
    "BUNDLE_OVERLOADED": "Cloud cost data is busy. Wait a moment and retry.",
    "SQL_TIMEOUT": "Cloud cost data took too long to load. Retry shortly.",
    "SQL_EXECUTION_ERROR": (
        "Cloud cost data is temporarily unavailable. Retry shortly."
    ),
    "CLOUD_BUNDLE_FAILED": (
        "Cloud cost data is temporarily unavailable. Retry shortly."
    ),
}

_OPTIONAL_BREAKDOWN_COPY = {
    "sku": "SKU detail is temporarily unavailable. The rest of DBU Overview is still available.",
    "pipeline": "Jobs and pipeline detail is temporarily unavailable. The rest of DBU Overview is still available.",
    "interactive": "Interactive compute detail is temporarily unavailable. The rest of DBU Overview is still available.",
}


def _optional_breakdown_unavailable(
    kind: str,
    collection: str,
    params: dict[str, Any],
    exc: Exception,
) -> dict[str, Any]:
    """Return a safe, settled 200 contract for non-critical DBU detail."""
    code = str(getattr(exc, "code", "QUERY_FAILED"))
    source_unsupported = code == "SOURCE_SCOPE_UNSUPPORTED"
    reason = (
        "shared_scope_unsupported"
        if source_unsupported
        else "query_timeout" if code == "SQL_TIMEOUT" else "query_failed"
    )
    logger.warning("%s breakdown unavailable (%s): %s", kind, code, exc)
    return {
        "available": False,
        "availability": "unavailable",
        "retryable": not source_unsupported,
        "reason": reason,
        "reason_detail": (
            f"The selected shared source does not publish {kind} detail."
            if source_unsupported
            else _OPTIONAL_BREAKDOWN_COPY[kind]
        ),
        "error_code": code,
        collection: [],
        "total_spend": None,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _safe_cloud_failure(
    exc: BaseException,
    *,
    request_id: str,
) -> dict[str, Any]:
    raw_code = str(getattr(exc, "code", "CLOUD_BUNDLE_FAILED")).upper()
    error_code = (
        raw_code if raw_code in _CLOUD_FAILURE_MESSAGES else "CLOUD_BUNDLE_FAILED"
    )
    return {
        "message": _CLOUD_FAILURE_MESSAGES[error_code],
        "error_code": error_code,
        "retryable": True,
        "request_id": request_id,
    }


def _run_bundle_parallel(
    queries: list[tuple[str, Any]],
    *,
    required: set[str],
    timeout: float,
) -> tuple[dict[str, Any], dict[str, str]]:
    ordered = [
        *[(name, call) for name, call in queries if name in required],
        *[(name, call) for name, call in queries if name not in required],
    ]
    try:
        return execute_queries_parallel(ordered, timeout=timeout), {}
    except SQLExecutionError as exc:
        return recover_optional_bundle_queries(exc, required)


def _kpis_stale_key(
    start_date: str,
    end_date: str,
    workspace_ids: list[str] | None,
    source_labels: list[str],
) -> str:
    """Canonical key for last-known-good KPI fallbacks."""
    workspace_scope = ",".join(sorted(workspace_ids or []))
    source_scope = ",".join(sorted(set(source_labels)))
    return f"{start_date}/{end_date}/{workspace_scope}/{source_scope}"


def _ensure_list(val: Any) -> list:
    """Convert COLLECT_LIST results to a proper Python list.

    Databricks COLLECT_LIST may return Java arrays or stringified arrays
    that don't serialize to JSON properly.
    """
    if val is None:
        return []
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        import json
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
        # Try comma-separated string
        stripped = val.strip("[]")
        if stripped:
            return [s.strip().strip("'\"") for s in stripped.split(",")]
        return []
    # Try converting iterable types (Java arrays, etc.)
    try:
        return list(val)
    except (TypeError, ValueError):
        return []

# Cache for MV availability check — re-check after 30 min once confirmed available.
# MVs don't disappear except during an explicit rebuild; 5-min polling was wasteful.
_mv_cache: dict[str, Any] = {"available": None, "checked_at": 0}
_MV_CHECK_INTERVAL = 1800  # 30 minutes


def _check_mv_available() -> bool:
    """Check if materialized views are available (with caching).

    Runs the SQL check in a thread with a 30-second timeout so a slow or
    starting warehouse never blocks a bundle endpoint indefinitely.
    """
    def _result(available: bool) -> bool:
        if selected_source_labels() and not available:
            raise RuntimeError(
                "Selected shared sources require managed tables and verified unified views."
            )
        return available

    now = time.time()
    if _mv_cache["available"] is not None and (now - _mv_cache["checked_at"]) < _MV_CHECK_INTERVAL:
        return _result(_mv_cache["available"])

    import threading
    from concurrent.futures import Future
    from concurrent.futures import wait as _cfwait

    def _check():
        catalog, schema = get_catalog_schema()
        tables = check_materialized_views_exist(catalog, schema)
        core_tables = ["daily_usage_summary", "daily_product_breakdown", "daily_workspace_breakdown"]
        return all(tables.get(t, False) for t in core_tables)

    future: Future = Future()

    def _daemon_run(f=future, fn=_check):
        try:
            f.set_result(fn())
        except Exception as e:
            f.set_exception(e)

    threading.Thread(target=_daemon_run, daemon=True, name="sql-mv-check").start()
    done, _ = _cfwait([future], timeout=30.0)
    if not done:
        # Don't lock out MVs for 30 min on a transient timeout (e.g. cold SDK init after
        # restart). Cache the negative result for only 15s so the next request retries.
        logger.debug("MV availability check timed out after 30s — retrying in 15s")
        _mv_cache["available"] = False
        _mv_cache["checked_at"] = now - (_MV_CHECK_INTERVAL - 15)
        return _result(False)
    try:
        available = future.result()
        _mv_cache["available"] = available
        _mv_cache["checked_at"] = now
        if available:
            logger.info("Materialized views available - using optimized queries")
        return _result(available)
    except Exception as e:
        # Treat exceptions the same as timeouts: retry in 15s, not 30 min.
        # A transient SDK error on startup should not lock out MVs for half an hour.
        logger.debug("MV check failed (retrying in 15s): %s", e)
        _mv_cache["available"] = False
        _mv_cache["checked_at"] = now - (_MV_CHECK_INTERVAL - 15)
        return _result(False)


def _get_mv_query(mv_query: str, ws_filter: str = "") -> str:
    """Format a materialized view query with the correct catalog/schema and apply table overrides.

    The active source-label selection (if any) is appended into the same
    `{ws_filter}` slot the workspace filter uses, so MV reads against the unified
    views are narrowed to the chosen sources. No-op when nothing is selected or
    no additional sources are configured.
    """
    from server.db import apply_mv_overrides, source_label_filter_clause
    catalog, schema = get_catalog_schema()
    sql = mv_query.format(
        catalog=catalog,
        schema=schema,
        ws_filter=ws_filter + source_label_filter_clause(mv_query),
    )
    return apply_mv_overrides(sql, catalog, schema)


def _exec_mv(
    mv_template: str,
    params: dict,
    ws_filter: str = "",
    *,
    timeout: float | None = None,
) -> list[dict]:
    """Execute a materialized view query against Delta."""
    return execute_query(_get_mv_query(mv_template, ws_filter), params, timeout=timeout)


def _pool_scoped(sql: str, id_list: list[str] | None = None) -> str:
    """Scope live billing SQL (``u.`` alias) to the saved pool, narrowed by ``id_list``."""
    from server import workspace_filter as wf
    return _inject_ws_filter(sql, wf.build_ws_filter_clause(id_list=id_list))


def _mv_ws_clause(id_list: list[str] | None) -> str:
    """Build a workspace filter clause for MV queries (plain workspace_id column, no table alias)."""
    from server import workspace_filter as wf
    return wf.build_ws_filter_clause(col="workspace_id", id_list=id_list)


def _local_source_selected() -> bool:
    """Whether local-only system tables belong to the requested source scope."""
    labels = selected_source_labels()
    return not labels or get_local_source_label() in labels


def get_workspace_name() -> str | None:
    """Get workspace name from Databricks SDK."""
    try:
        w = get_workspace_client()
        host = w.config.host or ""
        if host:
            # Extract workspace name from host
            # e.g., https://e2-demo-field-eng.cloud.databricks.com
            parts = host.replace("https://", "").replace("http://", "").split(".")
            if parts:
                return parts[0]
        return None
    except Exception:
        return None


@router.get("/account")
async def get_account_info() -> dict[str, Any]:
    """Get account information — returns instantly from host URL, no SQL query needed."""
    result: dict[str, Any] = {
        "account_id": None,
        "account_name": None,
        "workspace_id": get_current_workspace_id() or None,
        "cloud": None,
        "host": None,
    }
    configured_name = os.environ.get("DATABRICKS_ACCOUNT_NAME", "").strip()
    if configured_name:
        result["account_name"] = configured_name

    # Instant: detect everything from host URL
    host = get_host_url()
    if host:
        result["host"] = host
        parts = host.replace("https://", "").replace("http://", "").split(".")
        if parts and not result["account_name"]:
            host_label = parts[0].strip()
            # GCP workspace hosts commonly begin with a numeric workspace ID.
            # That identifier must never be presented as an account display name.
            if host_label and not host_label.isdigit():
                result["account_name"] = host_label
        host_lower = host.lower()
        if "azuredatabricks.net" in host_lower:
            result["cloud"] = "AZURE"
            # Use Azure subscription ID (not available from host URL, set via env)
            result["account_id"] = os.environ.get("AZURE_SUBSCRIPTION_ID", None)
        elif "gcp.databricks.com" in host_lower:
            result["cloud"] = "GCP"
        elif "cloud.databricks.com" in host_lower:
            result["cloud"] = "AWS"

    return result


@router.get("/account-details")
async def get_account_details() -> dict[str, Any]:
    """Get account_id from billing data — may be slow, called separately."""
    try:
        results = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(None, lambda: execute_query(ACCOUNT_INFO)),
            timeout=10.0
        )
        if results:
            row = results[0]
            account_name = os.environ.get("DATABRICKS_ACCOUNT_NAME", "").strip() or None
            if account_name is None:
                workspace_id = os.environ.get("DATABRICKS_WORKSPACE_ID", "").strip()
                if workspace_id:
                    try:
                        account_name = await asyncio.wait_for(
                            asyncio.to_thread(
                                _get_current_workspace_display_label,
                                workspace_id,
                            ),
                            timeout=5.0,
                        )
                    except Exception as exc:
                        logger.debug("Could not resolve account display name: %s", exc)
            return {
                "account_id": row.get("account_id"),
                "account_name": account_name,
                "cloud": row.get("cloud"),
            }
    except Exception as e:
        logger.warning(f"Could not query account details from billing tables: {e}")
    return {"account_id": None, "account_name": None, "cloud": None}


def get_default_start_date() -> str:
    """Get default start date (last 30 days)."""
    return default_date_range()[0]


def get_default_end_date() -> str:
    """Get default end date (last complete UTC day)."""
    return default_date_range()[1]


def _validated_scope(
    start_date: str | None,
    end_date: str | None,
    workspace_ids: str | None = None,
    *,
    resolve_source_scope: bool = True,
) -> tuple[dict[str, str], list[str] | None]:
    validated_start, validated_end = validate_date_range(
        start_date,
        end_date,
        default_start=get_default_start_date(),
        default_end=get_default_end_date(),
    )
    from server import workspace_filter as wf

    id_list = parse_workspace_ids(workspace_ids)
    if resolve_source_scope:
        id_list = wf.resolve_source_workspace_scope(id_list)
    return (
        {"start_date": validated_start, "end_date": validated_end},
        id_list,
    )


@router.get("/summary")
async def get_billing_summary(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
) -> dict[str, Any]:
    """Get overall billing summary (total spend, DBUs, etc.)."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    ws_clause = wf.build_ws_filter_clause(id_list=id_list)
    use_mv = await asyncio.to_thread(_check_mv_available)
    if use_mv:
        results = await asyncio.to_thread(_exec_mv, MV_BILLING_SUMMARY, params, _mv_ws_clause(id_list))
        if not results and not selected_source_labels():
            results = await asyncio.to_thread(execute_query, _inject_ws_filter(BILLING_SUMMARY, ws_clause), params)
    else:
        results = await asyncio.to_thread(execute_query, _inject_ws_filter(BILLING_SUMMARY, ws_clause), params)

    if not results:
        return {
            "total_dbus": 0,
            "total_spend": 0,
            "workspace_count": 0,
            "days_in_range": 0,
            "avg_daily_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    row = results[0]
    days = row.get("days_in_range") or 1
    total_spend = float(row.get("total_spend") or 0)

    return {
        "total_dbus": float(row.get("total_dbus") or 0),
        "total_spend": total_spend,
        "workspace_count": row.get("workspace_count") or 0,
        "days_in_range": days,
        "avg_daily_spend": total_spend / days if days > 0 else 0,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "first_date": str(row.get("first_date")) if row.get("first_date") else None,
        "last_date": str(row.get("last_date")) if row.get("last_date") else None,
    }


@router.get("/by-product")
async def get_billing_by_product(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_id: str = Query(default=None, description="Filter by workspace ID"),
    workspace_ids: str = Query(default=None, description="Validated workspace scope"),
) -> dict[str, Any]:
    """Get billing breakdown by product category."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }
    if not _local_source_selected():
        return {
            "available": False,
            "availability": "unavailable",
            "unavailable_reason": "Product detail is unavailable for the selected shared-only source.",
            "products": [],
            "total_spend": 0,
            **params,
        }

    resolved_workspace_id = workspace_id if isinstance(workspace_id, str) else None
    resolved_workspace_ids = workspace_ids if isinstance(workspace_ids, str) else None
    scoped_ids = parse_workspace_ids(resolved_workspace_ids)
    if scoped_ids and EMPTY_WORKSPACE_SCOPE_ID in scoped_ids:
        return {
            "available": True,
            "availability": "available",
            "products": [],
            "total_spend": 0,
            **params,
        }
    if resolved_workspace_id and scoped_ids is not None and resolved_workspace_id not in scoped_ids:
        return {
            "available": True,
            "availability": "available",
            "products": [],
            "total_spend": 0,
            **params,
        }
    if not resolved_workspace_id and scoped_ids and len(scoped_ids) == 1:
        resolved_workspace_id = scoped_ids[0]

    if resolved_workspace_id:
        # Add workspace filter to the query
        params["workspace_id"] = resolved_workspace_id
        results = await asyncio.to_thread(
            execute_query, _pool_scoped(BILLING_BY_PRODUCT_WORKSPACE, scoped_ids), params
        )
    else:
        results = await asyncio.to_thread(execute_query, _pool_scoped(BILLING_BY_PRODUCT, scoped_ids), params)

    products = []
    total_spend = 0

    for row in (results or []):
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        products.append(
            {
                "category": row.get("product_category"),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "workspace_count": row.get("workspace_count") or 0,
            }
        )

    # Calculate percentages
    for product in products:
        product["percentage"] = (
            (product["total_spend"] / total_spend * 100) if total_spend > 0 else 0
        )

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/by-workspace")
async def get_billing_by_workspace(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get billing breakdown by workspace."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Always use the live query here — the MV lacks top_products and top_users columns.
    results = await asyncio.to_thread(execute_query, _pool_scoped(BILLING_BY_WORKSPACE), params)
    return _format_workspaces(results, params)


@router.get("/timeseries")
async def get_billing_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get daily billing time series by product category."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = await asyncio.to_thread(execute_query, _pool_scoped(BILLING_TIMESERIES), params)

    # Transform to chart-friendly format: [{date, SQL, ETL, Interactive, ...}, ...]
    date_data: dict[str, dict[str, float]] = {}

    for row in (results or []):
        date_str = str(row.get("usage_date"))
        category = row.get("product_category")
        spend = float(row.get("total_spend") or 0)

        if date_str not in date_data:
            date_data[date_str] = {"date": date_str}

        date_data[date_str][category] = spend

    # Convert to list sorted by date
    timeseries = sorted(date_data.values(), key=lambda x: x["date"])

    # Get all categories
    categories = set()
    for row in results:
        categories.add(row.get("product_category"))

    return {
        "timeseries": timeseries,
        "categories": sorted(list(categories)),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/sql-breakdown")
async def get_sql_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None),
) -> dict[str, Any]:
    """Get SQL breakdown by tool (DBSQL vs Genie).

    Uses materialized views when available for fast queries.
    """
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    _dkey = bundle_cache_key("billing:sql-breakdown", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation("billing:sql-breakdown")

    try:
        from server import workspace_filter as wf
        ws_clause = wf.build_ws_filter_clause(id_list=id_list)
        use_mv = await asyncio.to_thread(_check_mv_available)
        if use_mv:
            results = await asyncio.to_thread(_exec_mv, MV_SQL_TOOL_ATTRIBUTION, params, _mv_ws_clause(id_list))
        else:
            results = await asyncio.to_thread(execute_query, _inject_ws_filter(SQL_TOOL_ATTRIBUTION, ws_clause), params)

        products = []
        total_spend = 0

        for row in results:
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            products.append(
                {
                    "product": row.get("sql_product"),
                    "total_dbus": float(row.get("total_dbus") or 0),
                    "total_spend": spend,
                }
            )

        # Calculate percentages
        for product in products:
            product["percentage"] = (
                (product["total_spend"] / total_spend * 100) if total_spend > 0 else 0
            )

        _resp = {
            "available": True,
            "availability": "available",
            "products": products,
            "total_spend": total_spend,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "using_materialized_views": use_mv,
        }
        delta_cache_put(_dkey, "billing:sql-breakdown", _resp, ttl_seconds=cache_ttls.BUNDLE, generation=_cache_generation)
        return _resp
    except Exception as e:
        # If query.history is not available, return empty result
        return {
            "available": False,
            "availability": "unavailable",
            "products": [],
            "total_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": "SQL breakdown is unavailable for the selected scope.",
            "error_code": str(getattr(e, "code", "SQL_BREAKDOWN_FAILED")),
        }


@router.get("/etl-breakdown")
async def get_etl_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get ETL breakdown (Batch vs Streaming)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = await asyncio.to_thread(execute_query, _pool_scoped(ETL_BREAKDOWN), params)

    products = []
    total_spend = 0

    for row in (results or []):
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        products.append(
            {
                "product": row.get("etl_type"),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
            }
        )

    # Calculate percentages
    for product in products:
        product["percentage"] = (
            (product["total_spend"] / total_spend * 100) if total_spend > 0 else 0
        )

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/pipeline-objects")
async def get_pipeline_objects(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
) -> dict[str, Any]:
    """Get spend breakdown by pipeline objects (Jobs and SDP pipelines)."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    if not _local_source_selected():
        return _optional_breakdown_unavailable(
            "pipeline",
            "objects",
            params,
            SourceScopeUnsupportedError("Pipeline detail is local-only."),
        )
    _dkey = bundle_cache_key("billing:pipeline-objects", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation("billing:pipeline-objects")
    ws_clause = wf.build_ws_filter_clause(id_list=id_list)

    try:
        raw = await asyncio.to_thread(
            execute_query,
            _inject_ws_filter(PIPELINE_OBJECTS, ws_clause),
            params,
            timeout=22,
            max_rows=200,
        )
        raw_copy = [dict(r) for r in (raw or [])]
        try:
            results = await asyncio.wait_for(
                asyncio.to_thread(_enrich_pipeline_results, raw_copy),
                timeout=5.0,
            )
        except asyncio.TimeoutError:
            logger.warning("Pipeline name enrichment timed out; serving raw results")
            results = raw

        objects = []
        total_spend = 0

        for row in (results or []):
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            obj_name = row.get("object_name")
            obj_id = row.get("object_id")
            objects.append(
                {
                    "object_type": row.get("object_type"),
                    "object_id": obj_id,
                    "object_name": obj_name,
                    "workspace_id": str(row.get("workspace_id") or ""),
                    "object_state": row.get("object_state"),
                    "owner": row.get("owner"),
                    "total_dbus": float(row.get("total_dbus") or 0),
                    "total_spend": spend,
                    "total_runs": int(row.get("total_runs") or 0),
                }
            )

        # Calculate percentages
        for obj in objects:
            obj["percentage"] = (
                (obj["total_spend"] / total_spend * 100) if total_spend > 0 else 0
            )

        _resp = {
            "available": True,
            "availability": "available",
            "objects": objects,
            "total_spend": total_spend,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
        delta_cache_put(_dkey, "billing:pipeline-objects", _resp, ttl_seconds=cache_ttls.BUNDLE, generation=_cache_generation)
        return _resp
    except Exception as e:
        return _optional_breakdown_unavailable("pipeline", "objects", params, e)


@router.get("/interactive-breakdown")
async def get_interactive_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
) -> dict[str, Any]:
    """Get Interactive compute breakdown by notebook, user, and cluster."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    if not _local_source_selected():
        return _optional_breakdown_unavailable(
            "interactive",
            "items",
            params,
            SourceScopeUnsupportedError("Interactive detail is local-only."),
        )
    _dkey = bundle_cache_key("billing:interactive-breakdown", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation("billing:interactive-breakdown")
    ws_clause = wf.build_ws_filter_clause(id_list=id_list)

    try:
        results = await asyncio.to_thread(
            execute_query,
            _inject_ws_filter(INTERACTIVE_BREAKDOWN, ws_clause),
            params,
            timeout=22,
            max_rows=100,
        )

        items = []
        total_spend = 0

        for row in (results or []):
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            items.append(
                {
                    "cluster_id": row.get("cluster_id"),
                    "cluster_name": row.get("cluster_name"),
                    "notebook_path": row.get("notebook_path"),
                    "user": row.get("run_as_user"),
                    "workspace_id": row.get("workspace_id"),
                    "cluster_state": row.get("cluster_state"),
                    "total_dbus": float(row.get("total_dbus") or 0),
                    "total_spend": spend,
                    "days_active": row.get("days_active") or 0,
                    "notebook_count": row.get("notebook_count") or 0,
                }
            )

        # Calculate percentages
        for item in items:
            item["percentage"] = (
                (item["total_spend"] / total_spend * 100) if total_spend > 0 else 0
            )

        _resp = {
            "available": True,
            "availability": "available",
            "items": items,
            "total_spend": total_spend,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
        delta_cache_put(_dkey, "billing:interactive-breakdown", _resp, ttl_seconds=cache_ttls.BUNDLE, generation=_cache_generation)
        return _resp
    except Exception as e:
        return _optional_breakdown_unavailable("interactive", "items", params, e)


@router.get("/infra-costs")
async def get_infra_costs(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get cluster DBUs and instance metadata.

    Currency estimates are explicitly unavailable without node-hour data.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }
    if not _local_source_selected():
        return {
            "cloud": "UNKNOWN",
            "cloud_display_name": "Cloud",
            "clusters": [],
            "instance_families": [],
            "total_estimated_cost": None,
            "total_databricks_spend": 0,
            "total_dbu_hours": 0,
            "available": False,
            "availability": "unavailable",
            "reason": "shared_scope_unsupported",
            "reason_detail": (
                "Classic infrastructure metadata is local-only and is unavailable "
                "when this workspace is excluded from the selected sources."
            ),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    try:
        # Single query — instance families are derived in Python from cluster results
        cluster_results = await asyncio.to_thread(execute_query, _pool_scoped(INFRA_COST_ESTIMATE), params)

        # Detect cloud from results, fall back to host URL detection
        host = get_host_url()
        cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                cloud = "GCP"
        if cluster_results:
            for row in cluster_results:
                if row.get("cloud"):
                    cloud = row.get("cloud")
                    break

        clusters = []
        detail_databricks_spend = 0.0
        detail_dbu_hours = 0.0
        family_agg: dict[str, dict] = {}

        for row in cluster_results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            driver_type = row.get("driver_instance_type")
            worker_type = row.get("worker_instance_type")

            # DBUs are not node-hours. Without an authoritative node timeline
            # and worker counts, no currency estimate can be derived here.
            estimated_cost = None
            databricks_spend = float(row.get("databricks_spend") or 0)
            detail_databricks_spend += databricks_spend
            detail_dbu_hours += dbu_hours

            clusters.append({
                "cluster_id": row.get("cluster_id"),
                "cluster_name": row.get("cluster_name"),
                "driver_instance_type": driver_type,
                "worker_instance_type": worker_type,
                "cluster_source": row.get("cluster_source"),
                "workspace_id": str(row.get("workspace_id") or ""),
                "workspace_name": row.get("workspace_name"),
                "total_dbu_hours": dbu_hours,
                "databricks_spend": databricks_spend,
                "estimated_cost": estimated_cost,
                "days_active": row.get("days_active") or 0,
            })

            # Aggregate instance families from cluster data — no second query needed
            for itype in [driver_type, worker_type]:
                if itype:
                    family = get_instance_family(itype, cloud)
                    days = row.get("days_active") or 0
                    if family in family_agg:
                        family_agg[family]["total_dbu_hours"] += dbu_hours
                        family_agg[family]["days_active"] = max(family_agg[family]["days_active"], days)
                    else:
                        family_agg[family] = {"instance_family": family, "total_dbu_hours": dbu_hours, "days_active": days}

        aggregate_row = cluster_results[0] if cluster_results else {}
        total_cluster_count = int(
            aggregate_row.get("full_cluster_count") or len(cluster_results)
        )
        total_databricks_spend = float(
            aggregate_row.get("full_databricks_spend")
            if aggregate_row.get("full_databricks_spend") is not None
            else detail_databricks_spend
        )
        total_dbu_hours = float(
            aggregate_row.get("full_total_dbu_hours")
            if aggregate_row.get("full_total_dbu_hours") is not None
            else detail_dbu_hours
        )

        for cluster in clusters:
            cluster["percentage"] = (
                cluster["databricks_spend"] / total_databricks_spend * 100
                if total_databricks_spend > 0
                else 0
            )
        instance_families = sorted(family_agg.values(), key=lambda f: f["total_dbu_hours"], reverse=True)

        return {
            "cloud": cloud,
            "cloud_display_name": get_cloud_display_name(cloud),
            "clusters": clusters,
            "instance_families": instance_families,
            "total_estimated_cost": None,
            "total_databricks_spend": total_databricks_spend,
            "total_dbu_hours": total_dbu_hours,
            "total_cluster_count": total_cluster_count,
            "detail_limit": 100,
            "detail_truncated": total_cluster_count > len(cluster_results),
            "full_first_usage_date": aggregate_row.get("full_first_usage_date"),
            "full_last_usage_date": aggregate_row.get("full_last_usage_date"),
            "currency_estimate_available": False,
            "estimate_unavailable_reason": (
                "Cloud VM cost is unavailable because this deployment has no "
                "granted node-hour and worker-count timeline."
            ),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "disclaimer": (
                "Cluster DBUs and instance metadata are shown. Cloud VM currency "
                "cost requires an actual billing integration or authoritative node-hours."
            ),
        }
    except Exception as e:
        return {
            "cloud": "UNKNOWN",
            "cloud_display_name": "Cloud",
            "clusters": [],
            "instance_families": [],
            "total_estimated_cost": 0,
            "total_databricks_spend": 0,
            "total_dbu_hours": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"Infrastructure cost estimation not available: {str(e)}",
        }


@router.get("/infra-costs-timeseries")
async def get_infra_costs_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get daily cluster DBUs; cloud currency history requires billing exports."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }
    if not _local_source_selected():
        return {
            "cloud": "UNKNOWN",
            "cloud_display_name": "Cloud",
            "timeseries": [],
            "available": False,
            "availability": "unavailable",
            "reason": "shared_scope_unsupported",
            "reason_detail": (
                "Infrastructure history is local-only and unavailable for a shared-only source selection."
            ),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    try:
        results = await asyncio.to_thread(execute_query, _pool_scoped(INFRA_COST_TIMESERIES), params)

        # Detect cloud from host URL, override with billing data if available
        host = get_host_url()
        cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                cloud = "GCP"
        if results:
            for row in results:
                if row.get("cloud"):
                    cloud = row.get("cloud")
                    break

        timeseries = []
        for row in results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            timeseries.append(
                {
                    "date": str(row.get("usage_date")),
                    "total_dbu_hours": dbu_hours,
                }
            )

        return {
            "cloud": cloud,
            "cloud_display_name": get_cloud_display_name(cloud),
            "timeseries": timeseries,
            "currency_estimate_available": False,
            "estimate_unavailable_reason": (
                "Cloud VM cost history is unavailable without authoritative node-hours."
            ),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
    except Exception as e:
        return {
            "cloud": "UNKNOWN",
            "cloud_display_name": "Cloud",
            "timeseries": [],
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"Infrastructure cost timeseries not available: {str(e)}",
        }


def _classify_infra_query_error(error: Exception | str) -> str:
    """Classify an infra query failure without exposing it as a valid zero."""
    message = str(error).upper()
    if any(
        token in message
        for token in (
            "INSUFFICIENT_PERMISSIONS",
            "PERMISSION_DENIED",
            "NOT AUTHORIZED",
            "ACCESS_DENIED",
        )
    ):
        return "permission"
    if any(
        token in message
        for token in (
            "TABLE_OR_VIEW_NOT_FOUND",
            "SCHEMA_NOT_FOUND",
            "UNRESOLVED_COLUMN",
            "SYSTEM.COMPUTE.CLUSTERS",
            "SYSTEM.ACCESS.WORKSPACES_LATEST",
        )
    ):
        return "metadata"
    return "query_failure"


def _run_infra_query(query: str, params: dict[str, Any]) -> dict[str, Any]:
    """Keep query errors structured because the parallel runner otherwise returns None."""
    try:
        return {"rows": execute_query(query, params), "error": None, "error_kind": None}
    except SQLExecutionError:
        raise
    except Exception as exc:
        return {
            "rows": None,
            "error": str(exc),
            "error_kind": _classify_infra_query_error(exc),
        }


def _infra_query_outcome(
    query_results: dict[str, Any], name: str
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Normalize wrapped results, legacy list mocks, and silent None failures."""
    result = query_results.get(name)
    if result is None:
        return [], {
            "available": False,
            "error": f"{name.replace('_', ' ').title()} query did not complete.",
            "error_kind": "query_failure",
            "reason": "timeout_or_worker_failure",
        }
    if isinstance(result, dict) and "rows" in result:
        if result.get("error"):
            return [], {
                "available": False,
                "error": result["error"],
                "error_kind": result.get("error_kind") or "query_failure",
                "reason": "query_failed",
            }
        rows = result.get("rows")
    else:
        rows = result
    return list(rows or []), {
        "available": True,
        "error": None,
        "error_kind": None,
        "reason": None,
    }


def _infra_empty_reason(
    scope_rows: list[dict[str, Any]],
    scope_status: dict[str, Any],
    workspace_filtered: bool,
) -> tuple[str, str]:
    """Explain a successful empty cluster query using billing-only scope data."""
    if not scope_status["available"] or not scope_rows:
        return (
            "no_classic_cluster_id_usage",
            "No matching classic cluster_id usage was returned for this selection.",
        )

    scope = scope_rows[0]
    usage_rows = int(scope.get("usage_rows") or 0)
    cluster_rows = int(scope.get("cluster_usage_rows") or 0)
    serverless_rows = int(scope.get("serverless_usage_rows") or 0)
    if usage_rows == 0:
        selection = "workspace filter and date range" if workspace_filtered else "date range"
        return (
            "no_usage_for_filter_or_date",
            f"No billable usage matched the selected {selection}.",
        )
    if cluster_rows == 0 and serverless_rows > 0:
        return (
            "serverless_only",
            "Usage exists, but it is serverless and has no classic cluster_id or VM metadata.",
        )
    return (
        "no_classic_cluster_id_usage",
        "Usage exists, but no matching classic cluster_id usage was found.",
    )


@router.get("/infra-bundle")
async def get_infra_bundle(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
) -> dict[str, Any]:
    """Bundled infra endpoint: runs cluster costs, instance families, and timeseries in parallel."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(
        start_date,
        end_date,
        workspace_ids,
        resolve_source_scope=False,
    )

    # Delta cross-worker cache
    _dkey = bundle_cache_key("billing:infra-bundle:v3", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation("billing:infra-bundle:v3")

    _ws_clause = wf.build_ws_filter_clause(id_list=id_list)

    # Billing-based summary query — matches KPI trend drill-downs exactly
    BILLING_INFRA_SUMMARY = """
    WITH usage_with_price AS (
      SELECT
        u.usage_date,
        u.usage_quantity,
        u.usage_metadata.cluster_id as cluster_id,
        COALESCE(p.pricing.default, 0) as price_per_dbu
      FROM system.billing.usage u
      /* TEMPORAL_LIST_PRICE_JOIN */
      WHERE u.usage_date BETWEEN :start_date AND :end_date
        AND u.usage_quantity > 0
        AND u.usage_metadata.cluster_id IS NOT NULL
        AND (
          u.billing_origin_product = 'DLT'
          OR u.sku_name LIKE '%ALL_PURPOSE%'
          OR u.sku_name LIKE '%JOBS%'
          OR u.sku_name LIKE '%DLT%'
        )
        AND u.sku_name NOT LIKE '%SERVERLESS%'
    ),
    daily_stats AS (
      SELECT
        usage_date,
        SUM(usage_quantity * price_per_dbu) as daily_cost,
        SUM(usage_quantity) as daily_dbus,
        COUNT(DISTINCT cluster_id) as daily_clusters
      FROM usage_with_price
      GROUP BY usage_date
    ),
    summary_stats AS (
      SELECT COUNT(DISTINCT cluster_id) AS total_cluster_count
      FROM usage_with_price
    )
    SELECT
      SUM(daily_cost) as total_cost,
      SUM(daily_dbus) as total_dbu_hours,
      MAX(summary_stats.total_cluster_count) as total_cluster_count,
      AVG(daily_clusters) as avg_clusters_per_day,
      CASE WHEN AVG(daily_clusters) > 0 THEN AVG(daily_cost / daily_clusters) ELSE 0 END as avg_cost_per_cluster,
      COUNT(*) as days_in_range,
      MIN(usage_date) as first_usage_date,
      MAX(usage_date) as last_usage_date
    FROM daily_stats
    CROSS JOIN summary_stats
    """
    BILLING_INFRA_SCOPE = """
    SELECT
      COUNT(*) AS usage_rows,
      COUNT_IF(u.usage_metadata.cluster_id IS NOT NULL) AS cluster_usage_rows,
      COUNT_IF(
        u.sku_name LIKE '%SERVERLESS%'
        OR (
          u.usage_metadata.cluster_id IS NULL
          AND (
            u.usage_metadata.warehouse_id IS NOT NULL
            OR u.usage_metadata.endpoint_name IS NOT NULL
          )
        )
      ) AS serverless_usage_rows
    FROM system.billing.usage u
    WHERE u.usage_date BETWEEN :start_date AND :end_date
      AND u.usage_quantity > 0
    """

    _infra_sql = _inject_ws_filter(BILLING_INFRA_SUMMARY, _ws_clause)
    _clusters_sql = _inject_ws_filter(INFRA_COST_ESTIMATE, _ws_clause)
    _ts_sql = _inject_ws_filter(INFRA_COST_TIMESERIES, _ws_clause)
    _scope_sql = _inject_ws_filter(BILLING_INFRA_SCOPE, _ws_clause)
    try:
        query_results, optional_failures = await asyncio.to_thread(
            _run_bundle_parallel,
            [
                ("clusters", lambda: _run_infra_query(_clusters_sql, params)),
                ("timeseries", lambda: _run_infra_query(_ts_sql, params)),
                ("billing_summary", lambda: _run_infra_query(_infra_sql, params)),
                ("usage_scope", lambda: _run_infra_query(_scope_sql, params)),
            ],
            # The billing aggregate is the Cloud tab's required core. Cluster
            # detail, metadata, and history are optional enrichments.
            required={"billing_summary"},
            timeout=90.0,
        )

        cluster_results, cluster_status = _infra_query_outcome(query_results, "clusters")
        ts_results, timeseries_status = _infra_query_outcome(query_results, "timeseries")
        billing_summary_results, billing_summary_status = _infra_query_outcome(
            query_results, "billing_summary"
        )
        scope_results, scope_status = _infra_query_outcome(query_results, "usage_scope")

        # Detect cloud from host URL, override with billing data if available
        host = get_host_url()
        cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                cloud = "GCP"
        if cluster_results:
            for row in cluster_results:
                if row.get("cloud"):
                    cloud = row.get("cloud")
                    break

        # --- Build clusters and instance families in one pass ---
        # Instance metadata completeness is tracked separately from DBU spend.
        # Spend remains authoritative even when a deleted cluster has no node types.
        complete_cluster_results = [
            row
            for row in cluster_results
            if str(row.get("driver_instance_type") or "").strip()
            and str(row.get("worker_instance_type") or "").strip()
        ]
        incomplete_cluster_results = [
            row for row in cluster_results if row not in complete_cluster_results
        ]
        incomplete_cluster_dbu_hours = sum(
            float(row.get("total_dbu_hours") or 0) for row in incomplete_cluster_results
        )

        # Instance types remain useful for cluster analysis, but DBU quantity is
        # not elapsed node-hours and cannot be multiplied by VM hourly prices.
        all_types = {
            row.get("driver_instance_type") for row in cluster_results
        } | {
            row.get("worker_instance_type") for row in cluster_results
        }
        family_map = {t: get_instance_family(t, cloud) for t in all_types if t}

        clusters = []
        detail_databricks_spend = 0.0
        detail_dbu_hours = 0.0
        family_agg: dict[str, dict] = {}

        for row in cluster_results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            databricks_spend = float(row.get("databricks_spend") or 0)
            driver_type = row.get("driver_instance_type")
            worker_type = row.get("worker_instance_type")
            detail_databricks_spend += databricks_spend
            detail_dbu_hours += dbu_hours
            clusters.append({
                "cluster_id": row.get("cluster_id"),
                "cluster_name": row.get("cluster_name"),
                "driver_instance_type": driver_type,
                "worker_instance_type": worker_type,
                "cluster_source": row.get("cluster_source"),
                "workspace_id": str(row.get("workspace_id") or ""),
                "workspace_name": row.get("workspace_name"),
                "total_dbu_hours": dbu_hours,
                "databricks_spend": databricks_spend,
                "estimated_cost": None,
                "days_active": row.get("days_active") or 0,
            })
            # Derive instance families from cluster data — no second query needed
            for itype in [driver_type, worker_type]:
                if itype:
                    family = family_map.get(itype) or get_instance_family(itype, cloud)
                    days = row.get("days_active") or 0
                    if family in family_agg:
                        family_agg[family]["total_dbu_hours"] += dbu_hours
                        family_agg[family]["days_active"] = max(family_agg[family]["days_active"], days)
                    else:
                        family_agg[family] = {"instance_family": family, "total_dbu_hours": dbu_hours, "days_active": days}

        aggregate_row = cluster_results[0] if cluster_results else {}
        total_cluster_count = int(
            aggregate_row.get("full_cluster_count") or len(cluster_results)
        )
        total_databricks_spend = float(
            aggregate_row.get("full_databricks_spend")
            if aggregate_row.get("full_databricks_spend") is not None
            else detail_databricks_spend
        )
        total_dbu_hours = float(
            aggregate_row.get("full_total_dbu_hours")
            if aggregate_row.get("full_total_dbu_hours") is not None
            else detail_dbu_hours
        )
        detail_limit = 100
        detail_truncated = total_cluster_count > len(cluster_results)

        for cluster in clusters:
            cluster["percentage"] = (
                cluster["databricks_spend"] / total_databricks_spend * 100
                if total_databricks_spend > 0
                else 0
            )
        instance_families = sorted(family_agg.values(), key=lambda f: f["total_dbu_hours"], reverse=True)
        metadata_quality = {
            "total_rows": len(cluster_results),
            "complete_rows": len(complete_cluster_results),
            "incomplete_rows": len(incomplete_cluster_results),
            "incomplete_dbu_hours": incomplete_cluster_dbu_hours,
        }
        if cluster_status["available"] and clusters:
            # Missing node types are expected for historical/deleted clusters.
            # Spend and DBUs remain complete, and each affected row already
            # identifies the missing metadata in the table.
            availability = "available"
            reason = None
            reason_detail = None
        elif cluster_status["available"]:
            availability = "empty"
            reason, reason_detail = _infra_empty_reason(
                scope_results, scope_status, bool(id_list)
            )
        else:
            availability = "unavailable"
            reason = (
                "permission_denied"
                if cluster_status["error_kind"] == "permission"
                else "metadata_unavailable"
                if cluster_status["error_kind"] == "metadata"
                else "query_failed"
            )
            reason_detail = (
                "Classic cluster metadata could not be queried, so zero usage cannot be confirmed."
            )

        # --- Build timeseries ---
        # SQL already returns one authoritative aggregate row per date.
        timeseries = [
            {
                "date": str(row.get("usage_date")),
                "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
            }
            for row in ts_results
        ]
        timeseries_metadata_quality = {
            "total_rows": len(ts_results),
            "complete_rows": len(ts_results),
            "incomplete_rows": 0,
            "incomplete_dbu_hours": 0.0,
        }
        if not timeseries_status["available"]:
            timeseries_availability = "unavailable"
            timeseries_reason = "query_failed"
            timeseries_reason_detail = (
                "Infrastructure cost history could not be queried."
            )
        elif timeseries:
            timeseries_availability = "available"
            timeseries_reason = None
            timeseries_reason_detail = None
        else:
            timeseries_availability = "empty"
            timeseries_reason = reason
            timeseries_reason_detail = reason_detail

        # Extract billing-based summary (matches KPI drill-downs)
        billing_summary = {}
        if billing_summary_results:
            bs = billing_summary_results[0]
            billing_summary = {
                "databricks_compute_spend": float(bs.get("total_cost") or 0),
                "total_dbu_hours": float(bs.get("total_dbu_hours") or 0),
                "total_cluster_count": int(bs.get("total_cluster_count") or 0),
                "avg_clusters_per_day": round(float(bs.get("avg_clusters_per_day") or 0)),
                "avg_databricks_spend_per_cluster": float(bs.get("avg_cost_per_cluster") or 0),
                "days_in_range": int(bs.get("days_in_range") or 0),
                "first_usage_date": bs.get("first_usage_date"),
                "last_usage_date": bs.get("last_usage_date"),
            }
            if not cluster_status["available"]:
                total_databricks_spend = billing_summary["databricks_compute_spend"]
                total_dbu_hours = billing_summary["total_dbu_hours"]
                total_cluster_count = billing_summary["total_cluster_count"]
                detail_truncated = total_cluster_count > 0
                availability = "partial"
                reason = "cluster_detail_unavailable"
                reason_detail = (
                    "Databricks spend and DBU totals are available, but classic "
                    "cluster detail is temporarily unavailable. Retry this tab shortly."
                )

        section_partial = bool(optional_failures) or not all(
            status["available"]
            for status in (
                cluster_status,
                timeseries_status,
                billing_summary_status,
                scope_status,
            )
        )
        _resp = {
            "availability": "partial" if section_partial else "available",
            "partial_reasons": optional_failures,
            "infra_costs": {
                "cloud": cloud,
                "cloud_display_name": get_cloud_display_name(cloud),
                "clusters": clusters,
                "instance_families": instance_families,
                "total_estimated_cost": None,
                "total_databricks_spend": total_databricks_spend,
                "total_dbu_hours": total_dbu_hours,
                "total_cluster_count": total_cluster_count,
                "detail_limit": detail_limit,
                "detail_truncated": detail_truncated,
                "full_first_usage_date": aggregate_row.get("full_first_usage_date"),
                "full_last_usage_date": aggregate_row.get("full_last_usage_date"),
                "currency_estimate_available": False,
                "estimate_unavailable_reason": (
                    "Cloud VM cost is unavailable because this project grants "
                    "cluster metadata but no authoritative node-hour and worker-count timeline."
                ),
                "billing_summary": billing_summary,
                "available": bool(billing_summary_results)
                or (cluster_status["available"] and availability != "unavailable"),
                "availability": availability,
                "error": cluster_status["error"],
                "error_kind": (
                    "metadata"
                    if availability in {"partial", "unavailable"}
                    and reason in {"metadata_partial", "metadata_unavailable"}
                    else cluster_status["error_kind"]
                ),
                "reason": reason,
                "reason_detail": reason_detail,
                "metadata_quality": metadata_quality,
                "query_status": {
                    "clusters": cluster_status,
                    "billing_summary": billing_summary_status,
                    "usage_scope": scope_status,
                },
                "start_date": params["start_date"],
                "end_date": params["end_date"],
                "disclaimer": (
                    "Cluster DBUs and instance metadata are shown. Use AWS CUR, "
                    "Azure Cost Management, or GCP Billing Export for currency costs."
                ),
            },
            "infra_timeseries": {
                "cloud": cloud,
                "cloud_display_name": get_cloud_display_name(cloud),
                "timeseries": timeseries,
                "currency_estimate_available": False,
                "estimate_unavailable_reason": (
                    "Cloud VM cost history is unavailable without authoritative node-hours."
                ),
                "available": (
                    timeseries_status["available"]
                    and timeseries_availability != "unavailable"
                ),
                "availability": timeseries_availability,
                "error": timeseries_status["error"],
                "error_kind": (
                    "metadata"
                    if timeseries_availability in {"partial", "unavailable"}
                    and timeseries_reason in {"metadata_partial", "metadata_unavailable"}
                    else timeseries_status["error_kind"]
                ),
                "reason": timeseries_reason,
                "reason_detail": timeseries_reason_detail,
                "metadata_quality": timeseries_metadata_quality,
                "start_date": params["start_date"],
                "end_date": params["end_date"],
            },
        }
        # Partial infrastructure responses remain retryable. In particular, never
        # turn a capacity rejection into a durable successful empty response.
        if not section_partial:
            delta_cache_put(
                _dkey,
                "billing:infra-bundle:v3",
                _resp,
                ttl_seconds=cache_ttls.BUNDLE_FILTERED if id_list else cache_ttls.BUNDLE,
                generation=_cache_generation,
            )
        return _resp
    except Exception as e:
        logger.error(f"Infra bundle error: {e}")
        host = get_host_url()
        err_cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                err_cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                err_cloud = "GCP"
        empty = {
            "cloud": err_cloud, "cloud_display_name": get_cloud_display_name(err_cloud),
            "start_date": params["start_date"], "end_date": params["end_date"],
        }
        return {
            "availability": "error",
            "error_code": getattr(e, "code", "SQL_EXECUTION_ERROR"),
            "infra_costs": {
                **empty,
                "clusters": [],
                "instance_families": [],
                "total_estimated_cost": None,
                "total_databricks_spend": 0,
                "total_dbu_hours": 0,
                "currency_estimate_available": False,
                "available": False,
                "availability": "unavailable",
                "error": str(e),
                "error_kind": _classify_infra_query_error(e),
                "reason": "query_failed",
                "reason_detail": "Infrastructure costs could not be queried, so zero usage cannot be confirmed.",
            },
            "infra_timeseries": {
                **empty,
                "timeseries": [],
                "available": False,
                "availability": "unavailable",
                "error": str(e),
                "error_kind": _classify_infra_query_error(e),
                "reason": "query_failed",
            },
        }


async def _compute_cloud_costs_bundle(
    params: dict[str, str],
    workspace_ids: list[str] | None,
) -> dict[str, Any]:
    """Compute Cloud Costs in bounded phases with infrastructure as the core."""
    from server.routers import aws_actual, azure_actual, gcp_actual

    workspace_scope = ",".join(workspace_ids) if workspace_ids else None
    infra = await get_infra_bundle(
        start_date=params["start_date"],
        end_date=params["end_date"],
        workspace_ids=workspace_scope,
    )
    if infra.get("availability") == "error":
        error = SQLExecutionError(
            str(
                infra.get("infra_costs", {}).get("error")
                or "Required Cloud billing aggregate failed."
            )
        )
        error.code = str(infra.get("error_code") or error.code)
        raise error

    provider_calls = (
        ("aws_actual", aws_actual.get_aws_actual_dashboard_bundle),
        ("azure_actual", azure_actual.get_azure_actual_dashboard_bundle),
        ("gcp_actual", gcp_actual.get_gcp_actual_dashboard_bundle),
    )
    providers: dict[str, Any] = {}
    partial_reasons: dict[str, str] = (
        {"infra_bundle": "OPTIONAL_SECTION_FAILED"}
        if infra.get("availability") == "partial"
        else {}
    )
    # Providers are deliberately sequenced. Each provider bounds its own optional
    # detail fanout at two, so one large export cannot crowd out the core bundle.
    for name, call in provider_calls:
        try:
            providers[name] = await call(params["start_date"], params["end_date"])
            if providers[name].get("availability") == "partial":
                partial_reasons[name] = "OPTIONAL_DETAIL_FAILED"
        except Exception as exc:
            logger.warning("Optional %s Cloud bundle failed: %s", name, exc)
            code = str(getattr(exc, "code", "QUERY_FAILED"))
            partial_reasons[name] = code
            providers[name] = {
                "available": False,
                "availability": "unavailable",
                "transient_error": True,
                "error_code": code,
                "message": (
                    f"{name.replace('_', ' ').title()} is temporarily unavailable. "
                    "Usage & Metadata remains available; retry Cloud Costs shortly."
                ),
                "start_date": params["start_date"],
                "end_date": params["end_date"],
            }

    return {
        "availability": "partial"
        if partial_reasons or infra.get("availability") == "partial"
        else "available",
        "partial_reasons": partial_reasons,
        "infra_bundle": infra,
        **providers,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _json_safe_cloud_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize connector-native dates/decimals before shared JSON caching."""
    return jsonable_encoder(payload)


@router.get("/cloud-costs-bundle")
async def get_cloud_costs_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    workspace_ids: str = Query(default=None),
) -> dict[str, Any]:
    """Submit/coalesce the complete Cloud Costs request and poll until ready."""
    from server.app import current_request_id

    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    producer_request_id = current_request_id()
    cache_key = bundle_cache_key(
        "billing:cloud-costs-bundle:v2",
        params["start_date"],
        params["end_date"],
        id_list,
    )

    # Polling must not consume SQL slots while a producer owns the bundle lease.
    if bundle_compute_is_pending(cache_key):
        return JSONResponse(
            status_code=202,
            content={"status": "pending"},
            headers={"Retry-After": "1"},
        )
    if (cached := await asyncio.to_thread(delta_cache_get, cache_key)) is not None:
        return cached

    with _cloud_bundle_failures_lock:
        failure = _cloud_bundle_failures.get(cache_key)
    if failure:
        raise HTTPException(
            status_code=503,
            detail=failure,
            headers={"Retry-After": "2"},
        )

    generation = capture_cache_generation("billing:cloud-costs-bundle:v2")

    def produce() -> None:
        try:
            payload = _json_safe_cloud_payload(
                asyncio.run(_compute_cloud_costs_bundle(params, id_list))
            )
            delta_cache_put(
                cache_key,
                "billing:cloud-costs-bundle:v2",
                payload,
                ttl_seconds=(
                    60
                    if payload.get("availability") == "partial"
                    else cache_ttls.BUNDLE
                ),
                generation=generation,
                wait_for_remote=True,
            )
        except Exception as exc:
            logger.error(
                "Cloud Costs bundle producer failed request_id=%s: %s",
                producer_request_id,
                exc,
            )
            with _cloud_bundle_failures_lock:
                _cloud_bundle_failures[cache_key] = _safe_cloud_failure(
                    exc,
                    request_id=producer_request_id,
                )

    try:
        start_bundle_compute(cache_key, produce, name="cloud-costs-bundle")
    except BundleOverloadedError as exc:
        raise HTTPException(
            status_code=503,
            detail=_safe_cloud_failure(
                exc,
                request_id=producer_request_id,
            ),
            headers={"Retry-After": "2"},
        ) from exc
    return JSONResponse(
        status_code=202,
        content={"status": "pending"},
        headers={"Retry-After": "1"},
    )


@router.get("/aws-costs")
async def get_aws_costs(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get estimated AWS infrastructure costs based on cluster instance types.

    DEPRECATED: Use /infra-costs instead for multi-cloud support.
    This endpoint is maintained for backwards compatibility.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }
    if not _local_source_selected():
        return {
            "clusters": [],
            "instance_families": [],
            "total_estimated_cost": None,
            "total_databricks_spend": 0,
            "total_dbu_hours": 0,
            "currency_estimate_available": False,
            "reason": "shared_scope_unsupported",
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    try:
        # Get detailed cluster costs
        cluster_results = await asyncio.to_thread(execute_query, _pool_scoped(INFRA_COST_ESTIMATE), params)

        clusters = []
        detail_databricks_spend = 0.0
        detail_dbu_hours = 0.0

        for row in cluster_results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            databricks_spend = float(row.get("databricks_spend") or 0)
            detail_databricks_spend += databricks_spend
            detail_dbu_hours += dbu_hours
            clusters.append(
                {
                    "cluster_id": row.get("cluster_id"),
                    "cluster_name": row.get("cluster_name"),
                    "driver_instance_type": row.get("driver_instance_type"),
                    "worker_instance_type": row.get("worker_instance_type"),
                    "cluster_source": row.get("cluster_source"),
                    "total_dbu_hours": dbu_hours,
                    "databricks_spend": databricks_spend,
                    "days_active": row.get("days_active") or 0,
                }
            )

        aggregate_row = cluster_results[0] if cluster_results else {}
        total_cluster_count = int(
            aggregate_row.get("full_cluster_count") or len(cluster_results)
        )
        total_databricks_spend = float(
            aggregate_row.get("full_databricks_spend")
            if aggregate_row.get("full_databricks_spend") is not None
            else detail_databricks_spend
        )
        total_dbu_hours = float(
            aggregate_row.get("full_total_dbu_hours")
            if aggregate_row.get("full_total_dbu_hours") is not None
            else detail_dbu_hours
        )

        for cluster in clusters:
            cluster["percentage"] = (
                cluster["databricks_spend"] / total_databricks_spend * 100
                if total_databricks_spend > 0
                else 0
            )

        # Get instance family breakdown
        family_results = await asyncio.to_thread(execute_query, _pool_scoped(AWS_COST_BY_INSTANCE_TYPE), params)
        instance_families = []
        for row in family_results:
            instance_families.append(
                {
                    "instance_family": row.get("instance_family"),
                    "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
                    "days_active": row.get("days_active") or 0,
                }
            )

        return {
            "clusters": clusters,
            "instance_families": instance_families,
            "total_estimated_cost": None,
            "total_databricks_spend": total_databricks_spend,
            "total_dbu_hours": total_dbu_hours,
            "total_cluster_count": total_cluster_count,
            "detail_limit": 100,
            "detail_truncated": total_cluster_count > len(cluster_results),
            "full_first_usage_date": aggregate_row.get("full_first_usage_date"),
            "full_last_usage_date": aggregate_row.get("full_last_usage_date"),
            "currency_estimate_available": False,
            "estimate_unavailable_reason": (
                "AWS VM cost is unavailable without authoritative node-hours "
                "and worker counts."
            ),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "disclaimer": (
                "DBU and cluster metadata only. Connect AWS CUR for currency costs."
            ),
        }
    except Exception as e:
        return {
            "clusters": [],
            "instance_families": [],
            "total_estimated_cost": None,
            "total_databricks_spend": 0,
            "total_dbu_hours": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"AWS cost estimation not available: {str(e)}",
        }


@router.get("/aws-costs-timeseries")
async def get_aws_costs_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get AWS classic-cluster DBUs over time; no inferred VM currency cost."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }
    if not _local_source_selected():
        return {
            "timeseries": [],
            "instance_families": [],
            "available": False,
            "reason": "shared_scope_unsupported",
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    try:
        results = await asyncio.to_thread(execute_query, _pool_scoped(INFRA_COST_TIMESERIES), params)
        by_date: dict[str, float] = {}
        for row in results:
            key = str(row.get("usage_date"))
            by_date[key] = by_date.get(key, 0.0) + float(
                row.get("total_dbu_hours") or 0
            )
        return {
            "timeseries": [
                {"date": key, "Cluster DBUs": value}
                for key, value in sorted(by_date.items())
            ],
            "instance_families": [],
            "currency_estimate_available": False,
            "estimate_unavailable_reason": (
                "AWS VM cost history requires CUR or authoritative node-hours."
            ),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
    except Exception as e:
        return {
            "timeseries": [],
            "instance_families": [],
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"AWS cost timeseries not available: {str(e)}",
        }

_pipeline_names_cache: dict[str, str] | None = None
_pipeline_names_cache_ts: float = 0
_PIPELINE_CACHE_TTL = cache_ttls.PIPELINE_NAMES


def _get_pipeline_names() -> dict[str, str]:
    """Get pipeline ID → name mapping. Try system table first, fall back to SDK. Cached for 1 hour."""
    global _pipeline_names_cache, _pipeline_names_cache_ts
    import time as _time
    now = _time.monotonic()
    if _pipeline_names_cache is not None and (now - _pipeline_names_cache_ts) < _PIPELINE_CACHE_TTL:
        return _pipeline_names_cache

    # Try system.lakeflow.pipelines (cross-workspace)
    try:
        results = execute_query("""
            SELECT pipeline_id, MAX(name) as pipeline_name
            FROM system.lakeflow.pipelines
            WHERE name IS NOT NULL
            GROUP BY pipeline_id
        """)
        if results:
            names = {r["pipeline_id"]: r["pipeline_name"] for r in results if r.get("pipeline_id") and r.get("pipeline_name")}
            logger.info(f"Pipeline names from system table: {len(names)} found")
            if names:
                _pipeline_names_cache = names
                _pipeline_names_cache_ts = now
                return names
    except Exception as e:
        logger.warning(f"system.lakeflow.pipelines not accessible: {type(e).__name__}: {e}")

    # Fall back to SDK (current workspace only)
    try:
        w = get_workspace_client()
        pipeline_names: dict[str, str] = {}
        for p in w.pipelines.list_pipelines():
            if p.pipeline_id and p.name:
                pipeline_names[p.pipeline_id] = p.name
        logger.info(f"Pipeline names from SDK: {len(pipeline_names)} found")
        _pipeline_names_cache = pipeline_names
        _pipeline_names_cache_ts = now
        return pipeline_names
    except Exception as e:
        logger.warning(f"Could not list pipelines via SDK: {type(e).__name__}: {e}")
        return {}


def _enrich_pipeline_results(results: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Enrich billing-only pipeline results with names from system table or SDK."""
    if not results:
        return results
    try:
        sdp_rows = [r for r in results if r.get("object_type") == "SDP Pipeline"]
        unresolved = [r for r in sdp_rows if r.get("object_name") == r.get("object_id")]
        if not unresolved:
            return results
        pipeline_names = _get_pipeline_names()
        if not pipeline_names:
            return results
        for row in results:
            if row.get("object_type") == "SDP Pipeline":
                pid = row.get("object_id")
                if pid and pid in pipeline_names:
                    row["object_name"] = pipeline_names[pid]
    except Exception as e:
        logger.warning(f"Pipeline enrichment failed: {type(e).__name__}: {e}")
    return results


@router.get("/dashboard-bundle")
async def get_dashboard_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get all dashboard data in a single request with parallel execution.

    This endpoint executes all dashboard queries in parallel to minimize latency.
    Expected speedup: 6-12x faster than making individual requests.
    """
    params, _ = _validated_scope(start_date, end_date)

    # Execute all queries in parallel
    queries = [
        ("summary", lambda: execute_query(_pool_scoped(BILLING_SUMMARY), params)),
        ("products", lambda: execute_query(_pool_scoped(BILLING_BY_PRODUCT), params)),
        ("workspaces", lambda: execute_query(_pool_scoped(BILLING_BY_WORKSPACE), params)),
        ("timeseries", lambda: execute_query(_pool_scoped(BILLING_TIMESERIES), params)),
        ("sql_breakdown", lambda: execute_query(_pool_scoped(SQL_TOOL_ATTRIBUTION), params)),
        ("etl_breakdown", lambda: execute_query(_pool_scoped(ETL_BREAKDOWN), params)),
        ("pipeline_objects", lambda: _enrich_pipeline_results(execute_query(_pool_scoped(PIPELINE_OBJECTS), params))),
        ("interactive", lambda: execute_query(_pool_scoped(INTERACTIVE_BREAKDOWN), params)),
    ]

    try:
        results, optional_failures = await asyncio.to_thread(
            _run_bundle_parallel,
            queries,
            required={"summary", "products", "timeseries"},
            timeout=60.0,
        )

        # Format responses to match existing endpoint structures
        response = {
            "availability": "partial" if optional_failures else "available",
            "partial_reasons": optional_failures,
            "summary": _format_summary(results.get("summary"), params),
            "products": _format_products(results.get("products"), params),
            "workspaces": _format_workspaces(results.get("workspaces"), params),
            "timeseries": _format_timeseries(results.get("timeseries"), params),
            "sql_breakdown": _format_sql_breakdown(results.get("sql_breakdown"), params),
            "etl_breakdown": _format_etl_breakdown(results.get("etl_breakdown"), params),
            "pipeline_objects": _format_pipeline_objects(results.get("pipeline_objects"), params),
            "interactive": _format_interactive(results.get("interactive"), params),
            "aws": {
                "available": False,
                "currency_estimate_available": False,
                "unavailable_reason": (
                    "Cloud VM currency estimates require actual billing data "
                    "or authoritative node-hours."
                ),
                "clusters": [],
                "timeseries": [],
            },
        }

        return response
    except Exception as e:
        logger.error("dashboard-bundle failed: %s", e)
        return {
            "availability": "error",
            "error": str(e),
            "summary": _format_summary(None, params),
            "products": _format_products(None, params),
            "workspaces": _format_workspaces(None, params),
            "timeseries": _format_timeseries(None, params),
            "sql_breakdown": _format_sql_breakdown(None, params),
            "etl_breakdown": _format_etl_breakdown(None, params),
            "pipeline_objects": _format_pipeline_objects(None, params),
            "interactive": _format_interactive(None, params),
            "aws": {
                "clusters": _format_aws_clusters(None, None, params),
                "timeseries": _format_aws_timeseries(None, params),
            },
        }


def _inject_ws_filter(sql: str, clause: str) -> str:
    """Append a workspace filter clause after every usage_quantity guard in a SQL string."""
    from server import workspace_filter as wf
    return wf.inject_ws_filter(sql, clause)


def _inject_qh_ws_filter(sql: str, clause: str) -> str:
    """Append a workspace filter clause to a system.query.history query."""
    if not clause:
        return sql
    anchor = "AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)"
    if anchor in sql:
        return sql.replace(anchor, f"{anchor}\n    {clause}", 1)
    return sql


# Module-level cache for account workspace names (1h TTL).
# Populated by AccountClient.workspaces.list() when DATABRICKS_ACCOUNT_ID is set.
_account_ws_names: dict[str, str] = {}
_account_ws_deployment_names: dict[str, str] = {}
_account_ws_cloud_metadata: dict[str, dict[str, str]] = {}
_account_ws_names_ts: float = 0.0
_background_tasks: set = set()  # keeps fire-and-forget tasks alive


def _get_account_workspace_names() -> dict[str, str]:
    """Return workspace_id → workspace_name for ALL account workspaces. Cached 1h; {} on failure.

    Uses db.get_account_client() (account-console host + OAuth M2M). Previously this built a
    bare AccountClient(account_id=...) which has NO account host, so it hit the workspace host,
    failed, and returned {} — that's why the top-nav workspace filter showed raw IDs for the
    ~thousands of non-billing account workspaces (names resolve elsewhere via the
    billing.usage ⋈ workspaces_latest join, which only covers spending workspaces).
    """
    global _account_ws_cloud_metadata, _account_ws_deployment_names
    global _account_ws_names, _account_ws_names_ts
    if time.time() - _account_ws_names_ts < 3600:
        return _account_ws_names

    try:
        from server.db import get_account_client
        a = get_account_client()  # correct account-console host
        if a is None:
            _account_ws_names_ts = time.time()
            return {}
        workspaces = list(a.workspaces.list())
        names = {
            str(w.workspace_id): w.workspace_name
            for w in workspaces
            if w.workspace_name
        }
        _account_ws_deployment_names = {
            str(w.workspace_id): w.deployment_name
            for w in workspaces
            if getattr(w, "deployment_name", None)
        }
        metadata: dict[str, dict[str, str]] = {}
        for workspace in workspaces:
            workspace_id = str(workspace.workspace_id)
            raw_cloud = getattr(workspace, "cloud", None)
            cloud = str(getattr(raw_cloud, "value", raw_cloud) or "").lower()
            region = str(
                getattr(workspace, "aws_region", None)
                or getattr(workspace, "location", None)
                or ""
            )
            details = {
                key: value
                for key, value in {"cloud": cloud, "region": region}.items()
                if value
            }
            if details:
                metadata[workspace_id] = details
        _account_ws_cloud_metadata = metadata
        _account_ws_names = names
        _account_ws_names_ts = time.time()
        logger.info("AccountClient: fetched %d workspace names", len(names))
        return names
    except Exception as e:
        logger.warning("AccountClient workspace list failed: %s", e)
        _account_ws_names_ts = time.time()  # backoff: don't retry for another hour
        return {}


def _get_current_workspace_display_label(workspace_id: str) -> str | None:
    names = _get_account_workspace_names()
    return _account_ws_deployment_names.get(workspace_id) or names.get(workspace_id)


async def _refresh_account_ws_names_bg() -> None:
    """Fire-and-forget: refresh workspace name cache without blocking the request path."""
    await asyncio.to_thread(_get_account_workspace_names)


@router.get("/workspaces")
async def get_workspace_list(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """All workspaces with billing activity, scoped to COST_OBS_WORKSPACES when set."""
    from server import workspace_filter as wf
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }
    configured_ids = wf.get_configured_workspace_ids()
    ws_clause = wf.build_ws_filter_clause() if configured_ids else ""

    # Primary query: workspaces_latest only — always succeeds, result is cached on success.
    # Keeping this separate from the workspaces CDC table avoids TABLE_OR_VIEW_NOT_FOUND
    # on environments that don't have system.access.workspaces (e.g. dogfood), which would
    # prevent caching and cause every cold-start to stall while the warehouse wakes up.
    sql_with_names = f"""
        SELECT
            CAST(u.workspace_id AS STRING) as workspace_id,
            MAX(wsl.workspace_name) as workspace_name
        FROM system.billing.usage u
        LEFT JOIN system.access.workspaces_latest wsl
            ON CAST(u.workspace_id AS BIGINT) = CAST(wsl.workspace_id AS BIGINT)
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.workspace_id IS NOT NULL
          {ws_clause}
        GROUP BY u.workspace_id
        ORDER BY COALESCE(MAX(wsl.workspace_name), CAST(u.workspace_id AS STRING))
    """
    sql_ids_only = f"""
        SELECT
            CAST(workspace_id AS STRING) as workspace_id,
            CAST(NULL AS STRING) as workspace_name
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND workspace_id IS NOT NULL
          {ws_clause}
        GROUP BY workspace_id
        ORDER BY workspace_id
    """
    def _fetch_rows() -> list:
        if selected_source_labels():
            catalog, schema = get_catalog_schema()
            mv_template = """
                SELECT
                    CAST(ws.workspace_id AS STRING) AS workspace_id,
                    MAX(ws.workspace_name) AS workspace_name
                FROM `{catalog}`.`{schema}`.`daily_workspace_breakdown` AS ws
                WHERE ws.usage_date BETWEEN :start_date AND :end_date
                  {ws_filter}
                  {source_filter}
                GROUP BY ws.workspace_id
                ORDER BY COALESCE(
                    MAX(ws.workspace_name),
                    CAST(ws.workspace_id AS STRING)
                )
            """
            source_filter = source_label_filter_clause(mv_template)
            scoped_query = mv_template.format(
                catalog=catalog,
                schema=schema,
                ws_filter=wf.build_ws_filter_clause(col="ws.workspace_id"),
                source_filter=source_filter,
            )
            return execute_query(
                apply_mv_overrides(scoped_query, catalog, schema),
                params,
            )
        try:
            rows = execute_query(sql_with_names, params)
        except Exception as e:
            logger.warning("get_workspace_list: system.access.workspaces_latest unavailable (%s: %s), falling back to IDs only", type(e).__name__, e)
            rows = execute_query(sql_ids_only, params)
        # AccountClient names (authoritative for CURRENT workspaces).
        if _account_ws_names:
            rows = [{**r, "workspace_name": _account_ws_names.get(r["workspace_id"]) or r["workspace_name"]} for r in rows]
        # Fill any STILL-unresolved names from the app's own workspace MV — the SAME source
        # every other dropdown uses. It retains names for workspaces later deleted/renamed
        # (system.access.workspaces_latest drops those; AccountClient only lists current ones),
        # so the long tail otherwise renders as raw IDs in the top-nav filter. (The old
        # fallback queried system.access.workspaces, absent in many workspaces, and only ran
        # when EVERY row was null — so partial gaps never got filled.)
        if any(r["workspace_name"] is None for r in rows):
            try:
                _cat, _sch = get_catalog_schema()
                mv = execute_query(
                    f"SELECT CAST(workspace_id AS STRING) AS workspace_id, MAX(workspace_name) AS workspace_name "
                    f"FROM `{_cat}`.`{_sch}`.`daily_workspace_breakdown` "
                    f"WHERE workspace_name IS NOT NULL GROUP BY workspace_id",
                    no_cache=True,
                )
                mv_map = {r["workspace_id"]: r["workspace_name"] for r in mv}
                if mv_map:
                    rows = [{**r, "workspace_name": r["workspace_name"] or mv_map.get(r["workspace_id"])} for r in rows]
            except Exception as e:
                logger.debug("get_workspace_list: MV workspace-name fill skipped: %s", e)
        return rows

    # Kick off background refresh if stale — never blocks the request path
    if time.time() - _account_ws_names_ts >= 3600:
        _t = asyncio.create_task(_refresh_account_ws_names_bg())
        _background_tasks.add(_t)
        _t.add_done_callback(_background_tasks.discard)

    # Admin pref: when workspace display names are off, return IDs (name=null) even
    # where a name resolved. `historical` still reflects true name availability so the
    # toggle never mislabels a live workspace.
    try:
        from server.routers.settings import workspace_names_enabled
        show_names = workspace_names_enabled()
    except Exception:
        show_names = True

    try:
        rows = await asyncio.wait_for(asyncio.to_thread(_fetch_rows), timeout=30.0)
        host = get_host_url().lower()
        default_cloud = (
            "gcp"
            if "gcp.databricks.com" in host
            else "azure"
            if "azuredatabricks.net" in host
            else "aws"
            if "cloud.databricks.com" in host
            else ""
        )
        def _workspace_option(row: dict[str, Any]) -> dict[str, Any]:
            workspace_id = str(row["workspace_id"])
            workspace_name = row.get("workspace_name")
            metadata = _account_ws_cloud_metadata.get(workspace_id, {})
            cloud = str(metadata.get("cloud") or default_cloud).lower()
            region = metadata.get("region") or _infer_workspace_region(
                str(workspace_name or ""),
                cloud,
            )
            return {
                "id": workspace_id,
                "name": workspace_name if show_names else None,
                "historical": not (
                    workspace_name and str(workspace_name).strip()
                ),
                "cloud": cloud or None,
                "region": region,
            }
        return {
            "workspaces": [
                _workspace_option(r)
                for r in rows
                if r.get("workspace_id") is not None
                and str(r["workspace_id"]).strip().lower() not in ("", "none", "null")
            ],
            "is_scoped": bool(configured_ids),
            "env_var": "COST_OBS_WORKSPACES",
            "env_var_value": ",".join(configured_ids),
        }
    except asyncio.TimeoutError:
        logger.warning("get_workspace_list timed out after 30s")
        return {"workspaces": [], "is_scoped": bool(configured_ids), "error": "timeout"}
    except Exception as e:
        logger.warning("get_workspace_list failed: %s", e)
        return {"workspaces": [], "is_scoped": bool(configured_ids), "error": str(e)}


@router.get("/dashboard-bundle-fast")
async def get_dashboard_bundle_fast(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    workspace_ids: str = Query(default=None),
) -> dict[str, Any]:
    """Get essential dashboard data FAST.

    This endpoint is optimized for fast initial page load by:
    1. Using materialized views when available (sub-second queries)
    2. Falling back to optimized queries that skip system.query.history
    3. Running queries in parallel

    Expected load time: <1 second with MVs, 2-5 seconds without.
    """
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)

    # Delta cross-worker cache — check before running any warehouse queries
    _dkey = bundle_cache_key("billing:dashboard-bundle-fast:v2", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation("billing:dashboard-bundle-fast:v2")

    # Build workspace filter — dropdown selection overrides env/file config.
    ws_clause = wf.build_ws_filter_clause(id_list=id_list)
    mv_ws = _mv_ws_clause(id_list)

    use_mv = await asyncio.to_thread(_check_mv_available)
    source_scoped = any(
        label != get_local_source_label()
        for label in selected_source_labels()
    )

    if use_mv:
        # Use materialized views — much faster than live system.billing.usage scans.
        # MVs now include workspace_id so they support workspace filtering directly.
        logger.info("Using materialized views for dashboard bundle")

        def _mv_summary():
            r = _exec_mv(MV_BILLING_SUMMARY, params, mv_ws)
            # Fall back if empty or if MV returned zero spend (table exists but not yet populated)
            if selected_source_labels() or (
                r and float((r[0] if r else {}).get("total_spend") or 0) > 0
            ):
                return r
            return execute_query(_inject_ws_filter(BILLING_SUMMARY, ws_clause), params)

        def _mv_timeseries():
            template = (
                MV_BILLING_TOTAL_TIMESERIES
                if source_scoped
                else MV_BILLING_TIMESERIES
            )
            r = _exec_mv(template, params, mv_ws)
            return (
                r
                if r or selected_source_labels()
                else execute_query(_inject_ws_filter(BILLING_TIMESERIES_FAST, ws_clause), params)
            )

        def _mv_products():
            r = _exec_mv(MV_BILLING_BY_PRODUCT, params, mv_ws)
            return (
                r
                if r or selected_source_labels()
                else execute_query(_inject_ws_filter(BILLING_BY_PRODUCT_FAST, ws_clause), params)
            )

        def _mv_workspaces():
            if source_scoped:
                return _exec_mv(
                    MV_BILLING_BY_WORKSPACE_BASIC,
                    params,
                    mv_ws,
                    timeout=15,
                )
            return execute_query(
                _inject_ws_filter(BILLING_BY_WORKSPACE, ws_clause),
                params,
                timeout=15,
                max_rows=200,
            )

        # Also fetch most-recent-day workspace count; MV summary gives period-total DISTINCT
        # which is always >= any single day and mismatches the daily trend chart.
        _WORKSPACE_COUNT_QUERY_MV = """
        SELECT daily_ws as workspace_count FROM (
          SELECT usage_date, COUNT(DISTINCT workspace_id) as daily_ws
          FROM `{catalog}`.`{schema}`.`daily_usage_summary`
          WHERE usage_date BETWEEN :start_date AND :end_date
            {ws_filter}
          GROUP BY usage_date
          ORDER BY usage_date DESC
          LIMIT 1
        )
        """
        queries = [
            ("summary", _mv_summary),
            ("products", _mv_products),
            ("workspaces", _mv_workspaces),
            ("timeseries", _mv_timeseries),
            ("etl_breakdown", lambda: _exec_mv(MV_ETL_BREAKDOWN, params, mv_ws, timeout=15)),
            (
                "workspace_count",
                lambda: _exec_mv(
                    _WORKSPACE_COUNT_QUERY_MV,
                    params,
                    mv_ws,
                    timeout=15,
                ),
            ),
        ]
    else:
        # Fall back to fast queries without MVs; inject workspace filter when active.
        _ws = wf.build_ws_filter_clause(col="workspace_id", id_list=id_list)
        WORKSPACE_COUNT_QUERY = f"""
        SELECT daily_ws as workspace_count FROM (
          SELECT usage_date, COUNT(DISTINCT workspace_id) as daily_ws
          FROM system.billing.usage
          WHERE usage_date BETWEEN :start_date AND :end_date AND usage_quantity > 0
          {_ws}
          GROUP BY usage_date
          ORDER BY usage_date DESC
          LIMIT 1
        )
        """
        _s = _inject_ws_filter(BILLING_SUMMARY, ws_clause)
        _p = _inject_ws_filter(BILLING_BY_PRODUCT_FAST, ws_clause)
        _w = _inject_ws_filter(BILLING_BY_WORKSPACE, ws_clause)
        _t = _inject_ws_filter(BILLING_TIMESERIES_FAST, ws_clause)
        _e = _inject_ws_filter(ETL_BREAKDOWN, ws_clause)
        queries = [
            ("summary", lambda: execute_query(_s, params)),
            ("products", lambda: execute_query(_p, params)),
            ("workspaces", lambda: execute_query(_w, params, timeout=15, max_rows=200)),
            ("timeseries", lambda: execute_query(_t, params)),
            ("etl_breakdown", lambda: execute_query(_e, params, timeout=15)),
            (
                "workspace_count",
                lambda: execute_query(
                    WORKSPACE_COUNT_QUERY,
                    params,
                    timeout=15,
                    max_rows=1,
                ),
            ),
        ]

    try:
        results, optional_failures = await asyncio.to_thread(
            _run_bundle_parallel,
            queries,
            required=(
                {"summary", "timeseries"}
                if source_scoped
                else {"summary", "products", "timeseries"}
            ),
            timeout=20.0,
        )

        # Format responses
        response = {
            "availability": "partial" if optional_failures else "available",
            "partial_reasons": optional_failures,
            "summary": _format_summary(results.get("summary"), params),
            "products": _format_products_fast(results.get("products"), params),
            "workspaces": _format_workspaces(results.get("workspaces"), params),
            "timeseries": _format_timeseries_fast(results.get("timeseries"), params),
            "etl_breakdown": _format_etl_breakdown(results.get("etl_breakdown"), params),
            "is_fast_mode": True,
            "using_materialized_views": use_mv,
        }

        # Override workspace_count with most-recent-day count (both MV and non-MV paths).
        # MV summary computes COUNT(DISTINCT) over the full period which is always larger
        # than any daily count and mismatches the "Daily Active Workspaces" trend chart.
        if id_list:
            # With an explicit filter this KPI communicates filter scope, not
            # whether every selected workspace happened to bill on the last day.
            response["summary"]["workspace_count"] = len(id_list)
        else:
            wc_results = results.get("workspace_count")
            if wc_results and len(wc_results) > 0:
                accurate_count = int(wc_results[0].get("workspace_count") or 0)
                if accurate_count > 0:
                    response["summary"]["workspace_count"] = accurate_count

        delta_cache_put(
            _dkey,
            "billing:dashboard-bundle-fast:v2",
            response,
            ttl_seconds=(
                60
                if optional_failures
                else cache_ttls.BUNDLE_FILTERED if id_list else cache_ttls.BUNDLE
            ),
            generation=_cache_generation,
        )
        return response
    except Exception as e:
        logger.error("dashboard-bundle-fast failed: %s", e)
        return {
            "availability": "error",
            "error": str(e),
            "summary": _format_summary(None, params),
            "products": _format_products_fast(None, params),
            "workspaces": _format_workspaces(None, params),
            "timeseries": _format_timeseries_fast(None, params),
            "etl_breakdown": _format_etl_breakdown(None, params),
            "is_fast_mode": True,
            "using_materialized_views": use_mv,
        }


def _format_products_fast(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format fast products query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "category": row.get("product_category"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "workspace_count": int(row.get("workspace_count") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_timeseries_fast(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format fast timeseries query results."""
    if not results:
        return {"timeseries": [], "categories": [], "start_date": params["start_date"], "end_date": params["end_date"]}

    categories = set()
    timeseries_map: dict[str, dict[str, Any]] = {}

    for row in results:
        date = str(row.get("usage_date"))
        category = row.get("product_category") or "Other"
        spend = float(row.get("total_spend") or 0)

        categories.add(category)

        if date not in timeseries_map:
            timeseries_map[date] = {"date": date}

        timeseries_map[date][category] = spend

    timeseries = sorted(timeseries_map.values(), key=lambda x: x["date"])

    return {
        "timeseries": timeseries,
        "categories": sorted(list(categories)),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_summary(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format summary query results."""
    if not results:
        return {"error": "Summary data not available"}

    row = results[0] if results else {}
    total_dbus = float(row.get("total_dbus") or 0)
    total_spend = float(row.get("total_spend") or 0)
    workspace_count = int(row.get("workspace_count") or 0)
    days_in_range = int(row.get("days_in_range") or 1)
    avg_daily_spend = total_spend / days_in_range if days_in_range > 0 else 0

    return {
        "total_dbus": total_dbus,
        "total_spend": total_spend,
        "workspace_count": workspace_count,
        "days_in_range": days_in_range,
        "avg_daily_spend": avg_daily_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "first_date": str(row.get("first_date")) if row.get("first_date") else None,
        "last_date": str(row.get("last_date")) if row.get("last_date") else None,
    }


def _format_products(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format products query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "category": row.get("product_category"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "workspace_count": int(row.get("workspace_count") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _infer_workspace_region(name: str | None, cloud: str | None) -> str | None:
    """Best-effort region from a workspace/deployment name when Account API metadata is absent."""
    value = (name or "").lower()
    provider = (cloud or "").lower()
    patterns = {
        "aws": r"\b((?:us|eu|ap|sa|ca|me|af|il)-(?:central|east|west|north|south)-\d)\b",
        "gcp": (
            r"\b((?:(?:us|northamerica|southamerica|europe|asia|australia)-"
            r"(?:central|east|west|north|south)\d)|(?:central|east|west)\d)\b"
        ),
        "azure": (
            r"\b((?:east|west|north|south|central)(?:us|europe|asia|india|japan|"
            r"australia|canada|uk|france|germany|norway|switzerland|korea)\d*)\b"
        ),
    }
    match = re.search(patterns.get(provider, r"$^"), value)
    return match.group(1) if match else None


def _format_workspaces(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format workspaces query results."""
    if not results:
        return {"workspaces": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    # Admin pref: when workspace display names are turned off, show IDs even where a
    # name resolved. `historical` still reflects true name availability (computed from
    # the resolved name), so the toggle never mislabels a live workspace as historical.
    try:
        from server.routers.settings import workspace_names_enabled
        show_names = workspace_names_enabled()
    except Exception:
        show_names = True
    workspaces = []
    for row in results:
        wid = row.get("workspace_id")
        # Skip rows with no workspace id — str(None) would otherwise render a bogus
        # "None" entry in every workspace dropdown across the app.
        if wid is None or str(wid).strip().lower() in ("", "none", "null"):
            continue
        wid = str(wid)
        raw_name = row.get("workspace_name")
        resolved = raw_name if (raw_name and str(raw_name).strip()) else None
        account_metadata = _account_ws_cloud_metadata.get(wid, {})
        cloud = str(account_metadata.get("cloud") or row.get("cloud") or "").lower()
        region = (
            account_metadata.get("region")
            or _infer_workspace_region(str(resolved or ""), cloud)
        )
        spend = float(row.get("total_spend") or 0)
        workspaces.append({
            "workspace_id": wid,
            "workspace_name": resolved if show_names else None,
            # No display name in billing history => the workspace no longer exists
            # in the account (deleted); surface it as "historical" in dropdowns.
            "historical": resolved is None,
            "cloud": cloud or None,
            "region": region,
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "top_products": _ensure_list(row.get("top_products")),
            "top_users": _ensure_list(row.get("top_users")),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "workspaces": workspaces,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_timeseries(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format timeseries query results."""
    if not results:
        return {"timeseries": [], "categories": [], "start_date": params["start_date"], "end_date": params["end_date"]}

    categories = set()
    timeseries_map: dict[str, dict[str, Any]] = {}

    for row in results:
        date = str(row.get("usage_date"))
        category = row.get("product_category") or "Other"
        spend = float(row.get("total_spend") or 0)

        categories.add(category)

        if date not in timeseries_map:
            timeseries_map[date] = {"date": date}

        timeseries_map[date][category] = spend

    timeseries = sorted(timeseries_map.values(), key=lambda x: x["date"])

    return {
        "timeseries": timeseries,
        "categories": sorted(list(categories)),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_sql_breakdown(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format SQL breakdown query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "product": row.get("sql_product"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_etl_breakdown(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format ETL breakdown query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "product": row.get("etl_type"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_pipeline_objects(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format pipeline objects query results."""
    if not results:
        return {"objects": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    objects = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        objects.append({
            "object_type": row.get("object_type"),
            "object_id": row.get("object_id"),
            "object_name": row.get("object_name"),
            "workspace_id": str(row.get("workspace_id") or ""),
            "object_state": row.get("object_state"),
            "owner": row.get("owner"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "total_runs": int(row.get("total_runs") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "objects": objects,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_interactive(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format interactive breakdown query results."""
    if not results:
        return {"items": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    items = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        items.append({
            "cluster_id": row.get("cluster_id"),
            "notebook_path": row.get("notebook_path"),
            "user": row.get("run_as_user"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "days_active": int(row.get("days_active") or 0),
            "notebook_count": int(row.get("notebook_count") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "items": items,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_aws_clusters(
    cluster_results: list[dict[str, Any]] | None,
    instance_results: list[dict[str, Any]] | None,
    params: dict[str, str]
) -> dict[str, Any]:
    """Format AWS costs query results."""
    if not cluster_results:
        return {"clusters": [], "instance_families": [], "total_estimated_cost": 0, "total_dbu_hours": 0,
                "start_date": params["start_date"], "end_date": params["end_date"]}

    total_cost = sum(float(row.get("estimated_aws_cost") or 0) for row in cluster_results)
    total_dbu_hours = sum(float(row.get("total_dbu_hours") or 0) for row in cluster_results)

    clusters = []
    for row in cluster_results:
        cost = float(row.get("estimated_aws_cost") or 0)
        clusters.append({
            "cluster_id": row.get("cluster_id"),
            "cluster_name": row.get("cluster_name"),
            "driver_instance_type": row.get("driver_instance_type"),
            "worker_instance_type": row.get("worker_instance_type"),
            "cluster_source": row.get("cluster_source"),
            "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
            "estimated_aws_cost": cost,
            "days_active": int(row.get("days_active") or 0),
            "percentage": (cost / total_cost * 100) if total_cost > 0 else 0,
        })

    instance_families = []
    if instance_results:
        for row in instance_results:
            instance_families.append({
                "instance_family": row.get("instance_family"),
                "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
                "days_active": int(row.get("days_active") or 0),
            })

    return {
        "clusters": clusters,
        "instance_families": instance_families,
        "total_estimated_cost": total_cost,
        "total_dbu_hours": total_dbu_hours,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "disclaimer": "Estimated AWS costs based on standard EC2 pricing. Actual costs may vary.",
    }


def _format_aws_timeseries(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format AWS timeseries query results with instance family breakdown."""
    if not results:
        return {"timeseries": [], "instance_families": [], "start_date": params["start_date"], "end_date": params["end_date"]}

    # Aggregate by date, with per-family breakdown
    from collections import defaultdict
    date_totals: dict[str, float] = defaultdict(float)
    date_family: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    all_families: set[str] = set()

    for row in results:
        d = str(row.get("usage_date"))
        family = row.get("instance_family") or "unknown"
        cost = float(row.get("estimated_aws_cost") or 0)
        date_totals[d] += cost
        date_family[d][family] += cost
        all_families.add(family)

    # Build timeseries with total + per-family columns
    timeseries = []
    for d in sorted(date_totals.keys()):
        entry: dict[str, Any] = {"date": d, "AWS Cost": round(date_totals[d], 2)}
        for family in all_families:
            entry[family] = round(date_family[d].get(family, 0), 2)
        timeseries.append(entry)

    # Sort families by total spend descending
    family_totals = {f: sum(date_family[d].get(f, 0) for d in date_totals) for f in all_families}
    sorted_families = sorted(all_families, key=lambda f: family_totals[f], reverse=True)

    return {
        "timeseries": timeseries,
        "instance_families": sorted_families,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/sku-breakdown")
async def get_sku_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
) -> dict[str, Any]:
    """Get breakdown by SKU/product type.

    Returns spend and usage metrics grouped by SKU name.
    """
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    if not _local_source_selected():
        return _optional_breakdown_unavailable(
            "sku",
            "skus",
            params,
            SourceScopeUnsupportedError("SKU detail is local-only."),
        )
    cache_endpoint = "billing:sku-breakdown:v2"
    _dkey = bundle_cache_key(cache_endpoint, params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation(cache_endpoint)
    ws_clause = wf.build_ws_filter_clause(id_list=id_list)
    try:
        results = await asyncio.to_thread(
            execute_query,
            _inject_ws_filter(SKU_BREAKDOWN, ws_clause),
            params,
            timeout=22,
            max_rows=100,
        )
    except Exception as exc:
        return _optional_breakdown_unavailable("sku", "skus", params, exc)

    skus = []
    total_spend = 0.0

    for row in results:
        sku = {
            "product": row.get("product"),
            "workspaces_using": int(row.get("workspaces_using") or 0),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": float(row.get("total_spend") or 0),
            "percentage": float(row.get("percentage") or 0),
        }
        skus.append(sku)
        total_spend += sku["total_spend"]

    _resp = {
        "available": True,
        "availability": "available",
        "skus": skus,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }
    delta_cache_put(
        _dkey,
        cache_endpoint,
        _resp,
        ttl_seconds=cache_ttls.BUNDLE,
        generation=_cache_generation,
    )
    return _resp


_group_membership_cache: dict[str, list[str]] | None = None
_group_membership_cache_ts: float = 0
_GROUP_CACHE_TTL = cache_ttls.GROUP_MEMBERSHIP


def _get_cached_group_membership(w) -> dict[str, list[str]]:
    """Get user→groups mapping from SDK, cached for 1 hour."""
    global _group_membership_cache, _group_membership_cache_ts
    import time as _time
    now = _time.monotonic()
    if _group_membership_cache is not None and (now - _group_membership_cache_ts) < _GROUP_CACHE_TTL:
        return _group_membership_cache

    user_groups: dict[str, list[str]] = {}
    for g in w.groups.list(attributes="displayName,members", filter='displayName co ""'):
        if not g.display_name or not g.members:
            continue
        for m in g.members:
            if m.display and "@" in m.display:
                user_groups.setdefault(m.display, []).append(g.display_name)

    _group_membership_cache = user_groups
    _group_membership_cache_ts = now
    return user_groups


@router.get("/spend-by-user-group")
async def get_spend_by_user_group(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get spend breakdown by user group (falls back to top users)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Try user groups first via Databricks SDK (cached for 1 hour)
    groups = []
    total_spend = 0.0
    source = "users"

    try:
        w = get_workspace_client()
        # Build group membership map: user_name -> list of group names
        user_groups = _get_cached_group_membership(w)

        if user_groups:
            source = "groups"
            # Get per-user spend
            user_query = """
            SELECT
              COALESCE(u.identity_metadata.run_as, 'Unknown') as user_identity,
              SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
              SUM(u.usage_quantity) as total_dbus
            FROM system.billing.usage u
            /* TEMPORAL_LIST_PRICE_JOIN */
            WHERE u.usage_date BETWEEN :start_date AND :end_date
              AND u.usage_quantity > 0
              AND u.identity_metadata.run_as IS NOT NULL
              AND u.identity_metadata.run_as != 'Unknown'
            GROUP BY 1
            HAVING SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) > 0
            """
            user_results = await asyncio.to_thread(execute_query, _pool_scoped(user_query), params)

            # Aggregate spend by group
            group_spend: dict[str, dict] = {}
            for row in (user_results or []):
                user = row.get("user_identity") or ""
                spend = float(row.get("total_spend") or 0)
                dbus = float(row.get("total_dbus") or 0)
                matched_groups = user_groups.get(user, ["No Group"])
                for gname in matched_groups:
                    if gname not in group_spend:
                        group_spend[gname] = {"total_spend": 0, "total_dbus": 0, "user_count": set()}
                    group_spend[gname]["total_spend"] += spend
                    group_spend[gname]["total_dbus"] += dbus
                    group_spend[gname]["user_count"].add(user)

            for gname, data in sorted(group_spend.items(), key=lambda x: x[1]["total_spend"], reverse=True)[:15]:
                groups.append({
                    "group_name": gname,
                    "total_spend": data["total_spend"],
                    "total_dbus": data["total_dbus"],
                    "user_count": len(data["user_count"]),
                })
                total_spend += data["total_spend"]
    except Exception as e:
        logger.warning(f"Group lookup failed, falling back to users: {e}")

    # Fallback: top users by spend
    if not groups:
        source = "users"
        query = """
        SELECT
          u.identity_metadata.run_as as group_name,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
          SUM(u.usage_quantity) as total_dbus,
          1 as user_count
        FROM system.billing.usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.identity_metadata.run_as IS NOT NULL
        GROUP BY 1
        HAVING SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) > 0
        ORDER BY total_spend DESC
        LIMIT 15
        """
        try:
            results = await asyncio.to_thread(execute_query, _pool_scoped(query), params)
        except Exception as e:
            logger.warning(f"User spend query failed: {e}")
            return {"groups": [], "total_spend": 0, "error": str(e)}

        for row in (results or []):
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            name = row.get("group_name") or ""
            if not name or name == "Unknown":
                continue
            groups.append({
                "group_name": name.split("@")[0] if "@" in name else name,
                "total_spend": spend,
                "total_dbus": float(row.get("total_dbus") or 0),
                "user_count": int(row.get("user_count") or 0),
            })

    # Calculate percentages
    for g in groups:
        g["percentage"] = round((g["total_spend"] / total_spend * 100) if total_spend > 0 else 0, 1)

    return {
        "groups": groups,
        "total_spend": total_spend,
        "source": source,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/spend-anomalies")
async def get_spend_anomalies(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get days with largest day-over-day spend changes.

    Returns top 20 days with biggest absolute percentage changes in spend.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = await asyncio.to_thread(execute_query, _pool_scoped(SPEND_ANOMALIES), params)

    # Effective spike threshold folds in the admin's anomaly-sensitivity setting
    # (low/medium/high → base threshold × 1.5/1.0/0.5). Additive: each row is flagged
    # is_spike so consumers can highlight true anomalies without a contract change.
    try:
        from server.routers.settings import anomaly_spike_threshold
        spike_threshold = anomaly_spike_threshold()
    except Exception:
        spike_threshold = 20.0

    anomalies = []

    for row in results:
        change_percent = float(row.get("change_percent") or 0)
        anomaly = {
            "usage_date": str(row.get("usage_date")),
            "daily_spend": float(row.get("daily_spend") or 0),
            "prev_day_spend": float(row.get("prev_day_spend") or 0),
            "change_amount": float(row.get("change_amount") or 0),
            "change_percent": change_percent,
            "is_spike": abs(change_percent) >= spike_threshold,
        }
        anomalies.append(anomaly)

    return {
        "anomalies": anomalies,
        "spike_threshold_percent": spike_threshold,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/platform-kpis")
async def get_platform_kpis(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    fast: bool = Query(default=True, description="Use fast mode (skips query.history)"),
) -> dict[str, Any]:
    """Get platform KPIs showing value and accomplishments.

    Returns key metrics like total queries, jobs, data processed,
    unique users, and other metrics demonstrating platform value.

    Set fast=true (default) to skip slow query.history joins.
    When materialized views are available, query stats are included even in fast mode.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Initialize response with defaults
    response = {
        "total_queries": 0,
        "unique_query_users": 0,
        "total_rows_read": 0,
        "total_bytes_read": 0,
        "total_compute_seconds": 0,
        "total_jobs": 0,
        "total_job_runs": 0,
        "successful_runs": 0,
        "successful_runs_available": False,
        "total_job_run_hours": 0,
        "unique_job_owners": 0,
        "active_workspaces": 0,
        "active_notebooks": 0,
        "models_served": 0,
        "total_serving_dbus": 0,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }

    # Check if we can use materialized views for query stats
    use_mv = await asyncio.to_thread(_check_mv_available)

    if use_mv:
        # Try to get query stats from materialized view (fast!)
        try:
            mv_results = await asyncio.to_thread(_exec_mv, MV_PLATFORM_KPIS, params, _mv_ws_clause(None))
            if mv_results and len(mv_results) > 0:
                mv_row = mv_results[0]
                response["total_queries"] = int(mv_row.get("total_queries") or 0)
                response["unique_query_users"] = int(mv_row.get("unique_query_users") or 0)
                response["total_rows_read"] = int(mv_row.get("total_rows_read") or 0)
                response["total_bytes_read"] = int(mv_row.get("total_bytes_read") or 0)
                response["total_compute_seconds"] = float(mv_row.get("total_compute_seconds") or 0)
                logger.info("Platform KPIs: Using materialized views for query stats")
        except Exception as e:
            logger.debug(f"MV query stats failed: {e}")

    # Get billing-based stats (always use fast query for these)
    from server import workspace_filter as wf
    kpi_ws_clause = wf.build_ws_filter_clause(col="workspace_id")
    query = (PLATFORM_KPIS_FAST if fast or use_mv else PLATFORM_KPIS).format(
        ws_filter=kpi_ws_clause
    )
    query = _inject_ws_filter(query, kpi_ws_clause)
    results = await asyncio.to_thread(execute_query, query, params)

    if results and len(results) > 0:
        row = results[0]

        # If we didn't get query stats from MV, try to get them from the query results
        if not use_mv and not fast:
            response["total_queries"] = int(row.get("total_queries") or 0)
            response["unique_query_users"] = int(row.get("unique_query_users") or 0)
            response["total_rows_read"] = int(row.get("total_rows_read") or 0)
            response["total_bytes_read"] = int(row.get("total_bytes_read") or 0)
            response["total_compute_seconds"] = float(row.get("total_compute_seconds") or 0)

        # Always get billing-based metrics (including unique_job_owners and lakeflow stats)
        response["total_jobs"] = int(row.get("total_jobs") or 0)
        response["total_job_runs"] = int(row.get("total_job_runs") or 0)
        response["successful_runs"] = int(row.get("successful_runs") or 0)
        response["successful_runs_available"] = bool(row.get("result_state_available"))
        response["unique_job_owners"] = int(row.get("unique_job_owners") or 0)
        response["active_workspaces"] = int(row.get("active_workspaces") or 0)
        response["active_notebooks"] = int(row.get("active_notebooks") or 0)
        response["models_served"] = int(row.get("models_served") or 0)
        response["total_serving_dbus"] = float(row.get("total_serving_dbus") or 0)

    return response


@router.get("/kpis-bundle")
async def get_kpis_bundle(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
) -> dict[str, Any]:
    """Bundled KPIs endpoint: runs platform KPIs and spend anomalies in parallel."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    if selected_source_labels():
        try:
            source_label_filter_clause(MV_PLATFORM_KPIS)
        except SQLExecutionError as exc:
            return {
                "kpis": {
                    "total_queries": 0, "unique_query_users": 0, "query_users_available": False,
                    "total_rows_read": 0, "total_bytes_read": 0, "total_compute_seconds": 0,
                    "total_jobs": 0, "total_job_runs": 0, "successful_runs": 0,
                    "successful_runs_available": False, "total_job_run_hours": 0,
                    "unique_job_owners": 0, "active_workspaces": 0, "avg_daily_workspaces": 0,
                    "active_notebooks": 0, "total_clusters": 0, "sql_warehouses": 0,
                    "models_served": 0, "total_serving_dbus": 0, "avg_daily_models": 0,
                    "avg_daily_query_users": 0, "total_workspace_count": 0,
                    "stickiness_pct": None, "stickiness_available": False,
                    "start_date": params["start_date"], "end_date": params["end_date"],
                    "error": "Selected source does not include platform KPI aggregates.",
                    "error_code": exc.code,
                },
                "anomalies": {
                    "anomalies": [],
                    "available": False,
                    "unavailable_reason": "Selected source does not include KPI anomaly data.",
                    "start_date": params["start_date"],
                    "end_date": params["end_date"],
                },
            }

    # Delta cross-worker cache
    _dkey = bundle_cache_key("billing:kpis-bundle:v2", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation("billing:kpis-bundle:v2")

    ws_clause = wf.build_ws_filter_clause(id_list=id_list)

    # Determine which KPI query to run
    use_mv = await asyncio.to_thread(_check_mv_available)

    # Supplemental query for accurate user count (MV uses MAX of daily counts which under-counts)
    catalog, schema = get_catalog_schema()
    USER_COUNT_QUERY = """
    SELECT COUNT(DISTINCT executed_by) as unique_query_users
    FROM `{catalog}`.`{schema}`.`dbsql_cost_per_query`
    WHERE start_time >= :start_date AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
      AND executed_by IS NOT NULL
      {ws_filter}
    """
    STICKINESS_PCT_QUERY = """
    WITH total_users AS (
      SELECT COUNT(DISTINCT executed_by) AS total
      FROM `{catalog}`.`{schema}`.`dbsql_cost_per_query`
      WHERE start_time >= :start_date
        AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
        AND executed_by IS NOT NULL
        {ws_filter}
    ),
    daily_users AS (
      SELECT DATE(start_time) AS usage_date, COUNT(DISTINCT executed_by) AS dau
      FROM `{catalog}`.`{schema}`.`dbsql_cost_per_query`
      WHERE start_time >= :start_date
        AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
        AND executed_by IS NOT NULL
        {ws_filter}
      GROUP BY DATE(start_time)
    )
    SELECT ROUND(AVG(100.0 * d.dau / NULLIF(t.total, 0)), 1) AS stickiness_pct
    FROM daily_users d CROSS JOIN total_users t
    """
    ANOMALIES_MV_QUERY = """
    WITH daily_stats AS (
      SELECT usage_date, SUM(total_spend) AS daily_spend
      FROM `{catalog}`.`{schema}`.`daily_usage_summary`
      WHERE usage_date BETWEEN :start_date AND :end_date
        {ws_filter}
      GROUP BY usage_date
    ),
    with_lag AS (
      SELECT
        usage_date,
        daily_spend,
        LAG(daily_spend) OVER (ORDER BY usage_date) AS prev_day_spend
      FROM daily_stats
    )
    SELECT
      usage_date,
      daily_spend,
      prev_day_spend,
      daily_spend - prev_day_spend AS change_amount,
      ROUND(
        100.0 * (daily_spend - prev_day_spend) / NULLIF(prev_day_spend, 0),
        2
      ) AS change_percent
    FROM with_lag
    WHERE prev_day_spend IS NOT NULL
      AND prev_day_spend > 0
    ORDER BY ABS(change_percent) DESC
    LIMIT 20
    """
    ACTIVE_WORKSPACES_MV_QUERY = """
    SELECT COUNT(DISTINCT workspace_id) AS active_workspaces
    FROM `{catalog}`.`{schema}`.`daily_workspace_breakdown`
    WHERE usage_date BETWEEN :start_date AND :end_date
      {ws_filter}
    """

    # Direct Delta query for query stats — used as fallback if Lakebase daily_query_stats is empty
    mv_ws = _mv_ws_clause(id_list)
    delta_query_stats_sql = MV_PLATFORM_KPIS.format(catalog=catalog, schema=schema, ws_filter=mv_ws)

    # BILLING_KPIS_FAST has no table alias — use unqualified column name for the workspace filter.
    # ws_clause uses "u.workspace_id" (for aliased queries); build a separate clause here.
    billing_ws_clause = wf.build_ws_filter_clause(id_list=id_list, col="workspace_id")
    billing_kpis_sql = _inject_ws_filter(BILLING_KPIS_FAST, billing_ws_clause)
    lakeflow_ws_clause = wf.build_ws_filter_clause(id_list=id_list, col="workspace_id")
    lakeflow_kpis_sql = LAKEFLOW_JOB_STATS.format(ws_filter=lakeflow_ws_clause)

    # Run billing and lakeflow queries separately so a lakeflow permission failure
    # doesn't zero out the billing-backed KPIs (jobs, workspaces, clusters).
    parallel_queries: list[tuple[str, Any]] = []
    if _local_source_selected():
        parallel_queries.extend([
            ("billing_kpis", lambda: execute_query(billing_kpis_sql, params)),
            ("lakeflow_kpis", lambda: execute_query(lakeflow_kpis_sql, params)),
        ])
    source_labels = selected_source_labels()
    anomaly_source_filter = source_label_filter_clause(ANOMALIES_MV_QUERY)
    if use_mv and (not source_labels or anomaly_source_filter):
        anomalies_sql = _get_mv_query(ANOMALIES_MV_QUERY, mv_ws)
        parallel_queries.append(("anomalies", lambda: execute_query(anomalies_sql, params)))
    elif (
        not source_labels
        or all(label == get_local_source_label() for label in source_labels)
    ):
        # A local-only selection can truthfully use the local system table. Never
        # use it for shared or mixed selections: that would ignore the chosen scope.
        anomalies_sql = _inject_ws_filter(SPEND_ANOMALIES, ws_clause)
        parallel_queries.append(("anomalies", lambda: execute_query(anomalies_sql, params)))
    if use_mv:
        avg_daily_ws_sql = _get_mv_query(AVG_DAILY_WORKSPACES, mv_ws)
        parallel_queries.append(("avg_daily_ws", lambda: execute_query(avg_daily_ws_sql, params)))
        active_workspaces_sql = _get_mv_query(ACTIVE_WORKSPACES_MV_QUERY, mv_ws)
        parallel_queries.append((
            "active_workspaces",
            lambda: execute_query(active_workspaces_sql, params),
        ))
        avg_daily_users_sql = _get_mv_query(AVG_DAILY_QUERY_USERS_MV, mv_ws)
        parallel_queries.append(("avg_daily_query_users", lambda: execute_query(avg_daily_users_sql, params)))

    # delta_query_stats is a Delta-direct fallback; skip it when MV is available to avoid redundant scan
    if use_mv:
        parallel_queries.append(("mv_kpis", lambda: _exec_mv(MV_PLATFORM_KPIS, params, mv_ws)))
    else:
        parallel_queries.append(("delta_query_stats", lambda: execute_query(delta_query_stats_sql, params)))

    # Supplemental user count from the managed query-level table. Routing can be
    # unavailable for a selected shared source; keep the rest of the bundle usable
    # and expose this KPI as unavailable instead of failing or changing population.
    try:
        user_count_sql = _get_mv_query(USER_COUNT_QUERY, mv_ws)
        parallel_queries.append(("user_count", lambda: execute_query(user_count_sql, params)))
    except Exception as exc:
        logger.warning("Managed query-user count is unavailable: %s", exc)
    # Workspace count (all-time) and avg daily model endpoints — fast billing scans
    if _local_source_selected():
        total_workspaces_sql = (
            f"{TOTAL_WORKSPACES_ALLTIME.rstrip()}\n"
            f"WHERE 1 = 1\n  {billing_ws_clause}"
        )
        parallel_queries.append((
            "total_workspaces",
            lambda: execute_query(total_workspaces_sql, {}),
        ))
        avg_daily_models_sql = _inject_ws_filter(AVG_DAILY_MODELS, billing_ws_clause)
        parallel_queries.append(("avg_daily_models", lambda: execute_query(avg_daily_models_sql, params)))
    # Stickiness uses the same query-level MV as the unique-user card and trend.
    # This keeps source-label, workspace, and date scope identical across both.
    try:
        stickiness_sql = _get_mv_query(STICKINESS_PCT_QUERY, mv_ws)
        parallel_queries.append(("stickiness_pct", lambda: execute_query(stickiness_sql, params)))
    except Exception as exc:
        logger.warning("Managed query-user stickiness is unavailable: %s", exc)

    required_queries = (
        {"billing_kpis"} if _local_source_selected() else {"active_workspaces"}
    )
    required_queries.add("mv_kpis" if use_mv else "delta_query_stats")
    try:
        query_results, optional_failures = await asyncio.to_thread(
            _run_bundle_parallel,
            parallel_queries,
            required=required_queries,
            timeout=90.0,
        )
    except Exception as e:
        logger.error("kpis-bundle query execution failed: %s", e)
        return {"kpis": {
            "total_queries": 0, "unique_query_users": 0, "query_users_available": False,
            "total_rows_read": 0, "total_bytes_read": 0, "total_compute_seconds": 0,
            "total_jobs": 0, "total_job_runs": 0, "successful_runs": 0, "successful_runs_available": False, "total_job_run_hours": 0,
            "unique_job_owners": 0, "active_workspaces": 0, "avg_daily_workspaces": 0,
            "active_notebooks": 0, "total_clusters": 0, "sql_warehouses": 0,
            "models_served": 0, "total_serving_dbus": 0, "avg_daily_models": 0,
            "avg_daily_query_users": 0, "total_workspace_count": 0,
            "stickiness_pct": None, "stickiness_available": False,
            "start_date": params["start_date"], "end_date": params["end_date"],
            "error": str(e),
            "error_code": str(getattr(e, "code", "KPI_BUNDLE_FAILED")),
        }, "anomalies": {
            "anomalies": [], "available": False,
            "unavailable_reason": "Spend anomaly data could not be loaded",
            "start_date": params["start_date"], "end_date": params["end_date"],
        }}

    # --- Build KPIs response ---
    kpis_response = {
        "total_queries": 0, "unique_query_users": 0, "query_users_available": False,
        "query_metrics_available": True,
        "local_billing_available": _local_source_selected(),
        "total_rows_read": 0, "total_bytes_read": 0, "total_compute_seconds": 0,
        "total_jobs": 0, "total_job_runs": 0, "successful_runs": 0, "successful_runs_available": False, "total_job_run_hours": 0,
        "unique_job_owners": 0, "active_workspaces": 0, "avg_daily_workspaces": 0,
        "active_notebooks": 0, "total_clusters": 0, "sql_warehouses": 0,
        "models_served": 0, "total_serving_dbus": 0, "avg_daily_models": 0,
        "avg_daily_query_users": 0, "total_workspace_count": 0,
        "stickiness_pct": None, "stickiness_available": False,
        "start_date": params["start_date"], "end_date": params["end_date"],
    }

    # Apply query stats: MV (Lakebase) first, fall back to Delta if result is empty/zero
    def _apply_query_stats(row: dict) -> None:
        kpis_response["total_queries"] = int(row.get("total_queries") or 0)
        kpis_response["total_rows_read"] = int(row.get("total_rows_read") or 0)
        kpis_response["total_bytes_read"] = int(row.get("total_bytes_read") or 0)
        kpis_response["total_compute_seconds"] = float(row.get("total_compute_seconds") or 0)

    mv_results = query_results.get("mv_kpis")
    mv_has_data = mv_results and len(mv_results) > 0 and int(mv_results[0].get("total_queries") or 0) > 0
    if mv_has_data:
        _apply_query_stats(mv_results[0])
    else:
        # Lakebase daily_query_stats may be empty — use Delta copy directly
        delta_qs = query_results.get("delta_query_stats")
        if delta_qs and len(delta_qs) > 0:
            _apply_query_stats(delta_qs[0])

    # Billing-backed KPIs: total_jobs, total_job_runs, active_workspaces, clusters, models
    billing_results = query_results.get("billing_kpis") if _local_source_selected() else None
    if billing_results and len(billing_results) > 0:
        row = billing_results[0]
        kpis_response["total_jobs"] = int(row.get("total_jobs") or 0)
        kpis_response["total_job_runs"] = int(row.get("total_job_runs") or 0)
        kpis_response["unique_job_owners"] = int(row.get("unique_job_owners") or 0)
        kpis_response["active_workspaces"] = int(row.get("active_workspaces") or 0)
        total_clusters = int(row.get("total_clusters") or 0)
        sql_warehouses = int(row.get("sql_warehouses") or 0)
        kpis_response["total_clusters"] = total_clusters
        kpis_response["sql_warehouses"] = sql_warehouses
        # Kept under the legacy response key for API compatibility. This KPI now
        # represents all compute resources, including serverless SQL warehouses.
        kpis_response["active_notebooks"] = total_clusters + sql_warehouses
        kpis_response["models_served"] = int(row.get("models_served") or 0)
        kpis_response["total_serving_dbus"] = float(row.get("total_serving_dbus") or 0)
        if (
            float(row.get("sql_dbus") or 0) > 0
            and kpis_response["total_queries"] == 0
        ):
            kpis_response["query_metrics_available"] = False

    scoped_workspace_results = query_results.get("active_workspaces")
    if scoped_workspace_results:
        kpis_response["active_workspaces"] = int(
            scoped_workspace_results[0].get("active_workspaces") or 0
        )

    avg_daily_ws_results = query_results.get("avg_daily_ws")
    if avg_daily_ws_results and len(avg_daily_ws_results) > 0:
        val = avg_daily_ws_results[0].get("avg_daily_workspaces")
        if val is not None:
            kpis_response["avg_daily_workspaces"] = int(val)

    # Lakeflow-backed KPIs: successful_runs, total_job_run_hours (may be missing if lakeflow is inaccessible)
    lakeflow_results = query_results.get("lakeflow_kpis") if _local_source_selected() else None
    if lakeflow_results and len(lakeflow_results) > 0:
        kpis_response["successful_runs"] = int(lakeflow_results[0].get("successful_runs") or 0)
        kpis_response["successful_runs_available"] = bool(lakeflow_results[0].get("result_state_available"))
        kpis_response["total_job_run_hours"] = int(lakeflow_results[0].get("total_run_hours") or 0)

    avg_daily_users_results = query_results.get("avg_daily_query_users")
    if avg_daily_users_results and len(avg_daily_users_results) > 0:
        val = avg_daily_users_results[0].get("avg_daily_query_users")
        if val is not None:
            kpis_response["avg_daily_query_users"] = int(val)

    total_ws_results = query_results.get("total_workspaces") if _local_source_selected() else None
    if total_ws_results and len(total_ws_results) > 0:
        kpis_response["total_workspace_count"] = int(total_ws_results[0].get("total_workspaces") or 0)

    avg_daily_models_results = query_results.get("avg_daily_models") if _local_source_selected() else None
    if avg_daily_models_results and len(avg_daily_models_results) > 0:
        kpis_response["avg_daily_models"] = int(avg_daily_models_results[0].get("avg_daily_models") or 0)

    stickiness_results = query_results.get("stickiness_pct")
    if stickiness_results is not None and len(stickiness_results) > 0:
        kpis_response["stickiness_available"] = True
        val = stickiness_results[0].get("stickiness_pct")
        if val is not None:
            kpis_response["stickiness_pct"] = float(val)

    # Query-user KPIs use only dbsql_cost_per_query. Do not fall back to
    # daily_query_stats/system.query.history because those populations differ.
    uc_results = query_results.get("user_count")
    if uc_results is not None and len(uc_results) > 0:
        kpis_response["query_users_available"] = True
        accurate_users = int(uc_results[0].get("unique_query_users") or 0)
        kpis_response["unique_query_users"] = accurate_users

    # Stale-fallback: if local billing-backed KPIs are all zero (query failed or
    # warehouse cold), serve only a result from the exact date/workspace/source
    # scope. Shared-only scopes deliberately skip this fallback: local system
    # tables cannot validate that population, and an unfiltered stale response
    # would silently replace correctly scoped managed-table KPIs.
    stale_key = _kpis_stale_key(
        params["start_date"],
        params["end_date"],
        id_list,
        source_labels,
    )
    stale_fallback_allowed = not source_labels or get_local_source_label() in source_labels
    billing_has_data = (
        kpis_response.get("total_jobs", 0) > 0
        or kpis_response.get("active_workspaces", 0) > 0
        or kpis_response.get("total_job_runs", 0) > 0
    )
    if billing_has_data and stale_fallback_allowed:
        _kpis_stale[stale_key] = {k: v for k, v in kpis_response.items()}
    elif stale_fallback_allowed and stale_key in _kpis_stale:
        logger.warning(
            "Billing KPIs are all zero; serving exact-scope stale response to prevent zero-flash"
        )
        kpis_response = dict(_kpis_stale[stale_key])
        kpis_response["data_stale"] = True

    # --- Build anomalies response ---
    anomaly_results = query_results.get("anomalies") or []
    anomalies_available = (
        "anomalies" in query_results
        and query_results.get("anomalies") is not None
    )
    anomalies = []
    for row in anomaly_results:
        anomalies.append({
            "usage_date": str(row.get("usage_date")),
            "daily_spend": float(row.get("daily_spend") or 0),
            "prev_day_spend": float(row.get("prev_day_spend") or 0),
            "change_amount": float(row.get("change_amount") or 0),
            "change_percent": float(row.get("change_percent") or 0),
        })

    _kpis_resp = {
        "availability": "partial" if optional_failures else "available",
        "partial_reasons": optional_failures,
        "kpis": kpis_response,
        "anomalies": {
            "anomalies": anomalies,
            "available": anomalies_available,
            **({} if anomalies_available else {
                "unavailable_reason": "Spend anomalies are unavailable for the selected data sources",
            }),
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        },
    }
    # Anomaly surfaces need fresher data — cap at 5 min regardless of scope
    delta_cache_put(
        _dkey,
        "billing:kpis-bundle:v2",
        _kpis_resp,
        ttl_seconds=60 if optional_failures else cache_ttls.KPI,
        generation=_cache_generation,
    )
    return _kpis_resp


@router.get("/kpi-trend")
async def get_kpi_trend(
    kpi: str = Query(..., description="KPI to fetch trend for: total_spend, total_dbus, avg_daily_spend, workspace_count, aiml_spend, aiml_dbus, aiml_endpoints, tagged_spend, untagged_spend, infra_cost, infra_clusters, infra_dbu_hours"),
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    granularity: str = Query("daily", description="Granularity: daily, weekly, monthly"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
    tab: str = Query("dbu", description="Dashboard tab that owns this trend cache"),
) -> dict[str, Any]:
    """Get trend data for a specific KPI over time."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    owner_tab = (
        tab
        if isinstance(tab, str)
        and tab in {"dbu", "sql", "aiml", "tagging", "infra", "users-groups"}
        else "dbu"
    )
    cache_endpoint = f"trend:{owner_tab}:billing-kpi"

    _dkey = bundle_cache_key(f"{cache_endpoint}:{kpi}:{granularity}", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation(cache_endpoint)
    def _resp(data: dict) -> dict:
        delta_cache_put(_dkey, cache_endpoint, data, ttl_seconds=cache_ttls.TREND, generation=_cache_generation)
        return data

    ws_clause = wf.build_ws_filter_clause(col="workspace_id", id_list=id_list)

    use_mv = await asyncio.to_thread(_check_mv_available)

    unavailable_reason = None
    if selected_source_labels() and not _local_source_selected() and kpi not in {
        "total_spend",
        "avg_daily_spend",
        "total_dbus",
        "workspace_count",
        "user_spend",
        "sql_spend",
        "infra_cost",
        "avg_cost_per_cluster",
    }:
        unavailable_reason = (
            "This KPI is derived from local-only system tables and is unavailable "
            "for the selected shared-source scope."
        )
    if unavailable_reason:
        return _resp({
            "kpi": kpi,
            "granularity": granularity,
            "available": False,
            "unavailable_reason": unavailable_reason,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat",
            },
        })

    # Build query based on KPI type — use MVs when available for daily-aggregation KPIs
    # mv_fallback_query is set when using an MV so we can fall back to live if MV is empty
    mv_fallback_query = None

    if kpi == "total_spend" or kpi == "avg_daily_spend":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, SUM(total_spend) as value FROM `{catalog}`.`{schema}`.`daily_usage_summary` WHERE usage_date BETWEEN :start_date AND :end_date {ws_clause} {source_label_filter_clause()} GROUP BY usage_date ORDER BY usage_date"
            mv_fallback_query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
        else:
            query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "total_dbus":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, SUM(total_dbus) as value FROM `{catalog}`.`{schema}`.`daily_usage_summary` WHERE usage_date BETWEEN :start_date AND :end_date {ws_clause} {source_label_filter_clause()} GROUP BY usage_date ORDER BY usage_date"
            mv_fallback_query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
        else:
            query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "workspace_count":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, COUNT(DISTINCT workspace_id) as value FROM `{catalog}`.`{schema}`.`daily_usage_summary` WHERE usage_date BETWEEN :start_date AND :end_date {ws_clause} {source_label_filter_clause()} GROUP BY usage_date ORDER BY usage_date"
            mv_fallback_query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT workspace_id) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
        else:
            query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT workspace_id) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_spend":
        query = """
        WITH filtered_usage AS (
          SELECT *
          FROM system.billing.usage u
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND (
              u.billing_origin_product IN ('MODEL_SERVING', 'VECTOR_SEARCH')
              OR u.sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
              OR u.sku_name LIKE '%ANTHROPIC%'
              OR u.sku_name LIKE '%OPENAI%'
              OR u.sku_name LIKE '%GEMINI%'
              OR u.sku_name LIKE '%INFERENCE%'
              OR u.sku_name LIKE '%FINE_TUNING%'
            )
        ),
        usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM filtered_usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_dbus":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND (
            billing_origin_product IN ('MODEL_SERVING', 'VECTOR_SEARCH')
            OR sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
            OR sku_name LIKE '%ANTHROPIC%'
            OR sku_name LIKE '%OPENAI%'
            OR sku_name LIKE '%GEMINI%'
            OR sku_name LIKE '%INFERENCE%'
            OR sku_name LIKE '%FINE_TUNING%'
          )
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_endpoints":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.endpoint_name) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND (
            billing_origin_product IN ('MODEL_SERVING', 'VECTOR_SEARCH')
            OR sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
            OR sku_name LIKE '%ANTHROPIC%'
            OR sku_name LIKE '%OPENAI%'
            OR sku_name LIKE '%GEMINI%'
            OR sku_name LIKE '%INFERENCE%'
            OR sku_name LIKE '%FINE_TUNING%'
          )
          AND usage_metadata.endpoint_name IS NOT NULL
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_avg_endpoint_cost":
        query = """
        WITH filtered_usage AS (
          SELECT *
          FROM system.billing.usage u
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.usage_metadata.endpoint_name IS NOT NULL
            AND (
              u.billing_origin_product IN ('MODEL_SERVING', 'VECTOR_SEARCH')
              OR u.sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
              OR u.sku_name LIKE '%ANTHROPIC%'
              OR u.sku_name LIKE '%OPENAI%'
              OR u.sku_name LIKE '%GEMINI%'
              OR u.sku_name LIKE '%INFERENCE%'
              OR u.sku_name LIKE '%FINE_TUNING%'
            )
        )
        SELECT
          u.usage_date as date,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0))
            / NULLIF(COUNT(DISTINCT u.usage_metadata.endpoint_name), 0) as value
        FROM filtered_usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
    elif kpi == "tagged_spend":
        query = """
        WITH usage_with_tags AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu,
            CASE WHEN u.custom_tags IS NOT NULL AND size(u.custom_tags) > 0 THEN true ELSE false END as has_tags
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(CASE WHEN has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as value
        FROM usage_with_tags
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "untagged_spend":
        query = """
        WITH usage_with_tags AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu,
            CASE WHEN u.custom_tags IS NOT NULL AND size(u.custom_tags) > 0 THEN true ELSE false END as has_tags
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(CASE WHEN NOT has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as value
        FROM usage_with_tags
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "infra_cost":
        query = """
        WITH filtered_usage AS (
          SELECT *
          FROM system.billing.usage u
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.usage_metadata.cluster_id IS NOT NULL
            AND (
              u.billing_origin_product = 'DLT'
              OR u.sku_name LIKE '%ALL_PURPOSE%'
              OR u.sku_name LIKE '%JOBS%'
              OR u.sku_name LIKE '%DLT%'
            )
            AND u.sku_name NOT LIKE '%SERVERLESS%'
        ),
        usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM filtered_usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "infra_clusters":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.cluster_id) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND usage_metadata.cluster_id IS NOT NULL
          AND (sku_name LIKE '%ALL_PURPOSE%' OR sku_name LIKE '%JOBS%' OR sku_name LIKE '%DLT%')
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "infra_dbu_hours":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND (sku_name LIKE '%ALL_PURPOSE%' OR sku_name LIKE '%JOBS%' OR sku_name LIKE '%DLT%')
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "avg_cost_per_cluster":
        query = """
        WITH filtered_usage AS (
          SELECT *
          FROM system.billing.usage u
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.usage_metadata.cluster_id IS NOT NULL
            AND (
              u.billing_origin_product = 'DLT'
              OR u.sku_name LIKE '%ALL_PURPOSE%'
              OR u.sku_name LIKE '%JOBS%'
              OR u.sku_name LIKE '%DLT%'
            )
            AND u.sku_name NOT LIKE '%SERVERLESS%'
        ),
        usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            u.usage_metadata.cluster_id as cluster_id,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM filtered_usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) / NULLIF(COUNT(DISTINCT cluster_id), 0) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_spend":
        query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.billing_origin_product = 'APPS'
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_dbus":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND billing_origin_product = 'APPS'
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_count":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT COALESCE(usage_metadata.app_id, 'unknown')) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND billing_origin_product = 'APPS'
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_avg_cost_per_app":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity * COALESCE(p.pricing.default, 0))
            / NULLIF(COUNT(DISTINCT COALESCE(u.usage_metadata.app_id, 'unknown')), 0) as value
        FROM system.billing.usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.billing_origin_product = 'APPS'
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "total_tags":
        query = """
        WITH tagged AS (
          SELECT u.usage_date, t.key as tag_key, t.value as tag_value
          FROM system.billing.usage u
          LATERAL VIEW EXPLODE(u.custom_tags) t AS key, value
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.custom_tags IS NOT NULL
            AND size(u.custom_tags) > 0
        )
        SELECT
          usage_date as date,
          COUNT(DISTINCT CONCAT(tag_key, ':', tag_value)) as value
        FROM tagged
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "cost_per_tag":
        query = """
        WITH tagged AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu,
            t.key as tag_key,
            t.value as tag_value
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          LATERAL VIEW EXPLODE(u.custom_tags) t AS key, value
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.custom_tags IS NOT NULL
            AND size(u.custom_tags) > 0
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu)
            / NULLIF(COUNT(DISTINCT CONCAT(tag_key, ':', tag_value)), 0) as value
        FROM tagged
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "sql_spend":
        _cat, _sch = get_catalog_schema()
        query = f"""
        SELECT
          DATE(start_time) as date,
          SUM(query_attributed_dollars_estimation) as value
        FROM `{_cat}`.`{_sch}`.`dbsql_cost_per_query`
        WHERE DATE(start_time) >= :start_date
          AND DATE(start_time) <= :end_date
          {ws_clause}
          {source_label_filter_clause()}
        GROUP BY DATE(start_time)
        ORDER BY date
        """
    elif kpi == "active_users":
        active_user_ws_clause = wf.build_ws_filter_clause(
            col="u.workspace_id",
            id_list=id_list,
        )
        query = f"""
        SELECT
          u.usage_date AS date,
          COUNT(DISTINCT COALESCE(
            u.identity_metadata.run_as,
            u.identity_metadata.created_by
          )) AS value
        FROM system.billing.usage u
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          {active_user_ws_clause}
          AND (
            u.identity_metadata.run_as IS NOT NULL
            OR u.identity_metadata.created_by IS NOT NULL
          )
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
        ws_clause = ""  # already embedded above; prevent double-injection
    elif kpi == "user_spend":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, SUM(user_attributed_spend) as value FROM `{catalog}`.`{schema}`.`daily_usage_summary` WHERE usage_date BETWEEN :start_date AND :end_date {ws_clause} {source_label_filter_clause()} GROUP BY usage_date ORDER BY usage_date"
            mv_fallback_query = """
        SELECT
          u.usage_date as date,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as value
        FROM system.billing.usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.identity_metadata.run_as IS NOT NULL
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
        else:
            query = """
        SELECT
          u.usage_date as date,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as value
        FROM system.billing.usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.identity_metadata.run_as IS NOT NULL
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
    elif kpi == "avg_spend_per_user":
        query = """
        SELECT
          u.usage_date as date,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) / NULLIF(COUNT(DISTINCT u.identity_metadata.run_as), 0) as value
        FROM system.billing.usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.identity_metadata.run_as IS NOT NULL
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
    elif kpi == "tag_coverage_pct":
        query = """
        WITH usage_with_tags AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu,
            CASE WHEN u.custom_tags IS NOT NULL AND size(u.custom_tags) > 0 THEN true ELSE false END as has_tags
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          100.0 * SUM(CASE WHEN has_tags THEN usage_quantity * price_per_dbu ELSE 0 END)
            / NULLIF(SUM(usage_quantity * price_per_dbu), 0) as value
        FROM usage_with_tags
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "power_user_spend":
        # ws_clause is embedded inline via f-string; null it out so _inject_ws_filter below is a no-op
        query = f"""
        WITH user_totals AS (
          SELECT
            u.identity_metadata.run_as AS user_email,
            SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS total_spend
          FROM system.billing.usage u
          /* TEMPORAL_LIST_PRICE_JOIN */
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.identity_metadata.run_as IS NOT NULL
            {ws_clause}
          GROUP BY u.identity_metadata.run_as
        ),
        ranked_users AS (
          SELECT
            user_email,
            NTILE(10) OVER (ORDER BY total_spend DESC) AS spend_decile
          FROM user_totals
        ),
        power_users AS (
          SELECT user_email
          FROM ranked_users
          WHERE spend_decile = 1
        )
        SELECT
          u.usage_date AS date,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS value
        FROM system.billing.usage u
        /* TEMPORAL_LIST_PRICE_JOIN */
        JOIN power_users pu ON u.identity_metadata.run_as = pu.user_email
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          {ws_clause}
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
        ws_clause = ""  # already embedded above; prevent double-injection
    else:
        return {"error": f"Unknown KPI: {kpi}"}

    results = []
    try:
        # Route the MV read through the source-union views (no-op for the live
        # fallback query, which references no MV table) so KPI trends include
        # Delta-shared sources when configured.
        _kpi_cat, _kpi_sch = get_catalog_schema()
        results = await asyncio.to_thread(
            execute_query,
            apply_mv_overrides(_inject_ws_filter(query, ws_clause), _kpi_cat, _kpi_sch),
            params,
            timeout=25,
        )
        if not results and mv_fallback_query and not selected_source_labels():
            logger.info(f"KPI trend MV returned empty for {kpi}, falling back to live query")
            results = await asyncio.to_thread(
                execute_query,
                _inject_ws_filter(mv_fallback_query, ws_clause),
                params,
                timeout=25,
            )
    except Exception as e:
        logger.error(f"KPI trend query failed for {kpi}: {e}")
        if mv_fallback_query and not selected_source_labels():
            try:
                results = await asyncio.to_thread(
                    execute_query,
                    _inject_ws_filter(mv_fallback_query, ws_clause),
                    params,
                    timeout=25,
                )
            except Exception as fallback_e:
                logger.warning(f"KPI trend fallback query also failed for {kpi}: {fallback_e}")
                results = []
        if not results:
            return {
                "kpi": kpi,
                "granularity": granularity,
                "available": False,
                "retryable": True,
                "unavailable_reason": (
                    "Trend data is temporarily unavailable because the warehouse query did not finish."
                ),
                "data_points": [],
                "summary": {
                    "period_start_value": 0,
                    "period_end_value": 0,
                    "change_amount": 0,
                    "change_percent": 0,
                    "min_value": 0,
                    "max_value": 0,
                    "avg_value": 0,
                    "trend": "flat",
                },
            }

    # Process results into daily data points
    daily_points = []
    for row in results:
        daily_points.append({
            "date": str(row["date"]),
            "value": float(row["value"] or 0)
        })

    # KPIs that represent averages/rates — use AVG when grouping into buckets
    AVG_KPIS = {
        "avg_cost_per_cluster",
        "avg_daily_spend",
        "avg_spend_per_user",
        "aiml_avg_endpoint_cost",
    }

    # Group into weekly/monthly buckets if needed
    if granularity == "weekly" and daily_points:
        from datetime import datetime, timedelta
        buckets: dict[str, list[float]] = {}
        for dp in daily_points:
            d = datetime.strptime(dp["date"], "%Y-%m-%d")
            week_start = d - timedelta(days=d.weekday())
            key = week_start.strftime("%Y-%m-%d")
            buckets.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets.keys()):
            vals = buckets[key]
            agg = sum(vals) / len(vals) if kpi in AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    elif granularity == "monthly" and daily_points:
        buckets_m: dict[str, list[float]] = {}
        for dp in daily_points:
            key = dp["date"][:7] + "-01"
            buckets_m.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets_m.keys()):
            vals = buckets_m[key]
            agg = sum(vals) / len(vals) if kpi in AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    else:
        data_points = daily_points

    # Calculate summary statistics
    all_values = [dp["value"] for dp in data_points]

    if not data_points:
        return {
            "kpi": kpi,
            "granularity": granularity,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat"
            }
        }

    period_start_value = all_values[0]
    period_end_value = all_values[-1]
    change_amount = period_end_value - period_start_value
    change_percent = (change_amount / period_start_value * 100) if period_start_value > 0 else 0

    # Determine trend
    if abs(change_percent) < 5:
        trend = "flat"
    elif change_percent > 0:
        trend = "increasing"
    else:
        trend = "decreasing"

    return _resp({
        "kpi": kpi,
        "granularity": granularity,
        "available": True,
        "data_points": data_points,
        "summary": {
            "period_start_value": round(period_start_value, 2),
            "period_end_value": round(period_end_value, 2),
            "change_amount": round(change_amount, 2),
            "change_percent": round(change_percent, 2),
            "min_value": round(min(all_values), 2),
            "max_value": round(max(all_values), 2),
            "avg_value": round(sum(all_values) / len(all_values), 2),
            "trend": trend
        }
    })

def _build_platform_kpi_response(kpi: str, granularity: str, data_points: list[dict]) -> dict[str, Any]:
    """Build the standard platform KPI trend response from a list of {date, value} points."""
    PLATFORM_AVG_KPIS = {"avg_query_duration"}
    all_values = [dp["value"] for dp in data_points]
    if not data_points:
        return {"kpi": kpi, "granularity": granularity, "data_points": [], "summary": {
            "period_start_value": 0, "period_end_value": 0, "change_amount": 0,
            "change_percent": 0, "min_value": 0, "max_value": 0, "avg_value": 0, "trend": "flat"
        }}
    period_start_value = all_values[0]
    period_end_value = all_values[-1]
    change_amount = period_end_value - period_start_value
    change_percent = (change_amount / period_start_value * 100) if period_start_value > 0 else 0
    trend = "flat" if abs(change_percent) < 5 else ("increasing" if change_percent > 0 else "decreasing")
    # For avg metrics that carry a query_count weight, use a weighted mean so the summary
    # matches the KPI card (which computes AVG over all individual queries, not daily avgs).
    if kpi in PLATFORM_AVG_KPIS and any("query_count" in dp for dp in data_points):
        total_weight = sum(dp.get("query_count", 1) for dp in data_points)
        avg_value = sum(dp["value"] * dp.get("query_count", 1) for dp in data_points) / total_weight if total_weight > 0 else 0
    else:
        avg_value = sum(all_values) / len(all_values)
    # Strip internal weight fields before returning to the client
    clean_points = [{"date": dp["date"], "value": dp["value"]} for dp in data_points]
    return {
        "kpi": kpi, "granularity": granularity, "data_points": clean_points,
        "summary": {
            "period_start_value": round(period_start_value, 2),
            "period_end_value": round(period_end_value, 2),
            "change_amount": round(change_amount, 2),
            "change_percent": round(change_percent, 2),
            "min_value": round(min(all_values), 2),
            "max_value": round(max(all_values), 2),
            "avg_value": round(avg_value, 2),
            "trend": trend,
        }
    }


@router.get("/platform-kpi-trend")
async def get_platform_kpi_trend(
    kpi: str = Query(..., description="Platform KPI: total_queries, total_rows_read, total_bytes_read, total_compute_seconds, total_jobs, total_job_runs, successful_runs, active_notebooks, active_workspaces, models_served, total_users, sql_queries, sql_users"),
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    granularity: str = Query("daily", description="Granularity: daily, weekly, monthly"),
    workspace_ids: str = Query(default=None, description="Comma-separated workspace IDs to filter"),
    tab: str = Query("kpis", description="Dashboard tab that owns this trend cache"),
) -> dict[str, Any]:
    """Get trend data for platform KPIs over time."""
    from server import workspace_filter as wf
    params, id_list = _validated_scope(start_date, end_date, workspace_ids)
    owner_tab = (
        tab
        if isinstance(tab, str) and tab in {"sql", "kpis", "users-groups"}
        else "kpis"
    )
    cache_endpoint = f"trend:{owner_tab}:platform-kpi"

    _dkey = bundle_cache_key(f"{cache_endpoint}:{kpi}:{granularity}", params["start_date"], params["end_date"], id_list)
    if (_dcached := await asyncio.to_thread(delta_cache_get, _dkey)) is not None:
        return _dcached
    _cache_generation = capture_cache_generation(cache_endpoint)
    def _resp(data: dict) -> dict:
        delta_cache_put(_dkey, cache_endpoint, data, ttl_seconds=cache_ttls.TREND, generation=_cache_generation)
        return data

    ws_clause = wf.build_ws_filter_clause(col="workspace_id", id_list=id_list)
    # KPIs sourced from system.query.history (workspace_id filter via _inject_qh_ws_filter)
    _QH_KPIS = frozenset({"total_queries", "total_rows_read", "total_bytes_read",
                           "total_compute_seconds", "avg_query_duration",
                           "unique_warehouses"})

    # User count and stickiness must always use the same managed query-level
    # population as their KPI cards. If that source is unavailable, return an
    # empty trend rather than silently switching to system.query.history.
    if kpi in {"total_users", "stickiness"}:
        period_expr = {
            "daily": "DATE(start_time)",
            "weekly": "DATE_TRUNC('WEEK', DATE(start_time))",
            "monthly": "DATE_TRUNC('MONTH', DATE(start_time))",
        }.get(granularity)
        if period_expr is None:
            return {"error": f"Unsupported granularity: {granularity}"}

        if kpi == "total_users":
            managed_user_template = f"""
            SELECT {period_expr} AS date, COUNT(DISTINCT executed_by) AS value
            FROM `{{catalog}}`.`{{schema}}`.`dbsql_cost_per_query`
            WHERE start_time >= :start_date
              AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
              AND executed_by IS NOT NULL
              {{ws_filter}}
            GROUP BY {period_expr}
            ORDER BY {period_expr}
            """
        else:
            managed_user_template = f"""
            WITH total_users AS (
              SELECT COUNT(DISTINCT executed_by) AS total
              FROM `{{catalog}}`.`{{schema}}`.`dbsql_cost_per_query`
              WHERE start_time >= :start_date
                AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
                AND executed_by IS NOT NULL
                {{ws_filter}}
            ),
            period_users AS (
              SELECT {period_expr} AS date, COUNT(DISTINCT executed_by) AS active_users
              FROM `{{catalog}}`.`{{schema}}`.`dbsql_cost_per_query`
              WHERE start_time >= :start_date
                AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
                AND executed_by IS NOT NULL
                {{ws_filter}}
              GROUP BY {period_expr}
            )
            SELECT p.date, 100.0 * p.active_users / NULLIF(t.total, 0) AS value
            FROM period_users p CROSS JOIN total_users t
            ORDER BY p.date
            """
        try:
            managed_results = await asyncio.to_thread(
                execute_query,
                _get_mv_query(managed_user_template, _mv_ws_clause(id_list)),
                params,
            )
        except Exception as exc:
            logger.warning("Managed platform KPI trend failed for %s: %s", kpi, exc)
            return _resp(_build_platform_kpi_response(kpi, granularity, []))
        managed_points = [
            {"date": str(row["date"])[:10], "value": float(row["value"] or 0)}
            for row in managed_results
        ]
        return _resp(_build_platform_kpi_response(kpi, granularity, managed_points))

    use_mv = await asyncio.to_thread(_check_mv_available)

    selected_labels = selected_source_labels()
    shared_labels_selected = any(
        label != get_local_source_label()
        for label in selected_labels
    )
    if shared_labels_selected and not (
        granularity == "daily"
        and kpi in {
            "total_queries",
            "total_rows_read",
            "total_bytes_read",
            "total_compute_seconds",
            "active_workspaces",
        }
    ):
        unavailable = _build_platform_kpi_response(kpi, granularity, [])
        unavailable.update({
            "available": False,
            "unavailable_reason": (
                "This platform KPI has no source-union managed view for the "
                "requested granularity."
            ),
        })
        return _resp(unavailable)

    # The KPI cards read these metrics from source-union-capable managed tables.
    # Their daily drilldowns must use the same tables; querying the local system
    # tables here makes a populated card open an unrelated or empty trend.
    if granularity == "daily" and use_mv:
        metric_column = {
            "total_queries": "total_queries",
            "total_rows_read": "total_rows_read",
            "total_bytes_read": "total_bytes_read",
            "total_compute_seconds": "total_compute_seconds",
        }.get(kpi)
        mv_template = None
        if metric_column:
            mv_template = f"""
            SELECT usage_date AS date, SUM({metric_column}) AS value
            FROM `{{catalog}}`.`{{schema}}`.`daily_query_stats`
            WHERE usage_date BETWEEN :start_date AND :end_date
              {{ws_filter}}
            GROUP BY usage_date
            ORDER BY usage_date
            """
        elif kpi == "active_workspaces":
            mv_template = """
            SELECT usage_date AS date, COUNT(DISTINCT workspace_id) AS value
            FROM `{catalog}`.`{schema}`.`daily_workspace_breakdown`
            WHERE usage_date BETWEEN :start_date AND :end_date
              {ws_filter}
            GROUP BY usage_date
            ORDER BY usage_date
            """
        if mv_template:
            try:
                mv_results = await asyncio.to_thread(
                    execute_query,
                    _get_mv_query(mv_template, _mv_ws_clause(id_list)),
                    params,
                )
                mv_points = [
                    {"date": str(row["date"])[:10], "value": float(row["value"] or 0)}
                    for row in mv_results
                ]
                if mv_points or selected_source_labels():
                    return _resp(_build_platform_kpi_response(kpi, granularity, mv_points))
            except Exception as exc:
                logger.warning("Managed platform KPI trend failed for %s: %s", kpi, exc)
                if selected_source_labels():
                    return _resp(_build_platform_kpi_response(kpi, granularity, []))

    # These card metrics come from local-only system tables; shared MV sources do
    # not publish their job/compute/model dimensions. Excluding the local source
    # therefore means the correctly scoped result is empty, not local account data.
    local_only_kpis = {
        "total_jobs", "total_job_runs", "successful_runs",
        "active_notebooks", "models_served",
    }
    if kpi in local_only_kpis and not _local_source_selected():
        unavailable = _build_platform_kpi_response(kpi, granularity, [])
        unavailable.update({
            "available": False,
            "unavailable_reason": (
                "This KPI uses local billing or Lakeflow data that is unavailable "
                "for the selected shared-only source."
            ),
        })
        return _resp(unavailable)

    # For DISTINCT COUNT KPIs, monthly/weekly rollup must be done in SQL — summing
    # daily distinct counts in Python overcounts (user active 30 days = 30x, not 1x).
    # We re-query with DATE_TRUNC grouping so the DB computes true monthly/weekly uniques.
    DATE_TRUNC_MAP = {"weekly": "WEEK", "monthly": "MONTH"}
    if granularity in DATE_TRUNC_MAP:
        trunc = DATE_TRUNC_MAP[granularity]
        if kpi == "active_workspaces":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', usage_date) as date,
              COUNT(DISTINCT workspace_id) as value
            FROM system.billing.usage
            WHERE usage_date >= :start_date AND usage_date <= :end_date AND usage_quantity > 0
            GROUP BY DATE_TRUNC('{trunc}', usage_date)
            ORDER BY date
            """
            results = await asyncio.to_thread(execute_query, _inject_ws_filter(query, ws_clause), params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _resp(_build_platform_kpi_response(kpi, granularity, daily_points))
        elif kpi == "total_jobs":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', usage_date) as date,
              COUNT(DISTINCT usage_metadata.job_id) as value
            FROM system.billing.usage
            WHERE usage_date >= :start_date AND usage_date <= :end_date
              AND usage_metadata.job_id IS NOT NULL AND usage_quantity > 0
            GROUP BY DATE_TRUNC('{trunc}', usage_date)
            ORDER BY date
            """
            results = await asyncio.to_thread(execute_query, _inject_ws_filter(query, ws_clause), params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _resp(_build_platform_kpi_response(kpi, granularity, daily_points))
        elif kpi == "models_served":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', usage_date) as date,
              COUNT(DISTINCT usage_metadata.endpoint_name) as value
            FROM system.billing.usage
            WHERE usage_date >= :start_date AND usage_date <= :end_date
              AND sku_name LIKE '%INFERENCE%' AND usage_quantity > 0
            GROUP BY DATE_TRUNC('{trunc}', usage_date)
            ORDER BY date
            """
            results = await asyncio.to_thread(execute_query, _inject_ws_filter(query, ws_clause), params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _resp(_build_platform_kpi_response(kpi, granularity, daily_points))
        elif kpi == "unique_warehouses":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', DATE(start_time)) as date,
              COUNT(DISTINCT warehouse_id) as value
            FROM system.query.history
            WHERE start_time >= CAST(:start_date AS TIMESTAMP)
              AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
              AND warehouse_id IS NOT NULL
            GROUP BY DATE_TRUNC('{trunc}', DATE(start_time))
            ORDER BY date
            """
            results = await asyncio.to_thread(execute_query, _inject_qh_ws_filter(query, ws_clause), params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _resp(_build_platform_kpi_response(kpi, granularity, daily_points))
        elif kpi == "sql_users":
            _cat, _sch = get_catalog_schema()
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', DATE(start_time)) as date,
              COUNT(DISTINCT executed_by) as value
            FROM `{_cat}`.`{_sch}`.`dbsql_cost_per_query`
            WHERE DATE(start_time) >= :start_date
              AND DATE(start_time) <= :end_date
            GROUP BY DATE_TRUNC('{trunc}', DATE(start_time))
            ORDER BY date
            """
            results = await asyncio.to_thread(execute_query, query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _resp(_build_platform_kpi_response(kpi, granularity, daily_points))
        elif kpi == "sql_queries":
            _cat, _sch = get_catalog_schema()
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', DATE(start_time)) as date,
              COUNT(*) as value
            FROM `{_cat}`.`{_sch}`.`dbsql_cost_per_query`
            WHERE DATE(start_time) >= :start_date
              AND DATE(start_time) <= :end_date
            GROUP BY DATE_TRUNC('{trunc}', DATE(start_time))
            ORDER BY date
            """
            results = await asyncio.to_thread(execute_query, query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _resp(_build_platform_kpi_response(kpi, granularity, daily_points))

    # Build query based on KPI type
    # Use explicit TIMESTAMP casts for partition-aware date filtering on system.query.history
    if kpi == "total_queries":
        query = """
        SELECT
          DATE(start_time) as date,
          COUNT(*) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_rows_read":
        query = """
        SELECT
          DATE(start_time) as date,
          SUM(COALESCE(read_rows, 0)) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_bytes_read":
        query = """
        SELECT
          DATE(start_time) as date,
          SUM(COALESCE(read_bytes, 0)) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_compute_seconds":
        query = """
        SELECT
          DATE(start_time) as date,
          SUM(COALESCE(total_task_duration_ms, 0)) / 1000.0 as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_jobs":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.job_id) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_metadata.job_id IS NOT NULL
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "total_job_runs":
        query = """
        SELECT
          usage_date as date,
          COUNT(*) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_metadata.job_id IS NOT NULL
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "successful_runs":
        query = f"""
        SELECT
          DATE(period_start_time) as date,
          COUNT(CASE WHEN result_state = 'SUCCEEDED' THEN 1 END) as value
        FROM system.lakeflow.job_run_timeline
        WHERE period_start_time >= :start_date
          AND period_start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
          {ws_clause}
        GROUP BY DATE(period_start_time)
        ORDER BY DATE(period_start_time)
        """
    elif kpi == "active_notebooks":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.cluster_id)
            + COUNT(DISTINCT CASE WHEN billing_origin_product = 'SQL' THEN usage_metadata.warehouse_id END) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND (usage_metadata.cluster_id IS NOT NULL OR usage_metadata.warehouse_id IS NOT NULL)
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "active_workspaces":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT workspace_id) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "models_served":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.endpoint_name) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND sku_name LIKE '%INFERENCE%'
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "avg_query_duration":
        _cat, _sch = get_catalog_schema()
        query = f"""
        SELECT
          DATE(start_time) as date,
          AVG(duration_seconds) as value,
          COUNT(*) as query_count
        FROM `{_cat}`.`{_sch}`.`dbsql_cost_per_query`
        WHERE DATE(start_time) >= :start_date
          AND DATE(start_time) <= :end_date
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "unique_warehouses":
        query = """
        SELECT
          DATE(start_time) as date,
          COUNT(DISTINCT warehouse_id) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
          AND warehouse_id IS NOT NULL
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "sql_queries":
        _cat, _sch = get_catalog_schema()
        query = f"""
        SELECT
          DATE(start_time) as date,
          COUNT(*) as value
        FROM `{_cat}`.`{_sch}`.`dbsql_cost_per_query`
        WHERE DATE(start_time) >= :start_date
          AND DATE(start_time) <= :end_date
        GROUP BY DATE(start_time)
        ORDER BY date
        """
    elif kpi == "sql_users":
        _cat, _sch = get_catalog_schema()
        query = f"""
        SELECT
          DATE(start_time) as date,
          COUNT(DISTINCT executed_by) as value
        FROM `{_cat}`.`{_sch}`.`dbsql_cost_per_query`
        WHERE DATE(start_time) >= :start_date
          AND DATE(start_time) <= :end_date
        GROUP BY DATE(start_time)
        ORDER BY date
        """
    else:
        return {"error": f"Unknown platform KPI: {kpi}"}

    try:
        filtered_query = (
            _inject_qh_ws_filter(query, ws_clause)
            if kpi in _QH_KPIS
            else query
            if kpi == "successful_runs"
            else _inject_ws_filter(query, ws_clause)
        )
        results = await asyncio.to_thread(execute_query, filtered_query, params)
    except Exception as e:
        logger.error(f"Platform KPI trend query failed for {kpi}: {e}")
        return {
            "kpi": kpi,
            "granularity": granularity,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat"
            }
        }

    # Process results into daily data points
    daily_points = []
    for row in results:
        daily_points.append({
            "date": str(row["date"]),
            "value": float(row["value"] or 0)
        })

    # KPIs that represent averages/rates — use AVG when grouping into buckets
    PLATFORM_AVG_KPIS = {"avg_query_duration"}

    # Group into weekly/monthly buckets if needed
    if granularity == "weekly" and daily_points:
        from datetime import datetime, timedelta
        buckets: dict[str, list[float]] = {}
        for dp in daily_points:
            d = datetime.strptime(dp["date"], "%Y-%m-%d")
            week_start = d - timedelta(days=d.weekday())
            key = week_start.strftime("%Y-%m-%d")
            buckets.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets.keys()):
            vals = buckets[key]
            agg = sum(vals) / len(vals) if kpi in PLATFORM_AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    elif granularity == "monthly" and daily_points:
        buckets_m: dict[str, list[float]] = {}
        for dp in daily_points:
            key = dp["date"][:7] + "-01"
            buckets_m.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets_m.keys()):
            vals = buckets_m[key]
            agg = sum(vals) / len(vals) if kpi in PLATFORM_AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    else:
        data_points = daily_points

    # Calculate summary statistics
    # Use all values (including zeros) for data points, but filter for summary
    all_values = [dp["value"] for dp in data_points]
    positive_values = [v for v in all_values if v > 0]

    if not data_points:
        return {
            "kpi": kpi,
            "granularity": granularity,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat"
            }
        }

    # Use positive_values for start/end/min/max/trend; all_values for avg so it matches card computation
    values = positive_values if positive_values else all_values

    period_start_value = values[0] if values else 0
    period_end_value = values[-1] if values else 0
    change_amount = period_end_value - period_start_value
    change_percent = (change_amount / period_start_value * 100) if period_start_value > 0 else 0

    # Determine trend
    if abs(change_percent) < 5:
        trend = "flat"
    elif change_percent > 0:
        trend = "increasing"
    else:
        trend = "decreasing"

    return _resp({
        "kpi": kpi,
        "granularity": granularity,
        "data_points": data_points,
        "summary": {
            "period_start_value": round(period_start_value, 2),
            "period_end_value": round(period_end_value, 2),
            "change_amount": round(change_amount, 2),
            "change_percent": round(change_percent, 2),
            "min_value": round(min(values), 2),
            "max_value": round(max(values), 2),
            "avg_value": round(sum(all_values) / len(all_values), 2) if all_values else 0,
            "trend": trend
        }
    })


