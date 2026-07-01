"""Warehouse rightsizing and utilization recommendations.

Uses system.compute.warehouse_events, system.compute.warehouses, and
system.query.history to detect underutilized warehouses via three heuristics:
  1. IDLE_RUNNING  — warehouse running 2+ hours with no queries in 24h
  2. OVER_SCALED   — scaled to 2+ clusters but peak concurrency is low
  3. OVERSIZED     — large size with low queue wait and fast queries
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

from server.db import execute_query, execute_queries_parallel

router = APIRouter()
logger = logging.getLogger(__name__)

_health_cache: dict | None = None
_health_cache_ts: float = 0.0
_HEALTH_CACHE_TTL = 30 * 60  # 30 minutes — recommendations don't change rapidly

# ── Tunable thresholds ────────────────────────────────────────────────────────
_IDLE_LOOKBACK_HOURS = 2
_IDLE_NO_QUERY_HOURS = 24
_OVER_SCALED_CONCURRENCY_PER_CLUSTER = 10
_OVERSIZED_MAX_QUEUE_MS = 15000     # 15 s avg queue — warehouse is not under pressure
_OVERSIZED_MAX_MEDIAN_DURATION_S = 180  # 3 min execution — queries don't need Large
_OVERSIZED_MIN_QUERIES = 5
_LARGE_SIZES = ("Large", "X-Large", "2X-Large", "3X-Large", "4X-Large")

_SQL_IDLE = f"""
WITH current_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id, warehouse_type
  FROM system.compute.warehouses
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
recent_queries AS (
  SELECT DISTINCT compute.warehouse_id AS warehouse_id
  FROM system.query.history
  WHERE start_time >= NOW() - INTERVAL {_IDLE_NO_QUERY_HOURS} HOUR
    AND compute.warehouse_id IS NOT NULL
),
running_warehouses AS (
  SELECT DISTINCT warehouse_id
  FROM system.compute.warehouse_events
  WHERE event_time >= NOW() - INTERVAL {_IDLE_LOOKBACK_HOURS} HOUR
    AND cluster_count > 0
)
SELECT
  rw.warehouse_id,
  w.warehouse_name,
  w.warehouse_size,
  w.workspace_id,
  w.warehouse_type,
  MAX(we.event_time) AS last_event_time
FROM running_warehouses rw
JOIN current_warehouses w USING (warehouse_id)
JOIN system.compute.warehouse_events we ON we.warehouse_id = rw.warehouse_id
WHERE rw.warehouse_id NOT IN (SELECT warehouse_id FROM recent_queries)
  AND COALESCE(w.warehouse_type, 'CLASSIC') != 'SERVERLESS'
GROUP BY rw.warehouse_id, w.warehouse_name, w.warehouse_size, w.workspace_id, w.warehouse_type
"""

_SQL_OVER_SCALED = f"""
WITH current_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id
  FROM system.compute.warehouses
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
cluster_scale_events AS (
  SELECT
    warehouse_id,
    MAX(cluster_count) AS max_clusters_observed
  FROM system.compute.warehouse_events
  WHERE event_time >= NOW() - INTERVAL 30 DAY
  GROUP BY warehouse_id
  HAVING MAX(cluster_count) >= 2
),
concurrent_per_minute AS (
  SELECT
    compute.warehouse_id AS warehouse_id,
    DATE_TRUNC('minute', start_time) AS minute_bucket,
    COUNT(*) AS concurrent_queries
  FROM system.query.history
  WHERE start_time >= NOW() - INTERVAL 30 DAY
    AND compute.warehouse_id IN (SELECT warehouse_id FROM cluster_scale_events)
  GROUP BY 1, 2
),
max_concurrency AS (
  SELECT warehouse_id, MAX(concurrent_queries) AS max_concurrent
  FROM concurrent_per_minute
  GROUP BY warehouse_id
)
SELECT
  cse.warehouse_id,
  w.warehouse_name,
  w.warehouse_size,
  w.workspace_id,
  cse.max_clusters_observed,
  COALESCE(mc.max_concurrent, 0) AS max_concurrent
FROM cluster_scale_events cse
JOIN current_warehouses w USING (warehouse_id)
LEFT JOIN max_concurrency mc USING (warehouse_id)
WHERE COALESCE(mc.max_concurrent, 0) < (cse.max_clusters_observed * {_OVER_SCALED_CONCURRENCY_PER_CLUSTER})
"""

_SQL_OVERSIZED = f"""
WITH current_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id, warehouse_type
  FROM system.compute.warehouses
  WHERE warehouse_size IN {_LARGE_SIZES}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
large_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id
  FROM current_warehouses
  WHERE COALESCE(warehouse_type, 'CLASSIC') != 'SERVERLESS'
),
qstats AS (
  SELECT
    compute.warehouse_id AS warehouse_id,
    COUNT(*) AS query_count,
    AVG(COALESCE(waiting_at_capacity_duration_ms, 0) + COALESCE(waiting_for_compute_duration_ms, 0)) AS avg_queue_ms,
    PERCENTILE_APPROX(
      GREATEST(0.0,
        (UNIX_TIMESTAMP(end_time) - UNIX_TIMESTAMP(start_time))
        - (COALESCE(waiting_at_capacity_duration_ms, 0) + COALESCE(waiting_for_compute_duration_ms, 0)) / 1000.0
      ),
      0.5
    ) AS median_duration_seconds
  FROM system.query.history
  WHERE start_time >= NOW() - INTERVAL 30 DAY
    AND compute.warehouse_id IN (SELECT warehouse_id FROM large_warehouses)
    AND end_time IS NOT NULL
  GROUP BY compute.warehouse_id
  HAVING COUNT(*) >= {_OVERSIZED_MIN_QUERIES}
)
SELECT
  lw.warehouse_id,
  lw.warehouse_name,
  lw.warehouse_size,
  lw.workspace_id,
  q.query_count,
  q.avg_queue_ms,
  q.median_duration_seconds
FROM large_warehouses lw
JOIN qstats q USING (warehouse_id)
WHERE q.avg_queue_ms < {_OVERSIZED_MAX_QUEUE_MS}
  AND q.median_duration_seconds < {_OVERSIZED_MAX_MEDIAN_DURATION_S}
"""


def _build_recommendation(
    row: dict, rtype: str, extra: dict | None = None
) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "warehouse_id": row.get("warehouse_id"),
        "warehouse_name": row.get("warehouse_name"),
        "warehouse_size": row.get("warehouse_size"),
        "workspace_id": str(row.get("workspace_id") or ""),
        "recommendation_type": rtype,
        **(extra or {}),
    }
    if rtype == "IDLE_RUNNING":
        rec["last_event_time"] = str(row.get("last_event_time")) if row.get("last_event_time") else None
        rec["recommendation_text"] = (
            f"Warehouse has been running for {_IDLE_LOOKBACK_HOURS}+ hours with no queries "
            f"in the last {_IDLE_NO_QUERY_HOURS}h. Consider reducing auto_stop_minutes."
        )
    elif rtype == "OVER_SCALED":
        mc = int(row.get("max_clusters_observed") or 0)
        concur = int(row.get("max_concurrent") or 0)
        rec["max_clusters_observed"] = mc
        rec["max_concurrent"] = concur
        rec["recommendation_text"] = (
            f"Warehouse scaled to {mc} clusters but peak concurrency was only {concur} queries. "
            f"Consider reducing max_num_clusters."
        )
    elif rtype == "OVERSIZED":
        q = float(row.get("avg_queue_ms") or 0)
        d = float(row.get("median_duration_seconds") or 0)
        size = row.get("warehouse_size", "")
        rec["avg_queue_ms"] = q
        rec["median_duration_seconds"] = d
        rec["query_count"] = int(row.get("query_count") or 0)
        rec["recommendation_text"] = (
            f"{size} warehouse with avg queue time {q/1000:.1f}s and median query duration {d:.1f}s. "
            f"Consider downsizing one tier."
        )
    return rec


def _run_health_queries() -> dict[str, Any]:
    """Execute the three health queries synchronously (called via asyncio.to_thread)."""
    results = execute_queries_parallel([
        ("idle", lambda: execute_query(_SQL_IDLE)),
        ("over_scaled", lambda: execute_query(_SQL_OVER_SCALED)),
        ("oversized", lambda: execute_query(_SQL_OVERSIZED)),
    ], timeout=90.0)

    recommendations: list[dict] = []
    seen_wids: set[str] = set()

    for row in (results.get("idle") or []):
        recommendations.append(_build_recommendation(row, "IDLE_RUNNING"))
        seen_wids.add(row.get("warehouse_id") or "")

    for row in (results.get("over_scaled") or []):
        recommendations.append(_build_recommendation(row, "OVER_SCALED"))
        seen_wids.add(row.get("warehouse_id") or "")

    for row in (results.get("oversized") or []):
        recommendations.append(_build_recommendation(row, "OVERSIZED"))
        seen_wids.add(row.get("warehouse_id") or "")

    order = {"IDLE_RUNNING": 0, "OVER_SCALED": 1, "OVERSIZED": 2}
    recommendations.sort(key=lambda r: order.get(r["recommendation_type"], 9))

    return {
        "available": True,
        "recommendations": recommendations,
        "warehouses_analyzed": len(seen_wids),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("")
async def get_warehouse_health() -> dict[str, Any]:
    """Return rightsizing recommendations for all warehouses."""
    global _health_cache, _health_cache_ts

    if _health_cache is not None and (time.time() - _health_cache_ts) < _HEALTH_CACHE_TTL:
        return _health_cache

    try:
        payload = await asyncio.to_thread(_run_health_queries)
    except Exception as e:
        logger.warning(f"Warehouse health queries failed: {e}")
        return {"available": False, "error": str(e), "recommendations": [], "warehouses_analyzed": 0,
                "generated_at": datetime.now(timezone.utc).isoformat()}

    _health_cache = payload
    _health_cache_ts = time.time()
    return payload


_idle_time_cache: dict | None = None
_idle_time_cache_ts: float = 0.0
_IDLE_TIME_CACHE_TTL = 30 * 60


def _build_idle_time_sql(ws_clause: str, ws_clause_wh: str) -> str:
    return f"""
WITH all_events AS (
  -- Look back 7 days before the window start to catch warehouses already running at boundary
  SELECT
    warehouse_id,
    event_time,
    cluster_count
  FROM system.compute.warehouse_events
  WHERE event_time < CAST(:end_ts AS TIMESTAMP)
    AND event_time >= CAST(:start_ts AS TIMESTAMP) - INTERVAL 7 DAYS
),
events_with_next AS (
  SELECT
    warehouse_id,
    event_time,
    cluster_count,
    LEAD(event_time) OVER (PARTITION BY warehouse_id ORDER BY event_time) AS next_event_time
  FROM all_events
),
running_windows AS (
  SELECT
    warehouse_id,
    GREATEST(event_time, CAST(:start_ts AS TIMESTAMP)) AS window_start,
    LEAST(
      COALESCE(next_event_time, CAST(:end_ts AS TIMESTAMP)),
      CAST(:end_ts AS TIMESTAMP)
    ) AS window_end
  FROM events_with_next
  WHERE cluster_count > 0
    AND COALESCE(next_event_time, CAST(:end_ts AS TIMESTAMP)) > CAST(:start_ts AS TIMESTAMP)
    AND event_time < CAST(:end_ts AS TIMESTAMP)
),
warehouse_uptime AS (
  SELECT
    warehouse_id,
    SUM((UNIX_TIMESTAMP(window_end) - UNIX_TIMESTAMP(window_start)) / 60.0) AS total_running_minutes
  FROM running_windows
  WHERE window_start < window_end
  GROUP BY warehouse_id
),
query_time AS (
  SELECT
    qh.compute.warehouse_id AS warehouse_id,
    SUM(GREATEST(
      (UNIX_TIMESTAMP(COALESCE(qh.end_time, CURRENT_TIMESTAMP())) - UNIX_TIMESTAMP(qh.start_time)) / 60.0,
      0
    )) AS total_query_minutes
  FROM system.query.history qh
  WHERE qh.start_time >= CAST(:start_ts AS TIMESTAMP)
    AND qh.start_time < CAST(:end_ts AS TIMESTAMP)
    AND qh.compute.warehouse_id IS NOT NULL
  GROUP BY qh.compute.warehouse_id
),
wh_info AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id, warehouse_type
  FROM system.compute.warehouses
  WHERE 1=1 {ws_clause_wh}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
wh_cost AS (
  SELECT
    usage_metadata.warehouse_id AS warehouse_id,
    SUM(usage_quantity * COALESCE(p.pricing.default, 0)) AS total_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
  WHERE usage_date BETWEEN :start_date AND :end_date
    AND usage_metadata.warehouse_id IS NOT NULL
    AND usage_quantity > 0
    {ws_clause}
  GROUP BY usage_metadata.warehouse_id
)
SELECT
  u.warehouse_id,
  COALESCE(i.warehouse_name, u.warehouse_id) AS warehouse_name,
  COALESCE(i.warehouse_size, 'Unknown') AS warehouse_size,
  COALESCE(i.warehouse_type, 'CLASSIC') AS warehouse_type,
  i.workspace_id,
  ROUND(u.total_running_minutes) AS total_running_minutes,
  ROUND(COALESCE(q.total_query_minutes, 0)) AS total_query_minutes,
  ROUND(GREATEST(u.total_running_minutes - COALESCE(q.total_query_minutes, 0), 0)) AS idle_minutes,
  CASE
    WHEN u.total_running_minutes > 0
    THEN ROUND(100.0 * GREATEST(u.total_running_minutes - COALESCE(q.total_query_minutes, 0), 0)
         / u.total_running_minutes, 1)
    ELSE 0.0
  END AS idle_pct,
  COALESCE(c.total_spend, 0) AS total_spend,
  CASE
    WHEN u.total_running_minutes > 0
    THEN COALESCE(c.total_spend, 0)
         * GREATEST(u.total_running_minutes - COALESCE(q.total_query_minutes, 0), 0)
         / u.total_running_minutes
    ELSE 0.0
  END AS estimated_idle_spend
FROM warehouse_uptime u
LEFT JOIN query_time q ON u.warehouse_id = q.warehouse_id
JOIN wh_info i ON u.warehouse_id = i.warehouse_id
LEFT JOIN wh_cost c ON u.warehouse_id = c.warehouse_id
WHERE u.total_running_minutes >= 10
ORDER BY estimated_idle_spend DESC
LIMIT 25
"""


def _build_serverless_check_sql(ws_clause_wh: str) -> str:
    return f"""
WITH latest_warehouses AS (
  SELECT warehouse_id, warehouse_type
  FROM system.compute.warehouses
  WHERE change_time >= CURRENT_TIMESTAMP() - INTERVAL 90 DAYS
  {ws_clause_wh}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
)
SELECT COUNT(*) AS serverless_count
FROM latest_warehouses
WHERE warehouse_type = 'SERVERLESS'
"""


@router.get("/idle-time")
async def get_warehouse_idle_time(
    start_date: str | None = None,
    end_date: str | None = None,
    workspace_ids: str | None = None,
) -> dict[str, Any]:
    """Idle time per warehouse: uptime from warehouse_events (with 7-day lookback) minus active query time."""
    global _idle_time_cache, _idle_time_cache_ts
    from server.routers.billing import get_default_start_date, get_default_end_date
    from server import workspace_filter as wf

    sd = start_date or get_default_start_date()
    ed = end_date or get_default_end_date()
    id_list = [i.strip() for i in workspace_ids.split(",") if i.strip()] if workspace_ids else None
    cache_key = f"{sd}:{ed}:{','.join(id_list) if id_list else ''}"

    if (_idle_time_cache is not None
            and (time.time() - _idle_time_cache_ts) < _IDLE_TIME_CACHE_TTL
            and _idle_time_cache.get("_cache_key") == cache_key):
        return {k: v for k, v in _idle_time_cache.items() if k != "_cache_key"}

    ws_clause = wf.build_ws_filter_clause(col="workspace_id", id_list=id_list)
    ws_clause_wh = wf.build_ws_filter_clause(col="workspace_id", id_list=id_list)

    from datetime import date as _date, timedelta as _timedelta
    _ed_dt = _date.fromisoformat(ed)
    params = {
        "start_ts": f"{sd} 00:00:00",
        "end_ts": (_ed_dt + _timedelta(days=1)).strftime("%Y-%m-%d 00:00:00"),
        "start_date": sd,
        "end_date": ed,
    }

    sql = _build_idle_time_sql(ws_clause, ws_clause_wh)
    try:
        rows = await asyncio.to_thread(execute_query, sql, params)
    except Exception as e:
        logger.warning("warehouse idle-time query failed: %s", e)
        return {"available": False, "error": str(e), "warehouses": [], "serverless_detected": False,
                "generated_at": datetime.now(timezone.utc).isoformat()}

    warehouses = []
    for row in rows:
        warehouses.append({
            "warehouse_id": row.get("warehouse_id"),
            "warehouse_name": row.get("warehouse_name"),
            "warehouse_size": row.get("warehouse_size"),
            "warehouse_type": row.get("warehouse_type") or "CLASSIC",
            "workspace_id": str(row.get("workspace_id") or ""),
            "total_running_minutes": int(row.get("total_running_minutes") or 0),
            "total_query_minutes": int(row.get("total_query_minutes") or 0),
            "idle_minutes": int(row.get("idle_minutes") or 0),
            "idle_pct": float(row.get("idle_pct") or 0),
            "total_spend": float(row.get("total_spend") or 0),
            "estimated_idle_spend": float(row.get("estimated_idle_spend") or 0),
        })

    # If no classic warehouses found, check whether serverless warehouses exist (can't generate lifecycle events)
    serverless_detected = False
    if not warehouses:
        try:
            check_sql = _build_serverless_check_sql(ws_clause_wh)
            check_rows = await asyncio.to_thread(execute_query, check_sql)
            serverless_detected = bool(check_rows and int(check_rows[0].get("serverless_count") or 0) > 0)
        except Exception:
            pass

    payload = {
        "available": True,
        "warehouses": warehouses,
        "serverless_detected": serverless_detected,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    _idle_time_cache = {**payload, "_cache_key": cache_key}
    _idle_time_cache_ts = time.time()
    return payload


@router.get("/{warehouse_id}")
async def get_warehouse_health_detail(warehouse_id: str) -> dict[str, Any]:
    """Return health detail for a specific warehouse (served from cache)."""
    result = await get_warehouse_health()
    recs = [r for r in result.get("recommendations", []) if r.get("warehouse_id") == warehouse_id]
    return {
        "available": result["available"],
        "warehouse_id": warehouse_id,
        "recommendations": recs,
        "generated_at": result.get("generated_at"),
    }
