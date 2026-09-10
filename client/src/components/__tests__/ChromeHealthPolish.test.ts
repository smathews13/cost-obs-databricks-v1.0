import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const setupWizardSource = readFileSync(resolve(process.cwd(), "src/components/SetupWizard.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const settingsSections = readFileSync(resolve(process.cwd(), "src/components/settings/sections.tsx"), "utf8");
const settingsPermissions = readFileSync(resolve(process.cwd(), "src/components/settings/SettingsPermissions.tsx"), "utf8");
const settingsConfig = readFileSync(resolve(process.cwd(), "src/components/settings/SettingsConfig.tsx"), "utf8");

describe("account rail health polish", () => {
  it("lets definitive server setup state override stale browser completion flags", () => {
    const setupRequired = appSource.slice(
      appSource.indexOf('status?.status === "setup_required"'),
      appSource.indexOf("setSetupCheckPending(false)"),
    );
    expect(setupRequired).toContain('localStorage.removeItem("coc-setup-complete")');
    expect(setupRequired).toContain('fetch("/api/setup/bootstrap-admin"');
    expect(setupRequired).not.toContain("if (!prevCompleted())");
  });

  it("keeps table creation recoverable and surfaces live failures", () => {
    expect(setupWizardSource).toContain('"/api/setup/cancel-table-creation"');
    expect(setupWizardSource).toContain("Stop and reset");
    expect(setupWizardSource).toContain("table_errors?: Record<string, string>");
    expect(setupWizardSource).toContain("Progress updates are temporarily unavailable");
    expect(setupWizardSource).toContain('taskStatus === "interrupted" || taskStatus === "cancelled"');
    expect(setupWizardSource).not.toContain("taskStatus === \"done\" || allDone");
    expect(setupWizardSource).toContain("await startRequestRef.current?.catch");
    expect(setupWizardSource.indexOf("await startRequestRef.current?.catch"))
      .toBeLessThan(setupWizardSource.indexOf('fetch("/api/setup/cancel-table-creation"'));
    expect(setupWizardSource).toContain("if (stopRequestedRef.current) return");
  });

  it("does not claim ordinary git redeploys rotate service-principal grants", () => {
    expect(appSource).not.toContain("after the last git deploy");
    expect(appSource).toContain("Use Identity & Permissions to repair the specific access gap.");
    expect(settingsSections).not.toContain("Each new app deploy gets a fresh service principal");
    expect(settingsPermissions).not.toContain("Each new app deploy gets a fresh service principal");
  });

  it("puts Drop tables below Query cache at the bottom of Data and tables", () => {
    expect(settingsSections).toContain("beforeDropContent");
    expect(settingsSections).toContain('data-testid="query-cache-section" style={{ marginTop: 20 }}');
    expect(settingsConfig.indexOf("{beforeDropContent}")).toBeLessThan(
      settingsConfig.indexOf('<Group label="Drop tables"'),
    );
    expect(settingsConfig).not.toContain('<Group label="Danger zone"');
  });

  it("keeps manual and source-scope refreshes on the visible tab", () => {
    expect(appSource).toContain("await refreshTabData(rqClient, tab);");
    expect(appSource).not.toContain(
      "await requeueDemandTabs([tab]);\n      await refreshTabData(rqClient, tab);",
    );
    expect(appSource).toContain("setTabDemand(createTabDemandState(nextScopeKey, tab));");
    expect(appSource).not.toContain(
      "visibleDashboardTabs.forEach((visibleTab) => {\n            next[visibleTab] = \"waiting\";",
    );
  });

  it("links source scope to workspace selection and available options", () => {
    expect(appSource).toContain("linkedWorkspaceIds: string[] | null");
    expect(appSource).toContain("setSelectedWorkspaceIds(linkedWorkspaceIds)");
    expect(appSource).toContain('workspaces={scopeOwner === "source" ? sourceFilteredWorkspaceList : wsFilterList}');
    expect(appSource).toContain("workspaceSelection={selectedWorkspaceIds}");
    const workspaceHandler = appSource.slice(
      appSource.indexOf("const handleWorkspaceChange"),
      appSource.indexOf("const resetAllScopeFilters"),
    );
    expect(workspaceHandler.match(/setActiveSourceLabels\(\[\]\)/g)).toHaveLength(2);
    expect(workspaceHandler.match(/setActiveSourceRouting\(\[\], \[\]\)/g)).toHaveLength(2);
  });

  it("removes Optimize after successful checks find no warehouse data", () => {
    expect(appSource).toContain("const optimizeChecksSettled");
    expect(appSource).toContain("const optimizeHasData");
    expect(appSource).toContain("visibility={runtimeTabVisibility}");
    expect(appSource).toContain('activeTab === "optimizer" && !runtimeTabVisibility.optimizer');
  });

  it("keeps Cloud Costs visible for the serverless-only explanation", () => {
    expect(appSource).not.toContain("const cloudCostsOnlyServerless");
    expect(appSource).not.toContain("infra: tabVisibility.infra && !cloudCostsOnlyServerless");
    expect(appSource).not.toContain('activeTab === "infra" && !runtimeTabVisibility.infra');
  });

  it("uses one dark slate border token for rail controls and Export", () => {
    expect(styles).toContain("--rail-control-border: #315F70;");
    expect(styles).toContain(".rail-control-border");
    expect(appSource).toMatch(
      /aria-label="Export"[\s\S]{0,250}className="rail-control-border/,
    );
    expect(appSource).toMatch(
      /aria-label="Export"[\s\S]{0,350}bg-\[#1B5F96\][\s\S]{0,100}hover:bg-\[#2272B4\]/,
    );
  });

  it("keeps rail actions together without a redundant Admin badge", () => {
    expect(appSource).not.toContain('{user.role === "admin" && (');
    expect(appSource).toContain('className="flex shrink-0 items-center gap-[4px]"');
    expect(appSource).not.toContain('className="-ml-[8px]');
  });

  it("wraps narrow chrome while keeping navigation horizontally controlled", () => {
    expect(appSource).toContain(
      'data-testid="account-rail" className="min-h-[52px] overflow-visible',
    );
    expect(appSource).toContain("min-w-0 flex-wrap items-center");
    expect(appSource).toContain(
      'className="order-last flex w-full min-w-0 items-center',
    );
    expect(appSource).toContain('className="flex flex-wrap items-center gap-4"');
    expect(appSource).toContain("overflow-x-auto overflow-y-hidden");
  });

  it("places deployment provenance beside Built on Databricks", () => {
    const badgeIndex = appSource.lastIndexOf("<DeploymentBadgeFromApi");
    const accountIndex = appSource.lastIndexOf('label="account ID"');
    const workspaceFilterIndex = appSource.lastIndexOf("<WorkspaceFilter");
    const builtOnIndex = appSource.lastIndexOf('href="https://www.databricks.com"');
    const servicePrincipalBadgeIndex = appSource.lastIndexOf(
      'label="service principal ID"',
    );

    expect(badgeIndex).toBeGreaterThan(0);
    expect(badgeIndex).toBeGreaterThan(builtOnIndex);
    expect(badgeIndex).toBeLessThan(workspaceFilterIndex);
    expect(badgeIndex).toBeLessThan(accountIndex);
    expect(workspaceFilterIndex).toBeLessThan(accountIndex);
    expect(accountIndex).toBeLessThan(servicePrincipalBadgeIndex);
    expect(appSource).not.toContain(">ACCOUNT</span>");
    expect(appSource).toContain('className="flex shrink-0 items-center gap-[4px]"');
  });

  it("uses the same direct hover-copy state for the account ID", () => {
    expect(appSource).not.toContain("<InfoPopover");
    expect(appSource).toContain("RAIL_STATUS_BADGE_CLASS");
    expect(appSource).toContain("h-[22px] w-[104px]");
    expect(appSource).toContain("rounded-[4px]");
    expect(appSource).toContain("rail-status-badge");
    expect(styles).toContain("border: 1px solid rgba(74, 222, 128, 0.28) !important;");
    expect(styles).toContain("font-size: 10px !important;");
    expect(styles).toContain("font-weight: 700 !important;");
    expect(styles).toContain("width: 104px !important;");
    expect(styles).toContain("height: 22px !important;");
    expect(styles).toContain("padding: 0 6px 0 16px !important;");
    expect(styles).toContain(".rail-status-dot");
    expect(styles).toContain("left: 7px;");
    expect(appSource).toContain("bg-green-500/20");
    expect(appSource).toContain("text-[10px]");
    expect(appSource).toContain("font-bold");
    expect(appSource).toContain("compactRailBadgeText(text)");
    expect(appSource).toContain("function RailBadgeTooltip");
    expect(appSource).toContain('role="tooltip"');
    expect(appSource).toContain("SQL warehouse status:");
    expect(appSource).toContain('"cost-obs:rail-tooltip-open"');
    expect(appSource).toContain("(event as CustomEvent<string>).detail === tooltipId");
    expect(appSource).toContain('const maxLength = /^\\d/.test(text) ? 8 : 11;');
    expect(appSource).not.toContain('className="max-w-[128px] truncate"');
    expect(appSource).toContain("className={RAIL_STATUS_BADGE_CLASS}");
    expect(appSource).toContain(
      'className="hidden h-2.5 w-2.5 opacity-80 group-hover:block group-focus:block"',
    );
    expect(appSource).toContain("<DuBoisAccountIcon");
    expect(appSource).toContain("<Bot");
    expect(appSource).toContain("<DatabricksSqlProductIcon");
    expect(appSource).toContain("<strong>{entity} display name:</strong>");
    expect(appSource).toContain("<strong>{entity} ID:</strong>");
    expect(appSource).toContain('entity="Account"');
    expect(appSource).toContain('entity="Service principal"');
    expect(appSource).toContain('entity="SQL warehouse"');
    expect(appSource).toContain('className="font-mono text-[10.5px]"');
    expect(appSource).toContain(
      'value={accountInfo?.account_id || accountInfo?.account_name || "Databricks account"}',
    );
    expect(appSource).toContain(
      'text={accountInfo?.account_name || "Databricks account"}',
    );
    expect(appSource).toContain('label="account ID"');
    expect(styles).not.toContain(".account-id-tooltip-content");
    expect(styles).not.toContain(".deployment-badge-tooltip");
  });

  it("sets the app font before React renders and prevents late font swaps", () => {
    expect(html).toContain('html, body, button, input, select, textarea, dialog');
    expect(html).toContain('button, input, select, textarea { font: inherit; }');
    expect(html).toContain('--sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;');
    expect(styles).not.toContain("@font-face");
    expect(styles).toMatch(/button,\s*input,\s*select,\s*textarea\s*\{\s*font: inherit;/);
  });

  it("gives every copyable status badge the shared perceptible pulse", () => {
    expect(appSource.match(/<CopyableRailBadge/g)).toHaveLength(3);
    expect(appSource.match(/healthy-status-dot/g)).toHaveLength(1);
    expect(appSource).toContain('label="SQL warehouse ID"');
    expect(appSource).toContain("warehouseStatus.warehouse_name?.trim()");
    expect(styles).toMatch(
      /\.healthy-status-dot\s*\{[\s\S]*animation:\s*healthyStatusBlink 11s ease-out infinite/,
    );
    expect(styles).toContain("opacity: 0.35;");
    expect(styles).toContain("transform: scale(1.32);");
    expect(styles).toContain("box-shadow: 0 0 0 4px rgba(60, 214, 143, 0.32);");
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.healthy-status-dot[\s\S]*animation: none !important/,
    );
  });

  it("places one combined scope reset after both filter dropdowns", () => {
    expect(appSource).toContain("showClearButton={false}");
    expect(appSource).toContain("resetVersion={scopeResetVersion}");
    expect(appSource).toContain('aria-label="Clear workspace and source filters"');
    expect(appSource.indexOf("<SourceLabelFilter")).toBeLessThan(
      appSource.indexOf('aria-label="Clear workspace and source filters"'),
    );
    expect(appSource).toContain("setActiveSourceLabels([])");
    expect(appSource).toContain("setActiveSourceRouting([], [])");
    expect(appSource).toContain('scopeOwner === "source"');
    expect(appSource).toContain('scopeOwner === "workspace"');
    expect(appSource).toContain('scopeOwner === "source" ? sourceFilteredWorkspaceList : wsFilterList');
    expect(appSource).toContain('controlling={scopeOwner === "source"}');
    expect(appSource).toContain('setScopeOwner(null)');
    expect(appSource).toContain('origin === "rollback"');
    expect(appSource).toContain('selectedWorkspaceIds.length > 0');
    expect(appSource).toContain("if (workspaceIds.length === 0)");
    expect(appSource).toContain("isLoading={wsListLoading}");
    expect(appSource).toContain("isRefreshing={wsListLoading}");
    expect(appSource).not.toContain("isRefreshing={showActiveTabLoading}");
  });

  it("labels the SP name correctly and copies the same ID used by Settings", () => {
    expect(appSource).not.toContain('RAIL_COPY_BADGE_CLASS');
    expect(appSource.match(/RAIL_STATUS_BADGE_CLASS/g)?.length).toBeGreaterThanOrEqual(3);
    expect(appSource).not.toContain('trailing="ID"');
    expect(appSource).not.toContain('trailing="Name"');
    expect(appSource).toContain(
      'value={authStatus.sp_object_id || authStatus.sp_client_id || ""}',
    );
    expect(appSource).toContain(
      'text={authStatus.sp_display_name || authStatus.sp_object_id || authStatus.sp_client_id || ""}',
    );
    expect(appSource).toContain('label="service principal ID"');
    expect(appSource).not.toContain('label="service principal display name"');
    expect(appSource).not.toContain(
      'value={authStatus.sp_user_name || authStatus.sp_client_id || ""}',
    );
  });
});
