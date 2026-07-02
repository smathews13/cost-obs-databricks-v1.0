import { memo, useState, useEffect, useMemo, useRef } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";
import type { ProductBreakdownResponse, WorkspaceBreakdown } from "@/types/billing";
import { formatCurrencyCompact as formatCurrency } from "@/utils/formatters";

interface ProductBreakdownProps {
  data: ProductBreakdownResponse | undefined;
  isLoading: boolean;
  workspaces?: WorkspaceBreakdown[];
  dateRange?: { startDate: string; endDate: string };
  workspaceNameMap?: Record<string, string>;
}

const CATEGORY_COLORS: Record<string, string> = {
  "SQL - DBSQL": "#1B5162",
  "SQL - Genie": "#06B6D4",
  SQL: "#1B5162",
  "ETL - Batch": "#10B981",
  "ETL - Streaming": "#14B8A6",
  Interactive: "#F59E0B",
  Serverless: "#06B6D4",
  "Model Serving": "#EC4899",
  "AI Search": "#EF4444",
  "Fine-Tuning": "#F97316",
  "AI Functions": "#3B82F6",
  Other: "#6B7280",
};

const COLOR_ROTATION = [
  "#1B5162", "#FF3621", "#06B6D4", "#10B981", "#F59E0B",
  "#3B82F6", "#EC4899", "#EF4444", "#14B8A6", "#6B7280",
  "#3B82F6", "#F97316",
];

export const ProductBreakdown = memo(function ProductBreakdown({ data, isLoading, workspaces, dateRange, workspaceNameMap }: ProductBreakdownProps) {
  const allWsIds = useMemo(
    () => (workspaces ?? []).map((w) => String(w.workspace_id)),
    [workspaces],
  );
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
  const wsFilterInitialized = useRef(false);
  const [filteredData, setFilteredData] = useState<ProductBreakdownResponse | undefined>(undefined);
  const [filterLoading, setFilterLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Seed with all workspaces on first data load
  useEffect(() => {
    if (wsFilterInitialized.current) return;
    if (allWsIds.length > 0) {
      setSelectedWorkspaces(allWsIds);
      wsFilterInitialized.current = true;
    }
  }, [allWsIds]);

  const isAll = selectedWorkspaces.length === allWsIds.length && allWsIds.length > 0;
  const isPartial = selectedWorkspaces.length > 0 && selectedWorkspaces.length < allWsIds.length;
  const isEmpty = selectedWorkspaces.length === 0;

  const wsKey = useMemo(() => [...selectedWorkspaces].sort().join(','), [selectedWorkspaces]);

  useEffect(() => {
    if (isAll || isEmpty) {
      setFilteredData(undefined);
      return;
    }

    let cancelled = false;
    setFilterLoading(true);

    const fetchOne = (wsId: string) => {
      const params = new URLSearchParams();
      if (dateRange?.startDate) params.set("start_date", dateRange.startDate);
      if (dateRange?.endDate) params.set("end_date", dateRange.endDate);
      params.set("workspace_id", wsId);
      return fetch(`/api/billing/by-product?${params}`).then((r) => r.json());
    };

    if (selectedWorkspaces.length === 1) {
      fetchOne(selectedWorkspaces[0])
        .then((json) => { if (!cancelled) { setFilteredData(json); setFilterLoading(false); } })
        .catch(() => { if (!cancelled) setFilterLoading(false); });
    } else {
      // Merge per-workspace results by product category
      Promise.all(selectedWorkspaces.map(fetchOne))
        .then((results: ProductBreakdownResponse[]) => {
          if (cancelled) return;
          const merged: Record<string, { total_spend: number; total_dbus: number; workspace_count: number }> = {};
          for (const r of results) {
            for (const p of r.products || []) {
              const key = p.category;
              if (!merged[key]) merged[key] = { total_spend: 0, total_dbus: 0, workspace_count: 0 };
              merged[key].total_spend += p.total_spend || 0;
              merged[key].total_dbus += p.total_dbus || 0;
              merged[key].workspace_count += p.workspace_count || 0;
            }
          }
          const total = Object.values(merged).reduce((s, x) => s + x.total_spend, 0);
          setFilteredData({
            products: Object.entries(merged).map(([category, v]) => ({
              category,
              total_spend: v.total_spend,
              total_dbus: v.total_dbus,
              workspace_count: v.workspace_count,
              percentage: total > 0 ? (v.total_spend / total) * 100 : 0,
            })).sort((a, b) => b.total_spend - a.total_spend),
            total_spend: total,
            start_date: "",
            end_date: "",
          } as ProductBreakdownResponse);
          setFilterLoading(false);
        })
        .catch(() => { if (!cancelled) setFilterLoading(false); });
    }

    return () => { cancelled = true; };
  }, [wsKey, dateRange?.startDate, dateRange?.endDate, isAll, isEmpty, selectedWorkspaces]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const displayData = isEmpty
    ? ({ products: [], total_spend: 0, start_date: "", end_date: "" } as ProductBreakdownResponse)
    : isAll
    ? data
    : filteredData;
  const showLoading = isLoading || filterLoading;

  const selectedWorkspaceName = useMemo(() => {
    if (selectedWorkspaces.length !== 1 || !workspaces) return null;
    const wsId = selectedWorkspaces[0];
    const ws = workspaces.find((w) => String(w.workspace_id) === wsId);
    return workspaceNameMap?.[wsId] || (ws ? (ws.workspace_name || String(ws.workspace_id)) : wsId);
  }, [selectedWorkspaces, workspaces, workspaceNameMap]);

  const workspaceSelector = workspaces && workspaces.length > 1 ? (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${isPartial ? "border-[#FF3621] text-[#FF3621]" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}
      >
        {selectedWorkspaceName
          ? selectedWorkspaceName
          : isPartial
          ? `${selectedWorkspaces.length} workspaces`
          : "Workspace"}
        <svg className={`h-3 w-3 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {dropdownOpen && (
        <div className="absolute right-0 top-full z-[9999] mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Workspace</span>
            <div className="flex items-center gap-2 text-xs">
              <button onClick={(e) => { e.stopPropagation(); setSelectedWorkspaces([...allWsIds]); }} className="text-gray-500 hover:text-gray-800">All</button>
              <span className="text-gray-300">·</span>
              <button onClick={(e) => { e.stopPropagation(); setSelectedWorkspaces([]); }} className="text-gray-500 hover:text-gray-800">Clear</button>
            </div>
          </div>
          {workspaces.map((ws) => {
            const wsId = String(ws.workspace_id);
            const isActive = selectedWorkspaces.includes(wsId);
            return (
              <button
                key={wsId}
                onClick={() => setSelectedWorkspaces(prev => prev.includes(wsId) ? prev.filter(x => x !== wsId) : [...prev, wsId])}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs hover:bg-gray-50"
              >
                <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isActive ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                  {isActive && <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </div>
                <span className="truncate text-gray-700">{workspaceNameMap?.[wsId] || ws.workspace_name || ws.workspace_id}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  if (showLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Spend by Product</h3>
          {workspaceSelector}
        </div>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading product breakdown...</p>
        </div>
      </div>
    );
  }

  if (!displayData || displayData.products.length === 0) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Spend by Product</h3>
          {workspaceSelector}
        </div>
        <div className="flex h-80 flex-col items-center justify-center gap-2" style={{ color: '#6B7280' }}>
          <p className="text-base font-medium">No product breakdown available</p>
          <p className="text-sm">Try expanding the date range to capture more billing data</p>
        </div>
      </div>
    );
  }

  const chartData = [...displayData.products]
    .sort((a, b) => b.total_spend - a.total_spend)
    .map((p) => ({
      name: p.category,
      total_spend: p.total_spend,
      percentage: p.percentage,
    }));

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5', overflow: 'visible' }}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Spend by Product</h3>
          {selectedWorkspaceName && (
            <p className="text-sm text-orange-600 font-medium mt-0.5">
              Filtered to: {selectedWorkspaceName}
            </p>
          )}
        </div>
        {workspaceSelector}
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 70 }}>
          <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={12} tickMargin={8} />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            stroke="#9ca3af"
            fontSize={12}
            tickMargin={8}
            tickFormatter={(v: string) => (v.length > 18 ? v.substring(0, 18) + "..." : v)}
          />
          <Tooltip
            formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
            labelFormatter={(label) => `Product: ${label}`}
            contentStyle={{
              backgroundColor: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
            }}
          />
          <Bar dataKey="total_spend" name="Spend" radius={[0, 4, 4, 0]}>
            {chartData.map((entry, idx) => (
              <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || COLOR_ROTATION[idx % COLOR_ROTATION.length]} />
            ))}
            <LabelList dataKey="total_spend" position="right" formatter={(v: unknown) => formatCurrency(v as number)} style={{ fontSize: 11, fill: "#6b7280" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
});
