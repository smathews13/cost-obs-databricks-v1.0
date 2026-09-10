import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure-128.png";
import gcpLogo from "@/assets/gcp.svg";
import { Spinner } from "@/components/Spinner";
import {
  resolveSourceCloud,
  resolveSourceRegion,
  type SourceCloud,
} from "@/utils/sourceCloud";

interface MvSource {
  label: string;
  catalog: string;
  schema: string;
  tables?: string[];
  workspace_ids?: string[];
  missing_tables?: string[];
  shared_view_total?: number;
  cloud?: string;
  region?: string;
  added_at?: string;
  share_last_updated?: string;
  required_grants?: string[];
  catalog_explorer_tables?: Array<{ fqn: string; url: string }>;
  catalog_explorer_schema_url?: string;
}

// Cloud → { logo, label font color } per spec: Google red, AWS gold, Azure light green.
const CLOUD_META: Record<SourceCloud, { logo: string; color: string; name: string }> = {
  gcp: { logo: gcpLogo, color: "#B3261E", name: "Google Cloud" },
  aws: { logo: awsLogo, color: "#B8860B", name: "AWS" },
  azure: { logo: azureLogo, color: "#3E9C3E", name: "Azure" },
};

function fmtTs(ts?: string): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return ts; }
}

interface PreviewTable {
  table: string;
  status: "match" | "mismatch" | "unreadable" | "absent";
}

interface PreviewResult {
  matched: number;
  total: number;
  tables: PreviewTable[];
  required_grants?: string[];
  workspace_candidates?: Array<{
    workspace_id: string;
    workspace_name: string;
  }>;
}

// Settings → Config: register additional materialized-view source locations
// (typically Delta-shared in from another workspace) whose tables share the app's
// MV structure. They are unioned into every MV read (additive: local data always
// included) and tagged with the source's label for later filtering. After a
// catalog + schema is chosen, the views actually present in that schema are listed
// and the user multiselects which ones to include.
export function MvSourcesSection() {
  const queryClient = useQueryClient();

  // detail=1 asks the server for each source's share_last_updated (DESCRIBE DETAIL).
  // The top-nav SourceLabelFilter fetches ["mv-sources"] WITHOUT detail, so this
  // heavier query is separate and only runs in the settings modal.
  const { data, isLoading } = useQuery<{
    sources: MvSource[];
    local_label: string;
    recipient_refresh?: {
      supported: boolean;
      mode: "provider_managed";
      check_action: "metadata_and_local_bindings_only";
    };
  }>({
    queryKey: ["mv-sources", "detail"],
    queryFn: () => fetch("/api/settings/mv-sources?detail=1").then((r) => r.json()).catch(() => ({ sources: [], local_label: "" })),
    staleTime: 30 * 1000,
  });
  const sources = data?.sources ?? [];
  const existingLabels = Array.from(new Set(sources.map((source) => source.label)))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [label, setLabel] = useState("");
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [checkingLabel, setCheckingLabel] = useState<string | null>(null);
  const [copiedGrantLabel, setCopiedGrantLabel] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [requiredGrants, setRequiredGrants] = useState<string[]>([]);

  // Load catalogs when the add form opens.
  useEffect(() => {
    if (!open || catalogs.length) return;
    fetch("/api/setup/list-catalogs").then((r) => r.json()).then((r) => setCatalogs(r.catalogs ?? [])).catch(() => setCatalogs([]));
  }, [open, catalogs.length]);

  // Load schemas whenever the catalog changes.
  useEffect(() => {
    setSchema("");
    setSchemas([]);
    setPreview(null);
    setSelected(new Set());
    setSelectedWorkspaceIds(new Set());
    if (!catalog) return;
    fetch(`/api/setup/list-schemas?catalog=${encodeURIComponent(catalog)}`)
      .then((r) => r.json()).then((r) => setSchemas(r.schemas ?? [])).catch(() => setSchemas([]));
  }, [catalog]);

  // Probe the chosen location whenever a full catalog.schema is selected; default the
  // selection to every view whose structure matches this app's.
  useEffect(() => {
    setPreview(null);
    setSelected(new Set());
    setSelectedWorkspaceIds(new Set());
    if (!catalog || !schema) return;
    setPreviewing(true);
    fetch(`/api/settings/mv-sources/preview?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`)
      .then((r) => r.json())
      .then((r: PreviewResult) => {
        setPreview(r);
        setSelected(new Set(
          (r.tables || []).filter((t) => t.status === "match").map((t) => t.table),
        ));
        setSelectedWorkspaceIds(new Set(
          (r.workspace_candidates ?? []).map((workspace) => workspace.workspace_id),
        ));
      })
      .catch(() => setPreview(null))
      .finally(() => setPreviewing(false));
  }, [catalog, schema]);

  // Views actually present in the shared schema (match or column-mismatch); absent
  // ones aren't shown. Only matching views can be selected: a column mismatch can't
  // be unioned into the app's structure.
  const presentTables = (preview?.tables ?? []).filter((t) => t.status !== "absent");
  const matchableCount = presentTables.filter((t) => t.status === "match").length;

  const toggle = (table: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const canAdd = Boolean(
    label.trim()
    && catalog
    && schema
    && selected.size > 0
    && selectedWorkspaceIds.size > 0
    && !busy,
  );

  const resetForm = () => {
    setCatalog(""); setSchema(""); setLabel(""); setPreview(null); setSelected(new Set());
    setSelectedWorkspaceIds(new Set()); setError(null);
  };

  const addSource = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/mv-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: label.trim(),
          catalog,
          schema,
          tables: Array.from(selected),
          workspace_ids: Array.from(selectedWorkspaceIds),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      // Refresh the sources list AND every dashboard tab: the unified views just
      // changed, so all visuals should refetch (the global progress bar reflects it).
      await queryClient.invalidateQueries();
      resetForm();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeSource = async (lbl: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/mv-sources?label=${encodeURIComponent(lbl)}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      // Refresh the sources list AND every dashboard tab: the unified views just
      // changed, so all visuals should refetch (the global progress bar reflects it).
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkFreshness = async (lbl: string) => {
    setCheckingLabel(lbl);
    setError(null);
    setRequiredGrants([]);
    try {
      const res = await fetch(`/api/settings/mv-sources/check?label=${encodeURIComponent(lbl)}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = body.detail;
        const nestedResult = (
          detail
          && typeof detail === "object"
          && "result" in detail
          && detail.result
          && typeof detail.result === "object"
        ) ? detail.result : null;
        const nestedGrants = nestedResult && "required_grants" in nestedResult
          ? nestedResult.required_grants
          : null;
        const nestedBuild = (
          nestedResult
          && "build" in nestedResult
          && nestedResult.build
          && typeof nestedResult.build === "object"
        ) ? nestedResult.build : null;
        const nestedBuildError = nestedBuild && "error" in nestedBuild
          ? nestedBuild.error
          : null;
        const nestedError = nestedResult && "error" in nestedResult
          ? nestedResult.error
          : null;
        if (Array.isArray(nestedGrants)) setRequiredGrants(nestedGrants);
        const message = typeof detail === "string"
          ? detail
          : detail?.message
            || nestedBuildError
            || nestedError
            || `HTTP ${res.status}`;
        throw new Error(String(message));
      }
      if (body.ok === false) {
        throw new Error(body.detail || body.error || body.build?.error || "Freshness check failed");
      }
      if (Array.isArray(body.required_grants) && body.required_grants.length > 0) {
        setRequiredGrants(body.required_grants);
        throw new Error("The shared tables exist, but the app service principal cannot read them. Apply the schema grants shown below.");
      }
      const configuredTables = sources.find((source) => source.label === lbl)?.tables;
      const statuses = new Map<string, string>(
        (Array.isArray(body.tables) ? body.tables : [])
          .map((table: PreviewTable) => [table.table, table.status]),
      );
      const failedTables = configuredTables?.length
        ? configuredTables.filter((table) => statuses.get(table) !== "match")
        : (Array.isArray(body.tables)
          ? body.tables.filter((table: PreviewTable) => table.status !== "match").map((table: PreviewTable) => table.table)
          : []);
      if (failedTables.length > 0) {
        throw new Error(`Freshness check failed for: ${failedTables.join(", ") || "configured views"}`);
      }
      setLastChecked((current) => ({ ...current, [lbl]: body.checked_at || new Date().toISOString() }));
      setRequiredGrants([]);
      await queryClient.invalidateQueries({ queryKey: ["mv-sources"] });
      await queryClient.invalidateQueries({ predicate: (query) => (
        ["billing", "aiml", "apps", "tagging", "dbsql", "users-groups"].includes(String(query.queryKey[0]))
      ) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingLabel(null);
    }
  };

  const selectClass =
    "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-[#2272B4] focus:outline-none focus:ring-1 focus:ring-[#2272B4] disabled:bg-gray-100 disabled:text-gray-500";

  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3">
      {/* Header: title + subtitle on the left, primary Browse button top-right. */}
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-900">Additional data (shared views)</h4>
          <p className="mt-0.5 text-xs text-gray-500">
            Provider updates appear automatically through OpenSharing. Re-checking reads current metadata and rebuilds this app&apos;s local view bindings.
          </p>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white transition-colors"
            style={{ backgroundColor: "#2272B4" }}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            Browse
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-gray-500">
          <Spinner size="sm" />
          <span>Loading…</span>
        </div>
      ) : sources.length > 0 ? (
        <div className="space-y-1.5">
          {sources.map((s) => {
            const sourceCloud = resolveSourceCloud(s.cloud, s.label, s.catalog);
            const meta = sourceCloud ? CLOUD_META[sourceCloud] : null;
            const sourceRegion = resolveSourceRegion(s.region, s.label, s.catalog);
            const added = fmtTs(s.added_at);
            const shareUpd = fmtTs(s.share_last_updated);
            return (
              <div key={s.label} className="flex items-center gap-2.5 rounded-md border border-gray-100 bg-gray-50 px-2.5 py-2">
                {meta && <img src={meta.logo} alt={meta.name} title={meta.name} className="h-4 w-4 shrink-0 object-contain" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-xs font-bold" style={meta ? { color: meta.color } : undefined}>{s.label}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-gray-500">{s.catalog}.{s.schema}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-500">
                    <span>
                      {s.tables
                        ? `${s.tables.length}${s.shared_view_total ? ` of ${s.shared_view_total}` : ""} shared view${s.tables.length === 1 ? "" : "s"}`
                        : "All shared views"}
                    </span>
                    {(s.workspace_ids?.length ?? 0) > 0 && (
                      <><span className="text-gray-300">·</span><span>Workspace {s.workspace_ids!.join(", ")}</span></>
                    )}
                    {(meta || sourceRegion) && (
                      <><span className="text-gray-300">·</span><span>{meta?.name || "Cloud"}{sourceRegion ? ` · ${sourceRegion}` : ""}</span></>
                    )}
                    {(s.workspace_ids?.length ?? 0) === 0 && (
                      <><span className="text-gray-300">·</span><span className="text-amber-700">Workspace scope not identified</span></>
                    )}
                    {(s.missing_tables?.length ?? 0) > 0 && (
                      <><span className="text-gray-300">·</span><span className="text-amber-700">Missing: {s.missing_tables!.join(", ")}</span></>
                    )}
                    {added && <><span className="text-gray-300">·</span><span>Added {added}</span></>}
                    {shareUpd && <><span className="text-gray-300">·</span><span>Share updated {shareUpd}</span></>}
                    {lastChecked[s.label] && checkingLabel !== s.label && <><span className="text-gray-300">·</span><span className="text-green-700">Checked just now</span></>}
                    {(s.tables?.length ?? 0) > 1 && s.catalog_explorer_schema_url ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-gray-300">·</span>
                        <a
                          href={s.catalog_explorer_schema_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-[#2272B4] hover:underline"
                          aria-label={`Open ${s.catalog}.${s.schema} in Catalog Explorer (opens in a new tab)`}
                        >
                          <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                          Open schema
                        </a>
                      </span>
                    ) : (s.catalog_explorer_tables ?? []).map((table) => (
                      <span key={table.fqn} className="inline-flex items-center gap-1">
                        <span className="text-gray-300">·</span>
                        <a
                          href={table.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-[#2272B4] hover:underline"
                          aria-label={`Open ${table.fqn} in Catalog Explorer (opens in a new tab)`}
                          title={table.fqn}
                        >
                          Open {table.fqn.split(".").at(-1)} in Catalog Explorer
                        </a>
                      </span>
                    ))}
                  </div>
                  {(s.required_grants?.length ?? 0) > 0 && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold text-amber-900">
                          Grant the app read access to activate this share
                        </p>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(s.required_grants!.join("\n"));
                              setCopiedGrantLabel(s.label);
                            } catch {
                              setError("Could not copy the grants. Select the SQL below and copy it manually.");
                            }
                          }}
                          className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold text-amber-900 hover:bg-amber-100"
                        >
                          {copiedGrantLabel === s.label ? "Copied" : "Copy grants"}
                        </button>
                      </div>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-amber-900">
                        {s.required_grants!.join("\n")}
                      </pre>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 self-center items-center gap-1">
                  <button
                    type="button"
                    onClick={() => checkFreshness(s.label)}
                    disabled={busy || checkingLabel !== null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-50"
                    title="Re-read shared-table metadata and rebuild local view bindings"
                  >
                    {checkingLabel === s.label ? <Spinner size="xs" /> : (
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.6m15.3 2A8 8 0 004.6 9m0 0H9m11 11v-5h-.6a8 8 0 01-15.3-2" />
                      </svg>
                    )}
                    {checkingLabel === s.label ? "Checking…" : "Re-check metadata"}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSource(s.label)}
                    disabled={busy || checkingLabel !== null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18m-2 0l-1 14H6L5 6m3 0V4h8v2m-6 4v6m4-6v6" />
                    </svg>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {error && !open && <div className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</div>}
      {requiredGrants.length > 0 && !open && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded border border-red-200 bg-red-50 p-2 font-mono text-[10px] leading-4 text-red-800">
          {requiredGrants.join("\n")}
        </pre>
      )}

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor="mv-source-catalog" className="block text-[11px] font-medium text-gray-700">Catalog</label>
              <select id="mv-source-catalog" value={catalog} onChange={(e) => setCatalog(e.target.value)} className={selectClass}>
                <option value="">Select…</option>
                {catalogs.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="mv-source-schema" className="block text-[11px] font-medium text-gray-700">Schema</label>
              <select id="mv-source-schema" value={schema} onChange={(e) => setSchema(e.target.value)} disabled={!catalog} className={selectClass}>
                <option value="">Select…</option>
                {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {catalog && schema && (
            <div className="space-y-1.5">
              {previewing ? (
                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                  <Spinner size="xs" />
                  <span>Reading views in this schema…</span>
                </div>
              ) : preview ? (
                presentTables.length === 0 ? (
                  <span className="text-[11px] text-red-600">
                    No summary views found at this location: check that the shared schema holds this app's views.
                  </span>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <label className="block text-[11px] font-medium text-gray-700">
                        Views to include ({selected.size} of {matchableCount})
                      </label>
                      {matchableCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSelected(
                              selected.size === matchableCount
                                ? new Set()
                                : new Set(presentTables.filter((t) => t.status === "match").map((t) => t.table))
                            )
                          }
                          className="text-[10px] font-medium text-[#2272B4] hover:underline"
                        >
                          {selected.size === matchableCount ? "Clear all" : "Select all"}
                        </button>
                      )}
                    </div>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-1.5">
                      {presentTables.map((t) => {
                        const isMatch = t.status === "match";
                        return (
                          <label
                            key={t.table}
                            className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${isMatch ? "cursor-pointer hover:bg-gray-50" : "cursor-not-allowed opacity-60"}`}
                          >
                            <input
                              type="checkbox"
                              disabled={!isMatch}
                              checked={selected.has(t.table)}
                              onChange={() => toggle(t.table)}
                              className="h-3.5 w-3.5 rounded border-gray-300 text-[#2272B4] focus:ring-[#2272B4]"
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-gray-700">{t.table}</span>
                            {isMatch ? (
                              <span className="shrink-0 rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700">matches</span>
                            ) : t.status === "unreadable" ? (
                              <span className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">access required</span>
                            ) : (
                              <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500" title="Column structure differs from this app's view: cannot be unioned.">structure differs</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                    {preview.required_grants && preview.required_grants.length > 0 && (
                      <div className="rounded-md border border-red-200 bg-red-50 p-2">
                        <p className="text-[11px] font-semibold text-red-800">
                          These tables exist, but the app service principal needs schema access.
                        </p>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-red-800">
                          {preview.required_grants.join("\n")}
                        </pre>
                      </div>
                    )}
                  </>
                )
              ) : null}
            </div>
          )}

          {preview && !previewing && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium text-gray-700">
                Workspaces discovered in the share ({selectedWorkspaceIds.size})
              </label>
              {(preview.workspace_candidates?.length ?? 0) > 0 ? (
                <>
                  <p className="text-[10px] text-gray-500">
                    Pulled automatically from the shared workspace breakdown and kept in sync by the app.
                  </p>
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-1.5">
                    {preview.workspace_candidates!.map((workspace) => (
                      <div
                        key={workspace.workspace_id}
                        className="flex items-center gap-2 rounded px-1.5 py-1 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate text-gray-700">
                          {workspace.workspace_name || "Unnamed workspace"}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-gray-500">
                          {workspace.workspace_id}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  No workspace mappings could be read from the shared workspace breakdown. Check the schema grant, then browse again.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="mv-source-label" className="block text-[11px] font-medium text-gray-700">Label</label>
            {existingLabels.length > 0 && (
              <select
                aria-label="Existing label"
                value={existingLabels.includes(label) ? label : ""}
                onChange={(event) => setLabel(event.target.value)}
                className={selectClass}
              >
                <option value="">Select an existing label…</option>
                {existingLabels.map((existingLabel) => (
                  <option key={existingLabel} value={existingLabel}>{existingLabel}</option>
                ))}
              </select>
            )}
            <input
              id="mv-source-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. EU workspace"
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-[#2272B4] focus:outline-none focus:ring-1 focus:ring-[#2272B4]"
            />
            <p className="text-[10px] text-gray-500">Used to tag this source's rows so you can filter by it in the dashboard.</p>
          </div>

          {error && <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-0.5">
            <button onClick={() => { setOpen(false); resetForm(); }} className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
              Cancel
            </button>
            <button
              onClick={addSource}
              disabled={!canAdd}
              className="rounded-md px-3 py-1.5 text-xs font-bold text-white transition-colors disabled:cursor-not-allowed"
              style={{ backgroundColor: canAdd ? "#2272B4" : "#A9C6DC" }}
            >
              {busy ? "Adding…" : "Add source"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
