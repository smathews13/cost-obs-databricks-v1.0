import { useMemo, useState, useEffect, useRef } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import type { SKUBreakdownResponse, WorkspaceBreakdown } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";

interface SKUBreakdownProps {
  data: SKUBreakdownResponse | undefined;
  isLoading: boolean;
  workspaces?: WorkspaceBreakdown[];
  dateRange?: { startDate: string; endDate: string };
  workspaceNameMap?: Record<string, string>;
}

const SKU_COLORS = [
  "#1B5162", "#FF3621", "#06B6D4", "#10B981", "#F59E0B",
  "#3B82F6", "#EC4899", "#EF4444", "#14B8A6", "#6B7280",
];

export function SKUBreakdown({ data, isLoading, workspaces, dateRange, workspaceNameMap }: SKUBreakdownProps) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("all");
  const [workspaceFilters, setWorkspaceFilters] = useState<string[]>([]);
  const [filteredData, setFilteredData] = useState<SKUBreakdownResponse | undefined>(undefined);
  const [filterLoading, setFilterLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sync workspaceFilters → selectedWorkspace for the existing fetch logic
  useEffect(() => {
    setSelectedWorkspace(workspaceFilters.length === 1 ? workspaceFilters[0] : "all");
  }, [workspaceFilters]);

  useEffect(() => {
    if (selectedWorkspace === "all") {
      setFilteredData(undefined);
      return;
    }

    setFilterLoading(true);
    const params = new URLSearchParams();
    if (dateRange?.startDate) params.set("start_date", dateRange.startDate);
    if (dateRange?.endDate) params.set("end_date", dateRange.endDate);
    params.set("workspace_id", selectedWorkspace);

    fetch(`/api/billing/sku-breakdown?${params}`)
      .then((res) => res.json())
      .then((json) => {
        setFilteredData(json);
        setFilterLoading(false);
      })
      .catch(() => {
        setFilterLoading(false);
      });
  }, [selectedWorkspace, dateRange?.startDate, dateRange?.endDate]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const displayData = selectedWorkspace === "all" ? data : filteredData;
  const showLoading = isLoading || filterLoading;

  const selectedWorkspaceName = useMemo(() => {
    if (workspaceFilters.length !== 1 || !workspaces) return null;
    const wsId = workspaceFilters[0];
    const ws = workspaces.find((w) => String(w.workspace_id) === wsId);
    return workspaceNameMap?.[wsId] || (ws ? (ws.workspace_name || String(ws.workspace_id)) : wsId);
  }, [workspaceFilters, workspaces, workspaceNameMap]);

  const workspaceSelector = workspaces && workspaces.length > 1 ? (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${workspaceFilters.length > 0 ? "border-[#FF3621] text-[#FF3621]" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}
      >
        {workspaceFilters.length === 0 ? "Workspaces" : workspaceFilters.length === 1 ? (selectedWorkspaceName || workspaceFilters[0]) : `${workspaceFilters.length} Workspaces`}
        {workspaceFilters.length > 0 && (
          <button onClick={(e) => { e.stopPropagation(); setWorkspaceFilters([]); }} className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600 hover:bg-orange-200">
            <svg className="h-2 w-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
        <svg className={`h-3 w-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {dropdownOpen && (
        <div className="absolute right-0 top-full z-[9999] mt-1 min-w-[200px] max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Workspaces</span>
            <div className="flex items-center gap-2 text-xs">
              <button onClick={(e) => { e.stopPropagation(); setWorkspaceFilters((workspaces || []).map(ws => String(ws.workspace_id))); }} className="text-gray-500 hover:text-gray-800">All</button>
              <span className="text-gray-300">·</span>
              <button onClick={(e) => { e.stopPropagation(); setWorkspaceFilters([]); }} className="text-gray-500 hover:text-gray-800">Clear</button>
            </div>
          </div>
          {(workspaces || []).map((ws) => {
            const wsId = String(ws.workspace_id);
            const wsName = workspaceNameMap?.[wsId] || ws.workspace_name || wsId;
            return (
              <button
                key={wsId}
                onClick={() => { setWorkspaceFilters((prev) => prev.includes(wsId) ? prev.filter((x) => x !== wsId) : [...prev, wsId]); }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs hover:bg-gray-50"
              >
                <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${workspaceFilters.includes(wsId) ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                  {workspaceFilters.includes(wsId) && <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </div>
                <span className="truncate text-gray-700">{wsName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  const barData = useMemo(() => {
    if (!displayData?.skus?.length) return [];
    return [...displayData.skus]
      .sort((a, b) => b.total_spend - a.total_spend)
      .slice(0, 10)
      .map((sku) => {
        const stripped = (sku.product ?? "").replace(/^(PREMIUM_|STANDARD_|ENTERPRISE_)/i, "");
        const parts = stripped.split("_");
        const label = parts.length > 4 ? parts.slice(0, 4).join(" ") + "…" : stripped.replace(/_/g, " ");
        return { name: label, total_spend: sku.total_spend };
      });
  }, [displayData]);

  if (showLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Spend by SKU</h3>
          {workspaceSelector}
        </div>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading SKU breakdown...</p>
        </div>
      </div>
    );
  }

  if (!displayData || !displayData.skus?.length) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Spend by SKU</h3>
          {workspaceSelector}
        </div>
        <div className="flex h-80 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No SKU data available</p>
          <p className="text-sm">Try expanding the date range</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Spend by SKU</h3>
          {selectedWorkspaceName && (
            <p className="text-sm text-orange-600 font-medium mt-0.5">
              Filtered to: {selectedWorkspaceName}
            </p>
          )}
          {workspaceFilters.length > 1 && (
            <p className="text-xs text-amber-600 mt-1">Showing aggregate view — select one workspace to filter by workspace</p>
          )}
        </div>
        {workspaceSelector}
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={barData} layout="vertical" margin={{ left: -25, right: 70 }}>
          <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={12} tickMargin={8} />
          <YAxis
            type="category"
            dataKey="name"
            width={175}
            stroke="#9ca3af"
            fontSize={11}
            tickMargin={2}
            tickFormatter={(v: string) => v.length > 22 ? v.substring(0, 20) + "…" : v}
          />
          <Tooltip
            formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
            labelFormatter={(label) => `SKU: ${label}`}
            contentStyle={{
              backgroundColor: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
            }}
          />
          <Bar dataKey="total_spend" name="Spend" radius={[0, 4, 4, 0]}>
            {barData.map((_entry, idx) => (
              <Cell key={idx} fill={SKU_COLORS[idx % SKU_COLORS.length]} />
            ))}
            <LabelList dataKey="total_spend" position="right" formatter={(v: unknown) => formatCurrency(v as number)} style={{ fontSize: 11, fill: "#6b7280" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
