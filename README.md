# Cost Observability & Control for Databricks

[![Deploy to Databricks](https://img.shields.io/badge/Deploy%20to-Databricks-FF3621?style=for-the-badge&logo=databricks&logoColor=white)](https://accounts.cloud.databricks.com/select-workspace?destination_url=/apps/install?repo_url=https://github.com/smathews13/cost-obs-databricks)

> **⚠️ Not Official Databricks Software**
> This application is built and maintained by the Databricks field engineering team and is **not an official Databricks product**. It is not covered by Databricks Support SLAs. Your Databricks account team can help you deploy, configure, and troubleshoot this app as part of your engagement.

> **🔧 Customization Notice**
> You are welcome to modify and customize this application's source code to fit your organization's requirements. However, be aware that local customizations may conflict with future upstream updates. We recommend tracking your changes in a fork and reviewing diffs carefully before pulling upstream updates.

---

A full-stack Databricks App for account-level compute cost visibility, chargeback, and anomaly detection across your entire Databricks platform.

Built on FastAPI + React, deployed as a [Databricks App](https://docs.databricks.com/en/dev-tools/databricks-apps/index.html) with OAuth authentication and serverless compute built in. Supports **multi-cloud deployment** across AWS and Azure with automatic cloud detection.

---

## Deployment

### Prerequisites

Before deploying, confirm the following are in place:

| Requirement | Why |
|---|---|
| **A running Serverless Pro SQL Warehouse** | **Required before deploying.** The app cannot create a warehouse on your behalf (the service principal lacks that permission by default). Create one in **SQL → SQL Warehouses → Create Warehouse** before running the setup wizard. |
| **Workspace Admin** (at minimum) | Required to grant the app's service principal `SELECT` on system tables |
| **Unity Catalog enabled** | All billing data is in `system.*` tables under UC — the app will not function without it |
| **System tables enabled** | Contact your Databricks account team if `system.billing.usage` is not accessible in your workspace |
| **Databricks Apps enabled** | Available on Premium plan and above |
| **Deploy from Git preview** *(recommended)* | Enables deploying directly from this GitHub repo. Enable in **Settings → Workspace Previews → "Deploy Databricks apps from Git repositories (Beta)"** |

> The setup wizard will show all available warehouses in a picker. In rare cases (typically Azure) where no warehouses appear, it will display the exact `GRANT USE ON WAREHOUSE` statement to run as a workspace admin.

### Deploy from Git

Deploy directly from this repository using Databricks Apps' built-in Git integration. No local clone or file sync required.

> **Enable the Deploy from Git preview first**
> If you don't see a **Git repository** option when creating an app, enable the beta feature:
> 1. Sign in as a workspace admin
> 2. Go to **Settings → Workspace Previews**
> 3. Find **"Deploy Databricks apps from Git repositories (Beta)"** and toggle it **ON**

#### Step 1 — Create the app

1. In your Databricks workspace, go to **Apps → Create App**
2. Choose **Git repository** as the source
3. Enter the repo URL: `https://github.com/smathews13/cost-obs-databricks`
4. Give the app a name and click **Create**

#### Step 2 — Add a SQL warehouse resource

Before deploying, add a warehouse resource in the app configuration:

1. In the app settings, go to **Configure → Resources → Add resource**
2. Choose **SQL warehouse** and set the permission to **CAN USE**
3. Select your Serverless Pro warehouse

This binds the warehouse to the app so no environment variables are needed for it.

#### Step 3 — Deploy

1. Click **Deploy**
2. Set the git reference: **Branch:** `main`, **Reference type:** `Branch`
3. Click **Deploy** — no environment variables required

Or click the **Deploy to Databricks** button at the top of this README.

### Environment Variables

**No environment variables are required to deploy.** The setup wizard configures the catalog and schema, and Databricks Apps injects OAuth credentials and the workspace host automatically. The wizard saves your catalog/schema to DBFS so it persists across future git redeploys — the wizard will not re-appear after a redeploy unless you explicitly trigger it.

<details>
<summary>Optional environment variable overrides</summary>

| Variable | Default | Description |
|---|---|---|
| `DATABRICKS_HOST` | Auto-detected | Override the workspace URL if not picked up automatically |
| `DATABRICKS_HTTP_PATH` | Auto-detected from resource binding | Point to an existing warehouse, or omit to use the bound resource |
| `COST_OBS_CATALOG` | Set by setup wizard | Override the Unity Catalog catalog for materialized views. Must be a dedicated, non-default catalog. When set, takes precedence over the wizard value. |
| `COST_OBS_SCHEMA` | Set by setup wizard | Override the schema name. When set, takes precedence over the wizard value. |
| `GENIE_SPACE_ID` | — | Genie Space ID for AI cost chat |
| `AZURE_SUBSCRIPTION_ID` | — | Azure subscription ID (shown in account banner on Azure) |
| `SMTP_HOST` / `SMTP_*` | — | Email alert configuration |
| `ENDPOINT_NAME` + `PGHOST` | — | Lakebase connection (falls back to Delta tables if not set) |
| `AWS_COST_CATALOG` / `AWS_COST_SCHEMA` | `billing` / `aws` | AWS CUR actual cost tables |
| `AZURE_COST_CATALOG` / `AZURE_COST_SCHEMA` | `billing` / `azure` | Azure cost export tables |
| `DATABRICKS_TOKEN` | — | Only needed for **local development** |

</details>

### First-Run Setup Wizard

On first deploy (or after a redeploy to a new workspace), the app launches a 6-step setup wizard. After completing the wizard once, the configuration persists across git redeploys — you'll go straight to the dashboard on subsequent deploys.

#### Step 1 — Environment

Confirms your workspace host, cloud provider (AWS/Azure/GCP), authenticated identity, and SQL warehouse selection.

**SQL Warehouse:** If you added a `sql-warehouse` resource in the app configuration (recommended), the warehouse is auto-detected and this step confirms it. Otherwise, a searchable warehouse picker is shown. If no warehouses are visible, the step displays the exact `GRANT` statement to run as a workspace admin.

#### Step 2 — Storage

Choose the Unity Catalog **catalog** and **schema** where the app will create its 6 pre-aggregated billing tables.

- Pick any non-default catalog (the wizard will create it if it doesn't exist)
- The schema is created inside that catalog
- The app's service principal is automatically granted the necessary privileges
- **You** (the installing user) are automatically granted `USE CATALOG`, `USE SCHEMA`, `SELECT`, and `MANAGE` on both the catalog and schema — so you can browse the tables in the UC browser and re-grant the service principal on future redeploys

#### Step 3 — Permissions

Checks access to the required system tables. The wizard automatically attempts to grant the service principal all necessary permissions.

If any permissions are still missing after the auto-grant, the wizard shows the exact SQL to run:

```sql
GRANT USE CATALOG ON CATALOG system TO `<service-principal>`;
GRANT USE SCHEMA ON SCHEMA system.billing TO `<service-principal>`;
GRANT SELECT ON TABLE system.billing.usage TO `<service-principal>`;
-- (plus any others shown as missing)
```

Click **Re-check** after running any manual grants.

#### Step 4 — Create Tables

Kicks off creation of 6 pre-aggregated Delta tables from your billing history. Progress is shown in real time. This typically takes 2–5 minutes depending on data volume and warehouse warmup.

#### Step 5 — Workspaces

Optionally filter the dashboard to a subset of workspaces. Useful for large multi-workspace accounts where you only need visibility into specific environments.

#### Step 6 — Complete

Click **Go to Dashboard**. The user who completes setup is automatically added as an app admin.

The wizard can be re-launched at any time from **Settings → Re-run Setup Wizard**.

---

## Databricks Preview Features

The following workspace previews unlock additional functionality. Enable any that are available in your workspace — the app gracefully falls back when a preview is not enabled. All are enabled per workspace by a workspace admin via **Settings → Workspace Previews**.

### Deploy from Git (Beta)

Enables deploying this app directly from GitHub — no file uploads or local tooling required. This is the recommended deployment path.

**To enable:**

1. Sign in as a workspace admin
2. Go to **Settings → Workspace Previews**
3. Find **"Deploy Databricks apps from Git repositories (Beta)"** and toggle it **ON**

Once enabled, go to **Apps → Create App** and choose **Git repository** as the source. Enter `https://github.com/smathews13/cost-obs-databricks` and deploy from the `main` branch.

### Account Tables (Private Preview)

Enables the **Account Prices** toggle in the DBU Overview tab. When toggled on, the app reads from `system.billing.account_prices` to show your negotiated/discounted prices instead of standard list prices.

This system table is a private preview. Contact your Databricks account team to request access. When available, the app automatically grants the required permissions on startup.

---

## What It Does

### DBU Overview
| Feature | Description |
|---|---|
| **Spend Over Time** | Daily spend timeseries by product category |
| **Spend by Product** | Horizontal bar chart with workspace filter — SQL, ETL, Interactive, Model Serving, Vector Search, Fine-Tuning, AI Functions, Serverless |
| **Spend by SKU** | Top 10 SKUs with workspace filter |
| **Spend by User** | Top spenders by DBU cost |
| **Workspace Table** | Per-workspace cost breakdown with top products/users |
| **Interactive Compute** | All-purpose cluster usage by user, cluster, or notebook with historical toggle |
| **ETL Breakdown** | Jobs and SDP pipeline spend with type filters, pagination, and historical toggle |
| **Account Prices Toggle** | Switch between list prices and negotiated account prices (from `system.billing.account_prices`, private preview) |

### KPIs & Trends
| Feature | Description |
|---|---|
| **Platform KPIs** | Total spend, DBUs, successful runs, active clusters, workspaces, models served |
| **KPI Drill-Downs** | Click any KPI to see daily/monthly trend lines in a modal |
| **Spend Anomalies** | Largest day-over-day spend changes with date search and AI analysis |

### SQL
| Feature | Description |
|---|---|
| **Query Spend by Source** | Daily cost timeseries by query source type (DBSQL, Genie, Dashboard, etc.) |
| **Warehouse Spend by Type** | Daily spend area chart segmented by Serverless/Pro/Classic |
| **Warehouses by Size** | Distribution of warehouses by size with workspace filter |
| **Top Users** | Highest-cost SQL users |
| **Query Source Breakdown** | Drill-down table by source type |
| **Most Expensive Queries** | Top queries with historical toggle, pagination, and query profile links |
| **Warehouse Rightsizing** | Automated recommendations to right-size overprovisioned warehouses based on `system.query.history` utilization heuristics |

### Cloud Costs
| Feature | Description |
|---|---|
| **Multi-Cloud Support** | Auto-detects AWS or Azure from workspace URL; displays cloud-specific logos, instance types, pricing links, and setup guides |
| **Infrastructure KPIs** | Total cloud cost, DBU hours, avg active clusters/day, avg cluster cost — all derived from billing data |
| **Cost Over Time** | Area chart of estimated infrastructure costs with instance family filter bubbles |
| **Instance Family Usage** | DBU hours by EC2 (AWS) or VM series (Azure) instance family |
| **Cluster Table** | Per-cluster cost attribution with instance types, pricing links, pagination, and historical toggle |
| **Actual Costs Integration** | Toggle between estimated and actual costs when AWS CUR 2.0 or Azure Cost Management Export is configured |
| **Cloud Integration Wizard** | In-app 5-step setup guide for both AWS and Azure actual cost integration |
| **2025 Pricing** | Updated EC2 and Azure VM pricing covering: AWS m7i, r7i, c7i, i4i, g6; Azure Dv6, Ev5/v6, NC A100 v4, ND A100 v4, NVadsA10 v5 |

### AI/ML
| Feature | Description |
|---|---|
| **AI/ML Spend Over Time** | Stacked area chart by AI/ML category |
| **Cost by Category** | Donut chart of spend distribution |
| **Top Serverless Endpoints** | Highest-cost inference endpoints |
| **ML Runtime Clusters** | Clusters running ML/GPU runtimes with hyperlinks, pagination, and historical toggle |
| **Agent Bricks** | Knowledge Assistants and other agent types with type filters, pagination, and historical toggle |

### Apps
| Feature | Description |
|---|---|
| **App Cost Dashboard** | Per-app spend with SKU breakdown drill-down |
| **Connected Artifacts** | Serving endpoints, SQL warehouses, and other resources used by apps |

### Tagging Hub
| Feature | Description |
|---|---|
| **Tag Coverage** | Tagged vs untagged spend ratio |
| **Spend by Tag** | Cost attribution by tag key/value pairs |
| **Spend by Key** | Horizontal bar chart of top tag keys |
| **Untagged Resources** | Clusters, jobs, pipelines, warehouses, and endpoints missing tags — with dynamic suggested tags per resource type, historical toggle, and pagination |

### Users
| Feature | Description |
|---|---|
| **Users by Spend** | Ranked list of users by total DBU cost across all products |
| **Spend Over Time per User** | Daily timeseries for any selected user |
| **Product Breakdown** | Cost split by product category per user |
| **User Growth Trend** | Active user count over time |

### Settings
| Feature | Description |
|---|---|
| **General** | Date range selection and display preferences |
| **Configuration** | Warehouse, catalog, schema, and Genie Space configuration; table status and rebuild |
| **Connections** | Shows the default Databricks workspace environment (cloud provider + host) |
| **Permissions** | System table access checks and service principal grant management |
| **User Permissions** | Admin-only management of who has admin vs. read-only access to the app |
| **Account Pricing** | Toggle between standard list prices and negotiated account prices |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Databricks App                        │
│                                                         │
│  ┌──────────────┐          ┌──────────────────────────┐ │
│  │  React + TS  │◄────────►│  FastAPI (4 workers)     │ │
│  │  Vite + TW   │  REST    │  18 routers              │ │
│  └──────────────┘          └──────────┬───────────────┘ │
│                                       │                 │
└───────────────────────────────────────┼─────────────────┘
                                        │ Databricks SDK
                      ┌─────────────────┼──────────────────┐
                      │                 ▼                  │
                      │   ┌──────────────────────────────┐ │
                      │   │  SQL Warehouse (Serverless)  │ │
                      │   └─────────────┬────────────────┘ │
                      │                 │                  │
                      │   ┌─────────────▼────────────────┐ │
                      │   │  system.billing.usage        │ │
                      │   │  system.billing.list_prices  │ │
                      │   │  system.billing.account_prices│ │
                      │   │  system.query.history        │ │
                      │   │  system.compute.*            │ │
                      │   │  system.lakeflow.*           │ │
                      │   │  system.serving.*            │ │
                      │   │  system.access.*             │ │
                      │   │  6 Materialized Views (MV)   │ │
                      │   └──────────────────────────────┘ │
                      │         Databricks                 │
                      └────────────────────────────────────┘
                                        │
                      ┌─────────────────▼──────────────────┐
                      │  Lakebase (optional, PostgreSQL 16) │
                      │  App state: alerts, permissions,    │
                      │  settings, user preferences         │
                      │  Falls back to Delta tables if not  │
                      │  configured                         │
                      └────────────────────────────────────┘
```

### Authentication

All dashboard queries run as the app's **service principal** (SP) using M2M OAuth. The SP is automatically granted access to the required system tables during the setup wizard's Permissions step.

The catalog and schema created during setup are owned by the SP. The installing user receives `USE CATALOG`, `USE SCHEMA`, `SELECT`, and `MANAGE` grants automatically — giving them full visibility in the Unity Catalog browser and the ability to re-grant the SP on future redeploys.

### Data Sources

All billing and compute data is **account-level** — queries run against Unity Catalog system tables which span all workspaces in the account.

| System Table | Usage |
|---|---|
| `system.billing.usage` | Core spend/DBU data for all products |
| `system.billing.list_prices` | Standard SKU pricing for cost calculation |
| `system.billing.account_prices` | Negotiated/discounted account-specific prices (private preview) |
| `system.query.history` | SQL query attribution, source tracking, and rightsizing signals |
| `system.compute.clusters` | Cluster metadata, names, owners, ML runtime detection |
| `system.compute.warehouses` | Warehouse names, types, sizes |
| `system.lakeflow.pipelines` | SDP pipeline name resolution |
| `system.lakeflow.jobs` | Job name resolution |
| `system.lakeflow.job_run_timeline` | Job success/failure tracking for KPIs |
| `system.serving.served_entities` | ML endpoint metadata |
| `system.access.workspaces_latest` | Workspace name resolution |

### Materialized Views

The setup wizard creates **6 pre-aggregated Delta tables** in the Unity Catalog location you configure. These are the only persistent objects the app creates in your environment.

| Table | What it stores | Rows (est.) |
|---|---|---|
| `daily_usage_summary` | Total DBUs + spend per day | ~365 |
| `daily_product_breakdown` | DBUs + spend per day × product category | ~3,600 |
| `daily_workspace_breakdown` | DBUs + spend per day × workspace | ~3,600–36,000 |
| `sql_tool_attribution` | Genie vs DBSQL spend split per day × warehouse | ~730–7,000 |
| `daily_query_stats` | Query count, rows read, compute time per day | ~365 |
| `dbsql_cost_per_query` | Per-query cost attribution for the last 90 days | ~90k–900k |

Tables are created automatically when the setup wizard completes — no manual action required. The dashboard works immediately using direct system table queries while the background build runs (typically 2–5 minutes), then switches to the pre-aggregated tables automatically.

### Keeping Tables Fresh

Tables are **not** automatically refreshed on a schedule. Refresh whenever you want to pull in the latest billing data (recommended: once a day or before sharing reports).

To refresh: go to **Settings → Configuration → Rebuild**. This rebuilds all 6 tables from the latest `system.*` data. The refresh runs in the background and typically takes 2–5 minutes. Progress is shown in real time.

Tables can be dropped and recreated at any time with no data loss — all source data lives in `system.*` tables managed by Databricks.

### Redeploy Behavior

On git redeploy to the same app:

- The setup wizard **does not re-appear** — the catalog/schema is persisted in DBFS and auto-detected
- Existing tables are left in place; no rebuild is triggered unless you click **Rebuild** in Settings
- The service principal retains its grants (same SP across redeploys on the same app)

### Performance Optimizations

| Optimization | Detail |
|---|---|
| **Materialized Views** | Pre-aggregated Delta tables for sub-second dashboard loads |
| **Parallel Query Execution** | `ThreadPoolExecutor` (10 workers) runs 6–8 queries concurrently per bundle endpoint |
| **4-Hour Query Cache** | `TTLCache` with 500 entries — cost data changes at most once per day |
| **SDK Call Caching** | Pipeline names, group membership, and app registry cached for 1 hour |
| **Bundle Endpoints** | Single API call returns all data for a tab (reduces HTTP round-trips) |
| **React Query** | 30-minute stale time, 1-hour GC — prevents redundant refetches |
| **Lazy-Loaded Chunks** | Each heavy tab (Cloud Costs, AI/ML, Tagging, etc.) is a separate JS chunk loaded on first visit |

---

## Local Development

### Prerequisites
- Python 3.11+
- [Bun](https://bun.sh) (frontend)
- Databricks workspace with system tables enabled
- A SQL warehouse HTTP path

### Setup

```bash
# Clone
git clone https://github.com/smathews13/cost-obs-databricks
cd cost-obs-databricks

# Backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Frontend
cd client && bun install && cd ..
```

### Start Dev Servers

```bash
# Backend (port 8000)
source .venv/bin/activate
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com \
DATABRICKS_TOKEN=dapi... \
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-id \
COST_OBS_CATALOG=my_catalog \
COST_OBS_SCHEMA=cost_obs_app \
uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload

# Frontend (port 5173, separate terminal)
cd client && bun run dev
```

Open http://localhost:5173

---

## Cloud Cost Integration

The Cloud Costs tab displays estimated infrastructure costs out of the box. It can also show **actual** AWS or Azure billing data when configured. Full step-by-step setup instructions for both clouds are built into the app — open the Cloud Costs tab and click **Set Up Actual Costs** to launch the in-app wizard.

### AWS (CUR 2.0)

The app reads from `billing.aws.actuals_gold`. Setup steps are available in the in-app wizard, and the table location can be overridden via `AWS_COST_CATALOG` / `AWS_COST_SCHEMA`.

### Azure (Cost Management Export)

The app reads from `billing.azure.actuals_gold`. Setup steps are available in the in-app wizard, and the table location can be overridden via `AZURE_COST_CATALOG` / `AZURE_COST_SCHEMA`.

---

## App Observability

Databricks Apps has built-in [OpenTelemetry-based observability](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/observability) that automatically captures traces, logs, and metrics into Unity Catalog tables:

| UC Table | Contents |
|---|---|
| `otel_metrics` | Request counts, latency histograms, error rates |
| `otel_spans` | Distributed traces for API requests end-to-end |
| `otel_logs` | App log output with trace correlation |

All telemetry is queryable via SQL in your workspace.

---

## Security

- All dashboard API endpoints are authenticated via Databricks OAuth (handled by the Databricks Apps platform)
- The `X-Forwarded-Email` header is used to identify the requesting user
- Settings mutation endpoints (cloud connections, webhook config, user permissions) require **admin role** — enforced server-side before any state change
- Webhook URLs are masked in API responses (never returned in plaintext after save)

---

## Project Structure

```
cost-obs-databricks/
├── server/                      # FastAPI backend
│   ├── app.py                   # Entry point, startup tasks, router registration
│   ├── db.py                    # SQL connector, 4h TTL query cache, connection pool
│   ├── postgres.py              # Lakebase PostgreSQL connection pool (optional)
│   ├── materialized_views.py    # MV creation, refresh, and query templates
│   ├── alerting.py              # Spike detection logic
│   ├── alert_manager.py         # Alert persistence and delivery
│   ├── cloud_pricing.py         # EC2 / Azure VM pricing for cost estimates
│   ├── queries/
│   │   └── __init__.py          # Core billing SQL
│   └── routers/                 # 18 API route handlers
│       ├── billing.py           # Core spend, KPIs, user/product breakdowns
│       ├── dbsql.py             # SQL tab bundle
│       ├── warehouse_health.py  # Warehouse utilization and rightsizing
│       ├── aiml.py              # AI/ML cost center
│       ├── apps.py              # Databricks Apps cost tracking
│       ├── tagging.py           # Tag coverage and untagged resource surfacing
│       ├── aws_actual.py        # AWS CUR actual cost queries
│       ├── azure_actual.py      # Azure actual cost queries
│       ├── alerts.py            # Threshold alerts and notifications
│       ├── use_cases.py         # Business use case tracking
│       ├── users_groups.py      # User spend analytics
│       ├── genie.py             # Genie AI integration
│       ├── settings.py          # App config, cloud connections, user permissions
│       └── setup.py             # First-run setup wizard
│
├── client/                      # React frontend
│   └── src/
│       ├── App.tsx              # Main dashboard (12 tabs, lazy-loaded chunks)
│       └── components/          # 30+ components
│
├── static/                      # Pre-built frontend assets (committed for git deployments)
├── app.yaml                     # Databricks Apps config with environment variables
├── app.yaml.example             # Environment variable template
├── pyproject.toml               # Python dependencies
└── docs/                        # Setup guides and architecture docs
```

---

## API Overview

The backend exposes a REST API at `/api/`. Key endpoints:

| Endpoint | Description |
|---|---|
| `GET /api/billing/dashboard-bundle-fast` | All DBU overview data in one parallel call |
| `GET /api/billing/by-product` | Spend by product category with workspace filter |
| `GET /api/billing/sku-breakdown` | Top SKUs with workspace filter |
| `GET /api/billing/spend-by-user-group` | Top users by spend |
| `GET /api/billing/infra-bundle` | Cloud cost estimates with billing-derived KPIs |
| `GET /api/dbsql/dashboard-bundle` | SQL tab data (sources, users, warehouses, queries) |
| `GET /api/warehouse-health/recommendations` | Rightsizing recommendations |
| `GET /api/aws-actual/dashboard-bundle` | AWS CUR actual cost data bundle |
| `GET /api/azure-actual/dashboard-bundle` | Azure actual cost data bundle |
| `GET /api/aiml/dashboard-bundle` | AI/ML cost center data |
| `GET /api/apps/dashboard-bundle` | Apps cost data |
| `GET /api/tagging/dashboard-bundle` | Tagging hub data |
| `GET /api/billing/platform-kpis-bundle` | Platform KPIs and anomalies |
| `GET /api/users-groups/bundle` | User spend analytics |
| `POST /api/genie/message` | Natural language cost query via Genie |
| `GET /api/health` | Health check |

Full interactive API docs at `http://localhost:8000/docs` (FastAPI Swagger UI).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, Recharts, TanStack Query v5 |
| Backend | Python 3.11+, FastAPI, Databricks SQL Connector, Databricks SDK 0.81+ |
| Data | Databricks system tables (account-level), Unity Catalog, Delta materialized views |
| Persistence | Lakebase (optional, Databricks-managed PostgreSQL 16); Delta table fallback |
| Deployment | Databricks Apps (managed OAuth, serverless compute), multi-cloud (AWS + Azure) |
| Caching | TTLCache (4h query cache, 1h SDK cache), React Query (30min stale time) |

---

## Docs

| Doc | Description |
|---|---|
| [Pre-Deployment Checklist](docs/PRE_DEPLOYMENT_CHECKLIST.md) | Required permissions and environment prerequisites |
| [Genie Setup](docs/GENIE_SETUP.md) | Configure Databricks Genie for AI cost queries |
| [Alerting System](docs/alerting_system.md) | Alert types, thresholds, and email/webhook setup |
| [DBSQL Cost Architecture](docs/dbsql_cost_architecture.md) | How SQL warehouse costs are attributed |
| [Performance](docs/PERFORMANCE_AUDIT.md) | Query optimization and materialized view strategy |
