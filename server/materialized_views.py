"""Materialized views for cost observability dashboard.

This module creates and manages pre-aggregated Delta tables that dramatically
improve query performance by avoiding expensive joins on system.query.history.

Tables created:
- cost_obs.daily_usage_summary: Daily aggregated usage and spend
- cost_obs.daily_product_breakdown: Daily spend by product category
- cost_obs.daily_workspace_breakdown: Daily spend by workspace
- cost_obs.sql_tool_attribution: Pre-computed Genie vs DBSQL split

These tables should be refreshed daily via a scheduled job.
"""

import logging
from collections.abc import Callable
from datetime import date, timedelta

from server.db import execute_query, get_catalog_schema, get_connection

logger = logging.getLogger(__name__)


# SQL to create the schema
CREATE_SCHEMA_SQL = """
CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}
COMMENT 'Pre-aggregated cost observability tables for fast dashboard queries'
"""

# Daily usage summary table - replaces BILLING_SUMMARY
CREATE_DAILY_USAGE_SUMMARY = """
CREATE OR REPLACE TABLE {catalog}.{schema}.daily_usage_summary CLUSTER BY (usage_date, workspace_id) AS
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {billing_lookback_days})
    AND u.usage_quantity > 0
)
SELECT
  usage_date,
  workspace_id,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  SUM(usage_quantity * effective_price_per_dbu) as effective_list_spend
FROM usage_with_price
GROUP BY usage_date, workspace_id
ORDER BY usage_date, workspace_id
"""

# Daily product breakdown table - replaces BILLING_BY_PRODUCT_FAST
CREATE_DAILY_PRODUCT_BREAKDOWN = """
CREATE OR REPLACE TABLE {catalog}.{schema}.daily_product_breakdown CLUSTER BY (usage_date, workspace_id) AS
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
      WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'Vector Search'
      WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
      WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
           OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      ELSE 'Other'
    END as product_category
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
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
CREATE OR REPLACE TABLE {catalog}.{schema}.daily_workspace_breakdown CLUSTER BY (usage_date, workspace_id) AS
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.usage_quantity,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
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
CREATE OR REPLACE TABLE {catalog}.{schema}.sql_tool_attribution CLUSTER BY (usage_date, workspace_id) AS
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
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
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
CREATE OR REPLACE TABLE {catalog}.{schema}.daily_query_stats CLUSTER BY (usage_date, workspace_id) AS
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
CREATE OR REPLACE TABLE {catalog}.{schema}.dbsql_cost_per_query CLUSTER BY (query_date, workspace_id) AS
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
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
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
CREATE OR REPLACE TABLE {catalog}.{schema}.dbsql_cost_per_query_prpr AS
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

prices AS (
  SELECT
    coalesce(price_end_time, date_add(current_date, 1)) as coalesced_price_end_time,
    *
  FROM system.billing.list_prices
  WHERE currency_code = 'USD'
),

filtered_warehouse_usage AS (
  SELECT
    u.warehouse_id warehouse_id,
    date_trunc('HOUR',u.usage_start_time) AS usage_start_hour,
    date_trunc('HOUR',u.usage_end_time) AS usage_end_hour,
    u.usage_quantity AS dbus,
    (CAST(p.pricing.default AS FLOAT) * dbus) AS usage_dollars
  FROM cpq_warehouse_usage AS u
  LEFT JOIN prices as p
    ON u.sku_name=p.sku_name
    AND u.usage_unit=p.usage_unit
    AND (u.usage_end_time between p.price_start_time and p.coalesced_price_end_time)
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
}

_OPTIMIZE_EVERY_N_REFRESHES = 12

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
      COALESCE(p.pricing.default, 0) as price_per_dbu,
      COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) as effective_price_per_dbu
    FROM system.billing.usage u
    LEFT JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
      AND u.cloud = p.cloud
      AND p.price_end_time IS NULL
    WHERE u.usage_date >= DATE('{reprocess_start}')
      AND u.usage_date <= CURRENT_DATE()
      AND u.usage_quantity > 0
  )
  SELECT
    usage_date,
    workspace_id,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend,
    SUM(usage_quantity * effective_price_per_dbu) as effective_list_spend
  FROM usage_with_price
  GROUP BY usage_date, workspace_id
) AS src
ON tgt.usage_date = src.usage_date AND tgt.workspace_id = src.workspace_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED BY TARGET THEN INSERT *
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
        WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'Vector Search'
        WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
        WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
             OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
        WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
        ELSE 'Other'
      END as product_category
    FROM system.billing.usage u
    LEFT JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
      AND u.cloud = p.cloud
      AND p.price_end_time IS NULL
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
    LEFT JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
      AND u.cloud = p.cloud
      AND p.price_end_time IS NULL
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
    LEFT JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
      AND u.cloud = p.cloud
      AND p.price_end_time IS NULL
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
    LEFT JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
      AND u.cloud = p.cloud
      AND p.price_end_time IS NULL
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
"""


# Step 5: Helper functions for incremental refresh

def _ensure_refresh_state_table(catalog: str, schema: str) -> None:
    """Create app_mv_refresh_state tracking table if it doesn't exist."""
    try:
        execute_query(CREATE_MV_REFRESH_STATE.format(catalog=catalog, schema=schema))
    except Exception as e:
        logger.warning("Could not create app_mv_refresh_state (non-fatal): %s", e)


def _get_refresh_state(catalog: str, schema: str, table_name: str) -> dict | None:
    """Return current refresh state for a table, or None if no state exists."""
    try:
        rows = execute_query(
            f"SELECT last_source_watermark, refresh_count "
            f"FROM `{catalog}`.`{schema}`.`app_mv_refresh_state` "
            f"WHERE table_name = '{table_name}' LIMIT 1"
        )
        if rows:
            return {
                "watermark": rows[0].get("last_source_watermark"),
                "refresh_count": int(rows[0].get("refresh_count") or 0),
            }
    except Exception:
        pass
    return None


def _update_refresh_state(catalog: str, schema: str, table_name: str, refresh_count: int) -> None:
    """Upsert refresh state after a successful table refresh."""
    try:
        cfg = _TABLE_REFRESH_CONFIG.get(table_name, {})
        reprocess_days = cfg.get("reprocess_days", 14)
        execute_query(
            f"""MERGE INTO `{catalog}`.`{schema}`.`app_mv_refresh_state` AS tgt
            USING (SELECT
                '{table_name}' AS table_name,
                CURRENT_TIMESTAMP() AS last_refresh_at,
                CURRENT_DATE() AS last_source_watermark,
                {reprocess_days} AS reprocess_window_days,
                {refresh_count} AS refresh_count
            ) AS src
            ON tgt.table_name = src.table_name
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED BY TARGET THEN INSERT *"""
        )
    except Exception as e:
        logger.warning("Could not update refresh state for %s (non-fatal): %s", table_name, e)


def create_materialized_views(catalog: str | None = None, schema: str | None = None, lookback_days: int = 180, on_table_event: "Callable[[str, str], None] | None" = None) -> dict:
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
    from server.db import validate_app_storage_target, StorageConfigurationError
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
            execute_query(f"CREATE CATALOG IF NOT EXISTS `{catalog}` COMMENT 'Cost Observability data'")
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
            execute_query(CREATE_SCHEMA_SQL.format(catalog=catalog, schema=schema))
            results["schema"] = "created"
    except Exception as e:
        err_str = str(e)
        err_lower = err_str.lower()
        if any(kw in err_lower for kw in ("insufficient_privileges", "does not have", "permission", "unauthorized", "error during request")):
            from server.db import get_workspace_client, _user_token
            # Identify who actually ran the query so the error message is accurate
            running_as_user = bool(_user_token.get())
            try:
                if running_as_user:
                    from server.db import get_user_workspace_client
                    identity = get_user_workspace_client().current_user.me().user_name or "your user account"
                    grant_note = f"As a metastore admin, run:"
                else:
                    identity = get_workspace_client().current_user.me().user_name or "<app-service-principal>"
                    grant_note = f"A catalog owner or metastore admin must run:"
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
    tables = [
        ("daily_usage_summary", CREATE_DAILY_USAGE_SUMMARY),
        ("daily_product_breakdown", CREATE_DAILY_PRODUCT_BREAKDOWN),
        ("daily_workspace_breakdown", CREATE_DAILY_WORKSPACE_BREAKDOWN),
        ("sql_tool_attribution", CREATE_SQL_TOOL_ATTRIBUTION),
        ("daily_query_stats", CREATE_QUERY_STATS),
        ("dbsql_cost_per_query", CREATE_DBSQL_COST_PER_QUERY),
    ]

    # Create all tables in parallel — none depend on each other
    from concurrent.futures import ThreadPoolExecutor, as_completed

    import time as _time

    def _create_table(table_name: str, create_sql: str) -> tuple[str, str, float]:
        from datetime import timedelta as _td
        t0 = _time.monotonic()
        if on_table_event:
            on_table_event(table_name, "running")
        try:
            logger.info(f"Refreshing table {catalog}.{schema}.{table_name}...")
            cfg = _TABLE_REFRESH_CONFIG.get(table_name, {})
            state = _get_refresh_state(catalog, schema, table_name)

            if state and state.get("watermark"):
                # Incremental path: MERGE reprocess window
                reprocess_days = cfg.get("reprocess_days", 14)
                overlap_days = cfg.get("overlap_days", 0)
                reprocess_start = date.today() - _td(days=reprocess_days + overlap_days)

                merge_sql_map = {
                    "daily_usage_summary": MERGE_DAILY_USAGE_SUMMARY,
                    "daily_product_breakdown": MERGE_DAILY_PRODUCT_BREAKDOWN,
                    "daily_workspace_breakdown": MERGE_DAILY_WORKSPACE_BREAKDOWN,
                    "sql_tool_attribution": MERGE_SQL_TOOL_ATTRIBUTION,
                    "daily_query_stats": MERGE_QUERY_STATS,
                    "dbsql_cost_per_query": MERGE_DBSQL_COST_PER_QUERY,
                }
                merge_sql = merge_sql_map.get(table_name)

                if merge_sql:
                    try:
                        execute_query(merge_sql.format(
                            catalog=catalog, schema=schema,
                            reprocess_start=str(reprocess_start),
                            billing_lookback_days=lookback_days,
                        ))
                        new_count = state["refresh_count"] + 1
                        _update_refresh_state(catalog, schema, table_name, new_count)

                        # Periodic OPTIMIZE
                        if new_count % _OPTIMIZE_EVERY_N_REFRESHES == 0:
                            try:
                                logger.info(f"Running OPTIMIZE on {table_name} (refresh #{new_count})")
                                execute_query(f"OPTIMIZE `{catalog}`.`{schema}`.`{table_name}`")
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
            execute_query(create_sql.format(catalog=catalog, schema=schema, billing_lookback_days=lookback_days))
            _update_refresh_state(catalog, schema, table_name, 1)
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
    with ThreadPoolExecutor(max_workers=len(tables)) as executor:
        futures = {executor.submit(_create_table, name, sql): name for name, sql in tables}
        for future in as_completed(futures):
            table_name, status, elapsed = future.result()
            results[table_name] = status
            mv_timings[table_name] = round(elapsed, 2)

    results["__mv_timings__"] = mv_timings  # type: ignore[assignment]

    return results


def refresh_materialized_views(catalog: str | None = None, schema: str | None = None, lookback_days: int = 180, on_table_event: "Callable[[str, str], None] | None" = None) -> dict:
    """Refresh all materialized view tables (same as create - full refresh)."""
    return create_materialized_views(catalog, schema, lookback_days=lookback_days, on_table_event=on_table_event)


def drop_materialized_views(catalog: str | None = None, schema: str | None = None) -> dict:
    """Drop all app-managed materialized view tables.

    Returns a dict mapping each table name to 'dropped' or an error string.
    """
    if catalog is None or schema is None:
        cat, sch = get_catalog_schema()
        catalog = catalog or cat
        schema = schema or sch

    results: dict[str, str] = {}
    for name in _MV_TABLES:
        try:
            execute_query(f"DROP TABLE IF EXISTS `{catalog}`.`{schema}`.`{name}`")
            results[name] = "dropped"
        except Exception as e:
            results[name] = f"error: {e}"
    return results


_MV_TABLES = [
    "daily_usage_summary",
    "daily_product_breakdown",
    "daily_workspace_breakdown",
    "sql_tool_attribution",
    "daily_query_stats",
    "dbsql_cost_per_query",
]


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

    table_names = [
        "daily_usage_summary",
        "daily_product_breakdown",
        "daily_workspace_breakdown",
        "sql_tool_attribution",
        "daily_query_stats",
        "dbsql_cost_per_query",
    ]

    # Use the Unity Catalog REST API (no SQL warehouse needed — fast even when cold).
    # Databricks Apps creates a new SP on every redeploy, so the SP may have no grants
    # on an existing deployment. Try the user's OAuth token first (always has access to
    # their own tables), then fall back to the SP client. Never fall back to SQL — a
    # schema-not-found error from the UC API means the tables simply don't exist yet,
    # and SQL connections would hang for minutes against a warehouse the SP can't use.
    from server.db import get_workspace_client, get_user_workspace_client
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
FROM {catalog}.{schema}.daily_usage_summary
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
"""

MV_BILLING_BY_PRODUCT = """
SELECT
  product_category,
  SUM(total_dbus) as total_dbus,
  SUM(total_spend) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count
FROM {catalog}.{schema}.daily_product_breakdown
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
FROM {catalog}.{schema}.daily_product_breakdown
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
FROM {catalog}.{schema}.daily_workspace_breakdown
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
FROM {catalog}.{schema}.sql_tool_attribution
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
FROM {catalog}.{schema}.daily_product_breakdown
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
FROM {catalog}.{schema}.daily_query_stats
WHERE usage_date BETWEEN :start_date AND :end_date
  {ws_filter}
"""
