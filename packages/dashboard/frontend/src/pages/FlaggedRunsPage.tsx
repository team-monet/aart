import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { AlertBanner } from "../components/AlertBanner";
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearedBy }),
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
      <PageHeader
        icon={ShieldAlert}
        iconColor="text-rose-400"
        title="Flagged Runs"
        subtitle="Review and mitigate poison, security, or reliability flags raised on runs."
        actions={
          <Button variant="outline" size="sm" onClick={fetchFlaggedRuns} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden animate-slide-up">
        {loading ? (
          <LoadingState message="Loading flagged runs..." />
        ) : flaggedRuns.length === 0 ? (
          <EmptyState icon={ShieldAlert} message="No flagged runs detected." />
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-800">
              <TableRow className="border-zinc-800 hover:bg-transparent">
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
                <TableRow key={run.runId} className="border-zinc-800 hover:bg-zinc-900/20">
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
                    {run.flag?.clearedBy || <StatusBadge status="active" />}
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
            <AlertBanner variant="error" message={actionError} />
            <div className="space-y-1">
              <label htmlFor="cleared-by" className="text-xs font-semibold text-zinc-300">Operator/Reviewer Name</label>
              <Input
                id="cleared-by"
                placeholder="e.g. alice"
                value={clearedBy}
                onChange={(e) => setClearedBy(e.target.value)}
                className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
                required
              />
            </div>
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setClearDialogOpen(false)}
                className="border-zinc-800 text-zinc-300 hover:bg-zinc-900"
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
