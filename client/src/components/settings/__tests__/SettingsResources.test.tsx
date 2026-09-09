import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsResources } from "../SettingsResources";

const payload = {
  generated_at: "2026-08-31T17:00:00Z",
  app: {
    name: "cost-obs",
    url: "https://cost-obs.example.databricksapps.com",
    page_url: "https://dbc.example.com/apps-v2/app/cost-obs/overview",
    source_code_url: "https://github.com/example/cost-obs",
    deployment: {
      deployed_at: "2026-08-30T21:29:46Z",
      deployer: "owner@example.com",
      commit_sha: "abc123def456",
      available: true,
      source: "databricks_apps_api",
    },
    version: { commit_sha: "abc123def456" },
  },
  service_principal: {
    display_name: "app-cost-obs",
    client_id: "client-id",
    object_id: "object-id",
    user_name: "client-id",
    identity_url: "https://dbc.example.com/api/2.0/preview/scim/v2/ServicePrincipals/object-id",
    execution_identity: "service_principal",
    execution_explanation: "Queries run as this service principal.",
    effective_oauth_scopes: ["all-apis"],
    oauth_scope_source: "databricks_apps_oauth_m2m",
  },
  warehouse: {
    id: "warehouse-id",
    name: "Serverless Starter Warehouse",
    size: "Medium",
    state: "RUNNING",
    source: "app_resource",
  },
  storage: {
    catalog: "east1_serverless",
    schema: "cost_obs_schema",
    permissions_table: "east1_serverless.cost_obs_schema.app_user_permissions",
  },
  inventory: {
    aggregates: { count: 2, names: ["daily_usage_summary", "daily_workspace_breakdown"] },
    state: { count: 2, names: ["app_settings", "app_user_permissions"] },
    cache: {
      count: 2,
      names: ["in-process query cache", "app_response_cache"],
      process_entries: 4,
      process_max_entries: 200,
      process_ttl_seconds: 7200,
    },
    unified_views: { count: 1, names: ["daily_usage_summary"] },
    observed_tables: {
      checked_at: "2026-08-31T16:55:00Z",
      available: 8,
      total: 9,
    },
  },
  shared_data_sources: [{
    label: "west",
    catalog: "west_share",
    schema: "cost_obs",
    cloud: "aws",
  }],
  cloud_cost_connections: [{
    id: "connection-1",
    name: "AWS CUR",
    provider: "aws",
    created_at: "2026-08-30T10:00:00Z",
  }],
  workspace_filter: {
    mode: "restricted",
    count: 2,
  },
  refresh: {
    schedule: {
      enabled: true,
      frequency: "nightly",
      hour_utc: 5,
      lookback_days: 180,
    },
    status: {
      last_refresh_utc: "2026-08-31T05:00:00Z",
      hours_since_refresh: 12,
      stale: false,
      status: "success",
      refresh_history: [{
        timestamp: "2026-08-31T05:00:00Z",
        status: "success",
        trigger: "scheduled",
        operation: "rebuild",
      }],
    },
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));
});

function renderResources() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsResources />
    </QueryClientProvider>,
  );
}

describe("SettingsResources", () => {
  it("marks the unified-view inventory inactive until shared routing is built", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...payload,
        inventory: {
          ...payload.inventory,
          state: {
            count: 3,
            names: ["app_settings", "app_user_permissions", "app_unified_views"],
          },
          unified_views: { count: 0, names: [] },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    renderResources();

    const unifiedViews = await screen.findByText("app_unified_views");
    expect(unifiedViews.parentElement).toHaveAttribute("data-inactive", "true");
    expect(unifiedViews.parentElement).toHaveClass("opacity-45", "grayscale");
    expect(screen.getByText(/app_settings contains six namespaced preference domains/i)).toBeVisible();
  });

  it("keeps useful runtime, inventory, and source metadata without duplicated data-table operations", async () => {
    renderResources();

    expect(await screen.findByText("App runtime")).toBeVisible();
    expect(screen.getByText("Managed data inventory")).toBeVisible();
    expect(screen.getByText("Data sources & scope")).toBeVisible();
    expect(screen.getByText("app-cost-obs")).toBeVisible();
    expect(screen.getByText("Aggregate tables (2)")).toBeVisible();
    expect(screen.getByText("Shared data sources (1)")).toBeVisible();
    expect(screen.getByText("Cloud-cost connections (1)")).toBeVisible();
    expect(screen.queryByText("Observed table availability")).not.toBeInTheDocument();
    expect(screen.queryByText("Refresh operations")).not.toBeInTheDocument();
    expect(screen.queryByText("Freshness")).not.toBeInTheDocument();
    expect(screen.queryByText(/Refresh history/)).not.toBeInTheDocument();
    expect(screen.queryByText("Schedule")).not.toBeInTheDocument();
  });

  it("renders only valid HTTPS Databricks identity links and no secrets", async () => {
    renderResources();

    const identity = await screen.findByRole("link", { name: /Identity record/ });
    expect(identity).toHaveAttribute(
      "href",
      "https://dbc.example.com/api/2.0/preview/scim/v2/ServicePrincipals/object-id",
    );
    expect(document.body.textContent).not.toMatch(/client_secret|access_key|token-value/i);
  });

  it("keeps successful sections visible when one subsection is temporarily unavailable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        ...payload,
        subsections: {
          config: { available: true },
          shared_data_sources: {
            available: false,
            reason: "temporarily_unavailable",
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderResources();

    expect(await screen.findByText(
      /resource details are temporarily unavailable \(shared data sources\)/i,
    )).toHaveTextContent(
      /temporarily unavailable/i,
    );
    expect(screen.getByText("App runtime")).toBeVisible();
    expect(screen.getByText("Managed data inventory")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
