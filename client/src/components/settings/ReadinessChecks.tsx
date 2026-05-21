import { useState } from "react";

export type ReadinessStatus =
  | "healthy"
  | "not_configured"
  | "timeout_starting"
  | "permission_denied"
  | "internal_error"
  | "unavailable";

export interface ReadinessCheck {
  table?: string;
  name: string;
  description: string;
  required?: boolean;
  granted: boolean;
  category: "core" | "enhanced";
  source?: string;
  fix_sql?: string;
  error?: string;
}

export interface ReadinessWarehouse {
  name: string;
  description: string;
  category: "core";
  source: "app_resource" | "http_path" | "none";
  granted: boolean;
  error?: string;
  fix_sql?: string;
}

export interface ReadinessResult {
  overall: "ready" | "core_ready" | "needs_action" | "not_ready";
  warehouse: ReadinessWarehouse;
  core: ReadinessCheck[];
  enhanced: ReadinessCheck[];
  sp_client_id: string;
}

/** Normalise a raw API response into a well-typed ReadinessResult.
 *  Guards against missing fields so the UI never crashes on a partial payload. */
export function normalizeReadinessResult(raw: unknown): ReadinessResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const overall = (r.overall as ReadinessResult["overall"]) ?? "not_ready";
  const warehouse = r.warehouse as ReadinessWarehouse | undefined;
  if (!warehouse) return null;
  return {
    overall,
    warehouse: {
      name: String(warehouse.name ?? "SQL Warehouse"),
      description: String(warehouse.description ?? ""),
      category: "core",
      source: (warehouse.source as ReadinessWarehouse["source"]) ?? "none",
      granted: Boolean(warehouse.granted),
      error: warehouse.error != null ? String(warehouse.error) : undefined,
      fix_sql: warehouse.fix_sql != null ? String(warehouse.fix_sql) : undefined,
    },
    core: Array.isArray(r.core) ? (r.core as ReadinessCheck[]) : [],
    enhanced: Array.isArray(r.enhanced) ? (r.enhanced as ReadinessCheck[]) : [],
    sp_client_id: String(r.sp_client_id ?? ""),
  };
}

interface ReadinessChecksProps {
  result: ReadinessResult | null;
  loading: boolean;
  fetchError?: string | null;
  onRecheck: (forceRefresh?: boolean) => void;
  onAutoGrant?: () => Promise<void>;
  autoGrantRunning?: boolean;
  autoGrantResult?: { ok: boolean; message: string; errors?: string[] } | null;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium text-gray-500 border border-gray-200 hover:border-gray-400 hover:text-gray-700 transition-colors"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CheckIcon({ granted }: { granted: boolean }) {
  if (granted) {
    return (
      <svg className="h-4 w-4 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg className="h-4 w-4 shrink-0 text-red-500" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
    </svg>
  );
}

function CheckRow({ check, showTable = true }: { check: ReadinessCheck | ReadinessWarehouse; showTable?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasFix = !check.granted && check.fix_sql;
  const tableLabel = "table" in check && check.table ? check.table : null;

  return (
    <div className={`rounded border px-3 py-2 ${check.granted ? "border-gray-100 bg-white" : "border-red-100 bg-red-50"}`}>
      <div className="flex items-start gap-2">
        <CheckIcon granted={check.granted} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-800">{check.name}</span>
            {showTable && tableLabel && (
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-mono text-gray-600">{tableLabel}</code>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-gray-500">{check.description}</p>
          {!check.granted && check.error && (
            <p className="mt-0.5 text-[11px] text-red-500 break-all line-clamp-2">{check.error}</p>
          )}
          {expanded && hasFix && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-gray-600 uppercase tracking-wide">Run as metastore admin</span>
                <CopyButton text={check.fix_sql!} />
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-gray-900 px-3 py-2 text-[11px] leading-relaxed text-green-400">
                {check.fix_sql}
              </pre>
            </div>
          )}
        </div>
        {hasFix && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
          >
            {expanded ? "Hide" : "Fix"}
          </button>
        )}
      </div>
    </div>
  );
}

function OverallBadge({ overall }: { overall: ReadinessResult["overall"] }) {
  const configs = {
    ready: { label: "Ready", className: "bg-green-50 text-green-700 border-green-200" },
    core_ready: { label: "Core Ready", className: "bg-amber-50 text-amber-700 border-amber-200" },
    needs_action: { label: "Needs Action", className: "bg-red-50 text-red-700 border-red-200" },
    not_ready: { label: "Not Ready", className: "bg-red-50 text-red-700 border-red-200" },
  };
  const { label, className } = configs[overall] ?? configs.not_ready;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`}>
      {label}
    </span>
  );
}

export function ReadinessChecks({
  result,
  loading,
  fetchError,
  onRecheck,
  onAutoGrant,
  autoGrantRunning,
  autoGrantResult,
}: ReadinessChecksProps) {
  if (loading) {
    return (
      <div className="space-y-2 animate-pulse">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-gray-100" />
        ))}
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {fetchError}
        <button onClick={() => onRecheck(true)} className="ml-3 text-xs underline">Retry</button>
      </div>
    );
  }

  if (!result) return null;

  const anyCoreFailing = !result.warehouse.granted || result.core.some(c => !c.granted);
  const anyEnhancedFailing = result.enhanced.some(c => !c.granted);

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <OverallBadge overall={result.overall} />
        <button
          onClick={() => onRecheck(true)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Re-check
        </button>
      </div>

      {/* Auto-grant panel — shown when core checks are failing */}
      {anyCoreFailing && onAutoGrant && (
        <div className="rounded-lg border border-[#FF3621]/20 bg-orange-50 px-4 py-3 space-y-2">
          <p className="text-xs font-medium text-gray-800">Apply SP grants automatically</p>
          <p className="text-[11px] text-gray-600">
            Uses your current identity to grant the app's service principal access to all required system tables.
            You must be a <strong>metastore admin</strong> for this to succeed.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={onAutoGrant}
              disabled={autoGrantRunning}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
              style={{ backgroundColor: autoGrantRunning ? "#FFA390" : "#FF3621" }}
            >
              {autoGrantRunning ? "Applying grants…" : "Apply SP Grants"}
            </button>
            {autoGrantResult && (
              <div className={`text-[11px] font-medium ${autoGrantResult.ok ? "text-green-700" : "text-red-600"}`}>
                <span>{autoGrantResult.ok ? "✓ " : "✗ "}{autoGrantResult.message}</span>
                {!autoGrantResult.ok && autoGrantResult.errors && autoGrantResult.errors.length > 0 && (
                  <ul className="mt-0.5 list-disc pl-4 space-y-0.5 font-normal text-red-500">
                    {autoGrantResult.errors.slice(0, 3).map((e, i) => (
                      <li key={i} className="break-all">{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Warehouse */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Warehouse Access</h4>
        <CheckRow check={result.warehouse} showTable={false} />
        {result.warehouse.source === "none" && (
          <p className="mt-1 text-[11px] text-gray-500">
            Configure <code className="rounded bg-gray-100 px-1 font-mono text-[10px]">DATABRICKS_HTTP_PATH</code> or bind a warehouse resource in app.yaml.
          </p>
        )}
      </div>

      {/* Core tables */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Core Tables</h4>
          <span className="text-[10px] text-gray-500">Required</span>
          {result.core.some(c => !c.granted) && (
            <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
              {result.core.filter(c => !c.granted).length} missing
            </span>
          )}
        </div>
        <div className="space-y-1.5">
          {result.core.map((c, i) => <CheckRow key={c.table ?? i} check={c} />)}
        </div>
      </div>

      {/* Enhanced tables */}
      {result.enhanced.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Enhanced Tables</h4>
            <span className="text-[10px] text-gray-500">Optional — enables richer analytics</span>
            {anyEnhancedFailing && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                {result.enhanced.filter(c => !c.granted).length} missing
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {result.enhanced.map((c, i) => <CheckRow key={c.table ?? i} check={c} />)}
          </div>
        </div>
      )}

      {/* Feature-plane readiness — what's actually usable given the control-plane state above */}
      <FeaturePlaneReadiness result={result} />
    </div>
  );
}

// ── Feature-plane readiness ─────────────────────────────────────────────────

interface FeatureArea {
  label: string;
  requiredTables: string[];
  requiresWarehouse?: boolean;
}

const FEATURE_AREAS: FeatureArea[] = [
  { label: "Cost Overview & Spend",       requiredTables: ["system.billing.usage"],                requiresWarehouse: true },
  { label: "Platform KPIs — Queries",     requiredTables: ["system.query.history"],                requiresWarehouse: true },
  { label: "Platform KPIs — Jobs",        requiredTables: ["system.lakeflow.pipelines"],           requiresWarehouse: true },
  { label: "Platform KPIs — Clusters",    requiredTables: ["system.compute.clusters"],             requiresWarehouse: true },
  { label: "Platform KPIs — Serving",     requiredTables: ["system.serving.served_entities"],      requiresWarehouse: true },
  { label: "SQL Warehousing 360",         requiredTables: ["system.billing.usage", "system.query.history"], requiresWarehouse: true },
  { label: "Interactive Compute",         requiredTables: ["system.billing.usage", "system.compute.clusters"], requiresWarehouse: true },
  { label: "Pipeline Objects",            requiredTables: ["system.billing.usage", "system.lakeflow.pipelines"], requiresWarehouse: true },
];

function FeaturePlaneReadiness({ result }: { result: ReadinessResult }) {
  const [open, setOpen] = useState(false);

  const allChecks: ReadinessCheck[] = [...result.core, ...result.enhanced];
  const tableGrantedMap = new Map<string, boolean>(
    allChecks.filter(c => c.table).map(c => [c.table!, c.granted])
  );

  type FeatureState = "ready" | "degraded" | "unavailable";
  const featureStates = FEATURE_AREAS.map(area => {
    const warehouseOk = !area.requiresWarehouse || result.warehouse.granted;
    const missingGrants = area.requiredTables.filter(t => tableGrantedMap.get(t) === false);

    let state: FeatureState = "ready";
    if (!warehouseOk || missingGrants.length > 0) state = "unavailable";
    // "degraded" = warehouse ok but some tables are unknown (not yet checked)
    else if (area.requiredTables.some(t => !tableGrantedMap.has(t))) state = "degraded";

    return { ...area, state, missingGrants, warehouseOk };
  });

  const unavailableCount = featureStates.filter(f => f.state === "unavailable").length;
  const allReady = unavailableCount === 0;

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 mb-2"
      >
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Feature Readiness</h4>
        <span className="text-[10px] text-gray-500">Which dashboards are available</span>
        {unavailableCount > 0 && (
          <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
            {unavailableCount} unavailable
          </span>
        )}
        {allReady && (
          <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
            All ready
          </span>
        )}
        <svg className={`ml-auto h-3.5 w-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="space-y-1">
          {featureStates.map(f => (
            <div
              key={f.label}
              className={`flex items-start gap-2 rounded border px-3 py-2 text-[11px] ${
                f.state === "unavailable" ? "border-red-100 bg-red-50" :
                f.state === "degraded"    ? "border-amber-100 bg-amber-50" :
                "border-gray-100 bg-white"
              }`}
            >
              {f.state === "ready" ? (
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
              ) : f.state === "unavailable" ? (
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              )}
              <div className="flex-1 min-w-0">
                <span className="font-medium text-gray-800">{f.label}</span>
                {f.state === "unavailable" && !f.warehouseOk && (
                  <p className="text-red-500 mt-0.5">Blocked — warehouse access denied</p>
                )}
                {f.state === "unavailable" && f.warehouseOk && f.missingGrants.length > 0 && (
                  <p className="text-red-500 mt-0.5">
                    Missing grants: {f.missingGrants.join(", ")}
                  </p>
                )}
                {f.state === "degraded" && (
                  <p className="text-amber-600 mt-0.5">Some table grants not yet verified</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
