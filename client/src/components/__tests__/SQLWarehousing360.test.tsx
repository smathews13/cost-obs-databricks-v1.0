/**
 * Regression tests for SQLWarehousing360 summary display states.
 *
 * Key invariants:
 * 1. available=false → dependency-blocked amber panel, not fake zeros.
 * 2. available=true + summary=null → "No summary data returned" gray panel.
 * 3. available=true + all-zero summary → $0 rendered (valid zero activity), not "—".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SQLWarehousing360 } from "../SQLWarehousing360";
import type { DBSQLDashboardBundle } from "@/types/billing";

// ---------------------------------------------------------------------------
// Mock useFeatureAvailability — tests control grant state without a server
// ---------------------------------------------------------------------------

vi.mock("@/hooks/useFeatureAvailability", () => ({
  useFeatureAvailability: vi.fn(),
  READINESS_QUERY_KEY: ["setup-readiness"],
}));

import { useFeatureAvailability } from "@/hooks/useFeatureAvailability";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Default: all grants unknown — never blocks rendering
  vi.mocked(useFeatureAvailability).mockReturnValue({
    warehouseGranted: undefined,
    tableGranted: () => undefined,
    isLoaded: true,
  });
  // Stub warehouse-health and any prefetch calls
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ available: false, recommendations: [], warehouses_analyzed: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

function renderSQLView(queryData: DBSQLDashboardBundle | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SQLWarehousing360
        sqlBreakdownData={undefined}
        queryData={queryData}
        isLoading={false}
      />
    </QueryClientProvider>
  );
}

const BASE_BUNDLE_AVAILABLE: DBSQLDashboardBundle = {
  available: true,
  start_date: "2026-01-01",
  end_date: "2026-01-31",
};

// ---------------------------------------------------------------------------
// available=false: dependency-blocked state
// ---------------------------------------------------------------------------

describe("SQLWarehousing360 — available=false renders dependency-blocked panel", () => {
  it("shows 'Query-level Cost Attribution Not Available' heading", () => {
    renderSQLView({ available: false, start_date: "2026-01-01", end_date: "2026-01-31" });

    expect(
      screen.getByText(/query-level cost attribution not available/i)
    ).toBeInTheDocument();
  });

  it("does NOT show the KPI summary cards", () => {
    renderSQLView({ available: false, start_date: "2026-01-01", end_date: "2026-01-31" });

    expect(screen.queryByText(/total query spend/i)).not.toBeInTheDocument();
  });

  it("shows the 'Create Materialized Views' setup button", () => {
    renderSQLView({ available: false, start_date: "2026-01-01", end_date: "2026-01-31" });

    expect(
      screen.getByRole("button", { name: /create materialized views/i })
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// available=true + summary=null: internal error / no data returned
// ---------------------------------------------------------------------------

describe("SQLWarehousing360 — available=true but summary null renders unavailable banner", () => {
  it("shows 'Query summary unavailable' when summary is absent", () => {
    renderSQLView({ ...BASE_BUNDLE_AVAILABLE, summary: undefined });

    expect(screen.getByText(/query summary unavailable/i)).toBeInTheDocument();
  });

  it("shows 'No summary data returned' as the reason", () => {
    renderSQLView({ ...BASE_BUNDLE_AVAILABLE, summary: undefined });

    expect(screen.getByText(/no summary data returned/i)).toBeInTheDocument();
  });

  it("does NOT show currency values (no fake zeros)", () => {
    renderSQLView({ ...BASE_BUNDLE_AVAILABLE, summary: undefined });

    // KPI card headings must not appear when summary is absent
    expect(screen.queryByText(/total query spend/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// available=true + all-zero summary: valid zero activity → $0, not "—"
// ---------------------------------------------------------------------------

describe("SQLWarehousing360 — available=true with zero-value summary renders $0", () => {
  const zeroSummary: DBSQLDashboardBundle = {
    ...BASE_BUNDLE_AVAILABLE,
    summary: {
      available: true,
      total_spend: 0,
      total_dbus: 0,
      total_queries: 0,
      unique_users: 0,
      unique_warehouses: 0,
      avg_cost_per_query: 0,
      avg_duration_seconds: 0,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
    },
  };

  it("renders the 'Total Query Spend' KPI card", () => {
    renderSQLView(zeroSummary);

    expect(screen.getByText(/total query spend/i)).toBeInTheDocument();
  });

  it("shows a currency value ($0) rather than '—' for zero spend", () => {
    renderSQLView(zeroSummary);

    // formatCurrency(0) → "$0" — valid zero activity, not a missing-data dash
    const spendValues = screen.getAllByText(/^\$0/);
    expect(spendValues.length).toBeGreaterThan(0);
  });

  it("does NOT show 'Query summary unavailable' for a zero-value summary", () => {
    renderSQLView(zeroSummary);

    expect(screen.queryByText(/query summary unavailable/i)).not.toBeInTheDocument();
  });

  it("does NOT show 'Query-level Cost Attribution Not Available'", () => {
    renderSQLView(zeroSummary);

    expect(
      screen.queryByText(/query-level cost attribution not available/i)
    ).not.toBeInTheDocument();
  });
});
