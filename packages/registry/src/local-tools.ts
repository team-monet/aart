import {
  constants,
  linkSync,
  mkdirSync,
  promises as fs,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { coerce, rcompare, satisfies, valid as validSemver, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { canonicalize } from "./hash.js";

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const INPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SECRET_ENV_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
const PLACEHOLDER_PATTERN = /^\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}$/;
const EVIDENCE_PATH_PATTERN = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/;

const versionCheckSchema = z
  .object({
    args: z.array(z.string()).min(1),
    semverRange: z
      .string()
      .refine((value) => validRange(value) !== null, "semverRange must be a valid SemVer range")
      .optional(),
    match: z.string().min(1).optional(),
  })
  .optional();

const executableSchema = z
  .object({
    executable: z.string().min(1),
    resolution: z.enum(["path", "absolute", "asset"]),
    versionCheck: versionCheckSchema,
  })
  .superRefine((value, ctx) => {
    if (value.resolution === "path" && (value.executable.includes("/") || value.executable.includes("\\"))) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "PATH-resolved executables must be a bare command name" });
    }
    if (value.resolution === "absolute" && !isAbsolute(value.executable)) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "absolute executable resolution requires an absolute path" });
    }
    if (value.resolution === "asset") {
      const segments = value.executable.split(/[\\/]+/);
      if (isAbsolute(value.executable) || segments.includes("..") || segments.includes(".")) {
        ctx.addIssue({
          code: "custom",
          path: ["executable"],
          message: "asset-owned executables must be a safe path relative to the manifest",
        });
      }
    }
  });

const prerequisiteSchema = z
  .object({
    name: z.string().min(1),
    executable: z.string().min(1),
    resolution: z.enum(["path", "absolute"]),
    versionCheck: versionCheckSchema,
    probe: z
      .object({
        args: z.array(z.string()),
        expectedExitCode: z.number().int().default(0),
      })
      .optional(),
    installHint: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.resolution === "path" && (value.executable.includes("/") || value.executable.includes("\\"))) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "PATH-resolved prerequisites must be a bare command name" });
    }
    if (value.resolution === "absolute" && !isAbsolute(value.executable)) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "absolute prerequisite resolution requires an absolute path" });
    }
  });

const inheritedEnvironmentSchema = z.union([z.literal("all"), z.array(z.string().min(1))]);

export const LocalToolManifestSchema = z
  .object({
    id: z.string().regex(TOOL_ID_PATTERN, "tool id must be lowercase and contain only letters, numbers, dot, underscore, or hyphen"),
    name: z.string().min(1),
    version: z.string().refine((value) => validSemver(value) !== null, "tool version must be valid SemVer"),
    description: z.string().min(1),
    keywords: z.array(z.string().min(1)).default([]),
    triggers: z.array(z.string().min(1)).min(1),
    examples: z
      .array(
        z.object({
          description: z.string().min(1),
          inputs: z.record(z.string(), z.string()).default({}),
        }),
      )
      .default([]),
    inputs: z
      .array(
        z.object({
          name: z.string().regex(INPUT_NAME_PATTERN, "input name must be a simple identifier"),
          description: z.string().min(1),
          required: z.boolean().default(true),
          sensitive: z.boolean().default(false),
        }),
      )
      .default([]),
    command: executableSchema.extend({
      args: z.array(z.string()),
      timeoutMs: z.number().int().positive().optional(),
    }),
    prerequisites: z.array(prerequisiteSchema).default([]),
    platforms: z.array(z.string().min(1)).default([]),
    capabilities: z.array(z.string().min(1)).default(["command"]),
    effects: z.object({
      reads: z.array(z.string().min(1)),
      writes: z.array(z.string().min(1)),
      network: z.array(z.string().min(1)),
    }),
    cwd: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("inherit") }),
      z.object({ mode: z.literal("asset") }),
      z.object({ mode: z.literal("fixed"), path: z.string().min(1) }),
    ]),
    authentication: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("inherited"),
        description: z.string().min(1),
        inheritEnvironment: inheritedEnvironmentSchema.default("all"),
      }),
      z.object({
        mode: z.literal("aart_secrets"),
        description: z.string().min(1),
        inheritEnvironment: z.array(z.string().min(1)).default([]),
        secrets: z
          .array(
            z.object({
              ref: z.string().min(1),
              env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "secret env must be an environment variable name"),
            }),
          )
          .min(1),
      }),
    ]),
    output: z.object({
      source: z.enum(["stdout", "stderr"]).default("stdout"),
      format: z.enum(["json", "jsonl", "text"]),
      evidence: z.record(z.string(), z.string().regex(EVIDENCE_PATH_PATTERN, "evidence selectors must be simple JSON paths")).default({}),
    }),
  })
  .superRefine((manifest, ctx) => {
    if (!manifest.capabilities.includes("command")) {
      ctx.addIssue({ code: "custom", path: ["capabilities"], message: 'local tools must declare the "command" capability' });
    }
    const inputNames = new Set<string>();
    for (const [index, input] of manifest.inputs.entries()) {
      if (inputNames.has(input.name)) {
        ctx.addIssue({ code: "custom", path: ["inputs", index, "name"], message: `duplicate input "${input.name}"` });
      }
      inputNames.add(input.name);
    }
    const prerequisiteNames = new Set<string>();
    for (const [index, prerequisite] of manifest.prerequisites.entries()) {
      if (prerequisiteNames.has(prerequisite.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["prerequisites", index, "name"],
          message: `duplicate prerequisite "${prerequisite.name}"`,
        });
      }
      prerequisiteNames.add(prerequisite.name);
    }
    for (const [index, template] of manifest.command.args.entries()) {
      if (!template.includes("{{")) continue;
      const match = PLACEHOLDER_PATTERN.exec(template);
      if (!match) {
        ctx.addIssue({
          code: "custom",
          path: ["command", "args", index],
          message: "an argv template must be either a literal or one whole {{inputName}} placeholder",
        });
      } else if (!inputNames.has(match[1]!)) {
        ctx.addIssue({
          code: "custom",
          path: ["command", "args", index],
          message: `argv placeholder "${match[1]}" has no declared input`,
        });
      }
    }
  });

export type LocalToolManifest = z.infer<typeof LocalToolManifestSchema>;
export type ToolPrerequisite = z.infer<typeof prerequisiteSchema>;

const toolProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_file"), source: z.string().min(1) }),
  z.object({ kind: z.literal("inline"), source: z.string().min(1) }),
  z.object({
    kind: z.literal("pack"),
    source: z.string().min(1),
    packName: z.string().min(1),
    packVersion: z.string().min(1),
  }),
]);

const RegisteredLocalToolSchema = z.object({
  manifest: LocalToolManifestSchema,
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  toolHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  registeredAt: z.string().datetime(),
  provenance: toolProvenanceSchema,
  ownedExecutable: z
    .object({
      path: z.string().min(1),
      contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .optional(),
});

export type RegisteredLocalTool = z.infer<typeof RegisteredLocalToolSchema>;
export type ToolProvenance = RegisteredLocalTool["provenance"];

export class LocalToolManifestError extends Error {}
export class LocalToolVersionConflictError extends Error {}

export function parseLocalToolManifest(input: unknown): LocalToolManifest {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = parseYaml(input);
    } catch (cause) {
      throw new LocalToolManifestError(`local tool manifest is not valid YAML: ${(cause as Error).message}`, { cause });
    }
  }
  const result = LocalToolManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new LocalToolManifestError(`local tool manifest failed validation: ${result.error.message}`, { cause: result.error });
  }
  return result.data;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeLocalToolHash(manifest: LocalToolManifest): string {
  return sha256(canonicalize(manifest));
}

function localToolRecordPath(root: string, id: string, version: string): string {
  return join(root, "tools", "registered", id, `${version}.json`);
}

function ownedExecutablePath(root: string, id: string, version: string): string {
  return join(root, "tools", "owned", id, version, "executable");
}

async function readRecord(path: string): Promise<RegisteredLocalTool | undefined> {
  try {
    return RegisteredLocalToolSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function writeOnce(path: string, bytes: string | Buffer, mode: number): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx", mode });
  try {
    await fs.link(temporary, path);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function writeOnceSync(path: string, bytes: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  try {
    linkSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

async function replaceFile(path: string, bytes: string | Buffer, mode: number): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx", mode });
  try {
    renameSync(temporary, path);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface RegisterLocalToolOptions {
  sourcePath?: string;
  now?: Date;
  sourceLabel?: string;
}

export async function registerLocalTool(
  root: string,
  input: unknown,
  options: RegisterLocalToolOptions = {},
): Promise<RegisteredLocalTool> {
  const manifest = parseLocalToolManifest(input);
  if (manifest.cwd.mode === "asset" && !options.sourcePath) {
    throw new LocalToolManifestError("asset working directories require sourcePath provenance");
  }
  const toolHash = computeLocalToolHash(manifest);
  let ownedExecutable: RegisteredLocalTool["ownedExecutable"];
  let ownedBytes: Buffer | undefined;
  let ownedMode = 0o700;

  if (manifest.command.resolution === "asset") {
    if (!options.sourcePath) {
      throw new LocalToolManifestError("asset-owned executables require sourcePath so registration can seal their bytes");
    }
    const sourceDirectory = await fs.realpath(dirname(resolve(options.sourcePath)));
    const requestedExecutable = resolve(sourceDirectory, manifest.command.executable);
    if (!isWithin(sourceDirectory, requestedExecutable)) {
      throw new LocalToolManifestError("asset-owned executable escapes the manifest directory");
    }
    const executableSource = await fs.realpath(requestedExecutable);
    if (!isWithin(sourceDirectory, executableSource)) {
      throw new LocalToolManifestError("asset-owned executable resolves outside the manifest directory");
    }
    const stat = await fs.lstat(requestedExecutable);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new LocalToolManifestError("asset-owned executable must be a regular, non-symlink file");
    }
    ownedBytes = await fs.readFile(executableSource);
    ownedMode = stat.mode & 0o777;
    ownedExecutable = {
      path: ownedExecutablePath(root, manifest.id, manifest.version),
      contentHash: sha256(ownedBytes),
    };
  }

  const contentHash = sha256(canonicalize({ manifest, ownedExecutableHash: ownedExecutable?.contentHash }));
  const provenance: ToolProvenance = options.sourcePath
    ? { kind: "local_file", source: resolve(options.sourcePath) }
    : { kind: "inline", source: options.sourceLabel ?? "aart_register_tool" };
  const record: RegisteredLocalTool = {
    manifest,
    contentHash,
    toolHash,
    registeredAt: (options.now ?? new Date()).toISOString(),
    provenance,
    ...(ownedExecutable ? { ownedExecutable } : {}),
  };

  const recordPath = localToolRecordPath(root, manifest.id, manifest.version);
  const existing = await readRecord(recordPath);
  if (existing) {
    if (existing.contentHash === record.contentHash) {
      if (existing.ownedExecutable && ownedBytes) {
        try {
          const storedHash = sha256(await fs.readFile(existing.ownedExecutable.path));
          if (storedHash !== existing.ownedExecutable.contentHash) {
            throw new LocalToolVersionConflictError(
              `owned executable seal for ${manifest.id}@${manifest.version} is broken`,
            );
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          await writeOnce(existing.ownedExecutable.path, ownedBytes, ownedMode);
        }
      }
      return existing;
    }
    throw new LocalToolVersionConflictError(
      `local tool ${manifest.id}@${manifest.version} is immutable and already has content hash ${existing.contentHash}`,
    );
  }

  if (ownedExecutable && ownedBytes) {
    try {
      await writeOnce(ownedExecutable.path, ownedBytes, ownedMode);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const storedHash = sha256(await fs.readFile(ownedExecutable.path));
      if (storedHash !== ownedExecutable.contentHash) {
        throw new LocalToolVersionConflictError(
          `owned executable for ${manifest.id}@${manifest.version} already exists with different bytes`,
        );
      }
    }
  }

  try {
    await writeOnce(recordPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const raced = await readRecord(recordPath);
    if (raced?.contentHash === record.contentHash) return raced;
    throw new LocalToolVersionConflictError(
      `local tool ${manifest.id}@${manifest.version} was concurrently registered with different content`,
    );
  }
  return record;
}

export async function listLocalTools(root: string): Promise<RegisteredLocalTool[]> {
  const base = join(root, "tools", "registered");
  let ids: string[];
  try {
    ids = await fs.readdir(base);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const records: RegisteredLocalTool[] = [];
  for (const id of ids.sort()) {
    const directory = join(base, id);
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      records.push(RegisteredLocalToolSchema.parse(JSON.parse(await fs.readFile(join(directory, file), "utf8"))));
    }
  }
  return records;
}

export function latestToolVersions(records: readonly RegisteredLocalTool[]): RegisteredLocalTool[] {
  const byId = new Map<string, RegisteredLocalTool>();
  for (const record of records) {
    const current = byId.get(record.manifest.id);
    if (!current || rcompare(record.manifest.version, current.manifest.version) < 0) {
      byId.set(record.manifest.id, record);
    }
  }
  return [...byId.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export function packToolRecord(
  manifest: LocalToolManifest,
  input: { packName: string; packVersion: string; contentHash: string; source: string; registeredAt?: string },
): RegisteredLocalTool {
  if (manifest.command.resolution === "asset" || manifest.cwd.mode === "asset") {
    throw new LocalToolManifestError(
      `Pack tool ${manifest.id} uses an asset-owned executable or working directory; v1 Pack tools support portable external prerequisites only`,
    );
  }
  return {
    manifest,
    contentHash: input.contentHash,
    toolHash: computeLocalToolHash(manifest),
    registeredAt: input.registeredAt ?? new Date(0).toISOString(),
    provenance: {
      kind: "pack",
      source: input.source,
      packName: input.packName,
      packVersion: input.packVersion,
    },
  };
}

function toolTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter((token) => token.length > 0 && !["a", "an", "and", "for", "the", "to", "tool", "tools"].includes(token));
}

export interface LocalToolSearchResult {
  record: RegisteredLocalTool;
  score: number;
}

export function searchLocalTools(records: readonly RegisteredLocalTool[], query: string): LocalToolSearchResult[] {
  const tokens = toolTokens(query);
  const minimumScore = tokens.length > 1 ? 2 : 1;
  return records
    .map((record) => {
      const manifest = record.manifest;
      if (tokens.length === 0) return { record, score: 1 };
      const id = manifest.id.toLowerCase();
      const name = manifest.name.toLowerCase();
      const haystack = [
        id,
        name,
        manifest.description,
        ...manifest.keywords,
        ...manifest.triggers,
        ...manifest.examples.map((example) => example.description),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (id === token) score += 12;
        else if (name === token) score += 10;
        else if (id.includes(token)) score += 6;
        else if (name.includes(token)) score += 5;
        else if (haystack.includes(token)) score += 1;
      }
      return { record, score };
    })
    .filter((result) => result.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.record.manifest.id.localeCompare(b.record.manifest.id));
}

interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function spawnNoShell(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onSpawn?: (pid: number) => void } = {},
): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let lifecycleError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, options.timeoutMs);
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("spawn", () => {
      if (!options.onSpawn || child.pid === undefined) return;
      try {
        options.onSpawn(child.pid);
      } catch (cause) {
        lifecycleError = cause as Error;
        terminateProcessTree(child);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (lifecycleError) {
        reject(lifecycleError);
        return;
      }
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

export function pathExecutableCandidates(
  command: string,
  platform: NodeJS.Platform,
  pathExt: string,
): string[] {
  if (platform !== "win32") return [command];
  const extensions = pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const commandLower = command.toLowerCase();
  if (extensions.some((extension) => commandLower.endsWith(extension.toLowerCase()))) {
    return [command];
  }
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

async function pathExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = env.PATH ?? "";
  const candidates = pathExecutableCandidates(command, process.platform, env.PATHEXT ?? ".EXE;.CMD;.BAT");
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const executable of candidates) {
      const candidate = join(directory, executable);
      try {
        await fs.access(candidate, constants.X_OK);
        return await fs.realpath(candidate);
      } catch {}
    }
  }
  return undefined;
}

async function resolvedExecutable(
  record: RegisteredLocalTool,
  spec: Pick<LocalToolManifest["command"], "executable" | "resolution">,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (spec.resolution === "path") return pathExecutable(spec.executable, env);
  if (spec.resolution === "asset") {
    if (!record.ownedExecutable) return undefined;
    try {
      await fs.access(record.ownedExecutable.path, constants.X_OK);
      return await fs.realpath(record.ownedExecutable.path);
    } catch {
      return undefined;
    }
  }
  try {
    await fs.access(spec.executable, constants.X_OK);
    return await fs.realpath(spec.executable);
  } catch {
    return undefined;
  }
}

async function inspectVersion(
  executable: string,
  check: NonNullable<LocalToolManifest["command"]["versionCheck"]> | undefined,
): Promise<{ raw?: string; version?: string; compatible: boolean; reason?: string }> {
  if (!check) return { compatible: true };
  const result = await spawnNoShell(executable, check.args, { timeoutMs: 5_000 });
  if (result.exitCode !== 0 || result.timedOut) {
    return { compatible: false, reason: `version check failed with exit ${String(result.exitCode)}` };
  }
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  let matched = raw;
  if (check.match) {
    const capture = new RegExp(check.match).exec(raw);
    if (!capture) return { raw, compatible: false, reason: "version output did not match the declared pattern" };
    matched = capture[1] ?? capture[0];
  }
  const version = coerce(matched)?.version;
  if (check.semverRange && (!version || !satisfies(version, check.semverRange))) {
    return {
      raw,
      version,
      compatible: false,
      reason: version
        ? `version ${version} does not satisfy ${check.semverRange}`
        : `could not parse a SemVer version required by ${check.semverRange}`,
    };
  }
  return { raw, version, compatible: true };
}

type ExecutableIdentity = {
  ready: true;
  path: string;
  contentHash: string;
  version?: string;
  versionOutput?: string;
};

type UnavailableExecutableIdentity = {
  ready: false;
  reason: string;
  sealMismatch?: true;
};

async function executableBytesIdentity(
  record: RegisteredLocalTool,
  spec: Pick<LocalToolManifest["command"], "executable" | "resolution">,
  env: NodeJS.ProcessEnv,
): Promise<ExecutableIdentity | UnavailableExecutableIdentity> {
  const path = await resolvedExecutable(record, spec, env);
  if (!path) return { ready: false, reason: `executable "${spec.executable}" was not found or is not executable` };
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch (cause) {
    return { ready: false, reason: `could not read resolved executable "${path}": ${(cause as Error).message}` };
  }
  const contentHash = sha256(bytes);
  if (spec.resolution === "asset" && record.ownedExecutable?.contentHash !== contentHash) {
    return { ready: false, reason: `asset-owned executable seal is broken (expected ${record.ownedExecutable?.contentHash}, got ${contentHash})` };
  }
  return { ready: true, path, contentHash };
}

async function executableIdentity(
  record: RegisteredLocalTool,
  spec: Pick<LocalToolManifest["command"], "executable" | "resolution" | "versionCheck">,
  env: NodeJS.ProcessEnv,
  expectedHash?: string,
): Promise<ExecutableIdentity | UnavailableExecutableIdentity> {
  const identity = await executableBytesIdentity(record, spec, env);
  if (!identity.ready) return identity;
  if (expectedHash !== undefined && identity.contentHash !== expectedHash) {
    return {
      ready: false,
      sealMismatch: true,
      reason: `reviewed executable hash ${expectedHash} does not match resolved hash ${identity.contentHash}`,
    };
  }
  const version = await inspectVersion(identity.path, spec.versionCheck);
  if (!version.compatible) return { ready: false, reason: version.reason ?? "incompatible executable version" };
  return {
    ...identity,
    ...(version.version ? { version: version.version } : {}),
    ...(version.raw ? { versionOutput: version.raw } : {}),
  };
}

async function resolveAartSecret(root: string, ref: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const name = ref.startsWith("secrets.") ? ref.slice("secrets.".length) : ref;
  const envValue = env[`AART_SECRET_${name}`];
  if (envValue) return envValue;
  try {
    const values = JSON.parse(await fs.readFile(join(root, "secrets.json"), "utf8")) as Record<string, unknown>;
    return typeof values[name] === "string" ? values[name] : undefined;
  } catch {
    return undefined;
  }
}

export type ToolAvailabilityStatus =
  | "ready"
  | "missing_prerequisite"
  | "incompatible"
  | "unsupported_platform"
  | "invalid_input"
  | "seal_mismatch";

export interface ToolCheckResult {
  status: ToolAvailabilityStatus;
  ready: boolean;
  contentHash: string;
  toolHash: string;
  executable?: { path: string; contentHash: string; version?: string; versionOutput?: string };
  prerequisites: Array<{
    name: string;
    ready: boolean;
    path?: string;
    contentHash?: string;
    version?: string;
    reason?: string;
    installHint?: string;
  }>;
  argv?: string[];
  argvHash?: string;
  prerequisiteHashes?: Record<string, string>;
  resolvedCwd?: string;
  reason?: string;
  approvalSummary: {
    asset: string;
    source: ToolProvenance;
    command: { executable: string; argsTemplate: string[]; argv?: string[] };
    capability: "command";
    authentication: { mode: "inherited" | "aart_secrets"; description: string; inheritedEnvironment: "all" | string[]; secretRefs: string[] };
    effects: LocalToolManifest["effects"];
    cwd: LocalToolManifest["cwd"];
    output: LocalToolManifest["output"];
  };
}

function renderArgs(manifest: LocalToolManifest, inputs: Readonly<Record<string, string>> | undefined): string[] {
  const values = inputs ?? {};
  for (const input of manifest.inputs) {
    if (input.required && values[input.name] === undefined) {
      throw new Error(`missing required tool input "${input.name}"`);
    }
  }
  return manifest.command.args.map((template) => {
    const match = PLACEHOLDER_PATTERN.exec(template);
    if (!match) return template;
    const value = values[match[1]!];
    if (value === undefined) throw new Error(`missing tool input "${match[1]}" used by argv`);
    return value;
  });
}

function reviewArgs(
  manifest: LocalToolManifest,
  inputs: Readonly<Record<string, string>> | undefined,
  rendered: readonly string[],
): string[] {
  const sensitive = new Set(manifest.inputs.filter((input) => input.sensitive).map((input) => input.name));
  return manifest.command.args.map((template, index) => {
    const match = PLACEHOLDER_PATTERN.exec(template);
    return match && sensitive.has(match[1]!) && inputs?.[match[1]!] !== undefined ? "[REDACTED]" : rendered[index]!;
  });
}

function approvalSummary(
  record: RegisteredLocalTool,
  argv?: string[],
): ToolCheckResult["approvalSummary"] {
  const manifest = record.manifest;
  return {
    asset: `${manifest.id}@${manifest.version}`,
    source: record.provenance,
    command: {
      executable: manifest.command.executable,
      argsTemplate: manifest.command.args,
      ...(argv ? { argv } : {}),
    },
    capability: "command",
    authentication: {
      mode: manifest.authentication.mode,
      description: manifest.authentication.description,
      inheritedEnvironment: manifest.authentication.inheritEnvironment,
      secretRefs: manifest.authentication.mode === "aart_secrets" ? manifest.authentication.secrets.map((secret) => secret.ref) : [],
    },
    effects: manifest.effects,
    cwd: manifest.cwd,
    output: manifest.output,
  };
}

export async function checkLocalTool(
  root: string,
  record: RegisteredLocalTool,
  options: {
    inputs?: Readonly<Record<string, string>>;
    env?: NodeJS.ProcessEnv;
    requireInputs?: boolean;
    expectedArgvHash?: string;
    expectedExecutableHash?: string;
    expectedPrerequisiteHashes?: Readonly<Record<string, string>>;
  } = {},
): Promise<ToolCheckResult> {
  const env = options.env ?? process.env;
  let argv: string[] | undefined;
  let argvHash: string | undefined;
  try {
    if (options.requireInputs === true || options.inputs !== undefined || record.manifest.inputs.length === 0) {
      const rendered = renderArgs(record.manifest, options.inputs);
      argvHash = sha256(canonicalize(rendered));
      argv = reviewArgs(record.manifest, options.inputs, rendered);
    }
  } catch (cause) {
    return {
      status: "invalid_input",
      ready: false,
      contentHash: record.contentHash,
      toolHash: record.toolHash,
      prerequisites: [],
      reason: (cause as Error).message,
      approvalSummary: approvalSummary(record),
    };
  }
  const base = {
    contentHash: record.contentHash,
    toolHash: record.toolHash,
    prerequisites: [] as ToolCheckResult["prerequisites"],
    approvalSummary: approvalSummary(record, argv),
    ...(argv ? { argv } : {}),
    ...(argvHash ? { argvHash } : {}),
  };

  if (options.expectedArgvHash !== undefined && argvHash !== options.expectedArgvHash) {
    return {
      ...base,
      status: "seal_mismatch",
      ready: false,
      reason: `reviewed argv hash ${options.expectedArgvHash} does not match rendered hash ${String(argvHash)}`,
    };
  }
  if (options.expectedPrerequisiteHashes !== undefined) {
    const declared = new Set(record.manifest.prerequisites.map((prerequisite) => prerequisite.name));
    const supplied = Object.keys(options.expectedPrerequisiteHashes);
    const extra = supplied.filter((name) => !declared.has(name));
    if (extra.length > 0) {
      return {
        ...base,
        status: "seal_mismatch",
        ready: false,
        reason: `reviewed prerequisite hashes include undeclared entries: ${extra.join(", ")}`,
      };
    }
  }

  if (record.manifest.platforms.length > 0 && !record.manifest.platforms.includes(process.platform)) {
    return {
      ...base,
      status: "unsupported_platform",
      ready: false,
      reason: `platform ${process.platform} is not supported (${record.manifest.platforms.join(", ")})`,
    };
  }

  const cwd = await availableToolCwd(record);
  if (!cwd.ready) {
    return {
      ...base,
      status: "missing_prerequisite",
      ready: false,
      reason: cwd.reason,
    };
  }

  const main = await executableIdentity(record, record.manifest.command, env, options.expectedExecutableHash);
  if (!main.ready) {
    return {
      ...base,
      status: main.sealMismatch ? "seal_mismatch" : main.reason.includes("version") ? "incompatible" : "missing_prerequisite",
      ready: false,
      reason: main.reason,
    };
  }

  for (const prerequisite of record.manifest.prerequisites) {
    const expectedPrerequisiteHash = options.expectedPrerequisiteHashes?.[prerequisite.name];
    if (options.expectedPrerequisiteHashes !== undefined && expectedPrerequisiteHash === undefined) {
      const unresolved = await executableBytesIdentity(record, prerequisite, env);
      if (!unresolved.ready) {
        base.prerequisites.push({
          name: prerequisite.name,
          ready: false,
          reason: unresolved.reason,
          installHint: prerequisite.installHint,
        });
        return {
          ...base,
          executable: main,
          status: "missing_prerequisite",
          ready: false,
          reason: `${prerequisite.name}: ${unresolved.reason}`,
        };
      }
      return {
        ...base,
        executable: main,
        status: "seal_mismatch",
        ready: false,
        reason: `${prerequisite.name}: no reviewed executable hash was supplied`,
      };
    }
    const identity = await executableIdentity(
      record,
      {
        executable: prerequisite.executable,
        resolution: prerequisite.resolution,
        versionCheck: prerequisite.versionCheck,
      },
      env,
      expectedPrerequisiteHash,
    );
    if (!identity.ready) {
      base.prerequisites.push({
        name: prerequisite.name,
        ready: false,
        reason: identity.reason,
        installHint: prerequisite.installHint,
      });
      return {
        ...base,
        executable: main,
        status: identity.sealMismatch ? "seal_mismatch" : identity.reason.includes("version") ? "incompatible" : "missing_prerequisite",
        ready: false,
        reason: `${prerequisite.name}: ${identity.reason}`,
      };
    }
    if (prerequisite.probe) {
      const beforeProbe = await executableBytesIdentity(record, prerequisite, env);
      if (!beforeProbe.ready || beforeProbe.contentHash !== identity.contentHash) {
        return {
          ...base,
          executable: main,
          status: "seal_mismatch",
          ready: false,
          reason: `${prerequisite.name}: prerequisite executable changed before its probe`,
        };
      }
      const probe = await spawnNoShell(identity.path, prerequisite.probe.args, { timeoutMs: 10_000 });
      if (probe.exitCode !== prerequisite.probe.expectedExitCode || probe.timedOut) {
        base.prerequisites.push({
          name: prerequisite.name,
          ready: false,
          path: identity.path,
          contentHash: identity.contentHash,
          version: identity.version,
          reason: `probe failed with exit ${String(probe.exitCode)}`,
          installHint: prerequisite.installHint,
        });
        return {
          ...base,
          executable: main,
          status: "missing_prerequisite",
          ready: false,
          reason: `${prerequisite.name}: prerequisite probe failed`,
        };
      }
    }
    base.prerequisites.push({
      name: prerequisite.name,
      ready: true,
      path: identity.path,
      contentHash: identity.contentHash,
      version: identity.version,
    });
  }

  if (record.manifest.authentication.mode === "aart_secrets") {
    for (const secret of record.manifest.authentication.secrets) {
      if (!(await resolveAartSecret(root, secret.ref, env))) {
        return {
          ...base,
          executable: main,
          status: "missing_prerequisite",
          ready: false,
          reason: `AART secret "${secret.ref}" is not configured`,
        };
      }
    }
  }

  return {
    ...base,
    executable: main,
    prerequisiteHashes: Object.fromEntries(
      base.prerequisites.map((prerequisite) => [prerequisite.name, prerequisite.contentHash!]),
    ),
    ...(cwd.path ? { resolvedCwd: cwd.path } : {}),
    status: "ready",
    ready: true,
  };
}

function selectEnvironment(
  root: string,
  manifest: LocalToolManifest,
  hostEnv: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv | undefined; secrets: string[] }> {
  return (async () => {
    const inherited = manifest.authentication.inheritEnvironment;
    const env: NodeJS.ProcessEnv | undefined =
      inherited === "all"
        ? undefined
        : Object.fromEntries(inherited.flatMap((name) => (hostEnv[name] === undefined ? [] : [[name, hostEnv[name]]])));
    const secretValues: string[] = [];
    if (manifest.authentication.mode === "aart_secrets") {
      const target = env ?? { ...hostEnv };
      for (const secret of manifest.authentication.secrets) {
        const value = await resolveAartSecret(root, secret.ref, hostEnv);
        if (!value) throw new Error(`AART secret "${secret.ref}" is not configured`);
        target[secret.env] = value;
        secretValues.push(value);
      }
      return { env: target, secrets: secretValues };
    }
    return { env, secrets: secretValues };
  })();
}

function toolCwd(record: RegisteredLocalTool): string | undefined {
  const cwd = record.manifest.cwd;
  if (cwd.mode === "inherit") return undefined;
  if (cwd.mode === "fixed") return cwd.path;
  if (record.provenance.kind === "inline") throw new Error("cwd mode asset requires file or Pack provenance");
  return record.provenance.kind === "local_file" ? dirname(record.provenance.source) : record.provenance.source;
}

async function availableToolCwd(
  record: RegisteredLocalTool,
): Promise<{ ready: true; path?: string } | { ready: false; reason: string }> {
  let path: string | undefined;
  try {
    path = toolCwd(record);
  } catch (cause) {
    return { ready: false, reason: (cause as Error).message };
  }
  if (!path) return { ready: true };
  try {
    const resolved = await fs.realpath(path);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return { ready: false, reason: `working directory "${path}" is not a directory` };
    await fs.access(resolved, constants.R_OK | constants.X_OK);
    return { ready: true, path: resolved };
  } catch {
    return { ready: false, reason: `working directory "${path}" does not exist or cannot be entered` };
  }
}

function redactText(text: string, literals: readonly string[]): string {
  const forms = literals.flatMap((value) => {
    if (value.length === 0) return [];
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    const urlEncoded = encodeURIComponent(value);
    return [...new Set([value, jsonEscaped, urlEncoded])];
  });
  return forms
    .sort((a, b) => b.length - a.length)
    .reduce((current, value) => current.split(value).join("[REDACTED]"), text);
}

function redactStructured(value: unknown, literals: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, literals);
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, literals));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactStructured(item, literals)]));
  }
  return value;
}

function parseStructuredOutput(format: LocalToolManifest["output"]["format"], text: string): unknown {
  if (format === "text") return text;
  if (format === "json") return JSON.parse(text);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function evidenceAtPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  const tokens = [...path.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)].map((match) =>
    match[1] !== undefined ? match[1] : Number(match[2]),
  );
  let current = value;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

export interface RunLocalToolInput {
  inputs?: Readonly<Record<string, string>>;
  contentHash: string;
  executableHash: string;
  argvHash: string;
  prerequisiteHashes?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
}

export interface LocalToolRunRecord {
  runId: string;
  toolId: string;
  toolVersion: string;
  contentHash: string;
  executableHash: string;
  argvHash: string;
  prerequisiteHashes: Record<string, string>;
  startedAt: string;
  endedAt?: string;
  status: "running" | "terminal";
  result: Record<string, unknown> & { ok: boolean; ran: true };
}

function localToolRunPath(root: string, runId: string): string {
  if (!/^toolrun_[0-9a-f-]{36}$/.test(runId)) throw new Error(`invalid local tool run id "${runId}"`);
  return join(root, "tools", "runs", `${runId}.json`);
}

function beginLocalToolRun(
  root: string,
  record: RegisteredLocalTool,
  executableHash: string,
  argvHash: string,
  prerequisiteHashes: Readonly<Record<string, string>>,
  runId: string,
  startedAt: string,
  result: Record<string, unknown> & { ok: boolean; ran: true },
): LocalToolRunRecord {
  const durable: LocalToolRunRecord = {
    runId,
    toolId: record.manifest.id,
    toolVersion: record.manifest.version,
    contentHash: record.contentHash,
    executableHash,
    argvHash,
    prerequisiteHashes: { ...prerequisiteHashes },
    startedAt,
    status: "running",
    result,
  };
  writeOnceSync(localToolRunPath(root, runId), `${JSON.stringify(durable, null, 2)}\n`, 0o600);
  return durable;
}

async function completeLocalToolRun(
  root: string,
  running: LocalToolRunRecord,
  result: Record<string, unknown> & { ok: boolean; ran: true },
): Promise<(typeof result) & { runId: string; evidenceStored: true }> {
  const durable: LocalToolRunRecord = {
    ...running,
    endedAt: new Date().toISOString(),
    status: "terminal",
    result,
  };
  await replaceFile(localToolRunPath(root, running.runId), `${JSON.stringify(durable, null, 2)}\n`, 0o600);
  return { ...result, runId: running.runId, evidenceStored: true };
}

export async function readLocalToolRun(root: string, runId: string): Promise<LocalToolRunRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(localToolRunPath(root, runId), "utf8")) as LocalToolRunRecord;
    if (
      parsed.runId !== runId ||
      parsed.result?.ran !== true ||
      typeof parsed.toolId !== "string" ||
      typeof parsed.toolVersion !== "string" ||
      !["running", "terminal"].includes(parsed.status) ||
      typeof parsed.argvHash !== "string" ||
      !parsed.prerequisiteHashes ||
      typeof parsed.prerequisiteHashes !== "object"
    ) {
      throw new Error(`local tool run record "${runId}" failed validation`);
    }
    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

export async function listLocalToolRuns(
  root: string,
  filter: { toolId?: string; status?: LocalToolRunRecord["status"] } = {},
): Promise<LocalToolRunRecord[]> {
  const directory = join(root, "tools", "runs");
  let files: string[];
  try {
    files = await fs.readdir(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const records: LocalToolRunRecord[] = [];
  for (const file of files.filter((name) => /^toolrun_[0-9a-f-]{36}\.json$/.test(name)).sort()) {
    const run = await readLocalToolRun(root, file.slice(0, -".json".length));
    if (!run) continue;
    if (filter.toolId !== undefined && run.toolId !== filter.toolId) continue;
    if (filter.status !== undefined && run.status !== filter.status) continue;
    records.push(run);
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
}

export async function runLocalTool(
  root: string,
  record: RegisteredLocalTool,
  input: RunLocalToolInput,
): Promise<Record<string, unknown> & { ok: boolean; ran: boolean }> {
  if (input.contentHash !== record.contentHash) {
    return {
      ok: false,
      ran: false,
      kind: "asset_seal_mismatch",
      error: `reviewed asset hash ${input.contentHash} does not match current hash ${record.contentHash}`,
    };
  }
  const check = await checkLocalTool(root, record, {
    inputs: input.inputs,
    env: input.env,
    requireInputs: true,
    expectedArgvHash: input.argvHash,
    expectedExecutableHash: input.executableHash,
    expectedPrerequisiteHashes: input.prerequisiteHashes ?? {},
  });
  if (!check.ready || !check.executable || !check.argv) {
    return {
      ok: false,
      ran: false,
      kind: check.status === "seal_mismatch" ? "review_seal_mismatch" : check.status,
      error: check.reason ?? "local tool prerequisites are not ready",
      check,
    };
  }

  const hostEnv = input.env ?? process.env;
  const selected = await selectEnvironment(root, record.manifest, hostEnv);
  const executionArgv = renderArgs(record.manifest, input.inputs);
  const sensitiveInputs = record.manifest.inputs
    .filter((definition) => definition.sensitive)
    .flatMap((definition) => (input.inputs?.[definition.name] ? [input.inputs[definition.name]!] : []));
  const inheritedSecretValues =
    record.manifest.authentication.mode === "inherited"
      ? Object.entries(hostEnv)
          .filter(
            ([name, value]) =>
              SECRET_ENV_PATTERN.test(name) && typeof value === "string" && value.length >= 4,
          )
          .map(([, value]) => value as string)
      : [];
  const redactions = [...selected.secrets, ...sensitiveInputs, ...inheritedSecretValues];
  const rechecked = await executableIdentity(record, record.manifest.command, hostEnv);
  if (!rechecked.ready || rechecked.contentHash !== input.executableHash) {
    return {
      ok: false,
      ran: false,
      kind: "executable_seal_mismatch",
      error: rechecked.ready
        ? `resolved executable changed before spawn (expected ${input.executableHash}, got ${rechecked.contentHash})`
        : rechecked.reason,
    };
  }
  for (const prerequisite of record.manifest.prerequisites) {
    const identity = await executableBytesIdentity(record, prerequisite, hostEnv);
    const expectedHash = (input.prerequisiteHashes ?? {})[prerequisite.name];
    if (!identity.ready || identity.contentHash !== expectedHash) {
      return {
        ok: false,
        ran: false,
        kind: "review_seal_mismatch",
        error: `${prerequisite.name}: prerequisite executable changed before task spawn`,
      };
    }
  }
  const startedAt = new Date().toISOString();
  const runId = `toolrun_${randomUUID()}`;
  const prerequisiteHashes = { ...(input.prerequisiteHashes ?? {}) };
  const executionContext = {
    asset: `${record.manifest.id}@${record.manifest.version}`,
    source: record.provenance,
    contentHash: record.contentHash,
    toolHash: record.toolHash,
    executable: rechecked,
    prerequisites: check.prerequisites,
    argv: executionArgv.map((arg) => redactText(arg, redactions)),
    argvHash: input.argvHash,
    prerequisiteHashes,
    cwd: check.resolvedCwd ?? process.cwd(),
    authentication: check.approvalSummary.authentication,
  };
  let processStarted = false;
  let running: LocalToolRunRecord | undefined;
  let result: SpawnResult;
  try {
    result = await spawnNoShell(rechecked.path, executionArgv, {
      cwd: check.resolvedCwd,
      env: selected.env,
      timeoutMs: record.manifest.command.timeoutMs,
      onSpawn: (pid) => {
        processStarted = true;
        running = beginLocalToolRun(
          root,
          record,
          rechecked.contentHash,
          input.argvHash,
          prerequisiteHashes,
          runId,
          startedAt,
          {
            ok: false,
            ran: true,
            kind: "running",
            evidence: { ...executionContext, pid },
          },
        );
      },
    });
  } catch (cause) {
    if (running) {
      return completeLocalToolRun(root, running, {
        ok: false,
        ran: true,
        kind: "execution_monitor_failed",
        error: `local tool process started but monitoring failed: ${(cause as Error).message}`,
        evidence: running.result.evidence,
      });
    }
    return {
      ok: false,
      ran: processStarted,
      kind: processStarted ? "evidence_persistence_failed" : "spawn_failed",
      error: processStarted
        ? `local tool process started but its running record could not be persisted: ${(cause as Error).message}`
        : `local tool failed to spawn after preflight: ${(cause as Error).message}`,
    };
  }
  if (!running) {
    return {
      ok: false,
      ran: false,
      kind: "spawn_failed",
      error: "local tool closed without emitting a successful spawn event",
    };
  }
  const stdout = redactText(result.stdout, redactions);
  const stderr = redactText(result.stderr, redactions);
  const outputText = record.manifest.output.source === "stdout" ? stdout : stderr;
  let structuredOutput: unknown;
  let outputParseError: string | undefined;
  try {
    structuredOutput = redactStructured(parseStructuredOutput(record.manifest.output.format, outputText), redactions);
  } catch (cause) {
    outputParseError = `${record.manifest.output.source} was not valid ${record.manifest.output.format}: ${(cause as Error).message}`;
  }
  const mappedEvidence =
    outputParseError === undefined
      ? Object.fromEntries(
          Object.entries(record.manifest.output.evidence).map(([name, path]) => [
            name,
            evidenceAtPath(structuredOutput, path),
          ]),
        )
      : {};
  const evidence = {
    ...executionContext,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout,
    stderr,
    mapped: mappedEvidence,
    ...(outputParseError ? { outputParseError } : {}),
  };
  if (result.exitCode !== 0 || result.timedOut) {
    return completeLocalToolRun(root, running, {
      ok: false,
      ran: true,
      kind: result.timedOut ? "timed_out" : "command_failed",
      error: result.timedOut ? "local tool timed out" : `local tool exited with code ${String(result.exitCode)}`,
      ...(outputParseError === undefined ? { structuredOutput } : {}),
      evidence,
    });
  }
  if (outputParseError !== undefined) {
    return completeLocalToolRun(root, running, {
      ok: false,
      ran: true,
      kind: "invalid_structured_output",
      error: `tool ran but ${outputParseError}`,
      evidence,
    });
  }
  return completeLocalToolRun(root, running, {
    ok: true,
    ran: true,
    structuredOutput,
    evidence,
  });
}
