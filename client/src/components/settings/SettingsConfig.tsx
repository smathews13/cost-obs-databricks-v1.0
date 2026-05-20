import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppSettings } from "../SettingsDialog";

interface AppConfigInfo {
  warehouse: { id: string; name: string | null; size: string | null; state: string } | null;
  identity: { display_name: string | null; user_name: string | null } | null;
  storage_location: { catalog: string; schema: string } | null;
}

interface TelemetryConfig {
  catalog: string;
  schema_name: string;
  table_prefix: string;
  is_default?: boolean;
}

interface SettingsConfigProps {
  configLoading: boolean;
  appConfig: AppConfigInfo | undefined;
  saveStatus: string | null;
  setSaveStatus: (status: string | null) => void;
  localSettings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onWsPoolSaved?: () => void;
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

export function SettingsConfig({
  configLoading,
  appConfig,
  saveStatus,
  setSaveStatus,
  localSettings,
  updateSetting,
  onWsPoolSaved,
}: SettingsConfigProps) {
  const [mvRefreshing, setMvRefreshing] = useState(false);
  const [lookbackDays, setLookbackDays] = useState(180);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, []);

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
  } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  const { data: telemetry = null, isLoading: telemetryLoading, refetch: refetchTelemetry } = useQuery<TelemetryConfig | null>({
    queryKey: ["settings-telemetry"],
    queryFn: () => fetch("/api/settings/telemetry").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });
  const [telemetryEditing, setTelemetryEditing] = useState(false);
  const [telemetryDraft, setTelemetryDraft] = useState<TelemetryConfig>({ catalog: "", schema_name: "", table_prefix: "" });
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
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
      error?: string;
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
    queryFn: () => fetch("/api/settings/tables").then(r => r.json()).catch(() => null),
    staleTime: 2 * 60 * 1000,
  });

  async function handleMvRefresh() {
    if (mvRefreshing) return;
    const prevRefreshTime = tablesStatus?.refresh_status?.last_refresh_utc ?? null;
    setMvRefreshing(true);
    try {
      await fetch(`/api/settings/refresh-mvs?lookback_days=${lookbackDays}`, { method: "POST" });
    } catch {
      // fire-and-forget — server runs refresh in background
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      const result = await refetchTables();
      const newTime = result.data?.refresh_status?.last_refresh_utc;
      if ((newTime && newTime !== prevRefreshTime) || Date.now() > deadline) {
        clearInterval(pollIntervalRef.current!);
        pollIntervalRef.current = null;
        setMvRefreshing(false);
      }
    }, 30_000);
  }
  // MV wipe state
  const [wipePending, setWipePending] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState<{ ok: boolean; results: Record<string, string> } | null>(null);

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
      refetchTables();
    }
  };

  // Workspace pool management
  const { data: allWorkspacesData } = useQuery<{ workspaces: Array<{ id: string; name: string }>; error?: string } | null>({
    queryKey: ["setup-list-workspaces"],
    queryFn: () => fetch("/api/setup/list-workspaces").then(r => r.json()).catch(() => null),
    staleTime: 5 * 60 * 1000,
  });
  const { data: wsFilterData, refetch: refetchWsFilter } = useQuery<{ workspace_ids: string[] } | null>({
    queryKey: ["setup-workspace-filter"],
    queryFn: () => fetch("/api/setup/workspace-filter").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });
  const { data: currentUser } = useQuery<{ email: string; name: string; role: string } | null>({
    queryKey: ["user-me"],
    queryFn: () => fetch("/api/user/me").then(r => r.json()).catch(() => null),
    staleTime: 5 * 60 * 1000,
  });
  const isAdmin = !currentUser || currentUser.role === "admin";

  const [wsPoolEditing, setWsPoolEditing] = useState(false);
  const [wsPoolDraft, setWsPoolDraft] = useState<string[]>([]);
  const [wsPoolSaving, setWsPoolSaving] = useState(false);
  const [wsPoolSaveStatus, setWsPoolSaveStatus] = useState<string | null>(null);
  const [wsPoolSearch, setWsPoolSearch] = useState("");

  const saveWsPool = async () => {
    setWsPoolSaving(true);
    setWsPoolSaveStatus(null);
    const t0 = performance.now();
    try {
      const res = await fetch("/api/setup/save-workspace-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_ids: wsPoolDraft }),
        signal: AbortSignal.timeout(8_000),
      });
      const elapsed = Math.round(performance.now() - t0);
      if (res.ok) {
        console.info(`[ws-pool] saved ${wsPoolDraft.length} ids in ${elapsed}ms`);
        setWsPoolSaveStatus("Saved");
        setWsPoolEditing(false);
        refetchWsFilter();
        setSaveStatus("Workspace filter pool updated — dashboard will refresh");
        setTimeout(() => setSaveStatus(null), 4000);
        onWsPoolSaved?.();
      } else {
        let detail = `HTTP ${res.status}`;
        try { const d = await res.json(); detail = d.detail || detail; } catch { /* ignore */ }
        console.error(`[ws-pool] save failed in ${elapsed}ms — ${detail}`);
        setWsPoolSaveStatus(`Failed: ${detail}`);
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        console.error(`[ws-pool] timed out after ${elapsed}ms — server did not respond within 8s`);
        setWsPoolSaveStatus("Timed out after 8s — check server logs");
      } else {
        console.error(`[ws-pool] network error after ${elapsed}ms —`, err);
        setWsPoolSaveStatus("Save failed — network error");
      }
    } finally {
      setWsPoolSaving(false);
      setTimeout(() => setWsPoolSaveStatus(null), 6000);
    }
  };

  const [genieCreating, setGenieCreating] = useState(false);
  const [genieCreateStatus, setGenieCreateStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const genieCreateStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const createGenieSpace = async () => {
    setGenieCreating(true);
    setGenieCreateStatus(null);
    try {
      const res = await fetch("/api/setup/create-genie-space", { method: "POST" });
      const data = await res.json();
      if (data.space_id) {
        updateSetting("genieSpaceId", data.space_id);
        updateSetting("enableGenie", true);
        setGenieCreateStatus({ type: "success", message: `Genie Space created (${data.space_id})` });
      } else if (data.status === "already_exists") {
        updateSetting("genieSpaceId", data.space_id || "");
        updateSetting("enableGenie", true);
        setGenieCreateStatus({ type: "success", message: "Using existing Genie Space" });
      } else {
        setGenieCreateStatus({ type: "error", message: data.message || "Failed to create Genie Space" });
      }
    } catch {
      setGenieCreateStatus({ type: "error", message: "Request failed — check server logs" });
    } finally {
      setGenieCreating(false);
      if (genieCreateStatusTimer.current) clearTimeout(genieCreateStatusTimer.current);
      genieCreateStatusTimer.current = setTimeout(() => setGenieCreateStatus(null), 6000);
    }
  };

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
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">SQL Warehouse</h4>
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Fixed at deploy time</span>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              {appConfig?.warehouse ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-2 w-2 rounded-full ${appConfig.warehouse.state === "RUNNING" ? "bg-green-500" : appConfig.warehouse.state === "STOPPED" ? "bg-gray-400" : "bg-yellow-500"}`} />
                    <span className="text-sm font-medium text-gray-900">{appConfig.warehouse.name || appConfig.warehouse.id}</span>
                    <span className="text-xs text-gray-500">({appConfig.warehouse.size || "—"}) · {appConfig.warehouse.state}</span>
                  </div>
                  <span className="shrink-0 rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: '#FF362120', color: '#FF3621' }}>
                    Active
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
                  placeholder={appConfig?.identity?.display_name || "e.g., Cost Observability"}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Overrides the app name shown in the header. Leave blank to use the default ({appConfig?.identity?.display_name || "service principal name"}).
                </p>
              </div>
              {appConfig?.identity && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-sm text-gray-500">Service Principal</div>
                  <div className="text-sm font-medium text-gray-900">{appConfig.identity.user_name || "—"}</div>
                </div>
              )}
              {authStatus && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-sm text-gray-500">Auth Mode</div>
                  <div className="flex items-center gap-1.5">
                    {authStatus.identity === "user_oauth" ? (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                        <span className="text-sm font-medium text-green-700">User OAuth</span>
                      </>
                    ) : authStatus.locked_to_sp ? (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                        <span className="text-sm font-medium text-amber-700">Service principal (token failed scope check)</span>
                      </>
                    ) : (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                        <span className="text-sm font-medium text-amber-700">Service principal</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Enable AI Features */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">AI Features</h4>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localSettings.enableAIFeatures}
                  onChange={(e) => {
                    updateSetting("enableAIFeatures", e.target.checked);
                    if (!e.target.checked) updateSetting("enableGenie", false);
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">Enable AI Features</div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    Enables AI-powered features across the app, including the Genie Assistant and AI-assisted analysis of cost spikes on the KPIs tab. Disable to turn off all AI capabilities for this deployment.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Genie Assistant */}
          <div className={localSettings.enableAIFeatures ? "" : "opacity-50 pointer-events-none"}>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">Genie Assistant</h4>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localSettings.enableGenie}
                  onChange={(e) => updateSetting("enableGenie", e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900">Enable Genie Assistant</div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    Show the Genie AI assistant on the DBU Overview tab for natural language questions about your cost data.
                  </div>
                </div>
              </label>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Genie Space ID</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localSettings.genieSpaceId}
                    onChange={(e) => updateSetting("genieSpaceId", e.target.value)}
                    placeholder="e.g. 01f0abcd1234..."
                    className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                  />
                  {!localSettings.genieSpaceId && (
                    <button
                      onClick={createGenieSpace}
                      disabled={genieCreating}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-wait whitespace-nowrap transition-colors"
                    >
                      {genieCreating ? "Creating…" : "Auto-Create"}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  Enter an existing Genie Space ID, or click Auto-Create to deploy one automatically using your workspace's billing tables.
                </p>
                {genieCreateStatus && (
                  <div className={`mt-2 rounded-md px-3 py-2 text-xs ${genieCreateStatus.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                    {genieCreateStatus.message}
                  </div>
                )}
              </div>
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
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-500">Catalog</span>
                  <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-xs font-mono font-medium text-orange-800">
                    {catalogInfo?.catalog ?? appConfig?.storage_location?.catalog ?? "—"}
                  </span>
                  <span className="text-gray-300">·</span>
                  <span className="text-xs text-gray-500">Schema</span>
                  <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-xs font-mono font-medium text-orange-800">
                    {catalogInfo?.schema ?? appConfig?.storage_location?.schema ?? "—"}
                  </span>
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
                  onClick={() => refetchTables()}
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
                      const stale = t.days_behind != null && t.days_behind > 1;
                      const missing = t.exists === false && !t.optional;
                      const notConfigured = t.exists === false && t.optional;
                      const unknown = t.exists === null;
                      return (
                        <tr key={t.name} className={missing ? "bg-red-50" : stale ? "bg-amber-50" : ""}>
                          <td className="px-3 py-2 font-mono text-gray-700 flex items-center gap-1.5">
                            {missing ? (
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
                                t.table_type === "Materialized View" ? "bg-blue-50 text-blue-600" :
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
                            ) : t.days_behind === 1 ? (
                              <span className="text-green-600">1d behind</span>
                            ) : t.days_behind <= 3 ? (
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

            {/* Drop all materialized views */}
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-red-800">Drop all materialized views</p>
                  <p className="text-[11px] text-red-600 mt-0.5">
                    Permanently deletes all {6} app-managed tables from your catalog. The dashboard will stop loading until you rebuild.
                  </p>
                </div>
                {!wipePending ? (
                  <button
                    onClick={() => { setWipePending(true); setWipeResult(null); }}
                    className="shrink-0 rounded border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
                  >
                    Drop Tables
                  </button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-red-700 font-medium">Are you sure?</span>
                    <button
                      onClick={handleWipeMVs}
                      disabled={wiping}
                      className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                    >
                      {wiping ? "Dropping…" : "Confirm Drop"}
                    </button>
                    <button
                      onClick={() => setWipePending(false)}
                      className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              {wipeResult && (
                <div className={`mt-2 rounded px-2 py-1.5 text-[11px] ${wipeResult.ok ? "bg-green-50 text-green-700" : "bg-red-100 text-red-700"}`}>
                  {wipeResult.ok
                    ? "All tables dropped. Use Rebuild to recreate them."
                    : `Some tables failed to drop: ${Object.entries(wipeResult.results).filter(([,v]) => v !== "dropped").map(([k]) => k).join(", ")}`}
                </div>
              )}
            </div>
          </div>

          {/* Workspace Pool */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">Workspace Filter Pool</h4>
              {!isAdmin && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0 0v2m0-2h2m-2 0H9m3-4V7a3 3 0 00-6 0v4M5 21h14a2 2 0 002-2v-5a2 2 0 00-2-2H5a2 2 0 00-2 2v5a2 2 0 002 2z" />
                  </svg>
                  Admin only
                </span>
              )}
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
              <p className="text-xs text-gray-500">
                Control which workspaces appear in the dashboard workspace filter dropdown. Non-admins can still use the dropdown — this setting only controls which workspaces are available to choose from.
              </p>
              {!wsPoolEditing ? (
                <div className="flex items-center justify-between">
                  <div className="text-xs text-gray-700">
                    {wsFilterData?.workspace_ids?.length
                      ? <span>{wsFilterData.workspace_ids.length} workspace{wsFilterData.workspace_ids.length !== 1 ? "s" : ""} in filter pool</span>
                      : <span className="text-gray-400">All workspaces (no filter configured)</span>
                    }
                  </div>
                  {isAdmin ? (
                    <button
                      onClick={() => {
                        setWsPoolDraft(wsFilterData?.workspace_ids ?? []);
                        setWsPoolEditing(true);
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded px-2 py-0.5"
                    >
                      Edit
                    </button>
                  ) : (
                    <span className="text-[10px] text-gray-400 italic">Contact an admin to change</span>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-600 font-medium">Select available workspaces</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setWsPoolDraft((allWorkspacesData?.workspaces ?? []).map(w => w.id))}
                        className="text-xs text-gray-500 hover:text-gray-800"
                      >All</button>
                      <span className="text-gray-300">·</span>
                      <button
                        onClick={() => setWsPoolDraft([])}
                        className="text-xs text-gray-500 hover:text-gray-800"
                      >None</button>
                    </div>
                  </div>
                  {(allWorkspacesData?.workspaces ?? []).length > 5 && (
                    <input
                      type="text"
                      value={wsPoolSearch}
                      onChange={e => setWsPoolSearch(e.target.value)}
                      placeholder="Search workspaces…"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                    />
                  )}
                  <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-gray-100 p-2">
                    {(allWorkspacesData?.workspaces ?? [])
                      .filter(ws => !wsPoolSearch || (ws.name || ws.id).toLowerCase().includes(wsPoolSearch.toLowerCase()))
                      .map(ws => (
                      <label key={ws.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={wsPoolDraft.includes(ws.id)}
                          onChange={() => {
                            if (wsPoolDraft.includes(ws.id)) {
                              setWsPoolDraft(wsPoolDraft.filter(i => i !== ws.id));
                            } else {
                              setWsPoolDraft([...wsPoolDraft, ws.id]);
                            }
                          }}
                          className="h-3.5 w-3.5 rounded border-gray-300 accent-[#FF3621]"
                        />
                        <span className="text-xs text-gray-700">{ws.name || ws.id}</span>
                      </label>
                    ))}
                    {(allWorkspacesData?.workspaces ?? []).length === 0 && (
                      <p className="py-2 text-center text-[11px] text-gray-400">No workspaces found</p>
                    )}
                    {(allWorkspacesData?.workspaces ?? []).length > 0 &&
                      wsPoolSearch &&
                      (allWorkspacesData?.workspaces ?? []).filter(ws => (ws.name || ws.id).toLowerCase().includes(wsPoolSearch.toLowerCase())).length === 0 && (
                      <p className="py-2 text-center text-[11px] text-gray-400">No workspaces match "{wsPoolSearch}"</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 pt-1">
                    {wsPoolSaveStatus && (
                      <span className={`text-[11px] font-medium ${wsPoolSaveStatus === "Saved" ? "text-green-600" : "text-red-600"}`}>
                        {wsPoolSaveStatus}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveWsPool}
                        disabled={wsPoolSaving}
                        className="flex items-center gap-1.5 rounded bg-[#FF3621] px-3 py-1 text-xs font-medium text-white hover:bg-[#e02e1a] disabled:opacity-60"
                      >
                        {wsPoolSaving && (
                          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                          </svg>
                        )}
                        {wsPoolSaving ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => { setWsPoolEditing(false); setWsPoolSaveStatus(null); }}
                        disabled={wsPoolSaving}
                        className="rounded px-3 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* App Telemetry */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <h4 className="text-sm font-semibold text-gray-900">App Telemetry</h4>
                <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">OpenTelemetry</span>
              </div>
              {!telemetryEditing && !telemetryLoading && (
                <button
                  onClick={() => {
                    setTelemetryDraft({ catalog: telemetry?.catalog ?? "", schema_name: telemetry?.schema_name ?? "", table_prefix: telemetry?.table_prefix ?? "" });
                    setTelemetryError(null);
                    setTelemetryEditing(true);
                  }}
                  className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Set prefix
                </button>
              )}
            </div>

            {/* What is OTel telemetry */}
            <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
              <p className="text-xs font-medium text-gray-900">How Databricks Apps telemetry works</p>
              <p className="text-[11px] text-gray-600 leading-relaxed">
                Databricks Apps automatically collects OpenTelemetry (OTel) data from every app and writes it to Delta tables in your Unity Catalog.
                This is handled entirely by the <strong>Databricks Apps platform</strong> — the app itself does not write these tables.
              </p>
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { table: "otel_spans", label: "Traces", desc: "HTTP request spans, latency, endpoints hit, response codes, errors" },
                  { table: "otel_metrics", label: "Metrics", desc: "CPU/memory usage, request rates, active connections, queue depth" },
                  { table: "otel_logs", label: "Logs", desc: "Structured log lines from uvicorn and all Python loggers" },
                ].map(({ table, label, desc }) => (
                  <div key={table} className="rounded border border-gray-200 bg-white px-2.5 py-2 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
                      <code className="text-[10px] font-mono font-semibold text-gray-700">{table}</code>
                    </div>
                    <p className="text-[10px] font-medium text-gray-700">{label}</p>
                    <p className="text-[10px] text-gray-500 leading-snug">{desc}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-600 pt-1">
                <strong>Different from Storage:</strong> The Storage section above shows tables <em>this app creates</em> (materialized views of system.billing data). The OTel tables are created by Databricks and contain telemetry about the app itself — not cost data.
              </p>
            </div>

            {/* Location — shared with Storage Location picker */}
            <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-gray-500">Location</span>
                <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-xs font-mono font-medium text-orange-800">
                  {catalogInfo?.catalog ?? appConfig?.storage_location?.catalog ?? "—"}
                </span>
                <span className="text-gray-300">·</span>
                <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-xs font-mono font-medium text-orange-800">
                  {catalogInfo?.schema ?? appConfig?.storage_location?.schema ?? "—"}
                </span>
                <span className="text-[10px] text-gray-400">(shared with app storage)</span>
              </div>
              {/* Table prefix — still configurable independently */}
              {telemetryEditing ? (
                <div className="space-y-2 pt-1 border-t border-gray-100">
                  <div className="flex items-center gap-2">
                    <label className="w-14 text-xs text-gray-500 shrink-0">Prefix</label>
                    <input
                      type="text"
                      value={telemetryDraft.table_prefix}
                      onChange={e => setTelemetryDraft(d => ({ ...d, table_prefix: e.target.value }))}
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                      placeholder="optional, e.g. cost_obs_"
                    />
                    <span className="text-[10px] text-gray-500 shrink-0">→ {telemetryDraft.table_prefix || ""}otel_spans</span>
                  </div>
                  {telemetryError && <p className="text-xs text-red-500">{telemetryError}</p>}
                  <div className="flex items-center gap-2">
                    <button
                      disabled={telemetrySaving}
                      onClick={async () => {
                        setTelemetryError(null);
                        setTelemetrySaving(true);
                        try {
                          const res = await fetch("/api/settings/telemetry", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              catalog: catalogInfo?.catalog ?? "",
                              schema_name: catalogInfo?.schema ?? "",
                              table_prefix: telemetryDraft.table_prefix,
                            }),
                          });
                          if (!res.ok) {
                            const d = await res.json().catch(() => ({}));
                            setTelemetryError(d.detail || "Save failed");
                          } else {
                            setTelemetryEditing(false);
                            await refetchTelemetry();
                            await refetchTables();
                          }
                        } finally {
                          setTelemetrySaving(false);
                        }
                      }}
                      className="rounded bg-[#FF3621] px-3 py-1 text-xs font-medium text-white hover:bg-[#e02e1a] disabled:opacity-50"
                    >
                      {telemetrySaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => { setTelemetryEditing(false); setTelemetryError(null); }}
                      className="rounded px-3 py-1 text-xs text-gray-500 hover:bg-gray-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : telemetry?.table_prefix ? (
                <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                  <span className="text-xs text-gray-500">Prefix</span>
                  <span className="rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">{telemetry.table_prefix}</span>
                  <span className="text-[10px] text-gray-400">→ {telemetry.table_prefix}otel_spans</span>
                </div>
              ) : null}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
