import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsDebugger } from "../SettingsDebugger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// Typed fetch mock so TypeScript is happy
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// Auth mode sourcing
// ---------------------------------------------------------------------------

describe("SettingsDebugger — auth mode sourcing", () => {
  it("shows the auth_mode from /api/settings/auth-status, not a hardcoded default", async () => {
    // /api/settings/config returns a payload WITHOUT auth_mode
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/settings/config")) {
        return Promise.resolve(new Response(JSON.stringify({
          version: { commit_sha: "abc1234" },
          warehouse: { id: "wh-1", source: "app_resource" },
          storage_location: { catalog: "main", schema: "coc" },
          // no auth_mode field
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.includes("/api/settings/auth-status")) {
        return Promise.resolve(new Response(JSON.stringify({
          auth_mode: "user",
          identity: "user_oauth",
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      // /api/debug/run — never called since user hasn't clicked "Run Diagnostics"
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    renderWithQuery(<SettingsDebugger />);

    // Deployment Info section appears once config loads
    await waitFor(() => {
      expect(screen.getByText("Auth mode")).toBeInTheDocument();
    });

    // Must show the real value from auth-status, not "service_principal"
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.queryByText("service_principal")).not.toBeInTheDocument();
  });

  it("shows '—' when /api/settings/auth-status is unavailable", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/settings/config")) {
        return Promise.resolve(new Response(JSON.stringify({
          version: { commit_sha: "abc1234" },
          warehouse: { id: "wh-1", source: "http_path" },
          storage_location: { catalog: "main", schema: "coc" },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.includes("/api/settings/auth-status")) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    renderWithQuery(<SettingsDebugger />);

    await waitFor(() => {
      expect(screen.getByText("Auth mode")).toBeInTheDocument();
    });

    // Falls back to "—" rather than a stale hardcoded value
    await waitFor(() => {
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });
});
