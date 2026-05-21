/**
 * Regression tests for PlatformKPIsView fake-zero prevention.
 *
 * Core invariant: when a system table grant is explicitly denied (false),
 * the corresponding KPI cards must show the unavailable state (renders "—"),
 * NOT zero or a loading spinner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformKPIsView } from "../PlatformKPIsView";

// ---------------------------------------------------------------------------
// Mock useFeatureAvailability so tests control grant state without a server
// ---------------------------------------------------------------------------

vi.mock("@/hooks/useFeatureAvailability", () => ({
  useFeatureAvailability: vi.fn(),
  READINESS_QUERY_KEY: ["setup-readiness"],
}));

import { useFeatureAvailability } from "@/hooks/useFeatureAvailability";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTableGranted(overrides: Record<string, boolean | undefined> = {}) {
  return (table: string) => overrides[table];
}

function renderView(tableOverrides: Record<string, boolean | undefined> = {}) {
  vi.mocked(useFeatureAvailability).mockReturnValue({
    warehouseGranted: true,
    tableGranted: makeTableGranted(tableOverrides),
    isLoaded: true,
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlatformKPIsView
        data={undefined}
        isLoading={false}
        spendAnomalies={undefined}
        anomaliesLoading={false}
      />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Core invariant: denied → "—" (Unavailable), not 0
// ---------------------------------------------------------------------------

describe("PlatformKPIsView — denied dependency renders unavailable, not 0", () => {
  beforeEach(() => {
    vi.mocked(useFeatureAvailability).mockReset();
  });

  it("shows unavailable state for query.history KPIs when grant is false", () => {
    renderView({ "system.query.history": false });

    // All query.history-dependent KPI cards must show the unavailable text
    const unavailableEls = screen.getAllByText(/Unavailable/i);
    expect(unavailableEls.length).toBeGreaterThan(0);

    // The reason text must be present (grant hint)
    expect(screen.getAllByText(/query\.history grant required/i).length).toBeGreaterThan(0);
  });

  it("does NOT show 0 for query.history KPIs when grant is false", () => {
    renderView({ "system.query.history": false });

    // The KPI value "0" must not appear as a standalone text node in unavailable cards
    const cards = screen.getAllByTitle(/query\.history grant required/i);
    cards.forEach(card => {
      // The card's value cell should show "—" not "0"
      expect(card).not.toHaveTextContent(/^\s*0\s*$/);
    });
  });

  it("shows unavailable state for lakeflow KPIs when grant is false", () => {
    renderView({ "system.lakeflow.pipelines": false });

    expect(screen.getAllByText(/lakeflow grants required/i).length).toBeGreaterThan(0);
  });

  it("shows unavailable state for compute.clusters KPI when grant is false", () => {
    renderView({ "system.compute.clusters": false });

    expect(screen.getAllByText(/compute\.clusters grant required/i).length).toBeGreaterThan(0);
  });

  it("shows unavailable state for serving.served_entities KPI when grant is false", () => {
    renderView({ "system.serving.served_entities": false });

    expect(screen.getAllByText(/serving\.served_entities grant required/i).length).toBeGreaterThan(0);
  });

  it("does NOT show unavailable state when grant is undefined (unknown)", () => {
    // undefined = not yet loaded — must NOT block rendering
    renderView({ "system.query.history": undefined });

    const unavailableEls = screen.queryAllByText(/query\.history grant required/i);
    expect(unavailableEls).toHaveLength(0);
  });

  it("does NOT show unavailable state when grant is true", () => {
    renderView({
      "system.query.history": true,
      "system.lakeflow.pipelines": true,
      "system.compute.clusters": true,
      "system.serving.served_entities": true,
    });

    expect(screen.queryAllByText(/grant required/i)).toHaveLength(0);
    expect(screen.queryAllByText(/Unavailable/i)).toHaveLength(0);
  });
});
