import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw, CheckCircle, XCircle, AlertTriangle, ShieldCheck } from "lucide-react";
import type { ApprovalTask, TrustMode } from "@aart/types";

export function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalTask[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog State
  const [decisionDialogOpen, setDecisionDialogOpen] = useState(false);
  const [targetTask, setTargetTask] = useState<ApprovalTask | null>(null);

  // Decision Form State
  const [reviewer, setReviewer] = useState("dashboard-operator");
  const [status, setStatus] = useState<"approved" | "rejected" | "needs_changes">("approved");
  // TrustMode is the real @aart/types enum ("dev" | "governed" | "strict" |
  // "production" — packages/governance/src/gates.ts's REQUIRED_GATES_BY_MODE
  // keys). The prior "override"/"disabled" options here weren't valid
  // TrustMode values at all — a decision submitted with either would have
  // been coerced/rejected server-side, not actually done what the label
  // implied.
  const [trustMode, setTrustMode] = useState<TrustMode>("governed");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fetchApprovals = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        setApprovals((await res.json()) as ApprovalTask[]);
      }
    } catch (err) {
      console.error("Failed to fetch approvals", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApprovals();
  }, []);

  const handleDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetTask) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(targetTask.id)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reviewer, trustMode }),
      });
      if (res.ok) {
        setDecisionDialogOpen(false);
        fetchApprovals();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to submit decision");
      }
    } catch {
      setError("Network error submitting decision");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            <ShieldCheck className="h-8 w-8 text-emerald-400" />
            Approvals Queue
          </h1>
          <p className="text-sm text-zinc-400">Review tasks requiring manual sign-off before workflow execution resumes.</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchApprovals} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center items-center py-24 text-zinc-500 text-sm font-medium">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin text-zinc-400" />
            Loading approvals queue...
          </div>
        ) : approvals.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-sm">
            No pending approvals at this time.
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-850">
              <TableRow className="border-zinc-850 hover:bg-transparent">
                <TableHead className="text-zinc-400 text-xs font-semibold">Task ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Title</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Description</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Created At</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((task) => (
                <TableRow key={task.id} className="border-zinc-850 hover:bg-zinc-900/20">
                  <TableCell className="font-mono text-zinc-300 text-xs font-semibold">{task.id}</TableCell>
                  <TableCell className="font-mono text-zinc-200 text-xs">
                    <Link href={`/runs/${task.runId}`} className="text-primary hover:underline">
                      {task.runId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-200 font-semibold">{task.title}</TableCell>
                  <TableCell className="text-zinc-400 max-w-xs truncate">{task.description}</TableCell>
                  <TableCell className="text-zinc-400 text-xs font-mono">
                    {task.createdAt ? new Date(task.createdAt).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      onClick={() => {
                        setTargetTask(task);
                        setStatus("approved");
                        setDecisionDialogOpen(true);
                      }}
                      className="bg-primary text-primary-foreground hover:bg-primary/95 text-xs"
                    >
                      Make Decision
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={decisionDialogOpen} onOpenChange={setDecisionDialogOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 max-w-md">
          {targetTask && (
            <>
              <DialogHeader>
                <DialogTitle className="text-zinc-100">Submit Approval Decision</DialogTitle>
                <DialogDescription className="text-zinc-400">
                  Submit decision for: <span className="font-semibold text-zinc-300">{targetTask.title}</span> ({targetTask.id})
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleDecision} className="space-y-4 py-2">
                {error && (
                  <div className="p-3 bg-red-950/30 border border-red-500/20 text-red-400 rounded-lg text-xs font-medium">
                    {error}
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-zinc-300">Decision Outcome</label>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      type="button"
                      variant={status === "approved" ? "default" : "outline"}
                      onClick={() => setStatus("approved")}
                      className={`text-xs ${status === "approved" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "border-zinc-850"}`}
                    >
                      <CheckCircle className="mr-1 h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant={status === "needs_changes" ? "default" : "outline"}
                      onClick={() => setStatus("needs_changes")}
                      className={`text-xs ${status === "needs_changes" ? "bg-amber-600 hover:bg-amber-700 text-white" : "border-zinc-850"}`}
                    >
                      <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                      Request changes
                    </Button>
                    <Button
                      type="button"
                      variant={status === "rejected" ? "default" : "outline"}
                      onClick={() => setStatus("rejected")}
                      className={`text-xs ${status === "rejected" ? "bg-rose-600 hover:bg-rose-700 text-white" : "border-zinc-850"}`}
                    >
                      <XCircle className="mr-1 h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-zinc-300">Trust Mode</label>
                  <select
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:outline-none"
                    value={trustMode}
                    onChange={(e) => setTrustMode(e.target.value as TrustMode)}
                  >
                    <option value="dev">dev (no gates required)</option>
                    <option value="governed">governed (Recommended — validate + human review)</option>
                    <option value="strict">strict (validate + human review)</option>
                    <option value="production">production (all five gates required)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-zinc-300">Reviewer Name</label>
                  <Input
                    placeholder="e.g. alice"
                    value={reviewer}
                    onChange={(e) => setReviewer(e.target.value)}
                    className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-600"
                    required
                  />
                </div>

                <DialogFooter className="pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDecisionDialogOpen(false)}
                    className="border-zinc-850 text-zinc-300 hover:bg-zinc-900"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitting} className="bg-primary text-primary-foreground">
                    {submitting ? "Submitting..." : "Submit Decision"}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
