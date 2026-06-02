# Deployment Plan: Cost Observability & Control

## Context

The app (`cost-obs`) is deployed on the CMEG Demo workspace and shows as RUNNING, but **all data endpoints return 504 timeouts**. The root cause: the app's service principal only has `iam.current-user:read` and `iam.access-control:read` OAuth scopes — no SQL warehouse access. This happened because no SQL warehouse resource was declared when the app was created/deployed. Additionally, `DATABRICKS_HTTP_PATH=auto` triggers warehouse auto-creation logic that the SP can't execute.

Two deliverables are needed:
1. **A repeatable CMEG deployment** that actually works end-to-end (data endpoints included)
2. **A Declarative Automation Bundle** for deploying to other environments with a setup wizard

---

## PART 1: Repeatable CMEG Deployment

### Step 1: Update `app.yaml` to use explicit warehouse path

**File**: `app.yaml`

Change `DATABRICKS_HTTP_PATH` from `auto` to the validated warehouse path. This skips the auto-creation code path entirely, which the SP can't execute anyway.

```yaml
name: cost-obs
description: Cost Observability & Control - Databricks compute consumption and spend analytics

env:
  - name: DATABRICKS_HTTP_PATH
    value: /sql/1.0/warehouses/dde448100db8752a
  - name: GENIE_SPACE_ID
    value: 01f0fcc775c11bb480e57c8b210a1995
  - name: COST_OBS_CATALOG
    value: cmegdemos_catalog
  - name: COST_OBS_SCHEMA
    value: cost_obs

command: ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
```

Key change: `auto` → `/sql/1.0/warehouses/dde448100db8752a`

**STATUS: DONE** — app.yaml already updated locally (unstaged).

### Step 2: Add SQL warehouse resource to the app via CLI

The `resources` field is NOT part of `app.yaml` — it's set on the app object itself via the Apps API/CLI. The deploy script needs to set this.

**Command** (already tested successfully):
```bash
databricks apps update cost-obs --json '{
  "description": "Cost Observability & Control - Databricks compute consumption and spend analytics",
  "resources": [{
    "name": "sql-warehouse",
    "description": "SQL Warehouse for cost observability queries",
    "sql_warehouse": {
      "id": "dde448100db8752a",
      "permission": "CAN_USE"
    }
  }]
}'
```

This grants the app's SP "CAN USE" on warehouse `dde448100db8752a`. **Must be done before deploy** so the SP has permissions when the app starts.

**STATUS: DONE** — resource already added to live app via CLI.

### Step 3: Update `dba_deploy.sh`

**File**: `dba_deploy.sh`

Add these changes:
1. **New Step 0**: Set app resources (SQL warehouse) via CLI before deploying
2. **New Step 6**: Post-deployment verification (health check + data endpoint)
3. **Validation**: Check that `app.yaml` doesn't have `DATABRICKS_HTTP_PATH: auto`

### Step 4: Improve error handling in `server/db.py`

**File**: `server/db.py` — `setup_warehouse_connection()` (line 170)

Add try/except around `ensure_dedicated_warehouse()` with a clear error message telling the user to set `DATABRICKS_HTTP_PATH` explicitly. This is defense-in-depth — when the path is explicit (not `auto`), this function just logs and returns.

### Step 5: Deploy and Verify

Single command: `./dba_deploy.sh cost-obs`

**Verification checklist** (automated in script):
1. `GET /api/health` → `{"status": "healthy"}` (immediate)
2. `GET /api/settings/config` → shows warehouse info (after ~30s startup)
3. `GET /api/permissions/check` → shows permission grants (confirms SQL access works)
4. `GET /api/billing/summary` → returns actual billing data (confirms full pipeline)

---

## PART 2: Declarative Automation Bundle for Other Environments

### Step 1: Create `databricks.yml`

**File**: `databricks.yml` (new, project root)

```yaml
bundle:
  name: cost-observability-control

variables:
  sql_warehouse_id:
    description: "SQL Warehouse ID for query execution"
  cost_obs_catalog:
    description: "Unity Catalog name for materialized views"
    default: "main"
  cost_obs_schema:
    description: "Schema name for materialized views"
    default: "cost_obs"
  genie_space_id:
    description: "Genie Space ID for AI cost analysis (optional)"
    default: ""

resources:
  apps:
    cost-observability:
      name: cost-observability
      description: "Cost Observability & Control"
      source_code_path: .
      resources:
        - name: "sql-warehouse"
          sql_warehouse:
            id: ${var.sql_warehouse_id}
            permission: "CAN_USE"

targets:
  cmeg:
    default: true
    workspace:
      host: https://fevm-cmegdemos.cloud.databricks.com
    variables:
      sql_warehouse_id: dde448100db8752a
      cost_obs_catalog: cmegdemos_catalog
      cost_obs_schema: cost_obs
      genie_space_id: 01f0fcc775c11bb480e57c8b210a1995

  dev:
    workspace:
      host: ${DATABRICKS_HOST}
```

### Step 2: Create `app.yaml.template` for variable substitution

**File**: `app.yaml.template` (new, project root)

Since DAB variable substitution in `app.yaml` `env` values may not work (see [GitHub CLI issue #3679](https://github.com/databricks/cli/issues/3679)), use a template approach:

```yaml
name: cost-observability
description: Cost Observability & Control

env:
  - name: DATABRICKS_HTTP_PATH
    value: /sql/1.0/warehouses/__SQL_WAREHOUSE_ID__
  - name: COST_OBS_CATALOG
    value: __COST_OBS_CATALOG__
  - name: COST_OBS_SCHEMA
    value: __COST_OBS_SCHEMA__
  - name: GENIE_SPACE_ID
    value: __GENIE_SPACE_ID__

command: ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
```

The deploy script will `sed` the placeholders before syncing.

### Step 3: Create `deploy_bundle.sh` — unified deployment for any target

**File**: `deploy_bundle.sh` (new)

Orchestrates the full bundle deployment:
1. Build frontend
2. Compile requirements.txt
3. Generate `app.yaml` from template using target variables
4. Set app resources via CLI (SQL warehouse with CAN_USE)
5. Sync + deploy
6. Verify

Usage:
```bash
# CMEG (uses databricks.yml cmeg target defaults)
./deploy_bundle.sh cmeg

# New environment (provide variables)
./deploy_bundle.sh dev \
  --warehouse-id abc123 \
  --catalog my_catalog \
  --schema cost_obs
```

### Step 4: Create SetupWizard frontend component

**File**: `client/src/components/SetupWizard.tsx` (new)

A multi-step wizard that appears on first load when materialized views don't exist. Uses existing API endpoints:

| Step | Title | API Call | Purpose |
|------|-------|----------|---------|
| 1 | Welcome | `GET /api/settings/config` + `GET /api/settings/cloud-provider` | Show detected environment (cloud, warehouse, catalog) |
| 2 | Permissions | `GET /api/permissions/check` | Verify system table access, show GRANT statements |
| 3 | Create Tables | `POST /api/setup/create-tables` | Create materialized views |
| 4 | Complete | — | Redirect to dashboard |

**No new backend endpoints needed** — all building blocks exist:
- `/api/setup/status` (in `server/routers/setup.py:24`)
- `/api/setup/create-tables` (in `server/routers/setup.py:46`)
- `/api/settings/config` (in `server/routers/settings.py:90`)
- `/api/settings/cloud-provider` (in `server/routers/settings.py:140`)
- `/api/permissions/check` (in `server/routers/permissions.py:149`)

### Step 5: Integrate SetupWizard into App.tsx

**File**: `client/src/App.tsx`

Add a setup status check that shows the wizard before the main dashboard:
- Call `GET /api/setup/status` on mount
- If `all_tables_exist === false` and no `coc-setup-complete` in localStorage, show `<SetupWizard />`
- On wizard completion, set localStorage flag and reload

This replaces the current flow where the app loads directly into PermissionsDialog → Dashboard. The new flow: SetupWizard (if needed) → PermissionsDialog → Dashboard.

### Step 6: Update `.databricksignore`

**File**: `.databricksignore`

Add:
```
databricks.yml
app.yaml.template
deploy_bundle.sh
dba_deploy.sh
dba_client.py
dba_logz.py
```

These are dev/deployment tools, not app runtime code.

---

## Multi-Cloud Considerations

Already handled by existing code — no changes needed:
- **Cloud detection**: `server/routers/settings.py:140` detects AWS/Azure/GCP from workspace URL
- **Cloud pricing**: `server/cloud_pricing.py` has provider-specific logic
- **SQL queries**: All use `system.billing.usage` which is cloud-agnostic
- **AWS CUR tab**: Gracefully hides when no CUR tables exist (already implemented)

---

## What NOT to Change

1. `server/db.py` `get_connection()` / `get_workspace_client()` — dual-mode auth works correctly
2. `server/queries/__init__.py` — SQL queries are cloud-agnostic
3. `pyproject.toml` / dependency chain
4. Frontend build pipeline (Vite + React + Tailwind)
5. Cache layer (TTLCache in `db.py`)
6. `dba_client.py` / `dba_logz.py` — keep as diagnostic tools
7. `SettingsDialog.tsx` — existing Config tab already shows runtime config
8. `ensure_dedicated_warehouse()` — keep for future use, just don't trigger it

---

## Files Changed Summary

| File | Action | Part |
|------|--------|------|
| `app.yaml` | Modify — explicit warehouse path | Part 1 |
| `dba_deploy.sh` | Modify — add resource setup + verification | Part 1 |
| `server/db.py` | Minor modify — better error handling | Part 1 |
| `databricks.yml` | Create — DAB bundle definition | Part 2 |
| `app.yaml.template` | Create — template for variable substitution | Part 2 |
| `deploy_bundle.sh` | Create — unified deployment script | Part 2 |
| `client/src/components/SetupWizard.tsx` | Create — setup wizard UI | Part 2 |
| `client/src/App.tsx` | Minor modify — add setup check | Part 2 |
| `.databricksignore` | Modify — exclude bundle files | Part 2 |

---

## Verification Plan

### Part 1 Verification (CMEG)
```bash
# Deploy
./dba_deploy.sh cost-obs

# Verify (automated in script, also manual)
DATABRICKS_APP_NAME=cost-obs python3 dba_client.py /api/health
DATABRICKS_APP_NAME=cost-obs python3 dba_client.py /api/settings/config
DATABRICKS_APP_NAME=cost-obs python3 dba_client.py /api/permissions/check
DATABRICKS_APP_NAME=cost-obs python3 dba_client.py /api/billing/summary
```

### Part 2 Verification (DAB)
```bash
# Validate bundle
databricks bundle validate -t cmeg

# Deploy via bundle
databricks bundle deploy -t cmeg

# Verify same endpoints work
```

---

## Implementation Order

1. **Part 1 first** — fix CMEG deployment (app.yaml + dba_deploy.sh + db.py)
2. **Deploy and verify** — confirm data endpoints work on live app
3. **Part 2** — create DAB structure + SetupWizard
4. **Test Part 2** — deploy via bundle to CMEG, verify identical behavior
