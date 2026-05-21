import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface InstallReport {
  version: { commit_sha: string };
  warehouse: { id: string | null; source: string };
  auth_mode: string;
  storage_location: { catalog: string; schema: string };
}

// Module-level so state survives tab switches (useState resets on unmount)
let _persistedRunKey = 0;
let _persistedHasRun = false;

interface DiagCheck {
  id: string;
  category: string;
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  fix: string;
  root_cause?: string;
  missing_tables?: string[];
}

interface DiagResult {
  checks: DiagCheck[];
  summary: { passed: number; failed: number; warned: number; total: number };
}

const CATEGORY_ORDER = ["configuration", "permissions", "materialized_views", "data", "tab_health"];
const CATEGORY_LABELS: Record<string, string> = {
  configuration: "Configuration",
  permissions: "System Table Permissions",
  materialized_views: "Materialized Views",
  data: "Data",
  tab_health: "Tab Visualizations",
};

function StatusIcon({ status }: { status: DiagCheck["status"] }) {
  if (status === "pass") {
    return (
      <svg className="h-4 w-4 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
      </svg>
    );
  }
  if (status === "fail") {
    return (
      <svg className="h-4 w-4 shrink-0 text-red-500" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
      </svg>
    );
  }
  if (status === "warn") {
    return (
      <svg className="h-4 w-4 shrink-0 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg className="h-4 w-4 shrink-0 text-gray-300" viewBox="0 0 20 20" fill="currentColor">
      <circle cx="10" cy="10" r="8" />
    </svg>
  );
}

function CheckRow({ check }: { check: DiagCheck }) {
  const [expanded, setExpanded] = useState(false);
  const hasFix = check.fix && check.status !== "pass";
  const isAlert = check.status === "fail" || check.status === "warn";
  const truncatedDetail = check.detail && check.detail.length > 175
    ? check.detail.slice(0, 175) + "…"
    : check.detail;

  const fixBtnClass = check.status === "fail"
    ? "shrink-0 rounded px-2.5 py-1 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
    : "shrink-0 rounded px-2.5 py-1 text-[11px] font-medium text-white bg-amber-500 hover:bg-amber-600";

  return (
    <div className={`rounded border px-3 py-2 ${
      check.status === "fail" ? "border-red-100 bg-red-50" :
      check.status === "warn" ? "border-amber-100 bg-amber-50" :
      "border-gray-100 bg-white"
    }`}>
      <div className="flex items-center gap-2">
        <StatusIcon status={check.status} />
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-gray-800">{check.label}</span>
          {isAlert ? (
            <>
              {check.detail && (
                <p className="mt-0.5 text-[11px] text-red-400">{truncatedDetail}</p>
              )}
              {check.root_cause && (
                <p className="mt-0.5 text-[11px] font-bold text-gray-900">{check.root_cause}</p>
              )}
            </>
          ) : check.detail ? (
            <p className="mt-0.5 text-[11px] text-gray-600">{check.detail}</p>
          ) : null}
          {expanded && hasFix && (
            <pre className="mt-2 whitespace-pre-wrap rounded border border-gray-200 bg-white px-2.5 py-2 text-[10px] leading-relaxed text-gray-700">
              {check.fix}
            </pre>
          )}
        </div>
        {hasFix && (
          <button onClick={() => setExpanded(e => !e)} className={fixBtnClass}>
            {expanded ? "Hide" : "Fix"}
          </button>
        )}
      </div>
    </div>
  );
}

function CategorySection({ category, checks }: { category: string; checks: DiagCheck[] }) {
  const failed = checks.filter(c => c.status === "fail").length;
  const warned = checks.filter(c => c.status === "warn").length;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {CATEGORY_LABELS[category] ?? category}
        </h4>
        {failed > 0 && (
          <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
            {failed} failed
          </span>
        )}
        {warned > 0 && (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
            {warned} warning{warned !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {checks.map(c => <CheckRow key={c.id} check={c} />)}
      </div>
    </div>
  );
}

interface SettingsDebuggerProps {
  onGoToConfig?: () => void;
}

export function SettingsDebugger({ onGoToConfig }: SettingsDebuggerProps) {
  const [runKey, setRunKey] = useState(_persistedRunKey);
  const [hasRun, setHasRun] = useState(_persistedHasRun);

  const { data: installReport } = useQuery<InstallReport>({
    queryKey: ["settings-install-report"],
    queryFn: () => fetch("/api/settings/config").then(r => r.json()).catch(() => null),
    staleTime: 5 * 60 * 1000,
  });

  const { data: result, isFetching, isError } = useQuery<DiagResult>({
    queryKey: ["debug-run", runKey],
    queryFn: async () => {
      const res = await fetch("/api/debug/run");
      if (!res.ok) throw new Error("Diagnostics request failed");
      return res.json();
    },
    enabled: hasRun,
    staleTime: Infinity,
    retry: false,
  });

  const handleRun = () => {
    const next = _persistedRunKey + 1;
    _persistedRunKey = next;
    _persistedHasRun = true;
    setRunKey(next);
    setHasRun(true);
  };

  const hasMvFailure = result?.checks.some(c => c.category === "materialized_views" && c.status === "fail");
  const { summary } = result ?? { summary: { passed: 0, failed: 0, warned: 0, total: 0 } };

  const grouped = CATEGORY_ORDER
    .map(cat => ({
      category: cat,
      checks: (result?.checks ?? []).filter(c => c.category === cat),
    }))
    .filter(g => g.checks.length > 0);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-gray-600">
          Diagnose the most common causes of zeros, missing data, and permission errors across the dashboard.
          Run a full check to identify issues and get step-by-step remediation instructions.
        </p>
      </div>

      {/* Install report — static deployment snapshot */}
      {installReport && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Deployment Info</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
            {installReport.version?.commit_sha && (
              <>
                <dt className="text-gray-500">Git SHA</dt>
                <dd><code className="rounded bg-gray-200 px-1.5 py-0.5 font-mono text-gray-700">{installReport.version.commit_sha}</code></dd>
              </>
            )}
            <dt className="text-gray-500">Auth mode</dt>
            <dd className="font-medium text-gray-700">{installReport.auth_mode ?? "service_principal"}</dd>
            <dt className="text-gray-500">Warehouse source</dt>
            <dd className="font-medium text-gray-700">{installReport.warehouse?.source ?? "—"}</dd>
            <dt className="text-gray-500">Storage</dt>
            <dd className="font-mono text-gray-700">
              {installReport.storage_location
                ? `${installReport.storage_location.catalog}.${installReport.storage_location.schema}`
                : "—"}
            </dd>
          </dl>
        </div>
      )}

      {/* Run button + summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleRun}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60"
          style={{ backgroundColor: isFetching ? "#FFA390" : "#FF3621" }}
        >
          {isFetching ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
              </svg>
              Running checks…
            </>
          ) : hasRun ? (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Re-run Diagnostics
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Run Diagnostics
            </>
          )}
        </button>

        {result && !isFetching && (
          <div className="flex items-center gap-3 text-sm">
            {summary.failed > 0 && (
              <span className="font-medium text-red-600">
                {summary.failed} failed
              </span>
            )}
            {summary.warned > 0 && (
              <span className="font-medium text-amber-600">
                {summary.warned} warning{summary.warned !== 1 ? "s" : ""}
              </span>
            )}
            {summary.failed === 0 && summary.warned === 0 && (
              <span className="font-medium text-green-600">All {summary.total} checks passed</span>
            )}
          </div>
        )}

        {isError && (
          <span className="text-sm text-red-600">Diagnostics request failed — check server logs</span>
        )}
      </div>

      {/* MV rebuild action */}
      {hasMvFailure && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-3">
          <svg className="h-4 w-4 shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-red-800">Materialized views are missing or empty</p>
            <p className="mt-0.5 text-[11px] text-red-700">This is the most common cause of $0 across the entire dashboard. Go to Configuration to rebuild them.</p>
          </div>
          {onGoToConfig && (
            <button
              onClick={onGoToConfig}
              className="shrink-0 inline-flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Go to Config
            </button>
          )}
        </div>
      )}

      {/* Check results grouped by category */}
      {grouped.length > 0 && (
        <div className="space-y-5">
          {grouped.map(g => (
            <CategorySection key={g.category} category={g.category} checks={g.checks} />
          ))}
        </div>
      )}

      {!hasRun && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
          <svg className="mx-auto mb-2 h-8 w-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <p className="text-sm text-gray-500">Click <strong>Run Diagnostics</strong> to check permissions, materialized views, and data availability</p>
        </div>
      )}
    </div>
  );
}
