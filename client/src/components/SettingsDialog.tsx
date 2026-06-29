import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsConfig, SettingsGeneral, SettingsTabs, SettingsAccuracyChecks, SettingsPermissions, SettingsDebugger } from "./settings";
import { READINESS_QUERY_KEY } from "@/hooks/useFeatureAvailability";
import type { ScheduleSettings } from "./settings/SettingsGeneral";
import { SetupWizard } from "./SetupWizard";

export interface TabVisibility {
  dbu: boolean;
  infra: boolean;
  optimizer: boolean;
  kpis: boolean;
  aiml: boolean;
  sql: boolean;
  apps: boolean;
  tagging: boolean;
  "use-cases": boolean;
  alerts: boolean;
  "users-groups": boolean;
  forecasting: boolean;
}

const DEFAULT_VISIBILITY: TabVisibility = {
  dbu: true,
  infra: true,
  optimizer: true,
  kpis: true,
  aiml: true,
  sql: true,
  apps: true,
  tagging: true,
  "use-cases": false,
  alerts: false,
  "users-groups": true,
  forecasting: false,
};

const STORAGE_KEY = "coc-tab-visibility";

export function loadTabVisibility(): TabVisibility {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_VISIBILITY, ...JSON.parse(stored) };
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_VISIBILITY;
}

function saveTabVisibility(visibility: TabVisibility) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
}

// ── App Settings (General tab) ──────────────────────────────────────────
export interface AppSettings {
  defaultDateRangeDays: 7 | 14 | 30 | 60 | 90;
  refreshIntervalMinutes: 0 | 5 | 15 | 30;
  compactMode: boolean;
  companyName: string;
  appDisplayName: string;
  monthlyBudget: number;
  costAllocationTags: string;
  alertSpikePercent: number;
  alertDailyBudget: number;
  alertWorkspaceBudget: number;
  slackWebhookUrl: string;
  enableAppHostingComparison: boolean;
  enableUseCaseTracking: boolean;
  enableAccuracyChecks: boolean;
  enableAlerts: boolean;
  enableForecasting: boolean;
  enableContractTracking: boolean;
  darkMode: boolean;
  anonymizeUsers: boolean;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultDateRangeDays: 30,
  refreshIntervalMinutes: 0,
  compactMode: false,
  companyName: "",
  appDisplayName: "",
  monthlyBudget: 0,
  costAllocationTags: "",
  alertSpikePercent: 20,
  alertDailyBudget: 50000,
  alertWorkspaceBudget: 10000,
  slackWebhookUrl: "",
  enableAppHostingComparison: false,
  enableUseCaseTracking: false,
  enableAccuracyChecks: false,
  enableAlerts: false,
  enableForecasting: false,
  enableContractTracking: false,
  darkMode: false,
  anonymizeUsers: false,
};

const APP_SETTINGS_KEY = "coc-app-settings";

export function loadAppSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(APP_SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_APP_SETTINGS };
}

function saveAppSettings(settings: AppSettings) {
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
}

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onTabVisibilityChange: (visibility: TabVisibility) => void;
  onSettingsChange: (settings: AppSettings) => void;
  tabVisibility: TabVisibility;
  appSettings: AppSettings;
}

export function SettingsDialog({ isOpen, onClose, onTabVisibilityChange, onSettingsChange, tabVisibility, appSettings }: SettingsDialogProps) {
  const rqClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<"tabs" | "general" | "config" | "accuracy-checks" | "permissions" | "debugger" | "setup">("general");
  const [localVisibility, setLocalVisibility] = useState<TabVisibility>(tabVisibility);
  const [localSettings, setLocalSettings] = useState<AppSettings>(appSettings);
  const [pendingSchedule, setPendingSchedule] = useState<ScheduleSettings | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [generalDirty, setGeneralDirty] = useState(false);
  const contentScrollRef = useRef<HTMLDivElement>(null);

  // ── Queries ──────────────────────────────────────────────────────────
  const { data: permissions } = useQuery<{ admins: string[]; current_user?: string | null }>({
    queryKey: ["user-permissions"],
    queryFn: async () => {
      const res = await fetch("/api/settings/user-permissions");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: isOpen,
    staleTime: 60 * 1000,
  });

  // Mirror backend logic: empty admins list = everyone is admin (fresh deploy)
  const isAdmin = !permissions || !permissions.admins?.length || (
    !!permissions.current_user && permissions.admins.includes(permissions.current_user)
  );

  const { data: appConfig, isLoading: configLoading } = useQuery<{
    warehouse: { id: string; name: string | null; size: string | null; state: string; source?: "app_resource" | "http_path" | "none" } | null;
    identity: { display_name: string | null; user_name: string | null } | null;
    storage_location: { catalog: string; schema: string; catalog_source?: "env_var" | "default"; schema_source?: "env_var" | "default" } | null;
    version?: { commit_sha: string };
  }>({
    queryKey: ["app-config"],
    queryFn: async () => {
      const res = await fetch("/api/settings/config");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: isOpen,
  });

  // ── Effects ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      setLocalVisibility(tabVisibility);
      setLocalSettings(appSettings);
      setGeneralDirty(false);
      setPendingSchedule(null);
    }
  }, [isOpen, tabVisibility, appSettings]);

  // Kick non-admins off the setup tab if permissions load and they're not admin
  useEffect(() => {
    if (activeSection === "setup" && permissions && !isAdmin) {
      setActiveSection("general");
    }
  }, [permissions, isAdmin, activeSection]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // ── Handlers ─────────────────────────────────────────────────────────
  const toggleTab = (key: keyof TabVisibility) => {
    const updated = { ...localVisibility, [key]: !localVisibility[key] };
    if (Object.values(updated).some(Boolean)) setLocalVisibility(updated);
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    setGeneralDirty(true);
  };

  const handleSave = () => {
    saveTabVisibility(localVisibility);
    onTabVisibilityChange(localVisibility);
    onClose();
  };

  const handleSaveGeneral = () => {
    saveAppSettings(localSettings);
    onSettingsChange(localSettings);
    setGeneralDirty(false);
    if (pendingSchedule) {
      rqClient.setQueryData(["settings-schedule"], pendingSchedule);
      fetch("/api/settings/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pendingSchedule),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
      setPendingSchedule(null);
    }
    fetch(
      `/api/alerts/setup-databricks-alerts?spike_threshold_percent=${localSettings.alertSpikePercent}&daily_threshold_amount=${localSettings.alertDailyBudget}&workspace_threshold_amount=${localSettings.alertWorkspaceBudget}`,
      { method: "POST", signal: AbortSignal.timeout(10000) }
    ).catch(() => {});
    fetch("/api/settings/alert-thresholds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spike_threshold_percent: localSettings.alertSpikePercent,
        daily_budget: localSettings.alertDailyBudget,
        workspace_budget: localSettings.alertWorkspaceBudget,
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
    if (localSettings.slackWebhookUrl !== appSettings.slackWebhookUrl) {
      fetch("/api/settings/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_webhook_url: localSettings.slackWebhookUrl }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
    onClose();
  };

  const visibleCount = Object.values(localVisibility).filter(Boolean).length;

  // ── Render ───────────────────────────────────────────────────────────
  return createPortal(
    <div className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/30" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="animate-dialog relative flex h-[90vh] w-full max-w-6xl flex-col rounded-lg bg-white shadow-xl border border-gray-200" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="shrink-0 border-b border-gray-200 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ backgroundColor: '#FF3621' }}>
                  <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900">App Settings</h3>
              </div>
              <button onClick={onClose} className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-500">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="flex flex-wrap gap-1">
                {(["general", "permissions", "config", "tabs"] as const).map((section) => (
                  <button
                    key={section}
                    onClick={() => setActiveSection(section)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      activeSection === section ? "text-white" : "text-gray-600 hover:bg-gray-100"
                    }`}
                    style={activeSection === section ? { backgroundColor: '#1B3139' } : {}}
                  >
                    {section === "general" ? "General" : section === "tabs" ? "Visibility" : section === "permissions" ? "Permissions" : "Configuration"}
                  </button>
                ))}
                {localSettings.enableAccuracyChecks && (
                  <button
                    onClick={() => setActiveSection("accuracy-checks")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      activeSection === "accuracy-checks" ? "text-white" : "text-gray-600 hover:bg-gray-100"
                    }`}
                    style={activeSection === "accuracy-checks" ? { backgroundColor: '#1B3139' } : {}}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Accuracy Checks
                  </button>
                )}
                <button
                  onClick={() => setActiveSection("debugger")}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    activeSection === "debugger" ? "text-white" : "text-gray-600 hover:bg-gray-100"
                  }`}
                  style={activeSection === "debugger" ? { backgroundColor: '#1B3139' } : {}}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  Debugger
                </button>
                {isAdmin && (
                  <button
                    onClick={() => setActiveSection("setup")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      activeSection === "setup" ? "text-white" : "text-gray-600 hover:bg-gray-100"
                    }`}
                    style={activeSection === "setup" ? { backgroundColor: '#1B3139' } : {}}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Setup Wizard
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                      Admin
                    </span>
                  </button>
                )}
              </div>
              <div className="relative group">
                <button
                  onClick={() => {
                    setLocalSettings({ ...DEFAULT_APP_SETTINGS });
                    setLocalVisibility({ ...DEFAULT_VISIBILITY });
                    saveAppSettings({ ...DEFAULT_APP_SETTINGS });
                    saveTabVisibility({ ...DEFAULT_VISIBILITY });
                    onSettingsChange({ ...DEFAULT_APP_SETTINGS });
                    onTabVisibilityChange({ ...DEFAULT_VISIBILITY });
                    localStorage.removeItem("coc-permissions-dont-show-again");
                    setGeneralDirty(false);
                    setSaveStatus("All settings reset to defaults");
                    setTimeout(() => setSaveStatus(null), 3000);
                  }}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
                >
                  Reset to Default
                </button>
                <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-56 rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  Resets all General settings (date range, refresh, budget, alerts), re-enables all tabs, clears company name, and restores the permissions dialog.
                </div>
              </div>
            </div>
          </div>

          {/* Content */}
          <div ref={contentScrollRef} className={`flex-1 min-h-0 overflow-y-auto ${activeSection === "setup" ? "p-0" : "px-6 py-4"}`}>
            {activeSection === "config" && (
              <SettingsConfig
                configLoading={configLoading}
                appConfig={appConfig}
                saveStatus={saveStatus}
                localSettings={localSettings}
                updateSetting={updateSetting}
              />
            )}
            {activeSection === "general" && (
              <SettingsGeneral
                localSettings={localSettings}
                updateSetting={updateSetting}
                saveStatus={saveStatus}
                setSaveStatus={setSaveStatus}
                onScheduleChange={(s) => { setPendingSchedule(s); setGeneralDirty(true); }}
              />
            )}
            {activeSection === "tabs" && (
              <SettingsTabs
                localVisibility={localVisibility}
                toggleTab={toggleTab}
                visibleCount={visibleCount}
                enableUseCaseTracking={localSettings.enableUseCaseTracking}
                enableAlerts={localSettings.enableAlerts}
                enableForecasting={localSettings.enableForecasting}
              />
            )}
            {activeSection === "accuracy-checks" && (
              <SettingsAccuracyChecks />
            )}
            {activeSection === "permissions" && (
              <SettingsPermissions />
            )}
            {activeSection === "debugger" && (
              <SettingsDebugger onGoToConfig={() => {
                setActiveSection("config");
                setTimeout(() => {
                  const el = contentScrollRef.current?.querySelector("#storage-location-tables");
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 50);
              }} />
            )}
            {activeSection === "setup" && (
              isAdmin
                ? <SetupWizard embedded onComplete={() => {
                    rqClient.invalidateQueries({ queryKey: ["app-config"] });
                    rqClient.invalidateQueries({ queryKey: ["settings-tables-status"] });
                    rqClient.invalidateQueries({ queryKey: READINESS_QUERY_KEY });
                    onClose();
                  }} />
                : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <svg className="mb-3 h-8 w-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <p className="text-sm font-medium text-gray-700">Admin access required</p>
                    <p className="mt-1 text-xs text-gray-500">Only admins can run the Setup Wizard.</p>
                  </div>
                )
            )}
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-200 px-6 py-4">
            {(activeSection === "general" || activeSection === "tabs" || activeSection === "config") && (
              <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
            )}
            {activeSection === "tabs" && (
              <button
                onClick={handleSave}
                className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Save Settings
              </button>
            )}
            {(activeSection === "general" || activeSection === "config") && (
              <button
                onClick={handleSaveGeneral}
                disabled={!generalDirty}
                className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save Settings
              </button>
            )}
            {(activeSection === "accuracy-checks" || activeSection === "permissions" || activeSection === "debugger") && (
              <button
                onClick={onClose}
                className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
