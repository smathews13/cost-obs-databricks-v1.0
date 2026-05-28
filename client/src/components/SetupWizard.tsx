import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { ReadinessChecks, normalizeReadinessResult } from "./settings/ReadinessChecks";
import type { ReadinessResult } from "./settings/ReadinessChecks";

interface SetupWizardProps {
  onComplete: () => void;
  onClose?: () => void;
  embedded?: boolean;
}

interface ConfigData {
  warehouse: { id: string; name: string | null; size: string | null; state: string } | null;
  identity: { display_name: string; user_name: string } | null;
  storage_location: { catalog: string; schema: string } | null;
}

interface CloudData {
  provider: "aws" | "azure" | "gcp";
  host: string;
}


interface SetupStatus {
  catalog: string;
  schema: string;
  tables: Record<string, boolean>;
  all_tables_exist: boolean;
  missing_tables: string[];
  status: "ready" | "setup_required";
  task?: { status: string; error: string | null; table_progress?: Record<string, string> };
  next_poll_ms?: number;
}

type WizardStep = "welcome" | "storage-location" | "permissions" | "create-tables" | "workspace-filter" | "complete";

const STEPS: WizardStep[] = ["welcome", "storage-location", "permissions", "create-tables", "workspace-filter", "complete"];

const STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Environment",
  "storage-location": "Storage",
  permissions: "Permissions",
  "create-tables": "Create Tables",
  "workspace-filter": "Workspaces",
  complete: "Complete",
};

const CLOUD_LABELS: Record<string, string> = {
  aws: "Amazon Web Services",
  azure: "Microsoft Azure",
  gcp: "Google Cloud Platform",
};

function PermissionErrorBlock({ error, onGranted }: { error: string; onGranted: () => void }) {
  const [copied, setCopied] = useState(false);
  const [grantStatus, setGrantStatus] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [grantMessage, setGrantMessage] = useState("");

  // Extract the GRANT SQL from the error message — use [\s\S] so periods in
  // email addresses (e.g. sam.mathews@databricks.com) don't break the match
  const grantMatch = error.match(/(GRANT [\s\S]+)$/);
  const rawGrants = grantMatch ? grantMatch[1].trim() : null;
  // Normalise to one statement per line
  const grantSql = rawGrants ? rawGrants.replace(/;\s*/g, ";\n").trim() : null;

  const msgPart = grantMatch ? error.slice(0, error.indexOf(grantMatch[1])).trim() : error;

  const handleCopy = () => {
    if (grantSql) {
      navigator.clipboard.writeText(grantSql).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const handleGrant = async () => {
    setGrantStatus("running");
    setGrantMessage("");
    try {
      const res = await fetch("/api/setup/grant-catalog-access", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setGrantStatus("ok");
        setGrantMessage(data.message);
        setTimeout(onGranted, 1500);
      } else {
        setGrantStatus("fail");
        setGrantMessage(data.message);
      }
    } catch {
      setGrantStatus("fail");
      setGrantMessage("Request failed — check server logs");
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
      <p className="text-sm text-red-700">{msgPart}</p>

      {grantSql && (
        <div className="rounded border border-gray-700 bg-gray-900 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
            <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">SQL — run as metastore admin</span>
            <button
              onClick={handleCopy}
              className="text-[11px] font-medium text-gray-400 hover:text-white transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <pre className="px-3 py-2.5 font-mono text-xs text-green-400 whitespace-pre overflow-x-auto">
            {grantSql}
          </pre>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleGrant}
          disabled={grantStatus === "running" || grantStatus === "ok"}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 transition-colors"
          style={{ backgroundColor: grantStatus === "ok" ? "#16a34a" : "#FF3621" }}
        >
          {grantStatus === "running" && (
            <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
            </svg>
          )}
          {grantStatus === "ok" ? "Granted!" : grantStatus === "running" ? "Granting…" : "Try to grant access"}
        </button>
        <p className="text-[11px] text-red-600">
          {grantStatus === "ok" || grantStatus === "running"
            ? grantMessage
            : grantStatus === "fail"
            ? <span className="text-red-700">{grantMessage} — copy the SQL above and ask a metastore admin to run it.</span>
            : "Requires metastore admin rights. If this fails, copy the SQL above and ask your admin."}
        </p>
      </div>
    </div>
  );
}

export function SetupWizard({ onComplete, onClose, embedded }: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [cloud, setCloud] = useState<CloudData | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [grantRunning, setGrantRunning] = useState(false);
  const [grantResult, setGrantResult] = useState<{ ok: boolean; message: string; errors?: string[]; grants_sql?: string; obo_scope_missing?: boolean } | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [tablesJustCreated, setTablesJustCreated] = useState(false);
  const [storagePhase, setStoragePhase] = useState<'idle' | 'saving' | 'creating-catalog' | 'creating-schema' | 'done' | 'error'>('idle');
  const [storageChecks, setStorageChecks] = useState<{ config: boolean | null; catalog: boolean | null; schema: boolean | null }>({ config: null, catalog: null, schema: null });
  const [error, setError] = useState<string | null>(null);
  const [preflightResult, setPreflightResult] = useState<{ ok: boolean; status: string; message: string } | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [verifyingGrants, setVerifyingGrants] = useState(false);
  const [grantVerifyElapsed, setGrantVerifyElapsed] = useState(0);
  const grantVerifyRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const autoGrantAttempted = useRef(false);

  // Storage location step state
  const [catalogInput, setCatalogInput] = useState("");
  const [schemaInput, setSchemaInput] = useState("");
  const [storageEnvVarLocked, setStorageEnvVarLocked] = useState(false);

  // Workspace filter step state
  const [wsLoading, setWsLoading] = useState(false);
  const [allWorkspaces, setAllWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [selectedWsIds, setSelectedWsIds] = useState<Set<string>>(new Set());
  const [wsSaved, setWsSaved] = useState(false);
  const [wsLocked, setWsLocked] = useState(false);
  const [lockedWsIds, setLockedWsIds] = useState<string[]>([]);

  // Load initial data
  useEffect(() => {
    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const [configRes, cloudRes] = await Promise.all([
          fetch("/api/settings/config"),
          fetch("/api/settings/cloud-provider"),
        ]);
        if (configRes.ok) {
          const cfg = await configRes.json();
          setConfig(cfg);
          const rawCat = cfg?.storage_location?.catalog || "";
          const rawSch = cfg?.storage_location?.schema || "";
          const isEnvVar = cfg?.storage_location?.catalog_source === "env_var";
          setStorageEnvVarLocked(isEnvVar);
          // Never pre-fill with the forbidden defaults — force the user to choose explicitly
          setCatalogInput(rawCat.toLowerCase() === "main" ? "" : rawCat);
          setSchemaInput(rawSch.toLowerCase() === "cost_obs" && rawCat.toLowerCase() === "main" ? "" : rawSch);
        }
        if (cloudRes.ok) setCloud(await cloudRes.json());
      } catch (e) {
        setError(`Failed to load environment info: ${e}`);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  useEffect(() => {
    return () => { if (grantVerifyRef.current) clearInterval(grantVerifyRef.current); };
  }, []);

  useEffect(() => {
    setStoragePhase('idle');
    setStorageChecks({ config: null, catalog: null, schema: null });
    // Reset auto-grant guard when leaving permissions step so a manual recheck
    // can re-trigger if the user navigates away and back.
    if (step !== "permissions") autoGrantAttempted.current = false;
  }, [step]);


  const loadReadiness = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setReadinessError(null);
    try {
      const url = forceRefresh ? "/api/setup/readiness?refresh=true" : "/api/setup/readiness";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReadiness(normalizeReadinessResult(await res.json()));
    } catch (e) {
      setReadinessError(`Failed to check system readiness: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPreflight = useCallback(async () => {
    setPreflightLoading(true);
    setPreflightResult(null);
    try {
      const res = await fetch("/api/setup/preflight-catalog");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreflightResult(await res.json());
    } catch (e) {
      setPreflightResult({ ok: false, status: "catalog_check_failed", message: `Preflight check failed: ${e}` });
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  const handleAutoGrant = useCallback(async () => {
    setGrantRunning(true);
    setGrantResult(null);
    try {
      const res = await fetch("/api/setup/grant-sp-system-access", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      const ok = body.ok ?? res.ok;
      const message = ok
        ? `${body.applied ?? 0} grant(s) applied for ${body.sp_client_id ?? "SP"}.`
        : (body.errors?.[0] ?? body.detail ?? "Grant run completed with errors — check server logs.");
      setGrantResult({
        ok,
        message: !ok && body.needs_admin
          ? "Automatic grant failed — your current identity could not apply the required permissions."
          : message,
        errors: body.errors,
        grants_sql: body.grants_sql ?? undefined,
        obo_scope_missing: body.obo_scope_missing ?? false,
      });
    if (ok) {
      setVerifyingGrants(true);
      setGrantVerifyElapsed(0);
      const verifyStart = Date.now();
      if (grantVerifyRef.current) clearInterval(grantVerifyRef.current);
      grantVerifyRef.current = setInterval(async () => {
        const elapsed = Math.round((Date.now() - verifyStart) / 1000);
        setGrantVerifyElapsed(elapsed);
        if (elapsed >= 90) {
          clearInterval(grantVerifyRef.current!);
          grantVerifyRef.current = undefined;
          setVerifyingGrants(false);
          loadReadiness(true);
          return;
        }
        try {
          const r = await fetch("/api/setup/readiness?refresh=true");
          if (!r.ok) return;
          const data = normalizeReadinessResult(await r.json());
          if (data) setReadiness(data);
          if (data?.overall === "ready" || data?.overall === "core_ready") {
            clearInterval(grantVerifyRef.current!);
            grantVerifyRef.current = undefined;
            setVerifyingGrants(false);
          }
        } catch { /* ignore transient polling errors */ }
      }, 5000);
    }
  } catch {
    setGrantResult({ ok: false, message: "Network error running grants." });
  } finally {
    setGrantRunning(false);
  }
  }, [loadReadiness]);

  // Auto-fire grants when permissions step loads with failures so the user never
  // has to manually click "Apply SP Grants" on a fresh deploy.
  useEffect(() => {
    if (step !== "permissions") return;
    if (!readiness) return;
    if (autoGrantAttempted.current) return;
    if (grantRunning || grantResult) return;
    const hasFailing =
      !readiness.warehouse.granted ||
      readiness.core.some(c => !c.granted) ||
      readiness.enhanced.some(c => !c.granted);
    if (!hasFailing) return;
    autoGrantAttempted.current = true;
    handleAutoGrant();
  }, [step, readiness, grantRunning, grantResult, handleAutoGrant]);

  const pollSetupStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/status");
      if (res.ok) {
        const data: SetupStatus = await res.json();
        setSetupStatus(data);
        return data;
      }
    } catch {
      // ignore polling errors
    }
    return null;
  }, []);

  const handleCreateTables = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/create-tables?run_in_background=true", { method: "POST", signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      // Poll for completion — use task.status as the authority.
      // The status endpoint returns all_tables_exist=false until setup_done.json
      // is written (post-wizard), so it is NOT a reliable success signal here.
      // Use next_poll_ms hint from server (5s during active build, 30s idle).
      let pollTimeout: ReturnType<typeof setTimeout>;
      let safetyTimeout: ReturnType<typeof setTimeout>;
      let pollCancelled = false;
      const schedulePoll = async () => {
        if (pollCancelled) return;
        const status = await pollSetupStatus();
        if (pollCancelled) return;
        const taskStatus = status?.task?.status;
        if (taskStatus === "done") {
          clearTimeout(safetyTimeout);
          setCreating(false);
          setTablesJustCreated(true);
        } else if (taskStatus === "error") {
          clearTimeout(safetyTimeout);
          setCreating(false);
          const detail = status?.task?.error || "Table creation failed — check server logs for details.";
          setError(`Table creation failed: ${detail}`);
        } else if (taskStatus === "interrupted") {
          clearTimeout(safetyTimeout);
          setCreating(false);
        } else {
          const delay = status?.next_poll_ms ?? 5000;
          pollTimeout = setTimeout(schedulePoll, delay);
        }
      };
      pollTimeout = setTimeout(schedulePoll, 2000);

      // Safety timeout after 10 minutes — cancelled on normal completion so it
      // doesn't fire on the Complete step after a successful build.
      safetyTimeout = setTimeout(() => {
        pollCancelled = true;
        clearTimeout(pollTimeout);
        setCreating(false);
        setError("Table creation is taking longer than expected. Check /api/setup/status for progress.");
      }, 600000);
    } catch (e) {
      setCreating(false);
      setError(`Failed to create tables: ${e}`);
    }
  };

  const loadWorkspaces = useCallback(async () => {
    setWsLoading(true);
    try {
      const [filterRes, listRes] = await Promise.all([
        fetch("/api/setup/workspace-filter"),
        fetch("/api/setup/list-workspaces"),
      ]);
      if (filterRes.ok) {
        const filterData = await filterRes.json();
        if (filterData.locked) {
          setWsLocked(true);
          setLockedWsIds(filterData.workspace_ids ?? []);
          setWsSaved(true);
          return;
        }
      }
      if (listRes.ok) {
        const data = await listRes.json();
        setAllWorkspaces(data.workspaces ?? []);
        // Pre-select all by default
        setSelectedWsIds(new Set((data.workspaces ?? []).map((w: { id: string }) => w.id)));
      }
    } catch {
      // non-fatal — user can skip
    } finally {
      setWsLoading(false);
    }
  }, []);

  const saveWorkspaceFilter = async () => {
    if (wsLocked) return;
    const ids = Array.from(selectedWsIds);
    try {
      const res = await fetch("/api/setup/save-workspace-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_ids: ids }),
      });
      if (res.ok) setWsSaved(true);
    } catch {
      // ignore — not fatal
    }
  };

  const goNext = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) {
      const next = STEPS[idx + 1];
      setStep(next);
      if (next === "permissions") loadReadiness();
      if (next === "create-tables") { pollSetupStatus(); loadPreflight(); }
      if (next === "workspace-filter") loadWorkspaces();
    }
  };

  const goBack = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const currentIdx = STEPS.indexOf(step);

  const wizardInner = (
    <>
        {/* Header — hidden in embedded mode (already inside App Settings dialog) */}
        {!embedded && (
        <div className="relative rounded-t-xl px-8 py-6" style={{ backgroundColor: '#1B3139' }}>
          {onClose && (
            <button
              onClick={onClose}
              className="absolute right-4 top-4 rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          <h2 className="text-xl font-bold text-white">Cost Observability & Control Setup</h2>
          <p className="mt-1 text-sm text-white/70">Configure your environment to get started</p>
        </div>
        )}

        {/* Step indicator */}
        <div className="flex items-start border-b px-6 py-3" style={{ borderColor: '#E5E5E5' }}>
          {STEPS.map((s, i) => (
            <Fragment key={s}>
              {i > 0 && <div className="mt-3 h-px flex-1 self-start bg-gray-200" />}
              <div className="flex flex-col items-center">
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  i < currentIdx ? "bg-green-500 text-white" :
                  i === currentIdx ? "text-white" : "bg-gray-200 text-gray-500"
                }`} style={i === currentIdx ? { backgroundColor: '#FF3621' } : undefined}>
                  {i < currentIdx ? (
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  ) : i + 1}
                </div>
                <span className={`mt-1 w-14 text-center text-[10px] font-medium leading-tight ${i === currentIdx ? "text-gray-900" : "text-gray-500"}`}>
                  {STEP_LABELS[s]}
                </span>
              </div>
            </Fragment>
          ))}
        </div>

        {/* Body */}
        <div className="min-h-[320px] px-8 py-6">
          {error && (() => {
            // Detect permission errors that include GRANT SQL
            const isPermissionError = /needs.*CREATE SCHEMA|needs.*USE CATALOG|GRANT USE CATALOG|GRANT CREATE SCHEMA/i.test(error);
            if (isPermissionError) {
              return <PermissionErrorBlock error={error} onGranted={() => { setError(null); }} />;
            }
            return (
              <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            );
          })()}

          {step === "welcome" && (
            <WelcomeStep config={config} cloud={cloud} loading={loading} />
          )}

          {step === "storage-location" && (
            <StorageLocationStep
              catalog={catalogInput}
              schema={schemaInput}
              onCatalogChange={setCatalogInput}
              onSchemaChange={setSchemaInput}
              phase={storagePhase}
              checks={storageChecks}
              envVarLocked={storageEnvVarLocked}
            />
          )}

          {step === "permissions" && (
            <WizardPermissionsStep
              readiness={readiness}
              loading={loading}
              fetchError={readinessError}
              onRecheck={loadReadiness}
              onAutoGrant={handleAutoGrant}
              autoGrantRunning={grantRunning}
              autoGrantResult={grantResult}
              verifyingGrants={verifyingGrants}
              grantVerifyElapsed={grantVerifyElapsed}
            />
          )}

          {step === "create-tables" && (
            <CreateTablesStep
              setupStatus={setupStatus}
              creating={creating}
              tablesJustCreated={tablesJustCreated}
              preflightResult={preflightResult}
              preflightLoading={preflightLoading}
              onRecheck={loadPreflight}
            />
          )}

          {step === "workspace-filter" && (
            <WorkspaceFilterStep
              loading={wsLoading}
              workspaces={allWorkspaces}
              selectedIds={selectedWsIds}
              onToggle={(id) => setSelectedWsIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              })}
              onSelectAll={() => setSelectedWsIds(new Set(allWorkspaces.map((w) => w.id)))}
              onClearAll={() => setSelectedWsIds(new Set())}
              saved={wsSaved}
              locked={wsLocked}
              lockedIds={lockedWsIds}
            />
          )}

          {step === "complete" && <CompleteStep />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between rounded-b-xl border-t px-8 py-4" style={{ borderColor: '#E5E5E5' }}>
          <div>
            {currentIdx > 0 && (
              <button
                onClick={goBack}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
              >
                Back
              </button>
            )}
          </div>
          <div>
            {step === "complete" ? (
              <button
                onClick={onComplete}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
              >
                Go to Dashboard
              </button>
            ) : step === "workspace-filter" ? (
              <div className="flex items-center gap-2">
                {!wsLocked && (
                  <button
                    onClick={goNext}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Skip
                  </button>
                )}
                <button
                  onClick={() => { if (!wsLocked) saveWorkspaceFilter(); goNext(); }}
                  disabled={wsLoading}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50"
                >
                  {selectedWsIds.size === 0 ? "Continue (all workspaces)" : `Save & Continue (${selectedWsIds.size} workspace${selectedWsIds.size !== 1 ? "s" : ""})`}
                </button>
              </div>
            ) : step === "create-tables" ? (
              creating ? null
              : (tablesJustCreated || setupStatus?.all_tables_exist) ? (
                <button
                  onClick={goNext}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={handleCreateTables}
                  disabled={preflightLoading || !preflightResult?.ok}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50"
                >
                  Create Tables
                </button>
              )
            ) : step === "storage-location" ? (
              storagePhase === "done" ? (
                <button
                  onClick={goNext}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={async () => {
                    const cat = catalogInput.trim();
                    const sch = schemaInput.trim();
                    if (!cat || !sch) return;
                    setError(null);

                    // Step 1: Save config — skip when catalog/schema come from env vars
                    // (env vars always win in get_catalog_schema(); saving to file is a no-op).
                    setStorageChecks({ config: null, catalog: null, schema: null });
                    if (storageEnvVarLocked) {
                      setStoragePhase("creating-catalog");
                      setStorageChecks(c => ({ ...c, config: true }));
                    } else {
                      setStoragePhase("saving");
                      let saved = false;
                      for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
                        try {
                          const res = await fetch("/api/settings/catalog", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ catalog: cat, schema: sch }),
                            signal: AbortSignal.timeout(30000),
                          });
                          if (!res.ok) {
                            const body = await res.json().catch(() => ({}));
                            setError(body.detail || `Failed to save (HTTP ${res.status})`);
                            setStorageChecks(c => ({ ...c, config: false }));
                            setStoragePhase("error");
                            return;
                          }
                          saved = true;
                        } catch (e: unknown) {
                          if (e instanceof Error && e.name === "TimeoutError" && attempt < 3) {
                            await new Promise(r => setTimeout(r, 4000));
                          } else {
                            setError(e instanceof Error && e.name === "TimeoutError"
                              ? "Server is not responding. Wait a moment and try again."
                              : `Failed to save: ${e}`);
                            setStorageChecks(c => ({ ...c, config: false }));
                            setStoragePhase("error");
                            return;
                          }
                        }
                      }
                      setStorageChecks(c => ({ ...c, config: true }));
                    }

                    // Step 2: Create catalog
                    setStoragePhase("creating-catalog");
                    try {
                      const res = await fetch("/api/setup/ensure-catalog", {
                        method: "POST",
                        signal: AbortSignal.timeout(45000),
                      });
                      const body = await res.json().catch(() => ({}));
                      if (!res.ok || body.ok === false) {
                        setError(body.message || body.detail || `Could not create catalog \`${cat}\``);
                        setStorageChecks(c => ({ ...c, catalog: false }));
                        setStoragePhase("error");
                        return;
                      }
                      setStorageChecks(c => ({ ...c, catalog: true }));
                    } catch (e: unknown) {
                      setError(`Could not create catalog: ${e}`);
                      setStorageChecks(c => ({ ...c, catalog: false }));
                      setStoragePhase("error");
                      return;
                    }

                    // Step 3: Create schema
                    setStoragePhase("creating-schema");
                    try {
                      const res = await fetch("/api/setup/ensure-schema", {
                        method: "POST",
                        signal: AbortSignal.timeout(45000),
                      });
                      const body = await res.json().catch(() => ({}));
                      if (!res.ok || body.ok === false) {
                        setError(body.message || body.detail || `Could not create schema \`${cat}.${sch}\``);
                        setStorageChecks(c => ({ ...c, schema: false }));
                        setStoragePhase("error");
                        return;
                      }
                      setStorageChecks(c => ({ ...c, schema: true }));
                    } catch (e: unknown) {
                      setError(`Could not create schema: ${e}`);
                      setStorageChecks(c => ({ ...c, schema: false }));
                      setStoragePhase("error");
                      return;
                    }

                    setStoragePhase("done");
                  }}
                  disabled={!catalogInput.trim() || !schemaInput.trim() || (storagePhase !== "idle" && storagePhase !== "error")}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50"
                >
                  {storagePhase !== "idle" && storagePhase !== "error" ? (
                    <span className="flex items-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                      </svg>
                      Working…
                    </span>
                  ) : storagePhase === "error" ? "Retry" : "Save & Continue"}
                </button>
              )
            ) : step === "permissions" ? (
              <button
                onClick={goNext}
                disabled={loading || verifyingGrants || readiness == null || (readiness.overall !== "ready" && readiness.overall !== "core_ready")}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            ) : (
              <button
                onClick={goNext}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
              >
                Next
              </button>
            )}
          </div>
        </div>
    </>
  );

  if (embedded) {
    return <div className="flex flex-col overflow-y-auto">{wizardInner}</div>;
  }

  return createPortal(
    <div className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="animate-dialog mx-4 w-full max-w-2xl rounded-xl bg-white shadow-2xl">
          {wizardInner}
        </div>
      </div>
    </div>,
    document.body
  );
}

function WelcomeStep({ config, cloud, loading }: { config: ConfigData | null; cloud: CloudData | null; loading: boolean }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        We detected the following environment. Verify this looks correct before proceeding.
      </p>

      <div className="space-y-3">
        <InfoRow
          label="Cloud Provider"
          value={loading ? "Detecting…" : (cloud ? CLOUD_LABELS[cloud.provider] || cloud.provider : "Unknown")}
          loading={loading}
        />
        <InfoRow
          label="Workspace"
          value={loading ? "Detecting…" : (cloud?.host || "Unknown")}
          loading={loading}
        />
        {loading ? (
          <InfoRow label="SQL Warehouse" value="Detecting…" loading={true} />
        ) : config?.warehouse ? (
          <InfoRow
            label="SQL Warehouse"
            value={config.warehouse.name || config.warehouse.id || "Unknown"}
            status={config.warehouse.state === "RUNNING" ? "ok" : config.warehouse.state === "UNKNOWN" ? undefined : "warn"}
          />
        ) : (
          <div className="rounded-lg bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-800 mb-1">No SQL warehouse detected</p>
            <p className="text-xs text-amber-700">
              The warehouse is set via the <span className="font-mono">DATABRICKS_WAREHOUSE_ID</span> app resource binding or the <span className="font-mono">DATABRICKS_HTTP_PATH</span> env var in <span className="font-mono">app.yaml</span>.
              Add a SQL warehouse resource in the Databricks Apps UI and redeploy, then restart setup.
            </p>
          </div>
        )}
        <InfoRow
          label="Identity"
          value={loading ? "Detecting…" : (config?.identity
            ? (config.identity.display_name === config.identity.user_name
                ? config.identity.user_name
                : `${config.identity.display_name} (${config.identity.user_name})`)
            : "Unknown")}
          loading={loading}
        />
      </div>
    </div>
  );
}

function StorageCheckRow({ label, state }: { label: string; state: "pending" | "running" | "done" | "error" }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      {state === "running" ? (
        <svg className="h-4 w-4 shrink-0 animate-spin text-gray-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
        </svg>
      ) : state === "done" ? (
        <svg className="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : state === "error" ? (
        <svg className="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      ) : (
        <div className="h-4 w-4 shrink-0 rounded-full border-2 border-gray-300" />
      )}
      <span className={state === "error" ? "text-red-600" : state === "done" ? "text-gray-800 font-medium" : "text-gray-500"}>{label}</span>
    </div>
  );
}

function StorageLocationStep({
  catalog,
  schema,
  onCatalogChange,
  onSchemaChange,
  phase,
  checks,
  envVarLocked,
}: {
  catalog: string;
  schema: string;
  onCatalogChange: (v: string) => void;
  onSchemaChange: (v: string) => void;
  phase: string;
  checks: { config: boolean | null; catalog: boolean | null; schema: boolean | null };
  envVarLocked?: boolean;
}) {
  const locked = phase !== "idle" && phase !== "error";

  const rowState = (
    checkVal: boolean | null,
    activePhase: string,
  ): "pending" | "running" | "done" | "error" => {
    if (phase === activePhase) return "running";
    if (checkVal === true) return "done";
    if (checkVal === false) return "error";
    return "pending";
  };

  const showProgress = phase !== "idle";

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600">
        Choose where the app will store its pre-aggregated cost tables.
        The catalog and schema will be created for you if they don't already exist.
      </p>

      {envVarLocked && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0 0v2m0-2h2m-2 0H10m2-6V7a4 4 0 00-8 0v4H3a1 1 0 00-1 1v6a2 2 0 002 2h14a2 2 0 002-2v-6a1 1 0 00-1-1h-1V7a4 4 0 00-8 0z" />
          </svg>
          <p className="text-xs text-amber-800">
            Catalog and schema are set by environment variable (<code className="font-mono">COST_OBS_CATALOG</code> / <code className="font-mono">COST_OBS_SCHEMA</code>). To change them, update the environment variables in the Databricks Apps configuration.
          </p>
        </div>
      )}

      <div className={`rounded-lg border p-4 space-y-4 ${locked || envVarLocked ? "border-gray-100 bg-gray-50" : "border-gray-200 bg-white"}`}>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-gray-700">Catalog</label>
          <input
            type="text"
            value={catalog}
            onChange={(e) => onCatalogChange(e.target.value)}
            disabled={locked || envVarLocked}
            placeholder="e.g. my_catalog"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621] disabled:bg-gray-100 disabled:text-gray-500"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-gray-700">Schema</label>
          <input
            type="text"
            value={schema}
            onChange={(e) => onSchemaChange(e.target.value)}
            disabled={locked || envVarLocked}
            placeholder="e.g. cost_obs_app"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621] disabled:bg-gray-100 disabled:text-gray-500"
          />
        </div>
      </div>

      {showProgress ? (
        <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
          {!envVarLocked && (
            <StorageCheckRow label="Saving configuration" state={rowState(checks.config, "saving")} />
          )}
          {(checks.catalog !== null || phase === "creating-catalog" || phase === "creating-schema" || phase === "done" || phase === "error") && (
            <StorageCheckRow label={`Creating catalog \`${catalog}\``} state={rowState(checks.catalog, "creating-catalog")} />
          )}
          {(checks.schema !== null || phase === "creating-schema" || phase === "done" || (phase === "error" && checks.catalog === true)) && (
            <StorageCheckRow label={`Creating schema \`${catalog}.${schema}\``} state={rowState(checks.schema, "creating-schema")} />
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          Tables will be placed at{" "}
          <span className="font-mono">{catalog || "…"}.{schema || "…"}</span>.
        </p>
      )}
    </div>
  );
}

interface WizardPermissionsStepProps {
  readiness: ReadinessResult | null;
  loading: boolean;
  fetchError: string | null;
  onRecheck: (forceRefresh?: boolean) => void;
  onAutoGrant: () => Promise<void>;
  autoGrantRunning: boolean;
  autoGrantResult: { ok: boolean; message: string; errors?: string[]; grants_sql?: string; obo_scope_missing?: boolean } | null;
  verifyingGrants: boolean;
  grantVerifyElapsed: number;
}

function WizardPermissionsStep({
  readiness,
  loading,
  fetchError,
  onRecheck,
  onAutoGrant,
  autoGrantRunning,
  autoGrantResult,
  verifyingGrants,
  grantVerifyElapsed,
}: WizardPermissionsStepProps) {
  const coreReady = readiness != null &&
    (readiness.overall === "ready" || readiness.overall === "core_ready");

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Verifying the app's service principal has access to required Databricks system tables.
        Core tables (billing) must pass before you can continue.
      </p>
      {verifyingGrants && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 flex items-center gap-2">
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
          <span className="text-sm text-blue-700">Verifying SP access… ({grantVerifyElapsed}s)</span>
        </div>
      )}
      {!loading && !verifyingGrants && coreReady && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          Core access confirmed — you can proceed to Create Tables.
        </div>
      )}
      <ReadinessChecks
        result={readiness}
        loading={loading}
        fetchError={fetchError}
        onRecheck={onRecheck}
        onAutoGrant={onAutoGrant}
        autoGrantRunning={autoGrantRunning}
        autoGrantResult={autoGrantResult}
      />
    </div>
  );
}

function CreateTablesStep({ setupStatus, creating, tablesJustCreated, preflightResult, preflightLoading, onRecheck }: {
  setupStatus: SetupStatus | null;
  creating: boolean;
  tablesJustCreated: boolean;
  preflightResult: { ok: boolean; status: string; message: string } | null;
  preflightLoading: boolean;
  onRecheck: () => void;
}) {
  if (preflightLoading) {
    return <LoadingSpinner text="Checking catalog access…" />;
  }

  if (preflightResult && !preflightResult.ok) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-800 mb-1">Catalog not accessible</p>
          <p className="text-sm text-red-700">{preflightResult.message}</p>
        </div>
        <button
          onClick={onRecheck}
          className="text-sm font-medium hover:underline"
          style={{ color: '#FF3621' }}
        >
          Re-check catalog
        </button>
      </div>
    );
  }

  if (creating) {
    const tableProgress = setupStatus?.task?.table_progress ?? {};
    const progressEntries = Object.entries(tableProgress);
    return (
      <div className="space-y-4">
        <LoadingSpinner text="Creating materialized views... This may take a few minutes." />
        {progressEntries.length > 0 && (
          <div className="space-y-1">
            {progressEntries.map(([table, state]) => (
              <div key={table} className="flex items-center gap-2 px-3 py-1 text-sm">
                {state === "done" ? (
                  <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                ) : state === "running" ? (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-[#FF3621]" />
                ) : state === "error" ? (
                  <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                ) : (
                  <div className="h-4 w-4 rounded-full border-2 border-gray-200" />
                )}
                <span className="font-mono text-xs text-gray-700">{table}</span>
                {state === "running" && <span className="text-xs text-gray-500">building…</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (tablesJustCreated || setupStatus?.all_tables_exist) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-3">
          <svg className="h-5 w-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-medium text-green-800">Tables created successfully. Click <strong>Next</strong> to continue.</p>
        </div>
        {setupStatus && Object.keys(setupStatus.tables).length > 0 && (
          <div className="space-y-1">
            {Object.entries(setupStatus.tables).map(([table, exists]) => (
              <div key={table} className="flex items-center gap-2 px-3 py-1 text-sm">
                <svg className={`h-4 w-4 ${exists ? "text-green-500" : "text-amber-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={exists ? "M5 13l4 4L19 7" : "M6 18L18 6M6 6l12 12"} />
                </svg>
                <span className="font-mono text-xs">{table}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const interrupted = setupStatus?.task?.status === "interrupted";
  const tableProgress = setupStatus?.task?.table_progress ?? {};
  const builtCount = Object.values(tableProgress).filter((s) => s === "done").length;
  const totalCount = Object.keys(tableProgress).length;

  return (
    <div className="space-y-4">
      {interrupted && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-800 mb-1">Previous build was interrupted</p>
          <p className="text-sm text-amber-700">
            The app restarted while building materialized views.
            {totalCount > 0 && ` ${builtCount} of ${totalCount} tables were built before the interruption.`}
            {" "}Click "Create Tables" to rebuild from scratch.
          </p>
        </div>
      )}

      {!interrupted && (
        <p className="text-sm text-gray-600">
          The app uses pre-aggregated materialized views for fast dashboard loading.
          This step creates them with 6 months of historical data.
        </p>
      )}

      {setupStatus && setupStatus.missing_tables.length > 0 && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          {setupStatus.missing_tables.length} table(s) need to be created in{" "}
          <span className="font-mono">{setupStatus.catalog}.{setupStatus.schema}</span>.
        </div>
      )}

      <p className="text-xs text-gray-500">
        This typically takes 2-5 minutes depending on data volume.
        Click "Create Tables" to begin.
      </p>
    </div>
  );
}

function WorkspaceFilterStep({
  loading,
  workspaces,
  selectedIds,
  onToggle,
  onSelectAll,
  onClearAll,
  saved,
  locked,
  lockedIds,
}: {
  loading: boolean;
  workspaces: { id: string; name: string }[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  saved: boolean;
  locked: boolean;
  lockedIds: string[];
}) {
  if (loading) return <LoadingSpinner text="Loading workspaces..." />;

  if (locked) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <svg className="h-4 w-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="text-sm font-semibold text-amber-800">Workspace filter already configured</span>
          </div>
          <p className="text-xs text-amber-700">
            This setting was locked during initial setup and cannot be changed. To modify the workspace filter, delete this app deployment and run setup again.
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <div className="text-xs font-medium text-gray-500 mb-2">Currently scoped to:</div>
          {lockedIds.length === 0 ? (
            <span className="text-sm text-gray-700">All workspaces</span>
          ) : (
            <div className="space-y-1">
              {lockedIds.map((id) => (
                <div key={id} className="text-xs font-mono text-gray-700 bg-white rounded border border-gray-200 px-2 py-1">{id}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Choose which workspaces this app should display data for. You can adjust this after setup in the workspace filter dropdown.
      </p>

      {workspaces.length === 0 ? (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          Could not load workspace list. Click <strong>Continue (all workspaces)</strong> to show data for all workspaces, or go back and check that system table permissions are granted.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {selectedIds.size === 0 ? "All workspaces will be shown" : `${selectedIds.size} of ${workspaces.length} selected`}
            </span>
            <div className="flex gap-3">
              <button onClick={onSelectAll} className="text-xs font-medium hover:underline" style={{ color: '#FF3621' }}>Select All</button>
              <button onClick={onClearAll} className="text-xs font-medium hover:underline" style={{ color: '#FF3621' }}>Clear All</button>
            </div>
          </div>

          <div className="max-h-52 overflow-y-auto space-y-1 rounded-lg border border-gray-200 p-2">
            {workspaces.map((ws) => {
              const checked = selectedIds.has(ws.id);
              return (
                <label key={ws.id} className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors ${checked ? "bg-orange-50" : "hover:bg-gray-50"}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(ws.id)}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{ws.name}</div>
                    <div className="text-xs font-mono text-gray-400">{ws.id}</div>
                  </div>
                </label>
              );
            })}
          </div>

          {selectedIds.size === 0 && (
            <p className="text-xs text-gray-500">
              No workspaces selected — all workspaces will be visible in the dashboard. Select specific workspaces to restrict the data shown.
            </p>
          )}
        </>
      )}

      {saved && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5">
          <p className="text-xs font-medium text-green-800">Workspace filter saved and locked. This setting persists across redeploys.</p>
        </div>
      )}
    </div>
  );
}

function CompleteStep() {
  return (
    <div className="flex flex-col items-center py-8">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
        <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h3 className="text-lg font-bold text-gray-900 text-center">Setup Complete</h3>
      <p className="mt-2 max-w-sm text-sm text-gray-600 text-center">
        Your environment is configured and materialized views are ready.
        Click below to start exploring your cost data.
      </p>
      <div className="mt-6 w-full rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-xs font-semibold text-amber-800 mb-1">Important Disclaimer</p>
        <p className="text-xs text-amber-700 leading-relaxed">
          This application is provided as a reference implementation and is not official production software from Databricks.
          It is not covered by Databricks support SLAs. If you encounter issues or have questions, your Solutions Architect
          (SA) and account team are available to assist. We encourage you to customize and tune this application to meet
          your organization's specific requirements. Databricks customers using this reference architecture should treat
          their deployment and use like OSS software.
        </p>
      </div>
    </div>
  );
}

function LoadingSpinner({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="h-8 w-8 animate-spin rounded-full" style={{ border: '3px solid #e5e7eb', borderTopColor: '#FF3621' }} />
      <p className="mt-3 text-sm text-gray-500">{text}</p>
    </div>
  );
}

function InfoRow({ label, value, status, loading }: { label: string; value: string; status?: "ok" | "warn" | "error"; loading?: boolean }) {
  return (
    <div className="flex items-center gap-4 rounded-lg bg-gray-50 px-4 py-2.5">
      <span className="shrink-0 text-sm font-medium text-gray-500">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        {loading ? (
          <svg className="h-4 w-4 animate-spin text-gray-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
          </svg>
        ) : (
          <span className="truncate text-right text-sm font-medium text-gray-900" title={value}>{value}</span>
        )}
        {!loading && status === "ok" && <span className="shrink-0 h-2 w-2 rounded-full bg-green-500" />}
        {!loading && status === "warn" && <span className="shrink-0 h-2 w-2 rounded-full bg-amber-500" />}
        {!loading && status === "error" && <span className="shrink-0 h-2 w-2 rounded-full bg-red-500" />}
      </div>
    </div>
  );
}
