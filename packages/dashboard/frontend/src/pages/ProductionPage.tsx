import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "../components/StatusBadge";
import { RefreshCw, Server, Shield, Key, Activity, ShieldCheck } from "lucide-react";
import type { Deployment, Environment } from "@aart/types";

type TabName = "environments" | "deployments" | "secrets" | "worker-health";

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

  // Data states
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthEntry[]>([]);

  const fetchData = async () => {
    setLoading(true);
    try {
      if (activeTab === "environments" || activeTab === "secrets") {
        const res = await fetch("/api/environments");
        if (res.ok) setEnvironments((await res.json()) as Environment[]);
      } else if (activeTab === "deployments") {
        const res = await fetch("/api/deployments");
        if (res.ok) setDeployments((await res.json()) as Deployment[]);
      } else if (activeTab === "worker-health") {
        const res = await fetch("/api/worker-health");
        if (res.ok) setWorkerHealth((await res.json()) as WorkerHealthEntry[]);
      }
    } catch (err) {
      console.error("Failed to load production tab data", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            <Server className="h-8 w-8 text-emerald-400" />
            Production Management
          </h1>
          <p className="text-sm text-zinc-400">Audit environment trust structures, active deployments, and orchestrator clusters.</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Tabs list */}
      <div className="flex gap-1.5 border-b border-zinc-900 pb-px">
        <button
          onClick={() => setActiveTab("environments")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-all ${
            activeTab === "environments"
              ? "border-primary text-primary font-bold"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Shield className="h-4 w-4" />
          Environments
        </button>
        <button
          onClick={() => setActiveTab("deployments")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-all ${
            activeTab === "deployments"
              ? "border-primary text-primary font-bold"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <ShieldCheck className="h-4 w-4" />
          Deployments
        </button>
        <button
          onClick={() => setActiveTab("secrets")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-all ${
            activeTab === "secrets"
              ? "border-primary text-primary font-bold"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Key className="h-4 w-4" />
          Secrets Vault
        </button>
        <button
          onClick={() => setActiveTab("worker-health")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-all ${
            activeTab === "worker-health"
              ? "border-primary text-primary font-bold"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Activity className="h-4 w-4" />
          Worker Health
        </button>
      </div>

      <div className="bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden min-h-[300px]">
        {loading ? (
          <div className="flex justify-center items-center py-24 text-zinc-500 text-sm font-medium">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin text-zinc-400" />
            Loading production parameters...
          </div>
        ) : (
          <div className="p-1">
            {/* Environments Tab */}
            {activeTab === "environments" && (
              <Table>
                <TableHeader className="bg-zinc-900/50 border-zinc-850">
                  <TableRow className="border-zinc-850 hover:bg-transparent">
                    <TableHead className="text-zinc-400 text-xs font-semibold">Env ID</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Name</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Trust Mode</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Secret Source Ref</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-12 text-zinc-500 text-xs">
                        No environments registered.
                      </TableCell>
                    </TableRow>
                  ) : (
                    environments.map((env) => (
                      <TableRow key={env.id} className="border-zinc-850 hover:bg-zinc-900/20">
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
                <TableHeader className="bg-zinc-900/50 border-zinc-850">
                  <TableRow className="border-zinc-850 hover:bg-transparent">
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
                      <TableCell colSpan={6} className="text-center py-12 text-zinc-500 text-xs">
                        No active workflow deployments.
                      </TableCell>
                    </TableRow>
                  ) : (
                    deployments.map((dep) => (
                      <TableRow key={dep.id} className="border-zinc-850 hover:bg-zinc-900/20">
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
                <TableHeader className="bg-zinc-900/50 border-zinc-850">
                  <TableRow className="border-zinc-850 hover:bg-transparent">
                    <TableHead className="text-zinc-400 text-xs font-semibold">Environment ID</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Secret Name</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Vault/Path Reference</TableHead>
                    <TableHead className="text-zinc-400 text-xs font-semibold">Value State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environments.length === 0 || !environments.some(e => e.secretSource && Object.keys(e.secretSource).length > 0) ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-12 text-zinc-500 text-xs">
                        No environment secrets registered in config vaults.
                      </TableCell>
                    </TableRow>
                  ) : (
                    environments.flatMap((env) => {
                      const secrets = env.secretSource ? Object.entries(env.secretSource) : [];
                      return secrets.map(([secretName, secretValObj]: [string, unknown]) => (
                        <TableRow key={`${env.id}-${secretName}`} className="border-zinc-850 hover:bg-zinc-900/20">
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
                <TableHeader className="bg-zinc-900/50 border-zinc-850">
                  <TableRow className="border-zinc-850 hover:bg-transparent">
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
                      <TableCell colSpan={5} className="text-center py-12 text-zinc-500 text-xs">
                        No cluster workers configured.
                      </TableCell>
                    </TableRow>
                  ) : (
                    workerHealth.map((entry, index) => {
                      const url = entry.url;
                      const h = entry.health || {};
                      const isErr = !!h.error;
                      
                      return (
                        <TableRow key={index} className="border-zinc-850 hover:bg-zinc-900/20">
                          <TableCell className="font-mono text-zinc-200 text-xs font-semibold">{url}</TableCell>
                          <TableCell>
                            {isErr ? (
                              <div className="space-y-1">
                                <StatusBadge status="unreachable" />
                                <div className="text-[10px] text-rose-400 max-w-xs truncate font-mono">
                                  {h.error}
                                </div>
                              </div>
                            ) : (
                              <StatusBadge status={h.status || "ok"} />
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
