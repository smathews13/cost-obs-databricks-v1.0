export interface TabVisibility {
  dbu: boolean;
  infra: boolean;
  optimizer: boolean;
  kpis: boolean;
  aiml: boolean;
  sql: boolean;
  apps: boolean;
  tagging: boolean;
  "users-groups": boolean;
}

export interface AppSettings {
  defaultDateRangeDays: 7 | 14 | 30 | 60 | 90;
  refreshIntervalMinutes: 0 | 5 | 15 | 30;
  compactMode: boolean;
  darkMode: boolean;
  density: "comfortable" | "compact";
  theme: "light" | "dark" | "system";
  defaultLandingTab: string;
  showWorkspaceNames: boolean;
  anomalySensitivity: "low" | "medium" | "high";
  expSetupWizardLink: boolean;
  expDebuggerLink: boolean;
  enableArchitectureView: boolean;
  enableMvShareRunbook: boolean;
  companyName: string;
  appDisplayName: string;
  monthlyBudget: number;
  costAllocationTags: string;
  alertSpikePercent: number;
  alertDailyBudget: number;
  alertWorkspaceBudget: number;
  slackWebhookUrl: string;
  anonymizeUsers: boolean;
}

export interface UnifiedSettings {
  general?: Record<string, unknown>;
  tab_visibility?: Partial<Record<keyof TabVisibility | string, unknown>>;
  thresholds?: {
    spike_threshold_percent?: unknown;
    daily_budget?: unknown;
    workspace_budget?: unknown;
    anomaly_sensitivity?: unknown;
  };
  experimental?: {
    exp_setup_wizard_link?: unknown;
    exp_debugger_link?: unknown;
    enable_architecture_view?: unknown;
    enable_mv_share_runbook?: unknown;
  };
  webhook?: {
    configured?: boolean;
    masked_url?: string | null;
  };
  capabilities?: {
    smtp_configured: boolean;
    workspace_names_available: boolean;
    account_prices_available: boolean;
    is_admin: boolean;
  };
}

export interface SettingsUpdatePayload {
  general?: Record<string, unknown>;
  tab_visibility?: Partial<TabVisibility>;
  thresholds?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  webhook?: { slack_webhook_url: string };
}

export interface SettingsUpdate {
  payload: SettingsUpdatePayload;
  updatedCount: number;
}

export const DEFAULT_VISIBILITY: TabVisibility = {
  dbu: true,
  infra: true,
  optimizer: true,
  kpis: true,
  aiml: true,
  sql: true,
  apps: true,
  tagging: true,
  "users-groups": true,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultDateRangeDays: 30,
  refreshIntervalMinutes: 0,
  compactMode: false,
  darkMode: false,
  density: "comfortable",
  theme: "light",
  defaultLandingTab: "dbu",
  showWorkspaceNames: true,
  anomalySensitivity: "medium",
  expSetupWizardLink: false,
  expDebuggerLink: false,
  enableArchitectureView: true,
  enableMvShareRunbook: true,
  companyName: "",
  appDisplayName: "",
  monthlyBudget: 0,
  costAllocationTags: "",
  alertSpikePercent: 20,
  alertDailyBudget: 50000,
  alertWorkspaceBudget: 10000,
  slackWebhookUrl: "",
  anonymizeUsers: false,
};

const TAB_VISIBILITY_STORAGE_KEY = "coc-tab-visibility";
const APP_SETTINGS_STORAGE_KEY = "coc-app-settings";
const DATE_RANGE_DAYS = new Set([7, 14, 30, 60, 90]);
const REFRESH_INTERVALS = new Set([0, 5, 15, 30]);
const DENSITIES = new Set(["comfortable", "compact"]);
const THEMES = new Set(["light", "dark", "system"]);
const SENSITIVITIES = new Set(["low", "medium", "high"]);

export function loadTabVisibility(): TabVisibility {
  try {
    const stored = localStorage.getItem(TAB_VISIBILITY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      delete parsed["use-cases"];
      return { ...DEFAULT_VISIBILITY, ...parsed };
    }
  } catch {
    // Fall through to defaults.
  }
  return { ...DEFAULT_VISIBILITY };
}

export function persistTabVisibility(visibility: TabVisibility): void {
  localStorage.setItem(TAB_VISIBILITY_STORAGE_KEY, JSON.stringify(visibility));
}

export function loadAppSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const merged = Object.fromEntries(
        (Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[])
          .map((key) => [key, parsed[key] ?? DEFAULT_APP_SETTINGS[key]]),
      ) as AppSettings;
      if (parsed.theme === undefined) merged.theme = parsed.darkMode ? "dark" : "light";
      if (parsed.density === undefined) {
        merged.density = parsed.compactMode ? "compact" : "comfortable";
      }
      // Webhook URLs are credentials. The durable server setting is the only
      // source of truth; never revive a legacy secret from browser storage.
      merged.slackWebhookUrl = "";
      return merged;
    }
  } catch {
    // Fall through to defaults.
  }
  return { ...DEFAULT_APP_SETTINGS };
}

export function persistAppSettings(settings: AppSettings): void {
  const stored = {
    ...settings,
    darkMode: settings.theme === "dark",
    compactMode: settings.density === "compact",
    // Keep the draft field in memory only. The server returns masked status and
    // owns the durable secret after Save.
    slackWebhookUrl: undefined,
  };
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(stored));
}

function validNumber(value: unknown, allowed: Set<number>, fallback: number): number {
  return typeof value === "number" && allowed.has(value) ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validString<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? value as T : fallback;
}

export function hydrateSettingsFromServer(
  server: UnifiedSettings,
  currentSettings: AppSettings,
  currentVisibility: TabVisibility,
): { appSettings: AppSettings; tabVisibility: TabVisibility } {
  const general = server.general ?? {};
  const appSettings: AppSettings = {
    ...currentSettings,
    companyName: typeof general.company_name === "string"
      ? general.company_name
      : currentSettings.companyName,
    appDisplayName: typeof general.app_display_name === "string"
      ? general.app_display_name
      : currentSettings.appDisplayName,
    defaultDateRangeDays: validNumber(
      general.default_date_range_days,
      DATE_RANGE_DAYS,
      currentSettings.defaultDateRangeDays,
    ) as AppSettings["defaultDateRangeDays"],
    defaultLandingTab: typeof general.default_landing_tab === "string"
      ? general.default_landing_tab
      : currentSettings.defaultLandingTab,
    refreshIntervalMinutes: validNumber(
      general.auto_refresh_minutes,
      REFRESH_INTERVALS,
      currentSettings.refreshIntervalMinutes,
    ) as AppSettings["refreshIntervalMinutes"],
    density: validString(general.density, DENSITIES, currentSettings.density),
    theme: validString(general.theme, THEMES, currentSettings.theme),
    showWorkspaceNames: typeof general.show_workspace_names === "boolean"
      ? general.show_workspace_names
      : currentSettings.showWorkspaceNames,
    anonymizeUsers: typeof general.anonymize_users === "boolean"
      ? general.anonymize_users
      : currentSettings.anonymizeUsers,
    alertSpikePercent: finiteNumber(
      server.thresholds?.spike_threshold_percent,
      currentSettings.alertSpikePercent,
    ),
    alertDailyBudget: finiteNumber(
      server.thresholds?.daily_budget,
      currentSettings.alertDailyBudget,
    ),
    alertWorkspaceBudget: finiteNumber(
      server.thresholds?.workspace_budget,
      currentSettings.alertWorkspaceBudget,
    ),
    anomalySensitivity: validString(
      server.thresholds?.anomaly_sensitivity,
      SENSITIVITIES,
      currentSettings.anomalySensitivity,
    ),
    expSetupWizardLink: typeof server.experimental?.exp_setup_wizard_link === "boolean"
      ? server.experimental.exp_setup_wizard_link
      : currentSettings.expSetupWizardLink,
    expDebuggerLink: typeof server.experimental?.exp_debugger_link === "boolean"
      ? server.experimental.exp_debugger_link
      : currentSettings.expDebuggerLink,
    enableArchitectureView: typeof server.experimental?.enable_architecture_view === "boolean"
      ? server.experimental.enable_architecture_view
      : currentSettings.enableArchitectureView,
    enableMvShareRunbook: typeof server.experimental?.enable_mv_share_runbook === "boolean"
      ? server.experimental.enable_mv_share_runbook
      : currentSettings.enableMvShareRunbook,
  };
  appSettings.darkMode = appSettings.theme === "dark";
  appSettings.compactMode = appSettings.density === "compact";

  const tabVisibility = { ...currentVisibility };
  if (server.tab_visibility) {
    for (const key of Object.keys(DEFAULT_VISIBILITY) as (keyof TabVisibility)[]) {
      const value = server.tab_visibility[key];
      if (typeof value === "boolean") tabVisibility[key] = value;
    }
  }

  return { appSettings, tabVisibility };
}

export function settingsAreEqual(left: AppSettings, right: AppSettings): boolean {
  return (Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[])
    .every((key) => left[key] === right[key]);
}

export function tabVisibilityIsEqual(left: TabVisibility, right: TabVisibility): boolean {
  return (Object.keys(DEFAULT_VISIBILITY) as (keyof TabVisibility)[])
    .every((key) => left[key] === right[key]);
}

const GENERAL_FIELDS = {
  companyName: "company_name",
  appDisplayName: "app_display_name",
  defaultDateRangeDays: "default_date_range_days",
  defaultLandingTab: "default_landing_tab",
  refreshIntervalMinutes: "auto_refresh_minutes",
  density: "density",
  theme: "theme",
  showWorkspaceNames: "show_workspace_names",
  anonymizeUsers: "anonymize_users",
} as const satisfies Partial<Record<keyof AppSettings, string>>;

const THRESHOLD_FIELDS = {
  alertSpikePercent: "spike_threshold_percent",
  alertDailyBudget: "daily_budget",
  alertWorkspaceBudget: "workspace_budget",
  anomalySensitivity: "anomaly_sensitivity",
} as const satisfies Partial<Record<keyof AppSettings, string>>;

const EXPERIMENTAL_FIELDS = {
  expSetupWizardLink: "exp_setup_wizard_link",
  expDebuggerLink: "exp_debugger_link",
  enableArchitectureView: "enable_architecture_view",
  enableMvShareRunbook: "enable_mv_share_runbook",
} as const satisfies Partial<Record<keyof AppSettings, string>>;

function collectChangedSettings(
  current: AppSettings,
  baseline: AppSettings,
  mapping: Partial<Record<keyof AppSettings, string>>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [clientKey, serverKey] of Object.entries(mapping) as [keyof AppSettings, string][]) {
    if (current[clientKey] !== baseline[clientKey]) changed[serverKey] = current[clientKey];
  }
  return changed;
}

/**
 * Build the unified PUT body from field-level changes only. The count is the
 * exact number of draft fields that differ from the last durable baseline.
 */
export function buildSettingsUpdate(
  currentSettings: AppSettings,
  baselineSettings: AppSettings,
  currentVisibility: TabVisibility,
  baselineVisibility: TabVisibility,
): SettingsUpdate {
  const payload: SettingsUpdatePayload = {};
  let updatedCount = 0;

  const general = collectChangedSettings(currentSettings, baselineSettings, GENERAL_FIELDS);
  if (Object.keys(general).length) {
    payload.general = general;
    updatedCount += Object.keys(general).length;
  }

  const thresholds = collectChangedSettings(currentSettings, baselineSettings, THRESHOLD_FIELDS);
  if (Object.keys(thresholds).length) {
    payload.thresholds = thresholds;
    updatedCount += Object.keys(thresholds).length;
  }

  const experimental = collectChangedSettings(currentSettings, baselineSettings, EXPERIMENTAL_FIELDS);
  if (Object.keys(experimental).length) {
    payload.experimental = experimental;
    updatedCount += Object.keys(experimental).length;
  }

  const tabVisibility: Partial<TabVisibility> = {};
  for (const key of Object.keys(DEFAULT_VISIBILITY) as (keyof TabVisibility)[]) {
    if (currentVisibility[key] !== baselineVisibility[key]) tabVisibility[key] = currentVisibility[key];
  }
  if (Object.keys(tabVisibility).length) {
    payload.tab_visibility = tabVisibility;
    updatedCount += Object.keys(tabVisibility).length;
  }

  if (currentSettings.slackWebhookUrl !== baselineSettings.slackWebhookUrl) {
    payload.webhook = { slack_webhook_url: currentSettings.slackWebhookUrl };
    updatedCount += 1;
  }

  return { payload, updatedCount };
}

/** Merge a successful partial update into the cached unified GET shape. */
export function mergeUnifiedSettings(
  current: UnifiedSettings | null | undefined,
  payload: SettingsUpdatePayload,
): UnifiedSettings {
  const merged: UnifiedSettings = { ...(current ?? {}) };
  if (payload.general) merged.general = { ...(current?.general ?? {}), ...payload.general };
  if (payload.tab_visibility) {
    merged.tab_visibility = { ...(current?.tab_visibility ?? {}), ...payload.tab_visibility };
  }
  if (payload.thresholds) merged.thresholds = { ...(current?.thresholds ?? {}), ...payload.thresholds };
  if (payload.experimental) {
    merged.experimental = { ...(current?.experimental ?? {}), ...payload.experimental };
  }
  if (payload.webhook) {
    const configured = Boolean(payload.webhook.slack_webhook_url);
    merged.webhook = {
      configured,
      masked_url: configured ? "https://hooks.slack.com/services/****" : null,
    };
  }
  return merged;
}
