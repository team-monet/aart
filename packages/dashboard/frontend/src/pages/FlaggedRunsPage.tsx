import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "../components/StatusBadge";
import { RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import type { RunRecord } from "@aart/types";

export function FlaggedRunsPage() {
  const [flaggedRuns, setFlaggedRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Dialog State
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [targetRunId, setTargetRunId] = useState("");
  const [clearedBy, setClearedBy] = useState("dashboard-operator");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");

  const fetchFlaggedRuns = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/flagged-runs");
      if (res.ok) {
        setFlaggedRuns((await res.json()) as RunRecord[]);
      }
    } catch (err) {
      console.error("Failed to fetch flagged runs", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFlaggedRuns();
  }, []);

  const handleClearFlag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetRunId) return;
    setSubmitting(true);
    setActionError("");
    try {
      const res = await fetch(`/api/flagged-runs/${encodeURIComponent(targetRunId)}/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `clearedBy=${encodeURIComponent(clearedBy)}`,
      });
      if (res.ok) {
        setClearDialogOpen(false);
        fetchFlaggedRuns();
      } else {
        const err = await res.json();
        setActionError(err.error || "Failed to clear flag");
      }
    } catch {
      setActionError("Network error clearing flag");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            <ShieldAlert className="h-8 w-8 text-rose-500" />
            Flagged Runs
          </h1>
          <p className="text-sm text-zinc-400">Review and mitigate poison, security, or reliability flags raised on runs.</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchFlaggedRuns} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center items-center py-24 text-zinc-500 text-sm font-medium">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin text-zinc-400" />
            Loading flagged runs...
          </div>
        ) : flaggedRuns.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-sm">
            No flagged runs detected.
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-850">
              <TableRow className="border-zinc-850 hover:bg-transparent">
                <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Workflow</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Flag Type</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Flagged At</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Cleared By</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flaggedRuns.map((run) => (
                <TableRow key={run.runId} className="border-zinc-850 hover:bg-zinc-900/20">
                  <TableCell className="font-mono text-zinc-200 text-sm font-medium">
                    <Link href={`/runs/${run.runId}`} className="text-primary hover:underline">
                      {run.runId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-300 font-semibold">{run.workflowId}</TableCell>
                  <TableCell>
                    <StatusBadge status={run.flag?.kind || "flagged"} />
                  </TableCell>
                  <TableCell className="text-zinc-400 text-xs font-mono">
                    {run.flag?.flaggedAt ? new Date(run.flag.flaggedAt).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="text-zinc-400 text-xs font-mono">
                    {run.flag?.clearedBy || <span className="text-red-400 italic">Active</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!run.flag?.clearedBy ? (
                      <Button
                        onClick={() => {
                          setTargetRunId(run.runId);
                          setClearDialogOpen(true);
                        }}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs border-0"
                      >
                        <Sparkles className="mr-1 h-3.5 w-3.5" />
                        Clear Flag
                      </Button>
                    ) : (
                      <span className="text-xs text-zinc-500">Resolved</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Clear Security/Poison Flag</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Confirm you want to clear the security or poison flag on run <span className="font-mono font-bold text-zinc-200">{targetRunId}</span>.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleClearFlag} className="space-y-4 py-2">
            {actionError && (
              <div className="p-3 bg-red-950/30 border border-red-500/20 text-red-400 rounded-lg text-xs font-medium">
                {actionError}
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-300">Operator/Reviewer Name</label>
              <Input
                placeholder="e.g. alice"
                value={clearedBy}
                onChange={(e) => setClearedBy(e.target.value)}
                className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-600"
                required
              />
            </div>
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setClearDialogOpen(false)}
                className="border-zinc-850 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting} className="bg-emerald-600 text-white hover:bg-emerald-700">
                {submitting ? "Clearing..." : "Clear Flag"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
