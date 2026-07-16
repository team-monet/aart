import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "../components/StatusBadge";
import { LoadingState } from "../components/LoadingState";
import { AlertBanner } from "../components/AlertBanner";
import { ArrowLeft, RefreshCw, AlertOctagon, HelpCircle, FileEdit } from "lucide-react";
import type { RunRecord, StepTrace } from "@aart/types";

/** `GET /api/runs/:id`'s real response shape (packages/dashboard/src/server.ts) — the RunRecord plus a pre-rendered HTML execution report (@aart/evidence's report-renderer seam, S6 E3). */
interface RunDetailResponse {
  run: RunRecord;
  reportHtml: string;
}

/** Map step status → timeline dot color */
function stepDotColor(status: string): string {
  switch (status) {
    case "completed":
    case "ok":
      return "bg-emerald-500";
    case "failed":
    case "error":
      return "bg-rose-500";
    case "running":
    case "in_progress":
      return "bg-sky-500";
    case "waiting":
      return "bg-purple-500";
    case "pending":
      return "bg-amber-500";
    default:
      return "bg-zinc-500";
  }
}

export function RunDetailPage({ id }: { id: string }) {
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchDetail = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
      if (res.ok) {
        const payload = await res.json();
        setData(payload);
      } else {
        setError("Run not found.");
      }
    } catch {
      setError("Failed to load run details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
  }, [id]);

  if (loading) {
    return <LoadingState message="Loading run details..." />;
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Link href="/runs" className="text-zinc-400 hover:text-zinc-200">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm text-zinc-500">Back to Runs</span>
        </div>
        <AlertBanner variant="error" message={error || "Run details unavailable"} />
      </div>
    );
  }

  const { run, reportHtml } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/runs" className="p-2 border border-zinc-800 hover:bg-zinc-900 text-zinc-300 rounded-lg">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-500 font-mono uppercase tracking-wider">Run ID</span>
              <h1 className="text-2xl font-mono font-bold text-zinc-100">{run.runId}</h1>
              <StatusBadge status={run.status} />
            </div>
            <p className="text-sm text-zinc-400 mt-1">
              Workflow: <span className="text-zinc-200 font-semibold">{run.workflowId}</span> (v{run.workflowVersion || "-"})
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDetail} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Flag / Waits alerts */}
      {run.flag && (
        <div className="flex items-center justify-between p-4 bg-red-950/20 border border-red-500/20 text-red-400 rounded-xl">
          <div className="flex items-center gap-3">
            <AlertOctagon className="h-5 w-5 text-red-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold">Flagged: {run.flag.kind}</p>
              <p className="text-xs text-red-400/80">Flagged at {new Date(run.flag.flaggedAt).toLocaleString()}</p>
            </div>
          </div>
          <Link href="/flagged-runs">
            <Button variant="destructive" size="sm" className="bg-red-500 hover:bg-red-600 text-white border-0">
              Manage Flags
            </Button>
          </Link>
        </div>
      )}

      {run.status === "waiting" && run.waits && run.waits.length > 0 && (
        <div className="flex items-center justify-between p-4 bg-purple-950/20 border border-purple-500/20 text-purple-400 rounded-xl">
          <div className="flex items-center gap-3">
            <HelpCircle className="h-5 w-5 text-purple-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold">Waiting on Actions</p>
              <p className="text-xs text-purple-400/80">
                This run is currently blocked waiting on approvals or manual steps.
              </p>
            </div>
          </div>
          <Link href="/waiting-runs">
            <Button variant="outline" size="sm" className="border-purple-800 hover:bg-purple-900 text-purple-300">
              View Wait Queue
            </Button>
          </Link>
        </div>
      )}

      {/* Metadata Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Started:</span>
              <span className="text-zinc-300 font-mono text-xs">
                {run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Completed:</span>
              <span className="text-zinc-300 font-mono text-xs">
                {run.endedAt ? new Date(run.endedAt).toLocaleString() : "-"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Environment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Execution Env:</span>
              {/* RunRecord has no top-level `environment` field — the trigger
                  form's optional Environment input is threaded through into
                  `params.environment` (server.ts's POST /api/runs/trigger,
                  stub-deps.ts's makeTriggerRun), not a field of its own. */}
              <span className="text-zinc-300 font-semibold">{(run.params?.["environment"] as string | undefined) || "default"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Trigger source:</span>
              <span className="text-zinc-300">Manual Dashboard</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Execution Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Steps Executed:</span>
              <span className="text-zinc-300 font-mono">{(run.trace || []).length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Artifacts Generated:</span>
              <span className="text-zinc-300 font-mono">{(run.artifacts || []).length}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* JSON Inputs & Outputs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-zinc-300">Run Inputs</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-zinc-900 p-4 rounded-lg overflow-x-auto text-xs font-mono text-emerald-400 max-h-60 border border-zinc-800">
              {JSON.stringify(run.inputs || {}, null, 2)}
            </pre>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-zinc-300">Run Outputs</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-zinc-900 p-4 rounded-lg overflow-x-auto text-xs font-mono text-cyan-400 max-h-60 border border-zinc-800">
              {JSON.stringify(run.outputs || {}, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>

      {/* Trace / Steps list with visual timeline */}
      {run.trace && run.trace.length > 0 && (
        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-zinc-300">Step Traces & Corrections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative">
              {run.trace.map((step: StepTrace, index: number) => {
                const isLast = index === (run.trace || []).length - 1;
                return (
                  <div key={index} className="relative flex gap-4">
                    {/* Timeline connector */}
                    <div className="flex flex-col items-center shrink-0 pt-1">
                      {/* Dot */}
                      <div className={`relative z-10 h-3 w-3 rounded-full border-2 border-zinc-950 ${stepDotColor(step.status)}`} />
                      {/* Vertical line */}
                      {!isLast && (
                        <div className="w-px flex-1 bg-zinc-800 mt-0.5" />
                      )}
                    </div>
                    {/* Step content */}
                    <div className="flex-1 pb-6 flex justify-between items-start gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="bg-zinc-900 text-zinc-400 font-mono text-[10px] px-2 py-0.5 rounded border border-zinc-800">
                            Seq {step.seq}
                          </span>
                          <h4 className="text-sm font-semibold text-zinc-200">{step.stepId}</h4>
                          <span className="text-xs font-mono text-zinc-500">({step.block})</span>
                          <StatusBadge status={step.status} />
                          {step.postHocCorrected && (
                            <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase">
                              Corrected
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-xs mt-2 pl-4">
                          <div>
                            <span className="text-zinc-500 font-semibold">Inputs:</span>
                            <pre className="text-zinc-400 font-mono mt-0.5 bg-zinc-900/50 p-2 rounded max-h-36 overflow-auto">
                              {JSON.stringify(step.inputs, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <span className="text-zinc-500 font-semibold">Outputs:</span>
                            <pre className="text-zinc-400 font-mono mt-0.5 bg-zinc-900/50 p-2 rounded max-h-36 overflow-auto">
                              {JSON.stringify(step.outputs, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </div>
                      
                      <Link href={`/corrections/new?runId=${encodeURIComponent(run.runId)}&stepId=${encodeURIComponent(step.stepId)}`}>
                        <Button variant="outline" size="sm" className="border-zinc-800 hover:bg-zinc-900 text-zinc-300 shrink-0">
                          <FileEdit className="mr-1 h-3.5 w-3.5" />
                          Correct Step
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* HTML execution report */}
      {reportHtml && (
        <Card className="bg-zinc-900/30 border-zinc-800 overflow-hidden">
          <CardHeader className="border-b border-zinc-800">
            <CardTitle className="text-sm font-semibold text-zinc-300">HTML Execution Report</CardTitle>
          </CardHeader>
          <CardContent className="p-0 bg-zinc-900">
            <div 
              className="run-report-container p-6 overflow-auto max-h-[600px] text-zinc-200"
              aria-label="Execution report"
              dangerouslySetInnerHTML={{ __html: reportHtml }} 
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
