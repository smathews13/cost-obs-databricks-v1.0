import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { format, parseISO, eachMonthOfInterval, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isWithinInterval } from "date-fns";
import type {
  BillingSummary,
  ProductBreakdownResponse,
  WorkspaceBreakdownResponse,
  SKUBreakdownResponse,
  SpendAnomaliesResponse,
  PipelineObjectsResponse,
  InteractiveBreakdownResponse,
  AWSCostsResponse,
  AIMLDashboardBundle,
  AppsDashboardBundle,
  TaggingDashboardBundle,
  PlatformKPIsResponse,
  DBSQLDashboardBundle,
  QueryCostBySource,
  QueryCostByWarehouse,
  QueryCostByUser,
  ExpensiveQuery,
} from "@/types/billing";
import type { UsersGroupsBundle } from "@/hooks/useBillingData";
import type { ExportSections } from "@/components/ExportDialog";
import { formatCurrency, formatNumber } from "./formatters";

// Optimize tab exports — pulled from /api/sql/warehouse-health and
// /api/sql/warehouse-health/idle-time; kept structural so the two views
// can evolve independently without churning the PDF payload.
export interface OptimizeExport {
  rightsizing?: {
    available: boolean;
    warehouses_analyzed: number;
    recommendations: Array<{
      warehouse_id: string;
      warehouse_name: string | null;
      warehouse_size: string | null;
      workspace_id: string;
      recommendation_type: string;
      recommendation_text: string;
    }>;
  };
  idle?: {
    available: boolean;
    serverless_detected: boolean;
    warehouses: Array<{
      warehouse_id: string;
      warehouse_name: string;
      warehouse_size: string;
      warehouse_type: string;
      workspace_id: string;
      idle_minutes: number;
      idle_pct: number;
      total_spend: number;
      estimated_idle_spend: number;
    }>;
  };
}

// Databricks navy — unified header color for all PDF tables
const DB_HEADER: [number, number, number] = [27, 49, 57];
// Databricks brand orange — section titles and accent elements
const DB_ORANGE: [number, number, number] = [255, 54, 33];
// Subtle warm alternating row tint for striped tables
const DB_ALT_ROW: [number, number, number] = [248, 249, 250];

// jspdf-autotable extends jsPDF with lastAutoTable. This helper avoids
// scattering `(doc as any)` casts throughout the file.
function getLastTableY(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
}

// Colors pre-blended against white (jsPDF fills are opaque, no alpha).
// Mirrors the heatmap tiers used in SpendAnomalies.cellStyle so the exported
// calendar looks like the on-screen one.
function heatmapCellColor(changePercent: number): { fill: [number, number, number]; text: [number, number, number] } {
  const abs = Math.abs(changePercent);
  if (changePercent > 0) {
    if (abs >= 30) return { fill: [226, 77, 77], text: [255, 255, 255] };
    if (abs >= 15) return { fill: [244, 133, 133], text: [255, 255, 255] };
    if (abs >= 5)  return { fill: [253, 208, 208], text: [153, 27, 27] };
    return           { fill: [254, 243, 243], text: [220, 38, 38] };
  } else {
    if (abs >= 30) return { fill: [72, 195, 118], text: [255, 255, 255] };
    if (abs >= 15) return { fill: [99, 217, 150], text: [255, 255, 255] };
    if (abs >= 5)  return { fill: [192, 247, 212], text: [20, 83, 45] };
    return           { fill: [240, 253, 245], text: [21, 128, 61] };
  }
}

// Draws a compact calendar heatmap of daily spend changes to mirror the
// SpendAnomalies calendar view. Renders two months per PDF row. Returns the
// updated yPos.
function drawSpendCalendar(
  doc: jsPDF,
  anomalies: Array<{ usage_date: string; change_percent: number }>,
  startDate: string,
  endDate: string,
  yStart: number,
): number {
  const anomalyMap = new Map<string, number>();
  for (const a of anomalies) anomalyMap.set(a.usage_date, a.change_percent);

  const start = parseISO(startDate);
  const end = parseISO(endDate);
  const months = eachMonthOfInterval({ start, end });
  const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;
  const marginX = 14;
  const gap = 6;
  const monthW = (pageWidth - marginX * 2 - gap) / 2;
  const cell = monthW / 7;
  const headerH = 5; // month label
  const dowH = 4;    // day-of-week row
  const monthH = headerH + dowH + cell * 6 + 2;

  let yPos = yStart;
  for (let i = 0; i < months.length; i++) {
    const col = i % 2;
    // Only advance yPos + paginate at the start of a row so the two months in
    // one row always stay on the same page. Otherwise month #2 could land alone
    // on the next page when month #1 fits but the row spills past the fold.
    if (col === 0) {
      if (i > 0) yPos += monthH + 4;
      if (yPos + monthH > pageHeight - 20) {
        doc.addPage();
        yPos = 20;
      }
    }
    const x0 = marginX + col * (monthW + gap);
    const month = months[i];

    // Month label
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(55, 65, 81);
    doc.text(format(month, "MMMM yyyy"), x0, yPos + headerH - 1);

    // Day-of-week headers
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    for (let d = 0; d < 7; d++) {
      doc.text(DAY_INITIALS[d], x0 + cell * d + cell / 2, yPos + headerH + dowH - 1, { align: "center" });
    }

    // Day cells
    const monthStart = startOfMonth(month);
    const monthEnd = endOfMonth(month);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const firstDow = getDay(monthStart);
    const gridTop = yPos + headerH + dowH;
    doc.setFontSize(6);
    for (let d = 0; d < days.length; d++) {
      const day = days[d];
      const slot = firstDow + d;
      const row = Math.floor(slot / 7);
      const colIdx = slot % 7;
      const cx = x0 + cell * colIdx;
      const cy = gridTop + cell * row;

      const dateStr = format(day, "yyyy-MM-dd");
      const inRange = isWithinInterval(day, { start, end });
      const pct = anomalyMap.get(dateStr);
      const style = (inRange && pct !== undefined) ? heatmapCellColor(pct) : null;

      if (style) {
        doc.setFillColor(style.fill[0], style.fill[1], style.fill[2]);
      } else if (inRange) {
        doc.setFillColor(243, 244, 246);
      } else {
        doc.setFillColor(250, 250, 250);
      }
      doc.roundedRect(cx + 0.3, cy + 0.3, cell - 0.6, cell - 0.6, 0.6, 0.6, "F");

      // Day number, top-right
      doc.setFont("helvetica", "normal");
      doc.setFontSize(5);
      const dayColor = style ? style.text : ([75, 85, 99] as [number, number, number]);
      doc.setTextColor(dayColor[0], dayColor[1], dayColor[2]);
      doc.text(format(day, "d"), cx + cell - 0.8, cy + 1.6, { align: "right" });

      // Percent, centered
      if (style && pct !== undefined) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(6);
        const label = `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
        doc.text(label, cx + cell / 2, cy + cell / 2 + 1.2, { align: "center" });
      }
    }
  }

  return yPos + monthH;
}

export interface ExportData {
  summary: BillingSummary | undefined;
  products: ProductBreakdownResponse | undefined;
  workspaces: WorkspaceBreakdownResponse | undefined;
  skus: SKUBreakdownResponse | undefined;
  anomalies: SpendAnomaliesResponse | undefined;
  pipelineObjects: PipelineObjectsResponse | undefined;
  interactiveBreakdown: InteractiveBreakdownResponse | undefined;
  awsCosts: AWSCostsResponse | undefined;
  aiml: AIMLDashboardBundle | undefined;
  apps: AppsDashboardBundle | undefined;
  tagging: TaggingDashboardBundle | undefined;
  platformKPIs: PlatformKPIsResponse | undefined;
  query360: DBSQLDashboardBundle | undefined;
  users: UsersGroupsBundle | undefined;
  optimize: OptimizeExport | undefined;
  dateRange: { start: string; end: string };
  workspaceFilter?: { ids: string[]; names?: string[] };
}

export function generateCostReport(data: ExportData, sections?: ExportSections) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;
  let yPos = 20;

  // Default to all sections if not specified
  const includeSections: ExportSections = sections || {
    summary: true,
    products: true,
    workspaces: true,
    skus: true,
    pipelines: true,
    interactive: true,
    query360: true,
    aiml: true,
    apps: true,
    tagging: true,
    users: true,
    platformKPIs: true,
    anomalies: true,
    awsCosts: true,
    optimize: true,
  };

  // Read company name from settings for branding
  let companyName = "";
  try {
    const stored = localStorage.getItem("coc-app-settings");
    if (stored) {
      const settings = JSON.parse(stored);
      if (settings.companyName) companyName = settings.companyName;
    }
  } catch {
    // ignore
  }

  // Brand header bar — Databricks orange across top of page 1
  doc.setFillColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
  doc.rect(0, 0, pageWidth, 18, "F");

  // Title in white on the orange bar
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  const title = companyName ? `${companyName} — COST-OBS Report` : "COST-OBS Report";
  doc.text(title, pageWidth / 2, 12, { align: "center" });
  doc.setTextColor(0, 0, 0);
  yPos = 28;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(
    `Report generated on ${format(new Date(), "MMM d, yyyy 'at' h:mm a")}`,
    pageWidth / 2,
    yPos,
    { align: "center" }
  );
  yPos += 5;
  doc.text(
    `Date range: ${data.dateRange?.start || "—"} to ${data.dateRange?.end || "—"}`,
    pageWidth / 2,
    yPos,
    { align: "center" }
  );
  yPos += 5;
  const wfLabel = data.workspaceFilter?.ids?.length
    ? `Workspace filter: ${data.workspaceFilter.names?.length ? data.workspaceFilter.names.join(", ") : data.workspaceFilter.ids.join(", ")}`
    : "Workspace filter: All workspaces (account-wide)";
  doc.text(wfLabel, pageWidth / 2, yPos, { align: "center" });
  yPos += 10;

  // Executive Summary
  if (includeSections.summary && data.summary) {
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Executive Summary", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");

    const summaryData = [
      ["Total DBUs Consumed", formatNumber(data.summary.total_dbus)],
      ["Total Spend", formatCurrency(data.summary.total_spend)],
      ["Average Daily Spend", formatCurrency(data.summary.avg_daily_spend)],
      ["Active Workspaces", data.summary.workspace_count.toString()],
      ["Days in Range", data.summary.days_in_range.toString()],
    ];

    autoTable(doc, {
      startY: yPos,
      head: [["Metric", "Value"]],
      body: summaryData,
      theme: "grid",
      headStyles: { fillColor: DB_HEADER, fontSize: 10 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 15;
  }

  // Check if we need a new page
  if (yPos > 250) {
    doc.addPage();
    yPos = 20;
  }

  // Top 10 Products by Spend
  if (includeSections.products && data.products && data.products.products.length > 0) {
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Top 10 Products by Spend", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const productData = data.products.products
      .slice(0, 10)
      .map((p) => [
        p.category,
        formatNumber(p.total_dbus),
        formatCurrency(p.total_spend),
        `${p.percentage.toFixed(1)}%`,
      ]);

    autoTable(doc, {
      startY: yPos,
      head: [["Product", "DBUs", "Spend", "%"]],
      body: productData,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // Check if we need a new page
  if (yPos > 230) {
    doc.addPage();
    yPos = 20;
  }

  // Top 10 Workspaces by Spend
  if (includeSections.workspaces && data.workspaces && data.workspaces.workspaces.length > 0) {
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Top 10 Workspaces by Spend", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const workspaceData = data.workspaces.workspaces
      .slice(0, 10)
      .map((w) => [
        w.workspace_name || w.workspace_id,
        formatNumber(w.total_dbus),
        formatCurrency(w.total_spend),
        `${w.percentage.toFixed(1)}%`,
      ]);

    autoTable(doc, {
      startY: yPos,
      head: [["Workspace", "DBUs", "Spend", "%"]],
      body: workspaceData,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // Check if we need a new page
  if (yPos > 230) {
    doc.addPage();
    yPos = 20;
  }

  // Top 10 SKUs by Spend
  if (includeSections.skus && data.skus && data.skus.skus.length > 0) {
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Top 10 SKUs by Spend", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const skuData = data.skus.skus.slice(0, 10).map((s) => [
      s.product.length > 40 ? s.product.substring(0, 37) + "..." : s.product,
      s.workspaces_using.toString(),
      formatCurrency(s.total_spend),
      `${s.percentage.toFixed(1)}%`,
    ]);

    autoTable(doc, {
      startY: yPos,
      head: [["SKU Name", "Workspaces", "Spend", "%"]],
      body: skuData,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 8 },
      margin: { left: 14, right: 14 },
      columnStyles: {
        0: { cellWidth: 80 },
      },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // Top 10 Pipeline Objects
  if (includeSections.pipelines && data.pipelineObjects && data.pipelineObjects.objects.length > 0) {
    if (yPos > 180) {
      doc.addPage();
      yPos = 20;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Top 10 Jobs & Pipelines by Spend", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const pipelineData = data.pipelineObjects.objects.slice(0, 10).map((p) => [
      p.object_type === "SDP Pipeline" ? "SDP" : "Job",
      p.object_name.length > 30 ? p.object_name.substring(0, 27) + "..." : p.object_name,
      formatCurrency(p.total_spend),
      formatNumber(p.total_runs),
    ]);

    autoTable(doc, {
      startY: yPos,
      head: [["Type", "Name", "Spend", "Runs"]],
      body: pipelineData,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 8 },
      margin: { left: 14, right: 14 },
      columnStyles: {
        1: { cellWidth: 80 },
      },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // Interactive Compute
  if (includeSections.interactive && data.interactiveBreakdown && data.interactiveBreakdown.items.length > 0) {
    if (yPos > 180) {
      doc.addPage();
      yPos = 20;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Top 10 Interactive Compute by Spend", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const interactiveData = data.interactiveBreakdown.items.slice(0, 10).map((i) => [
      i.cluster_id || "Unknown",
      (i.user || "Unknown").length > 20 ? (i.user || "Unknown").substring(0, 17) + "..." : (i.user || "Unknown"),
      formatCurrency(i.total_spend),
      i.days_active.toString(),
    ]);

    autoTable(doc, {
      startY: yPos,
      head: [["Cluster ID", "User", "Spend", "Days Active"]],
      body: interactiveData,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 8 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // AWS Infrastructure
  if (includeSections.awsCosts && data.awsCosts) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Cloud Costs", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(
      `Total Estimated AWS Cost: ${formatCurrency(data.awsCosts.total_estimated_cost)}`,
      14,
      yPos
    );
    yPos += 5;
    doc.text(
      `Based on ${formatNumber(data.awsCosts.total_dbu_hours)} DBU hours across ${data.awsCosts.clusters.length} clusters`,
      14,
      yPos
    );
    yPos += 10;

    if (data.awsCosts.disclaimer) {
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      const disclaimerLines = doc.splitTextToSize(data.awsCosts.disclaimer, pageWidth - 28);
      doc.text(disclaimerLines, 14, yPos);
      yPos += disclaimerLines.length * 4 + 8;
      doc.setTextColor(0, 0, 0);
    }

    if (data.awsCosts.clusters.length > 0) {
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 Clusters by AWS Cost", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const clusterData = data.awsCosts.clusters.slice(0, 10).map((c) => [
        (c.cluster_name || c.cluster_id || "Unknown").length > 25
          ? (c.cluster_name || c.cluster_id || "Unknown").substring(0, 22) + "..."
          : c.cluster_name || c.cluster_id || "Unknown",
        c.driver_instance_type || "-",
        c.worker_instance_type || "-",
        formatCurrency(c.estimated_aws_cost),
        formatNumber(c.total_dbu_hours),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Cluster", "Driver Type", "Worker Type", "AWS Cost", "DBU Hrs"]],
        body: clusterData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 8 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 7 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 45 },
          1: { cellWidth: 30 },
          2: { cellWidth: 30 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    if (data.awsCosts.instance_families && data.awsCosts.instance_families.length > 0) {
      if (yPos > 230) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 5 Instance Families by Usage", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const familyData = data.awsCosts.instance_families.slice(0, 5).map((f) => {
        const percentage = data.awsCosts?.total_dbu_hours ? (f.total_dbu_hours / data.awsCosts.total_dbu_hours) * 100 : 0;
        return [
          f.instance_family || "Unknown",
          formatNumber(f.total_dbu_hours),
          `${percentage.toFixed(1)}%`,
        ];
      });

      autoTable(doc, {
        startY: yPos,
        head: [["Instance Family", "DBU Hours", "% of Total"]],
        body: familyData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 9 },
        margin: { left: 14, right: 14 },
      });

      yPos = getLastTableY(doc) + 12;
    }
  }

  // AI/ML 360
  if (includeSections.aiml && data.aiml) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("AI/ML", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    // Summary
    const aimlSummary = data.aiml.summary;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Total AI/ML Spend: ${formatCurrency(aimlSummary.total_spend)}`, 14, yPos);
    yPos += 5;
    doc.text(`Total DBUs: ${formatNumber(aimlSummary.total_dbus)}`, 14, yPos);
    yPos += 5;
    doc.text(`Active Endpoints: ${aimlSummary.endpoint_count}`, 14, yPos);
    yPos += 5;
    doc.text(`Average Daily Spend: ${formatCurrency(aimlSummary.avg_daily_spend)}`, 14, yPos);
    yPos += 12;

    // Category breakdown
    if (data.aiml.categories?.categories?.length > 0) {
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("AI/ML Costs by Category", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const categoryData = data.aiml.categories.categories.map((c) => [
        c.category,
        formatNumber(c.total_dbus),
        formatCurrency(c.total_spend),
        `${c.percentage.toFixed(1)}%`,
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Category", "DBUs", "Spend", "%"]],
        body: categoryData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 9 },
        margin: { left: 14, right: 14 },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // FMAPI Providers
    if (data.aiml.providers?.providers?.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("FMAPI Provider Costs", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const providerData = data.aiml.providers.providers.map((p) => [
        p.provider,
        p.sku_name.length > 35 ? p.sku_name.substring(0, 32) + "..." : p.sku_name,
        formatCurrency(p.total_spend),
        `${p.percentage.toFixed(1)}%`,
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Provider", "SKU", "Spend", "%"]],
        body: providerData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          1: { cellWidth: 70 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top Endpoints
    if (data.aiml.endpoints?.endpoints?.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 Serverless Inference Endpoints", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const endpointData = data.aiml.endpoints.endpoints.slice(0, 10).map((e) => [
        (e.endpoint_name || "UNKNOWN").length > 30
          ? (e.endpoint_name || "UNKNOWN").substring(0, 27) + "..."
          : e.endpoint_name || "UNKNOWN",
        e.cost_type,
        formatCurrency(e.total_spend),
        e.days_active.toString(),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Endpoint", "Cost Type", "Spend", "Days"]],
        body: endpointData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 70 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top Models
    if (data.aiml.models?.models?.length && data.aiml.models.models.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 Models by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const modelRows = data.aiml.models.models.slice(0, 10).map((m) => [
        m.model_name.length > 32 ? m.model_name.substring(0, 29) + "..." : m.model_name,
        m.model_type,
        formatNumber(m.total_dbus),
        formatCurrency(m.total_spend),
        m.days_active.toString(),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Model", "Type", "DBUs", "Spend", "Days"]],
        body: modelRows,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 60 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top ML Clusters
    if (data.aiml.ml_clusters?.clusters?.length && data.aiml.ml_clusters.clusters.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 ML Clusters by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const clusterRows = data.aiml.ml_clusters.clusters.slice(0, 10).map((c) => [
        c.cluster_name.length > 28 ? c.cluster_name.substring(0, 25) + "..." : c.cluster_name,
        c.runtime_version || "—",
        (c.owner || "—").length > 20 ? (c.owner || "—").substring(0, 17) + "..." : c.owner || "—",
        formatCurrency(c.total_spend),
        c.days_active.toString(),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Cluster", "Runtime", "Owner", "Spend", "Days"]],
        body: clusterRows,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top Agent Bricks
    if (data.aiml.agent_bricks?.agents?.length && data.aiml.agent_bricks.agents.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 Agents by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const agentRows = data.aiml.agent_bricks.agents.slice(0, 10).map((a) => [
        (a.agent_name || "—").length > 28 ? (a.agent_name || "—").substring(0, 25) + "..." : a.agent_name || "—",
        a.agent_type || "Agent",
        formatCurrency(a.total_spend),
        formatCurrency(a.avg_daily_spend),
        a.days_active.toString(),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Agent", "Type", "Spend", "Avg/Day", "Days"]],
        body: agentRows,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 60 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }
  }

  // Apps
  if (includeSections.apps && data.apps) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Apps", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    // Summary
    const appsSummary = data.apps.summary;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Total Apps Spend: ${formatCurrency(appsSummary.total_spend)}`, 14, yPos);
    yPos += 5;
    doc.text(`Total DBUs: ${formatNumber(appsSummary.total_dbus)}`, 14, yPos);
    yPos += 5;
    doc.text(`Active Apps: ${appsSummary.app_count}`, 14, yPos);
    yPos += 5;
    doc.text(`Average Daily Spend: ${formatCurrency(appsSummary.avg_daily_spend)}`, 14, yPos);
    yPos += 12;

    // Per-app breakdown
    if (data.apps.apps?.apps?.length > 0) {
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top Apps by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const appsRows = [...data.apps.apps.apps]
        .sort((a, b) => (b.total_spend || 0) - (a.total_spend || 0))
        .slice(0, 15)
        .map((a) => [
          (a.app_name || a.app_id || "Unknown").length > 30
            ? (a.app_name || a.app_id || "Unknown").substring(0, 27) + "..."
            : a.app_name || a.app_id || "Unknown",
          formatNumber(a.total_dbus),
          formatCurrency(a.total_spend),
          `${a.percentage.toFixed(1)}%`,
          a.days_active?.toString() || "-",
        ]);

      autoTable(doc, {
        startY: yPos,
        head: [["App Name", "DBUs", "Spend", "%", "Days Active"]],
        body: appsRows,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 60 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

  }

  // Tagging
  if (includeSections.tagging && data.tagging) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Tagging", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    // Summary
    const taggingSummary = data.tagging.summary;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Total Spend: ${formatCurrency(taggingSummary.total_spend)}`, 14, yPos);
    yPos += 5;
    doc.setTextColor(16, 185, 129); // green
    doc.text(`Tagged Spend: ${formatCurrency(taggingSummary.tagged_spend)} (${taggingSummary.tagged_percentage.toFixed(1)}%)`, 14, yPos);
    yPos += 5;
    doc.setTextColor(239, 68, 68); // red
    doc.text(`Untagged Spend: ${formatCurrency(taggingSummary.untagged_spend)} (${taggingSummary.untagged_percentage.toFixed(1)}%)`, 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 5;
    // Cost Per-Tag + Total Tags KPIs (populated by the MV fast path on daily_tag_summary).
    if (typeof data.tagging.avg_cost_per_tag === "number" && data.tagging.avg_cost_per_tag != null) {
      doc.text(`Avg Cost Per Tag: ${formatCurrency(data.tagging.avg_cost_per_tag)} (over ${taggingSummary.total_spend ? "date range" : "—"})`, 14, yPos);
      yPos += 5;
    }
    if (typeof data.tagging.total_tag_count === "number" && data.tagging.total_tag_count != null) {
      doc.text(`Total Unique Tags (key:value): ${formatNumber(data.tagging.total_tag_count)}`, 14, yPos);
      yPos += 5;
    }
    yPos += 7;

    // Tag Coverage Summary
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
    doc.text("Tag Coverage Summary", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 6;

    const coverageData = [
      ["Tagged Spend", formatCurrency(taggingSummary.tagged_spend), `${taggingSummary.tagged_percentage.toFixed(1)}%`],
      ["Untagged Spend", formatCurrency(taggingSummary.untagged_spend), `${taggingSummary.untagged_percentage.toFixed(1)}%`],
    ];

    autoTable(doc, {
      startY: yPos,
      head: [["Category", "Spend", "Percentage"]],
      body: coverageData,
      theme: "grid",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;

    // Top Tags by Spend
    if (data.tagging.cost_by_tag?.tags?.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 15 Tags by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const tagData = data.tagging.cost_by_tag.tags.slice(0, 15).map((t) => [
        t.tag_key.length > 20 ? t.tag_key.substring(0, 17) + "..." : t.tag_key,
        t.tag_value.length > 25 ? t.tag_value.substring(0, 22) + "..." : t.tag_value,
        formatCurrency(t.total_spend),
        `${t.percentage.toFixed(1)}%`,
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Tag Key", "Tag Value", "Spend", "%"]],
        body: tagData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 40 },
          1: { cellWidth: 55 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Untagged Resources Summary
    const untagged = data.tagging.untagged;
    const untaggedSummary = [
      ["Clusters", (untagged.clusters?.count || 0).toString(), formatCurrency(untagged.clusters?.total_spend || 0)],
      ["Jobs", (untagged.jobs?.count || 0).toString(), formatCurrency(untagged.jobs?.total_spend || 0)],
      ["SDP Pipelines", (untagged.pipelines?.count || 0).toString(), formatCurrency(untagged.pipelines?.total_spend || 0)],
      ["SQL Warehouses", (untagged.warehouses?.count || 0).toString(), formatCurrency(untagged.warehouses?.total_spend || 0)],
      ["Endpoints", (untagged.endpoints?.count || 0).toString(), formatCurrency(untagged.endpoints?.total_spend || 0)],
    ];

    if (yPos > 200) {
      doc.addPage();
      yPos = 20;
    }

    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
    doc.text("Untagged Resources Summary", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 6;

    autoTable(doc, {
      startY: yPos,
      head: [["Resource Type", "Count", "Untagged Spend"]],
      body: untaggedSummary,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // Platform KPIs & Trends
  if (includeSections.platformKPIs && data.platformKPIs) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Platform KPIs & Trends", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const kpi = data.platformKPIs;

    // Query metrics
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
    doc.text("Query Metrics", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 6;

    const queryMetrics = [
      ["Total Queries Executed", formatNumber(kpi.total_queries)],
      ["Unique Query Users", formatNumber(kpi.unique_query_users)],
      ["Total Rows Read", formatNumber(kpi.total_rows_read)],
      ["Total Data Read", `${(kpi.total_bytes_read / (1024 * 1024 * 1024)).toFixed(1)} GB`],
      ["Total Compute Time", `${(kpi.total_compute_seconds / 3600).toFixed(1)} hours`],
    ];

    autoTable(doc, {
      startY: yPos,
      head: [["Metric", "Value"]],
      body: queryMetrics,
      theme: "grid",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;

    // Job metrics
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
    doc.text("Job Metrics", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 6;

    const jobSuccessRate = kpi.total_job_runs > 0 ? ((kpi.successful_runs / kpi.total_job_runs) * 100).toFixed(1) : "N/A";
    const jobMetrics = [
      ["Total Jobs", formatNumber(kpi.total_jobs)],
      ["Total Job Runs", formatNumber(kpi.total_job_runs)],
      ["Successful Runs", formatNumber(kpi.successful_runs)],
      ["Job Success Rate", jobSuccessRate === "N/A" ? "N/A" : `${jobSuccessRate}%`],
      ["Unique Job Owners", formatNumber(kpi.unique_job_owners)],
    ];

    autoTable(doc, {
      startY: yPos,
      head: [["Metric", "Value"]],
      body: jobMetrics,
      theme: "grid",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;

    // Platform overview
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
    doc.text("Platform Overview", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 6;

    const platformMetrics = [
      ["Active Workspaces", formatNumber(kpi.active_workspaces)],
      ["Active Notebooks", formatNumber(kpi.active_notebooks)],
      ["Models Served", formatNumber(kpi.models_served)],
      ["Total Serving DBUs", formatNumber(kpi.total_serving_dbus)],
    ];

    autoTable(doc, {
      startY: yPos,
      head: [["Metric", "Value"]],
      body: platformMetrics,
      theme: "grid",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;
  }

  // Spend Anomalies — moved here from the DBU section because SpendAnomalies
  // actually renders inside PlatformKPIsView in the app; the PDF should mirror
  // the tab it lives under.
  if (includeSections.anomalies && data.anomalies && data.anomalies.anomalies.length > 0) {
    if (yPos > 180) {
      doc.addPage();
      yPos = 20;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Top 10 Spend Changes (Day-over-Day)", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const anomalyData = data.anomalies.anomalies.slice(0, 10).map((a) => [
      format(new Date(a.usage_date), "MMM d, yyyy"),
      formatCurrency(a.daily_spend),
      formatCurrency(a.prev_day_spend),
      formatCurrency(Math.abs(a.change_amount ?? 0)),
      `${Math.abs(a.change_percent ?? 0).toFixed(1)}%`,
    ]);

    autoTable(doc, {
      startY: yPos,
      head: [["Date", "Daily Spend", "Prev Day", "Change $", "Change %"]],
      body: anomalyData,
      theme: "striped",
      headStyles: { fillColor: DB_HEADER, fontSize: 9 },
      alternateRowStyles: { fillColor: DB_ALT_ROW },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });

    yPos = getLastTableY(doc) + 12;

    // Calendar heatmap of daily changes — mirrors the SpendAnomalies calendar view.
    if (yPos > 200) { doc.addPage(); yPos = 20; }
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
    doc.text("Daily Spend Change Calendar", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 6;
    yPos = drawSpendCalendar(doc, data.anomalies.anomalies, data.dateRange.start, data.dateRange.end, yPos);
    yPos += 8;
  }

  // Query 360 (SQL Warehousing)
  if (includeSections.query360 && data.query360) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Query", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    // Summary metrics table
    if (data.query360.summary) {
      const s = data.query360.summary;
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("SQL Warehouse Summary", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const summaryMetrics = [
        ["Total SQL Spend", formatCurrency(s.total_spend || 0)],
        ["Total DBUs", formatNumber(s.total_dbus || 0)],
        ["Total Queries", formatNumber(s.total_queries || 0)],
        ["Unique Users", formatNumber(s.unique_users || 0)],
        ["Unique Warehouses", formatNumber(s.unique_warehouses || 0)],
        ["Average Cost per Query", formatCurrency(s.avg_cost_per_query || 0)],
        ["Average Duration per Query", `${(s.avg_duration_seconds || 0).toFixed(1)}s`],
      ];

      autoTable(doc, {
        startY: yPos,
        head: [["Metric", "Value"]],
        body: summaryMetrics,
        theme: "grid",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        bodyStyles: { fontSize: 9 },
        margin: { left: 14, right: 14 },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Cost by query source type
    if (data.query360.by_source && data.query360.by_source.sources && data.query360.by_source.sources.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Cost by Query Source", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const sourceData = data.query360.by_source.sources.map((s: QueryCostBySource) => [
        s.query_source_type || "Unknown",
        formatNumber(s.query_count || 0),
        formatCurrency(s.total_spend || 0),
        formatCurrency(s.avg_cost_per_query || 0),
        `${(s.percentage || 0).toFixed(1)}%`,
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Source Type", "Queries", "Spend", "Avg/Query", "%"]],
        body: sourceData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top warehouses by spend
    if (data.query360.by_warehouse && data.query360.by_warehouse.warehouses && data.query360.by_warehouse.warehouses.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 SQL Warehouses by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const warehouseData = data.query360.by_warehouse.warehouses.slice(0, 10).map((w: QueryCostByWarehouse) => [
        (w.warehouse_name || w.warehouse_id || "Unknown").length > 25
          ? (w.warehouse_name || w.warehouse_id || "Unknown").substring(0, 22) + "..."
          : w.warehouse_name || w.warehouse_id || "Unknown",
        formatNumber(w.query_count || 0),
        formatNumber(w.unique_users || 0),
        formatCurrency(w.total_spend || 0),
        `${(w.percentage || 0).toFixed(1)}%`,
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["Warehouse", "Queries", "Users", "Spend", "%"]],
        body: warehouseData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 55 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top users by spend
    if (data.query360.by_user && data.query360.by_user.users && data.query360.by_user.users.length > 0) {
      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 Users by Query Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const userData = data.query360.by_user.users.slice(0, 10).map((u: QueryCostByUser) => [
        (u.executed_by || "Unknown").length > 25
          ? (u.executed_by || "Unknown").substring(0, 22) + "..."
          : u.executed_by || "Unknown",
        u.query_source_type || "-",
        formatNumber(u.query_count || 0),
        formatCurrency(u.total_spend || 0),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["User", "Source", "Queries", "Spend"]],
        body: userData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 8 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 55 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }

    // Top expensive queries
    if (data.query360.top_queries && data.query360.top_queries.queries && data.query360.top_queries.queries.length > 0) {
      if (yPos > 180) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 10 Most Expensive Queries", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const queryData = data.query360.top_queries.queries.slice(0, 10).map((q: ExpensiveQuery) => {
        const preview = q.statement_preview
          ? (q.statement_preview.length > 40 ? q.statement_preview.substring(0, 37) + "..." : q.statement_preview)
          : "-";
        return [
          (q.executed_by || "Unknown").length > 15
            ? (q.executed_by || "Unknown").substring(0, 12) + "..."
            : q.executed_by || "Unknown",
          preview,
          formatCurrency(q.cost || 0),
          `${(q.duration_seconds || 0).toFixed(1)}s`,
        ];
      });

      autoTable(doc, {
        startY: yPos,
        head: [["User", "Query Preview", "Cost", "Duration"]],
        body: queryData,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 7 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          1: { cellWidth: 75 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }
  }

  // Users
  if (includeSections.users && data.users) {
    doc.addPage();
    yPos = 20;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.text("Users", 14, yPos);
    doc.setTextColor(0, 0, 0);
    yPos += 8;

    const usersSummary = data.users.summary;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Total Spend: ${formatCurrency(usersSummary.total_spend)}`, 14, yPos);
    yPos += 5;
    doc.text(`Total DBUs: ${formatNumber(usersSummary.total_dbus)}`, 14, yPos);
    yPos += 5;
    doc.text(`Active Users: ${usersSummary.user_count}`, 14, yPos);
    yPos += 5;
    doc.text(`Avg Spend per User: ${formatCurrency(usersSummary.avg_spend_per_user)}`, 14, yPos);
    yPos += 12;

    if (data.users.top_users && data.users.top_users.length > 0) {
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
      doc.text("Top 20 Users by Spend", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      const usersRows = data.users.top_users.slice(0, 20).map((u) => [
        (u.user_email || "Unknown").length > 30
          ? (u.user_email || "Unknown").substring(0, 27) + "..."
          : u.user_email || "Unknown",
        u.primary_product || "-",
        formatNumber(u.total_dbus),
        formatCurrency(u.total_spend),
        `${u.percentage.toFixed(1)}%`,
        u.active_days.toString(),
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [["User", "Primary Product", "DBUs", "Spend", "%", "Active Days"]],
        body: usersRows,
        theme: "striped",
        headStyles: { fillColor: DB_HEADER, fontSize: 9 },
        alternateRowStyles: { fillColor: DB_ALT_ROW },
        bodyStyles: { fontSize: 7 },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 55 },
          1: { cellWidth: 35 },
        },
      });

      yPos = getLastTableY(doc) + 12;
    }
  }

  // Optimize — Warehouse Rightsizing + Idle Time summary tables (new tab, no PDF section before).
  if (includeSections.optimize && data.optimize) {
    const hasRightsizing = (data.optimize.rightsizing?.recommendations?.length ?? 0) > 0;
    const hasIdle = (data.optimize.idle?.warehouses?.length ?? 0) > 0;
    if (hasRightsizing || hasIdle) {
      doc.addPage();
      yPos = 20;

      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
      doc.text("Optimize", 14, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;

      doc.setFontSize(9);
      doc.setFont("helvetica", "italic");
      doc.setTextColor(107, 114, 128);
      doc.text(
        "Rightsizing and idle-time opportunities across your SQL warehouses.",
        14,
        yPos,
      );
      doc.setTextColor(0, 0, 0);
      doc.setFont("helvetica", "normal");
      yPos += 8;

      // Top 10 Warehouse Rightsizing Opportunities
      if (hasRightsizing && data.optimize.rightsizing) {
        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
        doc.text("Top 10 Warehouse Rightsizing Opportunities", 14, yPos);
        doc.setTextColor(0, 0, 0);
        yPos += 6;

        const rows = data.optimize.rightsizing.recommendations.slice(0, 10).map((r) => [
          r.warehouse_name || r.warehouse_id,
          r.warehouse_size || "—",
          r.recommendation_type,
          r.recommendation_text.length > 80
            ? r.recommendation_text.substring(0, 77) + "..."
            : r.recommendation_text,
        ]);

        autoTable(doc, {
          startY: yPos,
          head: [["Warehouse", "Size", "Issue", "Recommendation"]],
          body: rows,
          theme: "striped",
          headStyles: { fillColor: DB_HEADER, fontSize: 9 },
          alternateRowStyles: { fillColor: DB_ALT_ROW },
          bodyStyles: { fontSize: 8 },
          margin: { left: 14, right: 14 },
          columnStyles: {
            0: { cellWidth: 40 },
            3: { cellWidth: 90 },
          },
        });

        yPos = getLastTableY(doc) + 5;
        doc.setFontSize(8);
        doc.setTextColor(107, 114, 128);
        doc.text(
          `Analyzed ${data.optimize.rightsizing.warehouses_analyzed} warehouse${data.optimize.rightsizing.warehouses_analyzed === 1 ? "" : "s"}.`,
          14,
          yPos,
        );
        doc.setTextColor(0, 0, 0);
        yPos += 10;
      }

      if (yPos > 200) {
        doc.addPage();
        yPos = 20;
      }

      // Top 10 Warehouses by Idle Time
      if (hasIdle && data.optimize.idle) {
        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(DB_HEADER[0], DB_HEADER[1], DB_HEADER[2]);
        doc.text("Top 10 Warehouses by Idle Time", 14, yPos);
        doc.setTextColor(0, 0, 0);
        yPos += 6;

        const rows = [...data.optimize.idle.warehouses]
          .sort((a, b) => b.estimated_idle_spend - a.estimated_idle_spend)
          .slice(0, 10)
          .map((w) => [
            w.warehouse_name || w.warehouse_id,
            w.warehouse_size || "—",
            w.warehouse_type || "—",
            `${(w.idle_minutes / 60).toFixed(1)} h`,
            `${w.idle_pct.toFixed(1)}%`,
            formatCurrency(w.estimated_idle_spend),
          ]);

        autoTable(doc, {
          startY: yPos,
          head: [["Warehouse", "Size", "Type", "Idle", "Idle %", "Est. Idle Spend"]],
          body: rows,
          theme: "striped",
          headStyles: { fillColor: DB_HEADER, fontSize: 9 },
          alternateRowStyles: { fillColor: DB_ALT_ROW },
          bodyStyles: { fontSize: 8 },
          margin: { left: 14, right: 14 },
        });

        yPos = getLastTableY(doc) + 5;
        doc.setFontSize(8);
        doc.setTextColor(107, 114, 128);
        doc.text(
          "Idle time = warehouse uptime (from lifecycle events) minus active query time.",
          14,
          yPos,
        );
        doc.setTextColor(0, 0, 0);
        yPos += 10;
      }
    }
  }

  // Footer on every page
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    // Thin brand-orange rule above the footer
    doc.setDrawColor(DB_ORANGE[0], DB_ORANGE[1], DB_ORANGE[2]);
    doc.setLineWidth(0.3);
    doc.line(14, doc.internal.pageSize.height - 14, pageWidth - 14, doc.internal.pageSize.height - 14);
    doc.setDrawColor(0);
    doc.setLineWidth(0.2);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(
      `Page ${i} of ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.height - 10,
      { align: "center" }
    );
    doc.text(
      "Generated by the Databricks COST-OBS app framework",
      pageWidth - 14,
      doc.internal.pageSize.height - 10,
      { align: "right" }
    );
  }

  // Save the PDF
  const filename = `cost-report-${format(new Date(), "yyyy-MM-dd")}.pdf`;
  doc.save(filename);
}
