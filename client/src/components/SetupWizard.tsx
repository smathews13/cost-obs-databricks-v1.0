import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { ReadinessChecks } from "./settings/ReadinessChecks";
import type { ReadinessResult } from "./settings/ReadinessChecks";

interface SetupWizardProps {
  onComplete: () => void;
  onClose?: () => void;
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
  task?: { status: string; error: string | null };
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

export function SetupWizard({ onComplete, onClose }: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [cloud, setCloud] = useState<CloudData | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [grantRunning, setGrantRunning] = useState(false);
  const [grantResult, setGrantResult] = useState<{ ok: boolean; message: string; errors?: string[] } | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (configRes.ok) setConfig(await configRes.json());
        if (cloudRes.ok) setCloud(await cloudRes.json());
      } catch (e) {
        setError(`Failed to load environment info: ${e}`);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const loadReadiness = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setReadinessError(null);
    try {
      const url = forceRefresh ? "/api/setup/readiness?refresh=true" : "/api/setup/readiness";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReadiness(await res.json());
    } catch (e) {
      setReadinessError(`Failed to check system readiness: ${e}`);
    } finally {
      setLoading(false);
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
      setGrantResult({ ok, message, errors: body.errors });
      if (ok) setTimeout(() => loadReadiness(true), 800);
    } catch {
      setGrantResult({ ok: false, message: "Network error running grants." });
    } finally {
      setGrantRunning(false);
    }
  }, [loadReadiness]);

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

      // Poll for completion
      const poll = setInterval(async () => {
        const status = await pollSetupStatus();
        if (status?.all_tables_exist) {
          clearInterval(poll);
          setCreating(false);
          setStep("complete");
        } else if (status?.task?.status === "error" && status.task.error) {
          clearInterval(poll);
          setCreating(false);
          setError(`Table creation failed: ${status.task.error}`);
        } else if (status?.task?.status === "error" || (status?.task?.status === "done" && !status.all_tables_exist)) {
          clearInterval(poll);
          setCreating(false);
          const detail = status?.task?.error || "unknown error";
          setError(`Table creation failed: ${detail}`);
        }
      }, 2000);

      // Safety timeout after 10 minutes
      setTimeout(() => {
        clearInterval(poll);
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
      if (next === "create-tables") pollSetupStatus();
      if (next === "workspace-filter") loadWorkspaces();
    }
  };

  const goBack = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const currentIdx = STEPS.indexOf(step);

  return createPortal(
    <div className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="animate-dialog mx-4 w-full max-w-2xl rounded-xl bg-white shadow-2xl">
        {/* Header */}
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

        {/* Step indicator */}
        <div className="flex border-b px-8 py-3" style={{ borderColor: '#E5E5E5' }}>
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 items-center">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                i < currentIdx ? "bg-green-500 text-white" :
                i === currentIdx ? "text-white" : "bg-gray-200 text-gray-500"
              }`} style={i === currentIdx ? { backgroundColor: '#FF3621' } : undefined}>
                {i < currentIdx ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                ) : i + 1}
              </div>
              <span className={`ml-2 text-xs font-medium ${i === currentIdx ? "text-gray-900" : "text-gray-500"}`}>
                {STEP_LABELS[s]}
              </span>
              {i < STEPS.length - 1 && <div className="mx-3 h-px flex-1 bg-gray-200" />}
            </div>
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
            <StorageLocationStep config={config} />
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
            />
          )}

          {step === "create-tables" && (
            <CreateTablesStep
              setupStatus={setupStatus}
              creating={creating}
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
            {currentIdx > 0 && step !== "complete" && (
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
                  onClick={async () => { if (!wsLocked) await saveWorkspaceFilter(); goNext(); }}
                  disabled={wsLoading}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50"
                >
                  {selectedWsIds.size === 0 ? "Continue (all workspaces)" : `Save & Continue (${selectedWsIds.size} workspace${selectedWsIds.size !== 1 ? "s" : ""})`}
                </button>
              </div>
            ) : step === "create-tables" ? (
              creating ? null
              : setupStatus?.all_tables_exist ? (
                <button
                  onClick={goNext}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={handleCreateTables}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
                >
                  Create Tables
                </button>
              )
            ) : step === "storage-location" ? (
              <button
                onClick={goNext}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
              >
                Next
              </button>
            ) : step === "permissions" ? (
              <button
                onClick={goNext}
                disabled={loading || (readiness != null && readiness.overall !== "ready" && readiness.overall !== "core_ready")}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            ) : (
              <button
                onClick={goNext}
                disabled={loading}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
}

function WelcomeStep({ config, cloud, loading }: { config: ConfigData | null; cloud: CloudData | null; loading: boolean }) {
  const [devOpen, setDevOpen] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<{ token: string; host: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "host" | "env" | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = (text: string, key: "token" | "host" | "env") => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleGenerateToken = async () => {
    setGenerating(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/setup/generate-token", { method: "POST" });
      const data = await res.json();
      if (data.status === "created") {
        setGeneratedToken({ token: data.token, host: data.host });
      } else {
        setTokenError(data.message || "Failed to generate token");
      }
    } catch (e) {
      setTokenError(`Request failed: ${e}`);
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return <LoadingSpinner text="Detecting environment..." />;

  const envFileContent = generatedToken
    ? `DATABRICKS_HOST=${generatedToken.host}\nDATABRICKS_TOKEN=${generatedToken.token}\nDATABRICKS_HTTP_PATH=auto`
    : "";

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        We detected the following environment. Verify this looks correct before proceeding.
      </p>

      <div className="space-y-3">
        <InfoRow
          label="Cloud Provider"
          value={cloud ? CLOUD_LABELS[cloud.provider] || cloud.provider : "Unknown"}
        />
        <InfoRow
          label="Workspace"
          value={cloud?.host || "Unknown"}
        />
        {config?.warehouse ? (
          <InfoRow
            label="SQL Warehouse"
            value={`${config.warehouse.name || config.warehouse.id} (${config.warehouse.state})`}
            status={config.warehouse.state === "RUNNING" ? "ok" : "warn"}
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
          value={config?.identity ? `${config.identity.display_name} (${config.identity.user_name})` : "Unknown"}
        />
      </div>

      {/* Local development token section */}
      <div className="rounded-lg border border-gray-200">
        <button
          onClick={() => setDevOpen(!devOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-sm font-medium text-gray-700">Local development setup</span>
          <svg className={`h-4 w-4 text-gray-500 transition-transform ${devOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {devOpen && (
          <div className="border-t border-gray-200 px-4 pb-4 pt-3 space-y-3">
            <p className="text-xs text-gray-500">
              The deployed app uses OAuth automatically — no token needed here. If you want to run this app locally, generate a token to use in your <span className="font-mono">.env.local</span> file.
            </p>
            {!generatedToken ? (
              <button
                onClick={handleGenerateToken}
                disabled={generating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {generating ? (
                  <><div className="h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent" /> Generating...</>
                ) : (
                  <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>Generate Token</>
                )}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
                  Token generated — valid for 90 days. Copy the env block below into your <span className="font-mono">.env.local</span>.
                </div>
                <div className="relative rounded-lg bg-gray-900 px-4 py-3">
                  <pre className="text-xs text-green-400 overflow-x-auto whitespace-pre">{envFileContent}</pre>
                  <button
                    onClick={() => handleCopy(envFileContent, "env")}
                    className="absolute right-2 top-2 rounded px-2 py-1 text-xs text-gray-500 hover:bg-white/10 hover:text-white transition-colors"
                  >
                    {copied === "env" ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-gray-500">Keep this token secure — treat it like a password.</p>
              </div>
            )}
            {tokenError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{tokenError}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StorageLocationStep({ config }: { config: ConfigData | null }) {
  const catalog = config?.storage_location?.catalog;
  const schema = config?.storage_location?.schema;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Materialized views will be created in the catalog and schema configured in your app's
        environment variables. This location is set at deployment time and cannot be changed
        without redeploying the app.
      </p>

      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        {catalog && schema ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">Catalog</span>
            <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-sm font-mono font-medium text-orange-800">{catalog}</span>
            <span className="text-gray-300">·</span>
            <span className="text-xs text-gray-500">Schema</span>
            <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-sm font-mono font-medium text-orange-800">{schema}</span>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm text-amber-700 font-medium">No storage location detected</p>
            <p className="text-xs text-amber-600">
              Set <span className="font-mono">COST_OBS_CATALOG</span> and{" "}
              <span className="font-mono">COST_OBS_SCHEMA</span> in your app.yaml environment
              variables, then restart the app before continuing.
            </p>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        To use a different catalog or schema, update <span className="font-mono">COST_OBS_CATALOG</span>{" "}
        and <span className="font-mono">COST_OBS_SCHEMA</span> in app.yaml and redeploy.
        The service principal needs <span className="font-mono">USE CATALOG</span> and{" "}
        <span className="font-mono">CREATE SCHEMA</span> privileges on the target catalog.
      </p>
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
  autoGrantResult: { ok: boolean; message: string; errors?: string[] } | null;
}

function WizardPermissionsStep({
  readiness,
  loading,
  fetchError,
  onRecheck,
  onAutoGrant,
  autoGrantRunning,
  autoGrantResult,
}: WizardPermissionsStepProps) {
  const coreReady = readiness != null &&
    (readiness.overall === "ready" || readiness.overall === "core_ready");

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Verifying the app's service principal has access to required Databricks system tables.
        Core tables (billing) must pass before you can continue.
      </p>
      {!loading && coreReady && (
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

function CreateTablesStep({ setupStatus, creating }: {
  setupStatus: SetupStatus | null;
  creating: boolean;
}) {
  if (creating) {
    return (
      <div className="space-y-4">
        <LoadingSpinner text="Creating materialized views... This may take a few minutes." />
        {setupStatus && (
          <div className="space-y-1">
            {Object.entries(setupStatus.tables).map(([table, exists]) => (
              <div key={table} className="flex items-center gap-2 px-3 py-1 text-sm">
                {exists ? (
                  <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                ) : (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                )}
                <span className="font-mono text-xs">{table}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (setupStatus?.all_tables_exist) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
          All materialized views are ready.
        </div>
        <div className="space-y-1">
          {Object.entries(setupStatus.tables).map(([table, exists]) => (
            <div key={table} className="flex items-center gap-2 px-3 py-1 text-sm">
              <svg className={`h-4 w-4 ${exists ? "text-green-500" : "text-red-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={exists ? "M5 13l4 4L19 7" : "M6 18L18 6M6 6l12 12"} />
              </svg>
              <span className="font-mono text-xs">{table}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        The app uses pre-aggregated materialized views for fast dashboard loading.
        This step creates them with 365 days of historical data.
      </p>

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
        Choose which workspaces this app should display data for. This is a one-time choice — it cannot be changed after setup.
      </p>

      {workspaces.length === 0 ? (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          No workspaces found in the last 90 days of billing data. Skip this step to show all workspaces.
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
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
        <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h3 className="text-lg font-bold text-gray-900">Setup Complete</h3>
      <p className="mt-2 max-w-sm text-sm text-gray-600">
        Your environment is configured and materialized views are ready.
        Click below to start exploring your cost data.
      </p>
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

function InfoRow({ label, value, status }: { label: string; value: string; status?: "ok" | "warn" | "error" }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2.5">
      <span className="text-sm font-medium text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{value}</span>
        {status === "ok" && <span className="h-2 w-2 rounded-full bg-green-500" />}
        {status === "warn" && <span className="h-2 w-2 rounded-full bg-amber-500" />}
        {status === "error" && <span className="h-2 w-2 rounded-full bg-red-500" />}
      </div>
    </div>
  );
}
