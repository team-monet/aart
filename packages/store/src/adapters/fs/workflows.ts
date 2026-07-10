// WorkflowStore's fs implementation — architecture §5.2:
// `registry/workflows/<workflowId>/<version>.json`.
import type { Workflow } from "@aart/types";
import type { WorkflowStore } from "../../types.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { JsonFileHandle, type StagingBuffer } from "./json-file.js";

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

/** Naive semver-ish comparator: numeric segments compare numerically, non-numeric segments compare lexically. Good enough for "which version is latest" without pulling in a full semver dependency for a single S0-scope comparison. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (sa !== "" && sb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export class FsWorkflowStore implements WorkflowStore {
  constructor(
    private readonly dir: string,
    private readonly staging?: StagingBuffer,
  ) {}

  private workflowDir(workflowId: string): string {
    return join(this.dir, workflowId);
  }
  private versionPath(workflowId: string, version: string): string {
    return join(this.workflowDir(workflowId), `${version}.json`);
  }

  async get(workflowId: string, version: string): Promise<Workflow | undefined> {
    return new JsonFileHandle<Workflow>(this.versionPath(workflowId, version), this.staging).read();
  }

  async put(workflow: Workflow): Promise<void> {
    await new JsonFileHandle<Workflow>(this.versionPath(workflow.id, workflow.version), this.staging).write(workflow);
  }

  async listVersions(workflowId: string): Promise<string[]> {
    const onDisk = await this.listVersionsOnDisk(workflowId);
    const versions = new Set(onDisk);
    if (this.staging) {
      const prefix = this.workflowDir(workflowId) + "/";
      for (const [path, content] of this.staging.pending) {
        if (!path.startsWith(prefix) || !path.endsWith(".json")) continue;
        const version = path.slice(prefix.length, -".json".length);
        if (content === null) versions.delete(version);
        else versions.add(version);
      }
    }
    return Array.from(versions).sort(compareVersions);
  }

  private async listVersionsOnDisk(workflowId: string): Promise<string[]> {
    try {
      return (await fs.readdir(this.workflowDir(workflowId)))
        .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
        .map((f) => f.slice(0, -".json".length));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }

  async getLatest(workflowId: string): Promise<Workflow | undefined> {
    const versions = await this.listVersions(workflowId);
    const latest = versions.at(-1);
    if (!latest) return undefined;
    return this.get(workflowId, latest);
  }

  async listWorkflowIds(): Promise<string[]> {
    try {
      return await fs.readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }
}
