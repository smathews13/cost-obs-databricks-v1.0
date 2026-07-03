import gcpLogo from "@/assets/gcp.svg";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie, Legend,
} from "recharts";
import { format, parseISO } from "date-fns";
import type { GCPActualDashboardBundle } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";

const GCP_COLORS = ["#4285F4", "#34A853", "#FBBC05", "#EA4335", "#8AB4F8", "#81C995", "#FDD663", "#F28B82", "#A8C7FA", "#CCFF90"];

interface GCPActualViewProps {
  gcpActualData: GCPActualDashboardBundle;
  cloudTabSwitcher: React.ReactNode;
  onSwitchToEstimated: () => void;
}

export function GCPActualView({ gcpActualData, cloudTabSwitcher, onSwitchToEstimated }: GCPActualViewProps) {
  const summary = gcpActualData.summary;
  const byService = gcpActualData.by_service;
  const byProject = gcpActualData.by_project;
  const timeseries = gcpActualData.timeseries;

  const servicePieData = byService?.services?.map((s, i) => ({
    name: s.service,
    value: s.total_cost,
    fill: GCP_COLORS[i % GCP_COLORS.length],
  })) || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            GCP Billing Data Available
          </span>
          {cloudTabSwitcher}
        </div>
        <div className="flex rounded-lg bg-gray-100 p-1">
          <button className="rounded-md px-4 py-1.5 text-sm font-medium bg-white text-blue-500 shadow">Actual Costs</button>
          <button onClick={onSwitchToEstimated} className="rounded-md px-4 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Estimated</button>
        </div>
      </div>

      <div className="rounded-lg p-6 text-white shadow" style={{ background: 'linear-gradient(to right, #4285F4, #8AB4F8)' }}>
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>Actual GCP Infrastructure Cost</p>
              <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>From BigQuery Billing Export</span>
              <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>Account-wide · workspace filter not applied</span>
            </div>
            <p className="mt-1 text-3xl font-bold">
              {formatCurrency(summary?.total_cost || 0)}{" "}
              <span className="text-base font-normal opacity-75">{summary?.currency || "USD"}</span>
            </p>
            <p className="mt-1 text-sm" style={{ color: 'rgba(255,255,255,0.85)' }}>
              Across {summary?.project_count || 0} projects · {summary?.service_count || 0} services · {summary?.days_in_range || 0} days
            </p>
          </div>
          <div className="rounded-lg p-4" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>
            <img src={gcpLogo} alt="GCP" className="h-12 w-12 object-contain" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by GCP Service</h3>
          {servicePieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie isAnimationActive={false} data={servicePieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} dataKey="value"
                  label={({ name, percent }) => `${name}: ${((percent || 0) * 100).toFixed(1)}%`} labelLine={false}>
                  {servicePieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Pie>
                <Tooltip formatter={(v) => formatCurrency(v as number)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="flex h-64 items-center justify-center text-gray-500">No service data</div>}
        </div>

        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">GCP Cost Over Time</h3>
          {timeseries?.timeseries && timeseries.timeseries.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={timeseries.timeseries}>
                <XAxis dataKey="date" tickFormatter={(d) => format(parseISO(d), "MMM d")} />
                <YAxis tickFormatter={(v) => formatCurrency(v)} />
                <Tooltip formatter={(v) => formatCurrency(v as number)} labelFormatter={(l) => format(parseISO(l as string), "MMM d, yyyy")} />
                <Legend />
                {(timeseries.services || []).slice(0, 8).map((svc, i) => (
                  <Bar isAnimationActive={false} key={svc} dataKey={svc} stackId="1" fill={GCP_COLORS[i % GCP_COLORS.length]} radius={[0, 0, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>}
        </div>
      </div>

      {byProject?.projects && byProject.projects.length > 0 && (
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by GCP Project</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Project</th>
                  <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Project ID</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Services</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {byProject.projects.slice(0, 20).map((p, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-3 text-sm font-medium text-gray-900">{p.project_name}</td>
                    <td className="px-3 py-3 text-sm text-gray-500 font-mono">{p.project_id}</td>
                    <td className="px-3 py-3 text-right text-sm text-gray-600">{p.service_count}</td>
                    <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(p.total_cost)}</td>
                    <td className="px-3 py-3 text-right text-sm text-gray-500">{(p.percentage ?? 0).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {byService?.services && byService.services.length > 0 && (
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by GCP Service</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Service</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Days Active</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</th>
                  <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {byService.services.slice(0, 20).map((s, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-3 text-sm font-medium text-gray-900">{s.service}</td>
                    <td className="px-3 py-3 text-right text-sm text-gray-600">{s.days_active}</td>
                    <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(s.total_cost)}</td>
                    <td className="px-3 py-3 text-right text-sm text-gray-500">{(s.percentage ?? 0).toFixed(1)}%</td>
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
