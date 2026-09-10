import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { loadAppSettings, loadTabVisibility } from "@/utils/settingsHydration";
import { SettingsDialog } from "../SettingsDialog";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("starts settings queries only after the dialog opens and deduplicates config", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    onClose: vi.fn(),
    onTabVisibilityChange: vi.fn(),
    onSettingsChange: vi.fn(),
    tabVisibility: loadTabVisibility(),
    appSettings: loadAppSettings(),
  };
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsDialog {...props} isOpen={false} />
    </QueryClientProvider>,
  );

  expect(fetchMock).not.toHaveBeenCalled();
  view.rerender(
    <QueryClientProvider client={client}>
      <SettingsDialog {...props} isOpen />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const urls = fetchMock.mock.calls.map(([input]) => String(input));
  expect(urls).toContain("/api/settings/warehouses");
  expect(urls).toContain("/api/settings/cloud-connections");
  expect(urls).toContain("/api/setup/workspace-filter");
  expect(urls.filter((url) => url === "/api/settings/config")).toHaveLength(1);
});

it("renders every settings tab immediately while role verification loads", () => {
  const never = new Promise<Response>(() => {});
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/settings/user-permissions") return never;
    return Promise.resolve(Response.json({}));
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  for (const label of [
    "General",
    "Data & tables",
    "Identity & Permissions",
    "Alerts & notifications",
    "Resources",
    "Experimental",
  ]) {
    expect(screen.getByRole("button", { name: label })).toBeVisible();
  }
});

it("animates the save spinner while respecting reduced motion", () => {
  const css = readFileSync("src/components/settings/settings.css", "utf8");
  expect(css).toMatch(/\.settings-save-spinner\s*\{[^}]*animation:\s*settings-save-spin/s);
  expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.settings-save-spinner\s*\{[^}]*animation:\s*none/s);
});

it("places Data & tables above Identity & Permissions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ current_role: "admin" }),
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  const accessTab = await screen.findByRole("button", { name: "Identity & Permissions" });
  expect(accessTab).toHaveStyle({ whiteSpace: "nowrap" });
  expect(accessTab.parentElement?.parentElement).toHaveStyle({ width: "232px" });
  for (const label of [
    "General",
    "Data & tables",
    "Identity & Permissions",
    "Alerts & notifications",
    "Resources",
    "Experimental",
  ]) {
    expect(screen.getByRole("button", { name: label }).querySelector("svg")).toBeInTheDocument();
  }
  const navButtons = ["General", "Data & tables", "Identity & Permissions"].map(
    (label) => screen.getByRole("button", { name: label }),
  );
  expect(navButtons[0].compareDocumentPosition(navButtons[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(navButtons[1].compareDocumentPosition(navButtons[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(accessTab);
  expect(screen.getByRole("heading", { name: "Identity & Permissions" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Access" })).not.toBeInTheDocument();
});

it("explains query-cache clearing and reports completion under Data & tables", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/cache/clear") && init?.method === "POST") {
      return Response.json({ status: "ok", cleared: 7 });
    }
    return Response.json({ current_role: "admin" });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Data & tables" }));
  expect(screen.getByText(/does not delete managed tables, settings, or source configuration/i)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Clear query cache" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Cache cleared successfully. 7 in-memory entries removed",
  );
});

it("discards saved settings for the removed Use Cases feature", () => {
  localStorage.setItem("coc-tab-visibility", JSON.stringify({ "use-cases": true }));
  localStorage.setItem("coc-app-settings", JSON.stringify({
    enableUseCaseTracking: true,
    enableAppHostingComparison: true,
    enableAccuracyChecks: true,
  }));

  expect(loadTabVisibility()).not.toHaveProperty("use-cases");
  expect(loadAppSettings()).not.toHaveProperty("enableUseCaseTracking");
  expect(loadAppSettings()).not.toHaveProperty("enableAppHostingComparison");
  expect(loadAppSettings()).not.toHaveProperty("enableAccuracyChecks");
});

it("saves successfully and stays on the same open section", async () => {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }));

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={onClose}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Cloud Costs" }));
  expect(screen.getByText("1 unsaved setting")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(screen.getByText("Settings saved")).toBeVisible());
  expect(screen.getByText("1 setting updated")).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
  expect(screen.getByText("Dashboard tab visibility")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Cloud Costs" })).toHaveAttribute("aria-checked", "false");
  client.setQueryData(["unified-settings"], { tab_visibility: { infra: true } });
  await waitFor(() => expect(screen.getByText("1 setting updated")).toBeVisible());
  expect(screen.getByRole("switch", { name: "Cloud Costs" })).toHaveAttribute("aria-checked", "false");

  await userEvent.click(screen.getByRole("switch", { name: "Optimize" }));
  expect(screen.queryByText("1 setting updated")).not.toBeInTheDocument();
  expect(screen.getByText("1 unsaved setting")).toBeVisible();
});

it("renders, toggles, saves, and reloads user anonymization", async () => {
  let serverValue = false;
  const putBodies: Array<{ general: { anonymize_users: boolean } }> = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/settings") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      putBodies.push(body);
      serverValue = body.general.anonymize_users;
      return { ok: true, json: async () => ({}) };
    }
    if (url.endsWith("/api/settings")) {
      return { ok: true, json: async () => ({ general: { anonymize_users: serverValue } }) };
    }
    return { ok: true, json: async () => ({ current_role: "admin" }) };
  }));

  const renderDialog = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <SettingsDialog
          isOpen
          onClose={vi.fn()}
          onTabVisibilityChange={vi.fn()}
          onSettingsChange={vi.fn()}
          tabVisibility={loadTabVisibility()}
          appSettings={loadAppSettings()}
        />
      </QueryClientProvider>,
    );
  };

  const first = renderDialog();
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  expect(screen.getByText(/Replace human email addresses with User 1/)).toBeInTheDocument();
  expect(screen.queryByText("Preview")).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Materialized view share runbook" }))
    .toHaveAttribute("aria-checked", "true");
  const toggle = screen.getByRole("switch", { name: "User anonymization" });
  expect(toggle).toHaveAttribute("aria-checked", "false");

  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(putBodies.at(-1)?.general.anonymize_users).toBe(true));
  expect(loadAppSettings().anonymizeUsers).toBe(true);

  first.unmount();
  renderDialog();
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "User anonymization" })).toHaveAttribute("aria-checked", "true"));
});

it("defaults, saves, reloads, and resets the architecture view setting", async () => {
  expect(loadAppSettings().enableArchitectureView).toBe(true);
  let serverValue = true;
  const putBodies: Array<{ experimental: { enable_architecture_view: boolean } }> = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/settings") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      putBodies.push(body);
      serverValue = body.experimental.enable_architecture_view;
      return { ok: true, status: 200, json: async () => ({ experimental: { enable_architecture_view: serverValue } }) };
    }
    if (url.endsWith("/api/settings")) {
      return { ok: true, status: 200, json: async () => ({ experimental: { enable_architecture_view: serverValue } }) };
    }
    return { ok: true, status: 200, json: async () => ({ current_role: "admin" }) };
  }));

  const renderDialog = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <SettingsDialog
          isOpen
          onClose={vi.fn()}
          onTabVisibilityChange={vi.fn()}
          onSettingsChange={vi.fn()}
          tabVisibility={loadTabVisibility()}
          appSettings={loadAppSettings()}
        />
      </QueryClientProvider>,
    );
  };

  const first = renderDialog();
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  expect(screen.getByText("Unlock architecture PDF export from the existing Export dialog.")).toBeVisible();
  const toggle = screen.getByRole("switch", { name: "Architecture view" });
  expect(toggle).toHaveAttribute("aria-checked", "true");
  await userEvent.click(toggle);
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(putBodies.at(-1)?.experimental.enable_architecture_view).toBe(false));
  expect(loadAppSettings().enableArchitectureView).toBe(false);

  first.unmount();
  localStorage.clear();
  renderDialog();
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Architecture view" })).toHaveAttribute("aria-checked", "false"));

  await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
  await waitFor(() => expect(putBodies.at(-1)?.experimental.enable_architecture_view).toBe(true));
  expect(loadAppSettings().enableArchitectureView).toBe(true);
});

it("defaults the MV share runbook on and persists an administrator opt-out", async () => {
  expect(loadAppSettings().enableMvShareRunbook).toBe(true);
  let serverValue = true;
  const putBodies: Array<{ experimental: { enable_mv_share_runbook: boolean } }> = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/settings") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      putBodies.push(body);
      serverValue = body.experimental.enable_mv_share_runbook;
      return { ok: true, status: 200, json: async () => ({ updated_count: 1 }) };
    }
    if (url.endsWith("/api/settings")) {
      return { ok: true, status: 200, json: async () => ({ experimental: { enable_mv_share_runbook: serverValue } }) };
    }
    return { ok: true, status: 200, json: async () => ({ current_role: "admin" }) };
  }));

  const renderDialog = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <SettingsDialog
          isOpen
          onClose={vi.fn()}
          onTabVisibilityChange={vi.fn()}
          onSettingsChange={vi.fn()}
          tabVisibility={loadTabVisibility()}
          appSettings={loadAppSettings()}
        />
      </QueryClientProvider>,
    );
  };

  const first = renderDialog();
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  const toggle = screen.getByRole("switch", { name: "Materialized view share runbook" });
  expect(toggle).toHaveAttribute("aria-checked", "true");
  await userEvent.click(toggle);
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(putBodies.at(-1)?.experimental.enable_mv_share_runbook).toBe(false));
  expect(loadAppSettings().enableMvShareRunbook).toBe(false);

  first.unmount();
  localStorage.clear();
  renderDialog();
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Materialized view share runbook" }))
    .toHaveAttribute("aria-checked", "false"));
});

it("persists the default when user anonymization is reset", async () => {
  const saved = loadAppSettings();
  saved.anonymizeUsers = true;
  const putBodies: Array<{ general: { anonymize_users: boolean } }> = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings") && init?.method === "PUT") {
      putBodies.push(JSON.parse(String(init.body)));
    }
    return { ok: true, json: async () => ({}) };
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={saved}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
  await waitFor(() => expect(putBodies.at(-1)?.general.anonymize_users).toBe(false));
  expect(loadAppSettings().anonymizeUsers).toBe(false);
});

it("retains the draft and dirty state when Save fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings") && init?.method === "PUT") {
      return { ok: false, status: 500, json: async () => ({ detail: "storage unavailable" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await userEvent.type(input, "Acme");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(screen.getByText("Settings were not saved: storage unavailable")).toBeVisible());
  expect(input).toHaveValue("Acme");
  expect(screen.getByRole("alert")).toHaveTextContent("Save failed · 1 unsaved setting");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(loadAppSettings().companyName).toBe("");
});

it("does not overwrite an active local draft when server settings refresh", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await userEvent.type(input, "Local draft");
  client.setQueryData(["unified-settings"], {
    general: { company_name: "Server value", theme: "dark" },
    tab_visibility: { infra: false },
  });

  await waitFor(() => expect(input).toHaveValue("Local draft"));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

it("prevents double submission while a save is in flight", async () => {
  let resolvePut: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
  let putCount = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings") && init?.method === "PUT") {
      putCount += 1;
      return new Promise((resolve) => { resolvePut = resolve; });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ current_role: "admin" }),
    });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  await userEvent.type(screen.getByPlaceholderText("e.g. Acme Corp"), "Acme");
  const save = screen.getByRole("button", { name: "Save changes" });
  fireEvent.click(save);
  fireEvent.click(save);

  expect(putCount).toBe(1);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  const savingStatus = screen.getByRole("status");
  expect(savingStatus).toHaveTextContent("Saving 1 setting…");
  expect(savingStatus.querySelector(".settings-save-spinner")).toBeInTheDocument();
  resolvePut?.({ ok: true, status: 200, json: async () => ({}) });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled());
});

it("uses the shared dirty and save status for Experimental draft controls", async () => {
  let resolvePut: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
  const putBodies: Array<{
    general: { anonymize_users: boolean };
    experimental: { enable_architecture_view: boolean };
  }> = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings") && init?.method === "PUT") {
      putBodies.push(JSON.parse(String(init.body)));
      return new Promise((resolve) => { resolvePut = resolve; });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ current_role: "admin" }),
    });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  await userEvent.click(screen.getByRole("switch", { name: "User anonymization" }));
  await userEvent.click(screen.getByRole("switch", { name: "Architecture view" }));
  expect(screen.getByRole("status")).toHaveTextContent("2 unsaved settings");

  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("status")).toHaveTextContent("Saving 2 settings…");
  expect(putBodies[0].experimental).toMatchObject({
    enable_architecture_view: false,
  });
  expect(putBodies[0].general).toMatchObject({ anonymize_users: true });

  resolvePut?.({ ok: true, status: 200, json: async () => ({ updated_count: 2 }) });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 settings updated"));
});

it("persists all toggles from the first Save click", async () => {
  const putBodies: Array<{
    general: { anonymize_users: boolean };
    tab_visibility: { infra: boolean; optimizer: boolean };
  }> = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings") && init?.method === "PUT") {
      putBodies.push(JSON.parse(String(init.body)));
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ current_role: "admin" }),
    };
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Cloud Costs" }));
  await userEvent.click(screen.getByRole("switch", { name: "Optimize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Experimental" }));
  await userEvent.click(screen.getByRole("switch", { name: "User anonymization" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(putBodies).toHaveLength(1));
  expect(putBodies[0].tab_visibility.infra).toBe(false);
  expect(putBodies[0].tab_visibility.optimizer).toBe(false);
  expect(putBodies[0].general.anonymize_users).toBe(true);
});

it("clears a saved webhook draft without writing the secret to localStorage", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings") && init?.method === "PUT") {
      return { ok: true, status: 200, json: async () => ({ updated_count: 1 }) };
    }
    if (String(input).endsWith("/api/settings")) {
      return { ok: true, status: 200, json: async () => ({ webhook: { configured: false } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ current_role: "admin" }),
    };
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        isOpen
        onClose={vi.fn()}
        onTabVisibilityChange={vi.fn()}
        onSettingsChange={vi.fn()}
        tabVisibility={loadTabVisibility()}
        appSettings={loadAppSettings()}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Alerts & notifications" }));
  const webhook = screen.getByPlaceholderText(/hooks\.slack\.com\/services/);
  await userEvent.type(webhook, "https://hooks.slack.com/services/top-secret");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(webhook).toHaveValue(""));
  expect(localStorage.getItem("coc-app-settings") ?? "").not.toContain("top-secret");
});

it("implements modal semantics, focus trapping, Escape, outside close, and focus restore", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open settings</button>
        <QueryClientProvider client={client}>
          <SettingsDialog
            isOpen={open}
            onClose={() => setOpen(false)}
            onTabVisibilityChange={vi.fn()}
            onSettingsChange={vi.fn()}
            tabVisibility={loadTabVisibility()}
            appSettings={loadAppSettings()}
          />
        </QueryClientProvider>
      </>
    );
  }

  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Open settings" });
  await userEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  const close = screen.getByRole("button", { name: "Close settings" });
  expect(close).toHaveClass("settings-icon-button");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("settings-secondary-action");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("settings-primary-action");
  expect(screen.getByRole("button", { name: "Reset to defaults" })).toHaveClass("settings-reset-button");
  const settingsCss = readFileSync("src/components/settings/settings.css", "utf8");
  expect(settingsCss).toMatch(/\.settings-icon-button:hover/);
  expect(settingsCss).toMatch(/\.settings-primary-action:hover:not\(:disabled\)/);
  expect(settingsCss).toMatch(/\.settings-icon-button:focus-visible[\s\S]*outline:\s*2px solid/);
  await waitFor(() => expect(close).toHaveFocus());

  await userEvent.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());

  await userEvent.click(trigger);
  const reopened = screen.getByRole("dialog", { name: "Settings" });
  fireEvent.click(reopened.parentElement!);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});
