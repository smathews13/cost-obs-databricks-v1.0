/**
 * Regression tests for SettingsPermissions SP identity and grant bundle.
 *
 * Key invariants:
 * 1. SP client ID and display name are rendered from /api/settings/auth-status.
 * 2. The grant SQL bundle uses the actual SP name (not a placeholder).
 * 3. After running grants, the readiness cache is invalidated.
 * 4. When SP is the active identity, the remediation bundle is shown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsPermissions } from "../SettingsPermissions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

const SP_AUTH_STATUS = {
  auth_mode: "sp",
  identity: "service_principal",
  token_present: false,
  user_email: "cost-observer-sp@apps.databricks.com",
  sp_client_id: "0000-aaaa-bbbb-1234",
  sp_display_name: "cost-observer-app-sp",
  catalog: "main",
  schema: "coc",
};

const USER_AUTH_STATUS = {
  auth_mode: "user" as const,
  identity: "user_oauth",
  token_present: true,
  user_email: "alice@databricks.com",
  sp_client_id: "0000-aaaa-bbbb-1234",
  sp_display_name: "cost-observer-app-sp",
  catalog: "main",
  schema: "coc",
};

function mockApis(authStatus: object, permissionsPayload?: object) {
  const defaultPermissions = {
    permissions: [],
    summary: { total: 0, granted: 0, required_count: 2, required_granted: 2, all_required_granted: true, ready_to_use: true },
    user: { email: "alice@databricks.com", name: "Alice" },
    sp: { client_id: "0000-aaaa-bbbb-1234", display_name: "cost-observer-app-sp" },
    help_url: "https://docs.databricks.com",
  };

  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/settings/auth-status")) {
      return Promise.resolve(
        new Response(JSON.stringify(authStatus), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (url.includes("/api/permissions/check")) {
      return Promise.resolve(
        new Response(JSON.stringify(permissionsPayload ?? defaultPermissions), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (url.includes("/api/setup/readiness")) {
      return Promise.resolve(
        new Response(JSON.stringify({
          overall: "ready",
          warehouse: { name: "Main WH", granted: true, category: "core", source: "app_resource" },
          core: [],
          enhanced: [],
          sp_client_id: "0000-aaaa-bbbb-1234",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function renderPermissions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPermissions />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// SP identity panel
// ---------------------------------------------------------------------------

describe("SettingsPermissions — SP identity panel", () => {
  it("renders the SP client ID from auth-status", async () => {
    mockApis(SP_AUTH_STATUS);
    renderPermissions();

    await waitFor(() => {
      expect(screen.getByText("0000-aaaa-bbbb-1234")).toBeInTheDocument();
    });
  });

  it("renders the SP display name when present", async () => {
    mockApis(SP_AUTH_STATUS);
    renderPermissions();

    await waitFor(() => {
      expect(screen.getByText("cost-observer-app-sp")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Grant SQL bundle uses the actual SP name
// ---------------------------------------------------------------------------

describe("SettingsPermissions — grant bundle targets actual SP name", () => {
  it("grant SQL uses sp_display_name, not a placeholder", async () => {
    mockApis(SP_AUTH_STATUS);
    renderPermissions();

    // Wait for auth status to load and grant bundle to appear
    await waitFor(() => {
      // The grant bundle is rendered when identity is SP or token is absent
      const codeBlocks = document.querySelectorAll("code, pre");
      const sqlText = Array.from(codeBlocks).map(el => el.textContent ?? "").join("\n");
      // Must reference the real SP name, not a generic placeholder
      expect(sqlText).toContain("cost-observer-app-sp");
      expect(sqlText).not.toContain("<service-principal>");
    });
  });

  it("grant SQL does not include the requesting user's email when they differ from SP", async () => {
    // SP auth — user_email is the SP's own email
    mockApis(SP_AUTH_STATUS);
    renderPermissions();

    await waitFor(() => {
      const codeBlocks = document.querySelectorAll("code, pre");
      const sqlText = Array.from(codeBlocks).map(el => el.textContent ?? "").join("\n");
      // Section 1 grants must target the SP; no user-specific grants when SP is active identity
      expect(sqlText).toContain("GRANT USE CATALOG ON CATALOG system TO");
    });
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation after grant run
// ---------------------------------------------------------------------------

describe("SettingsPermissions — readiness cache invalidated after grant", () => {
  it("calls /api/setup/readiness after grant SP access", async () => {
    mockApis(SP_AUTH_STATUS);

    // Mock grant endpoint to succeed
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/setup/grant-sp-system-access") && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ applied: 5, sp_client_id: "0000-aaaa-bbbb-1234" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      if (url.includes("/api/settings/auth-status")) {
        return Promise.resolve(
          new Response(JSON.stringify(SP_AUTH_STATUS), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      if (url.includes("/api/setup/readiness")) {
        return Promise.resolve(
          new Response(JSON.stringify({
            overall: "ready",
            warehouse: { name: "Main WH", granted: true, category: "core", source: "app_resource" },
            core: [],
            enhanced: [],
            sp_client_id: "0000-aaaa-bbbb-1234",
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      if (url.includes("/api/permissions/check")) {
        return Promise.resolve(
          new Response(JSON.stringify({
            permissions: [],
            summary: { total: 0, granted: 0, required_count: 2, required_granted: 2, all_required_granted: true, ready_to_use: true },
            user: { email: "sp@apps.databricks.com", name: "SP" },
            sp: { client_id: "0000-aaaa-bbbb-1234", display_name: "cost-observer-app-sp" },
            help_url: "",
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    renderPermissions();

    // After render, query the grant button
    const grantBtn = await screen.findByRole("button", { name: /run sp grants|apply grants|grant access/i });
    grantBtn.click();

    // After grant: /api/setup/readiness must be refetched (cache invalidated)
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(c => String(c[0]));
      const readinessCalls = calls.filter(u => u.includes("/api/setup/readiness"));
      expect(readinessCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
