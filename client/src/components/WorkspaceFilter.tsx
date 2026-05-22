import { useState, useRef, useEffect } from "react";

interface Workspace {
  workspace_id: string | null;
  workspace_name?: string | null;
}

interface WorkspaceFilterProps {
  workspaces: Workspace[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function WorkspaceFilter({ workspaces, selectedIds, onChange }: WorkspaceFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const validWorkspaces = workspaces.filter((ws) => ws.workspace_id != null);
  if (validWorkspaces.length <= 1) return null;

  const allSelected = selectedIds.length === 0;

  function toggle(id: string | null) {
    if (!id) return;
    if (allSelected) {
      // All checked — unchecking one means select everything except this one
      onChange(validWorkspaces.map((w) => w.workspace_id!).filter((x) => x !== id));
      return;
    }
    if (selectedIds.includes(id)) {
      const next = selectedIds.filter((x) => x !== id);
      // If removing the last one, revert to "all"
      onChange(next.length === 0 ? [] : next);
    } else {
      const next = [...selectedIds, id];
      // If all are now checked, normalise back to the "all" empty-array representation
      onChange(next.length === validWorkspaces.length ? [] : next);
    }
  }

  function label() {
    if (allSelected) return "All Workspaces";
    if (selectedIds.length === 1) {
      const ws = validWorkspaces.find((w) => w.workspace_id === selectedIds[0]);
      return ws?.workspace_name || selectedIds[0];
    }
    return `${selectedIds.length} Workspaces`;
  }

  return (
    <div className="relative">
      {isOpen && (
        <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
      )}

      <button
        onClick={() => setIsOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
      >
        <svg className="h-4 w-4 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
        <span className="max-w-[140px] truncate">{label()}</span>
        {!allSelected && (
          <button
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-500 hover:bg-gray-300"
            title="Clear filter"
          >
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        <svg
          className={`ml-0.5 h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute left-0 z-20 mt-2 min-w-[220px] rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Workspaces</span>
            <div className="flex gap-2">
              <button
                onClick={() => onChange([])}
                className="text-xs text-gray-500 hover:text-gray-800"
              >
                All
              </button>
              <span className="text-gray-300">·</span>
              <button
                onClick={() => onChange([])}
                className="text-xs text-gray-500 hover:text-gray-800"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="mb-2">
            <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search workspaces…"
                className="w-full bg-transparent text-xs text-gray-700 placeholder-gray-400 outline-none"
              />
              {search && (
                <button onClick={() => setSearch("")} className="shrink-0 text-gray-400 hover:text-gray-600">
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {(() => {
              const filtered = validWorkspaces.filter((ws) => {
                if (!search) return true;
                const q = search.toLowerCase();
                return (ws.workspace_name || ws.workspace_id || "").toLowerCase().includes(q);
              });
              if (filtered.length === 0) {
                return (
                  <p className="px-2 py-3 text-center text-xs text-gray-500">No workspaces match</p>
                );
              }
              return filtered.map((ws) => {
                const id = ws.workspace_id!;
                const checked = selectedIds.includes(id);
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(id)}
                      className="h-3.5 w-3.5 rounded border-gray-300 accent-[#FF3621]"
                    />
                    <span className="flex-1 truncate text-sm text-gray-700">
                      {ws.workspace_name || id}
                    </span>
                  </label>
                );
              });
            })()}
          </div>
          {!allSelected && (
            <div className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-400">
              {selectedIds.length} of {validWorkspaces.length} selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
