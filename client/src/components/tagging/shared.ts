// Shared constants and utility functions for tagging sub-components

export type UntaggedTab = "clusters" | "jobs" | "pipelines" | "warehouses" | "endpoints";

export const COLORS = {
  tagged: "#10b981",
  untagged: "#ef4444",
};

export const TAG_COLORS = [
  "#1B5162",
  "#06B6D4",
  "#10B981",
  "#14B8A6",
  "#F59E0B",
  "#3B82F6",
  "#EC4899",
  "#EF4444",
  "#6B7280",
];

export const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

export const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
