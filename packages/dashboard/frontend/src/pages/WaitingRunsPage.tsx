import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { Clock, FileEdit, CheckSquare, RefreshCw } from "lucide-react";
import type { WaitCondition } from "@aart/types";

/** `GET /api/waiting-runs`'s real response shape (server.ts, mirroring
 * packages/dashboard/src/api-client.ts's WaitingRunEntry — a dashboard/
 * server composition, not a raw @aart/types record on its own). */
interface WaitingRunEntry {
  runId: string;
  stepId: string;
  wait: WaitCondition;
  createdAt: string;
}
interface WaitingRunsResponse {
  waitingRuns: WaitingRunEntry[];
  now: string;
}

export function WaitingRunsPage() {
  const [data, setData] = useState<WaitingRunsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchWaitingRuns = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/waiting-runs");
      if (res.ok) {
        setData((await res.json()) as WaitingRunsResponse);
      }
    } catch (err) {
      console.error("Failed to fetch waiting runs", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWaitingRuns();
  }, []);

  const calculateAge = (createdAt: string, serverNow: string) => {
    const created = new Date(createdAt).getTime();
    const now = new Date(serverNow).getTime();
    const diffSec = Math.floor((now - created) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ${diffMin % 60}m ago`;
  };

  const ageColor = (createdAt: string, serverNow: string) => {
    const diffMs = new Date(serverNow).getTime() - new Date(createdAt).getTime();
    const hours = diffMs / (1000 * 60 * 60);
    if (hours > 4) return "text-rose-400";
    if (hours > 1) return "text-amber-400";
    return "text-zinc-400";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Clock}
        iconColor="text-amber-400"
        title="Waiting Runs"
        subtitle="Manage runs blocked on manual decisions, external hooks, or gates."
        actions={
          <Button variant="outline" size="sm" onClick={fetchWaitingRuns} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden animate-slide-up">
        {loading ? (
          <LoadingState message="Loading waiting runs..." />
        ) : !data || data.waitingRuns.length === 0 ? (
          <EmptyState icon={Clock} message="No runs are currently waiting on human action." />
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-800">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400 text-xs font-semibold">Run ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Step ID</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Wait Type</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold">Wait Age</TableHead>
                <TableHead className="text-zinc-400 text-xs font-semibold text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.waitingRuns.map((waitObj) => {
                const runId = waitObj.runId;
                const stepId = waitObj.stepId;
                const waitType = waitObj.wait?.type || "unknown";
                
                return (
                  <TableRow key={`${runId}-${stepId}`} className="border-zinc-800 hover:bg-zinc-900/20">
                    <TableCell className="font-mono text-zinc-200 text-sm font-medium">
                      <Link href={`/runs/${runId}`} className="text-primary hover:underline">
                        {runId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-zinc-300 font-semibold">{stepId}</TableCell>
                    <TableCell>
                      <StatusBadge status={waitType} />
                    </TableCell>
                    <TableCell className={`text-xs font-mono ${waitObj.createdAt ? ageColor(waitObj.createdAt, data.now) : "text-zinc-400"}`}>
                      {waitObj.createdAt ? calculateAge(waitObj.createdAt, data.now) : "-"}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {waitType === "approval" ? (
                        <Link href="/approvals">
                          <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white text-xs border-0">
                            <CheckSquare className="mr-1 h-3.5 w-3.5" />
                            Go to Approvals
                          </Button>
                        </Link>
                      ) : (
                        <Link href={`/corrections/new?runId=${encodeURIComponent(runId)}&stepId=${encodeURIComponent(stepId)}`}>
                          <Button variant="outline" size="sm" className="border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs">
                            <FileEdit className="mr-1 h-3.5 w-3.5" />
                            Record Correction
                          </Button>
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
