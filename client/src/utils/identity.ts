/**
 * Utilities for displaying Databricks identities (users vs service principals).
 *
 * Service principals appear as bare UUIDs in billing data (identity_metadata.run_as).
 * Pattern: 8-4-4-4-8..12 hex chars.
 */

import { createContext, useContext } from "react";

export const SP_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,12}$/i;

// React context for the service-principal display-name map (application_id -> display_name).
// App.tsx provides the value fetched from /api/user/service-principals so consumers
// don't need to drill the map through props.
export const SpNameMapContext = createContext<Record<string, string>>({});
export const useSpNameMap = () => useContext(SpNameMapContext);

export function isServicePrincipal(id: string): boolean {
  return SP_REGEX.test((id ?? "").trim());
}

/**
 * Short display label for any identity:
 *  - Service principal UUID → resolved SCIM display_name, else "SP-xxxxx"
 *  - Email address          → "alice"    (username before @)
 *  - Other                  → value as-is
 *
 * Pass an optional `spNameMap` (application_id -> display_name) sourced from
 * /api/user/service-principals to get real SP names instead of the hex hash.
 */
export function formatIdentity(id: string, spNameMap?: Record<string, string>): string {
  if (!id) return id;
  const v = id.trim();
  if (isServicePrincipal(v)) {
    // Lookup case-insensitively — backend normalizes keys to lowercase but
    // billing identity_metadata.run_as can arrive with mixed casing.
    const resolved = spNameMap?.[v.toLowerCase()] ?? spNameMap?.[v];
    if (resolved) return resolved;
    return `SP-${v.replace(/-/g, "").slice(0, 5)}`;
  }
  if (v.includes("@")) {
    return v.split("@")[0];
  }
  return v;
}

/**
 * Full tooltip label — shows the raw ID for copy-pasting.
 */
export function identityTitle(id: string): string {
  return id ?? "";
}

/**
 * Returns a stable anon label for a user email given its sort index.
 * Service principals are always returned as-is.
 * @param id    - raw identity string (email or SP UUID)
 * @param index - 0-based rank in the sorted user list
 * @param enabled - whether anonymization is active
 */
export function anonymizeIdentity(id: string, index: number, enabled: boolean): string {
  if (!enabled || isServicePrincipal(id)) return formatIdentity(id);
  return `User ${index + 1}`;
}

