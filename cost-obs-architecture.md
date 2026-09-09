# cost-obs — Architecture (v1.2)

> A Databricks App that turns governed platform usage and operational metadata into interactive cost analysis. The browser calls a FastAPI service, which executes governed SQL through a bound Databricks SQL Warehouse and serves results from **system tables** or **app-managed Delta aggregates**.
>
> Static design content only — no customer, account, workspace, or user identifiers. · August 2026

## Architecture at a glance

```
Browser / React 19          FastAPI application          Databricks SQL Warehouse
  nine cost views    REST     authenticated routes   SQL    bound app resource
  filters & reports ──────▶   validation & shaping ──────▶  governed SQL execution
  React Query cache  same-    bundle cache · roles          parallel bundle queries
                     origin   scheduler                     enforces CAN USE
                                                                │ read / write
                                              ┌─────────────────┴──────────────────┐
                                              │ App-managed Delta layer            │
                                              │  8 aggregates · response cache     │
                                              │  settings + refresh state          │
                                              ├────────────────────────────────────┤
                                              │ Governed sources (reads only)      │
                                              │  Databricks system tables          │
                                              │  optional cloud billing exports    │
                                              │  optional shared aggregates        │
                                              └────────────────────────────────────┘
```

- **Authentication + governance:** Databricks Apps session → FastAPI role checks → app service principal for every SQL operation → Warehouse `CAN USE` + Unity Catalog grants.
- **Scheduled refresh:** scheduler → service principal → incremental Delta `MERGE`s → refresh state & history → cache invalidation.
- **On-demand refresh:** tab refresh → scoped cache clear → active refetch; administrator rebuild → full aggregate recreation.

## Components

| Component | Role |
|---|---|
| React browser interface | Interactive cost views, filters, settings, customer-facing report downloads |
| FastAPI application | Authenticated API layer: assigns request IDs, validates requests, coordinates queries, shapes dashboard responses |
| Databricks SQL Warehouse | Governed SQL execution plane for system-table reads, aggregates, app-managed tables |
| Databricks system tables | Account-level billing, query, compute, Lakeflow, serving, audit, workspace metadata |
| App-managed Delta layer | Pre-aggregated cost tables, durable settings + refresh state, shared response cache |
| Optional cloud billing exports | AWS / Azure / GCP exports supplement Databricks charges with cloud actuals |

## Request & data flow

1. A signed-in user opens the React interface in Databricks Apps and selects dates, workspaces, or report options.
2. The browser sends same-origin requests to tab-specific FastAPI routes. Middleware assigns `X-Request-ID`, carries it through log records, and records status/duration or redacted failure details.
3. FastAPI serves a valid cached bundle when possible; otherwise it submits governed SQL through the bound SQL Warehouse.
4. Queries use app-managed Delta aggregates for supported summaries and live system-table queries for detailed, specialized, or fallback views.
5. Configured AWS / Azure / GCP billing exports are queried only for the optional actual-cloud-cost views.
6. FastAPI returns shaped JSON and React renders the dashboard. Architecture export downloads the canonical same-origin `cost-obs-arch-1.2.pdf` asset without regenerating or mutating it.

## Authentication & governance

- Databricks Apps authenticates the browser session and forwards user identity to the application.
- FastAPI uses the forwarded identity only for app roles; settings mutations and rebuild actions require the app administrator role.
- The app service principal performs every SQL operation, including dashboard reads, setup and managed-table creation, scheduled refreshes, and cache writes. No forwarded user OAuth credential is used for SQL.
- Unity Catalog privileges govern system-table and managed-table access (verified by the setup flow); the bound SQL Warehouse separately enforces `CAN USE` and executes all table reads and writes.

## Refresh paths

**Scheduled aggregate refresh** — nightly by default (weekly/monthly selectable): scheduler acquires the shared refresh lock → the service principal incrementally `MERGE`s recent source partitions into the eight Delta aggregates → watermarks & history persist, unified source views rebuild, response caches invalidate.

**Administrator full rebuild** — Settings → Data & tables → Rebuild: admin check → locked background rebuild queued → every aggregate recreated from the configured history window → progress written to refresh state/history; all query & response caches cleared on completion.

**On-demand tab refresh** — React posts the tab name to `/api/cache/clear` → FastAPI invalidates only that tab's in-process and shared Delta response-cache entries → React Query refetches the active tab routes. Aggregate tables are not rebuilt.

There is no generic prewarm endpoint or periodic warehouse keepalive. The only synthetic SQL recovery is the bounded, administrator-only warehouse probe used by the initial cold gate; normal health polling is REST-only.

## Deployment and release flow

Databricks Apps installs Python dependencies, starts FastAPI, and serves the committed `static/` artifact. It does not build the frontend at deployment time. The SQL warehouse is a bound app resource (`sql-warehouse`), and the setup wizard collects and validates the app-managed catalog/schema.

The internal repository is the source of truth. A release lands on internal `origin/main` with the static artifact, then `sync-mirror.sh` derives and validates the customer-safe public tree before a normal public push.

## Tab-by-tab data lineage

| Tab | FastAPI routes (`GET /api/…`) | Managed Delta / cache | Source system tables | Fallback & optional enrichment |
|---|---|---|---|---|
| DBU Overview | `billing/dashboard-bundle-fast` · `billing/sku-breakdown` · `billing/interactive-breakdown` · `billing/pipeline-objects` · `billing/kpi-trend` | `daily_usage_summary` · `daily_product_breakdown` · `app_response_cache` | `billing.usage` · `billing.list_prices` · `access.workspaces_latest` · `compute.clusters` | Live billing scan when aggregates absent/empty; SKU, interactive, and jobs/pipelines detail always live. Opt: `lakeflow.pipelines` names; `billing.account_prices` multiplier |
| SQL | `billing/sql-breakdown` · `dbsql/dashboard-bundle` · `dbsql/top-queries` · `dbsql/top-queries-by-source` · `dbsql/queries-by-user` · `billing/platform-kpi-trend` | `sql_tool_attribution` · `dbsql_cost_per_query` · `app_response_cache` | `billing.usage` · `billing.list_prices` · `query.history` · `compute.warehouses` · `access.workspaces_latest` | DBSQL-vs-Genie falls back to live billing + query history; per-query views report unavailable until `dbsql_cost_per_query` exists — no invented attribution |
| AI/ML | `aiml/dashboard-bundle` · `billing/kpi-trend` | `app_response_cache` (analytics live) | `billing.usage` · `billing.list_prices` | Billing-only views survive missing metadata; ML-runtime clusters need compute metadata. Opt: `compute.clusters`, `serving.served_entities`, `access.workspaces_latest` |
| Apps | `apps/dashboard-bundle` · `apps/kpi-trend` | `daily_apps_summary` · `app_response_cache` | `billing.usage` · `billing.list_prices` · `access.workspaces_latest` | Every summary query has a live billing fallback; Databricks Apps API enriches names/resources, stale cached metadata tolerated |
| Tagging | `tagging/dashboard-bundle` · `tagging/top-objects-by-tag` · `billing/kpi-trend` | `daily_tag_summary` · `daily_tag_coverage_summary` · `app_response_cache` | `billing.usage` · `billing.list_prices` | Exact coverage uses non-exploded daily aggregates; tag pairs use the exploded aggregate. Untagged resource rows remain live. Opt: compute/Lakeflow names |
| Users | `users-groups/bundle` | `app_response_cache` (analytics live) | `billing.usage` · `billing.list_prices` | Opt: workspace SCIM Users/Groups APIs enrich billing identities with group membership |
| KPIs & Trends | `billing/kpis-bundle` · `billing/platform-kpi-trend` | `daily_usage_summary` · `daily_query_stats` · `daily_workspace_breakdown` · `dbsql_cost_per_query` · `app_response_cache` | `billing.usage` · `billing.list_prices` · `query.history` · `lakeflow.job_run_timeline` | Billing KPIs survive missing Lakeflow access; query-history trends stay live |
| Cloud Costs | `billing/infra-bundle` · `aws-actual/dashboard-bundle` · `azure-actual/dashboard-bundle` · `gcp-actual/dashboard-bundle` · `billing/kpi-trend` | `app_response_cache` (cluster and DBU analytics live) | `billing.usage` · `compute.clusters` · `access.workspaces_latest` | Cluster and DBU analytics work without exports; currency costs require a configured cloud billing export. DBUs are not treated as VM node-hours. Opt: AWS/Azure `actuals_gold`, GCP BigQuery-federated or curated Delta |
| Optimize | `sql/warehouse-health` · `sql/warehouse-health/idle-time` | none — 30-minute in-process cache | `compute.warehouses` · `compute.warehouse_events` · `query.history` · `billing.usage` · `billing.list_prices` | Idle-time falls back from warehouse events to billing intervals (lower attribution confidence); rightsizing unavailable when regional system tables unreadable |

## Source-table inventory

**Core analytic system tables:** `system.billing.usage`, `system.billing.list_prices`, `system.query.history`, `system.compute.clusters`, `system.compute.warehouses`, `system.compute.warehouse_events`, `system.lakeflow.jobs`, `system.lakeflow.pipelines`, `system.lakeflow.job_run_timeline`, `system.serving.served_entities`, `system.access.workspaces_latest`

**Optional:** `system.billing.account_prices` — used when account pricing is enabled and the table is available.
**Permission probe only:** `system.access.audit` — checked to report optional audit-table readiness; never an analytic input.

**App-managed aggregates (9), in the configured Unity Catalog location:** `daily_usage_summary`, `daily_product_breakdown`, `daily_workspace_breakdown`, `daily_query_stats`, `daily_tag_summary`, `daily_tag_coverage_summary`, `daily_apps_summary`, `sql_tool_attribution`, `dbsql_cost_per_query`

**Durable app state & cache (8):** `app_settings` (namespaced general, alert, webhook, pricing, schedule, and workspace-filter settings), `app_refresh_log`, `app_cloud_connections`, `app_user_permissions`, `app_mv_refresh_state`, `app_response_cache`, `app_mv_sources`, `app_unified_views`

**Optional cloud billing sources (administrator-configured):** AWS `<catalog>.<schema>.actuals_gold` · Azure `<catalog>.<schema>.actuals_gold` · GCP `<catalog>.<schema>.<table>` (federated BigQuery billing export or curated Delta)
