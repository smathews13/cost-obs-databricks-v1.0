import type { ExportSections } from "@/components/ExportDialog";

type Row = Record<string, unknown>;

function escape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function toCsv(headers: string[], rows: Row[]): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

function block(title: string, headers: string[], rows: Row[]): string {
  if (!rows.length) return "";
  return `## ${title}\n${toCsv(headers, rows)}\n`;
}

function fmt(n: unknown, decimals = 2): string {
  return Number(n ?? 0).toFixed(decimals);
}

export function generateCostCSV(
  data: any,
  sections: ExportSections,
  dateRange: { start: string; end: string }
): void {
  const parts: string[] = [
    `# Cost Observability Report — ${dateRange.start} to ${dateRange.end}\n`,
  ];

  if (sections.summary && data.summary) {
    const s = data.summary;
    parts.push(
      block("Executive Summary", ["metric", "value"], [
        { metric: "Total DBUs", value: fmt(s.total_dbus) },
        { metric: "Total Spend ($)", value: fmt(s.total_spend) },
        { metric: "Workspace Count", value: String(s.workspace_count ?? 0) },
        { metric: "Date Range", value: `${dateRange.start} to ${dateRange.end}` },
      ])
    );
  }

  if (sections.products && data.products?.products?.length) {
    parts.push(
      block(
        "Product Breakdown",
        ["category", "total_dbus", "total_spend_usd"],
        data.products.products.map((p: any) => ({
          category: p.category,
          total_dbus: fmt(p.total_dbus),
          total_spend_usd: fmt(p.total_spend),
        }))
      )
    );
  }

  if (sections.workspaces && data.workspaces?.workspaces?.length) {
    parts.push(
      block(
        "Workspace Breakdown",
        ["workspace_id", "workspace_name", "total_spend_usd", "total_dbus"],
        data.workspaces.workspaces.map((w: any) => ({
          workspace_id: w.workspace_id,
          workspace_name: w.workspace_name ?? w.workspace_id,
          total_spend_usd: fmt(w.total_spend),
          total_dbus: fmt(w.total_dbus),
        }))
      )
    );
  }

  if (sections.skus && data.skus?.skus?.length) {
    parts.push(
      block(
        "SKU Breakdown",
        ["sku_name", "total_dbus", "total_spend_usd"],
        data.skus.skus.map((s: any) => ({
          sku_name: s.sku_name,
          total_dbus: fmt(s.total_dbus),
          total_spend_usd: fmt(s.total_spend),
        }))
      )
    );
  }

  // PipelineObjectsResponse: { objects: PipelineObject[] }
  if (sections.pipelines && data.pipelineObjects?.objects?.length) {
    parts.push(
      block(
        "Jobs & Pipelines",
        ["object_id", "object_name", "object_type", "total_spend_usd", "total_dbus"],
        data.pipelineObjects.objects.slice(0, 100).map((j: any) => ({
          object_id: j.object_id,
          object_name: j.object_name ?? j.object_id,
          object_type: j.object_type ?? "",
          total_spend_usd: fmt(j.total_spend),
          total_dbus: fmt(j.total_dbus),
        }))
      )
    );
  }

  // InteractiveBreakdownResponse: { items: InteractiveItem[] }
  if (sections.interactive && data.interactiveBreakdown?.items?.length) {
    parts.push(
      block(
        "Interactive Compute",
        ["cluster_id", "cluster_name", "total_spend_usd", "total_dbus"],
        data.interactiveBreakdown.items.slice(0, 100).map((c: any) => ({
          cluster_id: c.cluster_id,
          cluster_name: c.cluster_name ?? c.cluster_id,
          total_spend_usd: fmt(c.total_spend),
          total_dbus: fmt(c.total_dbus),
        }))
      )
    );
  }

  // AIMLDashboardBundle: { categories: AIMLCategoriesResponse }
  // AIMLCategoriesResponse: { categories: AIMLCategory[] }
  if (sections.aiml && data.aiml?.categories?.categories?.length) {
    parts.push(
      block(
        "AI/ML by Category",
        ["category", "total_spend_usd", "total_dbus"],
        data.aiml.categories.categories.map((c: any) => ({
          category: c.category,
          total_spend_usd: fmt(c.total_spend),
          total_dbus: fmt(c.total_dbus),
        }))
      )
    );
  }

  // AppsDashboardBundle: { apps: AppsAppsResponse }
  // AppsAppsResponse: { apps: AppsApp[] }
  if (sections.apps && data.apps?.apps?.apps?.length) {
    parts.push(
      block(
        "Apps Cost",
        ["app_name", "total_spend_usd", "total_dbus"],
        data.apps.apps.apps.map((a: any) => ({
          app_name: a.app_name ?? a.app_id,
          total_spend_usd: fmt(a.total_spend),
          total_dbus: fmt(a.total_dbus),
        }))
      )
    );
  }

  // TaggingDashboardBundle: { cost_by_tag: TagCostResponse }
  // TagCostResponse: { tags: TagCost[] }
  if (sections.tagging && data.tagging?.cost_by_tag?.tags?.length) {
    parts.push(
      block(
        "Cost by Tag",
        ["tag_key", "tag_value", "total_spend_usd"],
        data.tagging.cost_by_tag.tags.slice(0, 200).map((t: any) => ({
          tag_key: t.tag_key,
          tag_value: t.tag_value,
          total_spend_usd: fmt(t.total_spend),
        }))
      )
    );
  }

  // UsersGroupsBundle: { top_users: UserSpend[] }
  // UserSpend: { user_email, total_spend, total_dbus }
  if (sections.users && data.users?.top_users?.length) {
    parts.push(
      block(
        "Top Users by Spend",
        ["user_email", "total_spend_usd", "total_dbus"],
        data.users.top_users.slice(0, 100).map((u: any) => ({
          user_email: u.user_email ?? u.run_as_user ?? u.user_name,
          total_spend_usd: fmt(u.total_spend),
          total_dbus: fmt(u.total_dbus),
        }))
      )
    );
  }

  // Alerts: /api/alerts/recent returns { spikes: [...], total_alerts: N }
  const alertSpikes = data.alerts?.spikes ?? data.alerts?.alerts;
  if (sections.alerts && alertSpikes?.length) {
    parts.push(
      block(
        "Spend Spikes",
        ["date", "product_category", "daily_spend_usd", "prev_spend_usd", "pct_change"],
        alertSpikes.slice(0, 200).map((a: any) => ({
          date: a.usage_date ?? a.date ?? a.triggered_at ?? "",
          product_category: a.product_category ?? a.metric ?? "",
          daily_spend_usd: fmt(a.daily_spend ?? a.current_spend ?? a.threshold),
          prev_spend_usd: fmt(a.prev_daily_spend ?? a.previous_spend),
          pct_change: fmt(a.pct_change ?? a.spike_percent),
        }))
      )
    );
  }

  const csv = parts.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cost-obs-${dateRange.start}-to-${dateRange.end}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
