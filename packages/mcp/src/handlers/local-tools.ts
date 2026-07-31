import { resolve } from "node:path";
import {
  buildPackManifest,
  checkLocalTool,
  fetchRemoteRegistryIndex,
  latestToolVersions,
  listActiveApprovedPackStatesSync,
  listLocalTools,
  listLocalToolRuns,
  packToolRecord,
  parsePackManifestYaml,
  readInstalledPackSync,
  readLocalToolRun,
  registerLocalTool,
  runLocalTool,
  searchLocalTools,
  searchRemoteTools,
  type RegisteredLocalTool,
} from "@aart/registry";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";

function approvedPackTools(ctx: AartContext): RegisteredLocalTool[] {
  const tools: RegisteredLocalTool[] = [];
  for (const state of listActiveApprovedPackStatesSync(ctx.root)) {
    try {
      const installed = readInstalledPackSync(ctx.root, state.name, state.version);
      const raw = parsePackManifestYaml(installed.files.manifestYaml);
      const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
      if (current.contentHash !== state.contentHash) continue;
      const source = resolve(ctx.root, "packs", "installed", state.name, state.version);
      for (const manifest of raw.tools) {
        tools.push(
          packToolRecord(manifest, {
            packName: state.name,
            packVersion: state.version,
            contentHash: state.contentHash,
            source,
            registeredAt: state.approvedAt ?? state.installedAt,
          }),
        );
      }
    } catch {
      // A broken approved Pack is intentionally absent from every runtime
      // catalog, including local tools. `aart_list_packs` remains the
      // diagnostic surface that explains its broken seal.
    }
  }
  return tools;
}

async function runnableTools(ctx: AartContext): Promise<RegisteredLocalTool[]> {
  return [...(await listLocalTools(ctx.root)), ...approvedPackTools(ctx)];
}

function latestToolCandidates(records: readonly RegisteredLocalTool[]): RegisteredLocalTool[] {
  const latestVersions = new Map(
    latestToolVersions(records).map((record) => [record.manifest.id, record.manifest.version]),
  );
  return records.filter((record) => latestVersions.get(record.manifest.id) === record.manifest.version);
}

function selectTool(
  records: readonly RegisteredLocalTool[],
  id: string,
  version?: string,
): RegisteredLocalTool | HandlerResult {
  const candidates = records.filter(
    (record) => record.manifest.id === id && (version === undefined || record.manifest.version === version),
  );
  if (candidates.length === 0) {
    return { ok: false, error: `Unknown local tool "${id}"${version ? ` at version ${version}` : ""}.` };
  }
  const selected = version ? candidates : latestToolVersions(candidates);
  const topVersion = selected[0]?.manifest.version;
  const top = candidates.filter((candidate) => candidate.manifest.version === topVersion);
  const hashes = new Set(top.map((candidate) => candidate.contentHash));
  if (hashes.size > 1) {
    const ambiguousToolResult: HandlerResult = {
      ok: false,
      error: `Local tool "${id}" is ambiguous at version ${topVersion}; multiple sources expose different sealed content.`,
      candidates: top.map((candidate) => ({
        contentHash: candidate.contentHash,
        provenance: candidate.provenance,
      })),
    };
    return ambiguousToolResult;
  }
  return top[0]!;
}

function isHandlerResult(value: RegisteredLocalTool | HandlerResult): value is HandlerResult {
  return "ok" in value;
}

export interface RegisterToolInput {
  tool: unknown;
  sourcePath?: string;
}

export async function registerToolHandler(ctx: AartContext, input: RegisterToolInput): Promise<HandlerResult> {
  const record = await registerLocalTool(ctx.root, input.tool, {
    sourcePath: input.sourcePath,
    sourceLabel: "aart_register_tool",
    now: ctx.now(),
  });
  const registeredToolResult: HandlerResult = {
    ok: true,
    tool: {
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      contentHash: record.contentHash,
      toolHash: record.toolHash,
      provenance: record.provenance,
      ownedExecutable: record.ownedExecutable,
    },
  };
  return registeredToolResult;
}

export interface FindToolsInput {
  query: string;
  scope?: "local" | "remote" | "all";
  indexUrl?: string;
}

export async function findToolsHandler(ctx: AartContext, input: FindToolsInput): Promise<HandlerResult> {
  const scope = input.scope ?? "local";
  const localRecords = scope === "remote" ? [] : latestToolCandidates(await runnableTools(ctx));
  const localResults = searchLocalTools(localRecords, input.query).map(({ record, score }) => {
    const manifest = record.manifest;
    const conflicting = localRecords.filter(
      (candidate) =>
        candidate.manifest.id === manifest.id &&
        candidate.manifest.version === manifest.version &&
        candidate.contentHash !== record.contentHash,
    );
    const localToolSearchResult = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      keywords: manifest.keywords,
      triggers: manifest.triggers,
      examples: manifest.examples,
      inputs: manifest.inputs,
      command: {
        executable: manifest.command.executable,
        resolution: manifest.command.resolution,
        args: manifest.command.args,
      },
      prerequisites: manifest.prerequisites,
      capabilities: manifest.capabilities,
      effects: manifest.effects,
      cwd: manifest.cwd,
      authentication: {
        mode: manifest.authentication.mode,
        description: manifest.authentication.description,
        inheritedEnvironment: manifest.authentication.inheritEnvironment,
        secretRefs:
          manifest.authentication.mode === "aart_secrets"
            ? manifest.authentication.secrets.map((secret) => secret.ref)
            : [],
        secretMappings: manifest.authentication.mode === "aart_secrets" ? manifest.authentication.secrets : [],
      },
      output: manifest.output,
      availability:
        conflicting.length > 0
          ? {
              status: "ambiguous",
              ready: false,
              reason: "Multiple sources expose different sealed content at this id and version.",
              candidates: [record, ...conflicting].map((candidate) => ({
                contentHash: candidate.contentHash,
                provenance: candidate.provenance,
              })),
            }
          : {
              status: "requires_explicit_check",
              ready: false,
              reason: "Discovery is inert; call aart_check_tool with concrete inputs to run version checks and probes.",
            },
      contentHash: record.contentHash,
      toolHash: record.toolHash,
      provenance: record.provenance,
      source: record.provenance.kind === "pack" ? "pack" : "local",
      score,
    };
    return localToolSearchResult;
  });

  let remoteResults: Array<Record<string, unknown>> = [];
  let indexMode: "preview" | "production" | undefined;
  if (scope !== "local") {
    const indexUrl = input.indexUrl ?? process.env.AART_PACK_INDEX_URL;
    if (!indexUrl) throw new Error("remote tool search needs indexUrl or AART_PACK_INDEX_URL");
    const index = await fetchRemoteRegistryIndex(indexUrl);
    indexMode = index.mode;
    remoteResults = searchRemoteTools(index.packs, input.query).map(({ record, pack, score }) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description,
      keywords: record.manifest.keywords,
      triggers: record.manifest.triggers,
      examples: record.manifest.examples,
      inputs: record.manifest.inputs,
      command: {
        executable: record.manifest.command.executable,
        resolution: record.manifest.command.resolution,
        args: record.manifest.command.args,
      },
      prerequisites: record.manifest.prerequisites,
      capabilities: record.manifest.capabilities,
      effects: record.manifest.effects,
      cwd: record.manifest.cwd,
      authentication: record.manifest.authentication,
      output: record.manifest.output,
      contentHash: pack.contentHash,
      provenance: {
        kind: "public_pack",
        packName: pack.packName,
        packVersion: pack.version,
        npmPackageName: pack.npmPackageName,
      },
      installation: {
        name: pack.packName,
        version: pack.version,
        contentHash: pack.contentHash,
      },
      source: "public",
      catalogMode: index.mode,
      installable: index.mode === "production",
      score,
    }));
  }

  const tools = [...localResults, ...remoteResults].sort(
    (a, b) =>
      Number(b.score ?? 0) - Number(a.score ?? 0) ||
      String(a.id).localeCompare(String(b.id)) ||
      String(a.source).localeCompare(String(b.source)),
  );
  const toolDiscoveryResult: HandlerResult = {
    ok: true,
    matched: tools.length > 0,
    query: input.query,
    scope,
    ...(indexMode ? { indexMode } : {}),
    tools,
  };
  return toolDiscoveryResult;
}

export interface CheckToolInput {
  id: string;
  version?: string;
  inputs?: Record<string, string>;
}

export async function checkToolHandler(ctx: AartContext, input: CheckToolInput): Promise<HandlerResult> {
  const selected = selectTool(await runnableTools(ctx), input.id, input.version);
  if (isHandlerResult(selected)) return selected;
  const check = await checkLocalTool(ctx.root, selected, { inputs: input.inputs, requireInputs: true });
  const toolCheckResult: HandlerResult = {
    ok: check.ready,
    tool: { id: selected.manifest.id, version: selected.manifest.version },
    check,
  };
  return toolCheckResult;
}

export interface RunToolInput extends CheckToolInput {
  contentHash: string;
  executableHash: string;
  argvHash: string;
  cwdHash: string;
  prerequisiteHashes?: Record<string, string>;
}

export async function runToolHandler(ctx: AartContext, input: RunToolInput): Promise<HandlerResult> {
  const selected = selectTool(await runnableTools(ctx), input.id, input.version);
  if (isHandlerResult(selected)) return selected;
  return runLocalTool(ctx.root, selected, {
    inputs: input.inputs,
    contentHash: input.contentHash,
    executableHash: input.executableHash,
    argvHash: input.argvHash,
    cwdHash: input.cwdHash,
    prerequisiteHashes: input.prerequisiteHashes,
  });
}

export interface GetToolRunInput {
  runId: string;
}

export async function getToolRunHandler(ctx: AartContext, input: GetToolRunInput): Promise<HandlerResult> {
  if (!/^toolrun_[0-9a-f-]{36}$/.test(input.runId)) {
    return { ok: false, error: `Unknown local tool run "${input.runId}".` };
  }
  const run = await readLocalToolRun(ctx.root, input.runId);
  if (!run) return { ok: false, error: `Unknown local tool run "${input.runId}".` };
  return { ok: true, run };
}

export interface ListToolRunsInput {
  toolId?: string;
  status?: "running" | "terminal";
}

export async function listToolRunsHandler(ctx: AartContext, input: ListToolRunsInput): Promise<HandlerResult> {
  const runs = await listLocalToolRuns(ctx.root, input);
  const toolRunsResult: HandlerResult = { ok: true, runs, count: runs.length };
  return toolRunsResult;
}
