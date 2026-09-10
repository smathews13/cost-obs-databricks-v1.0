import { afterEach, describe, expect, it } from "vitest";
import {
  buildSettingsUpdate,
  hydrateSettingsFromServer,
  loadAppSettings,
  loadTabVisibility,
  mergeUnifiedSettings,
  persistAppSettings,
  persistTabVisibility,
} from "../settingsHydration";

afterEach(() => {
  localStorage.clear();
});

describe("settings hydration", () => {
  it("maps the complete unified server snapshot into dashboard settings", () => {
    const currentSettings = loadAppSettings();
    const currentVisibility = loadTabVisibility();
    const hydrated = hydrateSettingsFromServer({
      general: {
        company_name: "Acme",
        app_display_name: "FinOps",
        default_date_range_days: 60,
        default_landing_tab: "infra",
        auto_refresh_minutes: 15,
        density: "compact",
        theme: "dark",
        show_workspace_names: false,
        anonymize_users: true,
      },
      thresholds: {
        spike_threshold_percent: 33,
        daily_budget: 1234,
        workspace_budget: 456,
        anomaly_sensitivity: "high",
      },
      experimental: {
        exp_setup_wizard_link: true,
        exp_debugger_link: true,
        enable_architecture_view: true,
        enable_mv_share_runbook: false,
      },
      tab_visibility: {
        dbu: false,
        infra: true,
        optimizer: false,
      },
    }, currentSettings, currentVisibility);

    expect(hydrated.appSettings).toMatchObject({
      companyName: "Acme",
      appDisplayName: "FinOps",
      defaultDateRangeDays: 60,
      defaultLandingTab: "infra",
      refreshIntervalMinutes: 15,
      density: "compact",
      compactMode: true,
      theme: "dark",
      darkMode: true,
      showWorkspaceNames: false,
      anonymizeUsers: true,
      alertSpikePercent: 33,
      alertDailyBudget: 1234,
      alertWorkspaceBudget: 456,
      anomalySensitivity: "high",
      expSetupWizardLink: true,
      expDebuggerLink: true,
      enableArchitectureView: true,
      enableMvShareRunbook: false,
    });
    expect(hydrated.tabVisibility).toMatchObject({
      dbu: false,
      infra: true,
      optimizer: false,
    });
  });

  it("persists hydrated settings and visibility through the shared storage helpers", () => {
    const hydrated = hydrateSettingsFromServer({
      general: {
        default_date_range_days: 14,
        theme: "system",
        anonymize_users: true,
      },
      tab_visibility: { aiml: false, tagging: false },
    }, loadAppSettings(), loadTabVisibility());

    persistAppSettings(hydrated.appSettings);
    persistTabVisibility(hydrated.tabVisibility);

    expect(loadAppSettings()).toMatchObject({
      defaultDateRangeDays: 14,
      theme: "system",
      anonymizeUsers: true,
    });
    expect(loadTabVisibility()).toMatchObject({ aiml: false, tagging: false });
  });

  it("ignores malformed server values instead of clobbering valid local values", () => {
    const currentSettings = {
      ...loadAppSettings(),
      defaultDateRangeDays: 90 as const,
      theme: "system" as const,
      anomalySensitivity: "low" as const,
    };
    const hydrated = hydrateSettingsFromServer({
      general: {
        default_date_range_days: 365,
        theme: "neon",
      },
      thresholds: { anomaly_sensitivity: "extreme" },
      tab_visibility: { dbu: "no", sql: false },
    }, currentSettings, loadTabVisibility());

    expect(hydrated.appSettings.defaultDateRangeDays).toBe(90);
    expect(hydrated.appSettings.theme).toBe("system");
    expect(hydrated.appSettings.anomalySensitivity).toBe("low");
    expect(hydrated.tabVisibility.dbu).toBe(true);
    expect(hydrated.tabVisibility.sql).toBe(false);
  });

  it("builds a field-level update and counts exact changed settings", () => {
    const baselineSettings = loadAppSettings();
    const baselineVisibility = loadTabVisibility();
    const currentSettings = {
      ...baselineSettings,
      companyName: "Acme",
      alertDailyBudget: 25000,
      expDebuggerLink: true,
    };
    const currentVisibility = { ...baselineVisibility, infra: false, optimizer: false };

    expect(buildSettingsUpdate(
      currentSettings,
      baselineSettings,
      currentVisibility,
      baselineVisibility,
    )).toEqual({
      payload: {
        general: { company_name: "Acme" },
        thresholds: { daily_budget: 25000 },
        experimental: { exp_debugger_link: true },
        tab_visibility: { infra: false, optimizer: false },
      },
      updatedCount: 5,
    });
  });

  it("sends only app settings for a tab-only change", () => {
    const settings = loadAppSettings();
    const baselineVisibility = loadTabVisibility();
    const update = buildSettingsUpdate(
      settings,
      settings,
      { ...baselineVisibility, infra: false },
      baselineVisibility,
    );

    expect(update).toEqual({
      payload: { tab_visibility: { infra: false } },
      updatedCount: 1,
    });
    expect(update.payload).not.toHaveProperty("general");
    expect(update.payload).not.toHaveProperty("thresholds");
  });

  it("includes an explicitly cleared webhook and merges partial cache updates", () => {
    const baselineSettings = { ...loadAppSettings(), slackWebhookUrl: "https://hooks.slack.com/services/secret" };
    const update = buildSettingsUpdate(
      { ...baselineSettings, slackWebhookUrl: "" },
      baselineSettings,
      loadTabVisibility(),
      loadTabVisibility(),
    );

    expect(update).toEqual({
      payload: { webhook: { slack_webhook_url: "" } },
      updatedCount: 1,
    });
    expect(mergeUnifiedSettings({
      general: { company_name: "Old" },
      tab_visibility: { dbu: true, infra: true },
      webhook: { configured: true, masked_url: "****" },
    }, {
      general: { company_name: "New" },
      tab_visibility: { infra: false },
      webhook: { slack_webhook_url: "" },
    })).toMatchObject({
      general: { company_name: "New" },
      tab_visibility: { dbu: true, infra: false },
      webhook: { configured: false, masked_url: null },
    });
  });

  it("never persists or revives a Slack webhook secret in browser storage", () => {
    localStorage.setItem("coc-app-settings", JSON.stringify({
      slackWebhookUrl: "https://hooks.slack.com/services/legacy-secret",
      companyName: "Acme",
    }));
    expect(loadAppSettings().slackWebhookUrl).toBe("");

    persistAppSettings({
      ...loadAppSettings(),
      slackWebhookUrl: "https://hooks.slack.com/services/new-secret",
    });
    const raw = localStorage.getItem("coc-app-settings") ?? "";
    expect(raw).not.toContain("hooks.slack.com");
    expect(JSON.parse(raw)).not.toHaveProperty("slackWebhookUrl");
  });
});
