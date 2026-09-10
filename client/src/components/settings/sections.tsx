import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSettings, TabVisibility, SettingsCapabilities } from "../SettingsDialog";
import { SettingsConfig } from "./SettingsConfig";
import type { AppConfigInfo } from "./SettingsConfig";
import { SettingsPermissions } from "./SettingsPermissions";
import { SettingsResources } from "./SettingsResources";
import {
  SectionTitle, Group, Row, Toggle, Select, TextInput, UnitInput, Badge, MonoChip,
  SecondaryButton, LinkButton, Callout, T, MONO,
} from "./dubois";
import { useToast } from "./duboisToast";

// Tab labels for landing-tab select + visibility list (spec §6 order).
const TAB_LABELS: Record<keyof TabVisibility, string> = {
  dbu: "DBU Overview", sql: "SQL", aiml: "AI/ML", apps: "Apps", tagging: "Tagging",
  "users-groups": "Users", kpis: "Platform KPIs & Trends", infra: "Cloud Costs",
  optimizer: "Optimize",
};
const TAB_ORDER: (keyof TabVisibility)[] = ["dbu", "sql", "aiml", "apps", "tagging", "users-groups", "kpis", "infra", "optimizer"];

const ext = (
  <svg style={{ width: 12, height: 12, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
);

interface CommonProps {
  localSettings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  caps?: SettingsCapabilities;
}

// ── General ──────────────────────────────────────────────────────────────────
export function GeneralSection({
  localSettings,
  updateSetting,
  tabVisibility,
  toggleTab,
  caps,
}: CommonProps & {
  tabVisibility: TabVisibility;
  toggleTab?: (k: keyof TabVisibility) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [spCopied, setSpCopied] = useState(false);

  const { data: appConfig } = useQuery<{ identity?: { display_name: string | null; user_name: string | null } | null }>({
    queryKey: ["app-config"], queryFn: () => fetch("/api/settings/config").then(r => r.json()).catch(() => null),
  });
  const { data: authStatus } = useQuery<{ sp_user_name?: string; sp_client_id?: string; sp_display_name?: string } | null>({
    queryKey: ["settings-auth-status"], queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null), staleTime: 60000,
  });
  const { data: appLinks } = useQuery<{ source_code_url: string; app_page_url: string } | null>({
    queryKey: ["settings-app-links"], queryFn: () => fetch("/api/settings/app-links").then(r => r.json()).catch(() => null), staleTime: 300000,
  });
  const { data: pricing } = useQuery<{ use_account_prices: boolean } | null>({
    queryKey: ["settings-pricing-mode"], queryFn: () => fetch("/api/settings/pricing-mode").then(r => r.json()).catch(() => null), staleTime: 300000,
  });
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingSaving, setPricingSaving] = useState(false);
  const pricingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const durablePricingRef = useRef<boolean | null>(null);
  const pricingRevisionRef = useRef(0);
  useEffect(() => {
    if (pricing && durablePricingRef.current === null) {
      durablePricingRef.current = pricing.use_account_prices;
    }
  }, [pricing]);

  const sp = authStatus?.sp_user_name || authStatus?.sp_client_id || appConfig?.identity?.display_name || appConfig?.identity?.user_name || "Service principal";
  const defaultName = authStatus?.sp_display_name || appConfig?.identity?.display_name || "service principal name";
  const visibleTabs = TAB_ORDER.filter((k) => tabVisibility[k]);

  const setPricing = (useAccount: boolean) => {
    const revision = ++pricingRevisionRef.current;
    if (durablePricingRef.current === null) {
      durablePricingRef.current = pricing?.use_account_prices ?? false;
    }
    qc.setQueryData(["settings-pricing-mode"], { use_account_prices: useAccount });
    setPricingError(null);
    setPricingSaving(true);
    pricingQueueRef.current = pricingQueueRef.current.then(async () => {
      try {
        const response = await fetch("/api/settings/pricing-mode", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ use_account_prices: useAccount }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        durablePricingRef.current = useAccount;
        if (revision === pricingRevisionRef.current) {
          await qc.invalidateQueries();
          toast(useAccount ? "Using account prices" : "Using list prices");
        }
      } catch (error) {
        if (revision === pricingRevisionRef.current) {
          const durable = durablePricingRef.current ?? false;
          qc.setQueryData(["settings-pricing-mode"], { use_account_prices: durable });
          const message = error instanceof Error ? error.message : "Unknown error";
          setPricingError(`Price basis was not saved: ${message}. Try again.`);
          toast("Could not update price basis");
        }
      } finally {
        if (revision === pricingRevisionRef.current) setPricingSaving(false);
      }
    });
  };

  return (
    <div>
      <SectionTitle title="General" subtitle="App identity and default dashboard behavior." />

      <Group label="App identity">
        <Row first label="Display name" helper={`Shown in the app header. Leave blank to use the default (${defaultName}).`}
          control={<TextInput value={localSettings.appDisplayName} onChange={(v) => updateSetting("appDisplayName", v)} placeholder={defaultName} />} />
        <Row label="Company name" helper="Appears in exported PDF report headers."
          control={<TextInput value={localSettings.companyName} onChange={(v) => updateSetting("companyName", v)} placeholder="e.g. Acme Corp" />} />
        <Row label="Service principal" helper="The identity this app runs as. Managed by Databricks Apps."
          control={
            <div className="flex items-center gap-2">
              <MonoChip>{sp}</MonoChip>
              <LinkButton onClick={() => { navigator.clipboard?.writeText(sp); setSpCopied(true); toast("Copied"); setTimeout(() => setSpCopied(false), 1500); }}>{spCopied ? "Copied" : "Copy"}</LinkButton>
            </div>
          } />
        {(appLinks?.source_code_url || appLinks?.app_page_url) && (
          <Row label="Links"
            control={
              <div className="flex items-center gap-4">
                {appLinks?.source_code_url && <LinkButton href={appLinks.source_code_url}><span className="inline-flex items-center gap-1">App source code {ext}</span></LinkButton>}
                {appLinks?.app_page_url && <LinkButton href={appLinks.app_page_url}><span className="inline-flex items-center gap-1">App backend {ext}</span></LinkButton>}
              </div>
            } />
        )}
      </Group>

      <Group label="Dashboard defaults">
        <Row first label="Default date range" helper="Time window shown on dashboard load."
          control={<Select value={localSettings.defaultDateRangeDays} onChange={(v) => updateSetting("defaultDateRangeDays", v as AppSettings["defaultDateRangeDays"])}
            options={[{ value: 7, label: "Last 7 days" }, { value: 30, label: "Last 30 days" }, { value: 60, label: "Last 60 days" }, { value: 90, label: "Last 90 days" }]} />} />
        <Row label="Default landing tab" helper="Tab shown first when the dashboard opens."
          control={<Select value={localSettings.defaultLandingTab} onChange={(v) => updateSetting("defaultLandingTab", v)}
            options={visibleTabs.map((k) => ({ value: k as string, label: TAB_LABELS[k] }))} />} />
        <Row label="Auto-refresh" helper="Automatically refresh dashboard data."
          control={<Select value={localSettings.refreshIntervalMinutes} onChange={(v) => updateSetting("refreshIntervalMinutes", v as AppSettings["refreshIntervalMinutes"])}
            options={[{ value: 0, label: "Off" }, { value: 5, label: "Every 5 minutes" }, { value: 15, label: "Every 15 minutes" }, { value: 30, label: "Every 30 minutes" }]} />} />
        <Row label="Density" helper="Spacing of tables and cards."
          control={<Select value={localSettings.density} onChange={(v) => updateSetting("density", v as AppSettings["density"])}
            options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />} />
        <Row label="Theme" helper="Color scheme."
          control={<Select value={localSettings.theme} onChange={(v) => updateSetting("theme", v as AppSettings["theme"])}
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Match system" }]} />} />
        <Row label="Price basis"
          helper={caps && !caps.account_prices_available
            ? "system.billing.account_prices not accessible (private preview): account prices fall back to list prices. Saves immediately."
            : "Account prices read from system.billing.account_prices (private preview). Saves immediately."}
          control={<Select ariaLabel="Price basis" value={pricing?.use_account_prices ? "account" : "list"} onChange={(v) => setPricing(v === "account")}
            options={[{ value: "list", label: "List prices" }, { value: "account", label: "Account prices" }]} />} />
        {(pricingSaving || pricingError) && (
          <div role={pricingError ? "alert" : "status"} style={{ padding: "0 16px 10px", fontSize: 12, color: pricingError ? T.dangerFg : T.textSecondary }}>
            {pricingError ?? "Saving price basis…"}
          </div>
        )}
      </Group>

      {toggleTab && <DashboardTabsSection localVisibility={tabVisibility} toggleTab={toggleTab} />}
    </div>
  );
}

// ── Dashboard tabs ────────────────────────────────────────────────────────────
export function DashboardTabsSection({ localVisibility, toggleTab }: {
  localVisibility: TabVisibility; toggleTab: (k: keyof TabVisibility) => void;
}) {
  const toast = useToast();
  const keys = TAB_ORDER;
  const visibleCount = keys.filter((k) => localVisibility[k]).length;
  return (
    <div className="mt-6">
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Dashboard tab visibility</div>
      <p style={{ fontSize: 12, color: T.textSecondary, marginTop: 2, marginBottom: 8 }}>
        Choose which tabs viewers see. At least one must remain visible. {visibleCount} of {keys.length} visible.
      </p>
      <Group>
        {keys.map((k, i) => (
          <Row key={k} first={i === 0} label={TAB_LABELS[k]}
            control={<Toggle label={TAB_LABELS[k]} checked={localVisibility[k]} onChange={() => {
              if (localVisibility[k] && visibleCount <= 1) { toast("At least one tab must stay visible"); return; }
              toggleTab(k);
            }} />} />
        ))}
      </Group>
    </div>
  );
}

// ── Alerts & notifications ──────────────────────────────────────────────────
export function AlertsSection({ localSettings, updateSetting, caps }: CommonProps) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const { data: webhookStatus } = useQuery<{ configured: boolean } | null>({
    queryKey: ["settings-webhook-status"], queryFn: () => fetch("/api/settings/webhook").then(r => r.json()).catch(() => null), staleTime: 300000,
  });
  const masked = webhookStatus?.configured && !localSettings.slackWebhookUrl;
  return (
    <div>
      <SectionTitle title="Alerts & notifications" subtitle="Thresholds that drive spike detection and where alerts are delivered." />
      <Group label="Thresholds">
        <Row first label="Spike threshold" helper="Day-over-day change that triggers an alert."
          control={<UnitInput affix="%" value={localSettings.alertSpikePercent} min={1} max={500} onChange={(v) => updateSetting("alertSpikePercent", v || 20)} />} />
        <Row label="Daily budget" helper="Alert when account-wide daily spend exceeds this."
          control={<UnitInput affix="$" affixSide="left" width={160} value={localSettings.alertDailyBudget} min={0} step={1000} onChange={(v) => updateSetting("alertDailyBudget", v || 0)} />} />
        <Row label="Workspace budget" helper="Per-workspace daily limit."
          control={<UnitInput affix="$" affixSide="left" width={160} value={localSettings.alertWorkspaceBudget} min={0} step={1000} onChange={(v) => updateSetting("alertWorkspaceBudget", v || 0)} />} />
        <Row label="Anomaly sensitivity" helper="Maps to spike-detection thresholds in alerting."
          control={<Select value={localSettings.anomalySensitivity ?? "medium"} onChange={(v) => updateSetting("anomalySensitivity", v as AppSettings["anomalySensitivity"])}
            options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} />} />
      </Group>
      <Group label="Delivery">
        <Row first label="Slack webhook" helper={masked ? "A webhook is configured on the server (masked). Enter a new URL to replace it." : "Post alerts to a Slack channel."}
          control={
            <div className="flex items-center gap-2">
              <TextInput mono value={localSettings.slackWebhookUrl} onChange={(v) => updateSetting("slackWebhookUrl", v)}
                placeholder={masked ? "https://hooks.slack.com/…••••" : "https://hooks.slack.com/services/…"} width={260} />
              <SecondaryButton disabled={!localSettings.slackWebhookUrl && !webhookStatus?.configured}
                onClick={async () => {
                  try {
                    if (localSettings.slackWebhookUrl) {
                      const saveResponse = await fetch("/api/settings/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slack_webhook_url: localSettings.slackWebhookUrl }) });
                      if (!saveResponse.ok) {
                        toast(`Webhook was not saved (HTTP ${saveResponse.status})`);
                        return;
                      }
                      updateSetting("slackWebhookUrl", "");
                    }
                    const r = await fetch("/api/settings/webhook/test", { method: "POST" }); const d = await r.json().catch(() => ({}));
                    toast(d.success ? "Test message sent to Slack" : `Test failed: ${d.error ?? "unknown"}`);
                  } catch {
                    toast("Webhook test failed: network unavailable");
                  }
                }}>Send test</SecondaryButton>
            </div>
          } />
        <Row label="Email recipients"
          helper={caps?.smtp_configured ? "Comma-separated addresses for alert emails." : "Requires SMTP configuration (SMTP_* environment variables)."}
          control={<TextInput value="" onChange={() => {}} placeholder="Comma-separated addresses" disabled={!caps?.smtp_configured} width={260} />} />
        <Row label="Run alert check now"
          helper="Evaluate saved thresholds against the latest day's spend; posts any breaches to the Slack webhook. Runs automatically each night too."
          control={<SecondaryButton disabled={checking} onClick={async () => {
            setChecking(true);
            try {
              const r = await fetch("/api/settings/alerts/run", { method: "POST" });
              const d = await r.json().catch(() => ({}));
              const n = (d.breaches || []).length;
              if (!r.ok) toast("Alert check failed");
              else if (n === 0) toast("No threshold breaches in the latest data");
              else toast(`${n} breach${n === 1 ? "" : "es"} found${d.sent ? ": posted to Slack" : " (configure a webhook to deliver)"}`);
            } catch { toast("Alert check failed"); }
            finally { setChecking(false); }
          }}>{checking ? "Checking…" : "Run check"}</SecondaryButton>} />
      </Group>
    </div>
  );
}

// ── Resources (read-only) ─────────────────────────────────────────────────────
export function ResourcesSection() {
  return <SettingsResources />;
}

// ── Experimental (admin-only) ─────────────────────────────────────────────────
export function ExperimentalSection({ localSettings, updateSetting }: CommonProps) {
  return (
    <div>
      <SectionTitle title="Experimental" badge={<Badge>Admin only</Badge>} subtitle="Early features. Off by default; may change or be removed in a future version." />
      <Group>
        <Row first label={<span className="inline-flex items-center gap-2">Setup wizard link <Badge>Experimental</Badge></span>}
          helper="Show the Setup wizard as a link in the settings nav footer."
          control={<Toggle checked={localSettings.expSetupWizardLink} onChange={(v) => updateSetting("expSetupWizardLink", v)} />} />
        <Row label={<span className="inline-flex items-center gap-2">Debugger link <Badge>Experimental</Badge></span>}
          helper="Show the query debugger (SQL + timing per tile) as a nav-footer link."
          control={<Toggle checked={localSettings.expDebuggerLink} onChange={(v) => updateSetting("expDebuggerLink", v)} />} />
        <Row label={<span className="inline-flex items-center gap-2">User anonymization <Badge>Experimental</Badge></span>}
          helper="Replace human email addresses with User 1, User 2, and so on. Service principals remain unchanged."
          control={<Toggle label="User anonymization" checked={localSettings.anonymizeUsers} onChange={(v) => updateSetting("anonymizeUsers", v)} />} />
        <Row label={<span className="inline-flex items-center gap-2">Architecture view <Badge>Experimental</Badge></span>}
          helper="Unlock architecture PDF export from the existing Export dialog."
          control={<Toggle label="Architecture view" checked={localSettings.enableArchitectureView} onChange={(v) => updateSetting("enableArchitectureView", v)} />} />
        <Row
          label={<span className="inline-flex items-center gap-2">Materialized view share runbook <Badge>Experimental</Badge></span>}
          helper="Download a standalone Databricks Run All notebook that builds the same nine cost-obs aggregates in a publisher workspace and adds them to a Delta Share."
          control={<Toggle label="Materialized view share runbook" checked={localSettings.enableMvShareRunbook} onChange={(v) => updateSetting("enableMvShareRunbook", v)} />}
        />
      </Group>
    </div>
  );
}

// ── Refresh schedule (self-contained, saves immediately) ──────────────────────
interface Schedule { enabled: boolean; frequency: "nightly" | "weekly" | "monthly"; hour_utc: number; lookback_days: number; }
const SCHED_DEFAULTS: Schedule = { enabled: true, frequency: "nightly", hour_utc: 5, lookback_days: 180 };

export function ScheduleGroup() {
  const toast = useToast();
  const { data } = useQuery<Schedule>({
    queryKey: ["settings-schedule"], queryFn: () => fetch("/api/settings/schedule").then(r => r.ok ? r.json() : SCHED_DEFAULTS).catch(() => SCHED_DEFAULTS), staleTime: 300000,
  });
  const [s, setS] = useState<Schedule>(data ?? SCHED_DEFAULTS);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const synced = useRef(!!data);
  const durableRef = useRef<Schedule>(data ?? SCHED_DEFAULTS);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRevisionRef = useRef(0);
  useEffect(() => {
    if (data && !synced.current) {
      setS(data);
      durableRef.current = data;
      synced.current = true;
    }
  }, [data]);
  const save = (next: Schedule) => {
    const revision = ++saveRevisionRef.current;
    synced.current = true;
    setS(next);
    setSaveError(null);
    setSaving(true);
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const response = await fetch("/api/settings/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        durableRef.current = next;
        if (revision === saveRevisionRef.current) toast("Refresh schedule saved");
      } catch (error) {
        if (revision === saveRevisionRef.current) {
          setS(durableRef.current);
          const message = error instanceof Error ? error.message : "Unknown error";
          setSaveError(`Refresh schedule was not saved: ${message}. Try again.`);
          toast("Could not save schedule");
        }
      } finally {
        if (revision === saveRevisionRef.current) setSaving(false);
      }
    });
  };
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, "0")}:00 UTC` }));
  return (
    <Group label="Refresh schedule">
      <Row first label="Scheduled refresh" helper="Full rebuilds take 3 to 8 minutes; incremental refreshes finish in under a minute."
        control={<Toggle label="Scheduled refresh" checked={s.enabled} onChange={(v) => save({ ...s, enabled: v })} />} />
      {s.enabled && <Row label="Frequency" helper="How often to rebuild the managed tables."
        control={<Select ariaLabel="Refresh frequency" value={s.frequency} onChange={(v) => save({ ...s, frequency: v as Schedule["frequency"] })}
          options={[{ value: "nightly", label: "Nightly" }, { value: "weekly", label: "Weekly (Mondays)" }, { value: "monthly", label: "Monthly (1st)" }]} />} />}
      {s.enabled && <Row label="Run at" helper="Hour the rebuild runs."
        control={<Select ariaLabel="Refresh hour" value={s.hour_utc} onChange={(v) => save({ ...s, hour_utc: Number(v) })} options={hours} />} />}
      {s.enabled && <Row label="Rebuild window" helper="How far back to pull data on each rebuild."
        control={<Select ariaLabel="Rebuild window" value={s.lookback_days} onChange={(v) => save({ ...s, lookback_days: Number(v) })}
          options={[{ value: 180, label: "6 months" }, { value: 365, label: "1 year" }, { value: 730, label: "2 years" }, { value: 1095, label: "3 years" }]} />} />}
      {(saving || saveError) && (
        <div role={saveError ? "alert" : "status"} style={{ padding: "0 16px 10px", fontSize: 12, color: saveError ? T.dangerFg : T.textSecondary }}>
          {saveError ?? "Saving refresh schedule…"}
        </div>
      )}
    </Group>
  );
}

// ── Data & tables ─────────────────────────────────────────────────────────────
export function DataTablesSection({ localSettings, updateSetting, caps }: CommonProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const [cacheStatus, setCacheStatus] = useState<
    { kind: "idle" | "clearing" | "success" | "error"; message?: string }
  >({ kind: "idle" });
  const { data: appConfig } = useQuery<AppConfigInfo | undefined>({
    queryKey: ["app-config"], queryFn: () => fetch("/api/settings/config").then(r => r.json()).catch(() => undefined),
  });
  const loc = appConfig?.storage_location;
  const clearQueryCache = async () => {
    setCacheStatus({ kind: "clearing", message: "Clearing cached dashboard responses…" });
    try {
      const response = await fetch("/api/cache/clear", { method: "POST" });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const result = await response.json() as { cleared?: number };
      await qc.invalidateQueries();
      const cleared = Number(result.cleared ?? 0);
      const message = `Cache cleared successfully. ${cleared} in-memory ${cleared === 1 ? "entry" : "entries"} removed; dashboard tabs will run fresh warehouse queries as they are opened.`;
      setCacheStatus({ kind: "success", message });
      toast("Query cache cleared");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      setCacheStatus({ kind: "error", message: `Cache could not be cleared: ${detail}. Try again.` });
      toast("Could not clear query cache");
    }
  };
  return (
    <div>
      <SectionTitle title="Data & tables" subtitle="Where the app stores its managed tables and how they refresh." />
      <Group label="Storage location">
        <Row first label="Catalog & schema" helper="Fixed after setup. Redeploy or re-run setup to change."
          control={<MonoChip>{loc?.catalog && loc?.schema ? `${loc.catalog}.${loc.schema}` : "N/A"}</MonoChip>} />
        <Row label="Workspace filter" helper="Set at deploy time via COST_OBS_WORKSPACES. Redeploy to change."
          control={<span style={{ fontSize: 12, color: T.textSecondary }}>All workspaces</span>} />
        <Row label="Workspace display names"
          helper={caps && !caps.workspace_names_available
            ? "Grant missing: showing IDs. Names come from system.access.workspaces_latest once the SP can read it."
            : "Show resolved names from system.access.workspaces_latest instead of IDs."}
          control={<Toggle checked={localSettings.showWorkspaceNames} disabled={caps ? !caps.workspace_names_available : false} onChange={(v) => updateSetting("showWorkspaceNames", v)} />} />
      </Group>
      <ScheduleGroup />
      {/* Shared Delta-Sharing sources + managed-tables status/rebuild/history/danger :
          DuBois-styled, self-contained (owns the table-status polling + rebuild + drop). */}
      <SettingsConfig
        beforeDropContent={(
          <div data-testid="query-cache-section" style={{ marginTop: 20 }}>
            <Group label="Query cache">
              <Row
                first
                label="Clear cached dashboard results"
                helper="Removes server and shared response-cache entries for every dashboard tab. It does not delete managed tables, settings, or source configuration. Each tab runs fresh warehouse queries the next time it opens."
                control={(
                  <SecondaryButton
                    disabled={cacheStatus.kind === "clearing"}
                    onClick={() => { void clearQueryCache(); }}
                  >
                    {cacheStatus.kind === "clearing" ? "Clearing cache…" : "Clear query cache"}
                  </SecondaryButton>
                )}
              />
              {cacheStatus.kind !== "idle" && (
                <div
                  role={cacheStatus.kind === "error" ? "alert" : "status"}
                  aria-live="polite"
                  style={{ padding: "0 16px 12px" }}
                >
                  <Callout tone={cacheStatus.kind === "error" ? "danger" : cacheStatus.kind === "success" ? "success" : "warning"}>
                    {cacheStatus.message}
                  </Callout>
                </div>
              )}
            </Group>
          </div>
        )}
      />
    </div>
  );
}

// ── Identity & Permissions ────────────────────────────────────────────────────
export function AccessSection() {
  return (
    <div>
      <SectionTitle title="Identity & Permissions" subtitle="App roles, service-principal identity, and effective Databricks resource access." />
      <SettingsPermissions />
    </div>
  );
}

// ── Permissions grants-pending fallback helper (used inline by shell if needed)
export function GrantsPendingCallout({ sql }: { sql: string }) {
  return (
    <Callout tone="warning">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>System-table grants pending</div>
      <div style={{ marginBottom: 8 }}>When readiness identifies a missing service-principal grant, affected metrics show <em>unavailable</em> (never $0.00). Run this as a metastore admin, then re-check:</div>
      <pre style={{ backgroundColor: "#11171C", color: "#E8ECF0", borderRadius: 6, padding: 10, fontFamily: MONO, fontSize: 11.5, overflowX: "auto" }}>{sql}</pre>
    </Callout>
  );
}
