import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "../components/StatusBadge";
import { RefreshCw, FileEdit, CheckSquare } from "lucide-react";
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">Waiting Runs</h1>
          <p className="text-sm text-zinc-400">Manage runs blocked on manual decisions, external hooks, or gates.</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchWaitingRuns} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center items-center py-24 text-zinc-500 text-sm font-medium">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin text-zinc-400" />
            Loading waiting runs...
          </div>
        ) : !data || data.waitingRuns.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-sm">
            No runs are currently waiting on human action.
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-zinc-900/50 border-zinc-850">
              <TableRow className="border-zinc-850 hover:bg-transparent">
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
                  <TableRow key={`${runId}-${stepId}`} className="border-zinc-850 hover:bg-zinc-900/20">
                    <TableCell className="font-mono text-zinc-200 text-sm font-medium">
                      <Link href={`/runs/${runId}`} className="text-primary hover:underline">
                        {runId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-zinc-300 font-semibold">{stepId}</TableCell>
                    <TableCell>
                      <StatusBadge status={waitType} />
                    </TableCell>
                    <TableCell className="text-zinc-400 text-xs font-mono">
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
