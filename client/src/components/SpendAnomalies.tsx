import { useState, Fragment } from "react";
import { format, parseISO } from "date-fns";
import type { SpendAnomaliesResponse } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";

interface SpendAnomaliesProps {
  data: SpendAnomaliesResponse | undefined;
  isLoading: boolean;
}

export function SpendAnomalies({ data, isLoading }: SpendAnomaliesProps) {
  const [dateSearch, setDateSearch] = useState("");

  if (isLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading spend anomalies...</p>
        </div>
      </div>
    );
  }

  if (!data || data.anomalies.length === 0) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">
          Largest Spend Changes
        </h3>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No significant spend changes detected</p>
          <p className="text-sm">This is good news -- spending has been stable over the selected period</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Largest Spend Changes</h3>
          <p className="text-sm text-gray-500">
            Top {data.anomalies.length} days with biggest day-over-day spend changes
          </p>
        </div>
        <input
          type="text"
          placeholder="Search date..."
          value={dateSearch}
          onChange={(e) => setDateSearch(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-44"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr className="border-b border-gray-200">
              <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Date
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Daily Spend
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Previous Day
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Change $
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Change %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {data.anomalies.filter((a) => {
              if (!dateSearch) return true;
              const searchLower = dateSearch.toLowerCase();
              const formatted = format(parseISO(a.usage_date), "MMM d, yyyy").toLowerCase();
              return formatted.includes(searchLower) || a.usage_date.includes(searchLower);
            }).map((anomaly, idx) => {
              // Color scheme: Red = cost increase (higher cost = bad), Green = cost decrease (lower cost = good)
              const isCostIncrease = anomaly.change_amount > 0;
              const absChangePercent = Math.abs(anomaly.change_percent);

              return (
                <Fragment key={`${anomaly.usage_date}-${idx}`}>
                <tr className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-3 text-sm font-medium text-gray-900">
                    {format(parseISO(anomaly.usage_date), "MMM d, yyyy")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-900">
                    {formatCurrency(anomaly.daily_spend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                    {formatCurrency(anomaly.prev_day_spend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium">
                    <span className={isCostIncrease ? "text-red-600" : "text-green-600"}>
                      {isCostIncrease ? "+" : ""}
                      {formatCurrency(anomaly.change_amount)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm">
                    <div className="flex items-center justify-end gap-2">
                      <div className="flex items-center gap-1">
                        {isCostIncrease ? (
                          <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                          </svg>
                        )}
                        <span className={`font-medium ${isCostIncrease ? "text-red-600" : "text-green-600"}`}>
                          {absChangePercent.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
