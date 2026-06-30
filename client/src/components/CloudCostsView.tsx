import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure.png";
import gcpLogo from "@/assets/gcp.svg";
import { KPITrendModal } from "./KPITrendModal";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { format, parseISO } from "date-fns";
import type {
  AWSCostsResponse,
  TimeseriesResponse,
  AWSActualDashboardBundle,
  AzureActualDashboardBundle,
  GCPActualDashboardBundle,
  InfraCostsResponse,
  InfraCostsTimeseriesResponse,
  InfraBillingSummary,
} from "@/types/billing";
import { formatCurrency, workspaceUrl } from "@/utils/formatters";
import { StatusIndicator } from "./StatusIndicator";
import { AzureActualView } from "./AzureActualView";
import { GCPActualView } from "./GCPActualView";
import { AWSActualView } from "./AWSActualView";
import { CloudIntegrationWizard } from "./CloudIntegrationWizard";
import type { CloudIntegration } from "./CloudIntegrationWizard";

type CostMode = "estimated" | "actual";

interface CloudCostsViewProps {
  data: AWSCostsResponse | undefined;
  isLoading: boolean;
  timeseriesData: TimeseriesResponse | undefined;
  timeseriesLoading: boolean;
  host: string | null | undefined;
  actualData?: AWSActualDashboardBundle;
  actualLoading?: boolean;
  azureActualData?: AzureActualDashboardBundle;
  azureActualLoading?: boolean;
  gcpActualData?: GCPActualDashboardBundle;
  gcpActualLoading?: boolean;
  infraData?: InfraCostsResponse;
  infraLoading?: boolean;
  infraTimeseriesData?: InfraCostsTimeseriesResponse;
  infraTimeseriesLoading?: boolean;
  startDate?: string;
  endDate?: string;
  detectedCloud?: string;
  workspaceNameMap?: Record<string, string>;
  workspaceIds?: string[];
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

type SortField = "cluster_name" | "estimated_aws_cost" | "total_dbu_hours" | "days_active";
type SortDirection = "asc" | "desc";

const FAMILY_PALETTE = [
  "#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B",
  "#3B82F6", "#EC4899", "#EF4444", "#6B7280",
];

const INSTANCE_COLORS: Record<string, string> = {
  i3: "#1B5162", i3en: "#2D7A96", i4i: "#4A99B8",
  m4: "#10B981", m5: "#10B981", m5d: "#34D399", m5n: "#6EE7B7",
  m6i: "#6EE7B7", m6id: "#A7F3D0", m7g: "#059669", m7gd: "#047857", m7i: "#34D399",
  r5: "#F59E0B", r5d: "#FBBF24", r6id: "#FDE68A", r6gd: "#FCD34D", r8gd: "#D97706",
  c5: "#3B82F6", c5d: "#60A5FA", c6gd: "#1D4ED8",
  g4dn: "#EC4899", g5: "#F472B6",
  p3: "#EF4444",
  "rd-fleet": "#06B6D4", "rgd-fleet": "#0891B2",
  Standard_D: "#1B5162", Standard_DS: "#2D7A96",
  Standard_E: "#10B981", Standard_ES: "#34D399",
  Standard_F: "#3B82F6", Standard_FS: "#60A5FA",
  Standard_L: "#F59E0B", Standard_LS: "#FBBF24",
  Standard_M: "#EF4444",
  Standard_NC: "#EC4899", Standard_ND: "#F472B6", Standard_NV: "#14B8A6",
  unknown: "#6B7280",
};

function getInstanceColor(name: string, index: number): string {
  return INSTANCE_COLORS[name] || FAMILY_PALETTE[index % FAMILY_PALETTE.length];
}

function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="ml-1 inline-flex cursor-help"
      onMouseEnter={e => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
      onClick={e => e.stopPropagation()}
    >
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold normal-case text-gray-500">i</span>
      {pos && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] w-64 rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal normal-case leading-relaxed text-white shadow-lg"
          style={{
            top: pos.y - 12,
            transform: 'translateY(-100%)',
            left: Math.min(pos.x + 14, window.innerWidth - 272),
          }}
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

function getClusterUrl(host: string | null | undefined, clusterId: string | null, workspaceId: string | null): string | null {
  if (!host || !clusterId) return null;
  const workspaceParam = workspaceId ? `?o=${workspaceId}` : '';
  return workspaceUrl(host, `/compute/interactive${workspaceParam}`);
}

function getInstancePricingUrl(instanceType: string | null, isAzure: boolean = false): string {
  if (isAzure) {
    if (!instanceType) return "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/";
    const seriesMatch = instanceType.match(/^Standard_([A-Z]+)/i);
    const series = seriesMatch ? seriesMatch[1].toUpperCase() : null;
    const azureFamilyUrls: Record<string, string> = {
      'D': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#d-series',
      'E': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#e-series',
      'F': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#f-series',
      'L': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#l-series',
      'M': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#m-series',
      'NC': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#nc-series',
      'ND': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#nd-series',
    };
    return series && azureFamilyUrls[series]
      ? azureFamilyUrls[series]
      : "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/";
  }
  if (!instanceType) return "https://aws.amazon.com/ec2/pricing/on-demand/";
  const family = instanceType.split('.')[0];
  const familyUrls: Record<string, string> = {
    'i3': 'https://aws.amazon.com/ec2/instance-types/i3/',
    'i3en': 'https://aws.amazon.com/ec2/instance-types/i3en/',
    'm5': 'https://aws.amazon.com/ec2/instance-types/m5/',
    'm5d': 'https://aws.amazon.com/ec2/instance-types/m5/',
    'm6i': 'https://aws.amazon.com/ec2/instance-types/m6i/',
    'r5': 'https://aws.amazon.com/ec2/instance-types/r5/',
    'r5d': 'https://aws.amazon.com/ec2/instance-types/r5/',
    'c5': 'https://aws.amazon.com/ec2/instance-types/c5/',
    'c5d': 'https://aws.amazon.com/ec2/instance-types/c5/',
    'g4dn': 'https://aws.amazon.com/ec2/instance-types/g4/',
    'g5': 'https://aws.amazon.com/ec2/instance-types/g5/',
    'p3': 'https://aws.amazon.com/ec2/instance-types/p3/',
  };
  return familyUrls[family] || "https://aws.amazon.com/ec2/pricing/on-demand/";
}

export function CloudCostsView({
  data,
  isLoading,
  timeseriesData,
  timeseriesLoading,
  host: _host,
  actualData,
  actualLoading,
  azureActualData,
  azureActualLoading,
  gcpActualData,
  gcpActualLoading,
  infraData,
  infraLoading,
  infraTimeseriesData,
  infraTimeseriesLoading,
  startDate,
  endDate,
  detectedCloud,
  workspaceNameMap,
  workspaceIds,
}: CloudCostsViewProps) {
  const [sortField, setSortField] = useState<SortField>("estimated_aws_cost");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [showHistoricalClusters, setShowHistoricalClusters] = useState(false);
  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  useEffect(() => { setCurrentPage(1); }, [selectedFamilies]);
  const [tableFamily, setTableFamily] = useState<string>("");
  const [tableWorkspace, setTableWorkspace] = useState<string>("");
  const [familyFilterOpen, setFamilyFilterOpen] = useState(false);
  const [workspaceFilterOpen, setWorkspaceFilterOpen] = useState(false);
  const familyFilterRef = useRef<HTMLDivElement>(null);
  const workspaceFilterRef = useRef<HTMLDivElement>(null);

  const itemsPerPage = 10;

  const [activeActualCloud, setActiveActualCloud] = useState<"AWS" | "AZURE" | "GCP">(() => {
    const c = (detectedCloud || "AWS").toUpperCase();
    if (c === "AZURE") return "AZURE";
    if (c === "GCP") return "GCP";
    return "AWS";
  });

  const INTEGRATIONS_KEY = "cost-obs-cloud-integrations";
  const [cloudIntegrations, setCloudIntegrations] = useState<CloudIntegration[]>(() => {
    try { return JSON.parse(localStorage.getItem(INTEGRATIONS_KEY) || "[]"); } catch { return []; }
  });
  const [showIntegrationWizard, setShowIntegrationWizard] = useState(false);
  const [wizardCloud, setWizardCloud] = useState<"azure" | "aws" | "gcp" | null>(null);
  const [wizardExpandedStep, setWizardExpandedStep] = useState<number | null>(null);
  const [viewingIntegration, setViewingIntegration] = useState<CloudIntegration | null>(null);

  const addIntegration = (cloud: "azure" | "aws" | "gcp") => {
    if (cloudIntegrations.length >= 3) return;
    const newInt: CloudIntegration = { id: Date.now().toString(), cloud, label: cloud === "azure" ? "Azure" : cloud === "gcp" ? "GCP" : "AWS" };
    const updated = [...cloudIntegrations, newInt];
    setCloudIntegrations(updated);
    localStorage.setItem(INTEGRATIONS_KEY, JSON.stringify(updated));
  };

  const removeIntegration = (id: string) => {
    const updated = cloudIntegrations.filter(i => i.id !== id);
    setCloudIntegrations(updated);
    localStorage.setItem(INTEGRATIONS_KEY, JSON.stringify(updated));
  };

  const openWizardForExisting = (integration: CloudIntegration) => {
    setWizardCloud(integration.cloud);
    setWizardExpandedStep(null);
    setShowIntegrationWizard(true);
    setViewingIntegration(integration);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (familyFilterRef.current && !familyFilterRef.current.contains(e.target as Node)) {
        setFamilyFilterOpen(false);
      }
      if (workspaceFilterRef.current && !workspaceFilterRef.current.contains(e.target as Node)) {
        setWorkspaceFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const queryClient = useQueryClient();
  const wsKey = workspaceIds?.join(",") ?? "";
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["infra_cost", "infra_clusters", "infra_dbu_hours", "avg_cost_per_cluster"]) {
      queryClient.prefetchQuery({
        queryKey: ["kpi-trend", kpi, startDate, endDate, "daily", wsKey],
        queryFn: async () => {
          const params = new URLSearchParams({ kpi, start_date: startDate, end_date: endDate, granularity: "daily" });
          if (workspaceIds?.length) params.set("workspace_ids", workspaceIds.join(","));
          const res = await fetch(`/api/billing/kpi-trend?${params}`);
          if (!res.ok) throw new Error("prefetch failed");
          return res.json();
        },
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [startDate, endDate, wsKey, queryClient]);

  const MINIMIZE_KEY = "cost-obs-minimize-infra-info";
  const [infoMinimized, setInfoMinimized] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(MINIMIZE_KEY) === "true";
    }
    return false;
  });

  const handleMinimizeToggle = (checked: boolean) => {
    setInfoMinimized(checked);
    if (checked) {
      localStorage.setItem(MINIMIZE_KEY, "true");
    } else {
      localStorage.removeItem(MINIMIZE_KEY);
    }
  };

  const cloud = infraData?.cloud || detectedCloud || "AWS";
  const cloudDisplayName = cloud.toUpperCase() === "AZURE" ? "Azure" : cloud.toUpperCase() === "GCP" ? "GCP" : "AWS";
  const isAzure = cloud.toUpperCase() === "AZURE";
  const isGCP = cloud.toUpperCase() === "GCP";
  const daysCount = startDate && endDate
    ? Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1
    : null;

  const awsActualAvailable = actualData?.available === true;
  const azureActualAvailable = azureActualData?.available === true;
  const gcpActualAvailable = gcpActualData?.available === true;
  const multipleActualAvailable = [awsActualAvailable, azureActualAvailable, gcpActualAvailable].filter(Boolean).length > 1;
  const actualAvailable = awsActualAvailable || azureActualAvailable || gcpActualAvailable;

  const cloudTabs: Array<{ key: "AWS" | "AZURE" | "GCP"; label: string; logo: string; activeClass: string; available: boolean }> = [
    { key: "AWS",   label: "AWS",   logo: awsLogo,   activeClass: "text-orange-600", available: awsActualAvailable },
    { key: "AZURE", label: "Azure", logo: azureLogo, activeClass: "text-blue-600",   available: azureActualAvailable },
    { key: "GCP",   label: "GCP",   logo: gcpLogo,   activeClass: "text-blue-500",   available: gcpActualAvailable },
  ];
  const CloudTabSwitcher = multipleActualAvailable ? (
    <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-1">
      {cloudTabs.filter(t => t.available).map(t => (
        <button
          key={t.key}
          onClick={() => setActiveActualCloud(t.key)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            activeActualCloud === t.key ? `bg-white shadow ${t.activeClass}` : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <img src={t.logo} className="h-3.5 w-3.5 object-contain" alt={t.label} />
          {t.label}
        </button>
      ))}
    </div>
  ) : null;
  const [costMode, setCostMode] = useState<CostMode>("estimated");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
      setCurrentPage(1);
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <span className="ml-1 text-gray-300">↕</span>;
    }
    return <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  };

  const showLoading = isLoading || infraLoading || (costMode === "actual" && (
    activeActualCloud === "AZURE" ? azureActualLoading :
    activeActualCloud === "GCP"   ? gcpActualLoading :
    actualLoading
  ));

  if (showLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading cloud costs...</p>
      </div>
    );
  }

  if (costMode === "actual" && activeActualCloud === "AZURE" && azureActualData?.available) {
    return (
      <AzureActualView
        azureActualData={azureActualData}
        cloudTabSwitcher={CloudTabSwitcher}
        onSwitchToEstimated={() => setCostMode("estimated")}
      />
    );
  }

  if (costMode === "actual" && activeActualCloud === "GCP" && gcpActualData?.available) {
    return (
      <GCPActualView
        gcpActualData={gcpActualData}
        cloudTabSwitcher={CloudTabSwitcher}
        onSwitchToEstimated={() => setCostMode("estimated")}
      />
    );
  }

  if (costMode === "actual" && activeActualCloud === "AWS" && actualData?.available) {
    return (
      <AWSActualView
        actualData={actualData}
        cloudTabSwitcher={CloudTabSwitcher}
        onSwitchToEstimated={() => setCostMode("estimated")}
      />
    );
  }

  const ModeToggle = actualAvailable ? (
    <div className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {multipleActualAvailable ? "Multi-Cloud Cost Data Available" : azureActualAvailable ? "Azure Cost Data Available" : gcpActualAvailable ? "GCP Cost Data Available" : "AWS CUR Data Available"}
        </span>
        {CloudTabSwitcher}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg bg-gray-100 p-1">
          <button
            onClick={() => setCostMode("actual")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              costMode === "actual"
                ? "bg-white text-orange-600 shadow"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Actual Costs
          </button>
          <button
            onClick={() => setCostMode("estimated")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              costMode === "estimated"
                ? "bg-white text-orange-600 shadow"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Estimated
          </button>
        </div>
        {cloudIntegrations.length < 3 && (
          <button
            onClick={() => { setWizardCloud(null); setWizardExpandedStep(null); setViewingIntegration(null); setShowIntegrationWizard(true); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Integrate cloud costs
          </button>
        )}
      </div>
    </div>
  ) : null;

  const EstimationInfoBox = data && (
    <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
      <div className="flex">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="ml-3 flex-1">
          <button
            className="flex w-full items-center justify-between"
            onClick={() => handleMinimizeToggle(!infoMinimized)}
          >
            <h3 className="text-sm font-medium text-orange-800">Estimated {cloudDisplayName} Infrastructure Cost — Methodology</h3>
            <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {!infoMinimized && (
            <>
              <div className="mt-2 text-sm text-orange-700">
                {isAzure ? (
                  <ul className="list-inside list-disc space-y-1">
                    <li>Estimates <strong>Azure VM Pay-As-You-Go</strong> costs (East US, Linux) per node based on cluster instance types</li>
                    <li>Node uptime is derived from DBU hours — clusters are billed for every node-hour while running</li>
                    <li>Pricing sourced from Azure public pricing (2025); East US rates used as baseline</li>
                    <li><strong>Not included:</strong> Managed Disk storage (P10 ~$19.71/mo, P20 ~$38.40/mo per disk), outbound bandwidth ($0.087/GB)</li>
                    <li>Actual costs may vary by region, SKU availability, and subscription discounts</li>
                  </ul>
                ) : isGCP ? (
                  <ul className="list-inside list-disc space-y-1">
                    <li>Estimates <strong>Compute Engine On-Demand</strong> costs (us-central1, Linux) per node based on cluster machine types</li>
                    <li>Node uptime is derived from DBU hours — clusters are billed for every node-hour while running</li>
                    <li>Pricing sourced from GCP public pricing (2025); us-central1 rates used as baseline</li>
                    <li><strong>Not included:</strong> Persistent Disk storage (~$0.04/GB-month SSD), egress charges, Google Cloud Storage</li>
                    <li>Actual costs may vary by region, Committed Use Discounts, and Spot VM usage</li>
                  </ul>
                ) : (
                  <ul className="list-inside list-disc space-y-1">
                    <li>Estimates <strong>EC2 On-Demand</strong> costs (us-east-1, Linux) per node based on cluster instance types</li>
                    <li>Node uptime is derived from DBU hours — clusters are billed for every node-hour while running</li>
                    <li>Pricing sourced from AWS public pricing (2025); us-east-1 rates used as baseline</li>
                    <li><strong>Not included:</strong> EBS gp3 storage (~$0.08–$0.10/GB-month), data transfer, Route 53</li>
                    <li>Actual costs may vary by region, purchasing model, and AWS organization discounts</li>
                  </ul>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={infoMinimized}
                    onChange={(e) => handleMinimizeToggle(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                  />
                  <span className="text-xs text-orange-600">Minimize from now on</span>
                </label>
                <span className="text-xs text-orange-500 italic">For exact costs, integrate {isAzure ? "Azure Cost Management" : isGCP ? "GCP Billing Export" : "AWS CUR 2.0"} below ↓</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const CurSetupBanner = !actualAvailable ? (
    <div className="mb-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg bg-gray-100 p-1">
            <button
              disabled
              className="cursor-not-allowed rounded-md px-4 py-1.5 text-sm font-medium text-gray-500"
              title={`Configure ${isAzure ? "Azure Cost Management Export" : "AWS CUR"} to enable actual costs`}
            >
              Actual Costs
            </button>
            <button className="rounded-md bg-white px-4 py-1.5 text-sm font-medium text-orange-600 shadow">
              Estimated
            </button>
          </div>
          <span className="flex items-center gap-1.5 text-sm text-gray-500">
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Add cloud billing integrations to see actual costs from {isAzure ? "Azure Cost Management" : "AWS CUR"} alongside your estimates.
          </span>
        </div>
        {cloudIntegrations.length < 3 && (
          <button
            onClick={() => { setWizardCloud(null); setWizardExpandedStep(null); setViewingIntegration(null); setShowIntegrationWizard(true); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Integrate cloud costs
          </button>
        )}
      </div>

      {cloudIntegrations.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium uppercase tracking-wider text-gray-500">Additional Cloud Integrations</div>
          {cloudIntegrations.map((integration) => (
            <div key={integration.id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-medium"
                  style={integration.cloud === "azure"
                    ? { backgroundColor: '#0078D420', color: '#0078D4' }
                    : { backgroundColor: '#FF990020', color: '#CC7700' }
                  }
                >
                  {integration.label}
                </span>
                <span className="text-sm text-gray-700">{integration.cloud === "azure" ? "Azure Cost Management Export" : integration.cloud === "gcp" ? "GCP Billing Export (BigQuery)" : "AWS CUR 2.0"}</span>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Setup in progress</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openWizardForExisting(integration)} className="text-xs text-blue-600 hover:text-blue-800">
                  View setup guide
                </button>
                <button
                  onClick={() => removeIntegration(integration.id)}
                  className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-500"
                  title="Remove integration"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  const billingSummary: InfraBillingSummary | undefined = infraData?.billing_summary;

  if (data?.error) {
    return (
      <div className="space-y-6">
        {ModeToggle}
        {CurSetupBanner}
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Infrastructure Costs</h3>
          <p className="text-sm text-amber-600">{data.error}</p>
        </div>
      </div>
    );
  }

  if (!data || data.clusters.length === 0) {
    const hasBillingSummary = billingSummary != null && billingSummary.total_cost != null && billingSummary.total_cost > 0;
    return (
      <div className="space-y-6">
        {ModeToggle}
        {CurSetupBanner}
        {hasBillingSummary && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
              <p className="text-sm font-medium text-gray-500">Compute Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(billingSummary!.total_cost ?? 0)}</p>
              <p className="mt-1 text-xs text-gray-500">{billingSummary!.days_in_range ?? 0} days (all-purpose + jobs + DLT)</p>
            </div>
            <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
              <p className="text-sm font-medium text-gray-500">Avg Active Clusters / Day</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(billingSummary!.avg_clusters_per_day ?? 0)}</p>
              <p className="mt-1 text-xs text-gray-500">daily average</p>
            </div>
            <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
              <p className="text-sm font-medium text-gray-500">Avg Cost / Cluster</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(billingSummary!.avg_cost_per_cluster ?? 0)}</p>
              <p className="mt-1 text-xs text-gray-500">per cluster per day</p>
            </div>
          </div>
        )}
        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Infrastructure Costs</h3>
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-gray-500">
            <p className="text-base font-medium">No cluster instance data available</p>
            <p className="text-sm text-center max-w-md">Cluster-level VM cost estimates require classic (non-serverless) compute. This workspace may be using serverless jobs, SQL warehouses, or serverless DLT — which don't expose instance types.</p>
          </div>
        </div>
      </div>
    );
  }

  function getInstanceFamily(instanceType: string | null | undefined): string {
    if (!instanceType) return 'unknown';
    if (instanceType.startsWith('Standard_')) {
      const m = instanceType.match(/^(Standard_[A-Z]+)/);
      return m ? m[1] : 'unknown';
    }
    const dotIdx = instanceType.indexOf('.');
    return dotIdx > 0 ? instanceType.slice(0, dotIdx) : instanceType;
  }

  const cloudSummary = useMemo(() => {
    if (!data) return { totalCost: 0, totalDBUHours: 0, avgActiveClustersPerDay: 0, avgCostPerCluster: 0 };
    const bs = billingSummary;
    const totalDBUHours = data.clusters.reduce((sum, c) => sum + (c.total_dbu_hours || 0), 0);
    const clustersWithTypes = data.clusters.filter(c => c.driver_instance_type || c.worker_instance_type);
    const estimatedTotal = clustersWithTypes.reduce((sum, c) => sum + (c.estimated_aws_cost || 0), 0);

    const avgCostPerCluster = bs?.avg_cost_per_cluster || (() => {
      const tsPoints = infraTimeseriesData?.timeseries || [];
      const activeTsPoints = tsPoints.filter(p => (p["Infrastructure Cost"] || 0) > 0);
      if (activeTsPoints.length > 0) {
        const tsTotal = activeTsPoints.reduce((s, p) => s + (p["Infrastructure Cost"] || 0), 0);
        return tsTotal / activeTsPoints.length;
      }
      return 0;
    })();

    if (bs && bs.total_cost != null && bs.total_cost > 0) {
      return {
        totalCost: bs.total_cost,
        totalDBUHours,
        avgActiveClustersPerDay: bs.avg_clusters_per_day ?? 0,
        avgCostPerCluster,
      };
    }

    return { totalCost: estimatedTotal, totalDBUHours, avgActiveClustersPerDay: clustersWithTypes.length, avgCostPerCluster };
  }, [data, infraTimeseriesData, billingSummary]);

  const filteredClusters = showHistoricalClusters
    ? data.clusters
    : data.clusters.filter(c => c.driver_instance_type || c.worker_instance_type);

  const familyFilteredClusters = selectedFamilies.size === 0
    ? filteredClusters
    : filteredClusters.filter(c => {
        const df = getInstanceFamily(c.driver_instance_type);
        const wf = getInstanceFamily(c.worker_instance_type);
        return selectedFamilies.has(df) || selectedFamilies.has(wf);
      });

  const availableTableFamilies = (() => {
    const families = new Set<string>();
    (data.instance_families || []).forEach(f => {
      if (f.instance_family && f.instance_family !== 'unknown') families.add(f.instance_family);
    });
    return [...families].sort();
  })();

  const availableTableWorkspaces = (() => {
    const ws = new Set<string>();
    familyFilteredClusters.forEach(c => { if (c.workspace_id) ws.add(c.workspace_id); });
    return [...ws].sort();
  })();

  const tableFilteredClusters = familyFilteredClusters.filter(c => {
    if (tableFamily) {
      const df = getInstanceFamily(c.driver_instance_type);
      const wf = getInstanceFamily(c.worker_instance_type);
      if (df !== tableFamily && wf !== tableFamily) return false;
    }
    if (tableWorkspace && c.workspace_id !== tableWorkspace) return false;
    return true;
  });

  const sortedClusters = [...tableFilteredClusters].sort((a, b) => {
    const modifier = sortDirection === "asc" ? 1 : -1;
    if (sortField === "cluster_name") {
      return ((a.cluster_name || "").localeCompare(b.cluster_name || "")) * modifier;
    }
    const aVal = (a[sortField] as number) ?? 0;
    const bVal = (b[sortField] as number) ?? 0;
    return (aVal - bVal) * modifier;
  });

  const totalPages = Math.ceil(sortedClusters.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedClusters = sortedClusters.slice(startIndex, endIndex);

  const familyChartData = data.instance_families
    .filter((f) => f.instance_family && f.instance_family !== "unknown")
    .slice(0, 10)
    .map((f) => ({
      name: f.instance_family,
      value: f.total_dbu_hours,
    }));

  const timeseriesFamilies: string[] = (timeseriesData as any)?.instance_families || [];

  const filteredTimeseriesData = useMemo(() => {
    if (!timeseriesData?.timeseries) return null;
    if (selectedFamilies.size === 0) return timeseriesData.timeseries;
    return timeseriesData.timeseries.map((point) => {
      let filteredCost = 0;
      for (const family of selectedFamilies) {
        filteredCost += (point[family] as number) || 0;
      }
      return { ...point, "AWS Cost": filteredCost };
    });
  }, [timeseriesData, selectedFamilies]);

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cloud Costs</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-gray-500">Estimated cloud infrastructure costs and cluster analytics</p>
            {workspaceIds && workspaceIds.length > 0 ? (
              <span className="rounded bg-[#1B3139]/10 px-2 py-0.5 text-[10px] font-medium text-[#1B3139]">
                {workspaceIds.length === 1 ? (workspaceNameMap?.[workspaceIds[0]] || workspaceIds[0]) : `${workspaceIds.length} workspaces`}
              </span>
            ) : (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Account-wide</span>
            )}
          </div>
        </div>
      </div>

      {EstimationInfoBox}
      {ModeToggle}
      {CurSetupBanner}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="relative rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "infra_cost", label: `Daily ${cloudDisplayName} Cluster Spend` })}
        >
          <span className="absolute top-2 left-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide" style={{ backgroundColor: '#FF9900', color: '#fff' }}>est.</span>
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Cloud Costs</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(cloudSummary.totalCost)}</p>
              {startDate && endDate && <p className="mt-1 text-xs text-gray-500">over {Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1} days · cluster compute (DBU billing)</p>}
              {startDate && endDate && <p className="mt-0.5 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>}
            </div>
          </div>
        </div>
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "infra_dbu_hours", label: "Daily Cluster DBUs" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Cluster DBUs</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(cloudSummary.totalDBUHours)}</p>
              <p className="mt-1 text-xs text-gray-500">across {data.clusters.length} clusters</p>
              {startDate && endDate && <p className="mt-0.5 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>}
            </div>
          </div>
        </div>
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "infra_clusters", label: `Daily Active ${cloudDisplayName} Clusters` })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Active Clusters<InfoTooltip text="Average number of distinct clusters with billing activity per day in the selected period. Includes all cluster types (job clusters, interactive clusters)." /></p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(cloudSummary.avgActiveClustersPerDay)}</p>
              <p className="mt-1 text-xs text-gray-500">daily average</p>
              {startDate && endDate && <p className="mt-0.5 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>}
            </div>
          </div>
        </div>
        <div
          className={`relative rounded-lg bg-white p-6 border shadow-sm transition-all ${startDate && endDate ? "cursor-pointer hover:shadow-md hover:scale-[1.01]" : ""}`}
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "avg_cost_per_cluster", label: `Daily ${cloudDisplayName} Cost Per-Cluster` })}
        >
          <span className="absolute top-2 left-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide" style={{ backgroundColor: '#FF9900', color: '#fff' }}>est.</span>
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Avg Cost Per Cluster<InfoTooltip text="Total estimated cloud infrastructure cost divided by the number of distinct clusters with billing activity in the period." /></p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(cloudSummary.avgCostPerCluster)}</p>
              <p className="mt-1 text-xs text-gray-500">per-cluster average</p>
              {startDate && endDate && (
                <p className="mt-0.5 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {selectedKPI && startDate && endDate && (
        <KPITrendModal
          kpi={selectedKPI.kpi as any}
          kpiLabel={selectedKPI.label}
          isOpen={!!selectedKPI}
          onClose={() => setSelectedKPI(null)}
          startDate={startDate}
          endDate={endDate}
          workspaceIds={workspaceIds}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {(infraTimeseriesLoading || timeseriesLoading) ? (
          <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Cluster Costs{daysCount ? ` over ${daysCount} Days` : ""} <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide align-middle ml-1" style={{ backgroundColor: '#FF9900', color: '#fff' }}>est.</span></h3>
            <div className="h-80 animate-pulse rounded bg-gray-200" />
          </div>
        ) : (infraTimeseriesData?.timeseries && infraTimeseriesData.timeseries.length > 0) ? (
          <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Cluster Costs{daysCount ? ` over ${daysCount} Days` : ""} <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide align-middle ml-1" style={{ backgroundColor: '#FF9900', color: '#fff' }}>est.</span></h3>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={infraTimeseriesData.timeseries} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="infraCostGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tickFormatter={formatDate} stroke="#9ca3af" fontSize={12} tickMargin={8} />
                <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={12} width={80} />
                <Tooltip
                  formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
                  labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                  contentStyle={{ backgroundColor: "white", border: "1px solid #e5e7eb", borderRadius: "8px" }}
                />
                <Area type="monotone" dataKey="Infrastructure Cost" stroke="#f97316" strokeWidth={2} fill="url(#infraCostGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (filteredTimeseriesData && filteredTimeseriesData.length > 0) ? (
          <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">{cloudDisplayName} Cluster Costs{daysCount ? ` over ${daysCount} Days` : ""} <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide align-middle ml-1" style={{ backgroundColor: '#FF9900', color: '#fff' }}>est.</span></h3>
              {timeseriesFamilies.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setSelectedFamilies(new Set())}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      selectedFamilies.size === 0 ? "text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                    }`}
                    style={selectedFamilies.size === 0 ? { backgroundColor: '#1B5162' } : undefined}
                  >
                    All
                  </button>
                  {timeseriesFamilies.filter(f => f !== "unknown").slice(0, 8).map((family, idx) => (
                    <button
                      key={family}
                      onClick={() => {
                        setSelectedFamilies((prev) => {
                          const next = new Set(prev);
                          if (next.has(family)) { next.delete(family); } else { next.add(family); }
                          return next;
                        });
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        selectedFamilies.has(family) ? "text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                      }`}
                      style={selectedFamilies.has(family) ? { backgroundColor: getInstanceColor(family, idx) } : undefined}
                    >
                      {family}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={filteredTimeseriesData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="awsCostGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tickFormatter={formatDate} stroke="#9ca3af" fontSize={12} tickMargin={8} />
                <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={12} width={80} />
                <Tooltip
                  formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
                  labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                  contentStyle={{ backgroundColor: "white", border: "1px solid #e5e7eb", borderRadius: "8px" }}
                />
                <Area type="monotone" dataKey="AWS Cost" stroke="#f97316" strokeWidth={2} fill="url(#awsCostGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}

        <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Usage by Instance Family</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={familyChartData} layout="vertical" margin={{ left: 10, right: 20 }}>
              <XAxis type="number" tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} stroke="#9ca3af" fontSize={12} tickMargin={8} />
              <YAxis type="category" dataKey="name" width={100} fontSize={12} stroke="#9ca3af" interval={0} />
              <Tooltip
                formatter={(value: number | undefined) => [formatNumber(value ?? 0) + " DBU hours", "Usage"]}
                contentStyle={{ backgroundColor: "white", border: "1px solid #e5e7eb", borderRadius: "8px" }}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {familyChartData.map((entry, index) => (
                  <Cell key={entry.name} fill={getInstanceColor(entry.name, index)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-lg bg-white p-6 border" style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{cloudDisplayName} Cluster Leaderboard <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide align-middle ml-1" style={{ backgroundColor: '#FF9900', color: '#fff' }}>est.</span></h3>
            <p className="text-sm text-gray-500">
              {sortedClusters.length} cluster{sortedClusters.length !== 1 ? "s" : ""}{selectedFamilies.size > 0 ? ` · ${[...selectedFamilies].join(", ")} only` : ""}{" "}
              <span className="inline-flex items-center gap-1 group relative">
                <svg className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="pointer-events-none absolute bottom-5 left-0 z-[9999] w-72 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  Estimated {cloudDisplayName} VM cost for cluster compute nodes, derived from DBU hours × cloud instance pricing ({cloudDisplayName === "GCP" ? "us-central1" : cloudDisplayName === "Azure" ? "East US" : "us-east-1"} on-demand rates). This is separate from Databricks DBU spend shown in the page header.
                </span>
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {availableTableFamilies.length > 0 && (
              <div className="relative" ref={familyFilterRef}>
                <button
                  onClick={() => { setFamilyFilterOpen(o => !o); setWorkspaceFilterOpen(false); }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${tableFamily ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                  style={tableFamily ? { backgroundColor: '#FF3621' } : {}}
                >
                  Instance Family{tableFamily ? `: ${tableFamily}` : ""}
                  {tableFamily ? (
                    <span className="opacity-75 hover:opacity-100 ml-0.5 cursor-pointer" onClick={(e) => { e.stopPropagation(); setTableFamily(""); setCurrentPage(1); }}>×</span>
                  ) : (
                    <svg className={`h-3 w-3 text-gray-500 transition-transform ${familyFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </button>
                {familyFilterOpen && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-52 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg" style={{ maxHeight: 260 }}>
                    {availableTableFamilies.map(f => (
                      <button
                        key={f}
                        onClick={() => { setTableFamily(tableFamily === f ? "" : f); setCurrentPage(1); setFamilyFilterOpen(false); }}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${tableFamily === f ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                      >
                        <span className="flex items-center gap-2">
                          {tableFamily === f && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                          {f}
                        </span>
                        {tableFamily === f && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {availableTableWorkspaces.length > 1 && (
              <div className="relative" ref={workspaceFilterRef}>
                <button
                  onClick={() => { setWorkspaceFilterOpen(o => !o); setFamilyFilterOpen(false); }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${tableWorkspace ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                  style={tableWorkspace ? { backgroundColor: '#FF3621' } : {}}
                >
                  Workspace{tableWorkspace ? `: ${workspaceNameMap?.[tableWorkspace] || tableWorkspace}` : ""}
                  {tableWorkspace ? (
                    <span className="opacity-75 hover:opacity-100 ml-0.5 cursor-pointer" onClick={(e) => { e.stopPropagation(); setTableWorkspace(""); setCurrentPage(1); }}>×</span>
                  ) : (
                    <svg className={`h-3 w-3 text-gray-500 transition-transform ${workspaceFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </button>
                {workspaceFilterOpen && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg" style={{ maxHeight: 260 }}>
                    {availableTableWorkspaces.map(w => {
                      const label = workspaceNameMap?.[w] || w;
                      return (
                        <button
                          key={w}
                          onClick={() => { setTableWorkspace(tableWorkspace === w ? "" : w); setCurrentPage(1); setWorkspaceFilterOpen(false); }}
                          className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${tableWorkspace === w ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                        >
                          <span className="flex items-center gap-2">
                            {tableWorkspace === w && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                            {label}
                          </span>
                          {tableWorkspace === w && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={showHistoricalClusters}
                onChange={(e) => { setShowHistoricalClusters(e.target.checked); setCurrentPage(1); }}
                className="h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
              />
              <span>Show historical clusters</span>
            </label>
            <div className="group relative">
              <svg className="h-4 w-4 cursor-help text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="invisible absolute right-0 top-6 z-10 w-72 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                <p className="font-semibold mb-1.5">Historical Clusters</p>
                <p className="text-gray-200">Historical clusters have no instance type information available. These are typically old or deleted clusters that no longer have detailed configuration data.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-hidden">
          <table className="w-full table-fixed divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="cursor-pointer px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700" onClick={() => handleSort("cluster_name")}>
                  Cluster <SortIcon field="cluster_name" />
                </th>
                <th className="w-44 px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Instance Types</th>
                <th className="w-28 px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  <div className="flex items-center justify-end gap-1">
                    <span className="cursor-pointer hover:text-gray-700" onClick={() => handleSort("estimated_aws_cost")}>
                      Cost <SortIcon field="estimated_aws_cost" />
                    </span>
                    <div className="group relative">
                      <svg className="h-3.5 w-3.5 cursor-help text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="invisible absolute right-0 top-6 z-10 w-72 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                        <p className="font-semibold mb-1.5">Cost Estimate Details</p>
                        <ul className="space-y-1 text-gray-200">
                          <li>• {isAzure ? "Azure VM" : "EC2 instance"} costs only</li>
                          <li>• Based on on-demand pricing</li>
                          <li>• Assumes avg 2-4 workers per cluster</li>
                          <li>• Excludes storage, network, and platform fees</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </th>
                <th className="w-28 cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700" onClick={() => handleSort("total_dbu_hours")}>
                  DBU Hours <SortIcon field="total_dbu_hours" />
                </th>
                <th className="w-16 cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700" onClick={() => handleSort("days_active")}>
                  Days <SortIcon field="days_active" />
                </th>
                <th className="w-14 px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {paginatedClusters.map((cluster, idx) => {
                const url = getClusterUrl(_host, cluster.cluster_id, cluster.workspace_id);
                return (
                  <tr key={`${cluster.cluster_id}-${idx}`} className="hover:bg-gray-50">
                    <td className="px-3 py-3">
                      {url ? (
                        <div className="flex flex-col gap-1">
                          <a href={url} target="_blank" rel="noopener noreferrer" className="group flex max-w-xs items-center gap-1 truncate text-sm font-medium text-blue-600 hover:text-blue-800">
                            <span className="truncate">{cluster.cluster_name || cluster.cluster_id}</span>
                            <svg className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                          <div className="flex items-center gap-2">
                            {cluster.state && <StatusIndicator status={cluster.state} type="cluster" />}
                            {cluster.cluster_source && (
                              <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{cluster.cluster_source}</span>
                            )}
                            {cluster.cluster_name && cluster.cluster_name !== cluster.cluster_id && (
                              <span className="text-xs text-gray-500">{cluster.cluster_id}</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <div className="max-w-xs truncate text-sm font-medium text-gray-900">{cluster.cluster_name || cluster.cluster_id}</div>
                          <div className="flex items-center gap-2">
                            {cluster.state && <StatusIndicator status={cluster.state} type="cluster" />}
                            {cluster.cluster_source && (
                              <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{cluster.cluster_source}</span>
                            )}
                            {cluster.cluster_name && cluster.cluster_name !== cluster.cluster_id && (
                              <span className="text-xs text-gray-500">{cluster.cluster_id}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        {cluster.driver_instance_type && (
                          <div className="group relative inline-flex items-center gap-1">
                            <span className="inline-flex max-w-full truncate rounded bg-blue-50 px-2 py-0.5 text-xs font-mono text-blue-700" title={`D: ${cluster.driver_instance_type}`}>D: {cluster.driver_instance_type}</span>
                            <a href={getInstancePricingUrl(cluster.driver_instance_type, isAzure)} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title={`View ${isAzure ? "Azure" : "AWS"} pricing for this instance type`}>
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </a>
                          </div>
                        )}
                        {cluster.worker_instance_type && (
                          <div className="group relative inline-flex items-center gap-1">
                            <span className="inline-flex max-w-full truncate rounded bg-green-50 px-2 py-0.5 text-xs font-mono text-green-700" title={`W: ${cluster.worker_instance_type}`}>W: {cluster.worker_instance_type}</span>
                            <a href={getInstancePricingUrl(cluster.worker_instance_type, isAzure)} target="_blank" rel="noopener noreferrer" className="text-green-500 hover:text-green-700" title={`View ${isAzure ? "Azure" : "AWS"} pricing for this instance type`}>
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </a>
                          </div>
                        )}
                        {!cluster.driver_instance_type && !cluster.worker_instance_type && (
                          <div className="group relative inline-flex items-center gap-1">
                            <span className="inline-flex rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Historical cluster</span>
                            <div className="relative">
                              <svg className="h-3 w-3 cursor-help text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <div className="invisible absolute left-0 top-6 z-10 w-64 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                                <p className="font-semibold mb-1.5">Instance type unavailable</p>
                                <p className="text-gray-200">This cluster no longer exists in the workspace. Instance type information is only available for currently configured clusters.</p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(cluster.estimated_aws_cost)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">{formatNumber(cluster.total_dbu_hours)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">{cluster.days_active}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-500">{(cluster.percentage ?? 0).toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50">
              <tr>
                <td colSpan={2} className="px-3 py-3 text-sm font-medium text-gray-700">Total ({sortedClusters.length} clusters)</td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-bold text-gray-900">
                  {formatCurrency(data.total_estimated_cost)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-gray-700">{formatNumber(data.total_dbu_hours)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
            <p className="text-sm text-gray-700">
              Showing <span className="font-medium">{startIndex + 1}</span> to{" "}
              <span className="font-medium">{Math.min(endIndex, sortedClusters.length)}</span> of{" "}
              <span className="font-medium">{sortedClusters.length}</span> clusters
            </p>
            <div className="flex gap-2">
              <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
                Previous
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((page) => page === 1 || page === totalPages || (page >= currentPage - 1 && page <= currentPage + 1))
                .map((page, idx, arr) => {
                  const prevPage = arr[idx - 1];
                  const showEllipsis = prevPage && page - prevPage > 1;
                  return (
                    <>
                      {showEllipsis && <span key={`ellipsis-${page}`} className="px-2 py-1 text-gray-500">...</span>}
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`rounded px-3 py-1 text-sm font-medium ${currentPage === page ? "bg-orange-600 text-white" : "border border-gray-300 text-gray-700 hover:bg-gray-50"}`}
                      >
                        {page}
                      </button>
                    </>
                  );
                })}
              <button onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="fixed" style={{ top: -9999, left: -9999, opacity: 0.01, pointerEvents: "none" }} aria-hidden="true">
        <img src={awsLogo} alt="" style={{ width: 1, height: 1 }} />
        <img src={azureLogo} alt="" style={{ width: 1, height: 1 }} />
        <img src={gcpLogo} alt="" style={{ width: 1, height: 1 }} />
      </div>

      <CloudIntegrationWizard
        show={showIntegrationWizard}
        onClose={() => { setShowIntegrationWizard(false); setViewingIntegration(null); }}
        wizardCloud={wizardCloud}
        setWizardCloud={setWizardCloud}
        wizardExpandedStep={wizardExpandedStep}
        setWizardExpandedStep={setWizardExpandedStep}
        viewingIntegration={viewingIntegration}
        cloudIntegrations={cloudIntegrations}
        addIntegration={addIntegration}
        isAzure={isAzure}
        isGCP={isGCP}
      />
    </div>
  );
}
