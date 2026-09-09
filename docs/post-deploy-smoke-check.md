# Post-Deploy Smoke Check — Release Criteria

**This is a required gate for every deploy.** A deploy is not complete until this checklist is signed off with one of three outcomes: **pass**, **degraded but acceptable** (enhanced tables missing — core metrics OK), or **blocked** (stop, do not promote to production users).

Estimated time: ~5 minutes.

---

## Release sign-off block

Copy this into your deploy PR or release notes before marking the deploy complete:

```text
Post-deploy smoke check: [ ] pass  [ ] degraded-acceptable  [ ] blocked
Checked by: ___________  Date: ___________
Readiness overall: _______  Warehouse granted: _______
KPI cards show real values: [ ] yes  [ ] no
Notes: ___________
```

---

## 1. Readiness API

```bash
curl -s "$APP_URL/api/setup/readiness" | python3 -m json.tool
```

**Pass criteria:**
- `overall` is `"ready"` or `"core_ready"` (not `"not_ready"` or `"needs_action"`)
- `warehouse.granted` is `true`
- All items in `core[]` have `"granted": true`
- Response arrives in < 30 s (warehouse cold-start excluded)

**Fail signal:** `overall: "not_ready"` means required access is missing or has
drifted. A normal Git redeploy keeps the existing app service principal, so do
not reapply grants unless readiness identifies an actual access gap.

---

## 2. SP identity matches deployed credentials

In the Readiness API response, verify `sp_client_id` is populated. Databricks
Apps injects `DATABRICKS_CLIENT_ID` for the app's service principal; it is not a
customer-managed environment override.

**Fail signal:** `sp_client_id` is empty, or the app was deleted and recreated
with a different principal. In that case, apply grants to the new principal.

---

## 3. Platform KPIs load (no fake zeros)

1. Open the app in a browser.
2. Navigate to the **Platform KPIs** section.
3. Verify:
   - Job count, query count, cluster count, and model serving counts show real values (not `0` or `—`).
   - If any card shows `—` with a reason like "query.history grant required", the corresponding SP grant is missing — apply the grant bundle from **Settings → Permissions & Access**.
   - No card shows `$0.00` when the date range has activity.

**Fail signal:** A KPI shows `0` for a metric that historically had data → fake-zero regression. Check `system.query.history` and `system.lakeflow.pipelines` grants.

---

## 4. Diagnostics API

1. Call `GET /api/debug/run` as an app administrator.
2. Verify all core checks report a passing status.

**Acceptable:** Enhanced table checks in amber if optional grants not applied.

**Fail signal:** Any core check in red → apply grants and re-run. If warehouse check fails → SP needs CAN_USE on the configured warehouse.

---

## 5. Cache invalidation after grant apply

If readiness reports a missing grant:

1. In **Settings → Identity & Permissions**, click **Run SP Grants**.
2. After the grant completes, verify the Readiness section updates within 5 seconds (no manual refresh required).

**Fail signal:** Readiness section still shows stale state after grant → `queryClient.invalidateQueries` is not firing; check the `READINESS_QUERY_KEY` import in `SettingsPermissions.tsx`.

---

## 6. Drop Tables safety gate

1. Open **Settings → Data & tables**.
2. Verify the **Drop Tables** button is present.
3. If all tables exist (healthy), click it — a CONFIRM input must appear.
4. Type `con` (lowercase partial) — **Confirm Drop** button must remain disabled.
5. Type `CONFIRM` (exact) — button becomes active.
6. Click **Cancel** / close the dialog — do not proceed with the actual drop.

**Fail signal:** Drop Tables is enabled without requiring CONFIRM, or it's enabled when tables are missing.

---

## 7. Auth mode displayed correctly

Call `GET /api/settings/auth-status`:

- `Auth mode` must show `"service_principal"`.
- Forwarded user credentials must not be active for SQL.

---

## Quick pass/fail summary

| Check | Pass | Fail → Action |
|---|---|---|
| Readiness `overall` | `ready` / `core_ready` | Re-apply SP grant bundle |
| `sp_client_id` | Populated | Check the app identity; reapply grants only if it changed |
| Platform KPIs show real values | Non-zero values | Apply missing table grants |
| Diagnostics all green | All pass | Apply the endpoint's remediation guidance |
| Cache refreshes after grant | Auto-refresh | Check READINESS_QUERY_KEY import |
| Drop Tables requires CONFIRM | Gated | Regression — revert SettingsConfig change |
