import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/LoadingState";
import { EmptyState } from "../components/EmptyState";
import { TabBar } from "../components/TabBar";
import { AlertBanner } from "../components/AlertBanner";
import { RefreshCw, Server, Activity, Key } from "lucide-react";
import type { Deployment, Environment } from "@aart/types";

type TabName = "environments" | "deployments" | "secrets" | "worker-health";

const TABS = [
  { id: "environments" as const, label: "Environments", icon: Server },
  { id: "deployments" as const, label: "Deployments", icon: Activity },
  { id: "secrets" as const, label: "Secrets", icon: Key },
  { id: "worker-health" as const, label: "Worker Health", icon: Activity },
];

/** `GET /api/worker-health`'s real per-entry shape (server.ts) — a
 * dashboard/server composition (ApiClient.workerHealth's HealthPayload on
 * success, or a caught-error shape on failure), not a raw @aart/types
 * record on its own. */
interface WorkerHealthEntry {
  url: string;
  health: {
    status?: string;
    claimedRuns?: number;
    uptime?: number;
    version?: string;
    error?: string;
  };
}

export function ProductionPage() {
  const [activeTab, setActiveTab] = useState<TabName>("environments");
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Data states
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthEntry[]>([]);

  const fetchData = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      if (activeTab === "environments" || activeTab === "secrets") {
        const res = await fetch("/api/environments");
        if (res.ok) {
          setEnvironments((await res.json()) as Environment[]);
        } else {
          setFetchError("Failed to load production data. Please try again.");
        }
      } else if (activeTab === "deployments") {
        const res = await fetch("/api/deployments");
        if (res.ok) {
          setDeployments((await res.json()) as Deployment[]);
        } else {
          setFetchError("Failed to load production data. Please try again.");
        }
      } else if (activeTab === "worker-health") {
        const res = await fetch("/api/worker-health");
        if (res.ok) {
          setWorkerHealth((await res.json()) as WorkerHealthEntry[]);
        } else {
          setFetchError("Failed to load production data. Please try again.");
        }
      }
    } catch (err) {
      console.error("Failed to load production tab data", err);
      setFetchError("Failed to load production data. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        iconColor="text-emerald-400"
        title="Production Ops"
        subtitle="Manage environments, deployments, secrets, and worker health."
        actions={
          <Button variant="outline" size="sm" onClick={fetchData} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <TabBar tabs={TABS} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as TabName)} />

      <AlertBanner variant="error" message={fetchError} />

      <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden min-h-[300px] animate-slide-up">
        {loading ? (
          <LoadingState message="Loading production parameters..." />
        ) : (
          <div className="p-1">
            {/* Environments Tab */}
            {activeTab === "environments" && (
              <Table>
                <TableHeader className="bg-zinc-900/50 border-zinc-800">
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-zinc-400 text-xs font-semibold">Env ID</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Name</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Trust Mode</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Secret Source Ref</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="p-0">
                        <EmptyState message="No environments registered." icon={Server} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    environments.map((env) => (
                      <TableRow key={env.id} className="border-zinc-800 hover:bg-zinc-900/20">
                        <TableCell className="font-mono text-zinc-200 text-xs font-semibold">{env.id}</TableCell>
                        <TableCell className="text-zinc-300 font-semibold">{env.name || "-"}</TableCell>
                        <TableCell>
                          {/* Environment.config is z.record(z.string(), z.unknown())
                              at the schema level — narrowed here, same
                              reasoning as the secretSource narrowing below. */}
                          <StatusBadge status={(env.config?.["trustMode"] as string | undefined) || "governed"} />
                        </TableCell>
                        <TableCell className="text-zinc-400 text-xs font-mono">
                          {env.secretSource ? Object.keys(env.secretSource).join(", ") || "No keys" : "None"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}

            {/* Deployments Tab */}
            {activeTab === "deployments" && (
              <Table>
                <TableHeader className="bg-zinc-900/50 border-zinc-800">
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-zinc-400 text-xs font-semibold">Deployment ID</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Workflow</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold text-center">Version</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Environment</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Trigger Config (Cron)</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Created At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState message="No active workflow deployments." icon={Activity} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    deployments.map((dep) => (
                      <TableRow key={dep.id} className="border-zinc-800 hover:bg-zinc-900/20">
                        <TableCell className="font-mono text-zinc-200 text-xs font-semibold">{dep.id}</TableCell>
                        <TableCell className="text-zinc-300 font-semibold">{dep.workflowId}</TableCell>
                        <TableCell className="text-center font-mono text-xs text-zinc-400">{dep.workflowVersion}</TableCell>
                        <TableCell className="text-zinc-200 text-xs font-semibold">{dep.environmentId}</TableCell>
                        <TableCell className="text-zinc-400 text-xs font-mono">
                          {/* Deployment.triggerConfig is z.record(z.string(), z.unknown()) too. */}
                          {(dep.triggerConfig?.["cron"] as string | undefined) || "None"}
                        </TableCell>
                        <TableCell className="text-zinc-400 text-xs font-mono">
                          {dep.createdAt ? new Date(dep.createdAt).toLocaleString() : "-"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}

            {/* Secrets Tab */}
            {activeTab === "secrets" && (
              <Table>
                <TableHeader className="bg-zinc-900/50 border-zinc-800">
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-zinc-400 text-xs font-semibold">Environment ID</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Secret Name</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Vault/Path Reference</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Value State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environments.length === 0 || !environments.some(e => e.secretSource && Object.keys(e.secretSource).length > 0) ? (
                    <TableRow>
                      <TableCell colSpan={4} className="p-0">
                        <EmptyState message="No environment secrets registered in config vaults." icon={Key} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    environments.flatMap((env) => {
                      const secrets = env.secretSource ? Object.entries(env.secretSource) : [];
                      return secrets.map(([secretName, secretValObj]: [string, unknown]) => (
                        <TableRow key={`${env.id}-${secretName}`} className="border-zinc-800 hover:bg-zinc-900/20">
                          <TableCell className="font-mono text-zinc-200 text-xs font-semibold">{env.id}</TableCell>
                          <TableCell className="text-zinc-300 font-semibold">{secretName}</TableCell>
                          <TableCell className="text-zinc-400 text-xs font-mono">
                            {/* secretSource's value type is z.unknown() at the
                                schema level (Environment.secretSource is a
                                free-form ref-source blob) — this repo's own
                                convention for it is `{ path: <ref> }` (see
                                server.ts's /api/secrets route), narrowed
                                explicitly here rather than left as `any`. */}
                            {(secretValObj as { path?: string } | undefined)?.path || JSON.stringify(secretValObj) || "-"}
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-2 py-0.5 rounded font-mono font-semibold">
                              CONFIGURED (MASKED)
                            </span>
                          </TableCell>
                        </TableRow>
                      ));
                    })
                  )}
                </TableBody>
              </Table>
            )}

            {/* Worker Health Tab */}
            {activeTab === "worker-health" && (
              <Table>
                <TableHeader className="bg-zinc-900/50 border-zinc-800">
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-zinc-400 text-xs font-semibold">Worker URL</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Orchestrator Status</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold text-center">Claimed Runs</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold text-center">Uptime</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold text-center">Version</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workerHealth.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="p-0">
                        <EmptyState message="No cluster workers configured." icon={Activity} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    workerHealth.map((entry) => {
                      const url = entry.url;
                      const h = entry.health || {};
                      const isErr = !!h.error;
                      
                      return (
                        <TableRow key={entry.url} className="border-zinc-800 hover:bg-zinc-900/20">
                          <TableCell className="font-mono text-zinc-200 text-xs font-semibold">{url}</TableCell>
                          <TableCell>
                            {isErr ? (
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="relative flex h-2.5 w-2.5">
                                    <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                                  </span>
                                  <StatusBadge status="unreachable" />
                                </div>
                                <div className="text-[10px] text-rose-400 max-w-xs truncate font-mono">
                                  {h.error}
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="relative flex h-2.5 w-2.5">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                                </span>
                                <StatusBadge status={h.status || "ok"} />
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-center font-mono text-xs text-zinc-300">
                            {isErr ? "-" : h.claimedRuns ?? 0}
                          </TableCell>
                          <TableCell className="text-center font-mono text-xs text-zinc-300">
                            {isErr ? "-" : `${h.uptime ?? 0}s`}
                          </TableCell>
                          <TableCell className="text-center font-mono text-xs text-zinc-400">
                            {isErr ? "-" : h.version || "-"}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
