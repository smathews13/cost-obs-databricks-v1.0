"""Materialized views for cost observability dashboard.

This module creates and manages pre-aggregated Delta tables that dramatically
improve query performance by avoiding expensive joins on system.query.history.

Tables created:
- cost_obs.daily_usage_summary: Daily aggregated usage and spend (incl. user_attributed_spend)
- cost_obs.daily_product_breakdown: Daily spend by product category
- cost_obs.daily_workspace_breakdown: Daily spend by workspace
- cost_obs.sql_tool_attribution: Pre-computed Genie vs DBSQL split
- cost_obs.daily_tag_summary: Daily exploded tag aggregations (tag_key, tag_value grain)
- cost_obs.daily_tag_coverage_summary: Daily non-exploded tagged/untagged spend

These tables should be refreshed daily via a scheduled job.
"""

import fcntl
import logging
from collections.abc import Callable
from contextlib import contextmanager
from datetime import date
from typing import IO, Iterator

from server.db import (
    MV_UNIFIED_TABLE_NAMES,
    execute_query,
    get_catalog_schema,
)
from server.queries.pricing import apply_temporal_list_price_join

logger = logging.getLogger(__name__)


# SQL to create the schema
CREATE_SCHEMA_SQL = """
CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}
COMMENT 'Pre-aggregated cost observability tables for fast dashboard queries'
"""

# Daily usage summary table - replaces BILLING_SUMMARY
CREATE_DAILY_USAGE_SUMMARY = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_usage_summary` CLUSTER BY (usage_date, workspace_id) AS
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.identity_metadata.run_as AS run_as,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
)
SELECT
  usage_date,
  workspace_id,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  SUM(usage_quantity * effective_price_per_dbu) as effective_list_spend,
  SUM(CASE WHEN run_as IS NOT NULL THEN usage_quantity * price_per_dbu ELSE 0 END) as user_attributed_spend
FROM usage_with_price
GROUP BY usage_date, workspace_id
ORDER BY usage_date, workspace_id
"""

# Daily product breakdown table - replaces BILLING_BY_PRODUCT_FAST
CREATE_DAILY_PRODUCT_BREAKDOWN = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_product_breakdown` CLUSTER BY (usage_date, workspace_id) AS
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'SQL' THEN 'SQL'
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.billing_origin_product = 'SERVING' OR u.billing_origin_product = 'MODEL_SERVING'
           OR u.sku_name LIKE '%SERVING%' OR u.sku_name LIKE '%INFERENCE%'
           OR u.sku_name LIKE '%PROVISIONED_THROUGHPUT%' THEN 'Model Serving'
      WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'AI Search'
      WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
      WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
           OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      ELSE 'Other'
    END as product_category
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
)
SELECT
  usage_date,
  workspace_id,
  product_category,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  SUM(usage_quantity * effective_price_per_dbu) as effective_list_spend
FROM usage_with_price
GROUP BY usage_date, workspace_id, product_category
ORDER BY usage_date, workspace_id, product_category
"""

# Daily workspace breakdown table - replaces BILLING_BY_WORKSPACE
CREATE_DAILY_WORKSPACE_BREAKDOWN = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_workspace_breakdown` CLUSTER BY (usage_date, workspace_id) AS
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.usage_quantity,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
)
SELECT
  uwp.usage_date,
  uwp.workspace_id,
  ws.workspace_name,
  SUM(uwp.usage_quantity) as total_dbus,
  SUM(uwp.usage_quantity * uwp.price_per_dbu) as total_spend,
  SUM(uwp.usage_quantity * uwp.effective_price_per_dbu) as effective_list_spend
FROM usage_with_price uwp
LEFT JOIN system.access.workspaces_latest ws ON uwp.workspace_id = ws.workspace_id
GROUP BY uwp.usage_date, uwp.workspace_id, ws.workspace_name
ORDER BY uwp.usage_date, uwp.workspace_id
"""

# SQL tool attribution (Genie vs DBSQL) - expensive query, pre-computed daily
CREATE_SQL_TOOL_ATTRIBUTION = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`sql_tool_attribution` CLUSTER BY (usage_date, workspace_id) AS
WITH sql_query_work AS (
  SELECT
    CASE
      WHEN client_application LIKE '%Genie%' THEN 'Genie'
      ELSE 'DBSQL'
    END AS sql_product,
    DATE(start_time) AS usage_date,
    workspace_id,
    compute.warehouse_id AS warehouse_id,
    SUM(total_task_duration_ms) AS work_ms
  FROM system.query.history
  WHERE executed_as_user_id IS NOT NULL
    AND compute.warehouse_id IS NOT NULL
    AND DATE(start_time) >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
  GROUP BY 1, 2, 3, 4
),
sql_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.warehouse_id as warehouse_id,
    SUM(u.usage_quantity) as total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
    SUM(u.usage_quantity * COALESCE(p.pricing.effective_list.default, p.pricing.default, 0)) as effective_list_spend
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
  GROUP BY 1, 2, 3
),
warehouse_totals AS (
  SELECT
    usage_date,
    workspace_id,
    warehouse_id,
    SUM(work_ms) as total_work_ms
  FROM sql_query_work
  GROUP BY usage_date, workspace_id, warehouse_id
)
SELECT
  q.sql_product,
  q.usage_date,
  q.workspace_id,
  q.warehouse_id,
  CASE
    WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_dbus
    ELSE 0
  END as attributed_dbus,
  CASE
    WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_spend
    ELSE 0
  END as attributed_spend,
  CASE
    WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.effective_list_spend
    ELSE 0
  END as attributed_effective_list_spend
FROM sql_query_work q
JOIN warehouse_totals w ON q.usage_date = w.usage_date AND q.workspace_id = w.workspace_id AND q.warehouse_id = w.warehouse_id
LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.workspace_id = s.workspace_id AND q.warehouse_id = s.warehouse_id
"""

CREATE_QUERY_STATS = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_query_stats` CLUSTER BY (usage_date, workspace_id) AS
SELECT
  DATE(start_time) as usage_date,
  workspace_id,
  COUNT(*) as total_queries,
  COUNT(DISTINCT COALESCE(executed_by, executed_as_user_id)) as unique_query_users,
  SUM(COALESCE(read_rows, 0)) as total_rows_read,
  SUM(COALESCE(read_bytes, 0)) as total_bytes_read,
  SUM(COALESCE(total_task_duration_ms, 0)) / 1000.0 as total_compute_seconds
FROM system.query.history
WHERE DATE(start_time) >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
GROUP BY DATE(start_time), workspace_id
ORDER BY usage_date, workspace_id
"""


# DBSQL Cost Per Query Materialized View (Simplified Current Implementation)
# Based on: https://github.com/databrickslabs/sandbox/tree/main/dbsql/cost_per_query/PrPr
CREATE_DBSQL_COST_PER_QUERY = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`dbsql_cost_per_query` CLUSTER BY (query_date, workspace_id) AS
WITH
-- Get hourly DBU usage per warehouse from billing
warehouse_hourly_usage AS (
  SELECT
    DATE_TRUNC('hour', u.usage_start_time) AS hour_bucket,
    u.usage_metadata.warehouse_id AS warehouse_id,
    SUM(u.usage_quantity) AS hourly_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS hourly_dollars,
    SUM(u.usage_quantity * COALESCE(p.pricing.effective_list.default, p.pricing.default, 0)) AS hourly_dollars_effective
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_metadata.warehouse_id IS NOT NULL
    AND u.usage_start_time >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
  GROUP BY 1, 2
),
-- Get all queries with their execution details
queries_with_details AS (
  SELECT
    q.statement_id,
    q.statement_text,
    COALESCE(q.executed_by, q.executed_as_user_id) AS executed_by,
    q.compute.warehouse_id AS warehouse_id,
    q.workspace_id,
    q.start_time,
    q.end_time,
    (UNIX_TIMESTAMP(q.end_time) - UNIX_TIMESTAMP(q.start_time)) AS duration_seconds,
    q.total_task_duration_ms,
    q.client_application,
    -- Determine query source type from client_application and other fields
    CASE
      WHEN q.client_application LIKE '%genie%' OR q.client_application LIKE '%Genie%' THEN 'GENIE SPACE'
      WHEN q.client_application LIKE '%dashboard%' OR q.client_application LIKE '%Dashboard%' THEN
        CASE
          WHEN q.client_application LIKE '%lakeview%' OR q.client_application LIKE '%aibi%' THEN 'AI/BI DASHBOARD'
          ELSE 'LEGACY DASHBOARD'
        END
      WHEN q.client_application LIKE '%notebook%' OR q.client_application LIKE '%Notebook%' THEN 'NOTEBOOK'
      WHEN q.client_application LIKE '%job%' OR q.client_application LIKE '%Job%' OR q.statement_type = 'JOB' THEN 'JOB'
      WHEN q.client_application LIKE '%alert%' OR q.client_application LIKE '%Alert%' THEN 'ALERT'
      WHEN q.client_application LIKE '%sql-editor%' OR q.client_application LIKE '%SQL Editor%' THEN 'SQL QUERY'
      ELSE 'SQL QUERY'
    END AS query_source_type,
    -- Extract source ID where possible
    CASE
      WHEN q.client_application LIKE '%genie%' THEN REGEXP_EXTRACT(q.client_application, 'genie[/-]([a-zA-Z0-9-]+)', 1)
      WHEN q.client_application LIKE '%dashboard%' THEN REGEXP_EXTRACT(q.client_application, 'dashboard[/-]([a-zA-Z0-9-]+)', 1)
      ELSE NULL
    END AS query_source_id
  FROM system.query.history q
  WHERE q.compute.warehouse_id IS NOT NULL
    AND q.start_time >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND q.statement_type != 'CANCEL'
    AND (q.executed_by IS NOT NULL OR q.executed_as_user_id IS NOT NULL)
),
-- Calculate total work per warehouse per hour for proportional allocation
warehouse_hourly_work AS (
  SELECT
    DATE_TRUNC('hour', start_time) AS hour_bucket,
    warehouse_id,
    SUM(COALESCE(total_task_duration_ms, duration_seconds * 1000)) AS total_work_ms
  FROM queries_with_details
  GROUP BY 1, 2
),
-- Attribute costs to each query proportionally based on work done
query_costs AS (
  SELECT
    q.statement_id,
    q.statement_text,
    q.executed_by,
    q.warehouse_id,
    q.workspace_id,
    q.start_time,
    q.end_time,
    q.duration_seconds,
    q.client_application,
    q.query_source_type,
    q.query_source_id,
    q.total_task_duration_ms,
    DATE_TRUNC('hour', q.start_time) AS query_hour,
    -- Proportional cost attribution
    CASE
      WHEN w.total_work_ms > 0 THEN
        (COALESCE(q.total_task_duration_ms, q.duration_seconds * 1000) / w.total_work_ms) * h.hourly_dbus
      ELSE 0
    END AS query_attributed_dbus_estimation,
    CASE
      WHEN w.total_work_ms > 0 THEN
        (COALESCE(q.total_task_duration_ms, q.duration_seconds * 1000) / w.total_work_ms) * h.hourly_dollars
      ELSE 0
    END AS query_attributed_dollars_estimation,
    CASE
      WHEN w.total_work_ms > 0 THEN
        (COALESCE(q.total_task_duration_ms, q.duration_seconds * 1000) / w.total_work_ms) * h.hourly_dollars_effective
      ELSE 0
    END AS query_attributed_dollars_effective
  FROM queries_with_details q
  LEFT JOIN warehouse_hourly_work w
    ON DATE_TRUNC('hour', q.start_time) = w.hour_bucket
    AND q.warehouse_id = w.warehouse_id
  LEFT JOIN warehouse_hourly_usage h
    ON DATE_TRUNC('hour', q.start_time) = h.hour_bucket
    AND q.warehouse_id = h.warehouse_id
)
SELECT
  statement_id,
  query_source_id,
  query_source_type,
  client_application,
  executed_by,
  warehouse_id,
  statement_text,
  CAST(workspace_id AS STRING) AS workspace_id,
  start_time,
  end_time,
  duration_seconds,
  query_attributed_dollars_estimation,
  query_attributed_dbus_estimation,
  -- Generate query profile URL (customers should customize host)
  CONCAT(
    'https://DATABRICKS_HOST/sql/history?o=',
    CAST(workspace_id AS STRING),
    '&queryId=',
    statement_id,
    '&queryStartTimeMs=',
    CAST(UNIX_TIMESTAMP(start_time) * 1000 AS BIGINT)
  ) AS query_profile_url,
  -- Generate source URL for dashboards/genie spaces
  CASE
    WHEN query_source_type = 'GENIE SPACE' AND query_source_id IS NOT NULL THEN
      CONCAT('https://DATABRICKS_HOST/genie/rooms/', query_source_id)
    WHEN query_source_type = 'AI/BI DASHBOARD' AND query_source_id IS NOT NULL THEN
      CONCAT('https://DATABRICKS_HOST/sql/dashboardsv3/', query_source_id)
    WHEN query_source_type = 'LEGACY DASHBOARD' AND query_source_id IS NOT NULL THEN
      CONCAT('https://DATABRICKS_HOST/sql/dashboards/', query_source_id)
    WHEN query_source_type = 'SQL QUERY' AND query_source_id IS NOT NULL THEN
      CONCAT('https://DATABRICKS_HOST/editor/queries/', query_source_id)
    ELSE NULL
  END AS url_helper,
  DATE(start_time) AS query_date
FROM query_costs
WHERE query_attributed_dollars_estimation > 0
   OR query_attributed_dbus_estimation > 0
   OR duration_seconds > 0
ORDER BY start_time DESC
"""


# DBSQL Cost Per Query (PrPr Implementation - Full Accuracy)
# Source: https://github.com/databrickslabs/sandbox/blob/main/dbsql/cost_per_query/PrPr/DBSQL%20Cost%20Per%20Query%20MV%20(PrPr).sql
# This is the complete Private Preview implementation with warehouse utilization tracking and multi-hour query splitting
CREATE_DBSQL_COST_PER_QUERY_PRPR = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`dbsql_cost_per_query_prpr` AS
WITH
table_boundaries AS (
  SELECT
    (SELECT MAX(event_time) FROM system.compute.warehouse_events) AS max_events_ts,
    (SELECT MAX(end_time) FROM system.query.history) AS max_query_end_ts,
    (SELECT MAX(usage_end_time) FROM system.billing.usage) AS max_billing_ts,
    (SELECT MIN(event_time) FROM system.compute.warehouse_events) AS min_event_ts,
    (SELECT MIN(start_time) FROM system.query.history) AS min_query_start_ts,
    (SELECT MIN(usage_end_time) FROM system.billing.usage) AS min_billing_ts,
    date_trunc('HOUR', LEAST(max_events_ts, max_query_end_ts, max_billing_ts)) AS selected_end_time,
    (date_trunc('HOUR', GREATEST(min_event_ts, min_query_start_ts, min_billing_ts)) + INTERVAL 1 HOUR)::timestamp AS selected_start_time
),

cpq_warehouse_usage AS (
  SELECT
    usage_metadata.warehouse_id AS warehouse_id,
    *
  FROM system.billing.usage AS u
  WHERE usage_metadata.warehouse_id IS NOT NULL
    AND usage_start_time >= (SELECT MIN(selected_start_time) FROM table_boundaries)
    AND usage_end_time <= (SELECT MAX(selected_end_time) FROM table_boundaries)
),

filtered_warehouse_usage AS (
  SELECT
    u.warehouse_id warehouse_id,
    date_trunc('HOUR',u.usage_start_time) AS usage_start_hour,
    date_trunc('HOUR',u.usage_end_time) AS usage_end_hour,
    u.usage_quantity AS dbus,
    (CAST(p.pricing.default AS FLOAT) * dbus) AS usage_dollars
  FROM cpq_warehouse_usage AS u
  /* TEMPORAL_LIST_PRICE_JOIN */
),

table_bound_expld AS (
  SELECT timestampadd(hour, h, selected_start_time) as selected_hours
  FROM table_boundaries
  JOIN lateral explode(sequence(0, timestampdiff(hour, selected_start_time, selected_end_time), 1)) as t (h)
),

cpq_warehouse_query_history AS (
  SELECT
    account_id,
    workspace_id,
    statement_id,
    COALESCE(executed_by, executed_as_user_id) AS executed_by,
    statement_text,
    compute.warehouse_id AS warehouse_id,
    execution_status,
    COALESCE(client_application, 'Unknown') AS client_application,
    (COALESCE(CAST(total_task_duration_ms AS FLOAT) / 1000, 0) +
     COALESCE(CAST(result_fetch_duration_ms AS FLOAT) / 1000, 0) +
     COALESCE(CAST(compilation_duration_ms AS FLOAT) / 1000, 0)
    ) AS query_work_task_time,
    start_time,
    end_time,
    timestampadd(MILLISECOND,
      coalesce(waiting_at_capacity_duration_ms, 0) +
      coalesce(waiting_for_compute_duration_ms, 0) +
      coalesce(compilation_duration_ms, 0),
      start_time) AS query_work_start_time,
    timestampadd(MILLISECOND, coalesce(result_fetch_duration_ms, 0), end_time) AS query_work_end_time,
    CASE
      WHEN query_source.job_info.job_id IS NOT NULL THEN 'JOB'
      WHEN query_source.legacy_dashboard_id IS NOT NULL THEN 'LEGACY DASHBOARD'
      WHEN query_source.dashboard_id IS NOT NULL THEN 'AI/BI DASHBOARD'
      WHEN query_source.alert_id IS NOT NULL THEN 'ALERT'
      WHEN query_source.notebook_id IS NOT NULL THEN 'NOTEBOOK'
      WHEN query_source.sql_query_id IS NOT NULL THEN 'SQL QUERY'
      WHEN query_source.genie_space_id IS NOT NULL THEN 'GENIE SPACE'
      WHEN client_application IS NOT NULL THEN client_application
      ELSE 'UNKNOWN'
    END AS query_source_type,
    COALESCE(
      query_source.job_info.job_id,
      query_source.legacy_dashboard_id,
      query_source.dashboard_id,
      query_source.alert_id,
      query_source.notebook_id,
      query_source.sql_query_id,
      query_source.genie_space_id,
      'UNKNOWN'
    ) AS query_source_id
  FROM system.query.history AS h
  WHERE statement_type IS NOT NULL
    AND start_time < (SELECT selected_end_time FROM table_boundaries)
    AND end_time > (SELECT selected_start_time FROM table_boundaries)
    AND total_task_duration_ms > 0
    AND compute.warehouse_id is not null
),

cte_warehouse as (
  SELECT warehouse_id, min(query_work_start_time) as min_start_time
  FROM cpq_warehouse_query_history
  GROUP BY warehouse_id
),

window_events AS (
  SELECT
    warehouse_id,
    event_type,
    event_time,
    cluster_count AS cluster_count,
    CASE
      WHEN cluster_count = 0 THEN 'OFF'
      WHEN cluster_count > 0 THEN 'ON'
    END AS warehouse_state
  FROM system.compute.warehouse_events AS we
  WHERE warehouse_id in (SELECT warehouse_id FROM cte_warehouse)
    AND event_time >= (SELECT timestampadd(day, -1, selected_start_time) FROM table_boundaries)
    AND event_time <= (SELECT selected_end_time FROM table_boundaries)
),

cte_agg_events_prep as (
  SELECT
    warehouse_id,
    warehouse_state,
    event_time,
    row_number() over W1 - row_number() over W2 as grp
  FROM window_events
  WINDOW W1 as (partition by warehouse_id order by event_time asc),
         W2 as (partition by warehouse_id, warehouse_state order by event_time asc)
),

cte_agg_events as (
  SELECT
    warehouse_id,
    warehouse_state as window_state,
    min(event_time) as event_window_start,
    lead(min(event_time), 1, selected_end_time) over W as event_window_end
  FROM cte_agg_events_prep
  JOIN table_boundaries
  GROUP BY warehouse_id, warehouse_state, grp, selected_end_time
  WINDOW W as (partition by warehouse_id order by min(event_time) asc)
),

cte_all_events as (
  SELECT
    warehouse_id,
    window_state,
    date_trunc('second', event_window_start) as event_window_start,
    date_trunc('second', event_window_end) as event_window_end
  FROM cte_agg_events
  WHERE date_trunc('second', event_window_start) < date_trunc('second', event_window_end)
),

cte_queries_event_cnt as (
  SELECT
    warehouse_id,
    case num
      when 1 then date_trunc('second', query_work_start_time)
      else timestampadd(second,
        case when date_trunc('second', query_work_start_time) = date_trunc('second', query_work_end_time)
        then 1 else 0 end,
        date_trunc('second', query_work_end_time))
    end as query_event_time,
    sum(num) as num_queries
  FROM cpq_warehouse_query_history
  JOIN lateral explode(array(1, -1)) as t (num)
  GROUP BY 1, 2
),

cte_raw_history as (
  SELECT
    warehouse_id,
    query_event_time as query_start,
    lead(query_event_time, 1, selected_end_time) over W as query_end,
    sum(num_queries) over W as queries_active
  FROM cte_queries_event_cnt
  JOIN table_boundaries
  WINDOW W as (partition by warehouse_id order by query_event_time asc)
),

cte_raw_history_byday as (
  SELECT
    warehouse_id,
    case num
      when 0 then query_start
      else timestampadd(day, num, query_start::date)
    end::date as query_start_dt,
    case num
      when 0 then query_start
      else timestampadd(day, num, query_start::date)
    end as query_start,
    case num
      when timestampdiff(day, query_start::date, query_end::date) then query_end
      else timestampadd(day, num + 1, query_start::date)
    end as query_end,
    queries_active
  FROM cte_raw_history
  JOIN lateral explode(sequence(0, timestampdiff(day, query_start::date, query_end::date), 1)) as t (num)
),

cte_all_time_union as (
  SELECT warehouse_id, case num when 1 then event_window_start else event_window_end end ts_start
  FROM cte_all_events
  JOIN lateral explode(array(1, -1)) as t (num)
  UNION
  SELECT warehouse_id, case num when 1 then query_start else query_end end
  FROM cte_raw_history_byday
  JOIN lateral explode(array(1, -1)) as t (num)
  UNION
  SELECT warehouse_id, selected_hours
  FROM cte_warehouse
  JOIN table_bound_expld on true
),

cte_periods as (
  SELECT
    warehouse_id,
    ts_start::date as dt_start,
    ts_start,
    lead(ts_start, 1, selected_end_time) over W as ts_end
  FROM cte_all_time_union
  JOIN table_boundaries
  WINDOW W as (partition by warehouse_id order by ts_start asc)
),

cte_merge_periods as (
  SELECT
    p.warehouse_id,
    date_trunc('hour', p.ts_start) as ts_hour,
    sum(timestampdiff(second, p.ts_start, p.ts_end)) as duration,
    case
      when e.window_state = 'OFF' or e.window_state is null then 'OFF'
      when r.queries_active > 0 then 'UTILIZED'
      else 'ON_IDLE'
    end as utilization_flag
  FROM cte_periods as p
  LEFT JOIN cte_all_events as e
    ON e.warehouse_id = p.warehouse_id
    AND e.event_window_start < p.ts_end
    AND e.event_window_end > p.ts_start
  LEFT JOIN cte_raw_history_byday as r
    ON r.warehouse_id = p.warehouse_id
    AND r.query_start_dt = p.dt_start
    AND r.query_start < p.ts_end
    AND r.query_end > p.ts_start
    AND r.queries_active > 0
    AND e.window_state <> 'OFF'
  WHERE p.ts_start < p.ts_end
  GROUP BY p.warehouse_id, date_trunc('hour', p.ts_start),
    CASE
      WHEN e.window_state = 'OFF' or e.window_state is null THEN 'OFF'
      WHEN r.queries_active > 0 THEN 'UTILIZED'
      ELSE 'ON_IDLE'
    END
),

utilization_by_warehouse AS (
  SELECT
    warehouse_id,
    ts_hour as warehouse_hour,
    coalesce(sum(duration) filter(where utilization_flag = 'UTILIZED'), 0) as utilized_seconds,
    coalesce(sum(duration) filter(where utilization_flag = 'ON_IDLE'), 0) as idle_seconds,
    coalesce(sum(duration) filter(where utilization_flag = 'OFF'), 0) as off_seconds,
    coalesce(sum(duration), 0) as total_seconds,
    try_divide(utilized_seconds, utilized_seconds + idle_seconds)::decimal(3,2) as utilization_proportion
  FROM cte_merge_periods
  GROUP BY warehouse_id, ts_hour
),

cleaned_warehouse_info AS (
  SELECT
    wu.warehouse_id,
    wu.usage_start_hour AS hour_bucket,
    wu.dbus,
    wu.usage_dollars,
    ut.utilized_seconds,
    ut.idle_seconds,
    ut.total_seconds,
    ut.utilization_proportion
  FROM filtered_warehouse_usage wu
  LEFT JOIN utilization_by_warehouse AS ut
    ON wu.warehouse_id = ut.warehouse_id
    AND wu.usage_start_hour = ut.warehouse_hour
),

hour_intervals AS (
  SELECT
    statement_id,
    warehouse_id,
    query_work_start_time,
    query_work_end_time,
    query_work_task_time,
    explode(
      sequence(
        0,
        floor((UNIX_TIMESTAMP(query_work_end_time) - UNIX_TIMESTAMP(date_trunc('hour', query_work_start_time))) / 3600)
      )
    ) AS hours_interval,
    timestampadd(hour, hours_interval, date_trunc('hour', query_work_start_time)) AS hour_bucket
  FROM cpq_warehouse_query_history
),

statement_proportioned_work AS (
  SELECT *,
    GREATEST(0,
      UNIX_TIMESTAMP(LEAST(query_work_end_time, timestampadd(hour, 1, hour_bucket))) -
      UNIX_TIMESTAMP(GREATEST(query_work_start_time, hour_bucket))
    ) AS overlap_duration,
    CASE
      WHEN CAST(query_work_end_time AS DOUBLE) - CAST(query_work_start_time AS DOUBLE) = 0 THEN 0
      ELSE query_work_task_time * (overlap_duration / (CAST(query_work_end_time AS DOUBLE) - CAST(query_work_start_time AS DOUBLE)))
    END AS proportional_query_work
  FROM hour_intervals
),

attributed_query_work_all AS (
  SELECT
    statement_id,
    hour_bucket,
    warehouse_id,
    SUM(proportional_query_work) AS attributed_query_work
  FROM statement_proportioned_work
  GROUP BY statement_id, warehouse_id, hour_bucket
),

warehouse_time as (
  SELECT
    warehouse_id,
    hour_bucket,
    SUM(attributed_query_work) as total_work_done_on_warehouse
  FROM attributed_query_work_all
  GROUP BY warehouse_id, hour_bucket
),

history AS (
  SELECT
    a.*,
    b.total_work_done_on_warehouse,
    CASE
      WHEN attributed_query_work = 0 THEN NULL
      ELSE attributed_query_work / total_work_done_on_warehouse
    END AS proportion_of_warehouse_time_used_by_query
  FROM attributed_query_work_all a
  INNER JOIN warehouse_time b
    ON a.warehouse_id = b.warehouse_id
    AND a.hour_bucket = b.hour_bucket
),

history_with_pricing AS (
  SELECT
    h1.*,
    wh.dbus AS total_warehouse_period_dbus,
    wh.usage_dollars AS total_warehouse_period_dollars,
    wh.utilization_proportion AS warehouse_utilization_proportion,
    wh.hour_bucket AS warehouse_hour_bucket,
    MAX(wh.hour_bucket) OVER() AS warehouse_max_hour_bucket
  FROM history AS h1
  LEFT JOIN cleaned_warehouse_info AS wh
    ON h1.warehouse_id = wh.warehouse_id
    AND h1.hour_bucket = wh.hour_bucket
),

query_attribution AS (
  SELECT
    a.*,
    warehouse_max_hour_bucket AS most_recent_billing_hour,
    CASE
      WHEN warehouse_hour_bucket IS NOT NULL THEN 'Has Billing Record'
      ELSE 'No Billing Record for this hour and warehouse yet available'
    END AS billing_record_check,
    CASE
      WHEN total_work_done_on_warehouse = 0 THEN NULL
      ELSE attributed_query_work / total_work_done_on_warehouse
    END AS query_task_time_proportion,
    (warehouse_utilization_proportion * total_warehouse_period_dollars) * query_task_time_proportion AS query_attributed_dollars_estimation,
    (warehouse_utilization_proportion * total_warehouse_period_dbus) * query_task_time_proportion AS query_attributed_dbus_estimation
  FROM history_with_pricing a
)

SELECT
  qq.statement_id,
  FIRST(qq.query_source_id) AS query_source_id,
  FIRST(qq.query_source_type) AS query_source_type,
  FIRST(qq.client_application) AS client_application,
  FIRST(qq.executed_by) AS executed_by,
  FIRST(qq.warehouse_id) AS warehouse_id,
  FIRST(qq.statement_text) AS statement_text,
  FIRST(qq.workspace_id) AS workspace_id,
  COLLECT_LIST(
    NAMED_STRUCT(
      'hour_bucket', qa.hour_bucket,
      'hour_attributed_cost', query_attributed_dollars_estimation,
      'hour_attributed_dbus', query_attributed_dbus_estimation
    )
  ) AS statement_hour_bucket_costs,
  FIRST(qq.start_time) AS start_time,
  FIRST(qq.end_time) AS end_time,
  FIRST(qq.query_work_start_time) AS query_work_start_time,
  FIRST(qq.query_work_end_time) AS query_work_end_time,
  COALESCE(timestampdiff(MILLISECOND, FIRST(qq.start_time), FIRST(qq.end_time))/1000, 0) AS duration_seconds,
  COALESCE(timestampdiff(MILLISECOND, FIRST(qq.query_work_start_time), FIRST(qq.query_work_end_time))/1000, 0) AS query_work_duration_seconds,
  FIRST(query_work_task_time) AS query_work_task_time_seconds,
  SUM(query_attributed_dollars_estimation) AS query_attributed_dollars_estimation,
  SUM(query_attributed_dbus_estimation) AS query_attributed_dbus_estimation,
  FIRST(CASE
    WHEN query_source_type = 'JOB' THEN CONCAT('/jobs/', query_source_id)
    WHEN query_source_type = 'SQL QUERY' THEN CONCAT('/editor/queries/', query_source_id)
    WHEN query_source_type = 'AI/BI DASHBOARD' THEN CONCAT('/sql/dashboardsv3/', query_source_id)
    WHEN query_source_type = 'LEGACY DASHBOARD' THEN CONCAT('/sql/dashboards/', query_source_id)
    WHEN query_source_type = 'ALERT' THEN CONCAT('/sql/alerts/', query_source_id)
    WHEN query_source_type = 'GENIE SPACE' THEN CONCAT('/genie/rooms/', query_source_id)
    WHEN query_source_type = 'NOTEBOOK' THEN CONCAT('/editor/notebooks/', query_source_id)
    ELSE ''
  END) as url_helper,
  FIRST(CONCAT('/sql/history?queryId=', qq.statement_id, '&queryStartTimeMs=', CAST(UNIX_TIMESTAMP(qq.start_time) * 1000 AS BIGINT))) AS query_profile_url,
  FIRST(most_recent_billing_hour) AS most_recent_billing_hour,
  FIRST(billing_record_check) AS billing_record_check,
  date_trunc('HOUR', FIRST(qq.start_time)) AS query_start_hour
FROM query_attribution qa
LEFT JOIN cpq_warehouse_query_history AS qq
  ON qa.statement_id = qq.statement_id
  AND qa.warehouse_id = qq.warehouse_id
GROUP BY qq.statement_id
"""


# Daily tag summary — eliminates repeated EXPLODE scans in tagging bundle and KPI trends
CREATE_DAILY_TAG_SUMMARY = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_tag_summary` CLUSTER BY (usage_date, tag_key) AS
WITH tagged_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) AS price_per_dbu
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
    AND u.custom_tags IS NOT NULL
    AND size(u.custom_tags) > 0
),
exploded AS (
  SELECT
    usage_date,
    workspace_id,
    usage_quantity,
    price_per_dbu,
    tag_key,
    tag_value
  FROM tagged_usage
  LATERAL VIEW EXPLODE(custom_tags) t AS tag_key, tag_value
)
SELECT
  usage_date,
  workspace_id,
  tag_key,
  tag_value,
  SUM(usage_quantity)                    AS total_dbus,
  SUM(usage_quantity * price_per_dbu)    AS total_spend,
  COUNT(*)                               AS usage_row_count
FROM exploded
GROUP BY usage_date, workspace_id, tag_key, tag_value
ORDER BY usage_date, tag_key, tag_value
"""

# Daily tag coverage — exact tagged/untagged totals before tag explosion.
CREATE_DAILY_TAG_COVERAGE_SUMMARY = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_tag_coverage_summary` CLUSTER BY (usage_date, workspace_id) AS
WITH priced_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) AS price_per_dbu
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
)
SELECT
  usage_date,
  workspace_id,
  SUM(CASE WHEN custom_tags IS NOT NULL AND size(custom_tags) > 0
    THEN usage_quantity * price_per_dbu ELSE 0 END) AS tagged_spend,
  SUM(CASE WHEN custom_tags IS NULL OR size(custom_tags) = 0
    THEN usage_quantity * price_per_dbu ELSE 0 END) AS untagged_spend,
  SUM(usage_quantity * price_per_dbu) AS total_spend
FROM priced_usage
GROUP BY usage_date, workspace_id
ORDER BY usage_date, workspace_id
"""

# Daily Apps summary — pre-aggregates billing_origin_product = 'APPS' at
# (usage_date, workspace_id, app_id, sku_name) grain so the Apps bundle's
# summary / apps / timeseries / sku_breakdown slots don't rescan
# system.billing.usage on every request.
CREATE_DAILY_APPS_SUMMARY = """
CREATE OR REPLACE TABLE `{catalog}`.`{schema}`.`daily_apps_summary` CLUSTER BY (usage_date, workspace_id) AS
SELECT
  u.usage_date,
  u.workspace_id,
  COALESCE(u.usage_metadata.app_id, 'Unknown') AS app_id,
  u.sku_name,
  SUM(u.usage_quantity) AS total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS total_spend
FROM system.billing.usage u
/* TEMPORAL_LIST_PRICE_JOIN */
WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
  AND u.usage_quantity > 0
  AND u.billing_origin_product = 'APPS'
GROUP BY u.usage_date, u.workspace_id, COALESCE(u.usage_metadata.app_id, 'Unknown'), u.sku_name
ORDER BY u.usage_date, u.workspace_id
"""

MERGE_DAILY_APPS_SUMMARY = """
MERGE INTO `{catalog}`.`{schema}`.`daily_apps_summary` AS tgt
USING (
  SELECT
    u.usage_date,
    u.workspace_id,
    COALESCE(u.usage_metadata.app_id, 'Unknown') AS app_id,
    u.sku_name,
    SUM(u.usage_quantity) AS total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS total_spend
  FROM system.billing.usage u
  /* TEMPORAL_LIST_PRICE_JOIN */
  WHERE u.usage_date >= DATE('{reprocess_start}')
    AND u.usage_date <= CURRENT_DATE()
    AND u.usage_quantity > 0
    AND u.billing_origin_product = 'APPS'
  GROUP BY u.usage_date, u.workspace_id, COALESCE(u.usage_metadata.app_id, 'Unknown'), u.sku_name
) AS src
ON tgt.usage_date = src.usage_date
  AND tgt.workspace_id = src.workspace_id
  AND tgt.app_id = src.app_id
  AND tgt.sku_name = src.sku_name
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_DAILY_TAG_SUMMARY = """
MERGE INTO `{catalog}`.`{schema}`.`daily_tag_summary` AS tgt
USING (
  WITH tagged_usage AS (
    SELECT
      u.usage_date,
      u.workspace_id,
      u.usage_quantity,
      u.custom_tags,
      COALESCE(p.pricing.default, 0) AS price_per_dbu
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_date <= CURRENT_DATE()
      AND u.usage_quantity > 0
      AND u.custom_tags IS NOT NULL
      AND size(u.custom_tags) > 0
  ),
  exploded AS (
    SELECT
      usage_date,
      workspace_id,
      usage_quantity,
      price_per_dbu,
      tag_key,
      tag_value
    FROM tagged_usage
    LATERAL VIEW EXPLODE(custom_tags) t AS tag_key, tag_value
  )
  SELECT
    usage_date,
    workspace_id,
    tag_key,
    tag_value,
    SUM(usage_quantity)                    AS total_dbus,
    SUM(usage_quantity * price_per_dbu)    AS total_spend,
    COUNT(*)                               AS usage_row_count
  FROM exploded
  GROUP BY usage_date, workspace_id, tag_key, tag_value
) AS src
ON tgt.usage_date = src.usage_date
  AND tgt.workspace_id = src.workspace_id
  AND tgt.tag_key = src.tag_key
  AND tgt.tag_value = src.tag_value
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_DAILY_TAG_COVERAGE_SUMMARY = """
MERGE INTO `{catalog}`.`{schema}`.`daily_tag_coverage_summary` AS tgt
USING (
  WITH priced_usage AS (
    SELECT
      u.usage_date,
      u.workspace_id,
      u.usage_quantity,
      u.custom_tags,
      COALESCE(p.pricing.default, 0) AS price_per_dbu
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_date <= CURRENT_DATE()
      AND u.usage_quantity > 0
  )
  SELECT
    usage_date,
    workspace_id,
    SUM(CASE WHEN custom_tags IS NOT NULL AND size(custom_tags) > 0
      THEN usage_quantity * price_per_dbu ELSE 0 END) AS tagged_spend,
    SUM(CASE WHEN custom_tags IS NULL OR size(custom_tags) = 0
      THEN usage_quantity * price_per_dbu ELSE 0 END) AS untagged_spend,
    SUM(usage_quantity * price_per_dbu) AS total_spend
  FROM priced_usage
  GROUP BY usage_date, workspace_id
) AS src
ON tgt.usage_date = src.usage_date
  AND tgt.workspace_id = src.workspace_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

# Step 3: Refresh-state tracking table
CREATE_MV_REFRESH_STATE = """
CREATE TABLE IF NOT EXISTS `{catalog}`.`{schema}`.`app_mv_refresh_state` (
  table_name STRING NOT NULL,
  last_refresh_at TIMESTAMP,
  last_source_watermark DATE,
  reprocess_window_days INT,
  refresh_count BIGINT
)
CLUSTER BY (table_name)
"""

# Step 4: Per-table incremental refresh configuration
_TABLE_REFRESH_CONFIG: dict[str, dict] = {
    "daily_usage_summary": {
        "reprocess_days": 14,
        "pk": ["usage_date", "workspace_id"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "daily_product_breakdown": {
        "reprocess_days": 14,
        "pk": ["usage_date", "workspace_id", "product_category"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "daily_workspace_breakdown": {
        "reprocess_days": 14,
        "pk": ["usage_date", "workspace_id"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "sql_tool_attribution": {
        "reprocess_days": 7,
        "pk": ["usage_date", "workspace_id", "warehouse_id", "sql_product"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "daily_query_stats": {
        "reprocess_days": 7,
        "pk": ["usage_date", "workspace_id"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "dbsql_cost_per_query": {
        "reprocess_days": 5,
        "pk": ["statement_id"],
        "source_date_col": "query_date",
        "overlap_days": 1,
    },
    "daily_tag_summary": {
        "reprocess_days": 14,
        "pk": ["usage_date", "workspace_id", "tag_key", "tag_value"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "daily_tag_coverage_summary": {
        "reprocess_days": 14,
        "pk": ["usage_date", "workspace_id"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
    "daily_apps_summary": {
        "reprocess_days": 14,
        "pk": ["usage_date", "workspace_id", "app_id", "sku_name"],
        "source_date_col": "usage_date",
        "overlap_days": 0,
    },
}

_QUERY_WATERMARK_TABLES = {
    "sql_tool_attribution",
    "daily_query_stats",
    "dbsql_cost_per_query",
}
_SOURCE_WATERMARK_SQL = {
    "billing": "SELECT MAX(usage_date) AS watermark FROM system.billing.usage",
    "query": "SELECT MAX(DATE(start_time)) AS watermark FROM system.query.history",
}

_OPTIMIZE_EVERY_N_REFRESHES = 12
_MV_DDL_TIMEOUT_SECONDS = 300
_MV_REFRESH_MAX_WORKERS = 3

# Step 6: MERGE templates for incremental refresh

MERGE_DAILY_USAGE_SUMMARY = """
MERGE INTO `{catalog}`.`{schema}`.`daily_usage_summary` AS tgt
USING (
  WITH usage_with_price AS (
    SELECT
      u.usage_date,
      u.workspace_id,
      u.sku_name,
      u.billing_origin_product,
      u.usage_quantity,
      u.identity_metadata.run_as AS run_as,
      COALESCE(p.pricing.default, 0) as price_per_dbu,
      COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_date <= CURRENT_DATE()
      AND u.usage_quantity > 0
  )
  SELECT
    usage_date,
    workspace_id,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend,
    SUM(usage_quantity * effective_price_per_dbu) as effective_list_spend,
    SUM(CASE WHEN run_as IS NOT NULL THEN usage_quantity * price_per_dbu ELSE 0 END) as user_attributed_spend
  FROM usage_with_price
  GROUP BY usage_date, workspace_id
) AS src
ON tgt.usage_date = src.usage_date AND tgt.workspace_id = src.workspace_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_DAILY_PRODUCT_BREAKDOWN = """
MERGE INTO `{catalog}`.`{schema}`.`daily_product_breakdown` AS tgt
USING (
  WITH usage_with_price AS (
    SELECT
      u.usage_date,
      u.workspace_id,
      u.sku_name,
      u.billing_origin_product,
      u.usage_quantity,
      u.usage_metadata,
      COALESCE(p.pricing.default, 0) as price_per_dbu,
      COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu,
      CASE
        WHEN u.billing_origin_product = 'SQL' THEN 'SQL'
        WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
        WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
        WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
        WHEN u.billing_origin_product = 'SERVING' OR u.billing_origin_product = 'MODEL_SERVING'
             OR u.sku_name LIKE '%SERVING%' OR u.sku_name LIKE '%INFERENCE%'
             OR u.sku_name LIKE '%PROVISIONED_THROUGHPUT%' THEN 'Model Serving'
        WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'AI Search'
        WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
        WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
             OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
        WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
        ELSE 'Other'
      END as product_category
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
      AND u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_quantity > 0
  )
  SELECT
    usage_date,
    workspace_id,
    product_category,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend,
    SUM(usage_quantity * effective_price_per_dbu) as effective_list_spend
  FROM usage_with_price
  GROUP BY usage_date, workspace_id, product_category
) AS src
ON tgt.usage_date = src.usage_date AND tgt.workspace_id = src.workspace_id AND tgt.product_category = src.product_category
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_DAILY_WORKSPACE_BREAKDOWN = """
MERGE INTO `{catalog}`.`{schema}`.`daily_workspace_breakdown` AS tgt
USING (
  WITH usage_with_price AS (
    SELECT
      u.usage_date,
      u.workspace_id,
      u.sku_name,
      u.usage_quantity,
      COALESCE(p.pricing.default, 0) as price_per_dbu,
      COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
      AND u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_quantity > 0
  )
  SELECT
    uwp.usage_date,
    uwp.workspace_id,
    ws.workspace_name,
    SUM(uwp.usage_quantity) as total_dbus,
    SUM(uwp.usage_quantity * uwp.price_per_dbu) as total_spend,
    SUM(uwp.usage_quantity * uwp.effective_price_per_dbu) as effective_list_spend
  FROM usage_with_price uwp
  LEFT JOIN system.access.workspaces_latest ws ON uwp.workspace_id = ws.workspace_id
  GROUP BY uwp.usage_date, uwp.workspace_id, ws.workspace_name
) AS src
ON tgt.usage_date = src.usage_date AND tgt.workspace_id = src.workspace_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_SQL_TOOL_ATTRIBUTION = """
MERGE INTO `{catalog}`.`{schema}`.`sql_tool_attribution` AS tgt
USING (
  WITH sql_query_work AS (
    SELECT
      CASE
        WHEN client_application LIKE '%Genie%' THEN 'Genie'
        ELSE 'DBSQL'
      END AS sql_product,
      DATE(start_time) AS usage_date,
      workspace_id,
      compute.warehouse_id AS warehouse_id,
      SUM(total_task_duration_ms) AS work_ms
    FROM system.query.history
    WHERE executed_as_user_id IS NOT NULL
      AND compute.warehouse_id IS NOT NULL
      AND DATE(start_time) >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
      AND DATE(start_time) >= DATE('{reprocess_start}')
    GROUP BY 1, 2, 3, 4
  ),
  sql_usage AS (
    SELECT
      u.usage_date,
      u.workspace_id,
      u.usage_metadata.warehouse_id as warehouse_id,
      SUM(u.usage_quantity) as total_dbus,
      SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
      SUM(u.usage_quantity * COALESCE(p.pricing.effective_list.default, p.pricing.default, 0)) as effective_list_spend
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.billing_origin_product = 'SQL'
      AND u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
      AND u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_quantity > 0
    GROUP BY 1, 2, 3
  ),
  warehouse_totals AS (
    SELECT
      usage_date,
      workspace_id,
      warehouse_id,
      SUM(work_ms) as total_work_ms
    FROM sql_query_work
    GROUP BY usage_date, workspace_id, warehouse_id
  )
  SELECT
    q.sql_product,
    q.usage_date,
    q.workspace_id,
    q.warehouse_id,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_dbus
      ELSE 0
    END as attributed_dbus,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_spend
      ELSE 0
    END as attributed_spend,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.effective_list_spend
      ELSE 0
    END as attributed_effective_list_spend
  FROM sql_query_work q
  JOIN warehouse_totals w ON q.usage_date = w.usage_date AND q.workspace_id = w.workspace_id AND q.warehouse_id = w.warehouse_id
  LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.workspace_id = s.workspace_id AND q.warehouse_id = s.warehouse_id
) AS src
ON tgt.usage_date = src.usage_date AND tgt.workspace_id = src.workspace_id AND tgt.warehouse_id = src.warehouse_id AND tgt.sql_product = src.sql_product
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_QUERY_STATS = """
MERGE INTO `{catalog}`.`{schema}`.`daily_query_stats` AS tgt
USING (
  SELECT
    DATE(start_time) as usage_date,
    workspace_id,
    COUNT(*) as total_queries,
    COUNT(DISTINCT COALESCE(executed_by, executed_as_user_id)) as unique_query_users,
    SUM(COALESCE(read_rows, 0)) as total_rows_read,
    SUM(COALESCE(read_bytes, 0)) as total_bytes_read,
    SUM(COALESCE(total_task_duration_ms, 0)) / 1000.0 as total_compute_seconds
  FROM system.query.history
  WHERE DATE(start_time) >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND DATE(start_time) >= DATE('{reprocess_start}')
  GROUP BY DATE(start_time), workspace_id
) AS src
ON tgt.usage_date = src.usage_date AND tgt.workspace_id = src.workspace_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.usage_date >= DATE('{reprocess_start}')
  AND tgt.usage_date <= CURRENT_DATE()
THEN DELETE
"""

MERGE_DBSQL_COST_PER_QUERY = """
MERGE INTO `{catalog}`.`{schema}`.`dbsql_cost_per_query` AS tgt
USING (
  WITH
  warehouse_hourly_usage AS (
    SELECT
      DATE_TRUNC('hour', u.usage_start_time) AS hour_bucket,
      u.usage_metadata.warehouse_id AS warehouse_id,
      SUM(u.usage_quantity) AS hourly_dbus,
      SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS hourly_dollars,
      SUM(u.usage_quantity * COALESCE(p.pricing.effective_list.default, p.pricing.default, 0)) AS hourly_dollars_effective
    FROM system.billing.usage u
    /* TEMPORAL_LIST_PRICE_JOIN */
    WHERE u.billing_origin_product = 'SQL'
      AND u.usage_metadata.warehouse_id IS NOT NULL
      AND u.usage_start_time >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
      AND u.usage_start_time >= DATE('{reprocess_start}') - INTERVAL 1 DAY
    GROUP BY 1, 2
  ),
  queries_with_details AS (
    SELECT
      q.statement_id,
      q.statement_text,
      COALESCE(q.executed_by, q.executed_as_user_id) AS executed_by,
      q.compute.warehouse_id AS warehouse_id,
      q.workspace_id,
      q.start_time,
      q.end_time,
      (UNIX_TIMESTAMP(q.end_time) - UNIX_TIMESTAMP(q.start_time)) AS duration_seconds,
      q.total_task_duration_ms,
      q.client_application,
      CASE
        WHEN q.client_application LIKE '%genie%' OR q.client_application LIKE '%Genie%' THEN 'GENIE SPACE'
        WHEN q.client_application LIKE '%dashboard%' OR q.client_application LIKE '%Dashboard%' THEN
          CASE
            WHEN q.client_application LIKE '%lakeview%' OR q.client_application LIKE '%aibi%' THEN 'AI/BI DASHBOARD'
            ELSE 'LEGACY DASHBOARD'
          END
        WHEN q.client_application LIKE '%notebook%' OR q.client_application LIKE '%Notebook%' THEN 'NOTEBOOK'
        WHEN q.client_application LIKE '%job%' OR q.client_application LIKE '%Job%' OR q.statement_type = 'JOB' THEN 'JOB'
        WHEN q.client_application LIKE '%alert%' OR q.client_application LIKE '%Alert%' THEN 'ALERT'
        WHEN q.client_application LIKE '%sql-editor%' OR q.client_application LIKE '%SQL Editor%' THEN 'SQL QUERY'
        ELSE 'SQL QUERY'
      END AS query_source_type,
      CASE
        WHEN q.client_application LIKE '%genie%' THEN REGEXP_EXTRACT(q.client_application, 'genie[/-]([a-zA-Z0-9-]+)', 1)
        WHEN q.client_application LIKE '%dashboard%' THEN REGEXP_EXTRACT(q.client_application, 'dashboard[/-]([a-zA-Z0-9-]+)', 1)
        ELSE NULL
      END AS query_source_id
    FROM system.query.history q
    WHERE q.compute.warehouse_id IS NOT NULL
      AND q.start_time >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
      AND q.start_time >= DATE('{reprocess_start}') - INTERVAL 1 DAY
      AND q.statement_type != 'CANCEL'
      AND (q.executed_by IS NOT NULL OR q.executed_as_user_id IS NOT NULL)
  ),
  warehouse_hourly_work AS (
    SELECT
      DATE_TRUNC('hour', start_time) AS hour_bucket,
      warehouse_id,
      SUM(COALESCE(total_task_duration_ms, duration_seconds * 1000)) AS total_work_ms
    FROM queries_with_details
    GROUP BY 1, 2
  ),
  query_costs AS (
    SELECT
      q.statement_id,
      q.statement_text,
      q.executed_by,
      q.warehouse_id,
      q.workspace_id,
      q.start_time,
      q.end_time,
      q.duration_seconds,
      q.client_application,
      q.query_source_type,
      q.query_source_id,
      q.total_task_duration_ms,
      DATE_TRUNC('hour', q.start_time) AS query_hour,
      CASE
        WHEN w.total_work_ms > 0 THEN
          (COALESCE(q.total_task_duration_ms, q.duration_seconds * 1000) / w.total_work_ms) * h.hourly_dbus
        ELSE 0
      END AS query_attributed_dbus_estimation,
      CASE
        WHEN w.total_work_ms > 0 THEN
          (COALESCE(q.total_task_duration_ms, q.duration_seconds * 1000) / w.total_work_ms) * h.hourly_dollars
        ELSE 0
      END AS query_attributed_dollars_estimation,
      CASE
        WHEN w.total_work_ms > 0 THEN
          (COALESCE(q.total_task_duration_ms, q.duration_seconds * 1000) / w.total_work_ms) * h.hourly_dollars_effective
        ELSE 0
      END AS query_attributed_dollars_effective
    FROM queries_with_details q
    LEFT JOIN warehouse_hourly_work w
      ON DATE_TRUNC('hour', q.start_time) = w.hour_bucket
      AND q.warehouse_id = w.warehouse_id
    LEFT JOIN warehouse_hourly_usage h
      ON DATE_TRUNC('hour', q.start_time) = h.hour_bucket
      AND q.warehouse_id = h.warehouse_id
  )
  SELECT
    statement_id,
    query_source_id,
    query_source_type,
    client_application,
    executed_by,
    warehouse_id,
    statement_text,
    CAST(workspace_id AS STRING) AS workspace_id,
    start_time,
    end_time,
    duration_seconds,
    query_attributed_dollars_estimation,
    query_attributed_dbus_estimation,
    CONCAT(
      'https://DATABRICKS_HOST/sql/history?o=',
      CAST(workspace_id AS STRING),
      '&queryId=',
      statement_id,
      '&queryStartTimeMs=',
      CAST(UNIX_TIMESTAMP(start_time) * 1000 AS BIGINT)
    ) AS query_profile_url,
    CASE
      WHEN query_source_type = 'GENIE SPACE' AND query_source_id IS NOT NULL THEN
        CONCAT('https://DATABRICKS_HOST/genie/rooms/', query_source_id)
      WHEN query_source_type = 'AI/BI DASHBOARD' AND query_source_id IS NOT NULL THEN
        CONCAT('https://DATABRICKS_HOST/sql/dashboardsv3/', query_source_id)
      WHEN query_source_type = 'LEGACY DASHBOARD' AND query_source_id IS NOT NULL THEN
        CONCAT('https://DATABRICKS_HOST/sql/dashboards/', query_source_id)
      WHEN query_source_type = 'SQL QUERY' AND query_source_id IS NOT NULL THEN
        CONCAT('https://DATABRICKS_HOST/editor/queries/', query_source_id)
      ELSE NULL
    END AS url_helper,
    DATE(start_time) AS query_date
  FROM query_costs
  WHERE query_attributed_dollars_estimation > 0
     OR query_attributed_dbus_estimation > 0
     OR duration_seconds > 0
  ORDER BY start_time DESC
) AS src
ON tgt.statement_id = src.statement_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
WHEN NOT MATCHED BY SOURCE
  AND tgt.query_date >= DATE('{reprocess_start}')
  AND tgt.query_date <= CURRENT_DATE()
THEN DELETE
"""


# Step 5: Helper functions for incremental refresh

def _ensure_refresh_state_table(catalog: str, schema: str) -> None:
    """Create app_mv_refresh_state tracking table if it doesn't exist."""
    try:
        execute_query(CREATE_MV_REFRESH_STATE.format(catalog=catalog, schema=schema), no_cache=True)
    except Exception as e:
        logger.warning("Could not create app_mv_refresh_state (non-fatal): %s", e)


def _get_refresh_state(catalog: str, schema: str, table_name: str) -> dict | None:
    """Return current refresh state for a table, or None if no state exists."""
    try:
        rows = execute_query(
            f"SELECT last_refresh_at, last_source_watermark, refresh_count "
            f"FROM `{catalog}`.`{schema}`.`app_mv_refresh_state` "
            f"WHERE table_name = :table_name LIMIT 1",
            {"table_name": table_name},
            no_cache=True,
        )
        if rows:
            return {
                "last_refresh_at": rows[0].get("last_refresh_at"),
                "watermark": rows[0].get("last_source_watermark"),
                "refresh_count": int(rows[0].get("refresh_count") or 0),
            }
    except Exception:
        pass
    return None


def _watermark_date(value) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _source_kind(table_name: str) -> str:
    return "query" if table_name in _QUERY_WATERMARK_TABLES else "billing"


def _load_source_watermarks() -> dict[str, date | None]:
    """Read each source family watermark once per refresh operation."""
    watermarks: dict[str, date | None] = {}
    for source_kind, query in _SOURCE_WATERMARK_SQL.items():
        try:
            rows = execute_query(query, no_cache=True, timeout=30)
            watermarks[source_kind] = _watermark_date(
                rows[0].get("watermark") if rows else None
            )
        except Exception as exc:
            logger.warning(
                "Could not read %s source watermark (non-fatal): %s",
                source_kind,
                exc,
            )
            watermarks[source_kind] = None
    return watermarks


def _refresh_gap_exceeds_window(
    state: dict | None,
    source_watermark: date | None,
    reprocess_days: int,
    overlap_days: int,
    *,
    as_of: date | None = None,
) -> bool:
    prior_watermark = _watermark_date((state or {}).get("watermark"))
    if prior_watermark is None:
        return False
    window_days = int(reprocess_days) + int(overlap_days)
    elapsed_days = ((as_of or date.today()) - prior_watermark).days
    if source_watermark is None:
        # After a long outage, an unavailable source probe cannot prove the
        # rolling window covers every date. Prefer a safe full rebuild.
        return elapsed_days > window_days
    if source_watermark <= prior_watermark:
        # The source has not advanced, so there are no new rows to recover.
        return False
    return (
        elapsed_days > window_days
        or (source_watermark - prior_watermark).days > window_days
    )


def _resolved_refresh_watermark(
    catalog: str,
    schema: str,
    table_name: str,
    state: dict | None,
    source_watermark: date | None,
) -> date | None:
    """Prefer the source watermark, preserving or deriving a safe fallback."""
    if source_watermark is not None:
        return source_watermark
    prior = _watermark_date((state or {}).get("watermark"))
    if prior is not None:
        return prior
    source_date_col = _TABLE_REFRESH_CONFIG.get(table_name, {}).get(
        "source_date_col",
        "usage_date",
    )
    try:
        rows = execute_query(
            f"SELECT MAX(`{source_date_col}`) AS watermark "
            f"FROM `{catalog}`.`{schema}`.`{table_name}`",
            no_cache=True,
        )
        return _watermark_date(rows[0].get("watermark") if rows else None)
    except Exception:
        return None


_DEDUP_SKIP: frozenset = frozenset({"dbsql_cost_per_query"})


def _dedup_delta_table(catalog: str, schema: str, table_name: str, pk_cols: list) -> int:
    """Remove duplicate rows on the table's unique key, keeping one per key.

    Delta enforces no primary key, so concurrent MERGE races (or legacy rows) can leave
    duplicate rows that inflate SUM aggregations on the dashboard. Detect via GROUP BY …
    HAVING COUNT(*) > 1 (NULL-safe, unlike COUNT(DISTINCT)); if any exist, rewrite the table
    keeping one row per key via ROW_NUMBER. Returns duplicated keys removed (0 = clean, no
    rewrite). No-op for tables without a key or in _DEDUP_SKIP.
    """
    if not pk_cols or table_name in _DEDUP_SKIP:
        return 0
    fq = f"`{catalog}`.`{schema}`.`{table_name}`"
    partition = ", ".join(f"`{c}`" for c in pk_cols)
    try:
        chk = execute_query(
            f"SELECT COUNT(*) AS dup_keys FROM "
            f"(SELECT 1 FROM {fq} GROUP BY {partition} HAVING COUNT(*) > 1)",
            no_cache=True,
        )
        dup_keys = int((chk[0].get("dup_keys") if chk else 0) or 0)
        if dup_keys <= 0:
            return 0
        logger.warning("Deduping %s: %d duplicated keys found — rewriting", table_name, dup_keys)
        execute_query(
            f"INSERT OVERWRITE TABLE {fq} SELECT * EXCEPT(_dedup_rn) FROM ("
            f"  SELECT *, ROW_NUMBER() OVER (PARTITION BY {partition} ORDER BY {partition}) AS _dedup_rn "
            f"  FROM {fq}"
            f") WHERE _dedup_rn = 1",
            no_cache=True,
        )
        return dup_keys
    except Exception as e:
        logger.warning("Dedup of %s failed (non-fatal): %s", table_name, e)
        return 0


def _update_refresh_state(
    catalog: str,
    schema: str,
    table_name: str,
    refresh_count: int,
    source_watermark: date | None,
) -> None:
    """Upsert refresh state after a successful table refresh."""
    try:
        cfg = _TABLE_REFRESH_CONFIG.get(table_name, {})
        reprocess_days = int(cfg.get("reprocess_days", 14))
        execute_query(
            f"""MERGE INTO `{catalog}`.`{schema}`.`app_mv_refresh_state` AS tgt
            USING (SELECT
                :table_name AS table_name,
                CURRENT_TIMESTAMP() AS last_refresh_at,
                CAST(:source_watermark AS DATE) AS last_source_watermark,
                :reprocess_days AS reprocess_window_days,
                :refresh_count AS refresh_count
            ) AS src
            ON tgt.table_name = src.table_name
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED BY TARGET THEN INSERT *""",
            {
                "table_name": table_name,
                "source_watermark": (
                    source_watermark.isoformat() if source_watermark else None
                ),
                "reprocess_days": reprocess_days,
                "refresh_count": refresh_count,
            },
            no_cache=True,
        )
    except Exception as e:
        logger.warning("Could not update refresh state for %s (non-fatal): %s", table_name, e)


def create_materialized_views(catalog: str | None = None, schema: str | None = None, lookback_days: int = 180, on_table_event: "Callable[[str, str], None] | None" = None, force_full_rebuild: bool = False) -> dict:
    """Refresh base tables and dependent unified views as one ordered operation."""
    with unified_views_rebuild_lock():
        return _create_materialized_views_locked(
            catalog,
            schema,
            lookback_days=lookback_days,
            on_table_event=on_table_event,
            force_full_rebuild=force_full_rebuild,
        )


def _create_materialized_views_locked(catalog: str | None = None, schema: str | None = None, lookback_days: int = 180, on_table_event: "Callable[[str, str], None] | None" = None, force_full_rebuild: bool = False) -> dict:
    """Create all materialized view tables.

    Args:
        catalog: Target catalog (required — must be a dedicated, non-reserved catalog)
        schema: Target schema (required — must be a dedicated, non-reserved schema)
        lookback_days: How many days of history to include (default 180 = 6 months)

    Returns:
        Dict with status of each table creation
    """
    if catalog is None or schema is None:
        cat, sch = get_catalog_schema()
        catalog = catalog or cat
        schema = schema or sch

    # Hard safety gate — never touch forbidden or unconfigured locations
    from server.db import StorageConfigurationError, validate_app_storage_target
    try:
        validate_app_storage_target(catalog, schema)
    except StorageConfigurationError as e:
        logger.critical("create_materialized_views REFUSED: %s", e)
        return {"error": f"error: {e}"}

    results = {}

    # ── Step 0: ensure the catalog exists ────────────────────────────────────
    # `CREATE CATALOG IF NOT EXISTS` is a no-op when the catalog already exists,
    # and creates it when the running identity has CREATE CATALOG privilege (e.g.
    # the setup wizard runs as the user, who may be a metastore admin).
    # If we can't create it AND it doesn't exist, we surface a clear error
    # instead of letting a cryptic "SCHEMA_DOES_NOT_EXIST" or misclassified
    # permission error bubble up from the CREATE SCHEMA step.
    if catalog != "main":
        try:
            execute_query(f"CREATE CATALOG IF NOT EXISTS `{catalog}` COMMENT 'Cost Observability data'", no_cache=True)
            logger.info(f"Catalog `{catalog}` is ready")
            results["catalog"] = "ok"
        except Exception as _cat_e:
            _cat_err = str(_cat_e)
            # Verify whether the catalog already exists despite the error
            _cat_exists = False
            try:
                from server.db import get_user_workspace_client, get_workspace_client
                for _wc in [get_user_workspace_client(), get_workspace_client()]:
                    try:
                        next(iter(_wc.schemas.list(catalog_name=catalog)), None)
                        _cat_exists = True
                        break
                    except Exception:
                        pass
            except Exception:
                pass
            if _cat_exists:
                logger.info(f"Catalog `{catalog}` already exists (CREATE CATALOG not permitted but catalog is accessible)")
                results["catalog"] = "exists"
            else:
                logger.error(f"Catalog `{catalog}` does not exist and could not be created: {_cat_err}")
                results["catalog"] = (
                    f"error: Catalog `{catalog}` does not exist. "
                    f"Create it in the Databricks catalog explorer (Data > Create catalog), "
                    f"then return to this step and click 'Create Tables'."
                )
                return results

    # ── Step 1: ensure the schema exists ─────────────────────────────────────
    # Use tables.list() for existence detection — the x-forwarded-access-token has the
    # "sql" scope which authorises tables.list() but NOT schemas.get() (a UC management
    # API requiring a broader scope).  schemas.get() always returns 403 in Databricks
    # Apps, so silently treating it as "not found" caused us to always attempt CREATE
    # SCHEMA, which then fails for users without CREATE SCHEMA privilege even when the
    # schema is already there.  tables.list() is exactly what check_materialized_views_exist
    # uses and is reliably authorised by the SQL-scoped token.
    try:
        from server.db import get_user_workspace_client, get_workspace_client
        _schema_exists = False
        for label, _wc in [("user", get_user_workspace_client()), ("sp", get_workspace_client())]:
            try:
                # Consume the iterator — empty list means schema exists with no tables yet
                list(_wc.tables.list(catalog_name=catalog, schema_name=schema))
                _schema_exists = True
                logger.info(f"Schema {catalog}.{schema} exists (confirmed via tables.list, {label})")
                break
            except Exception as _e:
                _emsg = str(_e)
                if any(x in _emsg for x in ("SCHEMA_DOES_NOT_EXIST", "does not exist", "not found")):
                    # Definitive: schema is absent — no need to try other clients
                    logger.info(f"Schema {catalog}.{schema} confirmed absent via tables.list ({label}): {_emsg}")
                    break
                logger.debug(f"tables.list schema check failed ({label}): {_emsg}")
        if _schema_exists:
            logger.info(f"Schema {catalog}.{schema} already exists — skipping CREATE")
            results["schema"] = "exists"
        else:
            logger.info(f"Creating schema {catalog}.{schema}...")
            execute_query(CREATE_SCHEMA_SQL.format(catalog=catalog, schema=schema), no_cache=True)
            results["schema"] = "created"
    except Exception as e:
        err_str = str(e)
        err_lower = err_str.lower()
        if any(kw in err_lower for kw in ("insufficient_privileges", "does not have", "permission", "unauthorized", "error during request")):
            from server.db import _user_token, get_workspace_client
            # Identify who actually ran the query so the error message is accurate
            running_as_user = bool(_user_token.get())
            try:
                if running_as_user:
                    from server.db import get_user_workspace_client
                    identity = get_user_workspace_client().current_user.me().user_name or "your user account"
                    grant_note = "As a metastore admin, run:"
                else:
                    identity = get_workspace_client().current_user.me().user_name or "<app-service-principal>"
                    grant_note = "A catalog owner or metastore admin must run:"
            except Exception:
                identity = "your user account" if running_as_user else "<app-service-principal>"
                grant_note = "A catalog owner or metastore admin must run:"
            friendly = (
                f"`{identity}` needs CREATE SCHEMA permission on the `{catalog}` catalog. "
                f"{grant_note} "
                f"GRANT USE CATALOG ON CATALOG {catalog} TO `{identity}`; "
                f"GRANT CREATE SCHEMA ON CATALOG {catalog} TO `{identity}`"
            )
            logger.error(f"Failed to create schema (permission error, running_as_user={running_as_user}): {err_str}")
            results["schema"] = f"error: {friendly}"
        else:
            logger.error(f"Failed to create schema: {e}")
            results["schema"] = f"error: {err_str}"
        return results  # Can't continue without schema

    # Ensure incremental refresh state table exists (non-fatal if it fails)
    try:
        _ensure_refresh_state_table(catalog, schema)
    except Exception as _rse:
        logger.warning("_ensure_refresh_state_table failed (non-fatal): %s", _rse)

    # List of tables to create
    tables = list(CREATE_MV_TABLES.items())
    source_watermarks = _load_source_watermarks()

    # Create all tables in parallel — none depend on each other
    import time as _time
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _create_table(table_name: str, create_sql: str) -> tuple[str, str, float]:
        from datetime import timedelta as _td
        t0 = _time.monotonic()
        if on_table_event:
            on_table_event(table_name, "running")
        try:
            logger.info(f"Refreshing table {catalog}.{schema}.{table_name}...")
            cfg = _TABLE_REFRESH_CONFIG.get(table_name, {})
            state = _get_refresh_state(catalog, schema, table_name)
            source_watermark = source_watermarks.get(_source_kind(table_name))

            # If no state record exists but the table already has rows, recover
            # gracefully by using the incremental MERGE path. This prevents an
            # unnecessary full CREATE (which is expensive on large workspaces)
            # when app_mv_refresh_state was cleared or never populated. The MERGE
            # will cover the rolling reprocess window; any larger data gap was
            # presumably backfilled manually or by a prior catch-up run.
            if not force_full_rebuild and not state:
                try:
                    source_date_col = cfg.get("source_date_col", "usage_date")
                    _cnt = execute_query(
                        f"SELECT COUNT(*) AS cnt, MAX(`{source_date_col}`) AS watermark "
                        f"FROM `{catalog}`.`{schema}`.`{table_name}`",
                        no_cache=True,
                    )
                    if _cnt and int(_cnt[0].get("cnt", 0) or 0) > 0:
                        state = {
                            "watermark": _cnt[0].get("watermark"),
                            "refresh_count": 0,
                        }
                        logger.info(
                            "%s: recovered missing refresh state from target watermark",
                            table_name,
                        )
                except Exception:
                    pass  # no table yet — fall through to full CREATE

            reprocess_days = int(cfg.get("reprocess_days", 14))
            overlap_days = int(cfg.get("overlap_days", 0))
            gap_requires_full = _refresh_gap_exceeds_window(
                state,
                source_watermark,
                reprocess_days,
                overlap_days,
            )
            if gap_requires_full:
                logger.warning(
                    "%s: source advanced beyond the %d-day incremental window; "
                    "promoting to a full rebuild",
                    table_name,
                    reprocess_days + overlap_days,
                )

            if (
                not force_full_rebuild
                and not gap_requires_full
                and state
                and state.get("watermark")
            ):
                # Incremental path: MERGE reprocess window
                reprocess_start = date.today() - _td(days=reprocess_days + overlap_days)

                merge_sql = MERGE_MV_TABLES.get(table_name)

                if merge_sql:
                    try:
                        execute_query(merge_sql.format(
                            catalog=catalog, schema=schema,
                            reprocess_start=str(reprocess_start),
                            billing_lookback_days=lookback_days,
                        ), no_cache=True, timeout=_MV_DDL_TIMEOUT_SECONDS)
                        # Self-heal duplicate rows the incremental MERGE path can leave
                        # (Delta has no PK enforcement). Full rebuilds are dup-free (GROUP BY).
                        _dedup_delta_table(catalog, schema, table_name,
                                           _TABLE_REFRESH_CONFIG.get(table_name, {}).get("pk") or [])
                        new_count = state["refresh_count"] + 1
                        _update_refresh_state(
                            catalog,
                            schema,
                            table_name,
                            new_count,
                            _resolved_refresh_watermark(
                                catalog,
                                schema,
                                table_name,
                                state,
                                source_watermark,
                            ),
                        )

                        # Periodic OPTIMIZE
                        if new_count % _OPTIMIZE_EVERY_N_REFRESHES == 0:
                            try:
                                logger.info(f"Running OPTIMIZE on {table_name} (refresh #{new_count})")
                                execute_query(f"OPTIMIZE `{catalog}`.`{schema}`.`{table_name}`", no_cache=True)
                            except Exception as opt_e:
                                logger.warning("OPTIMIZE %s failed (non-fatal): %s", table_name, opt_e)

                        elapsed = _time.monotonic() - t0
                        logger.info(f"✓ {table_name} incremental refresh done in {elapsed:.1f}s (window: {reprocess_start})")
                        if on_table_event:
                            on_table_event(table_name, "done")
                        return table_name, "refreshed", elapsed
                    except Exception as merge_e:
                        logger.warning(f"Incremental MERGE failed for {table_name}, falling back to full rebuild: {merge_e}")
                        # fall through to full rebuild below

            # Full rebuild path (bootstrap or fallback)
            execute_query(
                create_sql.format(
                    catalog=catalog,
                    schema=schema,
                    billing_lookback_days=lookback_days,
                ),
                no_cache=True,
                timeout=_MV_DDL_TIMEOUT_SECONDS,
            )
            _update_refresh_state(
                catalog,
                schema,
                table_name,
                1,
                _resolved_refresh_watermark(
                    catalog,
                    schema,
                    table_name,
                    state,
                    source_watermark,
                ),
            )
            elapsed = _time.monotonic() - t0
            logger.info(f"✓ {table_name} full rebuild done in {elapsed:.1f}s")
            if on_table_event:
                on_table_event(table_name, "done")
            return table_name, "created", elapsed
        except Exception as e:
            elapsed = _time.monotonic() - t0
            logger.error(f"✗ Failed to refresh {table_name}: {e}")
            if on_table_event:
                on_table_event(table_name, "error")
            return table_name, f"error: {e}", elapsed

    mv_timings: dict[str, float] = {}
    with ThreadPoolExecutor(
        max_workers=min(_MV_REFRESH_MAX_WORKERS, len(tables))
    ) as executor:
        futures = {executor.submit(_create_table, name, sql): name for name, sql in tables}
        for future in as_completed(futures):
            table_name, status, elapsed = future.result()
            results[table_name] = status
            mv_timings[table_name] = round(elapsed, 2)

    results["__mv_timings__"] = mv_timings  # type: ignore[assignment]

    # A full CREATE OR REPLACE can swap the base Delta table object underneath an
    # existing view. Rebuild the shared-source views only after every base-table
    # worker has finished, never concurrently with the replacements above.
    try:
        from server.db import get_mv_sources

        if get_mv_sources():
            _rebuild_unified_views_locked(catalog, schema)
    except Exception as e:
        # Base tables are still usable when shared-source view maintenance fails.
        logger.warning("Post-refresh unified-view rebuild failed (non-fatal): %s", e)

    return results


def refresh_materialized_views(catalog: str | None = None, schema: str | None = None, lookback_days: int = 180, on_table_event: "Callable[[str, str], None] | None" = None, force_full_rebuild: bool = False) -> dict:
    """Refresh all materialized view tables (same as create - full refresh)."""
    return create_materialized_views(catalog, schema, lookback_days=lookback_days, on_table_event=on_table_event, force_full_rebuild=force_full_rebuild)


_APP_CONFIG_TABLES = [
    "app_cloud_connections",
    "app_mv_refresh_state",
    "app_mv_sources",
    "app_refresh_log",
    "app_response_cache",
    "app_settings",
    "app_unified_views",
    "app_user_permissions",
]


def drop_materialized_views(catalog: str | None = None, schema: str | None = None) -> dict:
    """Drop all app-managed tables — both MV data tables and config tables.

    Returns a dict mapping each table name to 'dropped' or an error string.
    """
    if catalog is None or schema is None:
        cat, sch = get_catalog_schema()
        catalog = catalog or cat
        schema = schema or sch

    from server.db import (
        MV_SOURCE_ROWS_SUFFIX,
        MV_UNIFIED_SUFFIX,
        validate_app_storage_target,
    )

    validate_app_storage_target(catalog, schema)
    results: dict[str, str] = {}
    for name in _MV_TABLES:
        for suffix in (MV_UNIFIED_SUFFIX, MV_SOURCE_ROWS_SUFFIX):
            view_name = f"{name}{suffix}"
            try:
                execute_query(
                    f"DROP VIEW IF EXISTS `{catalog}`.`{schema}`.`{view_name}`",
                    no_cache=True,
                )
                results[view_name] = "dropped"
            except Exception as e:
                results[view_name] = f"error: {e}"
    for name in _MV_TABLES + _APP_CONFIG_TABLES:
        try:
            execute_query(f"DROP TABLE IF EXISTS `{catalog}`.`{schema}`.`{name}`", no_cache=True)
            results[name] = "dropped"
        except Exception as e:
            results[name] = f"error: {e}"
    return results


_MV_TABLES = list(MV_UNIFIED_TABLE_NAMES)

_UNIFIED_VIEWS_LOCK_PATH = "/tmp/cost-obs-unified-views.lock"


@contextmanager
def unified_views_rebuild_lock(
    *, blocking: bool = True, lock_path: str = _UNIFIED_VIEWS_LOCK_PATH
) -> Iterator[IO[str]]:
    """Cross-process mutex for every unified-view DDL pass.

    Uvicorn workers are separate processes, so a threading lock cannot protect
    Databricks from overlapping ALTER/CREATE/DROP statements. Callers normally
    block so an explicit source add/remove is never lost; startup de-duplication
    is handled separately in ``server.app``.
    """
    with open(lock_path, "a+") as lock_file:
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(lock_file, flags)
        try:
            yield lock_file
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def _table_columns(full_table: str) -> list[str] | None:
    """Ordered column names for a (backticked) table path, or None if unreadable.

    Doubles as a readability probe — a Delta-shared source the app can't SELECT
    from raises here and is skipped rather than breaking the union.
    """
    from server.db import execute_query
    try:
        rows = execute_query(f"DESCRIBE TABLE {full_table}", no_cache=True)
    except Exception as e:
        logger.info("MV source not readable, skipping: %s (%s)", full_table, e)
        return None
    cols: list[str] = []
    for r in rows or []:
        cn = (r.get("col_name") or "").strip()
        # DESCRIBE trails partition-info after a blank / '#'-prefixed marker row.
        if not cn or cn.startswith("#"):
            break
        cols.append(cn)
    return cols or None


def _unified_view_exists(catalog: str, schema: str, view_name: str) -> bool | None:
    """Return physical view existence, or None when it cannot be verified safely."""
    from server.db import execute_query

    try:
        rows = execute_query(
            "SELECT 1 AS present FROM system.information_schema.views "
            "WHERE table_catalog = :catalog AND table_schema = :schema "
            "AND table_name = :view_name LIMIT 1",
            {"catalog": catalog, "schema": schema, "view_name": view_name},
            no_cache=True,
        )
        return bool(rows)
    except Exception as e:
        logger.warning(
            "Could not verify unified view %s.%s.%s: %s",
            catalog,
            schema,
            view_name,
            e,
        )
        return None


def _alter_view_is_unsupported(exc: Exception) -> bool:
    """Whether an ALTER VIEW failure indicates syntax/feature incompatibility."""
    message = str(exc).lower()
    return any(
        marker in message
        for marker in (
            "parse_syntax_error",
            "syntax error",
            "unsupported_feature",
            "not supported",
        )
    )


def _replace_unified_view(
    catalog: str,
    schema: str,
    table_name: str,
    body: str,
    *,
    existed: bool,
    view_suffix: str | None = None,
) -> str:
    """Create or alter one unified view without CREATE OR REPLACE races."""
    from server.db import MV_UNIFIED_SUFFIX, execute_query

    view_name = f"{table_name}{view_suffix or MV_UNIFIED_SUFFIX}"
    target = f"`{catalog}`.`{schema}`.`{view_name}`"
    normalized_target = f"{catalog}.{schema}.{view_name}".lower()
    if normalized_target in body.replace("`", "").lower():
        raise ValueError(f"Unified view body must not reference its target: {target}")

    if not existed:
        execute_query(f"CREATE VIEW {target} AS\n{body}", no_cache=True)
        return "created"

    try:
        # Databricks SQL supports replacing a view query with ALTER VIEW ... AS.
        # Unlike CREATE OR REPLACE, this does not delete/recreate the object.
        execute_query(f"ALTER VIEW {target} AS\n{body}", no_cache=True)
        return "altered"
    except Exception as e:
        if not _alter_view_is_unsupported(e):
            raise
        # Compatibility fallback for runtimes that do not support ALTER VIEW AS.
        # The caller holds the cross-process DDL lock throughout both statements.
        logger.warning("ALTER VIEW AS unsupported for %s; using locked DROP/CREATE", target)
        execute_query(f"DROP VIEW IF EXISTS {target}", no_cache=True)
        execute_query(f"CREATE VIEW {target} AS\n{body}", no_cache=True)
        return "recreated"


_MV_DEDUPE_KEYS: dict[str, tuple[str, ...]] = {
    "daily_usage_summary": ("usage_date", "workspace_id"),
    "daily_product_breakdown": ("usage_date", "workspace_id", "product_category"),
    "daily_workspace_breakdown": ("usage_date", "workspace_id"),
    "sql_tool_attribution": ("sql_product", "usage_date", "workspace_id", "warehouse_id"),
    "daily_query_stats": ("usage_date", "workspace_id"),
    "dbsql_cost_per_query": ("statement_id",),
    "daily_tag_summary": ("usage_date", "workspace_id", "tag_key", "tag_value"),
    "daily_tag_coverage_summary": ("usage_date", "workspace_id"),
    "daily_apps_summary": ("usage_date", "workspace_id", "app_id", "sku_name"),
}


def rebuild_unified_views(catalog: str | None = None, schema: str | None = None) -> dict:
    """(Re)create per-table `<name>__unified` views: local MV UNION ALL each source.

    Every row is tagged with a `source_label` column (local rows use the
    workspace's own label). A source table is included only when it is readable
    AND its column list matches the local MV exactly — so the `SELECT *` union can
    never fail on a mismatched share, and the app's reads stay healthy. When no
    sources are configured, unified views are dropped so reads fall back to base
    tables. Returns a per-table build summary (used by the Settings UI).
    """
    with unified_views_rebuild_lock():
        return _rebuild_unified_views_locked(catalog, schema)


def _rebuild_unified_views_locked(
    catalog: str | None = None,
    schema: str | None = None,
    *,
    sources_override: list[dict] | None = None,
    persist_registry: bool = True,
) -> dict:
    """Implementation of ``rebuild_unified_views`` with the DDL lock held."""
    from server.db import (
        MV_SOURCE_ROWS_SUFFIX,
        MV_UNIFIED_SUFFIX,
        get_catalog_schema,
        get_local_source_label,
        get_mv_sources,
        get_unified_view_tables,
        save_unified_view_tables,
    )

    if catalog is None or schema is None:
        c, s = get_catalog_schema()
        catalog = catalog or c
        schema = schema or s
    if not catalog or not schema:
        return {"ok": False, "error": "no catalog/schema configured"}

    sources = (
        [dict(source) for source in sources_override]
        if sources_override is not None
        else get_mv_sources()
    )
    if not sources:
        _drop_unified_views_locked(
            catalog, schema, persist_registry=persist_registry
        )
        return {"ok": True, "sources": 0, "views": {}}

    local_label = get_local_source_label().replace("'", "''")
    summary: dict = {}
    # This includes physically-listed views when information_schema is healthy
    # and the durable registry as a fallback. Per-view probes below remove only
    # entries that are definitively absent.
    known_existing = set(get_unified_view_tables())
    for t in _MV_TABLES:
        view_name = f"{t}{MV_UNIFIED_SUFFIX}"
        existed = _unified_view_exists(catalog, schema, view_name)
        source_rows_name = f"{t}{MV_SOURCE_ROWS_SUFFIX}"
        source_rows_existed = _unified_view_exists(catalog, schema, source_rows_name)
        if existed is True and source_rows_existed is True:
            known_existing.add(t)
        elif existed is False or source_rows_existed is False:
            known_existing.discard(t)
        else:
            summary[t] = {"built": False, "reason": "view existence check failed"}
            continue

        local_full = f"`{catalog}`.`{schema}`.`{t}`"
        local_cols = _table_columns(local_full)
        if not local_cols:
            summary[t] = {"built": False, "reason": "local table missing"}
            continue
        selects = [
            f"SELECT *, '{local_label}' AS source_label FROM {local_full}"
        ]
        included, skipped = [get_local_source_label()], []
        for src in sources:
            # A source may restrict which views it contributes (chosen via the
            # multiselect at add time). No `tables` key => contribute every matching
            # view (legacy sources added before the picker existed).
            sel = src.get("tables")
            if sel is not None and t not in sel:
                continue
            full = f"`{src['catalog']}`.`{src['schema']}`.`{t}`"
            cols = _table_columns(full)
            if cols is None:
                skipped.append({"label": src["label"], "reason": "unreadable/absent"})
            elif cols != local_cols:
                skipped.append({"label": src["label"], "reason": "column mismatch"})
            else:
                slabel = src["label"].replace("'", "''")
                workspace_ids = [
                    str(value).strip()
                    for value in (src.get("workspace_ids") or [])
                    if str(value).strip()
                ]
                quoted_workspace_ids = ", ".join(
                    "'" + value.replace("'", "''") + "'" for value in workspace_ids
                )
                if "workspace_id" in cols and not workspace_ids:
                    skipped.append({
                        "label": src["label"],
                        "reason": "workspace mapping missing",
                    })
                    continue
                workspace_scope = (
                    " WHERE CAST(workspace_id AS STRING) IN "
                    f"({quoted_workspace_ids})"
                    if "workspace_id" in cols and workspace_ids
                    else ""
                )
                selects.append(
                    f"SELECT *, '{slabel}' AS source_label FROM {full}{workspace_scope}"
                )
                included.append(src["label"])
        source_rows_sql = "\nUNION ALL\n".join(selects)
        dedupe_keys = [
            column for column in _MV_DEDUPE_KEYS.get(t, ())
            if column in local_cols
        ] or local_cols
        partition_sql = ", ".join(f"`{column.replace('`', '``')}`" for column in dedupe_keys)
        deduped_sql = (
            f"SELECT * FROM `{catalog}`.`{schema}`.`{source_rows_name}`\n"
            "QUALIFY ROW_NUMBER() OVER (\n"
            f"  PARTITION BY {partition_sql}\n"
            f"  ORDER BY CASE WHEN source_label = '{local_label}' THEN 0 ELSE 1 END, "
            "source_label\n"
            ") = 1"
        )
        try:
            source_rows_action = _replace_unified_view(
                catalog,
                schema,
                t,
                source_rows_sql,
                existed=source_rows_existed,
                view_suffix=MV_SOURCE_ROWS_SUFFIX,
            )
            deduped_action = _replace_unified_view(
                catalog, schema, t, deduped_sql, existed=existed
            )
            known_existing.add(t)
            summary[t] = {
                "built": True,
                "action": deduped_action,
                "source_rows_action": source_rows_action,
                "included": included,
                "skipped": skipped,
                "dedupe_keys": dedupe_keys,
            }
        except Exception as e:
            summary[t] = {"built": False, "reason": str(e), "skipped": skipped}
            logger.warning("Failed to build unified view %s: %s", view_name, e)
            # ALTER failures leave the previous view intact. A DROP/CREATE
            # fallback can fail after DROP, so re-check before preserving it.
            still_exists = _unified_view_exists(catalog, schema, view_name)
            source_rows_still_exists = _unified_view_exists(
                catalog, schema, source_rows_name
            )
            if still_exists is True and source_rows_still_exists is True:
                known_existing.add(t)
            elif still_exists is False or source_rows_still_exists is False:
                known_existing.discard(t)

    # Preserve prior live entries on partial failures; remove only views that
    # were definitively observed absent. This prevents a transient failure for
    # one table from truncating routing for every other still-live view.
    routed_tables = [t for t in _MV_TABLES if t in known_existing]
    build_ok = all(
        isinstance(result, dict) and bool(result.get("built"))
        for result in summary.values()
    ) and len(summary) == len(_MV_TABLES)
    if persist_registry and build_ok:
        save_unified_view_tables(routed_tables)
    if build_ok:
        # A routed-view definition change must fence response payloads produced
        # against the prior view graph, including durable cache rows that survive
        # an app redeploy.
        from server.db import clear_query_cache, delta_cache_invalidate

        clear_query_cache()
        delta_cache_invalidate(remote_cleanup=False)
    logger.info("Unified MV views rebuilt (%d source(s) configured)", len(sources))
    return {
        "ok": build_ok,
        "sources": len(sources),
        "views": summary,
        "routed_tables": routed_tables,
    }


def drop_unified_views(catalog: str | None = None, schema: str | None = None) -> None:
    """Drop every `<name>__unified` view so reads fall back to base tables."""
    with unified_views_rebuild_lock():
        _drop_unified_views_locked(catalog, schema)


def _drop_unified_views_locked(
    catalog: str | None = None,
    schema: str | None = None,
    *,
    persist_registry: bool = True,
) -> None:
    """Drop unified views while the caller holds ``unified_views_rebuild_lock``."""
    from server.db import (
        MV_SOURCE_ROWS_SUFFIX,
        MV_UNIFIED_SUFFIX,
        execute_query,
        get_catalog_schema,
        save_unified_view_tables,
    )

    if catalog is None or schema is None:
        c, s = get_catalog_schema()
        catalog = catalog or c
        schema = schema or s
    if not catalog or not schema:
        return
    for t in _MV_TABLES:
        for suffix in (MV_UNIFIED_SUFFIX, MV_SOURCE_ROWS_SUFFIX):
            try:
                execute_query(
                    f"DROP VIEW IF EXISTS `{catalog}`.`{schema}`.`{t}{suffix}`",
                    no_cache=True,
                )
            except Exception as e:
                logger.debug(
                    "drop routed view %s%s failed (non-fatal): %s",
                    t,
                    suffix,
                    e,
                )
    # Update routing only after the DDL pass, so readers never drop all registry
    # entries before the physical views are actually removed.
    remaining = [
        t
        for t in _MV_TABLES
        if _unified_view_exists(catalog, schema, f"{t}{MV_UNIFIED_SUFFIX}") is True
    ]
    if persist_registry:
        save_unified_view_tables(remaining)


def check_materialized_views_exist(catalog: str | None = None, schema: str | None = None) -> dict:
    """Check which materialized view tables exist.

    Uses the Unity Catalog REST API (no SQL warehouse required) so this is
    fast even when the warehouse is cold/starting. Avoids the thread-exhaustion
    problem that occurred when 6 blocking SQL queries were spawned per poll.

    Returns:
        Dict mapping table name to exists (True/False)
    """
    if catalog is None or schema is None:
        cat, sch = get_catalog_schema()
        catalog = catalog or cat
        schema = schema or sch

    table_names = _MV_TABLES

    # Use the Unity Catalog REST API (no SQL warehouse needed — fast even when cold).
    # Try the user's OAuth token first so readiness can still inspect the tables if
    # the SP has access drift or the app was explicitly recreated with a new identity,
    # then fall back to the SP client. Never fall back to SQL — a
    # schema-not-found error from the UC API means the tables simply don't exist yet,
    # and SQL connections would hang for minutes against a warehouse the SP can't use.
    from server.db import get_user_workspace_client, get_workspace_client
    clients_to_try = []
    try:
        user_client = get_user_workspace_client()
        # Only add user client if it's actually using a user token (not the SP fallback)
        if user_client is not get_workspace_client():
            clients_to_try.append(("user", user_client))
    except Exception:
        pass
    clients_to_try.append(("sp", get_workspace_client()))

    for label, w in clients_to_try:
        try:
            existing: set[str] = set()
            for t in w.tables.list(catalog_name=catalog, schema_name=schema):
                if t.name:
                    existing.add(t.name.lower())
            return {name: name.lower() in existing for name in table_names}
        except Exception as e:
            logger.debug(f"UC tables.list failed ({label} token): {e}")

    # Both clients failed — schema/catalog likely doesn't exist yet on this fresh deploy.
    return {name: False for name in table_names}


# Optimized queries that use materialized views
MV_BILLING_SUMMARY = """
SELECT
  SUM(total_dbus) as total_dbus,
  SUM(total_spend) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count,
  COUNT(DISTINCT usage_date) as days_in_range,
  MIN(usage_date) as first_date,
  MAX(usage_date) as last_date
FROM `{catalog}`.`{schema}`.`daily_usage_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
"""

MV_BILLING_TOTAL_TIMESERIES = """
SELECT
  usage_date,
  'Total' AS product_category,
  SUM(total_dbus) AS total_dbus,
  SUM(total_spend) AS total_spend
FROM `{catalog}`.`{schema}`.`daily_usage_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY usage_date
ORDER BY usage_date
"""

MV_BILLING_BY_WORKSPACE_BASIC = """
SELECT
  workspace_id,
  CAST(NULL AS STRING) AS workspace_name,
  SUM(total_dbus) AS total_dbus,
  SUM(total_spend) AS total_spend
FROM `{catalog}`.`{schema}`.`daily_usage_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY workspace_id
ORDER BY total_spend DESC
"""

MV_BILLING_BY_PRODUCT = """
SELECT
  product_category,
  SUM(total_dbus) as total_dbus,
  SUM(total_spend) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count
FROM `{catalog}`.`{schema}`.`daily_product_breakdown`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY product_category
ORDER BY total_spend DESC
"""

MV_BILLING_TIMESERIES = """
SELECT
  usage_date,
  product_category,
  SUM(total_dbus) as total_dbus,
  SUM(total_spend) as total_spend
FROM `{catalog}`.`{schema}`.`daily_product_breakdown`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY usage_date, product_category
ORDER BY usage_date, product_category
"""

MV_BILLING_BY_WORKSPACE = """
SELECT
  workspace_id,
  MAX(workspace_name) as workspace_name,
  SUM(total_dbus) as total_dbus,
  SUM(total_spend) as total_spend
FROM `{catalog}`.`{schema}`.`daily_workspace_breakdown`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY workspace_id
ORDER BY total_spend DESC
"""

MV_SQL_TOOL_ATTRIBUTION = """
SELECT
  sql_product,
  SUM(attributed_dbus) as total_dbus,
  SUM(attributed_spend) as total_spend
FROM `{catalog}`.`{schema}`.`sql_tool_attribution`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY sql_product
ORDER BY total_spend DESC
"""

MV_ETL_BREAKDOWN = """
SELECT
  CASE
    WHEN product_category = 'ETL - Streaming' THEN 'Streaming (SDP)'
    WHEN product_category = 'ETL - Batch' THEN 'Batch Jobs'
  END as etl_type,
  SUM(total_dbus) as total_dbus,
  SUM(total_spend) as total_spend
FROM `{catalog}`.`{schema}`.`daily_product_breakdown`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
  AND product_category IN ('ETL - Streaming', 'ETL - Batch')
GROUP BY product_category
ORDER BY total_spend DESC
"""

MV_PLATFORM_KPIS = """
SELECT
  SUM(total_queries) as total_queries,
  MAX(unique_query_users) as unique_query_users,
  SUM(total_rows_read) as total_rows_read,
  SUM(total_bytes_read) as total_bytes_read,
  SUM(total_compute_seconds) as total_compute_seconds
FROM `{catalog}`.`{schema}`.`daily_query_stats`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
"""

# Fast path for TAG_STATS. Reads pre-exploded (tag_key, tag_value, daily spend) rows
# from daily_tag_summary instead of scanning system.billing.usage + LATERAL VIEW EXPLODE
# on every request (which was hitting the 90s bundle deadline on large accounts).
MV_TAG_STATS = """
WITH per_day AS (
  SELECT
    usage_date,
    SUM(total_spend) AS daily_spend,
    COUNT(DISTINCT CONCAT(tag_key, ':', tag_value)) AS daily_tag_count
  FROM `{catalog}`.`{schema}`.`daily_tag_summary`
  WHERE usage_date BETWEEN :start_date AND :end_date
    {ws_filter}
  GROUP BY usage_date
)
SELECT
  (SELECT COUNT(DISTINCT CONCAT(tag_key, ':', tag_value))
     FROM `{catalog}`.`{schema}`.`daily_tag_summary`
     WHERE usage_date BETWEEN :start_date AND :end_date
       {ws_filter}
  ) AS total_tag_count,
  AVG(CASE WHEN daily_tag_count > 0 THEN daily_spend / daily_tag_count ELSE NULL END) AS avg_cost_per_tag
FROM per_day
"""


MV_COST_BY_TAG = """
SELECT
  tag_key,
  tag_value,
  SUM(total_dbus) AS total_dbus,
  SUM(total_spend) AS total_spend,
  COUNT(DISTINCT workspace_id) AS workspace_count,
  COUNT(DISTINCT usage_date) AS days_active
FROM `{catalog}`.`{schema}`.`daily_tag_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY tag_key, tag_value
ORDER BY total_spend DESC
LIMIT 1000
"""


MV_TAG_COVERAGE_TIMESERIES = """
SELECT
  usage_date,
  SUM(tagged_spend) AS tagged_spend,
  SUM(untagged_spend) AS untagged_spend
FROM `{catalog}`.`{schema}`.`daily_tag_coverage_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
GROUP BY usage_date
ORDER BY usage_date
"""


# Exact non-exploded MV fast path for the tagging bundle's summary card.
MV_TAGGING_SUMMARY = """
SELECT
  SUM(tagged_spend) AS tagged_spend,
  SUM(untagged_spend) AS untagged_spend,
  SUM(total_spend) AS total_spend,
  COUNT(DISTINCT CASE WHEN tagged_spend > 0 THEN workspace_id END) AS tagged_workspaces,
  COUNT(DISTINCT CASE WHEN untagged_spend > 0 THEN workspace_id END) AS untagged_workspaces
FROM `{catalog}`.`{schema}`.`daily_tag_coverage_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
"""


# ── Apps bundle fast paths (read from daily_apps_summary) ─────────────────
# These replace the raw system.billing.usage scans in server/routers/apps.py
# for the summary / apps / timeseries / sku_breakdown slots. Same output
# shape as the raw versions so downstream Python code is unchanged.

MV_APPS_SUMMARY = """
WITH apps_by_day AS (
  SELECT usage_date, workspace_id, app_id,
    SUM(total_dbus) AS daily_dbus,
    SUM(total_spend) AS daily_spend
  FROM `{catalog}`.`{schema}`.`daily_apps_summary`
  WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
  GROUP BY usage_date, workspace_id, app_id
),
apps_totals AS (
  SELECT
    SUM(daily_dbus) AS total_dbus,
    SUM(daily_spend) AS total_spend,
    COUNT(DISTINCT workspace_id) AS workspace_count,
    COUNT(DISTINCT app_id) AS app_count,
    COUNT(DISTINCT usage_date) AS days_in_range,
    MIN(usage_date) AS first_date,
    MAX(usage_date) AS last_date
  FROM apps_by_day
),
apps_avg AS (
  SELECT COALESCE(AVG(daily_apps), 0) AS avg_daily_apps
  FROM (
    SELECT usage_date, COUNT(DISTINCT app_id) AS daily_apps
    FROM apps_by_day
    GROUP BY usage_date
  ) t
)
SELECT t.*, a.avg_daily_apps
FROM apps_totals t, apps_avg a
"""

MV_APPS_BY_APP_FULL = """
SELECT
  app_id,
  SUM(total_dbus) AS total_dbus,
  SUM(total_spend) AS total_spend,
  COUNT(DISTINCT workspace_id) AS workspace_count,
  COUNT(DISTINCT usage_date) AS days_active,
  MAX(usage_date) AS last_usage_date
FROM `{catalog}`.`{schema}`.`daily_apps_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
{ws_filter}
GROUP BY app_id
ORDER BY total_spend DESC
"""

MV_APPS_BY_APP_SKU = """
SELECT
  app_id,
  sku_name,
  SUM(total_dbus) AS total_dbus,
  SUM(total_spend) AS total_spend
FROM `{catalog}`.`{schema}`.`daily_apps_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
{ws_filter}
GROUP BY app_id, sku_name
ORDER BY app_id, total_spend DESC
"""

MV_APPS_TIMESERIES = """
SELECT
  usage_date,
  SUM(total_dbus) AS total_dbus,
  SUM(total_spend) AS total_spend
FROM `{catalog}`.`{schema}`.`daily_apps_summary`
WHERE usage_date BETWEEN :start_date AND :end_date
{ws_filter}
{app_filter}
GROUP BY usage_date
ORDER BY usage_date
"""

MV_APPS_FILTERED_AVG = """
SELECT COALESCE(AVG(daily_apps), 0) AS avg_daily_apps
FROM (
  SELECT usage_date, COUNT(DISTINCT app_id) AS daily_apps
  FROM `{catalog}`.`{schema}`.`daily_apps_summary`
  WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
  {app_filter}
  GROUP BY usage_date
) t
"""

MV_APPS_AVG_COST_PER_APP = """
SELECT COALESCE(AVG(daily_cost_per_app), 0) AS avg_cost_per_app
FROM (
  SELECT usage_date,
    SUM(total_spend) / NULLIF(COUNT(DISTINCT app_id), 0) AS daily_cost_per_app
  FROM `{catalog}`.`{schema}`.`daily_apps_summary`
  WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
  {app_filter}
  GROUP BY usage_date
) t
"""


# Materialize the shared temporal fragment after every SQL template is defined.
for _query_name, _query_value in tuple(globals().items()):
    if isinstance(_query_value, str) and "/* TEMPORAL_LIST_PRICE_JOIN */" in _query_value:
        globals()[_query_name] = apply_temporal_list_price_join(_query_value)


# Canonical publisher/refresh contracts must be captured only after the temporal
# price-join marker above has been materialized in every SQL template.
CREATE_MV_TABLES: dict[str, str] = {
    "daily_usage_summary": CREATE_DAILY_USAGE_SUMMARY,
    "daily_product_breakdown": CREATE_DAILY_PRODUCT_BREAKDOWN,
    "daily_workspace_breakdown": CREATE_DAILY_WORKSPACE_BREAKDOWN,
    "sql_tool_attribution": CREATE_SQL_TOOL_ATTRIBUTION,
    "daily_query_stats": CREATE_QUERY_STATS,
    "dbsql_cost_per_query": CREATE_DBSQL_COST_PER_QUERY,
    "daily_tag_summary": CREATE_DAILY_TAG_SUMMARY,
    "daily_tag_coverage_summary": CREATE_DAILY_TAG_COVERAGE_SUMMARY,
    "daily_apps_summary": CREATE_DAILY_APPS_SUMMARY,
}

MERGE_MV_TABLES: dict[str, str] = {
    "daily_usage_summary": MERGE_DAILY_USAGE_SUMMARY,
    "daily_product_breakdown": MERGE_DAILY_PRODUCT_BREAKDOWN,
    "daily_workspace_breakdown": MERGE_DAILY_WORKSPACE_BREAKDOWN,
    "sql_tool_attribution": MERGE_SQL_TOOL_ATTRIBUTION,
    "daily_query_stats": MERGE_QUERY_STATS,
    "dbsql_cost_per_query": MERGE_DBSQL_COST_PER_QUERY,
    "daily_tag_summary": MERGE_DAILY_TAG_SUMMARY,
    "daily_tag_coverage_summary": MERGE_DAILY_TAG_COVERAGE_SUMMARY,
    "daily_apps_summary": MERGE_DAILY_APPS_SUMMARY,
}
