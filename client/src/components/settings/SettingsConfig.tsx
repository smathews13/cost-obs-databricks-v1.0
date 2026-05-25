import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "../SettingsDialog";
import { READINESS_QUERY_KEY } from "@/hooks/useFeatureAvailability";

interface AppConfigInfo {
  warehouse: { id: string; name: string | null; size: string | null; state: string; source?: "app_resource" | "http_path" | "none" } | null;
  identity: { display_name: string | null; user_name: string | null } | null;
  storage_location: { catalog: string; schema: string; catalog_source?: "env_var" | "default"; schema_source?: "env_var" | "default" } | null;
  version?: { commit_sha: string };
}

interface SettingsConfigProps {
  configLoading: boolean;
  appConfig: AppConfigInfo | undefined;
  saveStatus: string | null;
  localSettings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

function ColWarn({ error, align = "left" }: { error: string; align?: "left" | "right" }) {
  return (
    <span className="group relative inline-block ml-1 cursor-help">
      <svg className="h-3 w-3 text-red-400" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
      <span className={`pointer-events-none invisible absolute ${align === "right" ? "right-0" : "left-0"} top-full z-[9999] mt-1 w-64 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] leading-snug text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100`}>
        {error}
      </span>
    </span>
  );
}

// Module-level — survives tab switches (component unmount/remount)
let _mvRefreshing = false;
let _mvPrevRefreshTime: string | null = null;
let _mvDeadline = 0;
let _mvPollInterval: ReturnType<typeof setInterval> | null = null;
// Active poll callback updated by each mounted component instance
let _mvPollCallback: (() => Promise<void>) | null = null;
// Last rebuild result: null = no recent rebuild, "success"/"partial_error"/"error"
let _mvLastResult: string | null = null;

export function SettingsConfig({
  configLoading,
  appConfig,
  saveStatus,
  localSettings,
  updateSetting,
}: SettingsConfigProps) {
  const queryClient = useQueryClient();
  const [mvRefreshing, setMvRefreshing] = useState(_mvRefreshing);
  const [mvLastResult, setMvLastResult] = useState<string | null>(_mvLastResult);
  const [lookbackDays, setLookbackDays] = useState(180);
  const noCacheRef = useRef(false);

  // Catalog/schema location override
  const { data: catalogInfo = null, isLoading: catalogLoading } = useQuery<{
    catalog: string;
    schema: string;
    source: "env" | "override";
    env_catalog: string;
    env_schema: string;
  } | null>({
    queryKey: ["settings-catalog"],
    queryFn: () => fetch("/api/settings/catalog").then(r => r.json()).catch(() => null),
    staleTime: 30 * 1000,
  });
  const { data: authStatus = null } = useQuery<{
    user_token_active: boolean;
    identity: "user_oauth" | "service_principal";
    locked_to_sp: boolean;
    has_sql_scope: boolean | null;
    sp_display_name?: string;
    sp_client_id?: string;
    sp_user_name?: string;
  } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  const { data: tablesStatus = null, isLoading: tablesLoading, isFetching: tablesFetching, refetch: refetchTables } = useQuery<{
    catalog: string | null;
    schema: string | null;
    auth_error?: string | null;
    refresh_status?: {
      last_refresh_utc: string;
      duration_seconds: number | null;
      hours_since_refresh: number;
      stale: boolean;
      status: string;
      lookback_days?: number | null;
      error?: string;
      refresh_history?: Array<{
        timestamp: string;
        status: string;
        duration_seconds: number;
        lookback_days: number;
        trigger: "manual" | "scheduled";
        error?: string;
      }>;
    } | null;
    tables: Array<{
      name: string;
      table_type: string | null;
      exists: boolean | null;
      optional?: boolean;
      row_count: number | null;
      min_date: string | null;
      max_date: string | null;
      days_behind: number | null;
      owner?: string | null;
      error?: string;
    }>;
  } | null>({
    queryKey: ["settings-tables-status"],
    queryFn: () => {
      const url = noCacheRef.current ? "/api/settings/tables?no_cache=1" : "/api/settings/tables";
      noCacheRef.current = false;
      return fetch(url).then(r => r.json()).catch(() => null);
    },
    staleTime: 2 * 60 * 1000,
  });

  // Register the poll callback on every render so it always has current closures.
  // The module-level interval calls this, so it works even after tab switches.
  _mvPollCallback = async () => {
    noCacheRef.current = true;
    const result = await refetchTables();
    const newTime = result.data?.refresh_status?.last_refresh_utc;
    if ((newTime && newTime !== _mvPrevRefreshTime) || Date.now() > _mvDeadline) {
      if (_mvPollInterval) { clearInterval(_mvPollInterval); _mvPollInterval = null; }
      _mvRefreshing = false;
      setMvRefreshing(false);
      // Capture result status for success/error badge
      const status = result.data?.refresh_status?.status ?? null;
      _mvLastResult = status;
      setMvLastResult(status);
      queryClient.invalidateQueries({ queryKey: READINESS_QUERY_KEY });
      // Auto-dismiss the result badge after 30 seconds
      setTimeout(() => { _mvLastResult = null; setMvLastResult(null); }, 30_000);
    }
  };

  // On mount: if rebuild was running, restart the poll loop with fresh callbacks
  useEffect(() => {
    if (_mvRefreshing && !_mvPollInterval) {
      _mvPollInterval = setInterval(() => _mvPollCallback?.(), 30_000);
    }
    // On unmount: leave module vars intact; clear callback so ticks are no-ops
    return () => { _mvPollCallback = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMvRefresh() {
    if (_mvRefreshing) return;
    _mvPrevRefreshTime = tablesStatus?.refresh_status?.last_refresh_utc ?? null;
    _mvRefreshing = true;
    _mvLastResult = null;
    _mvDeadline = Date.now() + 15 * 60 * 1000;
    setMvRefreshing(true);
    setMvLastResult(null);
    try {
      await fetch(`/api/settings/refresh-mvs?lookback_days=${lookbackDays}`, { method: "POST" });
    } catch {
      // fire-and-forget — server runs refresh in background
    }
    // Clear any old interval, start fresh
    if (_mvPollInterval) clearInterval(_mvPollInterval);
    _mvPollInterval = setInterval(() => _mvPollCallback?.(), 30_000);
  }
  const [spCopied, setSpCopied] = useState(false);

  // MV wipe state
  const [wipePending, setWipePending] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState<{ ok: boolean; results: Record<string, string> } | null>(null);
  const [wipeConfirmText, setWipeConfirmText] = useState("");

  const handleWipeMVs = async () => {
    setWiping(true);
    setWipeResult(null);
    try {
      const res = await fetch("/api/setup/drop-materialized-views", { method: "DELETE" });
      const data = await res.json();
      setWipeResult(data);
    } catch (e) {
      setWipeResult({ ok: false, results: { error: String(e) } });
    } finally {
      setWiping(false);
      setWipePending(false);
      setWipeConfirmText("");
      refetchTables();
      queryClient.invalidateQueries({ queryKey: READINESS_QUERY_KEY });
    }
  };

  // Workspace pool — read-only, set during setup
  const { data: accountInfo } = useQuery<{ account_name: string | null; host: string | null } | null>({
    queryKey: ["billing", "account"],
    queryFn: () => fetch("/api/billing/account").then(r => r.json()).catch(() => null),
    staleTime: Infinity,
  });

  const { data: wsFilterData } = useQuery<{ workspace_ids: string[] } | null>({
    queryKey: ["setup-workspace-filter"],
    queryFn: () => fetch("/api/setup/workspace-filter").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });




  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        Runtime configuration for this app instance.
      </p>

      {saveStatus && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          {saveStatus}
        </div>
      )}

      {configLoading ? (
        <div className="py-8 text-center text-sm text-gray-500">Loading configuration...</div>
      ) : (
        <>
          {/* SQL Warehouse */}
          <div>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">SQL Warehouse</h4>
              {appConfig?.warehouse?.source === "app_resource" && (
                <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600" title="Set via DATABRICKS_WAREHOUSE_ID app resource binding in app.yaml">App resource binding</span>
              )}
              {appConfig?.warehouse?.source === "http_path" && (
                <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600" title="Set via DATABRICKS_HTTP_PATH env var">DATABRICKS_HTTP_PATH</span>
              )}
              {(!appConfig?.warehouse?.source || appConfig.warehouse.source === "none") && (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Fixed at deploy time</span>
              )}
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              {appConfig?.warehouse ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-2 w-2 rounded-full ${appConfig.warehouse.state === "RUNNING" ? "bg-green-500" : appConfig.warehouse.state === "STOPPED" ? "bg-gray-400" : "bg-yellow-500"}`} />
                    <span className="text-sm font-medium text-gray-900">{appConfig.warehouse.name || appConfig.warehouse.id}</span>
                    <span className="text-xs text-gray-500">({appConfig.warehouse.size || "—"}) · {appConfig.warehouse.state}</span>
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-[10px] font-medium text-green-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />Active
                  </span>
                </div>
              ) : (
                <p className="text-sm text-gray-500">No warehouse detected. Set <span className="font-mono text-xs">DATABRICKS_WAREHOUSE_ID</span> via app resource binding or <span className="font-mono text-xs">DATABRICKS_HTTP_PATH</span> in app.yaml.</p>
              )}
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              The warehouse is set via the app resource binding in app.yaml and cannot be changed here. Redeploy with a different resource binding to switch warehouses.
            </p>
          </div>

          {/* App Identity */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">App Identity</h4>
            </div>
            <div className="space-y-2">
              <div className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="text-sm font-medium text-gray-900 mb-1">Display Name</div>
                <input
                  type="text"
                  value={localSettings.appDisplayName}
                  onChange={(e) => updateSetting("appDisplayName", e.target.value)}
                  placeholder={authStatus?.sp_display_name || appConfig?.identity?.display_name || "e.g., Cost Observability"}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Overrides the app name shown in the header. Leave blank to use the default ({authStatus?.sp_display_name || appConfig?.identity?.display_name || "service principal name"}).
                </p>
              </div>
              {(authStatus?.sp_user_name || authStatus?.sp_display_name || appConfig?.identity) && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-sm text-gray-500">Service Principal</div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 border border-green-200 px-3 py-1 text-xs font-semibold text-green-700 font-mono">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
                      {authStatus?.sp_user_name || authStatus?.sp_client_id || appConfig?.identity?.display_name || appConfig?.identity?.user_name || "Service Principal"}
                    </span>
                    <button
                      type="button"
                      title="Copy service principal ID"
                      onClick={() => {
                        navigator.clipboard.writeText(authStatus?.sp_user_name || authStatus?.sp_client_id || appConfig?.identity?.display_name || appConfig?.identity?.user_name || "");
                        setSpCopied(true);
                        setTimeout(() => setSpCopied(false), 2000);
                      }}
                      className="rounded p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                      {spCopied ? (
                        <span className="text-[10px] font-medium text-green-600 px-0.5">Copied!</span>
                      ) : (
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Storage Location & Tables */}
          <div id="storage-location-tables">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">Storage Location & Tables</h4>
            </div>

            {/* Catalog / Schema location — read-only after setup */}
            <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3">
              {catalogLoading ? (
                <div className="text-xs text-gray-500">Loading...</div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500 w-10 shrink-0">Catalog</span>
                    <span className="rounded-md bg-gray-100 border border-gray-200 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">
                      {catalogInfo?.catalog ?? appConfig?.storage_location?.catalog ?? "—"}
                    </span>
                    {appConfig?.storage_location?.catalog_source === "env_var" && (
                      <span className="text-[10px] text-gray-500" title="Set via COST_OBS_CATALOG environment variable">env var</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500 w-10 shrink-0">Schema</span>
                    <span className="rounded-md bg-gray-100 border border-gray-200 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">
                      {catalogInfo?.schema ?? appConfig?.storage_location?.schema ?? "—"}
                    </span>
                    {appConfig?.storage_location?.schema_source === "env_var" && (
                      <span className="text-[10px] text-gray-500" title="Set via COST_OBS_SCHEMA environment variable">env var</span>
                    )}
                  </div>
                  {appConfig?.version?.commit_sha && (
                    <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                      <span className="text-xs text-gray-500 w-10 shrink-0">Deploy</span>
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-600">{appConfig.version.commit_sha}</code>
                      <span className="text-[10px] text-gray-500">git SHA</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Last refresh + Rebuild controls */}
            <div className="flex items-center justify-between mb-2">
              <div>
                {tablesStatus?.refresh_status === null || tablesStatus?.refresh_status === undefined ? (
                  <span className="text-xs text-gray-500">Last refresh: none</span>
                ) : tablesStatus.refresh_status.status === "error" ? (
                  <span className="text-xs text-red-500">Last refresh failed</span>
                ) : tablesStatus.refresh_status.stale ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                    Stale (&gt;26h)
                  </span>
                ) : (
                  <span className="text-xs text-gray-500">
                    {tablesStatus.refresh_status.hours_since_refresh < 1
                      ? "Refreshed <1h ago"
                      : `Refreshed ${tablesStatus.refresh_status.hours_since_refresh}h ago`}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={lookbackDays}
                  onChange={e => setLookbackDays(Number(e.target.value))}
                  disabled={mvRefreshing}
                  className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 bg-white focus:outline-none focus:ring-1 focus:ring-[#FF3621] disabled:opacity-50"
                >
                  <option value={180}>6 months (default)</option>
                  <option value={365}>1 year</option>
                  <option value={730}>2 years</option>
                  <option value={1095}>3 years</option>
                </select>
                <button
                  onClick={() => { noCacheRef.current = true; refetchTables(); }}
                  disabled={mvRefreshing || tablesFetching}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-gray-600 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Refresh table status"
                >
                  <svg className={`h-3.5 w-3.5 ${tablesFetching && !mvRefreshing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Status
                </button>
                <button
                  onClick={handleMvRefresh}
                  disabled={mvRefreshing}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-gray-600 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className={`h-3.5 w-3.5 ${mvRefreshing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {mvRefreshing ? "Rebuilding…" : "Rebuild"}
                </button>
              </div>
            </div>

            {/* Rebuild result badge — shown for 30s after completion */}
            {!mvRefreshing && mvLastResult === "success" && (
              <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-xs text-green-800 flex items-center gap-2">
                <svg className="h-3.5 w-3.5 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span><span className="font-medium">Rebuild complete.</span> All materialized views updated successfully.</span>
                <button onClick={() => { _mvLastResult = null; setMvLastResult(null); }} className="ml-auto text-green-600 hover:text-green-800">✕</button>
              </div>
            )}
            {!mvRefreshing && (mvLastResult === "partial_error" || mvLastResult === "error") && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 flex items-center gap-2">
                <svg className="h-3.5 w-3.5 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <span><span className="font-medium">Rebuild {mvLastResult === "partial_error" ? "partially failed" : "failed"}.</span> Check the error below for details.</span>
                <button onClick={() => { _mvLastResult = null; setMvLastResult(null); }} className="ml-auto text-red-600 hover:text-red-800">✕</button>
              </div>
            )}

            {/* Rebuild error banner */}
            {!mvRefreshing && tablesStatus?.refresh_status?.status && ["error", "partial_error"].includes(tablesStatus.refresh_status.status) && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 flex gap-2 items-start">
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <div>
                  <span className="font-medium">Last rebuild failed</span>
                  {tablesStatus.refresh_status.error && (
                    <p className="mt-0.5 text-red-700">{tablesStatus.refresh_status.error}</p>
                  )}
                </div>
              </div>
            )}

            {/* Auth error banner */}
            {tablesStatus?.auth_error && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 flex gap-2 items-start">
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <span>{tablesStatus.auth_error}</span>
              </div>
            )}

            {/* Table list */}
            {mvRefreshing && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
                <svg className="h-3.5 w-3.5 animate-spin shrink-0 text-[#FF3621]" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Rebuilding materialized views in the background — this may take a few minutes. The tables below will update automatically when complete.
              </div>
            )}
            {tablesLoading ? (
              <div className="py-3 text-center text-xs text-gray-500">Checking tables...</div>
            ) : tablesStatus?.tables?.length ? (
              <div className={`rounded-lg border border-gray-200 overflow-hidden transition-opacity duration-300 ${mvRefreshing ? "opacity-50" : ""}`}>
                <table className="min-w-full divide-y divide-gray-100 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      {[
                        { label: "Table", tip: "Name of the materialized view or app table stored in your catalog", align: "left" },
                        { label: "Type", tip: "Whether this is a materialized view (rebuilt from system tables) or a plain app config table", align: "left" },
                        { label: "Owner", tip: "The Unity Catalog owner of this table — shown in amber if it differs from the current app identity, which may prevent rebuilds", align: "left" },
                        { label: "Rows", tip: "Number of rows currently in the table", align: "right" },
                        { label: "History", tip: "Span of data in the table — the time window between the oldest and newest record", align: "right" },
                        { label: "Retention limit", tip: "Maximum data depth available from the source Databricks system table — data older than this cannot be captured regardless of rebuild window", align: "right" },
                        { label: "Latest date", tip: "The date of the most recent record in the table — data after this date is not yet reflected", align: "right" },
                        { label: "Freshness", tip: "How far behind today the latest date is — 'Today' means the table is current; '29d behind' means the newest record is 29 days old and the table needs a rebuild", align: "right" },
                      ].map(({ label, tip, align }) => (
                        <th key={label} className={`px-3 py-2 text-${align} font-medium text-gray-500`}>
                          <span className="inline-flex items-center gap-1">
                            {label}
                            <span className="relative group">
                              <svg className="h-3 w-3 text-gray-400 cursor-help flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
                                <path fillRule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" clipRule="evenodd" />
                              </svg>
                              <span className={`pointer-events-none invisible absolute ${align === "right" ? "right-0" : "left-0"} top-full z-[9999] mt-1.5 w-56 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] leading-snug text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100`}>
                                {tip}
                              </span>
                            </span>
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {(() => {
                      // Source system table determines effective retention limit.
                      // billing.usage retains ~3yr; query.history retains ~1yr.
                      const RETENTION: Record<string, string> = {
                        daily_usage_summary: "~3yr (billing.usage)",
                        daily_product_breakdown: "~3yr (billing.usage)",
                        daily_workspace_breakdown: "~3yr (billing.usage)",
                        sql_tool_attribution: "~13mo (query.history)",
                        daily_query_stats: "~13mo (query.history)",
                        dbsql_cost_per_query: "~13mo (query.history)",
                      };
                    return tablesStatus.tables.map((t) => {
                      // Billing source data has 1-3 day ingestion lag — flag only if notably stale
                      const veryStale = t.days_behind != null && t.days_behind > 7;
                      const stale = t.days_behind != null && t.days_behind > 4;
                      const missing = t.exists === false && !t.optional;
                      const notConfigured = t.exists === false && t.optional;
                      const unknown = t.exists === null;
                      // Don't show red ✗ while a re-check is in progress — the cached
                      // result may be stale. Show neutral ? until the fetch settles.
                      const showNeutral = tablesFetching;
                      return (
                        <tr key={t.name} className={!showNeutral && missing ? "bg-red-50" : veryStale ? "bg-red-50" : stale ? "bg-amber-50" : ""}>
                          <td className="px-3 py-2 font-mono text-gray-700 flex items-center gap-1.5">
                            {showNeutral ? (
                              <span className="text-gray-300">?</span>
                            ) : missing ? (
                              <span className="text-red-400">✗</span>
                            ) : notConfigured ? (
                              <span className="text-gray-300">–</span>
                            ) : unknown ? (
                              <span className="text-gray-300">?</span>
                            ) : (
                              <span className="text-green-500">✓</span>
                            )}
                            {t.name}
                            {t.error && <ColWarn error={t.error} />}
                          </td>
                          <td className="px-3 py-2 text-gray-500">
                            {t.table_type ? (
                              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                t.table_type === "Materialized View" ? "bg-gray-100 text-gray-600" :
                                t.table_type === "Telemetry" ? "bg-gray-100 text-gray-600" :
                                "bg-gray-100 text-gray-500"
                              }`}>
                                {t.table_type}
                              </span>
                            ) : t.error ? <ColWarn error={t.error} /> : "—"}
                          </td>
                          <td className="px-3 py-2 text-[11px]">
                            {t.owner ? (() => {
                              if (t.owner.toLowerCase() === "unknown") {
                                return <span className="italic text-gray-400" title="Owner could not be resolved by Unity Catalog">unknown</span>;
                              }
                              const currentIdentity = authStatus?.sp_display_name || authStatus?.sp_client_id;
                              const mismatch = !!(currentIdentity && !t.owner.includes(currentIdentity) && !currentIdentity.includes(t.owner));
                              return (
                                <span
                                  className={mismatch ? "text-amber-600 font-medium" : "text-gray-400"}
                                  title={mismatch ? `Owned by a different principal than the current app identity (${currentIdentity}). Rebuild may require explicit permissions.` : t.owner}
                                >
                                  {t.owner.length > 28 ? t.owner.slice(0, 28) + "…" : t.owner}
                                </span>
                              );
                            })() : t.error ? <><span className="text-gray-300">—</span><ColWarn error={t.error} /></> : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                            {t.row_count != null ? t.row_count.toLocaleString() : t.error ? <><span className="text-gray-300">—</span><ColWarn error={t.error} align="right" /></> : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                            {t.min_date && t.max_date ? (() => {
                              const start = new Date(t.min_date.slice(0, 10));
                              const end = new Date(t.max_date.slice(0, 10));
                              const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
                              const years = Math.floor(months / 12);
                              const remMonths = months % 12;
                              if (years > 0 && remMonths > 0) return `${years}yr ${remMonths}mo`;
                              if (years > 0) return `${years}yr`;
                              return `${months}mo`;
                            })() : t.error ? <><span className="text-gray-300">—</span><ColWarn error={t.error} align="right" /></> : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-400 text-[11px]">
                            {RETENTION[t.name] ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-500">
                            {t.max_date ? t.max_date.slice(0, 10) : t.error ? <><span className="text-gray-300">—</span><ColWarn error={t.error} align="right" /></> : "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {t.days_behind == null ? (
                              t.error ? <><span className="text-gray-300">—</span><ColWarn error={t.error} align="right" /></> : <span className="text-gray-300">—</span>
                            ) : t.days_behind === 0 ? (
                              <span className="text-green-600 font-medium">Today</span>
                            ) : t.days_behind <= 3 ? (
                              <span className="text-gray-500">{t.days_behind}d behind</span>
                            ) : t.days_behind <= 7 ? (
                              <span className="text-amber-600 font-medium">{t.days_behind}d behind</span>
                            ) : (
                              <span className="text-red-600 font-medium">{t.days_behind}d behind</span>
                            )}
                          </td>
                        </tr>
                      );
                    })})()}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">Could not retrieve table status</div>
            )}

            {/* Refresh history */}
            {(() => {
              const history = tablesStatus?.refresh_status?.refresh_history;
              if (!history?.length) return null;
              const fmtWindow = (d: number) => {
                if (d === 180) return "6 months";
                if (d === 365) return "1 year";
                if (d === 730) return "2 years";
                if (d === 1095) return "3 years";
                return `${d} days`;
              };
              const fmtDuration = (s: number) => {
                if (s < 60) return `${Math.round(s)}s`;
                return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
              };
              const fmtTs = (ts: string) => {
                try {
                  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
                } catch { return ts; }
              };
              return (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-gray-600">Refresh History</p>
                  <div className="rounded-lg border border-gray-200 overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-100 text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          {(["Date / Time", "Trigger", "Window", "Duration", "Result"] as const).map(h => (
                            <th key={h} className={`px-3 py-2 font-medium text-gray-500 ${h === "Date / Time" || h === "Trigger" ? "text-left" : "text-right"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {[...history].reverse().map((entry, i) => (
                          <tr key={i} className={entry.status === "error" ? "bg-red-50" : entry.status === "partial_error" ? "bg-amber-50" : ""}>
                            <td className="px-3 py-1.5 text-gray-600 font-mono text-[11px]">{fmtTs(entry.timestamp)}</td>
                            <td className="px-3 py-1.5 text-gray-500 capitalize">{entry.trigger}</td>
                            <td className="px-3 py-1.5 text-right text-gray-500">{fmtWindow(entry.lookback_days)}</td>
                            <td className="px-3 py-1.5 text-right text-gray-500 tabular-nums">{fmtDuration(entry.duration_seconds)}</td>
                            <td className="px-3 py-1.5 text-right">
                              {entry.status === "success" ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-[10px] font-medium text-green-700">
                                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />Success
                                </span>
                              ) : entry.status === "partial_error" ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-700" title={entry.error}>
                                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Partial
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 border border-red-200 px-2 py-0.5 text-[10px] font-medium text-red-700" title={entry.error}>
                                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />Error
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Drop all materialized views */}
            {(() => {
              const missingTables = tablesStatus?.tables?.filter(t => t.exists === false && !t.optional) ?? [];
              const isDegraded = missingTables.length > 0;
              // Hard block: degraded state prevents drop entirely, no break-glass path.
              const dropBlocked = isDegraded;
              return (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-red-800">Drop all materialized views</p>
                      <p className="text-[11px] text-red-600 mt-0.5">
                        Permanently deletes all app-managed tables from your catalog. The dashboard will stop loading until you rebuild.
                      </p>
                      {isDegraded && (
                        <p className="mt-1 text-[11px] text-red-700 font-medium">
                          ⚠ {missingTables.length} table{missingTables.length !== 1 ? "s are" : " is"} already missing — dropping in this state will deepen the outage. Fix readiness issues first, or proceed with caution.
                        </p>
                      )}
                    </div>
                    {!wipePending ? (
                      <button
                        onClick={() => { setWipePending(true); setWipeResult(null); setWipeConfirmText(""); }}
                        disabled={dropBlocked}
                        title={dropBlocked ? "System is degraded — fix missing tables before dropping" : undefined}
                        className="shrink-0 rounded border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Drop Tables
                      </button>
                    ) : (
                      <button
                        onClick={() => { setWipePending(false); setWipeConfirmText(""); }}
                        className="shrink-0 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {wipePending && (
                    <div className="mt-3 space-y-2">
                      <p className="text-[11px] font-medium text-red-800">
                        This will permanently delete all app-managed materialized views. Type <code className="rounded bg-red-100 px-1 font-mono">CONFIRM</code> to enable the drop button:
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={wipeConfirmText}
                          onChange={e => setWipeConfirmText(e.target.value)}
                          placeholder="Type CONFIRM"
                          className="w-40 rounded border border-red-300 bg-white px-2 py-1 text-xs font-mono text-red-700 placeholder-red-300 focus:outline-none focus:ring-1 focus:ring-red-400"
                          autoFocus
                        />
                        <button
                          onClick={handleWipeMVs}
                          disabled={wiping || wipeConfirmText !== "CONFIRM"}
                          className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {wiping ? "Dropping…" : "Confirm Drop"}
                        </button>
                      </div>
                    </div>
                  )}

                  {wipeResult && (
                    <div className={`mt-2 rounded px-2 py-1.5 text-[11px] ${wipeResult.ok ? "bg-green-50 text-green-700" : "bg-red-100 text-red-700"}`}>
                      {wipeResult.ok
                        ? "All tables dropped. Use Rebuild to recreate them."
                        : `Some tables failed to drop: ${Object.entries(wipeResult.results).filter(([,v]) => v !== "dropped").map(([k]) => k).join(", ")}`}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Workspace Pool */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">Workspace Filter Pool</h4>
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Set during setup</span>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="text-sm text-gray-700">
                {wsFilterData?.workspace_ids?.length
                  ? <span>{wsFilterData.workspace_ids.length} workspace{wsFilterData.workspace_ids.length !== 1 ? "s" : ""} configured{accountInfo?.account_name ? ` — ${accountInfo.account_name}` : ""}</span>
                  : <span className="text-gray-500">All workspaces (no filter configured){accountInfo?.account_name ? ` — ${accountInfo.account_name}` : ""}</span>
                }
              </div>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              The workspace filter pool is configured during initial setup and cannot be changed here.
            </p>
          </div>

        </>
      )}
    </div>
  );
}
