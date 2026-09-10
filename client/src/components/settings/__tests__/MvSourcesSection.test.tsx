import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MvSourcesSection } from "../MvSourcesSection";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared source freshness", () => {
  it("shows copyable grants beside a source that the app cannot read", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        local_label: "local",
        sources: [{
          label: "west4",
          catalog: "west4_share",
          schema: "cost_obs_shared",
          tables: ["daily_usage_summary"],
          required_grants: [
            "GRANT USE CATALOG ON CATALOG `west4_share` TO `app-id`;",
            "GRANT SELECT ON SCHEMA `west4_share`.`cost_obs_shared` TO `app-id`;",
          ],
        }],
      }),
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Grant the app read access to activate this share")).toBeVisible();
    expect(screen.getByText(/GRANT SELECT ON SCHEMA/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Copy grants" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("GRANT SELECT ON SCHEMA"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("automatically applies workspace mappings discovered in the share", async () => {
    let submittedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup/list-catalogs")) {
        return { ok: true, json: async () => ({ catalogs: ["west4_share"] }) };
      }
      if (url.includes("/setup/list-schemas")) {
        return { ok: true, json: async () => ({ schemas: ["cost_obs_shared"] }) };
      }
      if (url.includes("/mv-sources/preview")) {
        return {
          ok: true,
          json: async () => ({
            matched: 1,
            total: 1,
            tables: [{ table: "daily_usage_summary", status: "match" }],
            workspace_candidates: [
              { workspace_id: "workspace-a", workspace_name: "west4-a" },
              { workspace_id: "workspace-b", workspace_name: "west4-b" },
            ],
          }),
        };
      }
      if (url.endsWith("/api/settings/mv-sources") && init?.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ local_label: "local", sources: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Browse" }));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Catalog" }), "west4_share");
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Schema" }), "cost_obs_shared");

    expect(await screen.findByText("west4-a")).toBeVisible();
    expect(screen.getByText("west4-b")).toBeVisible();
    await userEvent.type(screen.getByPlaceholderText("e.g. EU workspace"), "west4");
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() => expect(submittedBody).toMatchObject({
      workspace_ids: ["workspace-a", "workspace-b"],
    }));
  });

  it("offers existing labels while preserving free-form label entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/setup/list-catalogs")) {
        return { ok: true, json: async () => ({ catalogs: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          local_label: "local",
          sources: [{
            label: "west4",
            catalog: "west4_share",
            schema: "cost_obs_shared",
            tables: ["daily_usage_summary"],
          }],
        }),
      };
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Browse" }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Existing label" }),
      "west4",
    );
    expect(screen.getByPlaceholderText("e.g. EU workspace")).toHaveValue("west4");

    await userEvent.clear(screen.getByPlaceholderText("e.g. EU workspace"));
    await userEvent.type(screen.getByPlaceholderText("e.g. EU workspace"), "new-region");
    expect(screen.getByPlaceholderText("e.g. EU workspace")).toHaveValue("new-region");
  });

  it("summarizes multi-view sources with one linked schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        local_label: "local",
        sources: [{
          label: "west4",
          catalog: "west4_share",
          schema: "cost_obs_shared",
          cloud: "google",
          tables: ["daily_usage_summary", "daily_apps_summary"],
          workspace_ids: ["workspace-west"],
          shared_view_total: 9,
          missing_tables: ["daily_query_stats", "sql_tool_attribution"],
          catalog_explorer_schema_url: "https://dbc.example.com/explore/data/west4_share/cost_obs_shared",
          catalog_explorer_tables: [
            { fqn: "west4_share.cost_obs_shared.daily_usage_summary", url: "https://dbc.example.com/table-1" },
            { fqn: "west4_share.cost_obs_shared.daily_apps_summary", url: "https://dbc.example.com/table-2" },
          ],
        }],
      }),
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("2 of 9 shared views")).toBeVisible();
    expect(screen.getByText("Workspace workspace-west")).toBeVisible();
    expect(screen.getByText("Google Cloud · west4")).toBeVisible();
    expect(screen.getByText("Missing: daily_query_stats, sql_tool_attribution")).toBeVisible();
    expect(screen.getByRole("img", { name: "Google Cloud" })).toBeVisible();
    expect(screen.getByText("west4")).toHaveStyle({ color: "#B3261E" });
    expect(screen.getByRole("link", {
      name: "Open west4_share.cost_obs_shared in Catalog Explorer (opens in a new tab)",
    })).toHaveAttribute(
      "href",
      "https://dbc.example.com/explore/data/west4_share/cost_obs_shared",
    );
    expect(screen.queryByRole("link", { name: /daily_usage_summary/ })).not.toBeInTheDocument();
  });

  it("shows the shared app spinner while reading a selected schema", async () => {
    const pendingPreview = new Promise<never>(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/setup/list-catalogs")) {
        return { ok: true, json: async () => ({ catalogs: ["west4_share"] }) };
      }
      if (url.includes("/setup/list-schemas")) {
        return { ok: true, json: async () => ({ schemas: ["cost_obs_shared"] }) };
      }
      if (url.includes("/mv-sources/preview")) return pendingPreview;
      return { ok: true, json: async () => ({ local_label: "local", sources: [] }) };
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Browse" }));
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Catalog" }),
      "west4_share",
    );
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Schema" }),
      "cost_obs_shared",
    );

    expect(screen.getByText("Reading views in this schema…")).toBeVisible();
    expect(screen.getByRole("status", { name: "Loading" })).toBeVisible();
  });

  it("checks freshness and keeps refresh/remove actions aligned", async () => {
    let checkCount = 0;
    const pendingCheck = new Promise<never>(() => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/mv-sources/check")) {
        checkCount += 1;
        if (checkCount === 2) return pendingCheck;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            checked_at: "2026-08-28T12:00:00Z",
            share_last_updated: "2026-08-28T11:00:00Z",
            matched: 1,
            total: 1,
            tables: [{ table: "daily_usage_summary", status: "match" }],
            required_grants: [],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          local_label: "local",
          sources: [{
            label: "west",
            catalog: "shared",
            schema: "cost_obs",
            cloud: "azure",
            tables: ["daily_usage_summary"],
            share_last_updated: "2026-08-28T11:00:00Z",
            catalog_explorer_tables: [{
              fqn: "shared.cost_obs.daily_usage_summary",
              url: "https://dbc.example.com/explore/data/shared/cost_obs/daily_usage_summary",
            }],
          }],
          recipient_refresh: {
            supported: false,
            mode: "provider_managed",
            check_action: "metadata_and_local_bindings_only",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );

    const check = await screen.findByRole("button", { name: "Re-check metadata" });
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(check.parentElement).toContainElement(remove);
    expect(screen.getByText(/Provider updates appear automatically/)).toBeVisible();
    expect(screen.getByRole("img", { name: "Azure" })).toHaveAttribute(
      "src",
      expect.stringContaining("azure-128.png"),
    );
    expect(screen.getByRole("link", {
      name: "Open shared.cost_obs.daily_usage_summary in Catalog Explorer (opens in a new tab)",
    })).toHaveAttribute(
      "href",
      "https://dbc.example.com/explore/data/shared/cost_obs/daily_usage_summary",
    );

    await user.click(check);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/mv-sources/check?label=west",
      { method: "POST" },
    ));
    expect(await screen.findByText("Checked just now")).toBeInTheDocument();

    await user.click(check);
    expect(await screen.findByText("Checking…")).toBeVisible();
    expect(screen.queryByText("Checked just now")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "reports a failed rebuild",
      response: { ok: false, build: { error: "view rebuild failed" }, tables: [{ table: "daily_usage_summary", status: "match" }] },
      message: "view rebuild failed",
    },
    {
      name: "reports a missing configured view",
      response: { ok: true, matched: 0, total: 1, tables: [{ table: "daily_usage_summary", status: "absent" }] },
      message: "Freshness check failed for: daily_usage_summary",
    },
    {
      name: "reports unreadable tables with schema grants",
      response: {
        ok: true,
        matched: 0,
        total: 1,
        tables: [{ table: "daily_usage_summary", status: "unreadable" }],
        required_grants: [
          "GRANT USE CATALOG ON CATALOG `shared` TO `app-id`;",
          "GRANT USE SCHEMA ON SCHEMA `shared`.`cost_obs` TO `app-id`;",
          "GRANT SELECT ON SCHEMA `shared`.`cost_obs` TO `app-id`;",
        ],
      },
      message: "The shared tables exist, but the app service principal cannot read them. Apply the schema grants shown below.",
    },
  ])("$name instead of showing a successful check", async ({ response, message }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/mv-sources/check")) {
        return { ok: true, json: async () => response };
      }
      return {
        ok: true,
        json: async () => ({
          local_label: "local",
          sources: [{
            label: "west",
            catalog: "shared",
            schema: "cost_obs",
            tables: ["daily_usage_summary"],
          }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Re-check metadata" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    if (response.required_grants) {
      expect(screen.getByText(/GRANT SELECT ON SCHEMA/)).toBeInTheDocument();
    }
    expect(screen.queryByText("Checked just now")).not.toBeInTheDocument();
  });

  it("unwraps structured 503 details and preserves nested grant remediation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/mv-sources/check")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({
            detail: {
              message: "Shared source check failed; existing routing remains active.",
              result: {
                required_grants: [
                  "GRANT SELECT ON SCHEMA `shared`.`cost_obs` TO `app-id`;",
                ],
                build: { error: "view rebuild failed" },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          local_label: "local",
          sources: [{
            label: "west",
            catalog: "shared",
            schema: "cost_obs",
            tables: ["daily_usage_summary"],
          }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MvSourcesSection />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Re-check metadata" }));

    expect(await screen.findByText(
      "Shared source check failed; existing routing remains active.",
    )).toBeVisible();
    expect(screen.getByText(/GRANT SELECT ON SCHEMA/)).toBeVisible();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });
});
