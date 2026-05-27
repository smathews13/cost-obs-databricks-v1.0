import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Legend,
} from "recharts";
import { format, parseISO } from "date-fns";
import type { AWSActualDashboardBundle } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";
import { CHARGE_TYPE_COLORS } from "./shared";

interface AwsActualTabProps {
  actualData: AWSActualDashboardBundle;
  /** The multi-cloud tab switcher rendered by the shell, or null */
  cloudTabSwitcher: React.ReactNode;
  onSwitchToEstimated: () => void;
}

export function AwsActualTab({
  actualData,
  cloudTabSwitcher,
  onSwitchToEstimated,
}: AwsActualTabProps) {
  const summary = actualData.summary;
  const byChargeType = actualData.by_charge_type;
  const byCluster = actualData.by_cluster;
  const timeseries = actualData.timeseries;

  const chargeTypePieData =
    byChargeType?.charge_types?.map((ct) => ({
      name: ct.charge_type,
      value: ct.net_unblended_cost,
      fill: CHARGE_TYPE_COLORS[ct.charge_type] || CHARGE_TYPE_COLORS.Other,
    })) || [];

  return (
    <div className="space-y-6">
      {/* Mode Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            AWS CUR Data Available
          </span>
          {cloudTabSwitcher}
        </div>
        <div className="flex rounded-lg bg-gray-100 p-1">
          <button
            className="rounded-md bg-white px-4 py-1.5 text-sm font-medium text-orange-600 shadow"
            aria-current="true"
          >
            Actual Costs
          </button>
          <button
            onClick={onSwitchToEstimated}
            className="rounded-md px-4 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Estimated
          </button>
        </div>
      </div>

      {/* Actual Costs Summary */}
      <div className="rounded-lg bg-gradient-to-r from-green-600 to-emerald-500 p-6 text-white shadow">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-green-100">Actual AWS Infrastructure Cost</p>
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">From CUR 2.0</span>
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">
                Account-wide · workspace filter not applied
              </span>
            </div>
            <p className="mt-1 text-3xl font-bold">{formatCurrency(summary?.total_net_unblended || 0)}</p>
            <p className="mt-1 text-sm text-green-100">
              Across {summary?.cluster_count || 0} clusters and {summary?.warehouse_count || 0} warehouses
            </p>
          </div>
          <div className="rounded-lg bg-white/20 p-4">
            <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-4 border-t border-white/20 pt-4">
          <div>
            <p className="text-xs text-green-200">Unblended</p>
            <p className="text-lg font-semibold">{formatCurrency(summary?.total_unblended || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-green-200">Net Unblended</p>
            <p className="text-lg font-semibold">{formatCurrency(summary?.total_net_unblended || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-green-200">Amortized</p>
            <p className="text-lg font-semibold">{formatCurrency(summary?.total_amortized || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-green-200">Net Amortized</p>
            <p className="text-lg font-semibold">{formatCurrency(summary?.total_net_amortized || 0)}</p>
          </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Charge Type Breakdown */}
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: "#E5E5E5" }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by Charge Type</h3>
          {chargeTypePieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={chargeTypePieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) => `${name}: ${((percent || 0) * 100).toFixed(1)}%`}
                  labelLine={false}
                >
                  {chargeTypePieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrency(value as number)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No charge type data</div>
          )}
        </div>

        {/* Cost Over Time */}
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: "#E5E5E5" }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Actual AWS Cost Over Time</h3>
          {timeseries?.timeseries && timeseries.timeseries.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={timeseries.timeseries}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(d) => format(parseISO(d), "MMM d")}
                />
                <YAxis tickFormatter={(v) => formatCurrency(v)} />
                <Tooltip
                  formatter={(value) => formatCurrency(value as number)}
                  labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                />
                <Legend />
                {timeseries.charge_types.map((ct) => (
                  <Bar
                    key={ct}
                    dataKey={ct}
                    stackId="1"
                    fill={CHARGE_TYPE_COLORS[ct] || CHARGE_TYPE_COLORS.Other}
                    radius={[0, 0, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
          )}
        </div>
      </div>

      {/* Clusters Table */}
      {byCluster?.clusters && byCluster.clusters.length > 0 && (
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: "#E5E5E5" }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Actual AWS Costs by Cluster</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Cluster</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Compute</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Storage</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Network</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {byCluster.clusters.slice(0, 20).map((cluster, idx) => (
                  <tr key={`${cluster.cluster_id}-${idx}`} className="hover:bg-gray-50">
                    <td className="px-3 py-3 text-sm font-medium text-gray-900">
                      {cluster.cluster_id || "Unknown"}
                    </td>
                    <td className="px-3 py-3 text-right text-sm text-gray-600">
                      {formatCurrency(cluster.compute_cost)}
                    </td>
                    <td className="px-3 py-3 text-right text-sm text-gray-600">
                      {formatCurrency(cluster.storage_cost)}
                    </td>
                    <td className="px-3 py-3 text-right text-sm text-gray-600">
                      {formatCurrency(cluster.network_cost)}
                    </td>
                    <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">
                      {formatCurrency(cluster.total_cost)}
                    </td>
                    <td className="px-3 py-3 text-right text-sm text-gray-500">
                      {(cluster.percentage ?? 0).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
