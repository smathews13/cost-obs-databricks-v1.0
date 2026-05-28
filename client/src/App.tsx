import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { TabRefreshButton } from "@/components/TabRefreshButton";
import { SetupWizard } from "@/components/SetupWizard";
import { SummaryCards } from "@/components/SummaryCards";
import { SpendChart } from "@/components/SpendChart";
import { ProductBreakdown } from "@/components/ProductBreakdown";
import { WorkspaceTable } from "@/components/WorkspaceTable";
import { PipelineObjectsTable } from "@/components/PipelineObjectsTable";
import { DateRangePicker } from "@/components/DateRangePicker";
import { WorkspaceFilter } from "@/components/WorkspaceFilter";
import { SKUBreakdown } from "@/components/SKUBreakdown";
import { ExportDialog, type ExportSections, type ExportFormat } from "@/components/ExportDialog";
import { SettingsDialog, loadTabVisibility, loadAppSettings, type TabVisibility, type AppSettings } from "@/components/SettingsDialog";
import { PricingProvider, usePricing } from "@/context/PricingContext";
import { Footer } from "@/components/Footer";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure.png";
import gcpLogo from "@/assets/gcp.svg";

// Retry a dynamic import once on failure (handles cold-start chunk load errors)
function lazyWithRetry<T>(factory: () => Promise<T>): Promise<T> {
  return factory().catch(() => factory());
}

// Lazy-loaded tab views — chunks download on first render
const InteractiveBreakdown = lazy(() => lazyWithRetry(() => import("@/components/InteractiveBreakdown").then(m => ({ default: m.InteractiveBreakdown }))));
const CloudCostsView = lazy(() => lazyWithRetry(() => import("@/components/CloudCostsView").then(m => ({ default: m.CloudCostsView }))));
const PlatformKPIsView = lazy(() => lazyWithRetry(() => import("@/components/PlatformKPIsView").then(m => ({ default: m.PlatformKPIsView }))));
const AIMLCostCenter = lazy(() => lazyWithRetry(() => import("@/components/AIMLCostCenter").then(m => ({ default: m.AIMLCostCenter }))));
const AppsCostCenter = lazy(() => lazyWithRetry(() => import("@/components/AppsCostCenter").then(m => ({ default: m.AppsCostCenter }))));
const TaggingHub = lazy(() => lazyWithRetry(() => import("@/components/TaggingHub").then(m => ({ default: m.TaggingHub }))));
const SQLWarehousing360 = lazy(() => lazyWithRetry(() => import("@/components/SQLWarehousing360").then(m => ({ default: m.SQLWarehousing360 }))));
const ForecastingView = lazy(() => lazyWithRetry(() => import("@/components/ForecastingView").then(m => ({ default: m.ForecastingView }))));
const ContractBurndown = lazy(() => lazyWithRetry(() => import("@/components/ContractBurndown").then(m => ({ default: m.ContractBurndown }))));
const Alerts = lazy(() => lazyWithRetry(() => import("@/pages/Alerts")));
const UseCases = lazy(() => lazyWithRetry(() => import("@/pages/UseCases")));
const UsersGroups = lazy(() => lazyWithRetry(() => import("@/pages/UsersGroups")));

// Preload all lazy chunks during browser idle time so tab switches are instant.
// React.lazy caches the promise, so these import() calls prime the module cache
// before the component ever renders.
function preloadTabChunks() {
  import("@/components/InteractiveBreakdown");
  import("@/components/CloudCostsView");
  import("@/components/PlatformKPIsView");
  import("@/components/AIMLCostCenter");
  import("@/components/AppsCostCenter");
  import("@/components/TaggingHub");
  import("@/components/SQLWarehousing360");
  import("@/components/ForecastingView");
  import("@/components/ContractBurndown");
  import("@/pages/Alerts");
  import("@/pages/UseCases");
  import("@/pages/UsersGroups");
}

if (typeof window !== "undefined") {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(preloadTabChunks, { timeout: 5000 });
  } else {
    setTimeout(preloadTabChunks, 2000);
  }
}
import {
  useAccountInfo,
  useAWSActualCosts,
  useAzureActualCosts,
  useGCPActualCosts,
  useDashboardBundleFast,
  useSqlBreakdown,
  usePipelineObjects,
  useInteractiveBreakdown,
  useSKUBreakdown,
  useDefaultDateRange,
  useAIMLDashboardBundle,
  useAppsDashboardBundle,
  useTaggingDashboardBundle,
  useDBSQLQueryCosts,
  useDBSQLTopQueries,
  useInfraBundle,
  useKPIsBundle,
  useUsersGroupsBundle,
} from "@/hooks/useBillingData";
import type { DateRange, WorkspaceBreakdown } from "@/types/billing";
import { generateCostReport } from "@/utils/pdfExport";
import { generateCostCSV } from "@/utils/csvExport";

// Keep the Databricks Apps pod warm while the tab is open.
// Cold starts take 30s–1min; a lightweight ping every 4 min prevents idle suspension.
function useKeepAlive() {
  useEffect(() => {
    const ping = () => fetch("/api/ping", { method: "GET" }).catch(() => {});
    const interval = setInterval(ping, 4 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") ping(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

type ViewTab = "dbu" | "sql" | "infra" | "kpis" | "aiml" | "apps" | "tagging" | "use-cases" | "alerts" | "forecasting" | "users-groups" | "contract";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 60 * 1000, // 30 minutes - data doesn't change often
      gcTime: 60 * 60 * 1000, // 1 hour cache
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

interface User {
  email: string;
  name: string;
  role?: "admin" | "consumer";
}

function AccountPricingBanner() {
  const { useAccountPrices, discountPercent, skuCount, available } = usePricing();
  if (!useAccountPrices) return null;
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: '#10B981' }}>
      <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {available
        ? `Account prices active — ${discountPercent.toFixed(1)}% discount applied across ${skuCount} SKUs (from system.billing.account_prices)`
        : "Account prices mode active — system.billing.account_prices not available, showing list prices"}
    </div>
  );
}

function SpGrantsBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem("coc-sp-grants-dismissed") === "1");

  const { data: authStatus } = useQuery<{ user_token_active: boolean; identity: string } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60_000,
  });

  const spMode = authStatus && !authStatus.user_token_active && authStatus.identity === "service_principal";

  const { data: billingAccess } = useQuery<{ ok: boolean; reason?: string; warehouse_id?: string; sp_client_id?: string } | null>({
    queryKey: ["settings-billing-access"],
    queryFn: () => fetch("/api/settings/billing-access").then(r => r.json()).catch(() => null),
    staleTime: 5 * 60_000,
    enabled: !!spMode,
  });

  const isWarehouseIssue = billingAccess?.reason === "warehouse_access";
  const isGrantsIssue = billingAccess?.reason === "grants_missing";

  if (dismissed || !spMode || !billingAccess || billingAccess.ok !== false || (!isWarehouseIssue && !isGrantsIssue)) return null;

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 bg-amber-50 border-b border-amber-200">
      <div className="flex items-center gap-2 min-w-0">
        <svg className="h-4 w-4 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        {isWarehouseIssue ? (
          <span className="text-xs text-amber-800">
            <strong>SP missing warehouse access</strong> — the service principal{billingAccess.sp_client_id ? ` (${billingAccess.sp_client_id})` : ""} cannot use the SQL warehouse.
            A workspace admin must run:{" "}
            <code className="rounded bg-amber-100 px-1 font-mono">
              GRANT CAN_USE ON WAREHOUSE {billingAccess.warehouse_id || "<warehouse_id>"} TO `{billingAccess.sp_client_id || "<sp_client_id>"}`
            </code>
          </span>
        ) : (
          <span className="text-xs text-amber-800">
            <strong>SP grants missing</strong> — the service principal lacks system table access after the last git deploy.
            Re-run the Permissions setup to restore access.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => { onOpenSettings(); }}
          className="text-xs font-medium px-3 py-1.5 rounded"
          style={{ background: "#FF3621", color: "#fff" }}
        >
          {isWarehouseIssue ? "Open Settings → Permissions" : "Re-run Permissions"}
        </button>
        <button
          onClick={() => { sessionStorage.setItem("coc-sp-grants-dismissed", "1"); setDismissed(true); }}
          className="text-xs text-amber-600 hover:text-amber-800 px-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function Dashboard() {
  useKeepAlive();
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);
  const defaultRange = useDefaultDateRange(appSettings.defaultDateRangeDays);
  const [dateRange, setDateRange] = useState<DateRange>(defaultRange);
  const [activeTab, setActiveTab] = useState<ViewTab>("dbu");
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [tabVisibility, setTabVisibility] = useState<TabVisibility>(loadTabVisibility);
  // true = show wizard, false = show dashboard.
  // Default to false — the status check flips it to true only if setup is genuinely
  // needed. Starting false prevents the wizard from flashing on container restart
  // (where .settings/ is wiped but the DBFS flag returns "ready" within ~2 s).
  const [showSetupWizard, setShowSetupWizard] = useState<boolean>(false);
  // Set when user closes wizard without completing — shows the incomplete banner on dashboard.
  const [setupIncomplete, setSetupIncomplete] = useState(false);
  // Stored so onLaunchWizard can abort the in-flight status check and prevent it from
  // overriding the manually-triggered wizard with a stale "ready" response.
  const setupStatusAbortRef = useRef<AbortController | null>(null);
  const rqClient = useQueryClient();

  const handleTabRefresh = async () => {
    await rqClient.cancelQueries();
    // Await cache clear so server-side cache is empty before any query fires
    await fetch("/api/cache/clear", { method: "POST" }).catch(() => {});
    // refetchQueries bypasses enabled:false — forces all tab-gated queries to fetch too
    await rqClient.refetchQueries({ type: "all" });
  };

  // On every load, verify setup status with the server.
  // 60s timeout — allows for cold App pod start.
  useEffect(() => {
    const controller = new AbortController();
    setupStatusAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const prevCompleted = () =>
      localStorage.getItem("coc-setup-complete") === "true" ||
      sessionStorage.getItem("coc-setup-complete") === "true";

    fetch("/api/setup/status", { signal: controller.signal })
      .then((r) => r.json())
      .then((status) => {
        clearTimeout(timeout);
        if (status?.status === "ready") {
          localStorage.setItem("coc-setup-complete", "true");
          sessionStorage.setItem("coc-setup-complete", "true");
          setShowSetupWizard(false);
        } else if (status?.status === "setup_required") {
          // Only show wizard on a definitive "setup_required" — not on transient states
          // like "initializing". Avoids wizard flash during cold start or mid-build polling.
          // Only clear local cache on explicit setup_required so Safari Private Mode
          // users don't lose their fallback if they briefly lose connectivity.
          if (!prevCompleted()) {
            localStorage.removeItem("coc-setup-complete");
            sessionStorage.removeItem("coc-setup-complete");
            setShowSetupWizard(true);
          }
          // If they have a local completion record, trust it — they're a returning user
          // and the server may be in a transient state (redeploy, DBFS slow).
        }
        // "initializing" and other transient states: no wizard change
      })
      .catch(() => {
        clearTimeout(timeout);
        // Network error, timeout, or non-JSON — trust local cache rather than flashing wizard.
        // This is the primary Safari fix: first-party cookies may not be sent on the
        // initial fetch in Safari's strict mode, causing a redirect instead of JSON.
        if (!prevCompleted()) {
          setShowSetupWizard(true);
        }
      });

    return () => { clearTimeout(timeout); controller.abort(); };
  }, []);

  const handleSetupComplete = () => {
    localStorage.setItem("coc-setup-complete", "true");
    sessionStorage.setItem("coc-setup-complete", "true");
    // Mark setup complete server-side (survives page refresh, cleared on redeploy)
    fetch("/api/setup/complete", { method: "POST" }).catch(() => {});
    // Save the deploying user as admin (fire-and-forget)
    fetch("/api/setup/bootstrap-admin", { method: "POST" }).catch(() => {});
    setShowSetupWizard(false);
    rqClient.invalidateQueries();
  };

  // On first load after each new deploy, reset all info banner minimize flags so users
  // see best-practice guidance at least once. After that, their collapse preference persists.
  useEffect(() => {
    const BANNER_RESET_VERSION = "2026-03-12";
    const BANNER_RESET_KEY = "coc-banner-reset-v";
    if (localStorage.getItem(BANNER_RESET_KEY) !== BANNER_RESET_VERSION) {
      [
        "cost-obs-minimize-tagging-info",
        "cost-obs-minimize-sql-info",
        "cost-obs-minimize-infra-info",
        "cost-obs-minimize-aiml-info",
        "cost-obs-minimize-kpis-info",
      ].forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(BANNER_RESET_KEY, BANNER_RESET_VERSION);
    }
  }, []);

  // Trigger cache prewarm immediately on mount (runs while permissions dialog is shown)
  useEffect(() => {
    fetch("/api/prewarm", { method: "POST" }).catch(() => {
      // Ignore errors - prewarm is best-effort
    });
  }, []);

  // Auto-refresh interval based on settings
  useEffect(() => {
    if (appSettings.refreshIntervalMinutes <= 0) return;
    const interval = setInterval(() => {
      rqClient.invalidateQueries();
    }, appSettings.refreshIntervalMinutes * 60 * 1000);
    return () => clearInterval(interval);
  }, [appSettings.refreshIntervalMinutes, rqClient]);

  // Compact mode - toggle CSS class on root
  useEffect(() => {
    document.documentElement.classList.toggle("compact-mode", appSettings.compactMode);
  }, [appSettings.compactMode]);

  // Dark mode - toggle CSS class on root
  useEffect(() => {
    document.documentElement.classList.toggle("dark-mode", appSettings.darkMode);
  }, [appSettings.darkMode]);

  const { data: user } = useQuery<User>({
    queryKey: ["user"],
    queryFn: async () => {
      const response = await fetch("/api/user/me");
      if (!response.ok) throw new Error("Failed to fetch user");
      return response.json();
    },
  });

  const { data: accountInfo } = useAccountInfo();

  const { data: authStatus } = useQuery<{
    user_token_active: boolean;
    identity: "user_oauth" | "service_principal";
    locked_to_sp: boolean;
    has_sql_scope: boolean | null;
    sp_client_id?: string;
    sp_display_name?: string;
    sp_user_name?: string;
  } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  // Detect cloud from browser URL instantly (no API call needed)
  const detectedCloudFromUrl = useMemo(() => {
    const host = window.location.hostname.toLowerCase();
    if (host.includes("azure") || host.includes(".azure.")) return "AZURE";
    if (host.includes(".gcp.") || host.includes("gcp.databricks")) return "GCP";
    return "AWS";
  }, []);

  const { applyPricing, multiplier: pricingMultiplier } = usePricing();

  // Central warehouse warming poller — single source of truth for warehouse state.
  // Polls every 5s while warming_up, backs off to 60s once warm.
  const { data: warehouseStatus } = useQuery<{ status: "warm" | "warming_up" | "unavailable"; state?: string }>({
    queryKey: ["health", "sql-warehouse"],
    queryFn: () => fetch("/api/health/sql-warehouse").then(r => r.ok ? r.json() : { status: "warm" }),
    refetchInterval: (query) => (!query.state.data || query.state.data.status === "warming_up") ? 5000 : 60000,
    staleTime: 0,
  });
  const warehouseWarming = warehouseStatus?.status === "warming_up";

  // Fast bundle for quick initial load (uses materialized views)
  const { data: bundle, isLoading: bundleLoading } = useDashboardBundleFast(dateRange, selectedWorkspaceIds.length ? selectedWorkspaceIds : undefined);

  // Extract data from fast bundle — apply pricing multiplier when account prices are active
  const summary = useMemo(() => {
    const s = bundle?.summary;
    if (!s || pricingMultiplier === 1.0) return s;
    return {
      ...s,
      total_spend: applyPricing(s.total_spend ?? 0),
      total_dbus: s.total_dbus, // DBUs don't scale with price
    };
  }, [bundle?.summary, pricingMultiplier, applyPricing]);

  const products = useMemo(() => {
    const p = bundle?.products;
    if (!p || pricingMultiplier === 1.0) return p;
    return {
      ...p,
      products: p.products?.map((prod) => ({
        ...prod,
        total_spend: applyPricing(prod.total_spend ?? 0),
      })),
    };
  }, [bundle?.products, pricingMultiplier, applyPricing]);

  const workspaces = useMemo(() => {
    const w = bundle?.workspaces;
    if (!w || pricingMultiplier === 1.0) return w;
    return {
      ...w,
      workspaces: w.workspaces?.map((ws) => ({
        ...ws,
        total_spend: applyPricing(ws.total_spend ?? 0),
      })),
    };
  }, [bundle?.workspaces, pricingMultiplier, applyPricing]);

  const workspaceNameMap = useMemo(() =>
    workspaces?.workspaces?.reduce((m: Record<string, string>, w: WorkspaceBreakdown) => {
      m[w.workspace_id] = w.workspace_name || w.workspace_id;
      return m;
    }, {} as Record<string, string>) ?? {}
  , [workspaces?.workspaces]);

  const timeseries = useMemo(() => {
    const t = bundle?.timeseries;
    if (!t || pricingMultiplier === 1.0) return t;
    return {
      ...t,
      timeseries: t.timeseries?.map((row) => {
        const scaled: typeof row = { ...row };
        for (const key of Object.keys(row)) {
          if (key !== "date" && typeof row[key] === "number") {
            scaled[key] = applyPricing(row[key] as number);
          }
        }
        return scaled;
      }),
    };
  }, [bundle?.timeseries, pricingMultiplier, applyPricing]);

  const _wsIds = selectedWorkspaceIds.length ? selectedWorkspaceIds : undefined;

  // DBU tab sub-queries: pipelines, interactive, SKU are account-wide → always preload.
  // sqlBreakdown fires in parallel with bundle — not gated so workspace filter changes don't stall it.
  const { data: sqlBreakdown, isLoading: sqlLoading } = useSqlBreakdown(dateRange, _wsIds, true);
  const { data: pipelineObjects, isLoading: pipelineLoading } = usePipelineObjects(dateRange, _wsIds, true);
  const { data: interactiveBreakdown, isLoading: interactiveLoading } = useInteractiveBreakdown(dateRange, _wsIds, true);
  const { data: skuBreakdown, isLoading: skuLoading } = useSKUBreakdown(dateRange, _wsIds, true);

  // All tabs preload eagerly — backend delta_cache returns instantly on hits.
  // asyncio.to_thread on the server ensures concurrent requests don't block each other.
  const { data: infraBundle, isLoading: infraBundleLoading } = useInfraBundle(dateRange, _wsIds, true);
  const infraCosts = infraBundle?.infra_costs;
  const infraCostsTimeseries = infraBundle?.infra_timeseries;

  const { data: kpisBundle, isLoading: kpisBundleLoading, isFetching: kpisBundleFetching } = useKPIsBundle(dateRange, _wsIds, true);
  const spendAnomalies = kpisBundle?.anomalies;
  const platformKPIs = kpisBundle?.kpis;
  const anomaliesLoading = kpisBundleLoading;
  const kpisLoading = kpisBundleLoading;

  const { data: aimlData, isLoading: aimlLoading } = useAIMLDashboardBundle(dateRange, _wsIds, true);
  const { data: appsData, isLoading: appsLoading } = useAppsDashboardBundle(dateRange, _wsIds, true);
  const { data: taggingData, isLoading: taggingLoading } = useTaggingDashboardBundle(dateRange, _wsIds, true);

  // Cloud actual costs — no workspace filter; always preload
  const { data: awsActualData, isLoading: awsActualLoading } = useAWSActualCosts(dateRange, true);
  const { data: azureActualData, isLoading: azureActualLoading } = useAzureActualCosts(dateRange, true);
  const { data: gcpActualData, isLoading: gcpActualLoading } = useGCPActualCosts(dateRange, true);

  const { data: dbsqlData, isLoading: dbsqlLoading, isFetching: dbsqlFetching } = useDBSQLQueryCosts(dateRange, _wsIds, true);
  const { data: dbsqlTopQueriesData, isLoading: dbsqlTopQueriesLoading } = useDBSQLTopQueries(dateRange, _wsIds, true);
  const { data: usersGroupsData } = useUsersGroupsBundle(dateRange, _wsIds, true);

  // Use Cases tab data - only fetch when feature is enabled
  const useCasesEnabled = appSettings.enableUseCaseTracking;
  useQuery({ queryKey: ["use-cases"], queryFn: async () => { const r = await fetch("/api/use-cases/use-cases?status=active"); if (!r.ok) throw new Error("Failed"); return r.json(); }, enabled: useCasesEnabled });
  const { data: useCasesSummaryData } = useQuery({ queryKey: ["use-cases-summary"], queryFn: async () => { const r = await fetch("/api/use-cases/analytics/summary"); if (!r.ok) throw new Error("Failed"); return r.json(); }, enabled: useCasesEnabled });
  useQuery({ queryKey: ["monthly-consumption"], queryFn: async () => { const r = await fetch("/api/use-cases/monthly-consumption"); if (!r.ok) throw new Error("Failed"); return r.json(); }, enabled: useCasesEnabled });
  useQuery({ queryKey: ["available-tags"], queryFn: async () => { const r = await fetch("/api/tagging/available-tags"); if (!r.ok) return { tags: {}, count: 0 }; return r.json(); } });

  // Alerts tab data - prefetch immediately on app load for fast tab switching
  const { data: alertsData } = useQuery({ queryKey: ["alerts", "recent", 30], queryFn: async () => { const r = await fetch("/api/alerts/recent?days_back=30"); if (!r.ok) throw new Error("Failed"); return r.json(); } });
  useQuery({ queryKey: ["alerts", "databricks"], queryFn: async () => { const r = await fetch("/api/alerts/databricks-alerts"); if (!r.ok) throw new Error("Failed"); return r.json(); } });

  // Workspace list for the filter dropdown — pool-scoped, independent of the bundle.
  const { data: wsListData, isLoading: wsListLoading } = useQuery<{ workspaces: { id: string; name: string }[] }>({
    queryKey: ["billing", "workspaces"],
    queryFn: () => fetch("/api/billing/workspaces").then(r => r.json()),
    staleTime: Infinity,
  });
  const wsFilterList = (wsListData?.workspaces ?? []).map(w => ({ workspace_id: w.id, workspace_name: w.name }));

  // Settings data — all prefetched in the background after the main bundle loads.
  // `enabled` gates each query on `!!bundle` so settings requests don't race the
  // critical-path billing queries on cold start.
  const _settingsReady = !!bundle;
  useQuery({ queryKey: ["user-permissions"],      enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/user-permissions"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["app-config"],             enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/config"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  // settings-install-report: same endpoint as app-config but separate key used by SettingsDebugger
  useQuery({ queryKey: ["settings-install-report"], enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/config"); return r.ok ? r.json() : null; }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["warehouses"],             enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/warehouses"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["cloud-provider"],         enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/cloud-provider"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 30 * 60 * 1000 });
  useQuery({ queryKey: ["cloud-connections"],      enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/cloud-connections"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["settings-account-prices"], enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/account-prices"); return r.ok ? r.json() : { available: false, prices: [], source: null, count: 0 }; }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["settings-catalog"],       enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/catalog"); return r.ok ? r.json() : null; }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["settings-auth-status"],   enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/auth-status"); return r.ok ? r.json() : null; }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["settings-schedule"],      enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/settings/schedule"); return r.ok ? r.json() : null; }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["setup-workspace-filter"], enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/setup/workspace-filter"); return r.ok ? r.json() : null; }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["billing", "account"],     enabled: _settingsReady, queryFn: async () => { const r = await fetch("/api/billing/account"); return r.ok ? r.json() : null; }, staleTime: Infinity });
  // settings-tables-status is NOT pre-fetched — it runs SQL against every app table
  // and returns stale false-negatives if it fires before the background MV build completes.

  // Memoize infra data transformations to avoid re-creating arrays on every render
  const infraViewData = useMemo(() => infraCosts ? {
    clusters: (infraCosts.clusters || []).map(c => ({
      cluster_id: c.cluster_id,
      cluster_name: c.cluster_name,
      driver_instance_type: c.driver_instance_type,
      worker_instance_type: c.worker_instance_type,
      cluster_source: c.cluster_source,
      total_dbu_hours: c.total_dbu_hours,
      days_active: c.days_active,
      percentage: c.percentage,
      workspace_id: (c as any).workspace_id || "",
      state: null,
      estimated_aws_cost: c.estimated_cost,
    })),
    instance_families: infraCosts.instance_families,
    total_estimated_cost: infraCosts.total_estimated_cost,
    total_dbu_hours: infraCosts.total_dbu_hours,
    billing_summary: (infraCosts as any).billing_summary,
    start_date: infraCosts.start_date,
    end_date: infraCosts.end_date,
    disclaimer: infraCosts.disclaimer,
    error: infraCosts.error,
  } : undefined, [infraCosts]);

  const infraViewTimeseries = useMemo(() => infraCostsTimeseries ? {
    timeseries: (infraCostsTimeseries.timeseries || []).map(t => ({
      date: t.date,
      "AWS Cost": t["Infrastructure Cost"],
    })),
    categories: ["AWS Cost"],
    start_date: infraCostsTimeseries.start_date,
    end_date: infraCostsTimeseries.end_date,
  } : undefined, [infraCostsTimeseries]);

  const handleExport = (sections: ExportSections, format: ExportFormat) => {
    const workspaceFilter = _wsIds?.length
      ? { ids: _wsIds, names: _wsIds.map((id: string) => workspaceNameMap[id] || id) }
      : { ids: [] };

    if (format === "csv") {
      generateCostCSV(
        {
          summary,
          products,
          workspaces,
          skus: skuBreakdown,
          pipelineObjects,
          interactiveBreakdown,
          aiml: aimlData,
          apps: appsData,
          tagging: taggingData,
          users: usersGroupsData,
          alerts: alertsData,
          query360: dbsqlData,
        },
        sections,
        { start: dateRange.startDate, end: dateRange.endDate },
        workspaceFilter
      );
      return;
    }
    handleExportPDF(sections, workspaceFilter);
  };

  const handleExportPDF = (sections: ExportSections, workspaceFilter?: { ids: string[]; names?: string[] }) => {
    generateCostReport(
      {
        summary,
        products,
        workspaces,
        skus: skuBreakdown,
        anomalies: spendAnomalies,
        pipelineObjects,
        interactiveBreakdown,
        awsCosts: infraCosts ? {
          clusters: (infraCosts.clusters ?? []).map(c => ({
            cluster_id: c.cluster_id,
            cluster_name: c.cluster_name,
            driver_instance_type: c.driver_instance_type,
            worker_instance_type: c.worker_instance_type,
            cluster_source: c.cluster_source,
            total_dbu_hours: c.total_dbu_hours,
            days_active: c.days_active,
            percentage: c.percentage,
            workspace_id: (c as any).workspace_id || "",
            state: null,
            estimated_aws_cost: c.estimated_cost,
          })),
          instance_families: infraCosts.instance_families,
          total_estimated_cost: infraCosts.total_estimated_cost,
          total_dbu_hours: infraCosts.total_dbu_hours,
          start_date: infraCosts.start_date,
          end_date: infraCosts.end_date,
          disclaimer: infraCosts.disclaimer,
          error: infraCosts.error,
        } : undefined,
        aiml: aimlData,
        apps: appsData,
        tagging: taggingData,
        platformKPIs,
        query360: dbsqlData,
        users: usersGroupsData,
        useCases: useCasesSummaryData,
        alerts: alertsData,
        dateRange: {
          start: dateRange.startDate,
          end: dateRange.endDate,
        },
        workspaceFilter,
      },
      sections
    );
  };

  if (showSetupWizard) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: '#F9F7F4' }}>
        <SetupWizard
          onComplete={handleSetupComplete}
          onClose={() => { setShowSetupWizard(false); setSetupIncomplete(true); }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: appSettings.darkMode ? '#1B1F23' : '#F9F7F4' }}>
      {/* Setup incomplete banner — non-dismissable, shown when wizard was closed without finishing */}
      {setupIncomplete && (
        <div className="flex items-center justify-between gap-4 px-4 py-2.5 border-b" style={{ backgroundColor: '#FFF7ED', borderColor: '#FED7AA' }}>
          <div className="flex items-center gap-2 min-w-0">
            <svg className="h-4 w-4 shrink-0 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span className="text-xs font-medium text-orange-800">
              Setup incomplete — materialized views have not been created. Data may be slower or incomplete.
            </span>
          </div>
          <button
            onClick={() => {
              setSetupIncomplete(false);
              fetch("/api/setup/rerun", { method: "POST" }).catch(() => {});
              setShowSetupWizard(true);
            }}
            className="shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold text-white transition-colors"
            style={{ backgroundColor: '#FF3621' }}
          >
            Resume Setup
          </button>
        </div>
      )}

      {/* Warehouse warming banner */}
      {warehouseWarming && (
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-blue-50 border-blue-200">
          <div className="h-3 w-3 animate-pulse rounded-full bg-blue-400" />
          <span className="text-xs font-medium text-blue-800">
            SQL Warehouse is starting up — dashboard data will load shortly.
          </span>
        </div>
      )}

      {/* Sticky top chrome: navy account bar + white title/tabs */}
      <div className="sticky top-0 z-30 shadow">
      {/* Account Info Banner */}
      <div className="text-white" style={{ backgroundColor: '#1B3139' }}>
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="white">
                  <path d="M20 4H4L7 8L4 12H20L17 8L20 4Z" opacity="0.9"/>
                  <path d="M20 8H4L7 12L4 16H20L17 12L20 8Z" opacity="0.7"/>
                  <path d="M20 12H4L7 16L4 20H20L17 16L20 12Z" opacity="0.5"/>
                </svg>
                <span className="text-sm opacity-75">Databricks Account</span>
              </div>
              <div className="flex items-center gap-3">
                <img
                  src={detectedCloudFromUrl === "AZURE" ? azureLogo : detectedCloudFromUrl === "GCP" ? gcpLogo : awsLogo}
                  alt={detectedCloudFromUrl}
                  className="h-5 w-5 object-contain"
                />
                {accountInfo ? (
                  <>
                    {accountInfo.account_name && (
                      <div className="flex flex-col leading-none">
                        <span className="text-[9px] font-medium uppercase tracking-wide opacity-50">Account</span>
                        <span className="mt-0.5 max-w-[120px] truncate rounded px-2 py-0.5 text-[10px] font-medium text-white/90" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
                          {accountInfo.account_name}
                        </span>
                      </div>
                    )}
                    {wsListLoading ? (
                      <div className="flex flex-col leading-none">
                        <span className="text-[9px] font-medium uppercase tracking-wide opacity-50">Workspace</span>
                        <div className="mt-0.5 h-5 w-24 animate-pulse rounded" style={{ backgroundColor: "rgba(255,255,255,0.15)" }} />
                      </div>
                    ) : wsFilterList.length > 0 ? (
                      <div className="flex flex-col leading-none">
                        <span className="text-[9px] font-medium uppercase tracking-wide opacity-50">
                          {(selectedWorkspaceIds.length === 0 ? wsFilterList.length : selectedWorkspaceIds.length) > 1 ? "Workspaces" : "Workspace"}
                        </span>
                        <div className="flex items-center gap-1 mt-0.5">
                          {selectedWorkspaceIds.length === 0 ? (
                            // All workspaces selected — show names if pool ≤ 2, else "All"
                            wsFilterList.length <= 2
                              ? wsFilterList.map((w) => {
                                  const lbl = w.workspace_name || w.workspace_id;
                                  return (
                                    <span
                                      key={w.workspace_id}
                                      title={lbl}
                                      className="max-w-[150px] truncate rounded px-2 py-0.5 text-[10px] font-medium text-white/90"
                                      style={{ backgroundColor: "rgba(255,255,255,0.15)" }}
                                    >
                                      {lbl}
                                    </span>
                                  );
                                })
                              : (
                                <span
                                  className="rounded px-2 py-0.5 text-[10px] font-medium text-white/90"
                                  style={{ backgroundColor: "rgba(255,255,255,0.15)" }}
                                >
                                  All
                                </span>
                              )
                          ) : selectedWorkspaceIds.length <= 2
                            ? selectedWorkspaceIds.map((id) => {
                                const ws = wsFilterList.find((w) => w.workspace_id === id);
                                const lbl = ws?.workspace_name || id;
                                return (
                                  <span
                                    key={id}
                                    title={lbl}
                                    className="max-w-[150px] truncate rounded px-2 py-0.5 text-[10px] font-medium text-white/90"
                                    style={{ backgroundColor: "rgba(255,255,255,0.15)" }}
                                  >
                                    {lbl}
                                  </span>
                                );
                              })
                            : (
                              <span
                                className="rounded px-2 py-0.5 text-[10px] font-medium text-white/90"
                                style={{ backgroundColor: "rgba(255,255,255,0.15)" }}
                              >
                                {selectedWorkspaceIds.length} workspaces
                              </span>
                            )
                          }
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="text-sm opacity-75">Loading account info...</span>
                )}
              </div>
            </div>
            {user && (
              <div className="flex items-center gap-2">
                {authStatus && authStatus.identity !== "user_oauth" && (
                  <>
                    {authStatus.sp_display_name && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] font-semibold text-green-200" title={authStatus.sp_display_name}>
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                        <span className="font-mono">{authStatus.sp_display_name.slice(0, 8)}</span>
                        <span className="opacity-60">ID</span>
                      </span>
                    )}
                    {(authStatus.sp_user_name || authStatus.sp_client_id) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] font-semibold text-green-200" title={authStatus.sp_user_name || authStatus.sp_client_id}>
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                        <span className="font-mono">{(authStatus.sp_user_name || authStatus.sp_client_id || "").slice(0, 8)}</span>
                        <span className="opacity-60">SP</span>
                      </span>
                    )}
                  </>
                )}
                <span className="text-sm opacity-90">
                  {user.email}
                </span>
                {user.role && (
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${user.role === "admin" ? "bg-white/20 text-white" : "bg-white/10 text-white/70"}`}>
                    {user.role === "admin" ? "Admin" : "Consumer"}
                  </span>
                )}
                <button
                  onClick={() => setShowSettings(true)}
                  className="rounded-md p-1.5 text-white opacity-75 transition-opacity hover:opacity-100 hover:bg-white/10"
                  title="App Settings"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowExportDialog(true)}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white opacity-75 transition-opacity hover:opacity-100 hover:bg-white/10 border border-white/20"
                  title="Export"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <AccountPricingBanner />
      <SpGrantsBanner onOpenSettings={() => setShowSettings(true)} />

      <header className="bg-white">
        <div className="mx-auto max-w-7xl px-4 pt-8 pb-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-3 items-center gap-4">
            <div>
              <h1
                className="text-3xl font-black tracking-wide text-gray-900 cursor-pointer hover:opacity-75 transition-opacity"
                style={{ fontFamily: "'Orbitron', sans-serif" }}
                onClick={() => setActiveTab("dbu")}
                title="Back to $DBU Spend"
              >
                COST-OBS
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                $DBU mission control + analytics center{appSettings.companyName ? ` for ${appSettings.companyName}'s Databricks spend` : ""}
              </p>
            </div>
            <div className="flex justify-center items-center gap-3">
              <DateRangePicker value={dateRange} onChange={setDateRange} />
              <WorkspaceFilter
                workspaces={wsFilterList}
                selectedIds={selectedWorkspaceIds}
                onChange={setSelectedWorkspaceIds}
                isLoading={wsListLoading}
              />
            </div>
            <div />
          </div>
          {/* Tab Navigation */}
          <div className="mt-4 border-b border-gray-200 overflow-x-auto overflow-y-hidden">
            <nav className="-mb-px flex justify-center space-x-4 min-w-max">
              {tabVisibility.dbu && (
              <button
                onClick={() => setActiveTab("dbu")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "dbu"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 4H4L7 8L4 12H20L17 8L20 4Z" opacity="0.9"/>
                  <path d="M20 8H4L7 12L4 16H20L17 12L20 8Z" opacity="0.7"/>
                  <path d="M20 12H4L7 16L4 20H20L17 16L20 12Z" opacity="0.5"/>
                </svg>
                $DBU Spend
              </button>
              )}
              {tabVisibility.sql && (
              <button
                onClick={() => setActiveTab("sql")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "sql"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
                SQL
              </button>
              )}
              {tabVisibility.aiml && (
              <button
                onClick={() => setActiveTab("aiml")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "aiml"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                AI/ML
              </button>
              )}
              {tabVisibility.apps && (
              <button
                onClick={() => setActiveTab("apps")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "apps"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
                Apps
              </button>
              )}
              {tabVisibility.tagging && (
              <button
                onClick={() => setActiveTab("tagging")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "tagging"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                Tagging
              </button>
              )}
              {tabVisibility["users-groups"] && (
              <button
                onClick={() => setActiveTab("users-groups")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "users-groups"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                Users
              </button>
              )}
              {tabVisibility.kpis && (
              <button
                onClick={() => setActiveTab("kpis")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "kpis"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                KPIs & Trends
              </button>
              )}
              {tabVisibility.infra && (
              <button
                onClick={() => setActiveTab("infra")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "infra"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
                Cloud Costs
              </button>
              )}
            </nav>
          </div>
        </div>
      </header>
      </div>{/* end sticky top chrome */}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div key={activeTab} className="animate-fade-in relative">
          {/* Per-tab refresh button — top-right corner, across from each tab's title.
              Hidden on infra (cloud costs) tab. */}
          {activeTab !== "infra" && (
            <div className="absolute right-0 top-1 z-20">
              <TabRefreshButton onRefresh={handleTabRefresh} />
            </div>
          )}
        <Suspense fallback={
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
            <p className="text-sm text-gray-500">Loading...</p>
          </div>
        }>
        {activeTab === "dbu" ? (
          bundleLoading ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
              <p className="text-sm text-gray-500">Loading DBU spend data...</p>
            </div>
          ) : (
          <TabErrorBoundary tabName="$DBU Spend">
          <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
                <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 4H4L7 8L4 12H20L17 8L20 4Z" opacity="0.9"/>
                  <path d="M20 8H4L7 12L4 16H20L17 12L20 8Z" opacity="0.7"/>
                  <path d="M20 12H4L7 16L4 20H20L17 16L20 12Z" opacity="0.5"/>
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">$DBU Spend</h1>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm text-gray-500">Databricks Unit consumption and cost breakdown</p>
                  {_wsIds && _wsIds.length > 0 && (
                    <span className="rounded bg-[#1B3139]/10 px-2 py-0.5 text-[10px] font-medium text-[#1B3139]">
                      {_wsIds.length === 1 ? (workspaceNameMap[_wsIds[0]] || _wsIds[0]) : `${_wsIds.length} workspaces`}
                    </span>
                  )}
                </div>
              </div>
            </div>


            <SummaryCards
              data={summary}
              isLoading={bundleLoading}
              startDate={dateRange.startDate}
              endDate={dateRange.endDate}
              workspaceIds={_wsIds}
            />

            <SpendChart data={timeseries} isLoading={bundleLoading} />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <ProductBreakdown data={products} isLoading={bundleLoading} workspaces={workspaces?.workspaces} dateRange={dateRange} />
              <SKUBreakdown data={skuBreakdown} isLoading={skuLoading} workspaces={workspaces?.workspaces} dateRange={dateRange} />
            </div>

            <WorkspaceTable data={workspaces} isLoading={bundleLoading} host={accountInfo?.host} />

            <InteractiveBreakdown data={interactiveBreakdown} isLoading={interactiveLoading} host={accountInfo?.host} />

            <PipelineObjectsTable data={pipelineObjects} isLoading={pipelineLoading} host={accountInfo?.host} />
          </div>
          </TabErrorBoundary>
          )
        ) : activeTab === "infra" ? (
          <TabErrorBoundary tabName="Cloud Costs">
          <CloudCostsView
            data={infraViewData}
            isLoading={infraBundleLoading}
            timeseriesData={infraViewTimeseries}
            timeseriesLoading={infraBundleLoading}
            host={accountInfo?.host}
            actualData={awsActualData}
            actualLoading={awsActualLoading}
            azureActualData={azureActualData}
            azureActualLoading={azureActualLoading}
            gcpActualData={gcpActualData}
            gcpActualLoading={gcpActualLoading}
            infraData={infraCosts}
            infraLoading={infraBundleLoading}
            infraTimeseriesData={infraCostsTimeseries}
            infraTimeseriesLoading={infraBundleLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            detectedCloud={accountInfo?.cloud || undefined}
            workspaceNameMap={workspaceNameMap}
            workspaceIds={_wsIds}
          />
          </TabErrorBoundary>
        ) : activeTab === "kpis" ? (
          <TabErrorBoundary tabName="KPIs & Trends">
          <PlatformKPIsView
            data={platformKPIs}
            isLoading={kpisLoading}
            isFetching={kpisBundleFetching}
            spendAnomalies={spendAnomalies}
            anomaliesLoading={anomaliesLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "aiml" ? (
          <TabErrorBoundary tabName="AI/ML">
          <AIMLCostCenter
            data={aimlData}
            isLoading={aimlLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            host={accountInfo?.host}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "apps" ? (
          <TabErrorBoundary tabName="Apps">
          <AppsCostCenter
            data={appsData}
            isLoading={appsLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            dateRange={dateRange}
            enableHostingComparison={appSettings.enableAppHostingComparison}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "tagging" ? (
          <TabErrorBoundary tabName="Tagging">
          <TaggingHub
            data={taggingData}
            isLoading={taggingLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "sql" ? (
          <TabErrorBoundary tabName="SQL">
          <SQLWarehousing360
            sqlBreakdownData={sqlBreakdown}
            queryData={dbsqlData}
            isLoading={sqlLoading || dbsqlLoading || dbsqlFetching}
            topQueriesData={dbsqlTopQueriesData}
            topQueriesLoading={dbsqlTopQueriesLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "use-cases" ? (
          <TabErrorBoundary tabName="Use Cases"><UseCases /></TabErrorBoundary>
        ) : activeTab === "alerts" ? (
          <TabErrorBoundary tabName="Alerts"><Alerts /></TabErrorBoundary>
        ) : activeTab === "forecasting" ? (
          <TabErrorBoundary tabName="Forecasting">
          <ForecastingView
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
          />
          </TabErrorBoundary>
        ) : activeTab === "users-groups" ? (
          <TabErrorBoundary tabName="Users">
          <UsersGroups
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            dateRange={dateRange}
            anonymizeUsers={appSettings.anonymizeUsers}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "contract" ? (
          <TabErrorBoundary tabName="Contract">
          <ContractBurndown />
          </TabErrorBoundary>
        ) : null}
        </Suspense>
        </div>
      </main>

      <Footer />

      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        onExport={handleExport}
        tabVisibility={{
          ...tabVisibility,
          "use-cases": tabVisibility["use-cases"] && appSettings.enableUseCaseTracking,
          alerts: tabVisibility.alerts && appSettings.enableAlerts,
          forecasting: tabVisibility.forecasting && appSettings.enableForecasting,
        }}
      />

      <SettingsDialog
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        tabVisibility={tabVisibility}
        appSettings={appSettings}
        onTabVisibilityChange={(v) => {
          setTabVisibility(v);
          // If the active tab was hidden, switch to the first visible tab.
          // "contract" is not in TabVisibility (it's purely settings-gated), so skip the check for it.
          if (activeTab !== "contract" && !v[activeTab as keyof typeof v]) {
            const firstVisible = (Object.keys(v) as ViewTab[]).find((k) => v[k as keyof typeof v]);
            if (firstVisible) setActiveTab(firstVisible);
          }
        }}
        onSettingsChange={setAppSettings}
      />
    </div>
  );
}

class TabErrorBoundary extends React.Component<
  { children: React.ReactNode; tabName?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-8 rounded-lg bg-white border " style={{ borderColor: '#E5E5E5' }}>
          <div className="text-3xl mb-3">⚠️</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">
            {this.props.tabName ? `${this.props.tabName} encountered an error` : "Something went wrong"}
          </h3>
          <p className="text-sm text-gray-500 text-center max-w-md mb-4">
            This may happen when data is loading or system tables are not accessible. Other tabs should still work.
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: '#FF3621' }}
          >
            Try Again
          </button>
          <details className="mt-4 text-xs text-gray-500">
            <summary className="cursor-pointer">Error details</summary>
            <pre className="mt-2 whitespace-pre-wrap">{this.state.error.message}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: "sans-serif", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
          <h1 style={{ color: "#f97316", marginBottom: 16 }}>Something went wrong</h1>
          <p style={{ color: "#94a3b8", marginBottom: 24 }}>The app encountered an error. This usually happens when data is still loading or system tables are not accessible.</p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ padding: "10px 24px", background: "#f97316", color: "#000", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, marginBottom: 24 }}
          >
            Reload App
          </button>
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer", color: "#64748b" }}>Error details</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#64748b", marginTop: 8 }}>
              {this.state.error.message}
              {"\n\n"}
              {this.state.error.stack}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <PricingProvider>
          <Dashboard />
        </PricingProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
