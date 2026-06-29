import { useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { UntaggedResourcesTable } from "./UntaggedResourcesTable";
import type { UntaggedTab } from "./UntaggedResourcesTable";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import type { TaggingDashboardBundle } from "@/types/billing";
import { KPITrendModal } from "./KPITrendModal";

interface TaggingHubProps {
  data: TaggingDashboardBundle | undefined;
  isLoading: boolean;
  host?: string | null;
  startDate?: string;
  endDate?: string;
  workspaceIds?: string[];
  workspaceNameMap?: Record<string, string>;
}


const COLORS = {
  tagged: "#10b981",
  untagged: "#ef4444",
};

const TAG_COLORS = ["#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B", "#3B82F6", "#EC4899", "#EF4444", "#6B7280"];

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="ml-1.5 inline-flex cursor-help"
      onMouseEnter={e => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-500">i</span>
      {pos && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] w-72 rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal leading-relaxed text-white shadow-lg"
          style={{ top: pos.y - 12, transform: "translateY(-100%)", left: Math.min(pos.x + 14, window.innerWidth - 296) }}
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

export function TaggingHub({ data, isLoading, host, startDate, endDate, workspaceIds, workspaceNameMap }: TaggingHubProps) {
  const [activeUntaggedTab, setActiveUntaggedTab] = useState<UntaggedTab>("clusters");
  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<string>("total_spend");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [showHistoricalUntagged, setShowHistoricalUntagged] = useState(false);
  const daysDiff = startDate && endDate
    ? Math.max(1, Math.abs(Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24))) + 1)
    : 30;

  // Tag key filter state (for Spend by Key chart)
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([]);
  const [tagFilterDropdownOpen, setTagFilterDropdownOpen] = useState(false);
  const [tagFilterSearch, setTagFilterSearch] = useState("");

  // Tag value filter state (for Spend by Tag table)
  const [selectedTagValueFilters, setSelectedTagValueFilters] = useState<string[]>([]);
  const [tagValueFilterDropdownOpen, setTagValueFilterDropdownOpen] = useState(false);
  const [tagValueFilterSearch, setTagValueFilterSearch] = useState("");

  // Tag drilldown state
  const [selectedTag, setSelectedTag] = useState<{tag_key: string; tag_value: string} | null>(null);
  const [tagObjectsCache, setTagObjectsCache] = useState<Record<string, any[]>>({});
  const [tagObjectsLoading, setTagObjectsLoading] = useState(false);
  const tagObjects = selectedTag ? (tagObjectsCache[`${selectedTag.tag_key}::${selectedTag.tag_value}`] || []) : [];

  const handleTagClick = (tagKey: string, tagValue: string) => {
    setSelectedTag({ tag_key: tagKey, tag_value: tagValue });
    const cacheKey = `${tagKey}::${tagValue}`;
    if (!tagObjectsCache[cacheKey]) {
      setTagObjectsLoading(true);
      const params = new URLSearchParams({ tag_key: tagKey, tag_value: tagValue });
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      fetch(`/api/tagging/top-objects-by-tag?${params}`)
        .then((res) => res.json())
        .then((result) => {
          setTagObjectsCache((prev) => ({ ...prev, [cacheKey]: result.objects || [] }));
        })
        .catch(() => {
          setTagObjectsCache((prev) => ({ ...prev, [cacheKey]: [] }));
        })
        .finally(() => setTagObjectsLoading(false));
    }
  };

  // Reset page/search when tab changes
  const handleTabChange = useCallback((tab: UntaggedTab) => {
    setActiveUntaggedTab(tab);
    setCurrentPage(1);
    setSearchQuery("");
    setSortField("total_spend");
    setSortDirection("desc");
  }, []);

  const handleSort = useCallback((field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setCurrentPage(1);
  }, [sortField]);

  // Pre-warm trend queries so modals open instantly
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["tagged_spend", "untagged_spend", "total_spend"]) {
      queryClient.prefetchQuery({
        queryKey: ["kpi-trend", kpi, startDate, endDate, "daily"],
        queryFn: async () => {
          const params = new URLSearchParams({ kpi, start_date: startDate, end_date: endDate, granularity: "daily" });
          const res = await fetch(`/api/billing/kpi-trend?${params}`);
          if (!res.ok) throw new Error("prefetch failed");
          return res.json();
        },
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [startDate, endDate, queryClient]);

  // Info box minimize state with localStorage persistence
  const MINIMIZE_KEY = "cost-obs-minimize-tagging-info";
  const [infoMinimized, setInfoMinimized] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(MINIMIZE_KEY) === "true";
    }
    return false;
  });

  const handleMinimizeToggle = (checked: boolean) => {
    setInfoMinimized(checked);
    if (checked) {
      localStorage.setItem(MINIMIZE_KEY, "true");
    } else {
      localStorage.removeItem(MINIMIZE_KEY);
    }
  };

  const coveragePieData = useMemo(() => {
    if (!data?.summary) return [];
    return [
      { name: "Tagged", value: data.summary.tagged_spend, fill: COLORS.tagged },
      { name: "Untagged", value: data.summary.untagged_spend, fill: COLORS.untagged },
    ];
  }, [data?.summary]);

  const tagBreakdownData = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    // Group by tag key and aggregate
    const byKey: Record<string, number> = {};
    for (const tag of data.cost_by_tag.tags) {
      if (!byKey[tag.tag_key]) {
        byKey[tag.tag_key] = 0;
      }
      byKey[tag.tag_key] += tag.total_spend;
    }
    return Object.entries(byKey)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, spend], idx) => ({
        tag_key: key,
        total_spend: spend,
        fill: TAG_COLORS[idx % TAG_COLORS.length],
      }));
  }, [data?.cost_by_tag]);

  const untaggedCounts = useMemo(() => {
    if (!data?.untagged) return { clusters: 0, jobs: 0, pipelines: 0, warehouses: 0, endpoints: 0 };
    return {
      clusters: data.untagged.clusters?.count || 0,
      jobs: data.untagged.jobs?.count || 0,
      pipelines: data.untagged.pipelines?.count || 0,
      warehouses: data.untagged.warehouses?.count || 0,
      endpoints: data.untagged.endpoints?.count || 0,
    };
  }, [data?.untagged]);

  // Compute suggested tags based on what's already used in the environment
  const suggestedTags = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];

    // Get unique tag keys and their usage counts
    const tagKeyUsage: Record<string, { count: number; examples: string[] }> = {};
    for (const tag of data.cost_by_tag.tags) {
      if (!tagKeyUsage[tag.tag_key]) {
        tagKeyUsage[tag.tag_key] = { count: 0, examples: [] };
      }
      tagKeyUsage[tag.tag_key].count += tag.workspace_count || 1;
      if (tagKeyUsage[tag.tag_key].examples.length < 3 && !tagKeyUsage[tag.tag_key].examples.includes(tag.tag_value)) {
        tagKeyUsage[tag.tag_key].examples.push(tag.tag_value);
      }
    }

    // Sort by usage and return top tag keys with example values
    return Object.entries(tagKeyUsage)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([key, info]) => ({
        key,
        usageCount: info.count,
        examples: info.examples,
      }));
  }, [data?.cost_by_tag]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!tagFilterDropdownOpen && !tagValueFilterDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (tagFilterDropdownOpen && !target.closest("[data-tag-filter-dropdown]")) {
        setTagFilterDropdownOpen(false);
      }
      if (tagValueFilterDropdownOpen && !target.closest("[data-tag-value-filter-dropdown]")) {
        setTagValueFilterDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [tagFilterDropdownOpen, tagValueFilterDropdownOpen]);

  // All unique tag keys for the filter dropdown
  const availableTagKeys = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    const keys = new Set<string>();
    for (const tag of data.cost_by_tag.tags) {
      keys.add(tag.tag_key);
    }
    return Array.from(keys).sort();
  }, [data?.cost_by_tag]);

  // All unique tag key:value pairs for the tag filter dropdown
  const availableTagValues = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    return data.cost_by_tag.tags
      .map(tag => `${tag.tag_key}:${tag.tag_value}`)
      .sort();
  }, [data?.cost_by_tag]);

  // Filtered tag data based on selected tag value filters
  const filteredTags = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    if (selectedTagValueFilters.length === 0) return data.cost_by_tag.tags;
    return data.cost_by_tag.tags.filter(tag =>
      selectedTagValueFilters.includes(`${tag.tag_key}:${tag.tag_value}`)
    );
  }, [data?.cost_by_tag, selectedTagValueFilters]);

  // Filtered tag breakdown (Spend by Key chart) based on selected filters
  const filteredTagBreakdownData = useMemo(() => {
    if (selectedTagFilters.length === 0) return tagBreakdownData;
    const byKey: Record<string, number> = {};
    for (const tag of filteredTags) {
      if (!byKey[tag.tag_key]) byKey[tag.tag_key] = 0;
      byKey[tag.tag_key] += tag.total_spend;
    }
    return Object.entries(byKey)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, spend], idx) => ({
        tag_key: key,
        total_spend: spend,
        fill: TAG_COLORS[idx % TAG_COLORS.length],
      }));
  }, [filteredTags, selectedTagFilters, tagBreakdownData]);

  const handleToggleTagFilter = useCallback((key: string) => {
    setSelectedTagFilters(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
    setCurrentPage(1);
  }, []);

  const handleClearTagFilters = useCallback(() => {
    setSelectedTagFilters([]);
    setCurrentPage(1);
  }, []);

  const handleToggleTagValueFilter = useCallback((keyValue: string) => {
    setSelectedTagValueFilters(prev =>
      prev.includes(keyValue) ? prev.filter(kv => kv !== keyValue) : [...prev, keyValue]
    );
    setCurrentPage(1);
  }, []);

  const handleClearTagValueFilters = useCallback(() => {
    setSelectedTagValueFilters([]);
    setCurrentPage(1);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading tagging data...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6">
        <p className="text-yellow-700">No tagging data available for the selected date range.</p>
      </div>
    );
  }

  const summary = data.summary;


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tagging</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-gray-500">Cost attribution through resource tagging coverage</p>
            {workspaceIds && workspaceIds.length > 0 && (
              <span className="rounded bg-[#1B3139]/10 px-2 py-0.5 text-[10px] font-medium text-[#1B3139]">
                {workspaceIds.length === 1 ? (workspaceNameMap?.[workspaceIds[0]] || workspaceIds[0]) : `${workspaceIds.length} workspaces`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Info Banner */}
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3 flex-1">
            <button className="flex w-full items-center justify-between" onClick={() => handleMinimizeToggle(!infoMinimized)}>
              <h3 className="text-sm font-medium text-orange-800">Tagging Best Practices</h3>
              <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {!infoMinimized && (
              <>
                <div className="mt-2 text-sm text-orange-700">
                  <ul className="list-inside list-disc space-y-1">
                    <li>Add <strong>custom_tags</strong> to clusters, jobs, and endpoints for cost attribution</li>
                    <li>Use consistent tag keys like <code>Owner</code>, <code>Team</code>, <code>Project</code>, <code>CostCenter</code></li>
                    <li>Tags propagate to billing usage records for chargeback and reporting</li>
                    <li>Higher tag coverage = better cost visibility and accountability</li>
                  </ul>
                </div>
                <div className="mt-3 flex justify-start">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={infoMinimized}
                      onChange={(e) => handleMinimizeToggle(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                    />
                    <span className="text-xs text-orange-600">Minimize from now on</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "tagged_spend", label: "Tagged Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Tagged Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.tagged_spend)}</p>
              <p className="text-sm text-gray-500">{(summary.tagged_percentage ?? 0).toFixed(1)}% of {daysDiff}-day spend</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "untagged_spend", label: "Untagged Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Untagged Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.untagged_spend)}</p>
              <p className="text-sm text-gray-500">{(summary.untagged_percentage ?? 0).toFixed(1)}% of {daysDiff}-day spend</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "cost_per_tag", label: "Daily Cost Per Tag" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Cost Per Tag</p>
              <p className="text-2xl font-semibold text-gray-900">
                {data?.avg_cost_per_tag != null ? formatCurrency(data.avg_cost_per_tag) : "—"}
              </p>
              <p className="text-sm text-gray-500">{data?.total_tag_count != null ? data.total_tag_count.toLocaleString() : "—"} tags over {daysDiff} days</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "total_tags", label: "Daily Total Tags" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="flex items-center text-sm font-medium text-gray-500">
                Total Tags
                <InfoTooltip text="Distinct tag key-value pairs applied across all resources over the full date range. The trend drilldown shows per-day counts — a tag on a long-running resource is counted each day it appears, so daily totals are lower than this cumulative figure." />
              </p>
              <p className="text-2xl font-semibold text-gray-900">{data?.total_tag_count?.toLocaleString() ?? "—"}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Trend Modal */}
      {selectedKPI && startDate && endDate && (
        <KPITrendModal
          kpi={selectedKPI.kpi as any}
          kpiLabel={selectedKPI.label}
          isOpen={!!selectedKPI}
          onClose={() => setSelectedKPI(null)}
          startDate={startDate}
          endDate={endDate}
          workspaceIds={workspaceIds}
        />
      )}

      {/* Tag Coverage + Tag Coverage Over Time — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Tag Coverage Pie Chart */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Total Tag Coverage</h3>
          {coveragePieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={coveragePieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${formatCurrency(value)}`}
                  labelLine={false}
                >
                  {coveragePieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrency(value as number)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No coverage data</div>
          )}
        </div>

        {/* Tag Coverage Over Time */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Tag Coverage Over Time</h3>
          {data.timeseries?.timeseries?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={data.timeseries.timeseries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  stroke="#9ca3af"
                  fontSize={12}
                  tickMargin={8}
                />
                <YAxis tickFormatter={(value) => formatCurrency(value)} width={80} stroke="#9ca3af" fontSize={12} />
                <Tooltip
                  formatter={(value) => formatCurrency(value as number)}
                  labelFormatter={(label) => new Date(label).toLocaleDateString()}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="Tagged"
                  stackId="1"
                  stroke={COLORS.tagged}
                  fill={COLORS.tagged}
                  fillOpacity={0.6}
                />
                <Area
                  type="monotone"
                  dataKey="Untagged"
                  stackId="1"
                  stroke={COLORS.untagged}
                  fill={COLORS.untagged}
                  fillOpacity={0.6}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
          )}
        </div>
      </div>

      {/* Spend by Tag + Spend by Key — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Spend by Tag Table (left) */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">
              Spend by Tag
              {selectedTagValueFilters.length > 0 && (
                <span className="ml-2 text-sm font-normal text-gray-500">({filteredTags.length} results)</span>
              )}
            </h3>
            {availableTagValues.length > 0 && (
              <div className="relative" data-tag-value-filter-dropdown>
                <button
                  onClick={() => { setTagValueFilterDropdownOpen(!tagValueFilterDropdownOpen); setTagValueFilterSearch(""); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Filter
                  {selectedTagValueFilters.length > 0 && (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#FF3621' }}>
                      {selectedTagValueFilters.length}
                    </span>
                  )}
                </button>
                {tagValueFilterDropdownOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
                    <div className="p-2">
                      <input
                        type="text"
                        value={tagValueFilterSearch}
                        onChange={(e) => setTagValueFilterSearch(e.target.value)}
                        placeholder="Search tags..."
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {availableTagValues
                        .filter(kv => !tagValueFilterSearch || kv.toLowerCase().includes(tagValueFilterSearch.toLowerCase()))
                        .map(kv => {
                          const [key, ...rest] = kv.split(":");
                          const value = rest.join(":");
                          return (
                            <button
                              key={kv}
                              onClick={() => handleToggleTagValueFilter(kv)}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                            >
                              <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selectedTagValueFilters.includes(kv) ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                                {selectedTagValueFilters.includes(kv) && (
                                  <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                              <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800">{key}</span>
                              <span className="truncate text-xs text-gray-600">{value}</span>
                            </button>
                          );
                        })}
                      {availableTagValues.filter(kv => !tagValueFilterSearch || kv.toLowerCase().includes(tagValueFilterSearch.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching tags</div>
                      )}
                    </div>
                    {selectedTagValueFilters.length > 0 && (
                      <div className="border-t border-gray-200 p-2">
                        <button onClick={handleClearTagValueFilters} className="w-full rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100">
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Tag value filter pills */}
          {selectedTagValueFilters.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {selectedTagValueFilters.map(kv => {
                const [key, ...rest] = kv.split(":");
                const value = rest.join(":");
                return (
                  <span key={kv} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: '#FF3621' }}>
                    {key}: {value}
                    <button onClick={() => handleToggleTagValueFilter(kv)} className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-white/20">
                      <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                );
              })}
              <button onClick={handleClearTagValueFilters} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          )}
          {filteredTags.length > 0 ? (
            <div className="max-h-75 overflow-y-auto">
              <table className="w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500" style={{ width: '100px' }}>Key</th>
                    <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Value</th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredTags.slice(0, 20).map((tag, idx) => (
                    <tr key={idx} className="cursor-pointer hover:bg-gray-50" onClick={() => handleTagClick(tag.tag_key, tag.tag_value)}>
                      <td className="whitespace-nowrap px-2 py-2 text-xs font-medium text-gray-900" style={{ width: '100px', maxWidth: '100px' }}>
                        <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-800 truncate inline-block max-w-full" title={tag.tag_key}>{tag.tag_key}</span>
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500 max-w-28 truncate" title={tag.tag_value}>{tag.tag_value}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right text-xs font-medium text-gray-900">{formatCurrency(tag.total_spend)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <div className="h-1.5 w-10 overflow-hidden rounded-full bg-gray-200">
                            <div className="h-full rounded-full bg-orange-500" style={{ width: `${tag.percentage}%` }} />
                          </div>
                          <span className="text-xs text-gray-500">{(tag.percentage ?? 0).toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-gray-500">
              {selectedTagFilters.length > 0 ? "No tags match the selected filters" : "No tagged resources found"}
            </div>
          )}
        </div>

        {/* Spend by Key Bar Chart (right) */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Spend by Key</h3>
            {availableTagKeys.length > 0 && (
              <div className="relative" data-tag-filter-dropdown>
                <button
                  onClick={() => { setTagFilterDropdownOpen(!tagFilterDropdownOpen); setTagFilterSearch(""); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Filter
                  {selectedTagFilters.length > 0 && (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#FF3621' }}>
                      {selectedTagFilters.length}
                    </span>
                  )}
                </button>
                {tagFilterDropdownOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg">
                    <div className="p-2">
                      <input
                        type="text"
                        value={tagFilterSearch}
                        onChange={(e) => setTagFilterSearch(e.target.value)}
                        placeholder="Search tag keys..."
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {availableTagKeys
                        .filter(k => !tagFilterSearch || k.toLowerCase().includes(tagFilterSearch.toLowerCase()))
                        .map(key => (
                          <button
                            key={key}
                            onClick={() => handleToggleTagFilter(key)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                          >
                            <div className={`flex h-4 w-4 items-center justify-center rounded border ${selectedTagFilters.includes(key) ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                              {selectedTagFilters.includes(key) && (
                                <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-800">{key}</span>
                          </button>
                        ))}
                      {availableTagKeys.filter(k => !tagFilterSearch || k.toLowerCase().includes(tagFilterSearch.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching tag keys</div>
                      )}
                    </div>
                    {selectedTagFilters.length > 0 && (
                      <div className="border-t border-gray-200 p-2">
                        <button onClick={handleClearTagFilters} className="w-full rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100">
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Tag key filter pills */}
          {selectedTagFilters.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {selectedTagFilters.map(key => (
                <span key={key} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: '#FF3621' }}>
                  {key}
                  <button onClick={() => handleToggleTagFilter(key)} className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-white/20">
                    <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              <button onClick={handleClearTagFilters} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          )}
          {filteredTagBreakdownData.length > 0 ? (() => {
            const totalKeySpend = filteredTagBreakdownData.reduce((sum, d) => sum + d.total_spend, 0);
            return (
              <div className="max-h-75 overflow-y-auto">
                <table className="w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Key</th>
                      <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                      <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {filteredTagBreakdownData.map((entry, idx) => {
                      const pct = totalKeySpend > 0 ? (entry.total_spend / totalKeySpend) * 100 : 0;
                      return (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="whitespace-nowrap px-2 py-2 text-xs font-medium text-gray-900">
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-800" title={entry.tag_key}>{entry.tag_key}</span>
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right text-xs font-medium text-gray-900">{formatCurrency(entry.total_spend)}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <div className="h-1.5 w-10 overflow-hidden rounded-full bg-gray-200">
                                <div className="h-full rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-xs text-gray-500">{pct.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })() : (
            <div className="flex h-32 items-center justify-center text-gray-500">
              {selectedTagFilters.length > 0 ? "No data for selected filters" : "No tag data available"}
            </div>
          )}
        </div>
      </div>

      {/* Untagged Resources Table */}
      <UntaggedResourcesTable
        data={data}
        host={host}
        suggestedTags={suggestedTags}
        untaggedCounts={untaggedCounts}
        activeUntaggedTab={activeUntaggedTab}
        onTabChange={handleTabChange}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        showHistoricalUntagged={showHistoricalUntagged}
        onHistoricalToggle={setShowHistoricalUntagged}
        itemsPerPage={itemsPerPage}
      />

      {/* Tag Drilldown Modal */}
      {selectedTag && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setSelectedTag(null)}>
          <div className="mx-4 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="rounded bg-orange-100 px-2 py-1 text-sm font-medium text-orange-800">{selectedTag.tag_key}</span>
                <h3 className="text-lg font-semibold text-gray-900">
                  Top 5 Objects — {selectedTag.tag_value}
                </h3>
              </div>
              <button onClick={() => setSelectedTag(null)} className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {tagObjectsLoading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
              </div>
            ) : tagObjects.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Object</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">DBUs</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Days Active</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {tagObjects.map((obj, idx) => (
                      <tr key={obj.object_id || idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-xs truncate">
                          {obj.object_name}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                            obj.object_type === 'Cluster' ? 'bg-blue-100 text-blue-700' :
                            obj.object_type === 'Job' ? 'bg-green-100 text-green-700' :
                            obj.object_type === 'SQL Warehouse' ? 'bg-blue-50 text-blue-700' :
                            obj.object_type === 'Pipeline' ? 'bg-cyan-100 text-cyan-700' :
                            obj.object_type === 'Serving Endpoint' ? 'bg-pink-100 text-pink-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {obj.object_type}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                          {formatNumber(obj.total_dbus)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                          {formatCurrency(obj.total_spend)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                          {obj.days_active}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-gray-500">
                No objects found for this tag
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
