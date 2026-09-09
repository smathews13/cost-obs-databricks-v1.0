import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/Spinner";
import { Group, LinkButton, MonoChip, Row, SectionTitle, T } from "./dubois";
import type { ResourceInventoryGroup, SettingsResourcesPayload } from "./resourceTypes";

const externalIcon = (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

function safeExternalUrl(value: string, identity = false): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (identity && !url.pathname.includes("/ServicePrincipals/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "Unavailable";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? value
    : timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function summarize(items: string[], limit = 5): string {
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  return `${visible.join(" | ")}${remaining > 0 ? ` | +${remaining} more` : ""}`;
}

function deploymentSourceLabel(source: string): string | null {
  if (source === "unavailable") return null;
  if (source.includes("process_start")) {
    return "process start (approximate; may reflect a restart, not deployment)";
  }
  return source.replaceAll("_", " ");
}

function InventoryList({
  inventory,
  inactiveNames = [],
}: {
  inventory: ResourceInventoryGroup;
  inactiveNames?: string[];
}) {
  const inactive = new Set(inactiveNames);
  return (
    <div className="flex max-w-110 flex-wrap justify-end gap-1.5">
      {inventory.names.map((name) => (
        <span
          key={name}
          data-inactive={inactive.has(name) ? "true" : undefined}
          title={inactive.has(name) ? "Created when shared-source routing is active" : undefined}
          className={inactive.has(name) ? "opacity-45 grayscale" : undefined}
        >
          <MonoChip>{name}</MonoChip>
        </span>
      ))}
    </div>
  );
}

export function SettingsResources() {
  const { data, isLoading, isError, refetch } = useQuery<SettingsResourcesPayload>({
    queryKey: ["settings-resources"],
    queryFn: async () => {
      const response = await fetch("/api/settings/resources");
      if (!response.ok) throw new Error(`Resources request failed (${response.status})`);
      return response.json();
    },
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div>
        <SectionTitle title="Resources" subtitle="Authoritative Databricks App resources and managed-data inventory." />
        <div className="flex items-center justify-center gap-3 py-12" style={{ color: T.textSecondary }}>
          <Spinner size="md" />
          <span style={{ fontSize: 13 }}>Loading resources…</span>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div>
        <SectionTitle title="Resources" subtitle="Authoritative Databricks App resources and managed-data inventory." />
        <div role="alert" style={{ border: `1px solid ${T.dangerBorder}`, backgroundColor: T.dangerBg, color: T.dangerFg, borderRadius: 8, padding: "12px 14px", fontSize: 13 }}>
          Resource metadata is unavailable. No deployment state has been assumed.{" "}
          <button type="button" onClick={() => refetch()} style={{ color: T.dangerFg, fontWeight: 600, textDecoration: "underline" }}>Retry</button>
        </div>
      </div>
    );
  }

  const sp = data.service_principal;
  const warehouse = data.warehouse;
  const deployment = data.app.deployment;
  const identityUrl = safeExternalUrl(sp.identity_url, true);
  const appPageUrl = safeExternalUrl(data.app.page_url);
  const sourceCodeUrl = safeExternalUrl(data.app.source_code_url);
  const unavailableSections = Object.entries(data.subsections ?? {})
    .filter(([, status]) => !status.available)
    .map(([name]) => name.replaceAll("_", " "));
  const configuredLocation = data.storage.catalog && data.storage.schema
    ? `${data.storage.catalog}.${data.storage.schema}`
    : "Not configured";

  return (
    <div>
      <SectionTitle title="Resources" subtitle="Authoritative Databricks App resources, managed data, and integrations." />
      {unavailableSections.length > 0 && (
        <div role="status" style={{ border: `1px solid ${T.warningBorder}`, backgroundColor: T.warningBg, color: T.warningFg, borderRadius: 8, padding: "10px 12px", marginBottom: 12, fontSize: 12 }}>
          Some resource details are temporarily unavailable ({unavailableSections.join(", ")}).{" "}
          <button type="button" onClick={() => refetch()} style={{ color: T.warningFg, fontWeight: 600, textDecoration: "underline" }}>Retry</button>
        </div>
      )}

      <Group label="App runtime">
        <Row
          first
          label="App service principal"
          helper="Databricks Apps injects this execution identity. Credentials and tokens are never shown."
          control={
            <span className="inline-flex max-w-110 flex-wrap items-center justify-end gap-2">
              <MonoChip>{sp.display_name || "Unavailable"}</MonoChip>
              {sp.client_id && <MonoChip>{sp.client_id}</MonoChip>}
              {sp.object_id && <MonoChip>{sp.object_id}</MonoChip>}
              {identityUrl && <LinkButton href={identityUrl}><span className="inline-flex items-center gap-1">Identity record {externalIcon}</span></LinkButton>}
            </span>
          }
        />
        <Row
          label="SQL warehouse"
          helper={warehouse
            ? `${warehouse.name || warehouse.id || "Unnamed warehouse"} · ${warehouse.size || "Size unavailable"}`
            : "No warehouse resource is bound."}
          control={<MonoChip>{warehouse?.state || "NOT_CONFIGURED"}</MonoChip>}
        />
        <Row label="Catalog & schema" helper="Configured Unity Catalog location for app-managed data." control={<MonoChip>{configuredLocation}</MonoChip>} />
        <Row
          label="Deployment"
          helper={[
            deployment.deployer ? `by ${deployment.deployer}` : null,
            deployment.commit_sha ? `commit ${deployment.commit_sha.slice(0, 12)}` : null,
            deploymentSourceLabel(deployment.source),
          ].filter(Boolean).join(" · ") || "Deployment metadata unavailable."}
          control={<span style={{ fontSize: 12, color: T.textSecondary }}>{formatTimestamp(deployment.deployed_at)}</span>}
        />
        {(appPageUrl || sourceCodeUrl) && (
          <Row
            label="Databricks App links"
            control={
              <span className="inline-flex items-center gap-4">
                {appPageUrl && <LinkButton href={appPageUrl}><span className="inline-flex items-center gap-1">App resource {externalIcon}</span></LinkButton>}
                {sourceCodeUrl && <LinkButton href={sourceCodeUrl}><span className="inline-flex items-center gap-1">Source {externalIcon}</span></LinkButton>}
              </span>
            }
          />
        )}
      </Group>

      <Group label="Managed data inventory">
        <Row first label={`Aggregate tables (${data.inventory.aggregates.count})`} helper="Bounded pre-aggregations maintained by the app." control={<InventoryList inventory={data.inventory.aggregates} />} />
        <Row
          label={`State tables (${data.inventory.state.count})`}
          helper={`${data.inventory.state.count} durable tables. app_settings contains six namespaced preference domains; app_unified_views is created only when shared routing is active.`}
          control={(
            <InventoryList
              inventory={data.inventory.state}
              inactiveNames={data.inventory.unified_views.count === 0 ? ["app_unified_views"] : []}
            />
          )}
        />
        <Row
          label={`Cache layers (${data.inventory.cache.count})`}
          helper={`In-process cache: ${data.inventory.cache.process_entries} of ${data.inventory.cache.process_max_entries} entries; TTL ${Math.round(data.inventory.cache.process_ttl_seconds / 3600)} hours.`}
          control={<InventoryList inventory={data.inventory.cache} />}
        />
        <Row
          label={`Shared routing views (${data.inventory.unified_views.count})`}
          helper={data.inventory.unified_views.count ? "Verified unified views currently used for shared-source routing." : "No unified shared-source views are currently verified."}
          control={data.inventory.unified_views.count ? <InventoryList inventory={data.inventory.unified_views} /> : <span style={{ fontSize: 12, color: T.textSecondary }}>None</span>}
        />
      </Group>

      <Group label="Data sources & scope">
        <Row
          first
          label={`Shared data sources (${data.shared_data_sources.length})`}
          helper={data.shared_data_sources.length
            ? summarize(data.shared_data_sources.map((source) => `${source.label} · ${source.catalog}.${source.schema}`))
            : "Only this workspace's managed data is configured."}
          control={<span style={{ fontSize: 12, color: T.textSecondary }}>{data.shared_data_sources.length ? "Delta Sharing" : "None"}</span>}
        />
        <Row
          label={`Cloud-cost connections (${data.cloud_cost_connections.length})`}
          helper={data.cloud_cost_connections.length
            ? summarize(data.cloud_cost_connections.map((connection) => `${connection.name} (${connection.provider.toUpperCase()})`))
            : "No cloud billing connections are configured."}
          control={<span style={{ fontSize: 12, color: T.textSecondary }}>Metadata only</span>}
        />
        <Row
          label="Workspace filter pool"
          helper={data.workspace_filter.mode === "restricted"
            ? `${data.workspace_filter.count} workspace${data.workspace_filter.count === 1 ? "" : "s"} configured.`
            : "All workspaces are included."}
          control={<span style={{ fontSize: 12, color: T.textSecondary }}>{data.workspace_filter.mode === "restricted" ? "Restricted" : "All workspaces"}</span>}
        />
        <Row label="Permissions table" helper="App roles persist here across deployments." control={<MonoChip>{data.storage.permissions_table || "Not configured"}</MonoChip>} />
      </Group>

    </div>
  );
}
