# Support Runbook — Cost Observability App

One-page incident reference. Start at the symptom that matches; follow the steps in order.

---

## Symptom: Dashboard shows $0 / zero counts / "—" for all metrics

**Root cause:** SP grants not applied after most recent deploy, OR readiness cache is stale.

**Steps:**
1. Check `GET /api/setup/readiness` → look at `overall` and `warehouse.granted`.
2. If `warehouse.granted: false` → the SP needs CAN_USE on the SQL warehouse. Grant via: SQL Warehouses → [warehouse name] → Permissions → Add the SP (cannot be done via SQL).
3. If any `core[]` item has `granted: false` → open **Settings → Permissions**, copy the **Section 1 grant bundle**, run it as a metastore admin. The SP client ID rotates on each git deploy; grants from the previous deploy are orphaned.
4. After applying grants, click **Run Diagnostics** in **Settings → Debugger** to confirm all checks pass.

**Key fact:** SP client ID rotates on every git deploy. Grants must be re-applied after every deploy.

---

## Symptom: KPI card shows "—" (not loading spinner, not 0)

**Root cause:** A specific system table grant is denied. "—" is the correct unavailable state — it means the app detected the denial and is not silently showing zero.

**Steps:**
1. Hover over the "—" card — the tooltip shows which table is missing (e.g. `query.history grant required`).
2. Go to **Settings → Permissions** → copy the Section 1 grant bundle.
3. Run the grant as a metastore admin.
4. After ~30 seconds the card will refresh automatically (cache invalidation fires on grant apply).

---

## Symptom: Settings → Readiness shows "not_ready" after grants were applied

**Root cause:** Readiness cache has not been invalidated, or the grant targeted the wrong SP.

**Steps:**
1. In **Settings → Permissions**, verify `SP Client ID` matches `DATABRICKS_CLIENT_ID` in the Apps UI → Environment Variables. If they differ, grants were applied to the old SP — re-apply to the current one.
2. Click **Re-check Readiness** (or **Run SP Grants** which also invalidates the cache).
3. If still stuck: call `GET /api/setup/readiness?refresh=true` to force a bypass-cache check.

---

## Symptom: "Drop Tables" button is greyed out / disabled

**Root cause:** The system is in a degraded state — one or more required tables have `exists: false`. This is intentional safety gate.

**Resolution:**
1. Go to **Settings → Debugger** → **Run Diagnostics** to identify which tables are missing.
2. Fix the underlying issue (grant missing tables, rebuild) before dropping.
3. If you must drop in a degraded state (emergency recovery), note: the button is disabled to prevent deepening an existing outage. Use the API directly with caution: `DELETE /api/setup/tables` — this requires a separate service account token.

---

## Symptom: Settings → Debugger shows "Auth mode: user" but should be SP

**Root cause:** A user OAuth token is in the request context (user is accessing via browser), which overrides SP identity for the permissions display.

**This is expected behavior** — the debugger shows the requesting user's identity. To see the SP's identity, call the endpoint from a context without a forwarded token (e.g. curl with a PAT, not a browser session).

---

## Symptom: Diagnostics check shows red for a warehouse check but warehouse exists

**Root cause:** SP identity mismatch, or warehouse is in STOPPED state.

**Steps:**
1. In **Settings → Config**, check the warehouse source: `app_resource` (managed by Apps) vs. `http_path` (configured manually).
2. If `http_path`, verify the warehouse is running and the SP has CAN_USE.
3. If `app_resource`, verify the Apps environment has `DATABRICKS_WAREHOUSE_ID` set correctly.
4. Click the **Grant SQL** button in the Debugger for the failing warehouse check to get the exact fix SQL.

---

## API quick reference

| Endpoint | Purpose |
|---|---|
| `GET /api/setup/readiness` | Current readiness state (5-min cache) |
| `GET /api/setup/readiness?refresh=true` | Force live re-check, bypass cache |
| `GET /api/permissions/check` | Current user's table access (5-min cache) |
| `GET /api/permissions/check?refresh=true` | Force live re-check |
| `GET /api/settings/auth-status` | Current identity (auth mode, SP info) |
| `GET /api/debug/run` | Run all diagnostics and return typed results |

---

## Escalation path

1. **App admin** — apply SP grant bundle, check warehouse permissions.
2. **Metastore admin** — apply system table grants (`GRANT SELECT ON TABLE system.* TO ...`).
3. **Databricks Support** — if `system.*` tables are not visible to any principal in the workspace, the workspace may not have system table access enabled at the account level.
