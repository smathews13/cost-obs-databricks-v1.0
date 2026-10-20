import type { ReactNode } from "react";
import { LoadingPanels } from "./Spinner";
import { TabRefreshButton } from "./TabRefreshButton";

interface TabRefreshRegionProps {
  isLoading: boolean;
  isRefreshing: boolean;
  loadingSections: string[];
  onRefresh: () => Promise<void>;
  onDismissRefreshError: () => void;
  refreshError?: string | null;
  children: ReactNode;
}

export function TabRefreshRegion({
  isLoading,
  isRefreshing,
  loadingSections,
  onRefresh,
  onDismissRefreshError,
  refreshError,
  children,
}: TabRefreshRegionProps) {
  return (
    <div className="relative">
      <div className="absolute right-0 top-0 z-20">
        <TabRefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
      </div>
      {refreshError && (
        <div role="alert" className="mb-4 mr-11 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{refreshError}</span>
          <span className="flex shrink-0 items-center gap-3">
            <button type="button" onClick={() => void onRefresh()} disabled={isRefreshing} className="font-semibold underline disabled:opacity-50">
              Retry
            </button>
            <button
              type="button"
              onClick={onDismissRefreshError}
              aria-label="Dismiss refresh error"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-lg leading-none hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            >
              ×
            </button>
          </span>
        </div>
      )}
      <div className={isLoading ? "pr-14 pt-[54px]" : "pr-14"}>
        {isLoading ? <LoadingPanels sections={loadingSections} /> : children}
      </div>
    </div>
  );
}
