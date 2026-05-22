# Cost Observability & Control — Deployment Guide

First-time deployment from Git using Databricks Apps. Estimated time: **15–20 minutes**.

---

## Requirements

### Required

| Requirement | Notes |
|---|---|
| Databricks workspace (Premium or above) | Apps must be enabled — contact your account team if not available |
| Unity Catalog enabled | Required for materialized views and system table access |
| System tables enabled | `system.billing.usage` and `system.billing.list_prices` must be accessible |
| SQL warehouse | See recommendation below |
| Workspace Admin role | Required to create the app and grant the service principal access |
| Metastore Admin role (or access to one) | Required to run the system table grants during setup |

### Warehouse recommendation

Use a **Serverless SQL warehouse, Medium size**. Serverless warehouses start in seconds and are billed only while running queries — there is no idle cost. A Medium size handles the initial materialized view build comfortably and supports concurrent users on the dashboard.

A Pro or Classic warehouse also works, but cold-start times will be longer during setup.

### Optional (enhances functionality)

| Feature | What it enables |
|---|---|
| `system.query.history` access | SQL Warehousing tab — per-query cost attribution |
| `system.compute.clusters` access | Job & cluster cost breakdown |
| AI/BI Genie Space | Natural language cost queries in the app |
| AWS Cost and Usage Reports (CUR 2.0) | Actual AWS infrastructure costs alongside DBU spend |

---

## Step 1 — Create the App from Git

1. In your Databricks workspace, open the left sidebar and click **Apps**.
2. Click **Create app**.
3. Select **Import from Git** and enter the repository URL:
   ```
   https://github.com/smathews13/cost-obs-databricks
   ```
4. Leave the branch as `main`.
5. Give the app a name — for example, `cost-observability` — and click **Create**.

Databricks will clone the repository and prepare the app. This takes about a minute.

---

## Step 2 — Add the SQL Warehouse Resource

The app reads the warehouse ID from a managed resource — this avoids hardcoding credentials in configuration.

1. In the app configuration screen, scroll to **Resources** and click **+ Add resource**.
2. Select **SQL warehouse**.
3. Choose your Serverless Medium warehouse from the dropdown.
4. Set the permission to **Can use**.
5. Leave the resource key as `sql-warehouse` (the app expects this exact key).
6. Click **Add**.

> The warehouse ID is injected automatically as `DATABRICKS_WAREHOUSE_ID`. You do not need to set this manually.

---

## Step 3 — Configure Environment Variables

In the app configuration screen, open **Environment variables** and set these **required** values:

| Variable | Required | Description |
|---|---|---|
| `COST_OBS_CATALOG` | **Yes** | Unity Catalog catalog for materialized views — must be a dedicated catalog, not `main` |
| `COST_OBS_SCHEMA` | **Yes** | Schema name for materialized views (e.g. `cost_obs_app`) |
| `COST_OBS_WORKSPACES` | No | Comma-separated workspace IDs to restrict the dashboard |

> **Important:** Do not use `main` as the catalog or `cost_obs` as the schema with the `main` catalog. These are reserved defaults. The app will refuse to create tables there. Use a dedicated catalog (e.g. `my_company_catalog`) and a descriptive schema name.

The catalog and schema will be created automatically during the setup wizard if they don't exist and your identity has the necessary permissions. No manual DDL is required.

---

## Step 4 — Deploy

Click **Deploy** in the top-right corner. Databricks will:

- Install Python dependencies
- Build the frontend
- Start the application server

Deployment typically takes 2–4 minutes. When the status shows **Running**, click the app URL to open it.

---

## Step 5 — Complete the Setup Wizard

On first open, the app will show a **Setup Wizard** that walks through everything in order. Follow it from top to bottom — you do not need to navigate into Settings manually.

### What the wizard does

#### Step 1 — Grant system table access

The wizard generates the exact SQL required to give the app's service principal access to Databricks system tables. It shows you the grant bundle and a **Re-check** button.

1. Copy the SQL displayed in the wizard.
2. Run it in a notebook or the SQL editor **as a Metastore Admin** (system table grants require metastore-level privileges).
3. Click **Re-check** in the wizard. The status will turn green when grants are confirmed.

You do not need to write your own grant SQL — use exactly what the wizard generates, since it targets the correct service principal name for your deployment.

#### Step 2 — Build the app tables

Once grants pass, the wizard will prompt you to build the pre-aggregated tables used by the dashboard. Click **Build** and wait for completion. This runs in the background on your warehouse and typically takes 3–8 minutes depending on data volume.

The dashboard will show live data as soon as the build completes. You do not need to leave the wizard open — you can close the browser and return when the build is done.

> **Re-running after initial setup:** If you ever need to re-apply grants or rebuild tables (for example, after adding a new workspace), use **Settings → Permissions** and **Settings → Config** respectively. These are the management surfaces for ongoing operations — the wizard is only shown on first run.

---

## Step 6 — Verify

Open the main dashboard. You should see:

- **DBU Overview** tab loading spend data for the last 30 days
- **Billing** tab showing SKU-level breakdown
- A green "Ready" status in Settings → Config

If any tab shows a warning, go to **Settings → Debugger** and click **Run Diagnostics** for a detailed check with fix instructions.

---

## Minimum access for end users

By default, only Workspace Admins can see all data. To give other users access:

1. Go to **Settings → Permissions**.
2. Add users or groups.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard shows no data | System table grants not applied | Settings → Permissions → Re-run SP Grants |
| "Warehouse not found" on load | Warehouse resource not configured | Settings → Config, verify warehouse ID |
| Materialized view build fails | SP missing `CREATE SCHEMA` / `CREATE TABLE` on catalog | Grant `CREATE SCHEMA` and `CREATE TABLE` on your catalog to the SP |
| SQL Warehousing tab missing | `system.query.history` not granted | Run the optional query history grant shown in Settings → Permissions |
| Setup wizard loops | Stale browser cache | Hard-refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`) |

For additional diagnostics, use **Settings → Debugger → Run Diagnostics**, which checks every dependency and surfaces specific fix SQL for any failure.
