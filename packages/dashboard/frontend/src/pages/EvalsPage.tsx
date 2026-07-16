import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { AlertBanner } from "../components/AlertBanner";
import { StatusBadge } from "../components/StatusBadge";
import { RefreshCw, Plus, Play, FileSpreadsheet } from "lucide-react";
import type { EvalRun, EvalSuite } from "@aart/types";

/** `GET /api/evals`'s real response shape (server.ts). */
interface EvalsResponse {
  suites: EvalSuite[];
  runs: EvalRun[];
}

export function EvalsPage() {
  const [data, setData] = useState<EvalsResponse | null>(null);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // New Suite Form
  const [suiteName, setSuiteName] = useState("");
  const [suiteDescription, setSuiteDescription] = useState("");
  const [scorerKind, setScorerKind] = useState("exact_match");
  const [suiteDialogOpen, setSuiteDialogOpen] = useState(false);
  const [creatingSuite, setCreatingSuite] = useState(false);
  const [suiteError, setSuiteError] = useState("");

  // Trigger Eval Run Form
  const [runSuiteId, setRunSuiteId] = useState("");
  const [runWorkflowId, setRunWorkflowId] = useState("");
  const [runWorkflowVersion, setRunWorkflowVersion] = useState("1.0.0");
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [triggeringRun, setTriggeringRun] = useState(false);
  const [runError, setRunError] = useState("");

  const fetchData = async () => {
    setLoading(true);
    try {
      const [evalsRes, wfsRes] = await Promise.all([
        fetch("/api/evals"),
        fetch("/api/workflows")
      ]);
      if (evalsRes.ok) setData((await evalsRes.json()) as EvalsResponse);
      if (wfsRes.ok) setWorkflows(await wfsRes.json());
    } catch (err) {
      console.error("Failed to fetch eval data", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreateSuite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suiteName) return;
    setCreatingSuite(true);
    setSuiteError("");
    try {
      const res = await fetch("/api/evals/suites", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `name=${encodeURIComponent(suiteName)}&description=${encodeURIComponent(suiteDescription)}&scorerKind=${encodeURIComponent(scorerKind)}`,
      });
      if (res.ok) {
        setSuiteDialogOpen(false);
        setSuiteName("");
        setSuiteDescription("");
        fetchData();
      } else {
        const err = await res.json();
        setSuiteError(err.error || "Failed to create suite");
      }
    } catch {
      setSuiteError("Network error creating suite");
    } finally {
      setCreatingSuite(false);
    }
  };

  const handleTriggerRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!runSuiteId || !runWorkflowId) return;
    setTriggeringRun(true);
    setRunError("");
    try {
      const res = await fetch("/api/evals/runs", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `suiteId=${encodeURIComponent(runSuiteId)}&workflowId=${encodeURIComponent(runWorkflowId)}&workflowVersion=${encodeURIComponent(runWorkflowVersion)}`,
      });
      if (res.ok) {
        setRunDialogOpen(false);
        fetchData();
      } else {
        const err = await res.json();
        setRunError(err.error || "Failed to run suite");
      }
    } catch {
      setRunError("Network error triggering run");
    } finally {
      setTriggeringRun(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileSpreadsheet}
        iconColor="text-indigo-400"
        title="Evaluation Suites"
        subtitle="Design benchmark scenarios, monitor assertions, and trigger LLM/agent scorecards."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={fetchData} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
            
            <Dialog open={suiteDialogOpen} onOpenChange={setSuiteDialogOpen}>
              <DialogTrigger render={<Button variant="outline" size="sm" className="border-zinc-800 text-zinc-300 hover:bg-zinc-900" />}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                New Suite
              </DialogTrigger>
              <DialogContent className="border-zinc-800 bg-zinc-950 max-w-sm">
                <DialogHeader>
                  <DialogTitle className="text-zinc-100">Create Evaluation Suite</DialogTitle>
                  <DialogDescription className="text-zinc-400">
                    Establish a test suite to continuously evaluate workflow spec changes.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreateSuite} className="space-y-4 py-2">
                  <AlertBanner variant="error" message={suiteError} />
                  <div className="space-y-1">
                    <label htmlFor="suite-name" className="text-xs font-semibold text-zinc-300">Suite Name</label>
                    <Input
                      id="suite-name"
                      placeholder="e.g. Accuracy Benchmark"
                      value={suiteName}
                      onChange={(e) => setSuiteName(e.target.value)}
                      className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="suite-description" className="text-xs font-semibold text-zinc-300">Description</label>
                    <Input
                      id="suite-description"
                      placeholder="Verify LLM extraction limits"
                      value={suiteDescription}
                      onChange={(e) => setSuiteDescription(e.target.value)}
                      className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="suite-scorer-kind" className="text-xs font-semibold text-zinc-300">Scorer Kind</label>
                    <select
                      id="suite-scorer-kind"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
                      value={scorerKind}
                      onChange={(e) => setScorerKind(e.target.value)}
                    >
                      <option value="exact_match">exact_match</option>
                      <option value="levenshtein">levenshtein</option>
                      <option value="numeric_delta">numeric_delta</option>
                    </select>
                  </div>
                  <DialogFooter className="pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSuiteDialogOpen(false)}
                      className="border-zinc-800 text-zinc-300 hover:bg-zinc-900"
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={creatingSuite} className="bg-primary text-primary-foreground">
                      {creatingSuite ? "Creating..." : "Create Suite"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
              <DialogTrigger render={<Button className="bg-primary text-primary-foreground hover:bg-primary/95" />}>
                <Play className="mr-1 h-3.5 w-3.5 fill-current" />
                Run Eval Suite
              </DialogTrigger>
              <DialogContent className="border-zinc-800 bg-zinc-950 max-w-sm">
                <DialogHeader>
                  <DialogTitle className="text-zinc-100">Trigger Evaluation Run</DialogTitle>
                  <DialogDescription className="text-zinc-400">
                    Select a Suite and Workflow to execute benchmark verification.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleTriggerRun} className="space-y-4 py-2">
                  <AlertBanner variant="error" message={runError} />
                  
                  <div className="space-y-1">
                    <label htmlFor="run-suite-id" className="text-xs font-semibold text-zinc-300">Eval Suite</label>
                    <select
                      id="run-suite-id"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
                      value={runSuiteId}
                      onChange={(e) => setRunSuiteId(e.target.value)}
                      required
                    >
                      <option value="">Select suite...</option>
                      {(data?.suites || []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="run-workflow-id" className="text-xs font-semibold text-zinc-300">Workflow Spec ID</label>
                    <select
                      id="run-workflow-id"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
                      value={runWorkflowId}
                      onChange={(e) => setRunWorkflowId(e.target.value)}
                      required
                    >
                      <option value="">Select workflow...</option>
                      {workflows.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="run-workflow-version" className="text-xs font-semibold text-zinc-300">Workflow Version</label>
                    <Input
                      id="run-workflow-version"
                      placeholder="e.g. 1.0.0"
                      value={runWorkflowVersion}
                      onChange={(e) => setRunWorkflowVersion(e.target.value)}
                      className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
                      required
                    />
                  </div>

                  <DialogFooter className="pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setRunDialogOpen(false)}
                      className="border-zinc-800 text-zinc-300 hover:bg-zinc-900"
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={triggeringRun} className="bg-primary text-primary-foreground">
                      {triggeringRun ? "Triggering..." : "Start Eval"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      {loading ? (
        <LoadingState message="Loading evaluation metrics..." />
      ) : !data ? (
        <EmptyState message="No metrics available." icon={FileSpreadsheet} />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
          {/* Suites List */}
          <Card className="bg-zinc-900/30 border-zinc-800 animate-slide-up">
            <CardHeader className="pb-3 border-b border-zinc-800">
              <CardTitle className="text-sm font-semibold text-zinc-300">Registered Suites</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.suites.length === 0 ? (
                <div className="p-6">
                  <EmptyState message="No Eval Suites created yet." icon={FileSpreadsheet} />
                </div>
              ) : (
                <Table>
                  <TableHeader className="bg-zinc-900/50 border-zinc-800">
                    <TableRow className="border-zinc-800 hover:bg-transparent">
                      <TableHead className="text-zinc-400 text-xs font-semibold">Name</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold">Description</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold">Scorer</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold text-center">Examples</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.suites.map((suite) => (
                      <TableRow key={suite.id} className="border-zinc-800 hover:bg-zinc-900/20">
                        <TableCell className="text-zinc-200 font-semibold text-sm">
                          {suite.name}
                          <div className="text-[10px] text-zinc-500 font-mono mt-0.5">{suite.id}</div>
                        </TableCell>
                        <TableCell className="text-zinc-400 text-xs">{suite.description || "-"}</TableCell>
                        <TableCell className="font-mono text-xs text-zinc-400">{suite.scorer?.kind || "exact_match"}</TableCell>
                        <TableCell className="text-center font-mono text-xs text-zinc-400">{(suite.examples || []).length}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Runs List */}
          <Card className="bg-zinc-900/30 border-zinc-800 animate-slide-up">
            <CardHeader className="pb-3 border-b border-zinc-800">
              <CardTitle className="text-sm font-semibold text-zinc-300">Continuous Eval Executions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.runs.length === 0 ? (
                <div className="p-6">
                  <EmptyState message="No Eval runs launched yet." icon={Play} />
                </div>
              ) : (
                <Table>
                  <TableHeader className="bg-zinc-900/50 border-zinc-800">
                    <TableRow className="border-zinc-800 hover:bg-transparent">
                      <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold">Suite ID</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold">Target Spec</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold text-center">Summary (Passed/Total)</TableHead>
                      <TableHead className="text-zinc-400 text-xs font-semibold text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.runs.map((run) => {
                      // EvalRun has no nested `summary` object — `passed`/
                      // `total` are its own top-level fields
                      // (packages/types/src/eval.ts).
                      const passed = run.passed || 0;
                      const total = run.total || 0;

                      return (
                        <TableRow key={run.id} className="border-zinc-800 hover:bg-zinc-900/20">
                          <TableCell className="font-mono text-zinc-200 text-xs font-semibold">{run.id}</TableCell>
                          <TableCell className="font-mono text-zinc-400 text-xs">{run.suiteId}</TableCell>
                          <TableCell className="text-zinc-300 text-xs">
                            <span className="font-semibold">{run.workflowId}</span> (v{run.workflowVersion})
                          </TableCell>
                          <TableCell className="text-center font-mono text-xs text-zinc-300">
                            {passed} / {total}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge status={run.status} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
