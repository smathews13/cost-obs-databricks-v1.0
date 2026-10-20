import { useState } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import {
  WAREHOUSE_GUIDANCE_VERSION,
  classifyWarehouseSize,
  warehouseManagementHref,
  warehouseWarningDismissalKey,
  type WarehouseHealth,
} from "@/utils/warehouseGuidance";

interface WarehouseGuidanceBannerProps {
  warehouse: WarehouseHealth;
  workspaceHost: string | null | undefined;
  warningVersion?: string;
}

interface WarehouseHealthCheckBannerProps {
  isRetrying: boolean;
  onRetry: () => void;
}

export function WarehouseHealthCheckBanner({
  isRetrying,
  onRetry,
}: WarehouseHealthCheckBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900"
    >
      <span className="text-xs font-medium">
        Warehouse status could not be verified. The app will keep loading data normally.
      </span>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-amber-300 px-2 py-1 text-xs font-semibold hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"
      >
        <RefreshCw size={12} className={isRetrying ? "animate-spin" : ""} aria-hidden="true" />
        {isRetrying ? "Checking…" : "Retry status check"}
      </button>
    </div>
  );
}

export function WarehouseGuidanceBanner({
  warehouse,
  workspaceHost,
  warningVersion = WAREHOUSE_GUIDANCE_VERSION,
}: WarehouseGuidanceBannerProps) {
  const warehouseId = warehouse.warehouse_id?.trim() ?? "";
  const dismissalKey = warehouseId
    ? warehouseWarningDismissalKey(warehouseId, warningVersion)
    : "";
  const [dismissed, setDismissed] = useState(
    () => Boolean(dismissalKey && localStorage.getItem(dismissalKey) === "1"),
  );

  if (
    dismissed
    || !warehouseId
    || classifyWarehouseSize(warehouse.warehouse_size) !== "below-medium"
  ) {
    return null;
  }

  const manageHref = warehouseManagementHref(workspaceHost, warehouseId);
  const warehouseName = warehouse.warehouse_name?.trim();
  const typeLabel = warehouse.warehouse_type?.trim().toLowerCase();
  const warehouseLabel = warehouseName
    ? `${warehouseName} · ${warehouseId}`
    : warehouseId;

  const dismiss = () => {
    localStorage.setItem(dismissalKey, "1");
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      className="warehouse-guidance-banner mx-2 my-2 flex w-[calc(100%-16px)] flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[10px] border border-[#F2A895] bg-[#FFF0EB] px-4 py-2.5 text-[#6F2A20] shadow-[0_1px_2px_rgba(116,42,30,.08)]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border border-[#ED9B87] bg-[#FFDCD2] text-[#C63E2B]">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[.08em] text-[#A33A2A]">
              Warehouse sizing recommendation
            </span>
            <span
              className="hidden min-w-0 max-w-[36rem] shrink items-center rounded-[5px] border border-[#EAA18E] bg-[#FFE1D8] px-2 py-0.5 font-mono text-[10px] font-medium text-[#8F3426] min-[1100px]:inline-flex"
              title={`${warehouseLabel} · ${warehouse.warehouse_size}${typeLabel ? ` · ${typeLabel}` : ""}`}
            >
              <span className="truncate">{warehouseLabel}</span>
              <span className="whitespace-nowrap">
                {" · "}{warehouse.warehouse_size}{typeLabel ? ` · ${typeLabel}` : ""}
              </span>
            </span>
          </div>
          <span className="mt-0.5 block text-xs font-medium text-[#6F2A20]">
            The recommended warehouse size is Medium, otherwise query latency may be volatile.
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {manageHref && (
          <a
            href={manageHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-[#D96751] bg-[#C94632] px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#A93626] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C94632]/35 focus-visible:ring-offset-1 focus-visible:ring-offset-[#FFF0EB]"
          >
            Manage warehouse
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss warehouse size recommendation"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[7px] text-[#A33A2A] transition-colors hover:bg-[#FFDCD2] hover:text-[#742A1E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C94632]/35"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
