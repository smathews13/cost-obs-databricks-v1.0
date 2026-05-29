import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ReadinessChecks, normalizeReadinessResult } from "./ReadinessChecks";
import type { ReadinessResult } from "./ReadinessChecks";
import { READINESS_QUERY_KEY } from "@/hooks/useFeatureAvailability";

interface UserPermissions {
  admins: string[];
  consumers: string[];
  table_location?: string | null;
  current_user?: string | null;
}

interface AuthStatus {
  user_token_active: boolean;
  identity: "user_oauth" | "service_principal";
  locked_to_sp: boolean;
  has_sql_scope: boolean | null;
  auth_mode: "unknown" | "user" | "sp";
  token_present: boolean;
  token_scopes: string[];
  user_email: string | null;
  override_mode: "sp" | "auto" | null;
  sp_client_id: string;
  sp_display_name: string;
  catalog: string;
  schema: string;
}

export function SettingsPermissions() {
  const queryClient = useQueryClient();
  const [grantRunning, setGrantRunning] = useState(false);
  const [grantResult, setGrantResult] = useState<{ ok: boolean; message: string; errors?: string[]; grants_sql?: string; obo_scope_missing?: boolean } | null>(null);
  const [grantSqlCopied, setGrantSqlCopied] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const autoGrantAttempted = useRef(false);

  const { data: permissions, isLoading } = useQuery<UserPermissions>({
    queryKey: ["user-permissions"],
    queryFn: async () => {
      const res = await fetch("/api/settings/user-permissions");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: authStatus, isLoading: authLoading, refetch: refetchAuth } = useQuery<AuthStatus>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });

  // Shared readiness query — same key as useFeatureAvailability so all
  // components (KPI cards, ReadinessChecks panel here) read from one cache entry.
  const {
    data: readiness,
    isLoading: readinessLoading,
    error: readinessQueryError,
  } = useQuery<ReadinessResult | null>({
    queryKey: READINESS_QUERY_KEY,
    queryFn: () =>
      fetch("/api/setup/readiness")
        .then(r => r.ok ? r.json() : null)
        .then(normalizeReadinessResult)
        .catch(() => null),
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const handleReadinessRecheck = (_forceRefresh?: boolean) => {
    queryClient.refetchQueries({ queryKey: READINESS_QUERY_KEY });
  };

  const saveMutation = useMutation({
    mutationFn: async (data: UserPermissions) => {
      const res = await fetch("/api/settings/user-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-permissions"] });
      queryClient.refetchQueries({ queryKey: ["user"] });
    },
  });

  const runSpGrants = async () => {
    setGrantRunning(true);
    setGrantResult(null);
    try {
      const res = await fetch("/api/setup/grant-sp-system-access", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (body.ok || (res.ok && body.status === "ok")) {
        const detail = body.applied != null
          ? `${body.applied} grant(s) applied for ${body.sp_client_id}.`
          : `Grants applied for ${body.sp_client_id}.`;
        setGrantResult({ ok: true, message: detail });
        queryClient.refetchQueries({ queryKey: READINESS_QUERY_KEY });
        await refetchAuth();
      } else {
        const allErrors: string[] = body.errors ?? [];
        const summary = body.failed
          ? `${body.failed} grant(s) failed, ${body.applied ?? 0} applied.`
          : (body.reason ?? body.detail ?? "Grant run completed — check server logs.");
        setGrantResult({
          ok: false,
          message: body.needs_admin
            ? "Automatic grant failed — your current identity could not apply the required permissions."
            : summary,
          errors: allErrors,
          grants_sql: body.grants_sql ?? undefined,
          obo_scope_missing: body.obo_scope_missing ?? false,
        });
      }
    } catch {
      setGrantResult({ ok: false, message: "Network error running grants." });
    } finally {
      setGrantRunning(false);
    }
  };

  // Auto-fire grants on first load if there are SP access failures — avoids
  // requiring a manual "Apply SP Grants" click on fresh deploys.
  useEffect(() => {
    if (!readiness) return;
    if (autoGrantAttempted.current) return;
    if (grantRunning || grantResult) return;
    const hasFailing =
      !readiness.warehouse.granted ||
      readiness.core.some(c => !c.granted) ||
      readiness.enhanced.some(c => !c.granted);
    if (!hasFailing) return;
    autoGrantAttempted.current = true;
    runSpGrants();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness]);

  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<"admin" | "consumer">("consumer");

  const allUsers = [
    ...(permissions?.admins ?? []).map(e => ({ email: e, role: "admin" as const })),
    ...(permissions?.consumers ?? []).map(e => ({ email: e, role: "consumer" as const })),
  ].sort((a, b) => a.email.localeCompare(b.email));

  const addUser = () => {
    const email = newUserEmail.trim();
    if (!email) return;
    const admins = [
      ...(permissions?.admins ?? []).filter(e => e !== email),
      ...(newUserRole === "admin" ? [email] : []),
    ];
    const consumers = [
      ...(permissions?.consumers ?? []).filter(e => e !== email),
      ...(newUserRole === "consumer" ? [email] : []),
    ];
    saveMutation.mutate({ admins, consumers });
    setNewUserEmail("");
  };

  const removeUser = (email: string) => {
    saveMutation.mutate({
      admins: (permissions?.admins ?? []).filter(e => e !== email),
      consumers: (permissions?.consumers ?? []).filter(e => e !== email),
    });
  };

  const changeRole = (email: string, newRole: "admin" | "consumer") => {
    const admins = newRole === "admin"
      ? [...(permissions?.admins ?? []).filter(e => e !== email), email]
      : (permissions?.admins ?? []).filter(e => e !== email);
    const consumers = newRole === "consumer"
      ? [...(permissions?.consumers ?? []).filter(e => e !== email), email]
      : (permissions?.consumers ?? []).filter(e => e !== email);
    saveMutation.mutate({ admins, consumers });
  };

  const isSP = authStatus?.identity === "service_principal";
  const noToken = !authStatus?.token_present;

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-gray-500">Loading permissions...</div>;
  }

  return (
    <div className="space-y-6">

      {/* ── System Readiness (collapsible) ── */}
      {(() => {
        const overall = readiness?.overall;
        const dotColor = overall === "ready" ? "bg-green-500"
          : overall === "core_ready" ? "bg-amber-500"
          : overall ? "bg-red-500" : "bg-gray-300";
        const badgeLabel = overall === "ready" ? "Ready"
          : overall === "core_ready" ? "Core Ready"
          : overall === "needs_action" ? "Needs Action"
          : overall === "not_ready" ? "Not Ready"
          : readinessLoading ? "Checking…" : "—";
        const badgeColor = overall === "ready" ? "bg-green-50 text-green-700 border-green-200"
          : overall === "core_ready" ? "bg-amber-50 text-amber-700 border-amber-200"
          : overall ? "bg-red-50 text-red-700 border-red-200"
          : "bg-gray-50 text-gray-500 border-gray-200";
        return (
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => setReadinessOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
                <h4 className="text-sm font-semibold text-gray-800">System Readiness</h4>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badgeColor}`}>
                  {badgeLabel}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400">SP access to Databricks system tables</span>
                <svg className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${readinessOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>
            {readinessOpen && (
              <div className="border-t border-gray-100 px-4 py-3">
                <ReadinessChecks
                  result={readiness ?? null}
                  loading={readinessLoading}
                  fetchError={readinessQueryError ? String(readinessQueryError) : null}
                  onRecheck={handleReadinessRecheck}
                  onAutoGrant={runSpGrants}
                  autoGrantRunning={grantRunning}
                  autoGrantResult={grantResult}
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* ── App-level user/role permissions ── */}
      {saveMutation.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <strong>Save failed:</strong> {saveMutation.error instanceof Error ? saveMutation.error.message : "Unknown error"}
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-700">
        <strong>Default access:</strong> Any user not explicitly listed is treated as a <strong>Consumer</strong>. Add users to the table below and set their role to <strong>Admin</strong> to grant settings access.
      </div>

      {permissions?.table_location && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-700">
          <strong>Permissions table:</strong>{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-800">{permissions.table_location}</code>
          <span className="ml-2 text-gray-500">— stored in Unity Catalog, persists across deploys</span>
        </div>
      )}

      {/* Unified Users table */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-3">
          <h4 className="text-sm font-semibold text-gray-800">Users</h4>
          <p className="mt-0.5 text-xs text-gray-500">
            Admins can view all data and change app settings. Consumers can view dashboards only.
          </p>
        </div>

        {/* Empty state — no explicit users */}
        {allUsers.length === 0 && (
          <div className="px-4 py-3 space-y-2">
            {permissions?.current_user && (
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 opacity-70">
                <span className="rounded bg-[#1B3139]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#1B3139] uppercase tracking-wide">Admin</span>
                <span className="text-xs text-gray-800">{permissions.current_user}</span>
                <span className="text-xs text-gray-500 italic">(you — implicit default admin)</span>
              </div>
            )}
            <p className="text-xs text-gray-500 italic">
              No users explicitly configured. All users are treated as Consumers by default. Add specific users below to restrict or elevate access.
            </p>
          </div>
        )}

        {/* Users table */}
        {allUsers.length > 0 && (
          <div className="overflow-hidden">
            <table className="min-w-full divide-y divide-gray-100 text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">User</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Role</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-500" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {allUsers.map(({ email, role }) => (
                  <tr key={email} className="group hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2 text-gray-800">{email}</td>
                    <td className="px-4 py-2">
                      <select
                        value={role}
                        onChange={e => changeRole(email, e.target.value as "admin" | "consumer")}
                        disabled={saveMutation.isPending}
                        className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-700 focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621] disabled:opacity-50"
                      >
                        <option value="admin">Admin</option>
                        <option value="consumer">Consumer</option>
                      </select>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => removeUser(email)}
                        disabled={saveMutation.isPending}
                        className="text-xs text-gray-400 hover:text-red-600 transition-colors disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add user row */}
        <div className="border-t border-gray-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              type="email"
              placeholder="user@example.com"
              value={newUserEmail}
              onChange={e => setNewUserEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addUser()}
              className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
            />
            <select
              value={newUserRole}
              onChange={e => setNewUserRole(e.target.value as "admin" | "consumer")}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-white focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
            >
              <option value="consumer">Consumer</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={addUser}
              disabled={!newUserEmail.trim() || saveMutation.isPending}
              className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
              style={{ backgroundColor: !newUserEmail.trim() || saveMutation.isPending ? "#FFA390" : "#FF3621" }}
            >
              Add User
            </button>
          </div>
        </div>
      </div>

      {/* ── Auth Mode Panel ── */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <h4 className="text-sm font-semibold text-gray-800">Query Authentication Mode</h4>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            Service Principal
          </div>
        </div>

        <div className="px-4 py-3 space-y-4">

          {/* Current identity */}
          {authLoading ? (
            <div className="h-10 animate-pulse rounded-lg bg-gray-100" />
          ) : authStatus ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-medium text-gray-600 mb-2">Running as</p>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 border border-green-200 px-3 py-1 text-xs font-semibold text-green-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  {authStatus.sp_display_name || "Service Principal"}
                </span>
                {authStatus.user_email && authStatus.user_email !== "service principal" && (
                  <span className="text-xs text-gray-500">{authStatus.user_email}</span>
                )}
              </div>
            </div>
          ) : null}

          {/* SP post-deploy grant status */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-3">
            <div className="flex items-start gap-2">
              <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-xs font-semibold text-amber-800">Re-apply grants when creating a new app</p>
                <p className="mt-0.5 text-[11px] text-amber-700">
                  Each new Databricks App gets a new service principal with a new client ID. Grants do not carry over from a previous app. Run this once after creating the app as a metastore or account admin.
                </p>
              </div>
            </div>

            {authStatus?.sp_client_id && (
              <div className="rounded border border-amber-200 bg-white px-3 py-2 text-xs space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-28 shrink-0">Current SP ID</span>
                  <code className="font-mono text-gray-800" title={authStatus.sp_client_id}>
                    {authStatus.sp_client_id.slice(0, 8)}…
                  </code>
                </div>
                {authStatus.sp_display_name && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-28 shrink-0">SP display name</span>
                    <span className="text-gray-700">{authStatus.sp_display_name}</span>
                  </div>
                )}
                <p className="text-xs text-amber-600 italic pt-0.5">
                  If grants have not been applied to this SP, dashboard data will show 0 until grants are run.
                </p>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={runSpGrants}
                disabled={grantRunning}
                className="btn-brand rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 transition-colors"
              >
                {grantRunning ? "Running grants…" : "Re-run SP grants"}
              </button>
              {grantResult && (
                <div className={`text-[11px] font-medium ${grantResult.ok ? "text-green-700" : "text-red-600"}`}>
                  <span>{grantResult.ok ? "✓ " : "✗ "}{grantResult.message}</span>
                  {!grantResult.ok && grantResult.errors && grantResult.errors.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 space-y-0.5 font-normal text-red-500">
                      {grantResult.errors.map((e, i) => (
                        <li key={i} className="break-all">{e}</li>
                      ))}
                    </ul>
                  )}
                  {grantResult.obo_scope_missing && (
                    <p className="mt-1 text-[10px] text-amber-700 font-normal">
                      OBO scope missing — this app is not configured with the <code className="font-mono">sql</code> user authorization scope.
                    </p>
                  )}
                  {grantResult.grants_sql && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-medium text-amber-900">
                          Run as metastore admin — Copy and run the SQL below, then click Re-check.
                        </p>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(grantResult.grants_sql!);
                            setGrantSqlCopied(true);
                            setTimeout(() => setGrantSqlCopied(false), 1800);
                          }}
                          className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium bg-gray-700 text-white hover:bg-gray-600"
                        >
                          {grantSqlCopied ? "Copied!" : "Copy"}
                        </button>
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-gray-900 px-3 py-2 text-[10px] leading-relaxed text-green-400">
                        {grantResult.grants_sql}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* SP grants reference — app runtime grants */}
          {(isSP || noToken) && authStatus && (
            <details className="rounded-lg border border-gray-200 bg-gray-50">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-gray-700 hover:text-gray-900">
                App runtime grants — exact SQL (run as metastore admin)
              </summary>
              <div className="border-t border-gray-200 px-4 py-3 space-y-3">
                {(() => {
                  const spName = authStatus.sp_display_name || authStatus.sp_client_id || "<service-principal>";
                  const userEmail = authStatus.user_email;
                  const cat = authStatus.catalog || "<your_catalog>";
                  const sch = authStatus.schema || "<your_schema>";
                  const appGrants =
`-- System tables (billing + query history + compute + lakeflow)
-- WHY: The app SP queries these tables to build all dashboards.
-- WHO: Must be run by a metastore admin or account admin.
-- WHEN: Required once when the app is first created (SP is tied to the app, not the code).
GRANT USE CATALOG ON CATALOG system TO \`${spName}\`;
GRANT USE SCHEMA ON SCHEMA system.billing TO \`${spName}\`;
GRANT SELECT ON TABLE system.billing.usage TO \`${spName}\`;
GRANT SELECT ON TABLE system.billing.list_prices TO \`${spName}\`;
GRANT SELECT ON TABLE system.billing.account_prices TO \`${spName}\`;
GRANT USE SCHEMA ON SCHEMA system.query TO \`${spName}\`;
GRANT SELECT ON TABLE system.query.history TO \`${spName}\`;
GRANT USE SCHEMA ON SCHEMA system.compute TO \`${spName}\`;
GRANT SELECT ON TABLE system.compute.clusters TO \`${spName}\`;
GRANT USE SCHEMA ON SCHEMA system.lakeflow TO \`${spName}\`;
GRANT SELECT ON TABLE system.lakeflow.pipelines TO \`${spName}\`;
GRANT USE SCHEMA ON SCHEMA system.serving TO \`${spName}\`;
GRANT SELECT ON TABLE system.serving.served_entities TO \`${spName}\`;

-- App schema (materialized views)
-- WHY: The SP must be able to create and query app-managed tables in your catalog.
-- WHEN: Required once per deploy.
GRANT USE CATALOG ON CATALOG \`${cat}\` TO \`${spName}\`;
GRANT USE SCHEMA ON SCHEMA \`${cat}\`.\`${sch}\` TO \`${spName}\`;
GRANT CREATE TABLE ON SCHEMA \`${cat}\`.\`${sch}\` TO \`${spName}\`;
GRANT SELECT ON SCHEMA \`${cat}\`.\`${sch}\` TO \`${spName}\`;`;
                  return (
                    <>
                      <div className="grid grid-cols-3 gap-2 text-xs rounded border border-gray-200 bg-white px-3 py-2">
                        <div><span className="text-gray-500">Target SP</span><br /><code className="font-mono text-gray-800 break-all">{spName}</code></div>
                        <div><span className="text-gray-500">Who must run</span><br /><span className="text-gray-700">Metastore or account admin</span></div>
                        <div><span className="text-gray-500">When</span><br /><span className="text-gray-700">Required once when the app is first created</span></div>
                      </div>
                      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                        <strong>Warehouse CAN_USE</strong> cannot be granted via SQL. Grant it via: SQL Warehouses → [warehouse name] → Permissions tab → Add {spName}. The app attempts this automatically on startup.
                      </div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Section 1 — App runtime grants</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(appGrants)}
                          className="rounded px-2 py-0.5 text-[10px] font-medium text-gray-500 border border-gray-200 hover:border-gray-400 hover:text-gray-700 transition-colors"
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="rounded bg-gray-900 px-4 py-3 text-[11px] text-green-400 overflow-x-auto leading-relaxed whitespace-pre">{appGrants}</pre>

                      {userEmail && userEmail !== spName && (
                        <>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Section 2 — Optional user read access</span>
                            <button
                              onClick={() => navigator.clipboard.writeText(
`-- User read access (optional — only needed if ${userEmail} should query app tables directly)
-- WHY: Grants the admin user read-only access to app-managed tables outside the app.
-- WHO: Metastore admin.
-- WHEN: One-time, does not rotate with deploys.
GRANT SELECT ON SCHEMA \`${cat}\`.\`${sch}\` TO \`${userEmail}\`;`
                              )}
                              className="rounded px-2 py-0.5 text-[10px] font-medium text-gray-500 border border-gray-200 hover:border-gray-400 hover:text-gray-700 transition-colors"
                            >
                              Copy
                            </button>
                          </div>
                          <pre className="rounded bg-gray-900 px-4 py-3 text-[11px] text-green-400 overflow-x-auto leading-relaxed whitespace-pre">{
`-- User read access (optional — only needed if ${userEmail} should query app tables directly)
-- WHY: Grants the admin user read-only access to app-managed tables outside the app.
-- WHO: Metastore admin.
-- WHEN: One-time, does not rotate with deploys.
GRANT SELECT ON SCHEMA \`${cat}\`.\`${sch}\` TO \`${userEmail}\`;`
                          }</pre>
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            </details>
          )}
        </div>
      </div>

    </div>
  );
}

