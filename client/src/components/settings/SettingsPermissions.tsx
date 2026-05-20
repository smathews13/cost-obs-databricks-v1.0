import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

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
  const [newAdmin, setNewAdmin] = useState("");
  const [newConsumer, setNewConsumer] = useState("");
  const [grantRunning, setGrantRunning] = useState(false);
  const [grantResult, setGrantResult] = useState<{ ok: boolean; message: string; errors?: string[] } | null>(null);

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
        queryClient.invalidateQueries({ queryKey: ["settings-auth-status"] });
        await refetchAuth();
      } else {
        const allErrors: string[] = body.errors ?? [];
        const summary = body.failed
          ? `${body.failed} grant(s) failed, ${body.applied ?? 0} applied.`
          : (body.reason ?? body.detail ?? "Grant run completed — check server logs.");
        setGrantResult({ ok: false, message: summary, errors: allErrors });
      }
    } catch {
      setGrantResult({ ok: false, message: "Network error running grants." });
    } finally {
      setGrantRunning(false);
    }
  };

  const addAdmin = () => {
    const email = newAdmin.trim();
    if (!email) return;
    saveMutation.mutate({
      admins: [...(permissions?.admins ?? []), email],
      consumers: (permissions?.consumers ?? []).filter((e) => e !== email),
    });
    setNewAdmin("");
  };

  const removeAdmin = (email: string) => {
    saveMutation.mutate({
      admins: (permissions?.admins ?? []).filter((e) => e !== email),
      consumers: permissions?.consumers ?? [],
    });
  };

  const addConsumer = () => {
    const email = newConsumer.trim();
    if (!email) return;
    saveMutation.mutate({
      admins: (permissions?.admins ?? []).filter((e) => e !== email),
      consumers: [...(permissions?.consumers ?? []), email],
    });
    setNewConsumer("");
  };

  const removeConsumer = (email: string) => {
    saveMutation.mutate({
      admins: permissions?.admins ?? [],
      consumers: (permissions?.consumers ?? []).filter((e) => e !== email),
    });
  };

  const isSP = authStatus?.identity === "service_principal";
  const noToken = !authStatus?.token_present;

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-gray-500">Loading permissions...</div>;
  }

  return (
    <div className="space-y-6">

      {/* ── App-level user/role permissions ── */}
      {saveMutation.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <strong>Save failed:</strong> {saveMutation.error instanceof Error ? saveMutation.error.message : "Unknown error"}. Check that the app service principal has INSERT/DELETE access to the permissions table.
        </div>
      )}
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700">
        <strong>Default access:</strong> Any user not explicitly listed is treated as a <strong>Consumer</strong>. Add users to <em>Admins</em> to grant settings access.
      </div>

      {permissions?.table_location && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <span className="font-medium">Permissions table: </span>
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-800">{permissions.table_location}</code>
          <span className="ml-2 text-gray-500">— stored in Unity Catalog, persists across deploys</span>
        </div>
      )}

      {/* Admins */}
      <div>
        <h4 className="mb-1 text-sm font-semibold text-gray-800">Admins</h4>
        <p className="mb-3 text-xs text-gray-500">Admins can view all data and change app settings.</p>
        <div className="mb-3 space-y-2">
          {(permissions?.admins ?? []).length === 0 ? (
            <div className="space-y-2">
              {permissions?.current_user && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 opacity-60">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">Admin</span>
                    <span className="text-sm text-gray-800">{permissions.current_user}</span>
                    <span className="text-xs text-gray-400 italic">(you — default admin)</span>
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500 italic">No admins explicitly configured. All users are admins by default. Add specific users below to restrict admin access to only those listed.</p>
            </div>
          ) : (
            (permissions?.admins ?? []).map((email) => (
              <div key={email} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">Admin</span>
                  <span className="text-sm text-gray-800">{email}</span>
                </div>
                <button onClick={() => removeAdmin(email)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="user@example.com"
            value={newAdmin}
            onChange={(e) => setNewAdmin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAdmin()}
            className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none"
          />
          <button
            onClick={addAdmin}
            disabled={!newAdmin.trim() || saveMutation.isPending}
            className="btn-brand rounded-md px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Add Admin
          </button>
        </div>
      </div>

      {/* Consumers */}
      <div>
        <h4 className="mb-1 text-sm font-semibold text-gray-800">Consumers</h4>
        <p className="mb-3 text-xs text-gray-500">Consumers can view dashboards but cannot change app settings.</p>
        <div className="mb-3 space-y-2">
          {(permissions?.consumers ?? []).length === 0 ? (
            <p className="text-xs text-gray-500 italic">No consumers listed.</p>
          ) : (
            (permissions?.consumers ?? []).map((email) => (
              <div key={email} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">Consumer</span>
                  <span className="text-sm text-gray-800">{email}</span>
                </div>
                <button onClick={() => removeConsumer(email)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="user@example.com"
            value={newConsumer}
            onChange={(e) => setNewConsumer(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addConsumer()}
            className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none"
          />
          <button
            onClick={addConsumer}
            disabled={!newConsumer.trim() || saveMutation.isPending}
            className="btn-brand rounded-md px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Add Consumer
          </button>
        </div>
      </div>

      {/* ── Auth Mode Panel ── */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <h4 className="text-sm font-semibold text-gray-900">Query Authentication Mode</h4>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Service Principal
          </div>
        </div>

        <div className="p-5 space-y-4">

          {/* Locked SP banner */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-amber-800">Service Principal only — OAuth disabled</p>
              <p className="text-[11px] text-amber-700">
                All queries run as the app's service principal. OAuth user-identity mode is preserved in the codebase
                but is not active. Grant the SP access to system tables using the button below.
              </p>
            </div>
          </div>

          {/* Current identity */}
          {authLoading ? (
            <div className="h-12 animate-pulse rounded-lg bg-gray-100" />
          ) : authStatus ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 space-y-2">
              <p className="text-xs font-medium text-gray-700">Running as</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
                <StatusRow label="Identity" value="Service Principal (permanent)" ok />
                <StatusRow label="SP email" value={authStatus.user_email ?? "service principal"} />
              </div>
            </div>
          ) : null}

          {/* Re-run SP grants button — always visible, needed after every git deploy */}
          <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 space-y-2">
              <p className="text-xs font-medium text-amber-800">After a git deploy, re-apply SP grants</p>
              <p className="text-[11px] text-amber-700">
                Each git deploy creates a new service principal. Run this (as a metastore or account admin) to
                grant the new SP access to all system tables and the app schema — fixes 0s in dashboards after deploy.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={runSpGrants}
                  disabled={grantRunning}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
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
                  </div>
                )}
              </div>
            </div>

          {/* SP grants reference */}
          {(isSP || noToken) && authStatus && (
            <details className="rounded-lg border border-gray-200 bg-gray-50 text-xs">
              <summary className="cursor-pointer px-4 py-2.5 font-medium text-gray-700 hover:text-gray-900">
                Required SP grants (run as metastore admin)
              </summary>
              <div className="border-t border-gray-200 px-4 py-3 space-y-2">
                {(() => {
                  const spName = authStatus.sp_display_name || authStatus.sp_client_id || "<service-principal>";
                  const userEmail = authStatus.user_email;
                  const principals = userEmail && userEmail !== spName
                    ? `\`${userEmail}\`, \`${spName}\``
                    : `\`${spName}\``;
                  const cat = authStatus.catalog || "<your_catalog>";
                  const sch = authStatus.schema || "<your_schema>";
                  return (
                    <>
                      <p className="text-gray-500 text-[11px]">
                        Grants for <strong>{spName}</strong>{userEmail ? <> and <strong>{userEmail}</strong></> : null}.
                        Run in a SQL editor as metastore admin.
                      </p>
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                        <strong>Note:</strong> Warehouse access cannot be granted via SQL. Grant <strong>CAN USE</strong> to the SP via: SQL Warehouses → [warehouse name] → Permissions tab. The app also grants this automatically on startup.
                      </p>
                      <pre className="rounded bg-gray-900 px-4 py-3 text-[11px] text-green-400 overflow-x-auto leading-relaxed whitespace-pre">{
`-- System tables (billing + query history)
GRANT USE CATALOG ON CATALOG system TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.billing TO ${principals};
GRANT SELECT ON TABLE system.billing.usage TO ${principals};
GRANT SELECT ON TABLE system.billing.list_prices TO ${principals};
GRANT SELECT ON TABLE system.billing.account_prices TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.query TO ${principals};
GRANT SELECT ON TABLE system.query.history TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.compute TO ${principals};
GRANT SELECT ON TABLE system.compute.clusters TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.lakeflow TO ${principals};
GRANT SELECT ON TABLE system.lakeflow.pipelines TO ${principals};

-- App schema (materialized views)
GRANT USE CATALOG ON CATALOG \`${cat}\` TO ${principals};
GRANT USE SCHEMA ON SCHEMA \`${cat}\`.\`${sch}\` TO ${principals};
GRANT CREATE TABLE ON SCHEMA \`${cat}\`.\`${sch}\` TO ${principals};
GRANT SELECT ON SCHEMA \`${cat}\`.\`${sch}\` TO ${principals};`
                      }</pre>
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

function StatusRow({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <>
      <span className="text-gray-500">{label}</span>
      <span className={`font-medium ${ok ? "text-green-700" : warn ? "text-amber-700" : "text-gray-800"}`}>{value}</span>
    </>
  );
}
