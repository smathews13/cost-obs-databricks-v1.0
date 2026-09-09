import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLabelFilter } from "../SourceLabelFilter";
import {
  buildFilteredUrl,
  getActiveSourceLabels,
  getActiveSourceRouting,
  setActiveSourceLabels,
  setActiveSourceRouting,
  setActiveSourceTables,
} from "@/hooks/useBillingData";
import { SourceCapabilityNotice } from "../brand";

const sourceData = (labels: string[]) => ({
  local_label: "local",
  sources: labels
    .filter((label) => label !== "local")
    .map((label) => ({ label, catalog: "shared", schema: "cost_obs" })),
});

afterEach(() => {
  setActiveSourceLabels([]);
  vi.unstubAllGlobals();
});

describe("source label reconciliation", () => {
  it("lists only aggregates actually missing from the selected source", () => {
    setActiveSourceLabels(["west4"]);
    setActiveSourceTables(["daily_workspace_breakdown"]);

    render(
      <SourceCapabilityNotice
        title="Platform detail unavailable"
        description="Some shared detail is unavailable."
        requiredAggregates={[
          "daily_query_stats",
          "daily_workspace_breakdown",
          "dbsql_cost_per_query",
        ]}
      />,
    );

    expect(screen.getByText(/Missing from selected source/)).toBeVisible();
    expect(screen.getByText("daily_query_stats")).toBeVisible();
    expect(screen.getByText("dbsql_cost_per_query")).toBeVisible();
    expect(screen.queryByText("daily_workspace_breakdown")).not.toBeInTheDocument();
  });

  it("shows detected provider logos for local and shared sources", async () => {
    const current = {
      local_label: "local-gcp",
      local_cloud: "gcp" as const,
      sources: [
        { label: "shared-aws", catalog: "aws_share", schema: "cost_obs", cloud: "aws" as const },
        { label: "shared-azure", catalog: "azure_share", schema: "cost_obs", cloud: "azure" as const },
        { label: "west4", catalog: "west4_share", schema: "cost_obs", cloud: "google" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "4 Sources" }));

    expect(screen.getAllByTitle("Google Cloud")).toHaveLength(2);
    for (const emblem of screen.getAllByTitle("Google Cloud")) {
      expect(emblem).toHaveAttribute("src", expect.stringContaining("gcp.svg"));
    }
    expect(screen.getByTitle("AWS")).toHaveAttribute(
      "src",
      expect.stringContaining("aws"),
    );
    expect(screen.getByTitle("Azure")).toHaveAttribute(
      "src",
      expect.stringContaining("azure"),
    );
  });

  it("updates module scope before invoking the App refresh callback", async () => {
    const current = sourceData(["local", "west"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const scopesSeen: string[][] = [];

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter onApplied={async () => {
          scopesSeen.push(getActiveSourceLabels());
        }} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /west/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(scopesSeen).toEqual([["local"]]));
  });

  it("routes a same-account source through its workspace ID", async () => {
    const current = {
      local_label: "local",
      sources: [{
        label: "west4",
        catalog: "west4_share",
        schema: "cost_obs",
        tables: ["daily_usage_summary"],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const urls: string[] = [];
    const linkedWorkspaceScopes: Array<string[] | null> = [];

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "1", name: "east1-serverless" },
            { id: "2", name: "west4-serverless" },
          ]}
          onApplied={(workspaceIds) => {
            linkedWorkspaceScopes.push(workspaceIds);
            urls.push(buildFilteredUrl("/api/test"));
          }}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /local/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain("workspace_ids=2");
    expect(urls[0]).toContain("source_labels=local");
    expect(getActiveSourceLabels()).toEqual(["west4"]);
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: ["2"],
      tables: ["daily_usage_summary"],
    });
    expect(linkedWorkspaceScopes).toEqual([["2"]]);
  });

  it("automatically narrows source selection to the selected workspace", async () => {
    const current = {
      local_label: "local",
      sources: [
        { label: "west4", catalog: "west", schema: "cost" },
        { label: "central1", catalog: "central", schema: "cost" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "1", name: "east1-serverless" },
            { id: "2", name: "west4-serverless" },
            { id: "3", name: "central1-serverless" },
          ]}
          workspaceSelection={["2"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["west4"]));
    await userEvent.click(await screen.findByRole("button", { name: "west4" }));
    expect(screen.getByRole("checkbox", { name: /west4/i })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /local/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /central1/i })).not.toBeInTheDocument();
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: ["2"],
    });
  });

  it("uses the workspace name to repair swapped persisted region mappings", async () => {
    const current = {
      local_label: "local",
      sources: [
        { label: "west4", catalog: "west", schema: "cost", workspace_ids: ["1"] },
        { label: "east1", catalog: "east", schema: "cost", workspace_ids: ["2"] },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "1", name: "east1-serverless" },
            { id: "2", name: "west4-serverless" },
          ]}
          workspaceSelection={["2"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["west4"]));
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: ["2"],
    });
  });

  it("does not let an embedded region substring override a persisted mapping", async () => {
    const current = {
      local_label: "local",
      sources: [{
        label: "east1",
        catalog: "east",
        schema: "cost",
        workspace_ids: ["1"],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "1", name: "Primary" },
            { id: "2", name: "northeast1-serverless" },
          ]}
          workspaceSelection={["1"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["east1"]));
    expect(getActiveSourceRouting().workspaceIds).toEqual(["1"]);
  });

  it("preserves the linked source when the explicit workspace selection is cleared", async () => {
    const current = {
      local_label: "local",
      sources: [{ label: "west4", catalog: "west", schema: "cost" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const localWorkspaces = [
      { id: "1", name: "east1-serverless" },
      { id: "2", name: "west4-serverless" },
    ];
    const view = render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={localWorkspaces}
          workspaceSelection={["2"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["west4"]));
    view.rerender(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={localWorkspaces}
          workspaceSelection={[]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["west4"]));
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: ["2"],
    });
  });

  it("unions matching sources when multiple workspaces are selected", async () => {
    const current = {
      local_label: "local",
      sources: [
        { label: "west4", catalog: "west", schema: "cost" },
        { label: "central1", catalog: "central", schema: "cost" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "1", name: "east1-serverless" },
            { id: "2", name: "west4-serverless" },
            { id: "3", name: "central1-serverless" },
          ]}
          workspaceSelection={["2", "3"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["central1", "west4"]));
    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    expect(screen.getByRole("checkbox", { name: /west4/i })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /central1/i })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /local/i })).not.toBeInTheDocument();
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: ["2", "3"],
    });
  });

  it("keeps mapped sources alongside local coverage for unmapped workspaces", async () => {
    const current = {
      local_label: "local",
      sources: [{ label: "west4", catalog: "west", schema: "cost" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "1", name: "east1-serverless" },
            { id: "2", name: "west4-serverless" },
          ]}
          workspaceSelection={["1", "2"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["local", "west4"]));
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: [],
    });
  });

  it("collapses local plus a same-account shared source to one local read path", async () => {
    const current = {
      local_label: "local",
      sources: [
        { label: "west4", catalog: "west", schema: "cost" },
        { label: "central1", catalog: "central", schema: "cost" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const linkedScopes: Array<string[] | null> = [];

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "2", name: "west4-serverless" },
            { id: "3", name: "central1-serverless" },
          ]}
          onApplied={(workspaceIds) => { linkedScopes.push(workspaceIds); }}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "3 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /central1/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(linkedScopes).toEqual([null]));
    expect(getActiveSourceLabels()).toEqual(["local", "west4"]);
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["local"],
      workspaceIds: [],
    });
  });

  it("repairs publisher routing when workspace names hydrate after Apply", async () => {
    const current = {
      local_label: "local",
      sources: [{
        label: "west4",
        catalog: "west4_share",
        schema: "cost_obs",
        tables: ["daily_usage_summary"],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const urls: string[] = [];
    const linkedScopes: Array<string[] | null> = [];
    const onApplied = (workspaceIds: string[] | null) => {
      linkedScopes.push(workspaceIds);
      urls.push(buildFilteredUrl("/api/test"));
    };
    const view = render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter localWorkspaces={[]} onApplied={onApplied} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /local/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain("source_labels=west4");
    expect(linkedScopes[0]).toBeNull();

    view.rerender(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "workspace-east", name: "east1-serverless" },
            { id: "workspace-west", name: "west4-serverless" },
          ]}
          onApplied={onApplied}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain("source_labels=local");
    expect(urls[1]).toContain("workspace_ids=workspace-west");
    expect(linkedScopes[1]).toEqual(["workspace-west"]);
  });

  it("restores publisher routing when hydration repair fails", async () => {
    const current = {
      local_label: "local",
      sources: [{ label: "west4", catalog: "west", schema: "cost" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const onApplied = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("refresh failed"));
    const view = render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter localWorkspaces={[]} onApplied={onApplied} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /local/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["west4"],
      workspaceIds: [],
    });

    view.rerender(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[{ id: "2", name: "west4-serverless" }]}
          onApplied={onApplied}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getActiveSourceRouting()).toMatchObject({
      requestLabels: ["west4"],
      workspaceIds: [],
    }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Source workspace routing could not be refreshed",
    );
  });

  it("falls back to an exact workspace ID when names do not match", async () => {
    const current = {
      local_label: "local",
      sources: [{ label: "workspace-west", catalog: "share", schema: "cost_obs" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const urls: string[] = [];
    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          localWorkspaces={[
            { id: "workspace-east", name: "Primary" },
            { id: "workspace-west", name: "Secondary" },
          ]}
          onApplied={() => { urls.push(buildFilteredUrl("/api/test")); }}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /local/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain("workspace_ids=workspace-west");
  });

  it("encodes a conflicting workspace and source selection as an empty scope", () => {
    setActiveSourceLabels(["west4"]);
    setActiveSourceRouting(["local"], ["2"]);

    const url = new URL(
      buildFilteredUrl("/api/test", new URLSearchParams(), ["1"]),
      "https://example.test",
    );

    expect(url.searchParams.get("workspace_ids")).toBe("source-scope-no-overlap");
    expect(url.searchParams.getAll("source_labels")).toEqual(["local"]);
  });

  it("keeps All selected when a new source appears", async () => {
    let current = sourceData(["local", "west"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const onApplied = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter onApplied={onApplied} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "2 Sources" })).toBeInTheDocument();

    current = sourceData(["local", "west", "east"]);
    client.setQueryData(["mv-sources"], current);

    await waitFor(() => expect(screen.getByRole("button", { name: "3 Sources" })).toBeInTheDocument());
    expect(getActiveSourceLabels()).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("shows all sources after the combined scope reset", async () => {
    const current = sourceData(["local", "west4"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    setActiveSourceLabels(["west4"]);
    const view = render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter resetVersion={0} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "west4" })).toBeVisible();
    setActiveSourceLabels([]);
    view.rerender(
      <QueryClientProvider client={client}>
        <SourceLabelFilter resetVersion={1} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "2 Sources" })).toBeVisible();
  });

  it("shows source refresh while a date-scope update is running", async () => {
    const current = sourceData(["local", "west4"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter isRefreshing />
      </QueryClientProvider>,
    );

    const trigger = await screen.findByRole("button", { name: "Updating sources" });
    expect(trigger).toBeDisabled();
    expect(screen.getByText("Updating…")).toHaveClass("text-[11px]");
    expect(trigger.querySelector('path[d="M19 9l-7 7-7-7"]')).toBeNull();
  });

  it("keeps every source option available while source is the controlling filter", async () => {
    const current = sourceData(["local", "west4", "east1"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    setActiveSourceLabels(["west4"]);
    setActiveSourceRouting(["local"], ["2"]);

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          controlling
          workspaceSelection={["2"]}
          localWorkspaces={[
            { id: "1", name: "east1-serverless" },
            { id: "2", name: "west4-serverless" },
          ]}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "west4" }));
    expect(screen.getByRole("checkbox", { name: /local/i })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /west4/i })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /east1/i })).toBeVisible();
  });

  it("clears the mapped workspace scope when the controlling source returns to All", async () => {
    const current = sourceData(["local", "west4"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    setActiveSourceLabels(["west4"]);
    setActiveSourceRouting(["local"], ["2"]);
    const applied: Array<{ workspaceIds: string[] | null; origin?: string }> = [];

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter
          controlling
          workspaceSelection={["2"]}
          localWorkspaces={[{ id: "2", name: "west4-serverless" }]}
          onApplied={(workspaceIds, origin) => {
            applied.push({ workspaceIds, origin });
          }}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "west4" }));
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(applied).toEqual([{
      workspaceIds: [],
      origin: "source",
    }]));
    expect(getActiveSourceLabels()).toEqual([]);
    expect(getActiveSourceRouting().workspaceIds).toEqual([]);
  });

  it("intersects a partial applied scope when selected labels disappear", async () => {
    setActiveSourceLabels(["local", "west"]);
    let current = sourceData(["local", "west", "east"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const onApplied = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter onApplied={onApplied} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "2 sources" })).toBeInTheDocument();

    current = sourceData(["local", "east"]);
    client.setQueryData(["mv-sources"], current);

    await waitFor(() => expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument());
    expect(getActiveSourceLabels()).toEqual(["local"]);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed scope and offers a direct retry", async () => {
    const current = sourceData(["local", "west"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => current,
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["mv-sources"], current);
    const scopesSeen: string[][] = [];
    let calls = 0;

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter onApplied={async () => {
          calls += 1;
          scopesSeen.push(getActiveSourceLabels());
          if (calls === 1) throw new Error("warehouse unavailable");
        }} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "2 Sources" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /west/i }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Source filter was not applied");
    expect(getActiveSourceLabels()).toEqual([]);
    expect(scopesSeen).toEqual([["local"], []]);
    expect(screen.getByRole("button", { name: "2 Sources" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getActiveSourceLabels()).toEqual(["local"]));
    expect(scopesSeen).toEqual([["local"], [], ["local"]]);
  });
});
