import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getActiveSourceLabels,
  getActiveSourceRouting,
  setActiveSourceLabels,
  setActiveSourceRouting,
  setActiveSourceTables,
} from "@/hooks/useBillingData";
import { C } from "@/theme";
import { Spinner } from "@/components/Spinner";
import { FloatingMenu } from "@/components/ui/FloatingMenu";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure-128.png";
import gcpLogo from "@/assets/gcp.svg";
import { resolveSourceCloud } from "@/utils/sourceCloud";

interface MvSource {
  label: string;
  catalog: string;
  schema: string;
  tables?: string[];
  workspace_ids?: string[];
  cloud?: string;
}

const CLOUD_LOGOS = {
  aws: awsLogo,
  azure: azureLogo,
  gcp: gcpLogo,
} as const;

interface SourceLabelFilterProps {
  variant?: "header" | "rail";
  localWorkspaces?: Array<{ id: string; name?: string | null }>;
  workspaceSelection?: string[];
  onApplied?: (
    sourceWorkspaceIds: string[] | null,
    origin?: "source" | "sync" | "rollback",
  ) => void | Promise<void>;
  resetVersion?: number;
  disabled?: boolean;
  isRefreshing?: boolean;
  controlling?: boolean;
}

function normalizedWorkspaceToken(value: unknown): string {
  return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function resolveSameAccountWorkspaceIds(
  labels: string[],
  sources: MvSource[],
  localWorkspaces: Array<{ id: string; name?: string | null }>,
  localLabel?: string,
): string[] | null {
  const routableLabels = labels.filter((label) => label !== localLabel);
  if (routableLabels.length === 0) return null;
  const localWorkspaceIds = new Set(
    localWorkspaces.map((workspace) => String(workspace.id)),
  );
  const groups = routableLabels.map((label) => {
    const source = sources.find((candidate) => candidate.label === label);
    if (!source) return [];
    const normalizedLabel = normalizedWorkspaceToken(label);
    const labelToken = String(label).trim().toLowerCase();
    const labelMatches = localWorkspaces.filter((workspace) => (
      normalizedLabel
      && (
        normalizedWorkspaceToken(workspace.id) === normalizedLabel
        || String(workspace.name ?? "")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
          .includes(labelToken)
      )
    ));
    if (labelMatches.length > 0) {
      return labelMatches.map((workspace) => String(workspace.id));
    }
    const persistedIds = (source.workspace_ids ?? []).map(String);
    if (
      persistedIds.length > 0
      && persistedIds.every((id) => localWorkspaceIds.has(id))
    ) {
      return persistedIds;
    }
    return [];
  });
  return groups.every((ids) => ids.length > 0)
    ? Array.from(new Set(groups.flat())).sort()
    : null;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

function reconcileSourceSelection(
  previousLabels: string[],
  nextLabels: string[],
  selected: Set<string>,
  wasGloballyAll = false,
): Set<string> {
  const previous = new Set(previousLabels);
  const next = new Set(nextLabels);
  const wasAll = previous.size > 0 && sameSet(previous, selected);
  if ((wasAll && wasGloballyAll) || (previous.size === 0 && selected.size === 0)) return next;

  const intersection = new Set(Array.from(selected).filter((label) => next.has(label)));
  // The UI does not permit an empty selection. If every selected source was
  // removed, fall back to the remaining complete set (the API's "all" scope).
  return intersection.size > 0 ? intersection : next;
}

// Top-nav multi-select for filtering dashboard data by MV source label. Only
// rendered when additional MV sources are configured (otherwise there's a single
// local label and nothing to filter). Default is all sources (combined); the
// selection is pushed to the data layer and queries are invalidated to refetch.
export function SourceLabelFilter({
  variant = "header",
  localWorkspaces = [],
  workspaceSelection = [],
  onApplied,
  resetVersion = 0,
  disabled = false,
  isRefreshing = false,
  controlling = false,
}: SourceLabelFilterProps) {
  const { data } = useQuery<{
    sources: MvSource[];
    local_label: string;
    local_cloud?: string;
  }>({
    queryKey: ["mv-sources"],
    queryFn: () => fetch("/api/settings/mv-sources").then((r) => r.json()).catch(() => ({ sources: [], local_label: "" })),
    staleTime: 60 * 1000,
  });

  const globalLabels = useMemo(() => {
    const local = data?.local_label ? [data.local_label] : [];
    const extra = (data?.sources ?? []).map((source) => source.label);
    return Array.from(new Set([...local, ...extra])).filter(Boolean);
  }, [data]);

  const allLabels = useMemo(() => {
    if (controlling || workspaceSelection.length === 0) return globalLabels;
    const selectedWorkspaceSet = new Set(workspaceSelection.map(String));
    const linkedSources = (data?.sources ?? []).flatMap((source) => {
      const workspaceIds = resolveSameAccountWorkspaceIds(
        [source.label],
        [source],
        localWorkspaces,
      );
      return workspaceIds?.some((id) => selectedWorkspaceSet.has(id))
        ? [{ label: source.label, workspaceIds }]
        : [];
    });
    const coveredWorkspaceIds = new Set(
      linkedSources.flatMap((source) => source.workspaceIds),
    );
    if (linkedSources.length === 0) {
      return data?.local_label ? [data.local_label] : globalLabels;
    }
    const allSelectedWorkspacesCovered = workspaceSelection.every(
      (id) => coveredWorkspaceIds.has(String(id)),
    );
    return Array.from(new Set([
      ...(!allSelectedWorkspacesCovered && data?.local_label ? [data.local_label] : []),
      ...linkedSources.map((source) => source.label),
    ]));
  }, [controlling, data?.local_label, data?.sources, globalLabels, localWorkspaces, workspaceSelection]);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(getActiveSourceLabels()),
  );
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [retrySelection, setRetrySelection] = useState<Set<string> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastAppliedRef = useRef<string>(
    getActiveSourceLabels().sort().join("\u0001"),
  );
  const previousLabelsRef = useRef<string[]>([]);
  const selectedRef = useRef(selected);

  const hasSources = (data?.sources?.length ?? 0) > 0;
  const updating = applying || isRefreshing;

  useEffect(() => {
    if (resetVersion === 0) return;
    const next = new Set(globalLabels);
    selectedRef.current = next;
    previousLabelsRef.current = globalLabels;
    lastAppliedRef.current = "";
    setSelected(next);
    setRetrySelection(null);
    setErr(null);
  }, [globalLabels, resetVersion]);

  const apply = useCallback(async (next: Set<string>, syncWorkspace = true) => {
    // At least one source is always selected (the toggle enforces it); a full
    // selection means "all" (empty filter = every source).
    const effective = next.size === 0 || (
      (controlling || workspaceSelection.length === 0)
      && sameSet(next, new Set(globalLabels))
    )
      ? []
      : Array.from(next).sort();
    // Skip the refetch when the effective selection hasn't changed (e.g. closing
    // the dropdown without edits).
    const key = [...effective].sort().join("");
    if (key === lastAppliedRef.current && !err) return;
    const previousEffective = getActiveSourceLabels();
    const previousRouting = getActiveSourceRouting();
    const previousVisible = previousEffective.length
      ? new Set(previousEffective)
      : new Set(allLabels);
    // The shared module scope must change before the App invalidates/refetches.
    // Query functions read this value when they build their scoped API URL.
    setActiveSourceLabels(effective);
    const selectedSources = effective.map((label) =>
      data?.sources?.find((source) => source.label === label)
    );
    const sourceWorkspaceIds = resolveSameAccountWorkspaceIds(
      effective,
      data?.sources ?? [],
      localWorkspaces,
      data?.local_label,
    );
    const includesLocalSource = Boolean(
      data?.local_label && effective.includes(data.local_label),
    );
    const sourceTables = selectedSources.flatMap((source) => source?.tables ?? []);
    const sourcePublishesAll = effective.includes(data?.local_label ?? "")
      || selectedSources.some((source) => source?.tables == null);
    const useWorkspaceRouting = !includesLocalSource && sourceWorkspaceIds !== null;
    setActiveSourceRouting(
      (useWorkspaceRouting || includesLocalSource) && data?.local_label
        ? [data.local_label]
        : effective,
      useWorkspaceRouting ? sourceWorkspaceIds ?? [] : [],
    );
    setActiveSourceTables(
      effective.length > 0 && !sourcePublishesAll ? sourceTables : null,
    );
    setApplying(true);
    setErr(null);
    try {
      const linkedWorkspaceScope = syncWorkspace
        ? effective.length === 0
          ? []
          : useWorkspaceRouting
            ? sourceWorkspaceIds
            : null
        : null;
      await onApplied?.(linkedWorkspaceScope, syncWorkspace ? "source" : "sync");
      lastAppliedRef.current = key;
      selectedRef.current = new Set(next);
      setSelected(new Set(next));
      setRetrySelection(null);
    } catch {
      // The attempted request used `effective`. Restore both the module scope and
      // visible selection, then refetch the prior scope so stale data is never
      // presented as if the new filter succeeded.
      setActiveSourceLabels(previousEffective);
      setActiveSourceRouting(
        previousRouting.requestLabels,
        previousRouting.workspaceIds,
      );
      setActiveSourceTables(previousRouting.tables);
      selectedRef.current = previousVisible;
      setSelected(previousVisible);
      setRetrySelection(new Set(next));
      setErr("Source filter was not applied because the refresh failed.");
      try {
        await onApplied?.(null, "rollback");
      } catch {
        // Keep the original error visible; the Retry action remains available.
      }
    } finally {
      setApplying(false);
    }
  }, [allLabels, controlling, data?.local_label, data?.sources, err, globalLabels, localWorkspaces, onApplied, workspaceSelection.length]);

  // Source options can arrive before the account workspace list. If an already
  // applied source becomes resolvable after workspace metadata hydrates, switch
  // it from publisher routing to the matching local workspace and refetch.
  useEffect(() => {
    const activeLabels = getActiveSourceLabels();
    if (data?.local_label && activeLabels.includes(data.local_label)) return;
    const workspaceIds = resolveSameAccountWorkspaceIds(
      activeLabels,
      data?.sources ?? [],
      localWorkspaces,
      data?.local_label,
    );
    if (!workspaceIds || !data?.local_label) return;
    const current = getActiveSourceRouting();
    if (
      current.requestLabels.length === 1
      && current.requestLabels[0] === data.local_label
      && sameSet(new Set(current.workspaceIds), new Set(workspaceIds))
    ) return;
    setActiveSourceRouting([data.local_label], workspaceIds);
    void Promise.resolve(onApplied?.(workspaceIds, "sync")).catch(() => {
      setActiveSourceRouting(current.requestLabels, current.workspaceIds);
      setErr("Source workspace routing could not be refreshed. Retry the source filter.");
    });
  }, [data?.local_label, data?.sources, localWorkspaces, onApplied]);

  // Keep the visible selection and the module-level applied scope synchronized
  // when shared sources are added or removed while the dashboard is open.
  useEffect(() => {
    const next = reconcileSourceSelection(
      previousLabelsRef.current,
      allLabels,
      selectedRef.current,
      getActiveSourceLabels().length === 0,
    );
    previousLabelsRef.current = allLabels;
    if (sameSet(next, selectedRef.current)) return;
    selectedRef.current = next;
    setSelected(next);
    void apply(next, false);
  }, [allLabels, apply]);

  if (!hasSources || allLabels.length === 0) return null;

  const allSelected = sameSet(selected, new Set(allLabels));

  const toggle = (label: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        // At least one source must always stay selected: refuse to clear the last one.
        if (next.size <= 1) return prev;
        next.delete(label);
      } else {
        next.add(label);
      }
      selectedRef.current = next;
      return next;
    });
  };

  const label = () => {
    if (allLabels.length === 1) return allLabels[0];
    if (allSelected) return `${allLabels.length} ${allLabels.length === 1 ? "Source" : "Sources"}`;
    if (selected.size === 1) return Array.from(selected)[0];
    return `${selected.size} sources`;
  };

  return (
    <div className={variant === "rail" ? "relative min-w-0 shrink" : "relative"}>
      {open && <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); apply(selected); }} />}
      <button
        ref={triggerRef}
        disabled={disabled || isRefreshing}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        aria-label={updating ? "Updating sources" : label()}
        className={variant === "rail"
          ? `rail-source-filter rail-control-border flex h-[28px] w-[116px] items-center gap-[6px] whitespace-nowrap rounded-[7px] border bg-white/[.07] px-[8px] text-[11.5px] font-medium text-[#E9EFED] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3621]/35 focus-visible:ring-offset-1 focus-visible:ring-offset-[#1B3139] min-[1280px]:w-[190px] min-[1280px]:gap-[8px] min-[1280px]:px-[10px] ${disabled && !isRefreshing ? "cursor-not-allowed opacity-55" : "hover:bg-white/[.12]"}`
          : "co-filter flex items-center gap-2 whitespace-nowrap px-3"
        }
        title={disabled
          ? "Controlled by the workspace filter. Clear both filters to edit sources."
          : "Filter by data source"}
      >
        {updating ? (
          <Spinner size="sm" />
        ) : (
          <svg className={variant === "rail" ? "h-[14px] w-[14px] shrink-0 opacity-70" : "h-4 w-4 shrink-0 text-gray-500"} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M6 12h12M9 17h6" />
          </svg>
        )}
        <span className="max-w-[68px] truncate min-[1280px]:max-w-[140px]">
          {updating ? "Updating…" : (
            <>
              <span className="min-[1180px]:hidden">
                {allLabels.length === 1
                  ? allLabels[0]
                  : allSelected
                  ? `${allLabels.length} ${allLabels.length === 1 ? "source" : "sources"}`
                  : selected.size === 1 ? "1 source" : `${selected.size} sources`}
              </span>
              <span className="hidden min-[1180px]:inline">{label()}</span>
            </>
          )}
        </span>
        <svg className={`${variant === "rail" ? "h-[12px] w-[12px] opacity-70" : "h-4 w-4 text-gray-500"} ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {err && !open && (
        <div role="alert" className="absolute right-0 top-full z-30 mt-2 flex w-72 items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg">
          <span>{err}</span>
          <button type="button" disabled={applying || !retrySelection} onClick={() => retrySelection && void apply(retrySelection)} className="shrink-0 font-semibold underline disabled:opacity-50">
            Retry
          </button>
        </div>
      )}

      {open && (
        <FloatingMenu anchorRef={triggerRef} gap={8} className="co-filter-menu min-w-[220px] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Data source</span>
            {/* No "Clear": at least one source must stay selected. "All" selects every source. */}
            <button onClick={() => {
              const next = new Set(allLabels);
              selectedRef.current = next;
              setSelected(next);
            }} className="text-xs text-gray-500 hover:text-gray-800">All</button>
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {allLabels.map((lbl) => {
              const checked = selected.has(lbl);
              const isLocal = lbl === data?.local_label;
              const source = data?.sources?.find((item) => item.label === lbl);
              const sourceCloud = resolveSourceCloud(
                isLocal ? data?.local_cloud : source?.cloud,
                lbl,
                source?.catalog,
              );
              const summaryOnly = !isLocal
                && source?.tables?.length === 1
                && source.tables[0] === "daily_usage_summary";
              return (
                <label key={lbl} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${checked ? "bg-orange-50 hover:bg-orange-100" : "hover:bg-gray-50"}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(lbl)} className="h-3.5 w-3.5 rounded border-gray-300 accent-lava" />
                  {sourceCloud && (
                    <img
                      src={CLOUD_LOGOS[sourceCloud]}
                      alt=""
                      aria-hidden="true"
                      title={sourceCloud === "gcp" ? "Google Cloud" : sourceCloud === "azure" ? "Azure" : "AWS"}
                      className="h-4 w-4 shrink-0 object-contain"
                    />
                  )}
                  <span className="flex-1 truncate text-sm text-gray-700">{lbl}</span>
                  {isLocal && <span className="shrink-0 rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">this account</span>}
                  {summaryOnly && <span className="shrink-0 rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">summary only</span>}
                </label>
              );
            })}
          </div>
          {err && (
            <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              <span>{err}</span>
              <button type="button" disabled={applying || !retrySelection} onClick={() => retrySelection && void apply(retrySelection)} className="font-semibold underline disabled:opacity-50">
                Retry
              </button>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2">
            <span className="text-[11px] text-gray-500">{allSelected ? `All ${allLabels.length}` : `${selected.size} of ${allLabels.length}`} selected</span>
            <button
              onClick={() => { apply(selected); setOpen(false); }}
              disabled={applying}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed"
              style={{ backgroundColor: applying ? C.busy : C.lava }}
            >
              {applying && <Spinner size="xs" />}
              {applying ? "Applying…" : "Apply"}
            </button>
          </div>
        </FloatingMenu>
      )}
    </div>
  );
}
