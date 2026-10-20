import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabRefreshRegion } from "@/components/TabRefreshRegion";
import {
  isQueryOwnedByTab,
  removeInactiveDashboardScopeData,
  refreshSourceScopeData,
  refreshTabData,
  startScopedAutoRefresh,
  TAB_LOADING_SECTIONS,
} from "../tabRefresh";

afterEach(() => {
  vi.useRealTimers();
});

describe("per-tab manual refresh", () => {
  it.each([
    ["dbu", ["billing", "dashboard-bundle-fast"]],
    ["sql", ["dbsql", "dashboard-bundle"]],
    ["infra", ["billing", "cloud-costs-bundle"]],
    ["infra", ["azure-actual", "dashboard-bundle"]],
    ["optimizer", ["warehouse-idle-time", "2026-01-01"]],
    ["kpis", ["kpis-platform-kpi-trend", "total_queries"]],
    ["aiml", ["aiml-kpi-trend", "aiml_spend"]],
    ["apps", ["apps-kpi-trend", "apps_spend"]],
    ["tagging", ["tagging-kpi-trend", "total_spend"]],
    ["users-groups", ["users-groups", "bundle"]],
    ["users-groups", ["users-groups-kpi-trend", "user_spend"]],
    ["users-groups", ["users-groups-platform-kpi-trend", "total_users"]],
  ] as const)("matches %s-owned queries", (tab, queryKey) => {
    expect(isQueryOwnedByTab(tab, queryKey)).toBe(true);
  });

  it("excludes global settings, account, and other-tab queries", () => {
    expect(isQueryOwnedByTab("dbu", ["unified-settings"])).toBe(false);
    expect(isQueryOwnedByTab("dbu", ["billing", "account"])).toBe(false);
    expect(isQueryOwnedByTab("dbu", ["dbsql", "dashboard-bundle"])).toBe(false);
    expect(isQueryOwnedByTab("infra", ["billing", "dashboard-bundle-fast"])).toBe(false);
    expect(isQueryOwnedByTab("sql", ["aiml-kpi-trend", "aiml_spend"])).toBe(false);
    expect(isQueryOwnedByTab("dbu", ["tagging-kpi-trend", "tagged_spend"])).toBe(false);
    expect(isQueryOwnedByTab("dbu", ["users-groups-kpi-trend", "user_spend"])).toBe(false);
    expect(isQueryOwnedByTab("kpis", ["users-groups-platform-kpi-trend", "total_users"])).toBe(false);
  });

  it("auto-refreshes active dashboard queries, pauses hidden, and resumes without a burst", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const dashboardQuery = client.getQueryCache().build(client, {
      queryKey: ["billing", "dashboard-bundle-fast"],
      queryFn: async () => ({}),
    });
    const settingsQuery = client.getQueryCache().build(client, {
      queryKey: ["unified-settings"],
      queryFn: async () => ({}),
    });
    const listeners = new Set<EventListener>();
    let visibilityState: DocumentVisibilityState = "visible";
    const visibilityDocument = {
      get visibilityState() { return visibilityState; },
      addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") listeners.add(listener);
      },
      removeEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") listeners.delete(listener);
      },
    };
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const stop = startScopedAutoRefresh(client, 1_000, visibilityDocument);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const options = invalidate.mock.calls[0][0];
    expect(options?.type).toBe("active");
    expect(options?.refetchType).toBe("active");
    expect(options?.predicate?.(dashboardQuery)).toBe(true);
    expect(options?.predicate?.(settingsQuery)).toBe(false);

    visibilityState = "hidden";
    listeners.forEach((listener) => listener(new Event("visibilitychange")));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invalidate).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    listeners.forEach((listener) => listener(new Event("visibilitychange")));
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    stop();
  });

  it.each([
    ["dbu", ["kpi-trend", "total_spend"]],
    ["sql", ["sql-platform-kpi-trend", "total_queries"]],
    ["infra", ["infra-kpi-trend", "infra_cost"]],
    ["kpis", ["kpis-platform-kpi-trend", "total_queries"]],
    ["aiml", ["aiml-kpi-trend", "aiml_spend"]],
    ["apps", ["apps-kpi-trend", "apps_spend"]],
    ["tagging", ["tagging-kpi-trend", "tagged_spend"]],
    ["users-groups", ["users-groups-kpi-trend", "user_spend"]],
    ["users-groups", ["users-groups-platform-kpi-trend", "total_users"]],
  ] as const)("assigns %s trend queries to one tab", (tab, queryKey) => {
    expect(isQueryOwnedByTab(tab, queryKey)).toBe(true);
    for (const other of ["dbu", "sql", "infra", "kpis", "aiml", "apps", "tagging", "users-groups"] as const) {
      if (other !== tab) expect(isQueryOwnedByTab(other, queryKey)).toBe(false);
    }
  });

  it("cancels and refetches only matching keys through the tab cache URL", async () => {
    const client = new QueryClient();
    const dbuQuery = client.getQueryCache().build(client, {
      queryKey: ["billing", "dashboard-bundle-fast"],
      queryFn: async () => ({}),
    });
    const settingsQuery = client.getQueryCache().build(client, {
      queryKey: ["unified-settings"],
      queryFn: async () => ({}),
    });
    const cancel = vi.spyOn(client, "cancelQueries").mockResolvedValue();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const refetch = vi.spyOn(client, "refetchQueries").mockResolvedValue();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await refreshTabData(client, "dbu", fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/cache/clear?tab=dbu", { method: "POST" });
    const cancelOptions = cancel.mock.calls[0][0];
    const invalidateOptions = invalidate.mock.calls[0][0];
    const refetchOptions = refetch.mock.calls[0][0];
    expect(cancelOptions?.predicate?.(dbuQuery)).toBe(true);
    expect(cancelOptions?.predicate?.(settingsQuery)).toBe(false);
    expect(invalidateOptions?.refetchType).toBe("none");
    expect(invalidateOptions?.predicate?.(dbuQuery)).toBe(true);
    expect(invalidateOptions?.predicate?.(settingsQuery)).toBe(false);
    expect(refetchOptions?.type).toBe("active");
    expect(refetchOptions?.predicate?.(dbuQuery)).toBe(true);
    expect(refetchOptions?.predicate?.(settingsQuery)).toBe(false);
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(refetch.mock.invocationCallOrder[0]);
  });

  it("increments the current tab fetch count after manual refresh", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const queryFn = vi.fn(async () => ({ total_spend: 1 }));
    const observer = new QueryObserver(client, {
      queryKey: ["billing", "dashboard-bundle-fast", "scope-a"],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(queryFn).toHaveBeenCalledTimes(1);

    await refreshTabData(
      client,
      "dbu",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch,
    );

    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("invalidates old scope without duplicate refetch, then fetches new scope on demand", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const dbuFetch = vi.fn(async () => ({ total_spend: 1 }));
    const appsFetch = vi.fn(async () => ({ apps: [] }));
    const dbuOptions = {
      queryKey: ["billing", "dashboard-bundle-fast", "scope-a"],
      queryFn: dbuFetch,
    };
    const appsOptions = {
      queryKey: ["apps", "dashboard-bundle", "scope-a"],
      queryFn: appsFetch,
    };
    const usersTrendKey = ["users-groups-kpi-trend", "user_spend", "scope-a"];
    const observer = new QueryObserver(client, dbuOptions);
    const unsubscribe = observer.subscribe(() => {});
    await client.ensureQueryData(dbuOptions);
    client.setQueryData(appsOptions.queryKey, { apps: ["stale"] });
    client.setQueryData(usersTrendKey, { data_points: ["stale"] });

    await refreshSourceScopeData(client);

    expect(dbuFetch).toHaveBeenCalledTimes(1);
    expect(appsFetch).not.toHaveBeenCalled();
    expect(client.getQueryState(dbuOptions.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(appsOptions.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(usersTrendKey)?.isInvalidated).toBe(true);

    await client.fetchQuery({ ...dbuOptions, queryKey: ["billing", "dashboard-bundle-fast", "scope-b"] });
    await client.fetchQuery({ ...appsOptions, queryKey: ["apps", "dashboard-bundle", "scope-b"] });
    removeInactiveDashboardScopeData(client);
    expect(dbuFetch).toHaveBeenCalledTimes(2);
    expect(appsFetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(appsOptions.queryKey)).toBeUndefined();
    unsubscribe();
  });

  it("keeps the button visible and replaces stale content with loading panels", async () => {
    render(
      <TabRefreshRegion
        isLoading
        isRefreshing
        loadingSections={TAB_LOADING_SECTIONS.optimizer}
        onRefresh={vi.fn()}
        onDismissRefreshError={vi.fn()}
      >
        <div>Stale optimizer content</div>
      </TabRefreshRegion>,
    );

    expect(screen.getByRole("button", { name: "Refresh this tab" })).toBeVisible();
    expect(screen.queryByText("Stale optimizer content")).not.toBeInTheDocument();
    expect(screen.getByText("Idle Time Analysis")).toBeVisible();
    expect(screen.getByText("Rightsizing Recommendations")).toBeVisible();
  });

  it("reserves space so date chips are not covered by the refresh button", () => {
    const { container } = render(
      <TabRefreshRegion
        isLoading={false}
        isRefreshing={false}
        loadingSections={[]}
        onRefresh={vi.fn()}
        onDismissRefreshError={vi.fn()}
      >
        <div>Date range</div>
      </TabRefreshRegion>,
    );
    expect(container.querySelector(".pr-14")).toBeTruthy();
  });

  it("describes the refresh as per-tab", async () => {
    render(
      <TabRefreshRegion
        isLoading={false}
        isRefreshing={false}
        loadingSections={[]}
        onRefresh={vi.fn()}
        onDismissRefreshError={vi.fn()}
      >
        <div>Current content</div>
      </TabRefreshRegion>,
    );
    await userEvent.hover(screen.getByRole("button", { name: "Refresh this tab" }));
    expect(screen.getByText("Refresh this tab", { selector: "p" })).toBeVisible();
    expect(screen.getByText(/clears this tab's caches/)).toBeVisible();
  });

  it("keeps refresh failures visible and directly retryable", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onDismissRefreshError = vi.fn();
    render(
      <TabRefreshRegion
        isLoading={false}
        isRefreshing={false}
        loadingSections={[]}
        onRefresh={onRefresh}
        onDismissRefreshError={onDismissRefreshError}
        refreshError="This tab could not be refreshed: warehouse unavailable"
      >
        <div>Current content</div>
      </TabRefreshRegion>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("warehouse unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss refresh error" }));
    expect(onDismissRefreshError).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveClass("mr-11");
  });
});
