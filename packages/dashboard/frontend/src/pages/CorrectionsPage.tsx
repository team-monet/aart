import { useEffect, useState } from "react";
import { Link, useRouter } from "../router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { AlertBanner } from "../components/AlertBanner";
import { RefreshCw, FileEdit, ArrowLeft, Send, Pencil } from "lucide-react";
import type { Correction, EvalSuite } from "@aart/types";

export function CorrectionsPage({ isNewForm }: { isNewForm?: boolean }) {
  const { query, navigate } = useRouter();

  // List View state
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // New Form state
  const [runId, setRunId] = useState(query.get("runId") || "");
  const [stepId, setStepId] = useState(query.get("stepId") || "");
  const [fieldPath, setFieldPath] = useState(query.get("fieldPath") || "outputs.total");
  const [observed, setObserved] = useState("null");
  const [corrected, setCorrected] = useState("null");
  const [reason, setReason] = useState("");
  const [reviewer, setReviewer] = useState("dashboard-operator");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Action/Outcome state
  const [evalDialogOpen, setEvalDialogOpen] = useState(false);
  const [selectedCorrectionKey, setSelectedCorrectionKey] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [actionSuccess, setActionSuccess] = useState("");
  const [actionError, setActionError] = useState("");
  // Outcome-dependent shape (RunRecord | EvalExample | ImprovementBrief
  // depending on which correction outcome ran) — `unknown`, not `any`: the
  // render below only ever JSON.stringifies it, never reads a named field,
  // so there's no drift class to catch here, but `unknown` still forces any
  // FUTURE field access to be checked rather than silently compiling.
  const [actionOutput, setActionOutput] = useState<unknown | null>(null);

  const fetchCorrections = async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/corrections");
      if (res.ok) {
        setCorrections((await res.json()) as Correction[]);
      }
    } catch (err) {
      console.error("Failed to fetch corrections", err);
    } finally {
      setLoadingList(false);
    }
  };

  const fetchSuites = async () => {
    try {
      const res = await fetch("/api/evals");
      if (res.ok) {
        const payload = (await res.json()) as { suites: EvalSuite[]; runs: unknown[] };
        setSuites(payload.suites || []);
        if (payload.suites && payload.suites.length > 0) {
          setSuiteId(payload.suites[0]!.id);
        }
      }
    } catch (err) {
      console.error("Failed to fetch suites", err);
    }
  };

  useEffect(() => {
    if (isNewForm) {
      // Sync query params if they change
      setRunId(query.get("runId") || "");
      setStepId(query.get("stepId") || "");
    } else {
      fetchCorrections();
      fetchSuites();
    }
  }, [isNewForm, query]);

  const handleSubmitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    
    if (!runId || !stepId || !fieldPath) {
      setFormError("Run ID, Step ID, and Field Path are required.");
      return;
    }

    let parsedObserved = null;
    let parsedCorrected = null;

    try {
      parsedObserved = JSON.parse(observed);
    } catch {
      setFormError("Observed value must be valid JSON");
      return;
    }

    try {
      parsedCorrected = JSON.parse(corrected);
    } catch {
      setFormError("Corrected value must be valid JSON");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          stepId,
          fieldPath,
          observed: parsedObserved,
          corrected: parsedCorrected,
          reason,
          reviewer,
        }),
      });

      if (res.ok) {
        navigate("/corrections");
      } else {
        const err = await res.json();
        setFormError(err.error || "Failed to record correction");
      }
    } catch {
      setFormError("Network error submitting correction");
    } finally {
      setSubmitting(false);
    }
  };

  const executeOutcome = async (key: string, outcome: "update-run-output" | "create-issue" | "create-eval-example", body?: Record<string, unknown>) => {
    setActionError("");
    setActionSuccess("");
    setActionOutput(null);
    try {
      const encodedKey = encodeURIComponent(key);
      const res = await fetch(`/api/corrections/${encodedKey}/${outcome}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.ok) {
        const data = await res.json();
        if (outcome === "create-issue") {
          setActionOutput(data);
          setActionSuccess("Successfully created GitHub/GitLab issue for spec improvement.");
        } else {
          setActionSuccess(`Successfully executed: ${outcome.replace("-", " ")}`);
          fetchCorrections();
        }
      } else {
        const err = await res.json();
        setActionError(err.error || `Failed to execute outcome ${outcome}`);
      }
    } catch {
      setActionError("Network error running correction action");
    }
  };

  const handleCreateEvalExample = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCorrectionKey || !suiteId) return;
    setEvalDialogOpen(false);
    executeOutcome(selectedCorrectionKey, "create-eval-example", { suiteId });
  };

  // ----------------------------------------------------
  // RECORD NEW FORM
  // ----------------------------------------------------
  if (isNewForm) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={Pencil}
          title="Record Correction"
          subtitle="Identify and patch outputs for human feedback and Evals generation."
          actions={
            <Link href="/corrections" className="p-2 border border-zinc-800 hover:bg-zinc-900 text-zinc-300 rounded-lg">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          }
        />

        <Card className="bg-zinc-950 border-zinc-900 max-w-2xl">
          <CardContent className="pt-6">
            <form onSubmit={handleSubmitCorrection} className="space-y-4">
              <AlertBanner variant="error" message={formError} />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label htmlFor="correction-run-id" className="text-xs font-semibold text-zinc-300">Run ID</label>
                  <Input
                    id="correction-run-id"
                    placeholder="e.g. run_abc"
                    value={runId}
                    onChange={(e) => setRunId(e.target.value)}
                    className="bg-zinc-900 border-zinc-800 text-zinc-100"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="correction-step-id" className="text-xs font-semibold text-zinc-300">Step ID</label>
                  <Input
                    id="correction-step-id"
                    placeholder="e.g. step1"
                    value={stepId}
                    onChange={(e) => setStepId(e.target.value)}
                    className="bg-zinc-900 border-zinc-800 text-zinc-100"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="correction-field-path" className="text-xs font-semibold text-zinc-300">Field Path (dot-notation)</label>
                <Input
                  id="correction-field-path"
                  placeholder="e.g. outputs.total"
                  value={fieldPath}
                  onChange={(e) => setFieldPath(e.target.value)}
                  className="bg-zinc-900 border-zinc-800 text-zinc-100 font-mono"
                  required
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label htmlFor="correction-observed" className="text-xs font-semibold text-zinc-300">Observed Value (JSON)</label>
                  <textarea
                    id="correction-observed"
                    rows={4}
                    value={observed}
                    onChange={(e) => setObserved(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-700"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="correction-corrected" className="text-xs font-semibold text-zinc-300">Corrected Value (JSON)</label>
                  <textarea
                    id="correction-corrected"
                    rows={4}
                    value={corrected}
                    onChange={(e) => setCorrected(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-700"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="correction-reason" className="text-xs font-semibold text-zinc-300">Reason for correction</label>
                <Input
                  id="correction-reason"
                  placeholder="e.g. LLM off-by-one error or hallucination"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="bg-zinc-900 border-zinc-800 text-zinc-100"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="correction-reviewer" className="text-xs font-semibold text-zinc-300">Reviewer</label>
                <Input
                  id="correction-reviewer"
                  placeholder="e.g. alice"
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  className="bg-zinc-900 border-zinc-800 text-zinc-100"
                  required
                />
              </div>

              <div className="pt-2 flex gap-3">
                <Link href="/corrections">
                  <Button type="button" variant="outline" className="border-zinc-800 text-zinc-300 hover:bg-zinc-900">
                    Cancel
                  </Button>
                </Link>
                <Button type="submit" disabled={submitting} className="bg-primary text-primary-foreground">
                  <Send className="mr-1.5 h-4 w-4" />
                  {submitting ? "Saving..." : "Submit Correction"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ----------------------------------------------------
  // LIST VIEW
  // ----------------------------------------------------
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Pencil}
        title="Corrections"
        subtitle="Record and propagate fixes to run traces and seed Eval suites."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={fetchCorrections} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
            <Link href="/corrections/new">
              <Button className="bg-primary text-primary-foreground">
                <FileEdit className="mr-1.5 h-4 w-4" />
                New Correction
              </Button>
            </Link>
          </>
        }
      />

      <AlertBanner variant="error" message={actionError} />
      {actionSuccess && (
        <div className="p-3 bg-emerald-950/30 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs font-medium space-y-2 animate-fade-in">
          <p className="font-semibold">{actionSuccess}</p>
          {actionOutput != null && (
            <pre className="bg-zinc-900 p-2 rounded text-[10px] font-mono text-zinc-300 overflow-x-auto max-w-full">
              {JSON.stringify(actionOutput, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden animate-slide-up">
        {loadingList ? (
          <LoadingState message="Loading corrections..." />
        ) : corrections.length === 0 ? (
          <EmptyState message="No trace corrections recorded." />
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-800">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Step ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Field Path</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Diff (Observed &rarr; Corrected)</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Reason</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-right">Outcome Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {corrections.map((corr) => {
                const key = `${corr.runId}:${corr.stepId}:${corr.fieldPath}`;
                return (
                  <TableRow key={key} className="border-zinc-800 hover:bg-zinc-900/20">
                    <TableCell className="font-mono text-zinc-200 text-xs font-medium">
                      <Link href={`/runs/${corr.runId}`} className="text-primary hover:underline">
                        {corr.runId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-zinc-300 font-semibold">{corr.stepId}</TableCell>
                    <TableCell className="font-mono text-xs text-zinc-400">{corr.fieldPath}</TableCell>
                    <TableCell className="text-xs space-y-1">
                      <div className="text-red-400 font-mono">
                        - {JSON.stringify(corr.observed)}
                      </div>
                      <div className="text-emerald-400 font-mono">
                        + {JSON.stringify(corr.corrected)}
                      </div>
                    </TableCell>
                    <TableCell className="text-zinc-400 text-xs">{corr.reason || "-"}</TableCell>
                    <TableCell className="text-right space-y-1 md:space-y-0 md:space-x-1">
                      <Button
                        size="xs"
                        onClick={() => executeOutcome(key, "update-run-output")}
                        className="bg-sky-600 hover:bg-sky-700 text-white text-[10px] border-0"
                      >
                        Patch Run Output
                      </Button>
                      
                      <Button
                        size="xs"
                        onClick={() => {
                          setSelectedCorrectionKey(key);
                          setEvalDialogOpen(true);
                        }}
                        className="bg-purple-600 hover:bg-purple-700 text-white text-[10px] border-0"
                      >
                        Create Eval Example
                      </Button>

                      <Button
                        size="xs"
                        onClick={() => executeOutcome(key, "create-issue")}
                        className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px]"
                      >
                        Create Issue
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={evalDialogOpen} onOpenChange={setEvalDialogOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Seed Eval Suite Example</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Select an Eval Suite to add this correction as a target benchmark.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateEvalExample} className="space-y-4 py-2">
            <div className="space-y-1">
              <label htmlFor="eval-suite-select" className="text-xs font-semibold text-zinc-300">Eval Suite</label>
              <select
                id="eval-suite-select"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
                value={suiteId}
                onChange={(e) => setSuiteId(e.target.value)}
              >
                <option value="">Select suite...</option>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id})
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEvalDialogOpen(false)}
                className="border-zinc-800 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button type="submit" className="bg-primary text-primary-foreground">
                Generate Example
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
