import { useState, Fragment } from "react";
import {
  format, parseISO,
  startOfMonth, endOfMonth,
  eachDayOfInterval, getDay,
  eachMonthOfInterval,
  isWithinInterval,
} from "date-fns";
import type { SpendAnomaliesResponse, SpendAnomaly } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";

type ViewMode = "calendar" | "table";

interface SpendAnomaliesProps {
  data: SpendAnomaliesResponse | undefined;
  isLoading: boolean;
}

// Returns background color + text color for a heatmap cell based on change_percent
function cellStyle(changePercent: number): { background: string; color: string } {
  const abs = Math.abs(changePercent);
  if (changePercent > 0) {
    if (abs >= 30) return { background: "rgba(220, 38, 38, 0.82)", color: "#fff" };
    if (abs >= 15) return { background: "rgba(239, 68, 68, 0.65)", color: "#fff" };
    if (abs >= 5)  return { background: "rgba(252, 165, 165, 0.52)", color: "#991b1b" };
    return           { background: "rgba(254, 226, 226, 0.42)", color: "#dc2626" };
  } else {
    if (abs >= 30) return { background: "rgba(22, 163, 74, 0.82)", color: "#fff" };
    if (abs >= 15) return { background: "rgba(34, 197, 94, 0.65)", color: "#fff" };
    if (abs >= 5)  return { background: "rgba(134, 239, 172, 0.52)", color: "#14532d" };
    return           { background: "rgba(220, 252, 231, 0.42)", color: "#15803d" };
  }
}

function CalendarView({
  anomalyMap,
  startDate,
  endDate,
}: {
  anomalyMap: Map<string, SpendAnomaly>;
  startDate: string;
  endDate: string;
}) {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  const months = eachMonthOfInterval({ start, end });
  const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="space-y-5">
      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-gray-500 flex-wrap">
        <span className="font-medium text-gray-600">Legend:</span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "rgba(22, 163, 74, 0.82)" }} />
          Large decrease
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "rgba(134, 239, 172, 0.52)" }} />
          Small decrease
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "rgba(252, 165, 165, 0.52)" }} />
          Small increase
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "rgba(220, 38, 38, 0.82)" }} />
          Large increase
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-gray-100 border border-gray-200" />
          No anomaly
        </span>
      </div>

      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
        {months.map((month) => {
          const monthStart = startOfMonth(month);
          const monthEnd = endOfMonth(month);
          const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
          const firstDow = getDay(monthStart); // 0=Sun

          return (
            <div key={format(month, "yyyy-MM")}>
              <div className="mb-2 text-xs font-semibold text-gray-700">
                {format(month, "MMMM yyyy")}
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {/* Day-of-week headers */}
                {DAY_INITIALS.map((d, i) => (
                  <div key={i} className="text-center text-[10px] font-medium text-gray-400 pb-1">
                    {d}
                  </div>
                ))}
                {/* Leading empty cells */}
                {Array.from({ length: firstDow }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}
                {/* Day cells */}
                {days.map((day) => {
                  const dateStr = format(day, "yyyy-MM-dd");
                  const inRange = isWithinInterval(day, { start, end });
                  const anomaly = anomalyMap.get(dateStr);
                  const styles = anomaly ? cellStyle(anomaly.change_percent) : null;

                  return (
                    <div
                      key={dateStr}
                      className="group relative aspect-square rounded text-[11px] font-medium"
                      style={
                        inRange
                          ? styles
                            ? { background: styles.background, color: styles.color }
                            : { background: "rgba(128,128,128,0.07)", color: "var(--dm-text, #374151)" }
                          : { opacity: 0.2, background: "rgba(128,128,128,0.05)" }
                      }
                    >
                      {/* Day number — top right */}
                      <span className="absolute right-1 top-0.5 text-[10px] leading-none">{format(day, "d")}</span>
                      {/* Percent + arrow — centered */}
                      {anomaly && (
                        <div className="flex h-full items-center justify-center gap-0.5">
                          <span>{Math.abs(anomaly.change_percent).toFixed(0)}%</span>
                          <svg className="h-3.5 w-1.5 flex-shrink-0" viewBox="0 0 6 14" fill="currentColor" aria-hidden="true">
                            {anomaly.change_amount > 0 ? (
                              <>
                                <polygon points="3,0 6,5 0,5" />
                                <rect x="2" y="5" width="2" height="9" />
                              </>
                            ) : (
                              <>
                                <rect x="2" y="0" width="2" height="9" />
                                <polygon points="3,14 6,9 0,9" />
                              </>
                            )}
                          </svg>
                        </div>
                      )}
                      {anomaly && (
                        <div className="pointer-events-none absolute bottom-full left-1/2 z-[9999] mb-1 w-44 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-[11px] text-white opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
                          <div className="font-semibold">{format(day, "MMM d, yyyy")}</div>
                          <div className="mt-1 text-gray-300">Spend: {formatCurrency(anomaly.daily_spend)}</div>
                          <div className="mt-0.5 text-gray-300">Prev: {formatCurrency(anomaly.prev_day_spend)}</div>
                          <div className={`mt-0.5 font-medium ${anomaly.change_amount > 0 ? "text-red-400" : "text-green-400"}`}>
                            {anomaly.change_amount > 0 ? "+" : ""}{formatCurrency(anomaly.change_amount)}
                            {" "}({anomaly.change_percent > 0 ? "+" : ""}{anomaly.change_percent.toFixed(1)}%)
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SpendAnomalies({ data, isLoading }: SpendAnomaliesProps) {
  const [dateSearch, setDateSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("calendar");

  if (isLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border" style={{ borderColor: "#E5E5E5" }}>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: "#FF3621" }} />
          <p className="text-sm text-gray-500">Loading spend anomalies...</p>
        </div>
      </div>
    );
  }

  if (!data || data.anomalies.length === 0) {
    return (
      <div className="rounded-lg bg-white p-6 border" style={{ borderColor: "#E5E5E5" }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Largest Spend Changes</h3>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No significant spend changes detected</p>
          <p className="text-sm">This is good news — spending has been stable over the selected period</p>
        </div>
      </div>
    );
  }

  const anomalyMap = new Map(data.anomalies.map((a) => [a.usage_date, a]));

  const filteredAnomalies = data.anomalies.filter((a) => {
    if (!dateSearch) return true;
    const q = dateSearch.toLowerCase();
    return (
      format(parseISO(a.usage_date), "MMM d, yyyy").toLowerCase().includes(q) ||
      a.usage_date.includes(q)
    );
  });

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border" style={{ borderColor: "#E5E5E5" }}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Largest Spend Changes</h3>
          <p className="text-sm text-gray-500">
            Top {data.anomalies.length} days with biggest day-over-day spend changes
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Search — only in table mode, left of date badge */}
          {viewMode === "table" && (
            <input
              type="text"
              placeholder="Search date..."
              value={dateSearch}
              onChange={(e) => setDateSearch(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-36"
            />
          )}
          {/* Date range badge */}
          <span className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm">
            <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {format(parseISO(data.start_date), "MMM d, yyyy")} – {format(parseISO(data.end_date), "MMM d, yyyy")}
          </span>
          {/* View toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
            <button
              onClick={() => setViewMode("calendar")}
              className={`px-3 py-1.5 transition-colors ${
                viewMode === "calendar" ? "text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
              style={viewMode === "calendar" ? { backgroundColor: "#1B3139" } : {}}
            >
              <span className="flex items-center gap-1">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Calendar
              </span>
            </button>
            <button
              onClick={() => setViewMode("table")}
              className={`px-3 py-1.5 transition-colors ${
                viewMode === "table" ? "text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
              style={viewMode === "table" ? { backgroundColor: "#1B3139" } : {}}
            >
              <span className="flex items-center gap-1">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M10 4v16M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
                </svg>
                Table
              </span>
            </button>
          </div>
        </div>
      </div>

      {viewMode === "calendar" ? (
        <CalendarView
          anomalyMap={anomalyMap}
          startDate={data.start_date}
          endDate={data.end_date}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Daily Spend</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Previous Day</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Change $</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Change %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {filteredAnomalies.map((anomaly, idx) => {
                const isCostIncrease = anomaly.change_amount > 0;
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
                        <div className="flex items-center justify-end gap-1">
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
                            {Math.abs(anomaly.change_percent).toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
