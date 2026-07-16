import { useEffect, useState } from "react";
import { Link, useRouter } from "../router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { AlertBanner } from "../components/AlertBanner";
import { ArrowLeft, RefreshCw, Check, X, ShieldAlert, Zap, AlertTriangle, ArrowRightLeft, GitBranch } from "lucide-react";
import type { Environment, RunRecord, Workflow } from "@aart/types";
import type { SemanticRiskDiff } from "@aart/governance";

/** `GET /api/workflows/:id`'s real response shape (server.ts). */
interface WorkflowDetailResponse {
  workflow: Workflow;
  versions: string[];
  recentRuns: RunRecord[];
}

export function WorkflowsPage({ id }: { id?: string }) {
  const { query, navigate } = useRouter();
  const selectedVersion = query.get("version") || "";

  // Lists view state
  const [workflowIds, setWorkflowIds] = useState<string[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // Detail view state
  const [detail, setDetail] = useState<WorkflowDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  // Risk Diff form state
  const [fromVersion, setFromVersion] = useState("");
  const [toVersion, setToVersion] = useState("");
  const [riskDiff, setRiskDiff] = useState<SemanticRiskDiff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // Environments for Promote dropdown
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState("");

  const fetchList = async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/workflows");
      if (res.ok) {
        setWorkflowIds(await res.json());
      }
    } catch (err) {
      console.error("Failed to load workflows list", err);
    } finally {
      setLoadingList(false);
    }
  };

  const fetchEnvironments = async () => {
    try {
      const res = await fetch("/api/environments");
      if (res.ok) {
        const envs = await res.json();
        setEnvironments(envs);
        if (envs.length > 0) {
          setSelectedEnvId(envs[0].id);
        }
      }
    } catch (err) {
      console.error("Failed to fetch environments", err);
    }
  };

  const fetchDetail = async () => {
    if (!id) return;
    setLoadingDetail(true);
    setActionError("");
    setActionSuccess("");
    setRiskDiff(null);
    try {
      const q = selectedVersion ? `?version=${selectedVersion}` : "";
      const res = await fetch(`/api/workflows/${encodeURIComponent(id)}${q}`);
      if (res.ok) {
        const payload = (await res.json()) as WorkflowDetailResponse;
        setDetail(payload);
        // Default risk diff selectors
        if (payload.versions && payload.versions.length > 0) {
          setFromVersion(payload.versions[payload.versions.length - 1] || "");
          setToVersion(payload.versions[0] || "");
        }
      }
    } catch (err) {
      console.error("Failed to load workflow details", err);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    if (id) {
      fetchDetail();
      fetchEnvironments();
    } else {
      fetchList();
    }
  }, [id, selectedVersion]);

  const handleAction = async (endpoint: string, body: Record<string, unknown>, successMsg: string) => {
    if (!id) return;
    setActionError("");
    setActionSuccess("");
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(id)}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setActionSuccess(successMsg);
        fetchDetail();
      } else {
        const data = await res.json();
        setActionError(data.error || `Failed to perform ${endpoint}`);
      }
    } catch {
      setActionError("Network error executing action");
    }
  };

  const handleCompareRisk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !fromVersion || !toVersion) return;
    setLoadingDiff(true);
    setRiskDiff(null);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(id)}/risk-diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromVersion, toVersion }),
      });
      if (res.ok) {
        setRiskDiff((await res.json()) as SemanticRiskDiff);
      } else {
        const data = await res.json();
        setActionError(data.error || "Failed to compare versions");
      }
    } catch {
      setActionError("Network error performing risk comparison");
    } finally {
      setLoadingDiff(false);
    }
  };

  // ----------------------------------------------------
  // LIST VIEW
  // ----------------------------------------------------
  if (!id) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={GitBranch}
          title="Workflow Definitions"
          subtitle="Manage and audit governed workflow specifications."
        />

        <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden animate-slide-up">
          {loadingList ? (
            <LoadingState message="Loading workflows..." />
          ) : workflowIds.length === 0 ? (
            <EmptyState message="No workflows registered." />
          ) : (
            <Table>
              <TableHeader className="bg-zinc-900/50 border-zinc-800">
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="text-zinc-400 text-xs font-semibold">Workflow ID</TableHead>
                  <TableHead className="text-zinc-400 text-xs font-semibold text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflowIds.map((wId) => (
                  <TableRow key={wId} className="border-zinc-800 hover:bg-zinc-900/20">
                    <TableCell className="text-zinc-200 font-semibold text-sm">
                      <Link href={`/workflows/${wId}`} className="text-primary hover:underline">
                        {wId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/workflows/${wId}`}>
                        <Button variant="outline" size="sm" className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
                          View Version History
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    );
  }

  // ----------------------------------------------------
  // DETAIL VIEW
  // ----------------------------------------------------
  if (loadingDetail || !detail) {
    return <LoadingState message="Loading workflow details..." />;
  }

  const { workflow, versions, recentRuns } = detail;
  const currentVersion = workflow.version;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/workflows" className="p-2 border border-zinc-800 hover:bg-zinc-900 text-zinc-300 rounded-lg">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Workflow</span>
              <h1 className="text-2xl font-bold text-zinc-100">{id}</h1>
              <span className="text-xs text-zinc-400 bg-zinc-900 px-2 py-0.5 border border-zinc-800 rounded font-mono">
                v{currentVersion}
              </span>
              <StatusBadge status={workflow.approval || "draft"} />
            </div>
            <p className="text-sm text-zinc-400 mt-1">
              Select versions in the sidebar to review Spec risk changes.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDetail} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <AlertBanner variant="error" message={actionError} />
      <AlertBanner variant="success" message={actionSuccess} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Versions Sidebar */}
        <div className="space-y-4 lg:col-span-1">
          <Card className="bg-zinc-950 border-zinc-900">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Version Spec History
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-zinc-900">
                {versions.map((ver) => {
                  const isViewing = ver === currentVersion;
                  return (
                    <button
                      key={ver}
                      onClick={() => navigate(`/workflows/${encodeURIComponent(id)}?version=${ver}`)}
                      className={`w-full text-left p-3 text-xs font-mono transition-colors flex justify-between items-center ${
                        isViewing
                          ? "bg-primary/10 text-primary hover:bg-primary/15 font-semibold"
                          : "text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200"
                      }`}
                    >
                      <span>{ver}</span>
                      {isViewing && (
                        <span className="text-[10px] bg-primary text-primary-foreground font-sans px-1.5 py-0.5 rounded font-semibold uppercase">
                          Viewing
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Content Area */}
        <div className="space-y-6 lg:col-span-3">
          {/* Gates Audit Status */}
          <Card className="bg-zinc-950 border-zinc-900">
            <CardHeader>
              <CardTitle className="text-sm font-semibold text-zinc-300">Governance Gate Approvals</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                {Object.entries(workflow.gates || {}).map(([gateName, status]) => (
                  <div key={gateName} className="p-3 bg-zinc-900 border border-zinc-800 rounded-lg flex flex-col items-center justify-center text-center space-y-1.5">
                    <span className="text-[10px] uppercase font-bold text-zinc-500 font-sans tracking-wide">
                      {gateName}
                    </span>
                    <StatusBadge status={status as string} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <Card className="bg-zinc-950 border-zinc-900">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-zinc-300">Governance & Release Controls</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              {workflow.approval !== "approved" && (
                <Button
                  onClick={() => handleAction("approve", { version: currentVersion, action: "approve", trustMode: "governed" }, `Approved v${currentVersion} successfully`)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white border-0 text-xs"
                >
                  <Check className="mr-1.5 h-4 w-4" />
                  Approve Version
                </Button>
              )}

              {workflow.approval === "approved" && (
                <Button
                  onClick={() => handleAction("approve", { version: currentVersion, action: "deprecate", trustMode: "governed" }, `Deprecated v${currentVersion} successfully`)}
                  variant="destructive"
                  className="text-xs"
                >
                  <X className="mr-1.5 h-4 w-4" />
                  Deprecate Version
                </Button>
              )}

              {/* Mark / Clear needs review */}
              {workflow.gates?.riskReview === "pending" || workflow.gates?.riskReview === "failed" ? (
                <Button
                  onClick={() => handleAction("clear-needs-review", { version: currentVersion }, "Cleared needs-review flag")}
                  variant="outline"
                  className="border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs"
                >
                  <Zap className="mr-1.5 h-4 w-4 text-emerald-400" />
                  Clear Needs Review
                </Button>
              ) : (
                <Button
                  onClick={() => handleAction("mark-needs-review", { version: currentVersion }, "Marked workflow as needs-review")}
                  variant="outline"
                  className="border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs"
                >
                  <AlertTriangle className="mr-1.5 h-4 w-4 text-amber-400" />
                  Mark Needs Review
                </Button>
              )}

              {/* Block / Unblock Promotion */}
              {workflow.promotionBlocked ? (
                <Button
                  onClick={() => handleAction("unblock-promotion", { version: currentVersion }, "Unblocked workflow promotion")}
                  variant="outline"
                  className="border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs"
                >
                  <Check className="mr-1.5 h-4 w-4 text-emerald-400" />
                  Unblock spec
                </Button>
              ) : (
                <Button
                  onClick={() => handleAction("block-promotion", { version: currentVersion }, "Blocked workflow promotion")}
                  variant="outline"
                  className="border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs"
                >
                  <ShieldAlert className="mr-1.5 h-4 w-4 text-rose-400" />
                  Block spec
                </Button>
              )}

              <Button
                onClick={() => handleAction("trigger-improvement", { version: currentVersion }, "Triggered specs optimization/improvement proposal")}
                variant="outline"
                className="border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs"
              >
                <Zap className="mr-1.5 h-4 w-4 text-yellow-400" />
                Improve Spec
              </Button>

              {/* Promotion Box */}
              <div className="w-full border-t border-zinc-900 my-2 pt-4 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label htmlFor="promote-env-select" className="text-xs text-zinc-400">Promote to:</label>
                  <select
                    id="promote-env-select"
                    className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-300 focus:outline-none"
                    value={selectedEnvId}
                    onChange={(e) => setSelectedEnvId(e.target.value)}
                  >
                    <option value="">Select target...</option>
                    {environments.map((env) => (
                      <option key={env.id} value={env.id}>
                        {env.name || env.id}
                      </option>
                    ))}
                    {!environments.length && (
                      <option value="production">production</option>
                    )}
                  </select>
                </div>
                <Button
                  onClick={() => handleAction("promote", { version: currentVersion, environmentId: selectedEnvId || "production" }, `Promoted spec to ${selectedEnvId || "production"} successfully`)}
                  className="bg-primary text-primary-foreground text-xs"
                >
                  Confirm Promotion
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Semantic Risk Diff tool */}
          <Card className="bg-zinc-950 border-zinc-900">
            <CardHeader>
              <CardTitle className="text-sm font-semibold text-zinc-300">Semantic Risk Diff</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCompareRisk} className="flex flex-wrap gap-4 items-end pb-4 border-b border-zinc-900">
                <div className="space-y-1">
                  <label htmlFor="risk-diff-from" className="text-[10px] uppercase font-bold text-zinc-500">From version</label>
                  <select
                    id="risk-diff-from"
                    className="w-40 bg-zinc-900 border border-zinc-800 rounded p-1.5 text-xs text-zinc-200 focus:outline-none"
                    value={fromVersion}
                    onChange={(e) => setFromVersion(e.target.value)}
                  >
                    {versions.map((ver) => (
                      <option key={ver} value={ver}>
                        {ver}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="p-2 text-zinc-600">
                  <ArrowRightLeft className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="risk-diff-to" className="text-[10px] uppercase font-bold text-zinc-500">To version</label>
                  <select
                    id="risk-diff-to"
                    className="w-40 bg-zinc-900 border border-zinc-800 rounded p-1.5 text-xs text-zinc-200 focus:outline-none"
                    value={toVersion}
                    onChange={(e) => setToVersion(e.target.value)}
                  >
                    {versions.map((ver) => (
                      <option key={ver} value={ver}>
                        {ver}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit" disabled={loadingDiff} className="bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 text-xs">
                  {loadingDiff ? "Computing..." : "Compare Spec"}
                </Button>
              </form>

              {riskDiff && (
                <div className="mt-4 space-y-4">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Risk comparison results:</h4>
                  
                  {/* Capabilities Added */}
                  {riskDiff.newCapabilities && riskDiff.newCapabilities.length > 0 && (
                    <div className="p-3 bg-red-950/20 border border-red-500/20 rounded-lg">
                      <span className="text-xs font-bold text-red-400 flex items-center gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
                        New capabilities requested:
                      </span>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {riskDiff.newCapabilities.map((cap: string) => (
                          <span key={cap} className="bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] font-mono font-semibold px-2 py-0.5 rounded">
                            {cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* General modifications */}
                  <pre className="bg-zinc-900 p-4 rounded-lg overflow-x-auto text-xs font-mono text-zinc-300 max-h-80 border border-zinc-800">
                    {JSON.stringify(riskDiff, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Runs for this Workflow */}
          <Card className="bg-zinc-950 border-zinc-900">
            <CardHeader>
              <CardTitle className="text-sm font-semibold text-zinc-300">Recent Executions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {recentRuns.length === 0 ? (
                <EmptyState message="No executions recorded for this workflow spec." />
              ) : (
                <Table>
                  <TableHeader className="bg-zinc-900/50 border-zinc-800">
                    <TableRow className="border-zinc-800 hover:bg-transparent">
                      <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold text-center">Version</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold text-center">Status</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold">Started At</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentRuns.map((run) => (
                      <TableRow key={run.runId} className="border-zinc-800 hover:bg-zinc-900/20">
                        <TableCell className="font-mono text-zinc-200 text-xs font-medium">
                          <Link href={`/runs/${run.runId}`} className="text-primary hover:underline">
                            {run.runId}
                          </Link>
                        </TableCell>
                        <TableCell className="text-center font-mono text-xs text-zinc-400">
                          {run.workflowVersion || "-"}
                        </TableCell>
                        <TableCell className="text-center">
                          <StatusBadge status={run.status} />
                        </TableCell>
                        <TableCell className="text-zinc-400 text-xs font-mono">
                          {run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
