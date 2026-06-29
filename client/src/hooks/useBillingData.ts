import { useQuery } from "@tanstack/react-query";
import type {
  AccountInfo,
  AWSCostsResponse,
  AWSActualDashboardBundle,
  AzureActualDashboardBundle,
  GCPActualDashboardBundle,
  BillingSummary,
  ProductBreakdownResponse,
  WorkspaceBreakdownResponse,
  TimeseriesResponse,
  GranularBreakdownResponse,
  PipelineObjectsResponse,
  InteractiveBreakdownResponse,
  SKUBreakdownResponse,
  SpendAnomaliesResponse,
  PlatformKPIsResponse,
  DashboardBundleFast,
  DateRange,
  AIMLDashboardBundle,
  AppsDashboardBundle,
  TaggingDashboardBundle,
  DBSQLDashboardBundle,
  InfraCostsResponse,
  InfraCostsTimeseriesResponse,
  InfraBundleResponse,
  KPIsBundleResponse,
} from "@/types/billing";

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDefaultStartDate(days: number = 30): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatLocalDate(date);
}

function getDefaultEndDate(): string {
  // Buffer by one day: today's cost data is incomplete/inaccurate
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return formatLocalDate(yesterday);
}

// Billing data changes infrequently; 5 min staleTime prevents
// unnecessary refetches on tab focus / component remount.
const STALE_TIME = 5 * 60 * 1000;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = `${response.status}: ${body.detail}`;
    } catch { /* ignore parse errors */ }
    throw new Error(detail);
  }
  return response.json();
}

function buildUrl(endpoint: string, dateRange?: DateRange): string {
  const params = new URLSearchParams();
  if (dateRange?.startDate) {
    params.set("start_date", dateRange.startDate);
  }
  if (dateRange?.endDate) {
    params.set("end_date", dateRange.endDate);
  }
  const queryString = params.toString();
  return queryString ? `${endpoint}?${queryString}` : endpoint;
}

function buildUrlWithWs(endpoint: string, dateRange?: DateRange, workspaceIds?: string[]): string {
  const base = buildUrl(endpoint, dateRange);
  const wsKey = workspaceIds?.length ? workspaceIds.join(",") : null;
  if (!wsKey) return base;
  return `${base}${base.includes("?") ? "&" : "?"}workspace_ids=${encodeURIComponent(wsKey)}`;
}


export function useBillingSummary(dateRange?: DateRange) {
  return useQuery<BillingSummary>({
    queryKey: ["billing", "summary", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/summary", dateRange)),
    staleTime: STALE_TIME,
  });
}

export function useBillingByProduct(dateRange?: DateRange) {
  return useQuery<ProductBreakdownResponse>({
    queryKey: ["billing", "by-product", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/by-product", dateRange)),
    staleTime: STALE_TIME,
  });
}

export function useBillingByWorkspace(dateRange?: DateRange) {
  return useQuery<WorkspaceBreakdownResponse>({
    queryKey: ["billing", "by-workspace", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/by-workspace", dateRange)),
    staleTime: STALE_TIME,
  });
}

export function useBillingTimeseries(dateRange?: DateRange) {
  return useQuery<TimeseriesResponse>({
    queryKey: ["billing", "timeseries", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/timeseries", dateRange)),
    staleTime: STALE_TIME,
  });
}

export function useSqlBreakdown(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<GranularBreakdownResponse>({
    queryKey: ["billing", "sql-breakdown", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/billing/sql-breakdown", dateRange, workspaceIds)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function useEtlBreakdown(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<GranularBreakdownResponse>({
    queryKey: ["billing", "etl-breakdown", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/etl-breakdown", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function usePipelineObjects(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<PipelineObjectsResponse>({
    queryKey: ["billing", "pipeline-objects", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/billing/pipeline-objects", dateRange, workspaceIds)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function useInteractiveBreakdown(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<InteractiveBreakdownResponse>({
    queryKey: ["billing", "interactive-breakdown", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/billing/interactive-breakdown", dateRange, workspaceIds)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function useAWSCosts(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<AWSCostsResponse>({
    queryKey: ["billing", "aws-costs", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/aws-costs", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function useAWSCostsTimeseries(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<TimeseriesResponse>({
    queryKey: ["billing", "aws-costs-timeseries", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/aws-costs-timeseries", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

/**
 * Multi-cloud infrastructure costs - automatically detects AWS or Azure
 */
export function useInfraCosts(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<InfraCostsResponse>({
    queryKey: ["billing", "infra-costs", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/infra-costs", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

/**
 * Multi-cloud infrastructure costs timeseries
 */
export function useInfraCostsTimeseries(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<InfraCostsTimeseriesResponse>({
    queryKey: ["billing", "infra-costs-timeseries", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/infra-costs-timeseries", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function useAccountInfo() {
  // Fast call — returns instantly from host URL detection (no SQL)
  const fast = useQuery<AccountInfo>({
    queryKey: ["billing", "account"],
    queryFn: () => fetchJson("/api/billing/account"),
    staleTime: Infinity,
  });

  // Slow call — backfills account_id from billing data (may take seconds)
  const details = useQuery<{ account_id: string | null; cloud: string | null }>({
    queryKey: ["billing", "account-details"],
    queryFn: () => fetchJson("/api/billing/account-details"),
    staleTime: Infinity,
    enabled: !!fast.data,
  });

  // Merge: fast data + account_id from slow query
  const merged = fast.data ? {
    ...fast.data,
    account_id: details.data?.account_id || fast.data.account_id,
    cloud: details.data?.cloud || fast.data.cloud,
  } : undefined;

  return { ...fast, data: merged as AccountInfo | undefined };
}

export function useDefaultDateRange(days: number = 30): DateRange {
  return {
    startDate: getDefaultStartDate(days),
    endDate: getDefaultEndDate(),
  };
}

export function useSKUBreakdown(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<SKUBreakdownResponse>({
    queryKey: ["billing", "sku-breakdown", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/billing/sku-breakdown", dateRange, workspaceIds)),
    staleTime: STALE_TIME,
    enabled,
  });
}

// ── Users & Groups types ──────────────────────────────────────────────────────

export interface UserSpend {
  user_email: string;
  total_spend: number;
  total_dbus: number;
  active_days: number;
  workspace_count: number;
  percentage: number;
  primary_product: string;
  products: { product: string; spend: number }[];
}

export interface UsersGroupsBundle {
  summary: {
    user_count: number;
    workspace_count: number;
    total_spend: number;
    total_dbus: number;
    avg_spend_per_user: number;
    spend_growth_pct: number | null;
  };
  top_users: UserSpend[];
  timeseries: Array<{ date: string; [user: string]: string | number }>;
  timeseries_users: string[];
  by_workspace: { workspace_id: string; user_count: number; total_spend: number }[];
  user_growth: UserGrowthPoint[];
  start_date: string;
  end_date: string;
}

export function useUsersGroupsBundle(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<UsersGroupsBundle>({
    queryKey: ["users-groups", "bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/users-groups/bundle", dateRange, workspaceIds)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export interface UserGrowthPoint {
  month: string;
  active_users: number;
  new_users: number;
}

export function useUserGrowth() {
  return useQuery<{ data: UserGrowthPoint[] }>({
    queryKey: ["users-groups", "growth"],
    queryFn: () => fetchJson("/api/users-groups/user-growth"),
    staleTime: STALE_TIME,
  });
}

export interface ReportConfig {
  weekly_reports: Array<{
    id: string;
    email: string;
    name: string;
    send_day: string;
    enabled: boolean;
    created_at: string;
  }>;
  user_alerts: Array<{
    id: string;
    email: string;
    name: string;
    threshold_amount: number | null;
    spike_percent: number | null;
    enabled: boolean;
    created_at: string;
  }>;
}

export function useReportConfig() {
  return useQuery<ReportConfig>({
    queryKey: ["users-groups", "report-config"],
    queryFn: () => fetchJson("/api/users-groups/report-config"),
    staleTime: 60 * 1000,
  });
}

export function useSpendAnomalies(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<SpendAnomaliesResponse>({
    queryKey: ["billing", "spend-anomalies", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/spend-anomalies", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

export function usePlatformKPIs(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<PlatformKPIsResponse>({
    queryKey: ["billing", "platform-kpis", dateRange],
    queryFn: () => fetchJson(buildUrl("/api/billing/platform-kpis", dateRange)),
    staleTime: STALE_TIME,
    enabled,
  });
}

/**
 * Fast dashboard bundle - optimized for quick initial page load.
 * Skips slow query.history joins for 5-10x faster load times.
 * Use this for initial load, then lazy-load detailed breakdowns.
 */
export function useDashboardBundleFast(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  const wsKey = workspaceIds?.length ? workspaceIds.join(",") : null;
  return useQuery<DashboardBundleFast>({
    queryKey: ["billing", "dashboard-bundle-fast", dateRange, wsKey],
    queryFn: () => {
      const base = buildUrl("/api/billing/dashboard-bundle-fast", dateRange);
      const url = wsKey
        ? `${base}${base.includes("?") ? "&" : "?"}workspace_ids=${encodeURIComponent(wsKey)}`
        : base;
      return fetchJson(url);
    },
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

const POLL_INTERVAL_MS = 2000;

async function fetchWithPoll<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 202) {
    return null; // still computing — caller will poll
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = `${response.status}: ${body.detail}`;
    } catch { /* ignore parse errors */ }
    throw new Error(detail);
  }
  const data = await response.json() as T & { _error?: string };
  if (data && typeof data === "object" && "_error" in data) {
    throw new Error((data as { _error: string })._error || "Bundle compute failed");
  }
  return data;
}

/**
 * AI/ML 360 dashboard bundle — submit-and-poll: returns null while computing, data when ready.
 * isLoading is true while data is null (pending or first fetch).
 */
export function useAIMLDashboardBundle(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  const result = useQuery<AIMLDashboardBundle | null>({
    queryKey: ["aiml", "dashboard-bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchWithPoll<AIMLDashboardBundle>(buildUrlWithWs("/api/aiml/dashboard-bundle", dateRange, workspaceIds)),
    enabled,
    refetchInterval: (q) => q.state.data === null ? POLL_INTERVAL_MS : false,
  });
  return {
    ...result,
    data: (result.data ?? undefined) as AIMLDashboardBundle | undefined,
    isLoading: result.isLoading || result.data === null,
  };
}

/**
 * Apps dashboard bundle — submit-and-poll: returns null while computing, data when ready.
 * isLoading is true while data is null (pending or first fetch).
 */
export function useAppsDashboardBundle(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  const result = useQuery<AppsDashboardBundle | null>({
    queryKey: ["apps", "dashboard-bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchWithPoll<AppsDashboardBundle>(buildUrlWithWs("/api/apps/dashboard-bundle", dateRange, workspaceIds)),
    enabled,
    refetchInterval: (q) => q.state.data === null ? POLL_INTERVAL_MS : false,
  });
  return {
    ...result,
    data: (result.data ?? undefined) as AppsDashboardBundle | undefined,
    isLoading: result.isLoading || result.data === null,
  };
}

/**
 * Tagging Hub dashboard bundle
 * @param dateRange - Date range for the query
 * @param enabled - Whether to enable the query (set false when tab not active)
 */
export function useTaggingDashboardBundle(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<TaggingDashboardBundle>({
    queryKey: ["tagging", "dashboard-bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/tagging/dashboard-bundle", dateRange, workspaceIds)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/**
 * AWS Actual Costs - from CUR 2.0 data when available
 * @param dateRange - Date range for the query
 * @param enabled - Whether to enable the query (set false when tab not active)
 */
export function useAWSActualCosts(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<AWSActualDashboardBundle>({
    queryKey: ["aws-actual", "dashboard-bundle", dateRange],
    queryFn: () =>
      fetchJson(buildUrl("/api/aws-actual/dashboard-bundle", dateRange)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

export function useAzureActualCosts(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<AzureActualDashboardBundle>({
    queryKey: ["azure-actual", "dashboard-bundle", dateRange],
    queryFn: () =>
      fetchJson(buildUrl("/api/azure-actual/dashboard-bundle", dateRange)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

export function useGCPActualCosts(dateRange?: DateRange, enabled: boolean = true) {
  return useQuery<GCPActualDashboardBundle>({
    queryKey: ["gcp-actual", "dashboard-bundle", dateRange],
    queryFn: () =>
      fetchJson(buildUrl("/api/gcp-actual/dashboard-bundle", dateRange)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/**
 * DBSQL Query Cost Attribution - from cost per query MV
 * @param dateRange - Date range for the query
 * @param enabled - Whether to enable the query (set false when tab not active)
 */
/**
 * DBSQL 360 dashboard bundle — submit-and-poll: returns null while computing, data when ready.
 * isLoading is true while data is null (pending or first fetch).
 */
export function useDBSQLQueryCosts(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<DBSQLDashboardBundle | null>({
    queryKey: ["dbsql", "dashboard-bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () =>
      fetchWithPoll<DBSQLDashboardBundle>(buildUrlWithWs("/api/dbsql/dashboard-bundle", dateRange, workspaceIds)),
    staleTime: 5 * 60 * 1000,
    enabled,
    refetchInterval: (q) => q.state.data === null ? POLL_INTERVAL_MS : false,
  });
}

export function useDBSQLTopQueries(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<import("@/types/billing").TopQueriesResponse>({
    queryKey: ["dbsql", "top-queries", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () =>
      fetchJson(buildUrlWithWs("/api/dbsql/top-queries", dateRange, workspaceIds)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/**
 * Bundled infrastructure costs - fetches clusters, instance families, and timeseries
 * in a single request with server-side parallel execution.
 */
export function useInfraBundle(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<InfraBundleResponse>({
    queryKey: ["billing", "infra-bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/billing/infra-bundle", dateRange, workspaceIds)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/**
 * Bundled KPIs - fetches platform KPIs and spend anomalies
 * in a single request with server-side parallel execution.
 */
export function useKPIsBundle(dateRange?: DateRange, workspaceIds?: string[], enabled: boolean = true) {
  return useQuery<KPIsBundleResponse>({
    queryKey: ["billing", "kpis-bundle", dateRange, workspaceIds?.join(",") ?? null],
    queryFn: () => fetchJson(buildUrlWithWs("/api/billing/kpis-bundle", dateRange, workspaceIds)),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}
