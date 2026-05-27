import { useMemo } from "react";
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
import type { TaggingSummary, TaggingDashboardBundle } from "@/types/billing";
import { KPITrendModal } from "@/components/KPITrendModal";
import { COLORS, formatCurrency } from "./shared";

interface TaggingOverviewProps {
  summary: TaggingSummary;
  timeseries: TaggingDashboardBundle["timeseries"];
  workspaceIds?: string[];
  workspaceNameMap?: Record<string, string>;
  startDate?: string;
  endDate?: string;
  selectedKPI: { kpi: string; label: string } | null;
  onSelectKPI: (kpi: { kpi: string; label: string } | null) => void;
  infoMinimized: boolean;
  onMinimizeToggle: (checked: boolean) => void;
}

export function TaggingOverview({
  summary,
  timeseries,
  workspaceIds,
  workspaceNameMap,
  startDate,
  endDate,
  selectedKPI,
  onSelectKPI,
  infoMinimized,
  onMinimizeToggle,
}: TaggingOverviewProps) {
  const coveragePieData = useMemo(
    () => [
      { name: "Tagged", value: summary.tagged_spend, fill: COLORS.tagged },
      { name: "Untagged", value: summary.untagged_spend, fill: COLORS.untagged },
    ],
    [summary.tagged_spend, summary.untagged_spend]
  );

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: "#FF3621" }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tagging</h1>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-gray-500">Cost attribution through resource tagging coverage</p>
            {workspaceIds && workspaceIds.length > 0 && (
              <span className="rounded bg-[#1B3139]/10 px-2 py-0.5 text-[10px] font-medium text-[#1B3139]">
                {workspaceIds.length === 1
                  ? workspaceNameMap?.[workspaceIds[0]] || workspaceIds[0]
                  : `${workspaceIds.length} workspaces`}
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
            <button className="flex w-full items-center justify-between" onClick={() => onMinimizeToggle(!infoMinimized)}>
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
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={infoMinimized}
                      onChange={(e) => onMinimizeToggle(e.target.checked)}
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

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="cursor-pointer rounded-lg border bg-white p-6 shadow-sm transition-all hover:scale-[1.01] hover:shadow-md"
          style={{ borderColor: "#E5E5E5" }}
          onClick={() => onSelectKPI({ kpi: "tagged_spend", label: "Tagged Spend" })}
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
              <p className="text-sm text-gray-500">{(summary.tagged_percentage ?? 0).toFixed(1)}% of total</p>
              <p className="mt-1 text-xs font-medium" style={{ color: "#FF3621" }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="cursor-pointer rounded-lg border bg-white p-6 shadow-sm transition-all hover:scale-[1.01] hover:shadow-md"
          style={{ borderColor: "#E5E5E5" }}
          onClick={() => onSelectKPI({ kpi: "untagged_spend", label: "Untagged Spend" })}
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
              <p className="text-sm text-gray-500">{(summary.untagged_percentage ?? 0).toFixed(1)}% of total</p>
              <p className="mt-1 text-xs font-medium" style={{ color: "#FF3621" }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="cursor-pointer rounded-lg border bg-white p-6 shadow-sm transition-all hover:scale-[1.01] hover:shadow-md"
          style={{ borderColor: "#E5E5E5" }}
          onClick={() => onSelectKPI({ kpi: "tagged_spend", label: "Tag Coverage" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Tag Coverage</p>
              <p className="text-2xl font-semibold text-gray-900">{(summary.tagged_percentage ?? 0).toFixed(1)}%</p>
              <p className="text-sm text-gray-500">of total spend</p>
              <p className="mt-1 text-xs font-medium" style={{ color: "#FF3621" }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="cursor-pointer rounded-lg border bg-white p-6 shadow-sm transition-all hover:scale-[1.01] hover:shadow-md"
          style={{ borderColor: "#E5E5E5" }}
          onClick={() => onSelectKPI({ kpi: "total_spend", label: "Total Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.total_spend)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: "#FF3621" }}>Click to see trend →</p>
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
          onClose={() => onSelectKPI(null)}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Tag Coverage + Tag Coverage Over Time — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Tag Coverage Pie Chart */}
        <div className="rounded-lg border bg-white p-6" style={{ borderColor: "#E5E5E5" }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Total Tag Coverage</h3>
          {coveragePieData.some((d) => d.value > 0) ? (
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
        <div className="rounded-lg border bg-white p-6" style={{ borderColor: "#E5E5E5" }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Tag Coverage Over Time</h3>
          {timeseries?.timeseries?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={timeseries.timeseries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) =>
                    new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  }
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
    </>
  );
}
