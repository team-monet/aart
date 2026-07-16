import { useEffect, useState } from "react";
import { Link, useRouter } from "../router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { FilterBar } from "../components/FilterBar";
import { AlertBanner } from "../components/AlertBanner";
import { Play, RefreshCw } from "lucide-react";
import type { RunRecord } from "@aart/types";

export function RunsPage() {
  const { navigate } = useRouter();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");

  // Filters
  const [workflowIdFilter, setWorkflowIdFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Dialog Form
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formWorkflowId, setFormWorkflowId] = useState("");
  const [formVersion, setFormVersion] = useState("");
  const [formInputs, setFormInputs] = useState("{}");
  const [formEnvironment, setFormEnvironment] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchRuns = async () => {
    setLoading(true);
    setFetchError("");
    try {
      const q = new URLSearchParams();
      if (workflowIdFilter) q.set("workflowId", workflowIdFilter);
      if (statusFilter) q.set("status", statusFilter);

      const res = await fetch(`/api/runs?${q.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as RunRecord[];
        setRuns(data);
      } else {
        setFetchError("Failed to load runs. Please try again.");
      }
    } catch (err) {
      console.error("Failed to fetch runs", err);
      setFetchError("Failed to load runs. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const fetchWorkflows = async () => {
    try {
      const res = await fetch("/api/workflows");
      if (res.ok) {
        setWorkflows(await res.json());
      } else {
        setFetchError("Failed to load workflows. Please try again.");
      }
    } catch (err) {
      console.error("Failed to fetch workflows", err);
      setFetchError("Failed to load workflows. Please try again.");
    }
  };

  useEffect(() => {
    fetchRuns();
  }, [workflowIdFilter, statusFilter]);

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const handleTriggerRun = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    
    if (!formWorkflowId) {
      setFormError("Workflow ID is required");
      return;
    }

    let parsedInputs = {};
    try {
      parsedInputs = JSON.parse(formInputs);
    } catch {
      setFormError("Inputs must be valid JSON");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/runs/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: formWorkflowId,
          workflowVersion: formVersion || undefined,
          inputs: parsedInputs,
          environment: formEnvironment || undefined,
        }),
      });

      if (res.ok) {
        const run = (await res.json()) as RunRecord;
        setDialogOpen(false);
        // Clear form
        setFormWorkflowId("");
        setFormVersion("");
        setFormInputs("{}");
        setFormEnvironment("");
        navigate(`/runs/${run.runId}`);
      } else {
        const errData = await res.json();
        setFormError(errData.error || "Failed to trigger run");
      }
    } catch {
      setFormError("Network error triggering run");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Play}
        title="Workflow Runs"
        subtitle="Monitor and execute your governed workflows."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={fetchRuns} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
          
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button className="bg-primary text-primary-foreground hover:bg-primary/95" />}>
              <Play className="mr-1.5 h-4 w-4 fill-current" />
              Trigger Run
            </DialogTrigger>
            <DialogContent className="border-zinc-800 bg-zinc-950 max-w-md">
              <DialogHeader>
                <DialogTitle className="text-zinc-100">Trigger New Workflow Run</DialogTitle>
                <DialogDescription className="text-zinc-400">
                  Select a workflow and environment to start execution.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleTriggerRun} className="space-y-4 py-2">
                <AlertBanner variant="error" message={formError} />

                <div className="space-y-1">
                  <label htmlFor="trigger-workflow-id" className="text-xs font-semibold text-zinc-300">Workflow ID</label>
                  <select
                    id="trigger-workflow-id"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
                    value={formWorkflowId}
                    onChange={(e) => setFormWorkflowId(e.target.value)}
                  >
                    <option value="">Select a workflow...</option>
                    {workflows.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="trigger-workflow-version" className="text-xs font-semibold text-zinc-300">Workflow Version (Optional)</label>
                  <Input
                    id="trigger-workflow-version"
                    placeholder="e.g. 1.0.0"
                    value={formVersion}
                    onChange={(e) => setFormVersion(e.target.value)}
                    className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="trigger-environment" className="text-xs font-semibold text-zinc-300">Environment (Optional)</label>
                  <Input
                    id="trigger-environment"
                    placeholder="e.g. production"
                    value={formEnvironment}
                    onChange={(e) => setFormEnvironment(e.target.value)}
                    className="bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="trigger-inputs" className="text-xs font-semibold text-zinc-300">Inputs (JSON)</label>
                  <textarea
                    id="trigger-inputs"
                    rows={4}
                    placeholder="{}"
                    value={formInputs}
                    onChange={(e) => setFormInputs(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-700"
                  />
                </div>

                <DialogFooter className="pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                    className="border-zinc-800 text-zinc-300 hover:bg-zinc-900"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitting} className="bg-primary text-primary-foreground">
                    {submitting ? "Starting..." : "Trigger"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          </>
        }
      />

      <FilterBar
        showClear={!!(workflowIdFilter || statusFilter)}
        onClear={() => {
          setWorkflowIdFilter("");
          setStatusFilter("");
        }}
      >
        <select
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-zinc-700"
          value={workflowIdFilter}
          onChange={(e) => setWorkflowIdFilter(e.target.value)}
        >
          <option value="">All Workflows</option>
          {workflows.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <select
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-zinc-700"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="waiting">Waiting</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </FilterBar>

      <AlertBanner variant="error" message={fetchError} />

      <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden animate-slide-up">
        {loading ? (
          <LoadingState message="Loading runs..." />
        ) : runs.length === 0 ? (
          <EmptyState message="No workflow runs found." />
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-800">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Workflow</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-center">Version</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-center">Status</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Started At</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.runId} className="border-zinc-800 hover:bg-zinc-900/20">
                  <TableCell className="font-mono text-zinc-200 text-sm font-medium">
                    <Link href={`/runs/${run.runId}`} className="text-primary hover:underline">
                      {run.runId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-300 font-semibold">{run.workflowId}</TableCell>
                  <TableCell className="text-center font-mono text-xs text-zinc-400">{run.workflowVersion || "-"}</TableCell>
                  <TableCell className="text-center">
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="text-zinc-400 text-xs">
                    {run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/runs/${run.runId}`}>
                      <Button variant="outline" size="sm" className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
                        View Details
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
