import { useState } from "react";
import { createPortal } from "react-dom";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure.png";
import gcpLogo from "@/assets/gcp.svg";

export type CloudIntegration = { id: string; cloud: "azure" | "aws" | "gcp"; label: string };

interface CloudIntegrationWizardProps {
  show: boolean;
  onClose: () => void;
  wizardCloud: "azure" | "aws" | "gcp" | null;
  setWizardCloud: (c: "azure" | "aws" | "gcp" | null) => void;
  wizardExpandedStep: number | null;
  setWizardExpandedStep: (s: number | null) => void;
  viewingIntegration: CloudIntegration | null;
  cloudIntegrations: CloudIntegration[];
  addIntegration: (cloud: "azure" | "aws" | "gcp") => void;
  isAzure: boolean;
  isGCP: boolean;
}

const WIZARD_STEPS_KEY = "cost-obs-wizard-checked-steps";

export function CloudIntegrationWizard({
  show, onClose,
  wizardCloud, setWizardCloud,
  wizardExpandedStep, setWizardExpandedStep,
  viewingIntegration,
  cloudIntegrations, addIntegration,
  isAzure, isGCP,
}: CloudIntegrationWizardProps) {
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(WIZARD_STEPS_KEY) || "{}"); } catch { return {}; }
  });

  const toggleStep = (key: string) => {
    setCheckedSteps(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(WIZARD_STEPS_KEY, JSON.stringify(next));
      return next;
    });
  };

  if (!show) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/50">
      <div className="flex min-h-full items-start justify-center p-8 pt-16">
        <div className="relative w-full max-w-4xl rounded-xl bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {wizardCloud === null
                  ? "Integrate Cloud Environment Costs"
                  : `${wizardCloud === "azure" ? "Azure" : wizardCloud === "gcp" ? "Google Cloud" : "AWS"} Cost Integration — Setup Guide`}
              </h2>
              <p className="mt-0.5 text-sm text-gray-500">
                {wizardCloud === null
                  ? "Choose the cloud environment you'd like to integrate billing data from."
                  : "Follow the steps below to enable actual cloud cost data in this app."}
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="px-6 py-5">
            {wizardCloud === null ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  You can integrate billing data from any cloud environment regardless of where your Databricks workspace is hosted. Up to 3 cloud cost integrations are supported.
                </p>
                <div className="grid grid-cols-3 gap-4">
                  <button
                    onClick={() => { setWizardCloud("azure"); setWizardExpandedStep(null); }}
                    disabled={cloudIntegrations.some(i => i.cloud === "azure") || cloudIntegrations.length >= 3}
                    className="group flex flex-col items-center gap-3 rounded-xl border-2 border-gray-200 p-6 text-center hover:border-blue-400 hover:bg-blue-600/10 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                  >
                    <img src={azureLogo} alt="Azure" className="h-12 w-auto object-contain" />
                    <div>
                      <div className="flex items-center justify-center gap-2">
                        <span className="font-semibold text-gray-900">Microsoft Azure</span>
                        {isAzure && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Default</span>}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500">Azure Cost Management Export via SDP</div>
                    </div>
                    {cloudIntegrations.some(i => i.cloud === "azure") && (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Already added</span>
                    )}
                  </button>
                  <button
                    onClick={() => { setWizardCloud("aws"); setWizardExpandedStep(null); }}
                    disabled={cloudIntegrations.some(i => i.cloud === "aws") || cloudIntegrations.length >= 3}
                    className="group flex flex-col items-center gap-3 rounded-xl border-2 border-gray-200 p-6 text-center hover:border-orange-400 hover:bg-orange-600/10 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                  >
                    <img src={awsLogo} alt="AWS" className="h-12 w-auto object-contain" />
                    <div>
                      <div className="flex items-center justify-center gap-2">
                        <span className="font-semibold text-gray-900">Amazon Web Services</span>
                        {!isAzure && !isGCP && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Default</span>}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500">AWS CUR 2.0 Standard Data Export</div>
                    </div>
                    {cloudIntegrations.some(i => i.cloud === "aws") && (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Already added</span>
                    )}
                  </button>
                  <button
                    onClick={() => { setWizardCloud("gcp"); setWizardExpandedStep(null); }}
                    disabled={cloudIntegrations.some(i => i.cloud === "gcp") || cloudIntegrations.length >= 3}
                    className="group flex flex-col items-center gap-3 rounded-xl border-2 border-gray-200 p-6 text-center hover:border-blue-400 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                  >
                    <img src={gcpLogo} alt="GCP" className="h-12 w-auto object-contain" />
                    <div>
                      <div className="flex items-center justify-center gap-2">
                        <span className="font-semibold text-gray-900">Google Cloud</span>
                        {isGCP && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Default</span>}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500">GCP Billing Export via BigQuery</div>
                    </div>
                    {cloudIntegrations.some(i => i.cloud === "gcp") && (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Already added</span>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">
                  {wizardCloud === "azure"
                    ? "Deploy the cloud-infra-costs Azure project to ingest actual Azure billing data (Actuals, Amortized, or FOCUS format) via Streaming Declarative Pipelines into a medallion architecture:"
                    : wizardCloud === "gcp"
                    ? "Deploy the cloud-infra-costs GCP project to ingest GCP billing data from BigQuery into a medallion architecture via Databricks Asset Bundles:"
                    : "Deploy the cloud-infra-costs AWS project to ingest CUR 2.0 Standard Data Exports from S3 into a medallion architecture via Databricks Asset Bundles:"}
                </p>

                {(wizardCloud === "azure" ? [
                  "Deploy Terraform (Storage Account, External Location, Catalog)",
                  "Configure Cost Exports in Azure Portal",
                  "Configure Databricks Asset Bundle (DAB)",
                  "Authenticate & Deploy the Bundle",
                  "Validate Dashboards (Final Step)",
                ] : wizardCloud === "gcp" ? [
                  "Enable GCP Billing Export to BigQuery",
                  "Create a GCP Service Account with BigQuery read access",
                  "Create a Databricks Google Cloud Storage External Location",
                  "Configure & Deploy the Databricks Asset Bundle (DAB)",
                  "Validate Workflows & Dashboards (Final Step)",
                ] : [
                  "Create S3 Bucket for Cost Export",
                  "Configure Standard Data Export (CUR 2.0)",
                  "Create Storage Credential & External Location",
                  "Configure & Deploy the DAB",
                  "Validate Workflows & Dashboards (Final Step)",
                ]).map((title, i) => {
                  const step = i + 1;
                  const isLast = step === 5;
                  const stepKey = `${wizardCloud}-${viewingIntegration?.id || 'new'}-step-${step}`;
                  const isChecked = !!checkedSteps[stepKey];
                  return (
                    <div key={step} className={`rounded-lg border ${isLast ? "border-orange-200 bg-orange-50" : "border-gray-200"}`}>
                      <button
                        type="button"
                        onClick={() => setWizardExpandedStep(wizardExpandedStep === step ? null : step)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left ${isLast ? "hover:bg-orange-100" : "hover:bg-gray-50"} rounded-t-lg`}
                      >
                        <span
                          className={`flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${isChecked ? "bg-green-100 text-green-700" : isLast ? "text-white" : "bg-orange-100 text-orange-700"}`}
                          style={!isChecked && isLast ? { backgroundColor: '#FF3621' } : {}}
                        >
                          {isChecked ? (
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : step}
                        </span>
                        <span className={`flex-1 font-medium ${isChecked ? "text-gray-500 line-through" : isLast ? "text-orange-900" : "text-gray-900"}`}>{title}</span>
                        <span
                          role="checkbox"
                          aria-checked={isChecked}
                          title={isChecked ? "Mark incomplete" : "Mark complete"}
                          onClick={(e) => { e.stopPropagation(); toggleStep(stepKey); }}
                          className={`flex-shrink-0 flex h-5 w-5 items-center justify-center rounded border-2 transition-colors cursor-pointer ${isChecked ? "border-green-500 bg-green-500" : "border-gray-300 bg-white hover:border-green-400"}`}
                        >
                          {isChecked && (
                            <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                        <svg className={`flex-shrink-0 h-5 w-5 text-gray-500 transition-transform ${wizardExpandedStep === step ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {wizardExpandedStep === step && (
                        <div className={`border-t px-4 py-3 text-sm text-gray-600 ${isLast ? "border-orange-200 bg-white" : "border-gray-200 bg-gray-50"}`}>
                          {wizardCloud === "azure" ? (
                            step === 1 ? (
                              <>
                                <p className="mb-3">Terraform sets up all dependent infrastructure: storage account, container, external location, catalog, schema, and volume.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Clone the <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/azure" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">cloud-infra-costs/azure</a> project</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Configure <code className="rounded bg-gray-200 px-1">terraform/terraform.tfvars</code>:</span></li>
                                  <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                    <pre>{`subscription_id      = "<Azure Subscription Id>"\ndatabricks_host      = "<Workspace Url>"\nresource_group_name  = "<Resource Group Name>"\nlocation             = "<Azure Region>"\nstorage_account_name = "<Globally Unique Name>"\ncontainer_name       = "billing"\ncatalog_name         = "billing"\nschema_name          = "azure"`}</pre>
                                  </li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Run Terraform:</span></li>
                                  <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                    <pre>{`az login\nterraform init\nterraform plan -var-file="terraform.tfvars"\nterraform apply -var-file="terraform.tfvars"`}</pre>
                                  </li>
                                </ol>
                                <div className="mt-3 rounded-md bg-blue-50 p-3 text-sm text-blue-800">
                                  <strong>✅ Result:</strong> Terraform deploys a Storage Account, Container, External Location, Catalog, Schema, and Volume in one step.
                                </div>
                              </>
                            ) : step === 2 ? (
                              <>
                                <p className="mb-3">Create exports in the <a href="https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/exports" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Azure Portal → Cost Exports</a>. Actuals is required; Amortized and FOCUS are optional.</p>
                                <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                  <table className="w-full border-collapse">
                                    <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Export Type</th><th className="border border-gray-200 px-2 py-1 text-left">Description</th><th className="border border-gray-200 px-2 py-1 text-left">Export Directory</th></tr></thead>
                                    <tbody>
                                      <tr><td className="border border-gray-200 px-2 py-1"><strong>Actuals</strong> ✅ required</td><td className="border border-gray-200 px-2 py-1">Actual billed costs as invoiced</td><td className="border border-gray-200 px-2 py-1 font-mono">azure-actual-cost</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1">Amortized (optional)</td><td className="border border-gray-200 px-2 py-1">Reservations spread across usage period</td><td className="border border-gray-200 px-2 py-1 font-mono">azure-amortized-cost</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1">FOCUS (optional)</td><td className="border border-gray-200 px-2 py-1">FinOps standard format</td><td className="border border-gray-200 px-2 py-1 font-mono">azure-focus-cost</td></tr>
                                    </tbody>
                                  </table>
                                </div>
                                <p className="mb-1 font-medium text-gray-700">Settings for each export:</p>
                                <div className="rounded-md bg-white p-2 font-mono text-xs mb-3">
                                  <div>Frequency: <strong>Daily</strong></div>
                                  <div>Schedule status: <strong>Active</strong></div>
                                  <div>File partitioning: <strong>On</strong></div>
                                  <div>Overwrite data: <strong>Off</strong></div>
                                  <div>Format: <strong>Parquet</strong></div>
                                  <div>Compression type: <strong>Snappy</strong></div>
                                </div>
                                <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
                                  <strong>📁 Expected structure:</strong> <code>{"<container>/<export-dir>/<billing-period>/<ingestion-date>/<run-id>/*.parquet"}</code>
                                </div>
                              </>
                            ) : step === 3 ? (
                              <>
                                <p className="mb-3">Configure <code className="rounded bg-gray-200 px-1">databricks.yml</code> with your workspace URL and warehouse ID, then set pipeline variables.</p>
                                <p className="mb-2 font-medium text-gray-700">Key variables for the Actuals pipeline:</p>
                                <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                  <table className="w-full border-collapse">
                                    <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Variable</th><th className="border border-gray-200 px-2 py-1 text-left">Default</th></tr></thead>
                                    <tbody>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">catalog</td><td className="border border-gray-200 px-2 py-1 font-mono">billing</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">schema</td><td className="border border-gray-200 px-2 py-1 font-mono">azure</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">volume_name</td><td className="border border-gray-200 px-2 py-1 font-mono">cost_export</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">warehouse_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                    </tbody>
                                  </table>
                                </div>
                                <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
                                  <strong>ℹ️</strong> Amortized and FOCUS pipelines use the same schema — just different source paths. Both are paused by default.
                                </div>
                              </>
                            ) : step === 4 ? (
                              <ol className="space-y-2">
                                <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Authenticate to your workspace:</span></li>
                                <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                  <pre>{"databricks auth login --host <workspace-url> --profile cloud-infra-cost"}</pre>
                                </li>
                                <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Deploy the bundle:</span></li>
                                <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                  <pre>{"databricks bundle deploy --target dev --profile cloud-infra-cost"}</pre>
                                </li>
                                <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Validate in the Databricks UI — check <strong>Workflows</strong> for the file arrival jobs (<code className="rounded bg-gray-200 px-1">azure_cost_job</code> active, amortized/FOCUS paused by default)</span></li>
                              </ol>
                            ) : (
                              <>
                                <p className="mb-3">Once the bundle is deployed, validate your dashboards.</p>
                                <p className="font-medium text-gray-700 mb-1">File arrival jobs to check in Workflows:</p>
                                <ul className="space-y-1 mb-4">
                                  <li>• <code className="rounded bg-gray-200 px-1">azure_cost_job</code> — active by default (Actuals)</li>
                                  <li>• <code className="rounded bg-gray-200 px-1">azure_amortized_job</code> — paused by default</li>
                                  <li>• <code className="rounded bg-gray-200 px-1">azure_focus_job</code> — paused by default</li>
                                </ul>
                              </>
                            )
                          ) : wizardCloud === "gcp" ? (
                            step === 1 ? (
                              <>
                                <p className="mb-3">Enable GCP Billing Export in the <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Google Cloud Billing Console</a> to stream billing data to BigQuery.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In the Billing console, select your billing account → <strong>Billing export</strong></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Under <strong>BigQuery export</strong>, click <strong>Edit settings</strong> for <em>Standard usage cost</em></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Choose or create a BigQuery project and dataset, then click <strong>Save</strong></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Note the project ID and dataset name — you'll need them in Step 4</span></li>
                                </ol>
                                <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                  <strong>⏱ Note:</strong> Initial export takes up to 48 hours. After that, data is exported daily.
                                </div>
                              </>
                            ) : step === 2 ? (
                              <>
                                <p className="mb-3">Create a GCP Service Account with read access to the BigQuery billing dataset.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In the <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">IAM console</a>, create a new service account in the BigQuery project</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Grant the service account <strong>BigQuery Data Viewer</strong> and <strong>BigQuery Job User</strong> roles</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Create and download a <strong>JSON key</strong> for the service account</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Store the JSON key securely — it will be referenced in the Databricks asset bundle config</span></li>
                                </ol>
                              </>
                            ) : step === 3 ? (
                              <>
                                <p className="mb-3">Create a <a href="https://docs.databricks.com/gcp/en/connect/unity-catalog/cloud-storage/gcs.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">GCS External Location</a> in Unity Catalog so the bundle can write staging data.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Create a GCS bucket in your GCP project for staging</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>In Databricks, go to <strong>Catalog → External Data → Storage Credentials → Create credential</strong> and choose <strong>GCP Service Account</strong></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Go to <strong>External Locations → Create external location</strong>, set URL to <code className="rounded bg-gray-200 px-1">gs://your-bucket/</code></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Click <strong>Test connection</strong> to verify access</span></li>
                                </ol>
                              </>
                            ) : step === 4 ? (
                              <>
                                <p className="mb-3">Clone the <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/gcp" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">cloud-infra-costs/gcp</a> project, configure <code className="rounded bg-gray-200 px-1">databricks.yml</code>, then deploy.</p>
                                <p className="mb-2 font-medium text-gray-700">Required DAB variables:</p>
                                <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                  <table className="w-full border-collapse">
                                    <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Variable</th><th className="border border-gray-200 px-2 py-1 text-left">Default</th></tr></thead>
                                    <tbody>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">catalog</td><td className="border border-gray-200 px-2 py-1 font-mono">billing</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">schema</td><td className="border border-gray-200 px-2 py-1 font-mono">gcp</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">bq_project_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">bq_dataset</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">warehouse_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                    </tbody>
                                  </table>
                                </div>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Authenticate: <code className="rounded bg-gray-200 px-1">databricks configure</code></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Deploy: <code className="rounded bg-gray-200 px-1">databricks bundle deploy --target dev</code></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Run: <code className="rounded bg-gray-200 px-1">databricks bundle run</code></span></li>
                                </ol>
                              </>
                            ) : (
                              <>
                                <p className="mb-3">Once deployed, verify the job ran successfully and billing data is flowing into the gold table.</p>
                                <ul className="space-y-1 mb-4">
                                  <li>• Check <strong>Workflows</strong> for <code className="rounded bg-gray-200 px-1">gcp_cost_job</code> — runs daily</li>
                                  <li>• Verify <strong>bronze → silver → gold</strong> tables exist in <code className="rounded bg-gray-200 px-1">billing.gcp</code></li>
                                  <li>• Open the deployed <strong>dashboard</strong> to confirm cost data is visible</li>
                                </ul>
                                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                  <strong>ℹ️ Note:</strong> GCP billing export includes Compute Engine, Cloud Storage, networking, and all other GCP services. BigQuery export data typically reflects costs with a 1-day lag.
                                </div>
                              </>
                            )
                          ) : (
                            step === 1 ? (
                              <>
                                <p className="mb-3">Create an S3 bucket to receive CUR exports. The account that creates the export must also own the S3 bucket.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Create a new S3 bucket in your <strong>AWS payer account</strong> (recommended — includes costs for all member accounts)</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Configure the bucket per the <a href="https://docs.aws.amazon.com/cur/latest/userguide/dataexports-s3-bucket.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">AWS S3 bucket requirements</a> for data exports</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Note your bucket name — you'll need it in Step 2</span></li>
                                </ol>
                                <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                  <strong>💡 Tip:</strong> Use your payer account so that all AWS account costs are included.
                                </div>
                              </>
                            ) : step === 2 ? (
                              <>
                                <p className="mb-3">Configure a <a href="https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Standard Data Export</a> in the AWS console.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In the AWS console, navigate to <strong>Billing → Data Exports → Create</strong></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Configure with these exact settings:</span></li>
                                  <li className="ml-6 rounded-md bg-white p-2 font-mono text-xs">
                                    <div>Type of export: <strong>Standard Data Export</strong></div>
                                    <div>✅ Include resource IDs</div>
                                    <div>Time granularity: <strong>Hourly</strong></div>
                                    <div>Column selection: <strong>Select all columns</strong></div>
                                    <div>Compression type and file format: <strong>Parquet</strong></div>
                                    <div>File versioning: <strong>Overwrite existing data export file</strong></div>
                                  </li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Set delivery destination to the S3 bucket from Step 1</span></li>
                                </ol>
                                <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                  <strong>⏱ Note:</strong> CUR data typically takes 24 hours to start appearing.
                                </div>
                              </>
                            ) : step === 3 ? (
                              <>
                                <p className="mb-3">Create a <a href="https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/#storage-credentials" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Storage Credential</a> and <a href="https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/#overview-of-external-locations" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">External Location</a> pointing to your S3 bucket.</p>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In Databricks, go to <strong>Catalog → External Data → Storage Credentials → Create credential</strong></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Choose <strong>AWS IAM role</strong>, create a role with <code className="rounded bg-gray-200 px-1">s3:GetObject</code> and <code className="rounded bg-gray-200 px-1">s3:ListBucket</code> on your CUR bucket</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Go to <strong>External Locations → Create external location</strong></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Set the URL to your S3 path (e.g. <code className="rounded bg-gray-200 px-1">s3://your-bucket/cur-prefix/</code>) and select the credential</span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">e.</span><span>Click <strong>Test connection</strong> to verify access</span></li>
                                </ol>
                              </>
                            ) : step === 4 ? (
                              <>
                                <p className="mb-3">Clone the <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/aws" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">cloud-infra-costs/aws</a> project, configure <code className="rounded bg-gray-200 px-1">databricks.yml</code>, then deploy.</p>
                                <p className="mb-2 font-medium text-gray-700">Required DAB variables:</p>
                                <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                  <table className="w-full border-collapse">
                                    <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Variable</th><th className="border border-gray-200 px-2 py-1 text-left">Default</th></tr></thead>
                                    <tbody>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">catalog</td><td className="border border-gray-200 px-2 py-1 font-mono">billing</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">schema</td><td className="border border-gray-200 px-2 py-1 font-mono">aws</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">storage_location</td><td className="border border-gray-200 px-2 py-1 text-red-600">required (S3 folder)</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">job_alerts_email</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                      <tr><td className="border border-gray-200 px-2 py-1 font-mono">warehouse_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                    </tbody>
                                  </table>
                                </div>
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Authenticate: <code className="rounded bg-gray-200 px-1">databricks configure</code></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Deploy dev: <code className="rounded bg-gray-200 px-1">databricks bundle deploy --target dev</code></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Deploy prod: <code className="rounded bg-gray-200 px-1">databricks bundle deploy --target prod</code></span></li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Run the job: <code className="rounded bg-gray-200 px-1">databricks bundle run</code></span></li>
                                </ol>
                              </>
                            ) : (
                              <>
                                <p className="mb-3">Once deployed, verify the job ran successfully and data is flowing into the gold table.</p>
                                <ul className="space-y-1 mb-4">
                                  <li>• Check <strong>Workflows</strong> for <code className="rounded bg-gray-200 px-1">aws_cost_job</code> — runs daily in prod</li>
                                  <li>• Verify <strong>bronze → silver → gold</strong> tables exist in <code className="rounded bg-gray-200 px-1">billing.aws</code></li>
                                  <li>• Open the deployed <strong>dashboard</strong> to confirm cost data is visible</li>
                                </ul>
                                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                  <strong>⚠️ Limitations:</strong> S3 storage charges and data egress are not included. AWS CUR only includes the latest tag key-value pair per resource.
                                </div>
                              </>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 pt-3">
                  <a
                    href={wizardCloud === "azure"
                      ? "https://github.com/databricks-solutions/cloud-infra-costs/tree/main/azure"
                      : wizardCloud === "gcp"
                      ? "https://github.com/databricks-solutions/cloud-infra-costs/tree/main/gcp"
                      : "https://github.com/databricks-solutions/cloud-infra-costs/tree/main/aws"}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    {wizardCloud === "azure" ? "cloud-infra-costs/azure README" : wizardCloud === "gcp" ? "cloud-infra-costs/gcp README" : "cloud-infra-costs/aws README"}
                  </a>
                  <a
                    href="https://docs.databricks.com/en/dev-tools/bundles/index.html"
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Databricks Asset Bundles Docs
                  </a>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
            <div>
              {wizardCloud !== null && !viewingIntegration && (
                <button
                  onClick={() => { setWizardCloud(null); setWizardExpandedStep(null); }}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  ← Choose a different cloud
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
              {wizardCloud !== null && !viewingIntegration && !cloudIntegrations.some(i => i.cloud === wizardCloud) && cloudIntegrations.length < 3 && (
                <button
                  onClick={() => {
                    if (wizardCloud) addIntegration(wizardCloud);
                    onClose();
                  }}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                  style={{ backgroundColor: '#FF3621' }}
                >
                  Mark as configured
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
