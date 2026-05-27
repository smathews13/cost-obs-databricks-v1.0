// Shared constants and helpers for per-cloud actual-cost tab components.
// These were extracted from CloudCostsView.tsx and must not be duplicated.

import { format, parseISO } from "date-fns";
import { workspaceUrl } from "@/utils/formatters";

// ---------------------------------------------------------------------------
// Colour palettes
// ---------------------------------------------------------------------------

// Base color palette for instance family charts (cycled by index)
export const FAMILY_PALETTE = [
  "#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B",
  "#3B82F6", "#EC4899", "#EF4444", "#6B7280",
];

// Known instance family -> color overrides for consistency
export const INSTANCE_COLORS: Record<string, string> = {
  // AWS EC2 instance families (using canonical Databricks palette)
  i3: "#1B5162", i3en: "#2D7A96", i4i: "#4A99B8",
  m4: "#10B981", m5: "#10B981", m5d: "#34D399", m5n: "#6EE7B7",
  m6i: "#6EE7B7", m6id: "#A7F3D0", m7g: "#059669", m7gd: "#047857", m7i: "#34D399",
  r5: "#F59E0B", r5d: "#FBBF24", r6id: "#FDE68A", r6gd: "#FCD34D", r8gd: "#D97706",
  c5: "#3B82F6", c5d: "#60A5FA", c6gd: "#1D4ED8",
  g4dn: "#EC4899", g5: "#F472B6",
  p3: "#EF4444",
  // Fleet types
  "rd-fleet": "#06B6D4", "rgd-fleet": "#0891B2",
  // Azure VM series
  Standard_D: "#1B5162", Standard_DS: "#2D7A96",
  Standard_E: "#10B981", Standard_ES: "#34D399",
  Standard_F: "#3B82F6", Standard_FS: "#60A5FA",
  Standard_L: "#F59E0B", Standard_LS: "#FBBF24",
  Standard_M: "#EF4444",
  Standard_NC: "#EC4899", Standard_ND: "#F472B6", Standard_NV: "#14B8A6",
  unknown: "#6B7280",
};

export function getInstanceColor(name: string, index: number): string {
  return INSTANCE_COLORS[name] || FAMILY_PALETTE[index % FAMILY_PALETTE.length];
}

export const CHARGE_TYPE_COLORS: Record<string, string> = {
  Compute: "#1B5162",
  Storage: "#06B6D4",
  Networking: "#10B981",
  Other: "#6B7280",
};

// GCP brand colors (used only by GcpActualTab, but defined here for consistency)
export const GCP_COLORS = [
  "#4285F4", "#34A853", "#FBBC05", "#EA4335",
  "#8AB4F8", "#81C995", "#FDD663", "#F28B82",
  "#A8C7FA", "#CCFF90",
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function getClusterUrl(
  host: string | null | undefined,
  clusterId: string | null,
  workspaceId: string | null,
): string | null {
  if (!host || !clusterId) return null;
  const workspaceParam = workspaceId ? `?o=${workspaceId}` : "";
  return workspaceUrl(host, `/compute/interactive${workspaceParam}`);
}

export function getInstancePricingUrl(instanceType: string | null, isAzure = false): string {
  if (isAzure) {
    if (!instanceType) {
      return "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/";
    }
    const seriesMatch = instanceType.match(/^Standard_([A-Z]+)/i);
    const series = seriesMatch ? seriesMatch[1].toUpperCase() : null;
    const azureFamilyUrls: Record<string, string> = {
      D: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#d-series",
      E: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#e-series",
      F: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#f-series",
      L: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#l-series",
      M: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#m-series",
      NC: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#nc-series",
      ND: "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#nd-series",
    };
    return series && azureFamilyUrls[series]
      ? azureFamilyUrls[series]
      : "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/";
  }

  // AWS EC2 pricing
  if (!instanceType) {
    return "https://aws.amazon.com/ec2/pricing/on-demand/";
  }
  const family = instanceType.split(".")[0];
  const familyUrls: Record<string, string> = {
    i3: "https://aws.amazon.com/ec2/instance-types/i3/",
    i3en: "https://aws.amazon.com/ec2/instance-types/i3en/",
    m5: "https://aws.amazon.com/ec2/instance-types/m5/",
    m5d: "https://aws.amazon.com/ec2/instance-types/m5/",
    m6i: "https://aws.amazon.com/ec2/instance-types/m6i/",
    r5: "https://aws.amazon.com/ec2/instance-types/r5/",
    r5d: "https://aws.amazon.com/ec2/instance-types/r5/",
    c5: "https://aws.amazon.com/ec2/instance-types/c5/",
    c5d: "https://aws.amazon.com/ec2/instance-types/c5/",
    g4dn: "https://aws.amazon.com/ec2/instance-types/g4/",
    g5: "https://aws.amazon.com/ec2/instance-types/g5/",
    p3: "https://aws.amazon.com/ec2/instance-types/p3/",
  };
  return familyUrls[family] || "https://aws.amazon.com/ec2/pricing/on-demand/";
}
