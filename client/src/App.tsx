import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from "react";
import { flushSync } from "react-dom";
import {
  QueryClient,
  QueryClientProvider,
  useIsFetching,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { TabRefreshRegion } from "@/components/TabRefreshRegion";
import { SetupWizard } from "@/components/SetupWizard";
import { SummaryCards } from "@/components/SummaryCards";
import { SpendChart } from "@/components/SpendChart";
import { ProductBreakdown } from "@/components/ProductBreakdown";
import { WorkspaceTable } from "@/components/WorkspaceTable";
import { PipelineObjectsTable } from "@/components/PipelineObjectsTable";
import { DateRangePicker } from "@/components/DateRangePicker";
import { WorkspaceFilter } from "@/components/WorkspaceFilter";
import { SourceLabelFilter } from "@/components/SourceLabelFilter";
import { SKUBreakdown } from "@/components/SKUBreakdown";
import {
  ExportDialog,
  type ExportFormat,
} from "@/components/ExportDialog";
import {
  getRequiredExportTabs,
  type ExportSections,
} from "@/utils/exportDemand";
import { PricingProvider } from "@/context/PricingContext";
import { usePricing } from "@/context/pricingState";
import { SpNameMapContext } from "@/utils/identity";
import { Footer } from "@/components/Footer";
import { UserMenu } from "@/components/UserMenu";
import { DeploymentBadgeFromApi } from "@/components/DeploymentBadge";
import { applyInfraPricing } from "@/utils/cloudCosts";
import {
  WarehouseGuidanceBanner,
  WarehouseHealthCheckBanner,
} from "@/components/WarehouseGuidanceBanner";
import { Bot, Check, Copy, Settings } from "lucide-react";
import type {
  WarehouseHealthData,
  WarehouseIdleTimeData,
} from "@/components/SQLWarehousing360";

// Retry a dynamic import on failure. First retry handles transient network blips.
// If the second attempt also fails (stale deployment: browser has old index.html with
// outdated chunk hashes that 404 after a redeploy), force a hard page reload to pick up
// the new assets. A sessionStorage flag prevents reload loops if assets are genuinely broken.
function lazyWithRetry<T>(factory: () => Promise<T>): Promise<T> {
  return factory().catch(() =>
    factory().catch((err) => {
      if (!sessionStorage.getItem("_chunk_reload")) {
        sessionStorage.setItem("_chunk_reload", "1");
        window.location.reload();
      }
      throw err;
    })
  );
}

// Lazy-loaded tab views: chunks download on first render
const InteractiveBreakdown = lazy(() => lazyWithRetry(() => import("@/components/InteractiveBreakdown").then(m => ({ default: m.InteractiveBreakdown }))));
const CloudCostsView = lazy(() => lazyWithRetry(() => import("@/components/CloudCostsView").then(m => ({ default: m.CloudCostsView }))));
const PlatformKPIsView = lazy(() => lazyWithRetry(() => import("@/components/PlatformKPIsView").then(m => ({ default: m.PlatformKPIsView }))));
const AIMLCostCenter = lazy(() => lazyWithRetry(() => import("@/components/AIMLCostCenter").then(m => ({ default: m.AIMLCostCenter }))));
const AppsCostCenter = lazy(() => lazyWithRetry(() => import("@/components/AppsCostCenter").then(m => ({ default: m.AppsCostCenter }))));
const TaggingHub = lazy(() => lazyWithRetry(() => import("@/components/TaggingHub").then(m => ({ default: m.TaggingHub }))));
const SQLWarehousing360 = lazy(() => lazyWithRetry(() => import("@/components/SQLWarehousing360").then(m => ({ default: m.SQLWarehousing360 }))));
const WarehouseRightsizingView = lazy(() => lazyWithRetry(() => import("@/components/SQLWarehousing360").then(m => ({ default: m.WarehouseRightsizingView }))));
const WarehouseIdleTimeView = lazy(() => lazyWithRetry(() => import("@/components/SQLWarehousing360").then(m => ({ default: m.WarehouseIdleTimeView }))));
const OptimizeMethodologyPanel = lazy(() => lazyWithRetry(() => import("@/components/SQLWarehousing360").then(m => ({ default: m.OptimizeMethodologyPanel }))));
const UsersGroups = lazy(() => lazyWithRetry(() => import("@/pages/UsersGroups")));
const SettingsDialog = lazy(() => lazyWithRetry(() => import("@/components/SettingsDialog").then(m => ({ default: m.SettingsDialog }))));

import {
  useAccountInfo,
  useCloudCostsBundle,
  useDashboardBundleFast,
  useSqlBreakdown,
  usePipelineObjects,
  useInteractiveBreakdown,
  useSKUBreakdown,
  getDefaultDateRange,
  useAIMLDashboardBundle,
  useAppsDashboardBundle,
  useTaggingDashboardBundle,
  useDBSQLQueryCosts,
  useDBSQLTopQueries,
  useKPIsBundle,
  useUsersGroupsBundle,
  buildFilteredUrl,
  getActiveSourceLabels,
  getActiveSourceRouting,
  getActiveSourceScopeKey,
  setActiveSourceLabels,
  setActiveSourceRouting,
  setActiveSourceTables,
  responsePayloadIssue,
  setIncludeHistoricalWorkspaceData,
} from "@/hooks/useBillingData";
import type { DateRange, WorkspaceBreakdown } from "@/types/billing";
import { generateCostCSV } from "@/utils/csvExport";
import { downloadArchitecturePdf } from "@/utils/architectureDownload";
import { C } from "@/theme";
import { CostObsLockup, VersionPill, PageHero, InfoPanel } from "@/components/brand";
import { LoadingPanels, Spinner } from "@/components/Spinner";
import {
  buildExportScopeKey,
  clearTabDemandRefreshPhases,
  createTabDemandState,
  isTabDemandUnresolved,
  isTabProducerActive,
  queueTabDemand,
  requeueTabDemand,
  settleTabDemand,
  type TabDemandRefreshPhase,
} from "@/utils/tabDemand";
import {
  isDashboardQuery,
  isQueryOwnedByTab,
  removeInactiveDashboardScopeData,
  refreshSourceScopeData,
  refreshTabData,
  startScopedAutoRefresh,
  TAB_LOADING_SECTIONS,
} from "@/utils/tabRefresh";
import {
  WAREHOUSE_WARM_SESSION_KEY,
  fetchWarehouseHealth,
  nextWarehouseWarmState,
  shouldGateDashboard,
  shouldShowDbuSkeleton,
  shouldRequestWarehouseProbe,
  warehouseHealthPollInterval,
  type WarehouseHealth,
} from "@/utils/warehouseGuidance";
import { useTransientScrollbarBehavior } from "@/utils/scrolling";
import {
  hydrateSettingsFromServer,
  loadAppSettings,
  loadTabVisibility,
  persistAppSettings,
  persistTabVisibility,
  settingsAreEqual,
  tabVisibilityIsEqual,
  type AppSettings,
  type TabVisibility,
  type UnifiedSettings,
} from "@/utils/settingsHydration";

// Keep the Databricks Apps pod warm while the tab is open.
// Cold starts take 30s to 1min; a lightweight ping every 4 min prevents idle suspension.
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

type ViewTab = keyof TabVisibility;

function useTabFetchingMap(): Record<ViewTab, boolean> {
  const dbu = useIsFetching({ predicate: (query) => isQueryOwnedByTab("dbu", query.queryKey) });
  const sql = useIsFetching({ predicate: (query) => isQueryOwnedByTab("sql", query.queryKey) });
  const aiml = useIsFetching({ predicate: (query) => isQueryOwnedByTab("aiml", query.queryKey) });
  const apps = useIsFetching({ predicate: (query) => isQueryOwnedByTab("apps", query.queryKey) });
  const tagging = useIsFetching({ predicate: (query) => isQueryOwnedByTab("tagging", query.queryKey) });
  const users = useIsFetching({ predicate: (query) => isQueryOwnedByTab("users-groups", query.queryKey) });
  const kpis = useIsFetching({ predicate: (query) => isQueryOwnedByTab("kpis", query.queryKey) });
  const infra = useIsFetching({ predicate: (query) => isQueryOwnedByTab("infra", query.queryKey) });
  const optimizer = useIsFetching({ predicate: (query) => isQueryOwnedByTab("optimizer", query.queryKey) });
  return {
    dbu: dbu > 0,
    sql: sql > 0,
    aiml: aiml > 0,
    apps: apps > 0,
    tagging: tagging > 0,
    "users-groups": users > 0,
    kpis: kpis > 0,
    infra: infra > 0,
    optimizer: optimizer > 0,
  };
}

const DASHBOARD_TABS: Array<{ id: ViewTab; label: string; icon: React.ReactNode }> = [
  {
    id: "dbu",
    label: "DBU Overview",
    icon: <span className="mr-1.5 -mt-0.5 inline-flex h-4 items-center justify-center font-mono text-base font-bold">$</span>,
  },
  {
    id: "sql",
    label: "SQL",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" /></svg>,
  },
  {
    id: "aiml",
    label: "AI/ML",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
  },
  {
    id: "apps",
    label: "Apps",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>,
  },
  {
    id: "tagging",
    label: "Tagging",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>,
  },
  {
    id: "users-groups",
    label: "Users",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656-.126-1.283-.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>,
  },
  {
    id: "kpis",
    label: "KPIs & Trends",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>,
  },
  {
    id: "infra",
    label: "Cloud Costs",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>,
  },
  {
    id: "optimizer",
    label: "Optimize",
    icon: <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>,
  },
];

export function DashboardTabNavigation({
  activeTab,
  visibility,
  loading,
  onChange,
}: {
  activeTab: ViewTab;
  visibility: TabVisibility;
  loading?: Partial<Record<ViewTab, boolean>>;
  onChange: (tab: ViewTab) => void;
}) {
  const tabRefs = useRef<Partial<Record<ViewTab, HTMLButtonElement | null>>>({});
  const visibleTabs = DASHBOARD_TABS.filter(({ id }) => visibility[id]);

  const moveFocus = (current: ViewTab, key: string) => {
    const currentIndex = visibleTabs.findIndex(({ id }) => id === current);
    if (currentIndex < 0) return;
    let nextIndex: number;
    if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = visibleTabs.length - 1;
    else if (key === "ArrowRight") nextIndex = (currentIndex + 1) % visibleTabs.length;
    else if (key === "ArrowLeft") nextIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
    else return;

    const nextTab = visibleTabs[nextIndex].id;
    onChange(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  return (
    <div className="mt-4 overflow-x-auto overflow-y-hidden" style={{ borderBottom: "1px solid var(--hairline)" }}>
      <nav
        role="tablist"
        aria-label="Dashboard views"
        className="-mb-px flex min-w-max justify-start space-x-7 px-1 sm:justify-center [&_svg]:h-3.75 [&_svg]:w-3.75"
      >
        {visibleTabs.map(({ id, label, icon }) => (
          <button
            key={id}
            ref={(element) => { tabRefs.current[id] = element; }}
            id={`dashboard-tab-${id}`}
            type="button"
            role="tab"
            aria-label={label}
            aria-selected={activeTab === id}
            aria-busy={loading?.[id] || undefined}
            aria-controls={`dashboard-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                moveFocus(id, event.key);
              }
            }}
            className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
              activeTab === id
                ? "border-lava text-lava"
                : "border-transparent text-slate hover:bg-oat-page hover:text-ink"
            }`}
          >
            {loading?.[id] ? (
              <span className="mr-2 -mt-0.5 inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">
                <Spinner size="xs" />
              </span>
            ) : icon}
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

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

const RAIL_STATUS_BADGE_CLASS = "rail-status-badge relative inline-flex h-[22px] w-[104px] min-w-0 shrink-0 items-center justify-center gap-[3px] overflow-hidden rounded-[4px] bg-green-500/20 px-[6px] text-[10px] font-bold leading-[10px] text-green-200";

function DuBoisAccountIcon() {
  return (
    <svg className="h-2.5 w-2.5 opacity-70" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M4 8.75h8v-1.5H4zM7 5.75H4v-1.5h3zM4 11.75h8v-1.5H4z" />
      <path fill="currentColor" fillRule="evenodd" d="M1.75 1a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75V5a.75.75 0 0 0-.75-.75H10v-2.5A.75.75 0 0 0 9.25 1zm.75 1.5h6V5c0 .414.336.75.75.75h4.25v7.75h-11z" clipRule="evenodd" />
    </svg>
  );
}

function DatabricksSqlProductIcon() {
  return (
    <svg className="h-3 w-3 opacity-70" viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d="M152 448h296V272H152c-48.601 0-88 39.399-88 88s39.399 88 88 88m0-48c22.091 0 40-17.909 40-40s-17.909-40-40-40-40 17.909-40 40 17.909 40 40 40" clipRule="evenodd" />
      <path fill="currentColor" fillRule="evenodd" d="M360 240c48.601 0 88-39.399 88-88s-39.399-88-88-88H64v176zm0-48c22.091 0 40-17.909 40-40s-17.909-40-40-40-40 17.909-40 40 17.909 40 40 40" clipRule="evenodd" />
    </svg>
  );
}

function compactRailBadgeText(value: string): string {
  const text = value.trim();
  const maxLength = /^\d/.test(text) ? 8 : 11;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function RailBadgeTooltip({
  text,
  children,
  align = "center",
}: {
  text: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const tooltipId = React.useId();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handleOpen = (event: Event) => {
      setVisible((event as CustomEvent<string>).detail === tooltipId);
    };
    window.addEventListener("cost-obs:rail-tooltip-open", handleOpen);
    return () => window.removeEventListener("cost-obs:rail-tooltip-open", handleOpen);
  }, [tooltipId]);
  const open = () => {
    window.dispatchEvent(new CustomEvent("cost-obs:rail-tooltip-open", {
      detail: tooltipId,
    }));
  };
  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={open}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={open}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setVisible(false);
        }
      }}
    >
      {children}
      <span
        role="tooltip"
        aria-hidden={!visible}
        className={`pointer-events-none absolute top-[calc(100%+8px)] z-50 w-max max-w-[min(360px,calc(100vw-24px))] rounded-[5px] bg-[#263238] px-2.5 py-1.5 text-left text-[11px] font-medium leading-4 text-white shadow-lg transition-opacity ${align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2"} ${visible ? "opacity-100" : "opacity-0"}`}
      >
        {text}
      </span>
    </span>
  );
}

function CopyableRailBadge({
  value,
  text,
  label,
  icon,
  tooltipAlign = "center",
}: {
  value: string;
  text: string;
  label: string;
  icon: React.ReactNode;
  tooltipAlign?: "start" | "center" | "end";
}) {
  const [copied, setCopied] = useState(false);
  const copyValue = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <RailBadgeTooltip align={tooltipAlign} text={
      <span className="block space-y-0.5">
        <span className="block">
          <strong>Display name:</strong>{" "}
          <code className="font-mono text-[10.5px]">{text}</code>
        </span>
        <span className="block">
          <strong>ID:</strong>{" "}
          <code className="font-mono text-[10.5px]">{value}</code>
          {copied ? " (copied)" : ""}
        </span>
      </span>
    }>
      <button
        type="button"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => { void copyValue(); }}
        className={`group ${RAIL_STATUS_BADGE_CLASS} appearance-none transition-colors hover:bg-green-400/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-300/40`}
      >
        <span className="rail-status-dot healthy-status-dot h-[5px] w-[5px] rounded-full bg-green-400" />
        <span className="min-w-0 overflow-hidden whitespace-nowrap">{compactRailBadgeText(text)}</span>
        {copied ? (
          <Check className="h-2.5 w-2.5" aria-hidden="true" />
        ) : (
          <span className="relative inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <span className="inline-flex group-hover:hidden group-focus:hidden" aria-hidden="true">
              {icon}
            </span>
            <Copy className="hidden h-2.5 w-2.5 opacity-80 group-hover:block group-focus:block" aria-hidden="true" />
          </span>
        )}
      </button>
    </RailBadgeTooltip>
  );
}

function DBUMethodologyPanel() {
  const minimizeKey = "cost-obs-minimize-dbu-info";
  const [minimized, setMinimized] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(minimizeKey) === "true" : false
  );
  const handleToggle = (value: boolean) => {
    setMinimized(value);
    if (value) localStorage.setItem(minimizeKey, "true");
    else localStorage.removeItem(minimizeKey);
  };

  return (
    <InfoPanel title="DBU Overview tab methodology" minimized={minimized} onToggle={handleToggle}>
      <ul className="list-inside list-disc space-y-1">
        <li><strong>DBUs</strong> are Databricks Units reported as usage quantity in <code className="rounded bg-white/60 px-1">system.billing.usage</code>.</li>
        <li><strong>Spend</strong> multiplies DBUs by the effective SKU price: account pricing when enabled and available, otherwise current list pricing.</li>
        <li>Date and workspace filters apply throughout this tab; cloud infrastructure charges are reported separately under Cloud Costs.</li>
      </ul>
    </InfoPanel>
  );
}

function AccountPricingBanner() {
  const { useAccountPrices, discountPercent, skuCount, available } = usePricing();
  if (!useAccountPrices) return null;
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: C.s3 }}>
      <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {available
        ? `Account prices active: ${discountPercent.toFixed(1)}% discount applied across ${skuCount} SKUs (from system.billing.account_prices)`
        : "Account prices mode active: system.billing.account_prices not available, showing list prices"}
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
            <strong>SP missing warehouse access</strong>: the service principal{billingAccess.sp_client_id ? ` (${billingAccess.sp_client_id})` : ""} cannot use the SQL warehouse.
            A workspace admin must run:{" "}
            <code className="rounded bg-amber-100 px-1 font-mono">
              GRANT CAN_USE ON WAREHOUSE {billingAccess.warehouse_id || "<warehouse_id>"} TO `{billingAccess.sp_client_id || "<sp_client_id>"}`
            </code>
          </span>
        ) : (
          <span className="text-xs text-amber-800">
            <strong>SP grants missing</strong>: the service principal lacks system table access after the last git deploy.
            Re-run the Permissions setup to restore access.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => { onOpenSettings(); }}
          className="text-xs font-medium px-3 py-1.5 rounded"
          style={{ background: C.lava, color: "#fff" }}
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
  const rqClient = useQueryClient();
  const tabFetching = useTabFetchingMap();
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);
  const { data: runtimeSettings } = useQuery<UnifiedSettings | null>({
    queryKey: ["unified-settings"],
    queryFn: () => fetch("/api/settings").then((response) => response.ok ? response.json() : null).catch(() => null),
    staleTime: 60 * 1000,
  });
  const defaultRange = getDefaultDateRange(appSettings.defaultDateRangeDays);
  const [dateRange, setDateRange] = useState<DateRange>(defaultRange);
  const [activeTab, setActiveTab] = useState<ViewTab>(() => {
    // Start on the configured default landing tab, falling back to the first visible
    // tab when that tab is hidden or unknown.
    const v = loadTabVisibility();
    const want = appSettings.defaultLandingTab as ViewTab;
    if (want && v[want as keyof TabVisibility]) return want;
    const first = (Object.keys(v) as ViewTab[]).find((k) => v[k as keyof TabVisibility]);
    return first ?? "dbu";
  });
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [sourceScopeVersion, setSourceScopeVersion] = useState(0);
  const [exportDemand, setExportDemand] = useState<{
    scope: string;
    tabs: ViewTab[];
  } | null>(null);
  const [preparedExportScope, setPreparedExportScope] = useState<string | null>(null);
  const [exportPreparationArmed, setExportPreparationArmed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [scopeResetVersion, setScopeResetVersion] = useState(0);
  const [scopeOwner, setScopeOwner] = useState<"workspace" | "source" | null>(null);
  const [includeHistoricalWorkspaces, setIncludeHistoricalWorkspaces] = useState(false);
  setIncludeHistoricalWorkspaceData(includeHistoricalWorkspaces);
  const [tabVisibility, setTabVisibility] = useState<TabVisibility>(loadTabVisibility);
  const visibleDashboardTabs = useMemo(
    () => DASHBOARD_TABS.map(({ id }) => id).filter((tab) => tabVisibility[tab]),
    [tabVisibility],
  );
  const tabDemandScopeKey = useMemo(
    () => JSON.stringify([
      dateRange.startDate,
      dateRange.endDate,
      [...selectedWorkspaceIds].sort(),
      includeHistoricalWorkspaces,
      sourceScopeVersion,
      [...visibleDashboardTabs].sort(),
    ]),
    [
      dateRange.endDate,
      dateRange.startDate,
      selectedWorkspaceIds,
      includeHistoricalWorkspaces,
      sourceScopeVersion,
      visibleDashboardTabs,
    ],
  );
  const [tabDemand, setTabDemand] = useState(
    () => createTabDemandState(tabDemandScopeKey, activeTab),
  );
  const tabDemandRef = useRef(tabDemand);
  tabDemandRef.current = tabDemand;
  const [demandRefreshPhase, setDemandRefreshPhase] = useState<
    Partial<Record<ViewTab, TabDemandRefreshPhase>>
  >({});
  const requeueDemandTabs = useCallback(async (
    tabs: readonly ViewTab[],
    markVisited = true,
  ) => {
    if (tabs.length === 0) return;
    let demoted: ViewTab[] = [];
    flushSync(() => {
      setDemandRefreshPhase((current) => {
        const next = { ...current };
        tabs.forEach((tab) => { next[tab] = "waiting"; });
        return next;
      });
      setTabDemand((current) => {
        const next = requeueTabDemand(
          current,
          tabs,
          activeTab,
          undefined,
          markVisited,
        );
        demoted = current.active.filter((tab) => !next.active.includes(tab));
        return next;
      });
    });
    await Promise.all(demoted.map((tab) => rqClient.cancelQueries({
      predicate: (query) => isQueryOwnedByTab(tab, query.queryKey),
    })));
  }, [activeTab, rqClient]);
  useEffect(() => {
    let disposed = false;
    const reconcile = async () => {
      if (tabDemand.scopeKey !== tabDemandScopeKey) {
        setDemandRefreshPhase({});
        await rqClient.cancelQueries({
          predicate: (query) => isDashboardQuery(query.queryKey),
        });
      }
      if (disposed) return;
      const currentDemand = tabDemandRef.current;
      const nextDemand = queueTabDemand(currentDemand, {
        scopeKey: tabDemandScopeKey,
        currentTab: activeTab,
        visibleTabs: visibleDashboardTabs,
        exportTabs: exportDemand?.tabs,
      });
      const preempted = currentDemand.active.filter(
        (tab) => !nextDemand.active.includes(tab),
      );
      setTabDemand(nextDemand);
      await Promise.all(preempted.map((tab) => rqClient.cancelQueries({
        predicate: (query) => isQueryOwnedByTab(tab, query.queryKey),
      })));
    };
    void reconcile();
    return () => { disposed = true; };
  }, [
    activeTab,
    exportDemand?.scope,
    exportDemand?.tabs,
    rqClient,
    tabDemand.scopeKey,
    tabDemandScopeKey,
    visibleDashboardTabs,
  ]);
  const appSettingsRef = useRef(appSettings);
  const tabVisibilityRef = useRef(tabVisibility);
  const settingsHydratedRef = useRef(false);
  appSettingsRef.current = appSettings;
  tabVisibilityRef.current = tabVisibility;

  useEffect(() => {
    if (!runtimeSettings) return;
    const previousSettings = appSettingsRef.current;
    const previousVisibility = tabVisibilityRef.current;
    const hydrated = hydrateSettingsFromServer(
      runtimeSettings,
      previousSettings,
      previousVisibility,
    );
    const initialHydration = !settingsHydratedRef.current;
    settingsHydratedRef.current = true;

    persistAppSettings(hydrated.appSettings);
    persistTabVisibility(hydrated.tabVisibility);
    appSettingsRef.current = hydrated.appSettings;
    tabVisibilityRef.current = hydrated.tabVisibility;
    if (!settingsAreEqual(previousSettings, hydrated.appSettings)) {
      setAppSettings(hydrated.appSettings);
    }
    if (!tabVisibilityIsEqual(previousVisibility, hydrated.tabVisibility)) {
      setTabVisibility(hydrated.tabVisibility);
    }
    if (initialHydration) {
      setDateRange(getDefaultDateRange(hydrated.appSettings.defaultDateRangeDays));
    }
    setActiveTab((current) => {
      const preferred = hydrated.appSettings.defaultLandingTab as ViewTab;
      if (initialHydration && hydrated.tabVisibility[preferred]) return preferred;
      if (hydrated.tabVisibility[current]) return current;
      return (Object.keys(hydrated.tabVisibility) as ViewTab[])
        .find((tab) => hydrated.tabVisibility[tab]) ?? "dbu";
    });
  }, [runtimeSettings]);

  // true = show wizard, false = show dashboard.
  // True until /api/setup/status resolves: blocks the dashboard from rendering.
  // Skip for returning users (local cache says done) so they never see a loading gate.
  const [setupCheckPending, setSetupCheckPending] = useState<boolean>(
    () => localStorage.getItem("coc-setup-complete") !== "true" &&
          sessionStorage.getItem("coc-setup-complete") !== "true"
  );
  const [showSetupWizard, setShowSetupWizard] = useState<boolean>(false);
  // Set when user closes wizard without completing: shows the incomplete banner on dashboard.
  const [setupIncomplete, setSetupIncomplete] = useState(false);
  // Stored so onLaunchWizard can abort the in-flight status check and prevent it from
  // overriding the manually-triggered wizard with a stale "ready" response.
  const setupStatusAbortRef = useRef<AbortController | null>(null);
  const [explicitRefreshingTab, setExplicitRefreshingTab] = useState<ViewTab | null>(null);
  const [refreshErrors, setRefreshErrors] = useState<Partial<Record<ViewTab, string>>>({});
  const handleTabRefresh = async () => {
    if (explicitRefreshingTab !== null) return;
    const tab = activeTab;
    setExplicitRefreshingTab(tab);
    setRefreshErrors((current) => ({ ...current, [tab]: undefined }));
    try {
      await refreshTabData(rqClient, tab);
    } catch (error) {
      console.error(`Failed to refresh ${tab} tab`, error);
      setRefreshErrors((current) => ({
        ...current,
        [tab]: "This tab could not be refreshed. Retry shortly.",
      }));
    } finally {
      setDemandRefreshPhase((current) => clearTabDemandRefreshPhases(current, [tab]));
      setExplicitRefreshingTab(null);
    }
  };

  const handleSourceApplied = useCallback(async (
    linkedWorkspaceIds: string[] | null,
    origin: "source" | "sync" | "rollback" = "sync",
  ) => {
    const tab = activeTab;
    if (origin === "source") {
      setScopeOwner(getActiveSourceLabels().length > 0 ? "source" : null);
    } else if (origin === "rollback") {
      setScopeOwner(
        selectedWorkspaceIds.length > 0
          ? "workspace"
          : getActiveSourceLabels().length > 0
            ? "source"
            : null,
      );
    }
    const nextSourceVersion = sourceScopeVersion + 1;
    const nextWorkspaceIds = linkedWorkspaceIds === null
      ? selectedWorkspaceIds
      : linkedWorkspaceIds;
    const nextScopeKey = JSON.stringify([
      dateRange.startDate,
      dateRange.endDate,
      [...nextWorkspaceIds].sort(),
      includeHistoricalWorkspaces,
      nextSourceVersion,
      [...visibleDashboardTabs].sort(),
    ]);
    try {
      // Stop every old-scope request before any parent state update can render
      // hooks with the new module-level source selection.
      await refreshSourceScopeData(rqClient);
      flushSync(() => {
        setRefreshErrors({});
        // A source filter is global, but only the visible tab should fetch now.
        // Other tabs pick up the new scope lazily when the user opens them.
        setDemandRefreshPhase({ [tab]: "waiting" });
        setTabDemand(createTabDemandState(nextScopeKey, tab));
        if (linkedWorkspaceIds !== null) {
          setSelectedWorkspaceIds(linkedWorkspaceIds);
        }
        setSourceScopeVersion(nextSourceVersion);
      });
      removeInactiveDashboardScopeData(rqClient);
    } catch (error) {
      console.error(`Failed to apply source filter to ${tab} tab`, error);
      throw error;
    }
  }, [
    activeTab,
    dateRange.endDate,
    dateRange.startDate,
    rqClient,
    selectedWorkspaceIds,
    includeHistoricalWorkspaces,
    sourceScopeVersion,
    visibleDashboardTabs,
  ]);

  const handleWorkspaceChange = useCallback((workspaceIds: string[]) => {
    if (workspaceIds.length === 0) {
      setActiveSourceLabels([]);
      setActiveSourceRouting([], []);
      setActiveSourceTables(null);
      setSelectedWorkspaceIds([]);
      setScopeOwner(null);
      setScopeResetVersion((version) => version + 1);
      void handleSourceApplied([]);
      return;
    }
    setSelectedWorkspaceIds(workspaceIds);
    setScopeOwner("workspace");
  }, [handleSourceApplied]);

  const resetAllScopeFilters = useCallback(async () => {
    setActiveSourceLabels([]);
    setActiveSourceRouting([], []);
    setActiveSourceTables(null);
    setSelectedWorkspaceIds([]);
    setScopeOwner(null);
    setScopeResetVersion((version) => version + 1);
    await handleSourceApplied([]);
  }, [handleSourceApplied]);

  // On every load, verify setup status with the server.
  // 60s timeout: allows for cold App pod start.
  useEffect(() => {
    const controller = new AbortController();
    setupStatusAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const prevCompleted = () =>
      localStorage.getItem("coc-setup-complete") === "true" ||
      sessionStorage.getItem("coc-setup-complete") === "true";

    fetch("/api/setup/status", { signal: controller.signal })
      .then((r) => r.json())
      .then(async (status) => {
        clearTimeout(timeout);
        if (status?.status === "ready") {
          localStorage.setItem("coc-setup-complete", "true");
          sessionStorage.setItem("coc-setup-complete", "true");
          setShowSetupWizard(false);
        } else if (status?.status === "setup_required") {
          // Only show wizard on a definitive "setup_required": not on transient states
          // like "initializing". Avoids wizard flash during cold start or mid-build polling.
          // The server is authoritative. A browser flag can survive a redeploy
          // that replaced the app identity or its managed tables, so it must not
          // suppress a newly-required setup run.
          localStorage.removeItem("coc-setup-complete");
          sessionStorage.removeItem("coc-setup-complete");
          // The durable administrator claim must happen before any setup
          // mutation. The server verifies the forwarded Apps OAuth identity
          // and atomically allows only the first caller to claim ownership.
          const bootstrap = await fetch("/api/setup/bootstrap-admin", {
            method: "POST",
            signal: controller.signal,
          });
          setShowSetupWizard(bootstrap.ok);
        }
        setSetupCheckPending(false);
        // "initializing" and other transient states: no wizard change, but unblock dashboard
      })
      .catch(() => {
        clearTimeout(timeout);
        setSetupCheckPending(false);
        // Network error, timeout, or non-JSON: trust local cache rather than flashing wizard.
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

  // Refresh only mounted dashboard data. Hidden documents pause the timer and
  // receive a full interval on resume, avoiding a focus-time request burst.
  useEffect(() => {
    if (appSettings.refreshIntervalMinutes <= 0) return;
    return startScopedAutoRefresh(
      rqClient,
      appSettings.refreshIntervalMinutes * 60 * 1000,
      document,
      globalThis,
      async () => {
        const tabs = tabDemand.visited.filter((tab) => tabVisibility[tab]);
        await requeueDemandTabs(tabs);
        await rqClient.invalidateQueries({
          type: "active",
          predicate: (query) => tabs.some(
            (tab) => isQueryOwnedByTab(tab, query.queryKey),
          ),
          refetchType: "active",
        });
      },
    );
  }, [
    appSettings.refreshIntervalMinutes,
    requeueDemandTabs,
    rqClient,
    tabDemand.visited,
    tabVisibility,
  ]);

  // Density → compact-mode CSS class on root
  useEffect(() => {
    document.documentElement.classList.toggle("compact-mode", appSettings.density === "compact");
  }, [appSettings.density]);

  // Theme → dark-mode CSS class on root ("system" follows prefers-color-scheme).
  useEffect(() => {
    const apply = () => {
      const dark = appSettings.theme === "dark" ||
        (appSettings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark-mode", dark);
    };
    apply();
    if (appSettings.theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [appSettings.theme]);

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
    sp_object_id?: string;
    sp_display_name?: string;
    sp_user_name?: string;
  } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  const {
    applyPricing,
    multiplier: pricingMultiplier,
    useAccountPrices,
    available: accountPricesAvailable,
  } = usePricing();

  // Central warehouse warming poller: single source of truth for warehouse state.
  // Normal checks are REST-only. If the initial cold gate remains after two polls,
  // one throttled SQL probe wakes/verifies the warehouse without releasing every
  // dashboard query at once. Missing bindings remain a definitive unavailable state.
  const initialWarehouseEverWarm =
    sessionStorage.getItem(WAREHOUSE_WARM_SESSION_KEY) === "1";
  const warehouseEverWarmRef = useRef(initialWarehouseEverWarm);
  const warehouseColdPollsRef = useRef(0);
  const warehouseLastProbeAtRef = useRef<number | null>(null);
  const [warehouseEverWarm, setWarehouseEverWarm] = useState(
    initialWarehouseEverWarm,
  );
  const {
    data: warehouseStatus,
    isError: warehouseHealthCheckFailed,
    isFetching: warehouseHealthChecking,
    refetch: retryWarehouseHealthCheck,
  } = useQuery<WarehouseHealth>({
    queryKey: ["health", "sql-warehouse"],
    queryFn: async () => {
      const now = Date.now();
      const requestProbe = shouldRequestWarehouseProbe(
        warehouseColdPollsRef.current,
        warehouseEverWarmRef.current,
        warehouseLastProbeAtRef.current,
        now,
      );
      if (requestProbe) warehouseLastProbeAtRef.current = now;

      const status = await fetchWarehouseHealth(requestProbe);
      if (status.status === "warm") {
        warehouseEverWarmRef.current = true;
        warehouseColdPollsRef.current = 0;
      } else if (status.status === "warming_up") {
        warehouseColdPollsRef.current += 1;
      } else {
        warehouseColdPollsRef.current = 0;
      }
      return status;
    },
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    // Keep retrying even if the endpoint itself transiently returns a network/5xx
    // error. An error allows normal data queries, so it never creates a cold gate.
    refetchInterval: (query) => warehouseHealthPollInterval(
      query.state.data?.status,
      query.state.status === "error",
    ),
    staleTime: 0,
  });
  const warehouseWarming = warehouseStatus?.status === "warming_up";
  // True only when we've confirmed the warehouse is accepting queries.
  // Undefined (not yet fetched) is treated as NOT ready: prevents firing 15+ SQL
  // queries against a cold warehouse before we know its state. Once bounded health
  // retries fail, allow real app queries to prove connectivity instead of blocking
  // an otherwise healthy app on a non-authoritative status endpoint.
  const warehouseReady = warehouseStatus?.status === "warm";
  const warehouseQueriesAllowed = warehouseReady || warehouseHealthCheckFailed;

  useEffect(() => {
    setWarehouseEverWarm((current) => {
      const next = nextWarehouseWarmState(current, warehouseStatus?.status);
      warehouseEverWarmRef.current = next;
      if (next && !current) sessionStorage.setItem(WAREHOUSE_WARM_SESSION_KEY, "1");
      return next;
    });
  }, [warehouseStatus?.status]);

  // SettingsConfig writes true here when a rebuild starts, false when it finishes.
  // Suppresses the cold-start screen during rebuilds: the warehouse waking up
  // was caused by the rebuild itself, not a cold app load.
  const { data: rebuildInProgress = false } = useQuery<boolean>({
    queryKey: ["rebuild-in-progress"],
    queryFn: () => false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Clear the stale-chunk reload guard once the app is healthy. Tab chunks remain
  // on demand: React.lazy downloads each one only when its tab is first opened.
  useEffect(() => {
    if (!warehouseReady) return;
    sessionStorage.removeItem("_chunk_reload");
  }, [warehouseReady]);

  const exportPreparationRequested = showExportDialog && exportDemand !== null;
  const requested = (tab: ViewTab) =>
    warehouseQueriesAllowed
    && tabDemand.scopeKey === tabDemandScopeKey
    && isTabProducerActive(tabDemand, tab);
  const dbuRequested = requested("dbu");
  const sqlRequested = requested("sql");
  const infraRequested = requested("infra");
  const optimizerRequested = requested("optimizer");
  const kpisRequested = requested("kpis");
  const aimlRequested = requested("aiml");
  const appsRequested = requested("apps");
  const taggingRequested = requested("tagging");
  const usersRequested = requested("users-groups");

  // Fast bundle for the DBU tab and report exports (uses materialized views).
  const { data: bundle, isLoading: bundleLoading, isError: bundleError } = useDashboardBundleFast(
    dateRange,
    selectedWorkspaceIds.length ? selectedWorkspaceIds : undefined,
    dbuRequested,
  );

  // Extract data from fast bundle: apply pricing multiplier when account prices are active
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

  // Each tab now opts into only the queries it owns. React Query keeps settled data
  // cached, so revisiting a tab is instant until its stale-time expires.
  const { data: sqlBreakdown, isLoading: sqlLoading, isError: sqlError } = useSqlBreakdown(dateRange, _wsIds, sqlRequested);
  const { data: pipelineObjects, isLoading: pipelineLoading, isError: pipelineError } = usePipelineObjects(dateRange, _wsIds, dbuRequested);
  const { data: interactiveBreakdown, isLoading: interactiveLoading, isError: interactiveError } = useInteractiveBreakdown(dateRange, _wsIds, dbuRequested);
  const { data: skuBreakdown, isLoading: skuLoading, isError: skuError } = useSKUBreakdown(dateRange, _wsIds, dbuRequested);

  const {
    data: cloudCostsBundle,
    isLoading: infraBundleLoading,
    isError: infraBundleError,
    error: infraBundleErrorObject,
  } = useCloudCostsBundle(dateRange, _wsIds, infraRequested);
  const infraBundle = cloudCostsBundle?.infra_bundle;
  const infraCosts = infraBundle?.infra_costs;
  const infraCostsTimeseries = infraBundle?.infra_timeseries;
  const infraPricingMultiplier =
    useAccountPrices && accountPricesAvailable ? pricingMultiplier : 1;
  const pricedInfraCosts = useMemo(
    () => applyInfraPricing(infraCosts, infraPricingMultiplier),
    [infraCosts, infraPricingMultiplier],
  );

  const { data: kpisBundle, isLoading: kpisBundleLoading, isFetching: kpisBundleFetching, isError: kpisBundleError } = useKPIsBundle(dateRange, _wsIds, kpisRequested);
  const spendAnomalies = kpisBundle?.anomalies;
  const platformKPIs = kpisBundle?.kpis;
  const anomaliesLoading = kpisBundleLoading;
  const kpisLoading = kpisBundleLoading;

  const {
    data: aimlData,
    isLoading: aimlLoading,
    isError: aimlError,
    error: aimlErrorObj,
    refetch: refetchAiml,
  } = useAIMLDashboardBundle(dateRange, _wsIds, aimlRequested);
  const {
    data: appsData,
    isLoading: appsLoading,
    isError: appsError,
    error: appsErrorObj,
    refetch: refetchApps,
  } = useAppsDashboardBundle(dateRange, _wsIds, appsRequested);
  const { data: taggingData, isLoading: taggingLoading, isError: taggingError } = useTaggingDashboardBundle(dateRange, _wsIds, taggingRequested);

  const awsActualData = cloudCostsBundle?.aws_actual;
  const azureActualData = cloudCostsBundle?.azure_actual;
  const gcpActualData = cloudCostsBundle?.gcp_actual;
  const awsActualLoading = infraBundleLoading;
  const azureActualLoading = infraBundleLoading;
  const gcpActualLoading = infraBundleLoading;

  const { data: dbsqlData, isLoading: dbsqlLoading, isError: dbsqlError } = useDBSQLQueryCosts(dateRange, _wsIds, sqlRequested);
  const { data: dbsqlTopQueriesData, isLoading: dbsqlTopQueriesLoading, isError: dbsqlTopQueriesError } = useDBSQLTopQueries(dateRange, _wsIds, sqlRequested);
  const {
    data: usersGroupsData,
    isLoading: usersGroupsLoading,
    isError: usersGroupsError,
    refetch: refetchUsersGroups,
  } = useUsersGroupsBundle(dateRange, _wsIds, usersRequested);

  // Optimizer queries run when its tab or the report exporter requests them.
  const optimizerSourceKey = getActiveSourceScopeKey();
  const { data: optimizeRightsizingData, isLoading: optimizeRightsizingLoading, isError: optimizeRightsizingError } = useQuery<WarehouseHealthData>({
    queryKey: ["warehouse-health", _wsIds?.join(","), optimizerSourceKey, includeHistoricalWorkspaces],
    queryFn: async () => {
      const response = await fetch(buildFilteredUrl(
        "/api/sql/warehouse-health",
        new URLSearchParams(),
        _wsIds,
      ));
      if (!response.ok) throw new Error(`Warehouse health request failed with ${response.status}`);
      return response.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: false,
    // Deferred: only fire when the Optimize tab is actually opened. Previously
    // this prefetched at Dashboard mount and could starve concurrent bundles.
    enabled: optimizerRequested,
  });
  const { data: optimizeIdleData, isLoading: optimizeIdleLoading, isError: optimizeIdleError } = useQuery<WarehouseIdleTimeData>({
    queryKey: ["warehouse-idle-time", dateRange.startDate, dateRange.endDate, _wsIds?.join(","), optimizerSourceKey, includeHistoricalWorkspaces],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateRange.startDate) params.set("start_date", dateRange.startDate);
      if (dateRange.endDate) params.set("end_date", dateRange.endDate);
      if (_wsIds?.length) params.set("workspace_ids", _wsIds.join(","));
      const response = await fetch(buildFilteredUrl("/api/sql/warehouse-health/idle-time", params));
      if (!response.ok) throw new Error(`Warehouse idle-time request failed with ${response.status}`);
      return response.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: false,
    // Deferred: only fire when the Optimize tab is actually opened.
    enabled: optimizerRequested,
  });
  const optimizeChecksSettled = Boolean(optimizeRightsizingData && optimizeIdleData)
    && !optimizeRightsizingLoading
    && !optimizeIdleLoading
    && !optimizeRightsizingError
    && !optimizeIdleError;
  const optimizeHasData = Boolean(
    (
      optimizeRightsizingData?.available
      && (
        optimizeRightsizingData.warehouses_analyzed > 0
        || optimizeRightsizingData.recommendations.length > 0
      )
    )
    || (
      optimizeIdleData?.available
      && optimizeIdleData.warehouses.length > 0
    )
  );
  const cloudCostsOnlyServerless = Boolean(
    !infraBundleLoading
    && !infraBundleError
    && infraCosts?.reason === "serverless_only"
  );
  const runtimeTabVisibility = useMemo(
    () => ({
      ...tabVisibility,
      infra: tabVisibility.infra && !cloudCostsOnlyServerless,
      optimizer: tabVisibility.optimizer
        && !(optimizeChecksSettled && !optimizeHasData),
    }),
    [cloudCostsOnlyServerless, optimizeChecksSettled, optimizeHasData, tabVisibility],
  );
  useEffect(() => {
    if (
      (activeTab === "optimizer" && !runtimeTabVisibility.optimizer)
      || (activeTab === "infra" && !runtimeTabVisibility.infra)
    ) {
      setActiveTab("dbu");
    }
  }, [activeTab, runtimeTabVisibility.infra, runtimeTabVisibility.optimizer]);
  const retryScheduledTab = useCallback(
    async (tab: ViewTab, refetch: () => Promise<unknown>) => {
      await requeueDemandTabs([tab]);
      await refetch();
    },
    [requeueDemandTabs],
  );

  const tabLoading: Record<ViewTab, boolean> = {
    dbu: bundleLoading || skuLoading || pipelineLoading || interactiveLoading,
    sql: sqlLoading || dbsqlLoading || dbsqlTopQueriesLoading,
    infra: infraBundleLoading,
    optimizer: optimizeRightsizingLoading || optimizeIdleLoading,
    kpis: kpisBundleLoading,
    aiml: aimlLoading,
    apps: appsLoading,
    tagging: taggingLoading,
    "users-groups": usersGroupsLoading,
  };
  // Optional DBU panels own their loading states. Do not mask the entire
  // overview after the core bundle has loaded because one detail query is slow.
  const tabPrimaryLoading: Record<ViewTab, boolean> = {
    ...tabLoading,
    dbu: bundleLoading,
  };
  const firstPayloadIssue = (
    ...payloads: Array<[unknown, boolean?]>
  ): string | undefined => {
    for (const [payload, requireAvailable = false] of payloads) {
      const issue = responsePayloadIssue(payload, requireAvailable);
      if (issue) return issue;
    }
    return undefined;
  };
  const reportPayloadIssues: Partial<Record<ViewTab, string>> = {
    dbu: firstPayloadIssue(
      [bundle],
      [bundle?.summary, true],
      [bundle?.products, true],
      [bundle?.workspaces, true],
      [skuBreakdown],
      [pipelineObjects],
      [interactiveBreakdown],
    ),
    sql: firstPayloadIssue(
      [sqlBreakdown, true],
      [dbsqlData, true],
      [dbsqlTopQueriesData, true],
    ),
    infra: firstPayloadIssue(
      [infraBundle],
      [infraCosts, true],
    ),
    optimizer: firstPayloadIssue(
      [optimizeRightsizingData, true],
      [optimizeIdleData, true],
    ),
    kpis: firstPayloadIssue(
      [kpisBundle],
      [spendAnomalies, true],
      [platformKPIs, true],
    ),
    aiml: firstPayloadIssue([aimlData, true]),
    apps: firstPayloadIssue([appsData, true]),
    tagging: firstPayloadIssue([taggingData, true]),
    "users-groups": firstPayloadIssue([usersGroupsData, true]),
  };
  const tabErrors: Partial<Record<ViewTab, string>> = {
    dbu: reportPayloadIssues.dbu || (bundleError || skuError || pipelineError || interactiveError ? "DBU Overview data failed to load." : undefined),
    sql: reportPayloadIssues.sql || (sqlError || dbsqlError || dbsqlTopQueriesError ? "SQL data failed to load." : undefined),
    infra: reportPayloadIssues.infra || (infraBundleError ? "Cloud Costs data failed to load." : undefined),
    optimizer: reportPayloadIssues.optimizer || (optimizeRightsizingError || optimizeIdleError ? "Optimize data failed to load." : undefined),
    kpis: reportPayloadIssues.kpis || (kpisBundleError ? "Platform KPI data failed to load." : undefined),
    aiml: reportPayloadIssues.aiml || (aimlError ? "AI/ML data failed to load." : undefined),
    apps: reportPayloadIssues.apps || (appsError ? "Apps data failed to load." : undefined),
    tagging: reportPayloadIssues.tagging || (taggingError ? "Tagging data failed to load." : undefined),
    "users-groups": reportPayloadIssues["users-groups"] || (usersGroupsError ? "Users data failed to load." : undefined),
  };
  const tabErrorsRef = useRef(tabErrors);
  tabErrorsRef.current = tabErrors;
  const tabHasOutcome = useMemo<Record<ViewTab, boolean>>(() => ({
    dbu: Boolean(bundle || bundleError)
      && Boolean(skuBreakdown || skuError)
      && Boolean(pipelineObjects || pipelineError)
      && Boolean(interactiveBreakdown || interactiveError),
    sql: Boolean(sqlBreakdown || sqlError)
      && Boolean(dbsqlData || dbsqlError)
      && Boolean(dbsqlTopQueriesData || dbsqlTopQueriesError),
    infra: Boolean(cloudCostsBundle || infraBundleError),
    optimizer: Boolean(optimizeRightsizingData || optimizeRightsizingError)
      && Boolean(optimizeIdleData || optimizeIdleError),
    kpis: Boolean(kpisBundle || kpisBundleError),
    aiml: Boolean(aimlData || aimlError),
    apps: Boolean(appsData || appsError),
    tagging: Boolean(taggingData || taggingError),
    "users-groups": Boolean(usersGroupsData || usersGroupsError),
  }), [
    aimlData,
    aimlError,
    appsData,
    appsError,
    bundle,
    bundleError,
    cloudCostsBundle,
    dbsqlData,
    dbsqlError,
    dbsqlTopQueriesData,
    dbsqlTopQueriesError,
    infraBundleError,
    interactiveBreakdown,
    interactiveError,
    kpisBundle,
    kpisBundleError,
    optimizeIdleData,
    optimizeIdleError,
    optimizeRightsizingData,
    optimizeRightsizingError,
    pipelineObjects,
    pipelineError,
    skuBreakdown,
    skuError,
    sqlBreakdown,
    sqlError,
    taggingData,
    taggingError,
    usersGroupsData,
    usersGroupsError,
  ]);
  useEffect(() => {
    setDemandRefreshPhase((current) => {
      let changed = false;
      const next = { ...current };
      for (const [tab, phase] of Object.entries(current) as Array<
        [ViewTab, "waiting" | "fetching"]
      >) {
        if (phase === "waiting" && tabFetching[tab]) {
          next[tab] = "fetching";
          changed = true;
        } else if (phase === "fetching" && !tabFetching[tab]) {
          delete next[tab];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tabFetching]);
  useEffect(() => {
    const completed = tabDemand.active.filter(
      (tab) => tabHasOutcome[tab] && !demandRefreshPhase[tab],
    );
    if (completed.length === 0) return;
    setTabDemand((current) => settleTabDemand(current, completed, activeTab));
  }, [
    activeTab,
    demandRefreshPhase,
    tabDemand.active,
    tabHasOutcome,
  ]);
  const unresolvedTabDemand = Object.fromEntries(
    visibleDashboardTabs.map((tab) => [
      tab,
      tabDemand.scopeKey !== tabDemandScopeKey
        ? tab === activeTab || tabDemand.visited.includes(tab)
        : isTabDemandUnresolved(tabDemand, tab),
    ]),
  ) as Partial<Record<ViewTab, boolean>>;
  const activeTabInitialLoading = !warehouseQueriesAllowed || tabPrimaryLoading[activeTab];
  const showActiveTabLoading = activeTabInitialLoading
    || Boolean(unresolvedTabDemand[activeTab])
    || explicitRefreshingTab === activeTab;
  const exportDataLoading = exportPreparationRequested &&
    Boolean(exportDemand?.tabs.some(
      (tab) => tabDemand.scopeKey !== tabDemandScopeKey
        || isTabDemandUnresolved(tabDemand, tab)
        || tabLoading[tab],
    ));
  const exportHasErrors = exportPreparationRequested &&
    Boolean(exportDemand?.tabs.some((tab) => Boolean(tabErrors[tab])));
  const exportDataPrepared = Boolean(
    exportDemand && preparedExportScope === exportDemand.scope,
  );
  const exportPreparing = exportPreparationRequested
    && !exportDataPrepared
    && !exportHasErrors;

  useEffect(() => {
    if (!exportPreparationRequested || !exportDemand) return;
    if (!exportPreparationArmed) {
      setExportPreparationArmed(true);
      return;
    }
    if (exportDataLoading || exportHasErrors) return;
    setPreparedExportScope(exportDemand.scope);
  }, [exportDataLoading, exportDemand, exportHasErrors, exportPreparationArmed, exportPreparationRequested]);

  const openExportDialog = () => {
    setExportDemand(null);
    setPreparedExportScope(null);
    setExportPreparationArmed(false);
    setShowExportDialog(true);
  };

  const releaseExportDemand = useCallback(() => {
    const currentDemand = tabDemandRef.current;
    const exportOnlyTabs = (exportDemand?.tabs ?? []).filter(
      (tab) => tab !== activeTab && !currentDemand.visited.includes(tab),
    );
    setExportDemand(null);
    setPreparedExportScope(null);
    setExportPreparationArmed(false);
    if (exportOnlyTabs.length === 0) return;
    setDemandRefreshPhase((current) => {
      const next = { ...current };
      exportOnlyTabs.forEach((tab) => { delete next[tab]; });
      return next;
    });
    void Promise.all(exportOnlyTabs.map((tab) => rqClient.cancelQueries({
      predicate: (query) => isQueryOwnedByTab(tab, query.queryKey),
    })));
  }, [activeTab, exportDemand?.tabs, rqClient]);

  const closeExportDialog = useCallback(() => {
    setShowExportDialog(false);
    releaseExportDemand();
  }, [releaseExportDemand]);

  const prepareExportData = useCallback((sections: ExportSections) => {
    const tabs = getRequiredExportTabs(sections, tabVisibility) as ViewTab[];
    const scope = buildExportScopeKey(
      dateRange.startDate,
      dateRange.endDate,
      selectedWorkspaceIds,
      sourceScopeVersion,
      tabs,
      includeHistoricalWorkspaces,
    );
    setPreparedExportScope(null);
    setExportPreparationArmed(false);
    setExportDemand({ scope, tabs });
    void (async () => {
      await requeueDemandTabs(tabs, false);
      await rqClient.invalidateQueries({
        predicate: (query) => tabs.some(
          (tab) => isQueryOwnedByTab(tab, query.queryKey),
        ),
        refetchType: "active",
      });
    })();
  }, [
    dateRange.endDate,
    dateRange.startDate,
    selectedWorkspaceIds,
    includeHistoricalWorkspaces,
    sourceScopeVersion,
    tabVisibility,
    requeueDemandTabs,
    rqClient,
  ]);

  const resetExportDemand = useCallback(() => {
    if (!exportDemand) return;
    releaseExportDemand();
  }, [exportDemand, releaseExportDemand]);

  const retryFailedExportData = useCallback(async () => {
    const tabs = exportDemand?.tabs ?? [];
    const failedTabs = tabs.filter((tab) => Boolean(tabErrorsRef.current[tab]));
    await requeueDemandTabs(failedTabs);
    await rqClient.invalidateQueries({
      predicate: (query) => failedTabs.some(
        (tab) => isQueryOwnedByTab(tab, query.queryKey),
      ),
      refetchType: "none",
    });
    await rqClient.refetchQueries({
      type: "active",
      predicate: (query) => query.state.status === "error"
        && failedTabs.some((tab) => isQueryOwnedByTab(tab, query.queryKey)),
    });
  }, [exportDemand?.tabs, requeueDemandTabs, rqClient]);

  // Workspace list for the filter dropdown: SQL-backed, only fire when warehouse is ready.
  const workspaceSourceKey = getActiveSourceScopeKey();
  const { data: wsListData, isLoading: wsListLoading } = useQuery<{
    workspaces: {
      id: string;
      name: string;
      historical?: boolean;
      cloud?: string | null;
      region?: string | null;
    }[];
    error?: string;
  }>({
    queryKey: [
      "billing",
      "workspaces",
      dateRange.startDate,
      dateRange.endDate,
      workspaceSourceKey,
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        start_date: dateRange.startDate,
        end_date: dateRange.endDate,
        include_historical_workspaces: "true",
      });
      return fetch(buildFilteredUrl("/api/billing/workspaces", params)).then(r => r.json());
    },
    staleTime: Infinity,
    enabled: warehouseQueriesAllowed,
  });
  const workspaceNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    // wsListData has real account-level names; only store entries where a real name exists
    wsListData?.workspaces?.forEach((w) => { if (w.name) map[w.id] = w.name; });
    // Fill any gaps from billing data (workspace_name sometimes populated here too)
    workspaces?.workspaces?.forEach((w: WorkspaceBreakdown) => {
      if (!map[w.workspace_id] && w.workspace_name) map[w.workspace_id] = w.workspace_name;
    });
    return map;
  }, [wsListData?.workspaces, workspaces?.workspaces]);

  // Overlay the merged name map so the top-nav filter picks up billing-derived
  // names when /api/billing/workspaces returns an id-only record.
  const wsFilterList = useMemo(
    () => (wsListData?.workspaces ?? []).map(w => {
      const name = workspaceNameMap[w.id] || w.name || null;
      const hasResolvedName = Boolean(
        name && name !== w.id && name !== `Workspace ${w.id}`,
      );
      return {
        workspace_id: w.id,
        workspace_name: name,
        // A resolved account-level name is stronger evidence than a stale historical
        // flag from billing metadata.
        historical: hasResolvedName ? false : (w.historical ?? true),
        cloud: w.cloud,
        region: w.region,
        total_dbus: 0,
        total_spend: 0,
        percentage: 0,
        top_products: [],
        top_users: [],
      };
    }),
    [wsListData?.workspaces, workspaceNameMap],
  );
  const sourceRoutingWorkspaces = useMemo(
    () => wsFilterList
      .filter((workspace) => Boolean(workspace.workspace_id))
      .map((workspace) => ({
        id: workspace.workspace_id as string,
        name: workspace.workspace_name,
      })),
    [wsFilterList],
  );
  const sourceLinkedWorkspaceIds = new Set(
    getActiveSourceRouting().workspaceIds,
  );
  const sourceFilteredWorkspaceList = sourceLinkedWorkspaceIds.size > 0
    ? wsFilterList.filter((workspace) =>
        Boolean(
          workspace.workspace_id
          && sourceLinkedWorkspaceIds.has(workspace.workspace_id)
        )
      )
    : wsFilterList;
  const workspaceScopeCount = wsListData && !wsListData.error
    ? wsFilterList.filter((workspace) => includeHistoricalWorkspaces || !workspace.historical).length
    : undefined;

  // Service-principal display-name map: refetches after 10 min so if the first
  // SCIM call missed (e.g. permission granted later, backend was in cold-start),
  // consumers recover without a hard refresh.
  const { data: spListData } = useQuery<{ map: Record<string, string> }>({
    queryKey: ["user", "service-principals"],
    queryFn: () => fetch("/api/user/service-principals").then(r => r.json()),
    staleTime: 10 * 60 * 1000,
  });
  // Memoize so consumers of SpNameMapContext get a stable reference while
  // spListData is undefined (otherwise every parent render churns the context).
  const spNameMap = useMemo(() => spListData?.map ?? {}, [spListData?.map]);

  // Memoize infra data transformations to avoid re-creating arrays on every render
  const infraViewData = useMemo(() => pricedInfraCosts ? {
    clusters: (pricedInfraCosts.clusters || []).map(c => ({
      cluster_id: c.cluster_id,
      cluster_name: c.cluster_name,
      driver_instance_type: c.driver_instance_type,
      worker_instance_type: c.worker_instance_type,
      cluster_source: c.cluster_source,
      total_dbu_hours: c.total_dbu_hours,
      databricks_spend: c.databricks_spend,
      days_active: c.days_active,
      percentage: c.percentage,
      workspace_id: c.workspace_id || "",
      workspace_name: c.workspace_name ?? null,
      state: null,
    })),
    instance_families: pricedInfraCosts.instance_families,
    total_estimated_cost: pricedInfraCosts.total_estimated_cost,
    total_databricks_spend: pricedInfraCosts.total_databricks_spend,
    total_dbu_hours: pricedInfraCosts.total_dbu_hours,
    total_cluster_count: pricedInfraCosts.total_cluster_count,
    detail_limit: pricedInfraCosts.detail_limit,
    detail_truncated: pricedInfraCosts.detail_truncated,
    full_first_usage_date: pricedInfraCosts.full_first_usage_date,
    full_last_usage_date: pricedInfraCosts.full_last_usage_date,
    billing_summary: pricedInfraCosts.billing_summary,
    start_date: pricedInfraCosts.start_date,
    end_date: pricedInfraCosts.end_date,
    disclaimer: pricedInfraCosts.disclaimer,
    error: pricedInfraCosts.error,
  } : undefined, [pricedInfraCosts]);

  const infraViewTimeseries = useMemo(() => infraCostsTimeseries ? {
    timeseries: (infraCostsTimeseries.timeseries || []).map(t => ({
      date: t.date,
      "Cluster DBUs": t.total_dbu_hours,
    })),
    categories: ["Cluster DBUs"],
    start_date: infraCostsTimeseries.start_date,
    end_date: infraCostsTimeseries.end_date,
  } : undefined, [infraCostsTimeseries]);

  const handleExport = (sections: ExportSections, format: ExportFormat) => {
    const workspaceFilter = _wsIds?.length
      ? { ids: _wsIds, names: _wsIds.map((id: string) => workspaceNameMap[id] || id) }
      : { ids: [] };
    const exportContext = {
      anonymizeUsers: appSettings.anonymizeUsers,
      companyName: appSettings.companyName,
      sourceLabels: getActiveSourceLabels(),
      cloudProvider: accountInfo?.cloud,
    };

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
          query360: dbsqlData ?? undefined,
        },
        sections,
        { start: dateRange.startDate, end: dateRange.endDate },
        workspaceFilter,
        exportContext,
      );
      return;
    }
    void handleExportPDF(sections, workspaceFilter);
  };

  const handleExportPDF = async (sections: ExportSections, workspaceFilter?: { ids: string[]; names?: string[] }) => {
    try {
      const { generateCostReport } = await import("@/utils/pdfExport");
      await generateCostReport(
        {
        summary,
        products,
        workspaces,
        skus: skuBreakdown,
        anomalies: spendAnomalies,
        pipelineObjects,
        interactiveBreakdown,
        awsCosts: pricedInfraCosts ? {
          clusters: (pricedInfraCosts.clusters ?? []).map(c => ({
            cluster_id: c.cluster_id,
            cluster_name: c.cluster_name,
            driver_instance_type: c.driver_instance_type,
            worker_instance_type: c.worker_instance_type,
            cluster_source: c.cluster_source,
            total_dbu_hours: c.total_dbu_hours,
            databricks_spend: c.databricks_spend,
            days_active: c.days_active,
            percentage: c.percentage,
            workspace_id: c.workspace_id || "",
            state: null,
          })),
          instance_families: pricedInfraCosts.instance_families,
          total_estimated_cost: pricedInfraCosts.total_estimated_cost,
          total_databricks_spend: pricedInfraCosts.total_databricks_spend,
          total_dbu_hours: pricedInfraCosts.total_dbu_hours,
          start_date: pricedInfraCosts.start_date,
          end_date: pricedInfraCosts.end_date,
          disclaimer: pricedInfraCosts.disclaimer,
          error: pricedInfraCosts.error,
        } : undefined,
        aiml: aimlData,
        apps: appsData,
        tagging: taggingData,
        platformKPIs,
        query360: dbsqlData ?? undefined,
        users: usersGroupsData,
        optimize: (optimizeRightsizingData || optimizeIdleData)
          ? { rightsizing: optimizeRightsizingData, idle: optimizeIdleData }
          : undefined,
        dateRange: {
          start: dateRange.startDate,
          end: dateRange.endDate,
        },
        workspaceFilter,
        context: {
          anonymizeUsers: appSettings.anonymizeUsers,
          companyName: appSettings.companyName,
          sourceLabels: getActiveSourceLabels(),
          cloudProvider: accountInfo?.cloud,
        },
        },
        sections
      );
    } catch (error) {
      console.error("PDF export failed", error);
      window.alert("The PDF could not be generated. Please try again.");
    }
  };

  const handleArchitectureExport = async () => {
    await downloadArchitecturePdf();
  };

  if (showSetupWizard) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: C.oatPage }}>
        <SetupWizard
          onComplete={handleSetupComplete}
          onClose={() => { setShowSetupWizard(false); setSetupIncomplete(true); }}
        />
      </div>
    );
  }

  if (setupCheckPending) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4" style={{ backgroundColor: C.oatPage }}>
        <Spinner size="md" />
        <p className="text-sm font-medium" style={{ color: C.ink }}>Checking setup status…</p>
      </div>
    );
  }

  if (
    warehouseStatus?.status === "unavailable"
    && shouldGateDashboard(warehouseStatus.status, warehouseEverWarm, rebuildInProgress)
  ) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6" style={{ backgroundColor: C.oatPage }}>
        <div className="flex flex-col items-center gap-4 text-center">
          <svg className="h-10 w-10 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <h2 className="text-xl font-semibold" style={{ color: C.ink }}>SQL Warehouse unavailable</h2>
          <p className="text-sm" style={{ color: C.slate }}>The warehouse could not be reached. Check that your warehouse is running in the Databricks console.</p>
        </div>
      </div>
    );
  }

  if (
    warehouseWarming
    && shouldGateDashboard(warehouseStatus?.status, warehouseEverWarm, rebuildInProgress)
  ) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6" style={{ backgroundColor: C.oatPage }}>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-3 w-13 items-center justify-center">
            <Spinner size="xs" />
          </div>
          <h2 className="text-xl font-semibold" style={{ color: C.ink }}>SQL Warehouse is starting up</h2>
          <p className="text-sm" style={{ color: C.slate }}>Dashboard data will load automatically once the warehouse is ready.</p>
        </div>
      </div>
    );
  }

  return (
    <SpNameMapContext.Provider value={spNameMap}>
    <div className="min-h-screen" style={{ backgroundColor: C.oatPage }}>
      {/* Setup incomplete banner: non-dismissable, shown when wizard was closed without finishing */}
      {setupIncomplete && (
        <div className="flex items-center justify-between gap-4 px-4 py-2.5 border-b" style={{ backgroundColor: C.coralTint, borderColor: C.coralBrd }}>
          <div className="flex items-center gap-2 min-w-0">
            <svg className="h-4 w-4 shrink-0 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span className="text-xs font-medium text-orange-800">
              Setup incomplete: materialized views have not been created. Data may be slower or incomplete.
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => {
                // Manually mark setup complete (tables already exist: e.g. the flag
                // was lost after a redeploy). Dismisses the banner without a rebuild.
                setSetupIncomplete(false);
                fetch("/api/setup/mark-complete", { method: "POST" }).catch(() => {});
              }}
              className="rounded-md border border-orange-300 px-3 py-1.5 text-xs font-medium text-orange-800 hover:bg-orange-100 transition-colors"
              title="Mark setup complete without rebuilding: use when the tables already exist"
            >
              Mark complete
            </button>
            <button
              onClick={() => {
                setSetupIncomplete(false);
                fetch("/api/setup/rerun", { method: "POST" }).catch(() => {});
                setShowSetupWizard(true);
              }}
              className="rounded-md px-3 py-1.5 text-xs font-semibold text-white transition-colors"
              style={{ backgroundColor: C.lava }}
            >
              Resume Setup
            </button>
          </div>
        </div>
      )}

      {/* Sticky top chrome: navy account bar + white title/tabs */}
      <div className="sticky top-0 z-30 shadow">
      {/* Account rail */}
      <div data-testid="account-rail" className="min-h-[52px] overflow-visible bg-[#1B3139] text-white">
        <div className="flex min-h-[52px] w-full min-w-0 flex-wrap items-center gap-[8px] px-[12px] py-[8px] min-[1280px]:gap-[14px] min-[1280px]:px-[20px]">
          <a
            href="https://www.databricks.com"
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-[10px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3621]/35"
          >
            <img src="/brand/databricks-symbol-white.svg" alt="" className="h-[19px] w-[17px]" />
            <span className="hidden flex-col gap-[1px] min-[1180px]:flex">
              <span className="text-[8.5px] font-semibold tracking-[.14em] text-[#E9EFED]/60">BUILT ON</span>
              <span className="text-[14px] font-semibold leading-none text-white">Databricks</span>
            </span>
          </a>

          <DeploymentBadgeFromApi variant="control" />

          <span className="hidden h-[22px] w-px shrink-0 bg-white/[.16] min-[1180px]:block" aria-hidden="true" />

          <div className="order-last flex w-full min-w-0 items-center gap-[8px] sm:order-none sm:w-auto sm:flex-1">
            <WorkspaceFilter
              workspaces={scopeOwner === "source" ? sourceFilteredWorkspaceList : wsFilterList}
              currentWorkspaceId={accountInfo?.workspace_id}
              selectedIds={selectedWorkspaceIds}
              onChange={handleWorkspaceChange}
              includeHistorical={includeHistoricalWorkspaces}
              onIncludeHistoricalChange={setIncludeHistoricalWorkspaces}
              isLoading={wsListLoading}
              variant="rail"
              showSingleOption={sourceLinkedWorkspaceIds.size > 0}
              showClearButton={false}
              disabled={scopeOwner === "source"}
            />
            <SourceLabelFilter
              variant="rail"
              localWorkspaces={sourceRoutingWorkspaces}
              workspaceSelection={selectedWorkspaceIds}
              onApplied={handleSourceApplied}
              resetVersion={scopeResetVersion}
              disabled={scopeOwner === "workspace"}
              isRefreshing={wsListLoading}
              controlling={scopeOwner === "source"}
            />
            {(selectedWorkspaceIds.length > 0 || getActiveSourceLabels().length > 0) && (
              <button
                type="button"
                onClick={() => { void resetAllScopeFilters(); }}
                aria-label="Clear workspace and source filters"
                title="Show all workspaces and all sources"
                className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-white/[.14] text-[#E9EFED] opacity-80 transition-colors hover:bg-white/[.22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3621]/35"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="min-w-[2px] flex-1 sm:hidden" />

          {user && (
            <>
              <CopyableRailBadge
                value={accountInfo?.account_id || accountInfo?.account_name || "Databricks account"}
                text={accountInfo?.account_name || "Databricks account"}
                label="account ID"
                icon={<DuBoisAccountIcon />}
                tooltipAlign="start"
              />
              {authStatus && authStatus.identity !== "user_oauth" && (
                (authStatus.sp_object_id || authStatus.sp_client_id) && (
                  <CopyableRailBadge
                    value={authStatus.sp_object_id || authStatus.sp_client_id || ""}
                    text={authStatus.sp_display_name || authStatus.sp_object_id || authStatus.sp_client_id || ""}
                    label="service principal ID"
                    icon={<Bot className="h-2.5 w-2.5 opacity-70" aria-label="Service principal" />}
                  />
                )
              )}
              {warehouseStatus && (
                warehouseStatus.warehouse_id ? (
                  <CopyableRailBadge
                    value={warehouseStatus.warehouse_id}
                    text={warehouseStatus.warehouse_name?.trim()
                      || (warehouseStatus.status === "warm" ? "Active" : warehouseStatus.status === "warming_up" ? "Starting" : "Offline")}
                    label="SQL warehouse ID"
                    icon={<DatabricksSqlProductIcon />}
                  />
                ) : (
                  <RailBadgeTooltip text={`SQL warehouse status: ${warehouseStatus.state ?? warehouseStatus.status}.`}>
                    <span className={RAIL_STATUS_BADGE_CLASS}>
                      {warehouseStatus.status === "warm" ? "Active" : warehouseStatus.status === "warming_up" ? "Starting" : "Offline"}
                    </span>
                  </RailBadgeTooltip>
                )
              )}
              <UserMenu
                name={user.name}
                email={user.email}
                isAdmin={user.role === "admin"}
                workspaceHost={accountInfo?.host}
              />
              <div className="flex shrink-0 items-center gap-[4px]">
                <button
                  type="button"
                  onClick={openExportDialog}
                  aria-label="Export"
                  className="rail-control-border inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px] border bg-[#1B5F96] px-0 text-[11.5px] font-semibold text-white transition-colors hover:bg-[#2272B4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4D98D0]/50 focus-visible:ring-offset-1 focus-visible:ring-offset-[#1B3139] min-[1100px]:w-auto min-[1100px]:gap-1.5 min-[1100px]:px-[9px]"
                  title="Export"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="hidden min-[1100px]:inline">Export</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[6px] text-white opacity-80 transition-colors hover:bg-white/[.10] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3621]/35 focus-visible:ring-offset-1 focus-visible:ring-offset-[#1B3139]"
                  title="App Settings"
                  aria-label="App Settings"
                >
                  <Settings size={17} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {warehouseEverWarm && warehouseStatus && !warehouseReady && (
        <div
          role="status"
          className={`flex items-center justify-center gap-2 border-b px-4 py-1.5 text-xs font-medium ${
            warehouseStatus.status === "warming_up"
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {warehouseStatus.status === "warming_up" && <Spinner size="xs" />}
          <span>
            {warehouseStatus.status === "warming_up"
              ? "SQL Warehouse is starting. Dashboard queries are paused; showing the last loaded data."
              : "SQL Warehouse is temporarily unavailable. Dashboard queries are paused; showing the last loaded data."}
          </span>
        </div>
      )}
      {warehouseHealthCheckFailed && (
        <WarehouseHealthCheckBanner
          isRetrying={warehouseHealthChecking}
          onRetry={() => { void retryWarehouseHealthCheck(); }}
        />
      )}
      {warehouseStatus && (
        <WarehouseGuidanceBanner
          key={warehouseStatus.warehouse_id ?? "unbound"}
          warehouse={warehouseStatus}
          workspaceHost={accountInfo?.host}
        />
      )}
      <AccountPricingBanner />
      <SpGrantsBanner onOpenSettings={() => setShowSettings(true)} />

      <header className="bg-white">
        <div className="mx-auto max-w-7xl px-4 pt-8 pb-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <button type="button" onClick={() => setActiveTab("dbu")} title="Back to DBU Overview" className="cursor-pointer transition-opacity hover:opacity-80">
                <CostObsLockup />
              </button>
              <VersionPill />
            </div>
            <div className="w-full sm:ml-auto sm:w-auto">
              <DateRangePicker value={dateRange} onChange={setDateRange} />
            </div>
          </div>
          {/* Tab Navigation */}
          <DashboardTabNavigation
            activeTab={activeTab}
            visibility={runtimeTabVisibility}
            loading={{
              ...tabFetching,
              ...unresolvedTabDemand,
              ...(explicitRefreshingTab ? { [explicitRefreshingTab]: true } : {}),
            }}
            onChange={setActiveTab}
          />
        </div>
      </header>
      </div>{/* end sticky top chrome */}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div
          key={activeTab}
          id={`dashboard-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`dashboard-tab-${activeTab}`}
          tabIndex={0}
          className="animate-fade-in relative focus-visible:outline-none focus-visible:shadow-(--focus)"
        >
        <TabRefreshRegion
          isLoading={showActiveTabLoading}
          isRefreshing={explicitRefreshingTab !== null}
          loadingSections={TAB_LOADING_SECTIONS[activeTab]}
          onRefresh={handleTabRefresh}
          onDismissRefreshError={() => {
            setRefreshErrors((current) => ({ ...current, [activeTab]: undefined }));
          }}
          refreshError={refreshErrors[activeTab]}
        >
        <Suspense fallback={
          <LoadingPanels sections={TAB_LOADING_SECTIONS[activeTab]} />
        }>
        {activeTab === "dbu" ? (
          shouldShowDbuSkeleton(warehouseQueriesAllowed, bundleLoading) ? (
            <LoadingPanels sections={[
              "Spend Over Time",
              "Spend by Product",
              "Spend by SKU",
              "Workspace Breakdown",
              "Jobs and Pipelines",
              "Interactive Compute",
            ]} />
          ) : (
          <TabErrorBoundary tabName="DBU Overview">
          <div className="space-y-6">
            <DBUMethodologyPanel />
            {/* Header */}
            <PageHero
              icon={<span className="font-mono text-xl font-bold">$</span>}
              title="DBU Overview"
              dateRange={dateRange}
              subtitle="Databricks Unit consumption and cost breakdown"
              workspaceScope={_wsIds && _wsIds.length > 0
                ? _wsIds.length === 1
                  ? workspaceNameMap[_wsIds[0]] || _wsIds[0]
                  : `${_wsIds.length} workspaces`
                : undefined}
            />


            <SummaryCards
              data={summary}
              isLoading={bundleLoading}
              startDate={dateRange.startDate}
              endDate={dateRange.endDate}
              workspaceIds={_wsIds}
              workspaceScopeCount={workspaceScopeCount}
            />

            <SpendChart data={timeseries} isLoading={bundleLoading} />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <ProductBreakdown data={products} isLoading={bundleLoading} workspaces={workspaces?.workspaces?.length ? workspaces.workspaces : wsFilterList} dateRange={dateRange} workspaceNameMap={workspaceNameMap} />
              <SKUBreakdown data={skuBreakdown} isLoading={skuLoading} workspaces={workspaces?.workspaces?.length ? workspaces.workspaces : wsFilterList} dateRange={dateRange} workspaceNameMap={workspaceNameMap} />
            </div>

            <WorkspaceTable data={workspaces} isLoading={bundleLoading} host={accountInfo?.host} workspaceNameMap={workspaceNameMap} />

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
            infraData={pricedInfraCosts}
            infraLoading={infraBundleLoading}
            infraTimeseriesData={infraCostsTimeseries}
            infraTimeseriesLoading={infraBundleLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            detectedCloud={accountInfo?.cloud || undefined}
            workspaceNameMap={workspaceNameMap}
            workspaceIds={_wsIds}
            accountPricingApplied={useAccountPrices && accountPricesAvailable}
            loadError={infraBundleErrorObject?.message}
            partialReasons={cloudCostsBundle?.partial_reasons}
          />
          </TabErrorBoundary>
        ) : activeTab === "optimizer" ? (
          <TabErrorBoundary tabName="Optimize">
          <div className="space-y-6">
            <OptimizeMethodologyPanel />
            <PageHero
              dateRange={dateRange}
              icon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
              }
              title="Optimize"
              subtitle="Rightsizing recommendations and cost optimization insights"
              workspaceScope={_wsIds && _wsIds.length > 0
                ? _wsIds.length === 1
                  ? workspaceNameMap[_wsIds[0]] || _wsIds[0]
                  : `${_wsIds.length} workspaces`
                : undefined}
            />
            <WarehouseIdleTimeView
              host={accountInfo?.host}
              data={optimizeIdleData}
              isLoading={optimizeIdleLoading}
              isError={optimizeIdleError}
            />
            <WarehouseRightsizingView
              host={accountInfo?.host}
              data={optimizeRightsizingData}
              isLoading={optimizeRightsizingLoading}
              isError={optimizeRightsizingError}
            />
          </div>
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
            isError={aimlError}
            error={aimlErrorObj}
            onRetry={() => { void retryScheduledTab("aiml", refetchAiml); }}
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
            isError={appsError}
            error={appsErrorObj}
            onRetry={() => { void retryScheduledTab("apps", refetchApps); }}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
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
            queryData={dbsqlData ?? undefined}
            isLoading={sqlLoading || dbsqlLoading}
            isError={dbsqlError}
            topQueriesData={dbsqlTopQueriesData}
            topQueriesLoading={dbsqlTopQueriesLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : activeTab === "users-groups" ? (
          <TabErrorBoundary tabName="Users">
          <UsersGroups
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            data={usersGroupsData}
            isLoading={usersGroupsLoading}
            isError={usersGroupsError}
            onRetry={() => { void retryScheduledTab("users-groups", refetchUsersGroups); }}
            anonymizeUsers={appSettings.anonymizeUsers}
            workspaceIds={_wsIds}
            workspaceNameMap={workspaceNameMap}
          />
          </TabErrorBoundary>
        ) : null}
        </Suspense>
        </TabRefreshRegion>
        </div>
      </main>

      <Footer />

      <ExportDialog
        isOpen={showExportDialog}
        onClose={closeExportDialog}
        onExport={handleExport}
        enableArchitectureView={appSettings.enableArchitectureView}
        isAdmin={user?.role === "admin"}
        onExportArchitecture={handleArchitectureExport}
        tabVisibility={tabVisibility}
        dataLoading={exportPreparing}
        dataPrepared={exportDataPrepared}
        requiredTabs={exportDemand?.tabs ?? []}
        tabLoading={tabLoading}
        dataErrors={tabErrors}
        onPrepare={prepareExportData}
        onSelectionChange={resetExportDemand}
        onRetryFailed={retryFailedExportData}
      />

      {showSettings && (
      <Suspense fallback={null}>
        <SettingsDialog
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        tabVisibility={tabVisibility}
        appSettings={appSettings}
        onTabVisibilityChange={(v) => {
          setTabVisibility(v);
          // If the active tab was hidden, switch to the first visible tab.
          if (!v[activeTab as keyof typeof v]) {
            const firstVisible = (Object.keys(v) as ViewTab[]).find((k) => v[k as keyof typeof v]);
            if (firstVisible) setActiveTab(firstVisible);
          }
        }}
        onSettingsChange={setAppSettings}
      />
      </Suspense>
      )}
    </div>
    </SpNameMapContext.Provider>
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
        <div className="flex flex-col items-center justify-center py-16 px-8 rounded-lg bg-white border " style={{ borderColor: C.hairline }}>
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
            style={{ backgroundColor: C.lava }}
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
  useTransientScrollbarBehavior();
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
