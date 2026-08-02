import {
  constants,
  linkSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { coerce, rcompare, satisfies, valid as validSemver, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { canonicalize } from "./hash.js";

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const INPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SECRET_ENV_PATTERN =
  /(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|SESSION|DATABASE_URL)/i;
const PLACEHOLDER_PATTERN = /^\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}$/;
const EVIDENCE_PATH_PATTERN = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/;
const MAX_CAPTURE_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 2_147_483_647;
const REGEX_EXECUTION_TIMEOUT_MS = 1_000;
const CURRENT_PROCESS_START_IDENTITY = processStartIdentity(process.pid);

function isAnyPlatformAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function isValidRegex(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

const versionCheckSchema = z
  .object({
    args: z.array(z.string()).min(1),
    semverRange: z
      .string()
      .refine((value) => validRange(value) !== null, "semverRange must be a valid SemVer range")
      .optional(),
    match: z.string().min(1).refine(isValidRegex, "match must be a valid regular expression").optional(),
  })
  .optional();

const executableSchema = z
  .object({
    executable: z.string().min(1),
    resolution: z.enum(["path", "absolute", "asset"]),
    snapshotMode: z.literal("standalone").optional(),
    versionCheck: versionCheckSchema,
  })
  .superRefine((value, ctx) => {
    if (value.resolution === "path" && (value.executable.includes("/") || value.executable.includes("\\"))) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "PATH-resolved executables must be a bare command name" });
    }
    if (value.resolution === "path" && ([".", ".."].includes(value.executable) || value.executable.startsWith("-"))) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "PATH-resolved executables must be safe command names" });
    }
    if (value.resolution === "absolute" && !isAnyPlatformAbsolute(value.executable)) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "absolute executable resolution requires an absolute path" });
    }
    if (value.resolution === "asset") {
      const segments = value.executable.split(/[\\/]+/);
      if (isAnyPlatformAbsolute(value.executable) || segments.includes("..") || segments.includes(".")) {
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
    resolution: z.literal("path"),
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
    if (value.executable.includes("/") || value.executable.includes("\\")) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "PATH-resolved prerequisites must be a bare command name" });
    }
    if ([".", ".."].includes(value.executable) || value.executable.startsWith("-")) {
      ctx.addIssue({ code: "custom", path: ["executable"], message: "PATH-resolved prerequisites must be safe command names" });
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
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
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
    if (manifest.cwd.mode === "asset") {
      ctx.addIssue({
        code: "custom",
        path: ["cwd", "mode"],
        message: "asset working directories are not supported until their complete file set can be snapshotted and sealed",
      });
    }
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
      } else if (manifest.inputs.find((input) => input.name === match[1])?.required === false) {
        ctx.addIssue({
          code: "custom",
          path: ["command", "args", index],
          message: `optional input "${match[1]}" cannot be an argv placeholder; omit optionality or encode the optional behavior in the fixed command`,
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

function computeRegisteredLocalToolContentHash(record: RegisteredLocalTool): string {
  if (record.provenance.kind === "pack") return record.contentHash;
  return sha256(
    canonicalize({
      manifest: record.manifest,
      ownedExecutableHash: record.ownedExecutable?.contentHash,
    }),
  );
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

function replaceFileSync(path: string, bytes: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  try {
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
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
  let resolvedSourcePath: string | undefined;
  if (options.sourcePath) {
    try {
      resolvedSourcePath = await fs.realpath(resolve(options.sourcePath));
      const sourceManifest = parseLocalToolManifest(await fs.readFile(resolvedSourcePath, "utf8"));
      if (canonicalize(sourceManifest) !== canonicalize(manifest)) {
        throw new LocalToolManifestError(
          `sourcePath manifest "${resolvedSourcePath}" does not match the supplied local tool contract`,
        );
      }
    } catch (cause) {
      if (cause instanceof LocalToolManifestError) throw cause;
      throw new LocalToolManifestError(
        `sourcePath does not identify a readable local tool manifest: ${(cause as Error).message}`,
        { cause },
      );
    }
  }
  const toolHash = computeLocalToolHash(manifest);
  let ownedExecutable: RegisteredLocalTool["ownedExecutable"];
  let ownedBytes: Buffer | undefined;
  let ownedMode = 0o700;

  if (manifest.command.resolution === "asset") {
    if (!resolvedSourcePath) {
      throw new LocalToolManifestError("asset-owned executables require sourcePath so registration can seal their bytes");
    }
    const sourceDirectory = dirname(resolvedSourcePath);
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
  const provenance: ToolProvenance = resolvedSourcePath
    ? { kind: "local_file", source: resolvedSourcePath }
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
  outputLimitExceeded: boolean;
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
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
      if (outputLimitExceeded) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) {
        stdout = Buffer.from(stdout, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
        outputLimitExceeded = true;
        terminateProcessTree(child);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (outputLimitExceeded) return;
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_CAPTURE_BYTES) {
        stderr = Buffer.from(stderr, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
        outputLimitExceeded = true;
        terminateProcessTree(child);
      }
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
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, outputLimitExceeded });
    });
  });
}

export function pathExecutableCandidates(
  command: string,
  platform: NodeJS.Platform,
  pathExt: string,
): string[] {
  if (platform !== "win32") return [command];
  if (/\.(?:cmd|bat)$/i.test(command)) return [];
  const extensions = pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.(?:exe|com)$/i.test(extension));
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

async function sealExecutableSnapshot(
  root: string,
  sourcePath: string,
  expectedHash: string,
  requestedExtension: string,
): Promise<string> {
  const digest = /^sha256:([a-f0-9]{64})$/.exec(expectedHash)?.[1];
  if (!digest) throw new Error(`invalid executable hash "${expectedHash}"`);
  const extension = /^\.[A-Za-z0-9]+$/.test(requestedExtension) ? requestedExtension.toLowerCase() : "";
  const target = join(root, "tools", "execution-snapshots", `${digest}${extension}`);

  async function verifyTarget(): Promise<string> {
    const storedHash = sha256(await fs.readFile(target));
    if (storedHash !== expectedHash) {
      throw new Error(`execution snapshot seal is broken (expected ${expectedHash}, got ${storedHash})`);
    }
    await fs.access(target, constants.X_OK);
    return fs.realpath(target);
  }

  try {
    return await verifyTarget();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  await fs.mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(sourcePath, temporary, constants.COPYFILE_FICLONE);
    await fs.chmod(temporary, 0o500);
    const copiedHash = sha256(await fs.readFile(temporary));
    if (copiedHash !== expectedHash) {
      throw new Error(`executable changed while it was snapshotted (expected ${expectedHash}, got ${copiedHash})`);
    }
    try {
      await fs.link(temporary, target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return verifyTarget();
}

async function prepareSealedPrerequisitePath(
  root: string,
  prerequisites: ReadonlyArray<{
    manifest: LocalToolManifest["prerequisites"][number];
    identity: ExecutableIdentity;
  }>,
): Promise<string> {
  const pathHash = sha256(
    canonicalize(
      prerequisites.map(({ manifest, identity }) => ({
        executable: manifest.executable,
        contentHash: identity.contentHash,
        mode: identity.mode,
        protectedPath: identity.mode === "protected_original" ? identity.path : undefined,
      })),
    ),
  ).slice("sha256:".length);
  const directory = join(root, "tools", "prerequisite-paths", pathHash);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const expectedNames = new Set<string>();
  for (const { manifest, identity } of prerequisites) {
    for (const name of sealedPrerequisiteNames(manifest, identity)) {
      expectedNames.add(name);
      const target = join(directory, name);
      try {
        if (identity.mode === "protected_original") {
          await fs.symlink(identity.sealedPath, target);
        } else {
          await fs.link(identity.sealedPath, target);
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        const existingHash = sha256(await fs.readFile(target));
        if (existingHash !== identity.sourceContentHash) {
          throw new Error(`sealed prerequisite alias "${name}" has a broken content hash`);
        }
        if (
          identity.mode === "protected_original" &&
          (await fs.realpath(target)) !== identity.path
        ) {
          throw new Error(`sealed prerequisite alias "${name}" points outside its protected executable`);
        }
      }
    }
  }
  const unexpected = (await fs.readdir(directory)).filter((name) => !expectedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`sealed prerequisite PATH contains undeclared aliases: ${unexpected.join(", ")}`);
  }
  return fs.realpath(directory);
}

function sealedPrerequisiteNames(
  manifest: LocalToolManifest["prerequisites"][number],
  identity: ExecutableIdentity,
): string[] {
  const extension = process.platform === "win32" ? extname(identity.path) : "";
  return [
    manifest.executable,
    ...(extension && !manifest.executable.toLowerCase().endsWith(extension.toLowerCase())
      ? [`${manifest.executable}${extension}`]
      : []),
  ];
}

async function verifySealedExecutable(identity: ExecutableIdentity, label: string): Promise<void> {
  const entrypointHash = sha256(await fs.readFile(identity.sealedPath));
  if (entrypointHash !== identity.sourceContentHash) {
    throw new Error(`${label} entrypoint seal is broken (expected ${identity.sourceContentHash}, got ${entrypointHash})`);
  }
  await fs.access(identity.sealedPath, constants.X_OK);
  if (identity.mode === "protected_original" && (await fs.realpath(identity.sealedPath)) !== identity.path) {
    throw new Error(`${label} entrypoint seal no longer resolves to its protected executable`);
  }
  if (!identity.interpreter) {
    if (identity.launchPath !== identity.sealedPath) {
      throw new Error(`${label} launch path no longer matches its sealed executable`);
    }
    return;
  }
  const interpreterHash = sha256(await fs.readFile(identity.interpreter.sealedPath));
  if (interpreterHash !== identity.interpreter.contentHash) {
    throw new Error(
      `${label} interpreter seal is broken (expected ${identity.interpreter.contentHash}, got ${interpreterHash})`,
    );
  }
  await fs.access(identity.interpreter.sealedPath, constants.X_OK);
  if (
    identity.interpreter.mode === "protected_original" &&
    (await fs.realpath(identity.interpreter.sealedPath)) !== identity.interpreter.path
  ) {
    throw new Error(`${label} interpreter seal no longer resolves to its protected executable`);
  }
  if (identity.launchPath !== identity.interpreter.sealedPath) {
    throw new Error(`${label} launch path no longer matches its sealed interpreter`);
  }
}

async function verifySealedExecutionArtifacts(
  main: ExecutableIdentity,
  prerequisites: ReadonlyArray<{
    manifest: LocalToolManifest["prerequisites"][number];
    identity: ExecutableIdentity;
  }>,
  prerequisitePath: string,
): Promise<string | undefined> {
  try {
    await verifySealedExecutable(main, "command");
    const expectedNames = new Set<string>();
    for (const { manifest, identity } of prerequisites) {
      await verifySealedExecutable(identity, `prerequisite ${manifest.name}`);
      for (const name of sealedPrerequisiteNames(manifest, identity)) {
        expectedNames.add(name);
        const alias = join(prerequisitePath, name);
        const aliasHash = sha256(await fs.readFile(alias));
        if (aliasHash !== identity.sourceContentHash) {
          throw new Error(
            `prerequisite ${manifest.name} alias "${name}" seal is broken (expected ${identity.sourceContentHash}, got ${aliasHash})`,
          );
        }
        await fs.access(alias, constants.X_OK);
        if (identity.mode === "protected_original" && (await fs.realpath(alias)) !== identity.path) {
          throw new Error(`prerequisite ${manifest.name} alias "${name}" no longer points to its protected executable`);
        }
      }
    }
    const unexpected = (await fs.readdir(prerequisitePath)).filter((name) => !expectedNames.has(name));
    if (unexpected.length > 0) {
      throw new Error(`sealed prerequisite PATH contains undeclared aliases: ${unexpected.join(", ")}`);
    }
    return undefined;
  } catch (cause) {
    return `approval-bound subprocess changed sealed execution artifacts: ${(cause as Error).message}`;
  }
}

function boundedRegexExec(pattern: string, input: string): Promise<Array<string | null> | undefined> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(
      [
        'const { parentPort, workerData } = require("node:worker_threads");',
        "const match = new RegExp(workerData.pattern).exec(workerData.input);",
        "parentPort.postMessage(match ? Array.from(match, (value) => value ?? null) : null);",
      ].join("\n"),
      { eval: true, workerData: { pattern, input } },
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`version match exceeded the ${REGEX_EXECUTION_TIMEOUT_MS}ms regex time budget`));
    }, REGEX_EXECUTION_TIMEOUT_MS);
    worker.once("message", (captures: Array<string | null> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolvePromise(captures ?? undefined);
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`version-match worker exited with code ${code}`));
    });
  });
}

async function inspectVersion(
  identity: ExecutableIdentity,
  check: NonNullable<LocalToolManifest["command"]["versionCheck"]> | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  execute: (request: ApprovalBoundSubprocessRequest) => Promise<SpawnResult>,
  phase: "command_version_check" | "prerequisite_version_check",
  prerequisite?: string,
): Promise<{ raw?: string; version?: string; compatible: boolean; reason?: string }> {
  if (!check) return { compatible: true };
  const result = await execute({
    phase,
    ...(prerequisite ? { prerequisite } : {}),
    executable: identity,
    args: check.args,
    env,
    cwd,
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
    if (result.outputLimitExceeded) {
      return { compatible: false, reason: `version check exceeded the ${MAX_CAPTURE_BYTES}-byte output limit` };
    }
    return { compatible: false, reason: `version check failed with exit ${String(result.exitCode)}` };
  }
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  let matched = raw;
  if (check.match) {
    let capture: Array<string | null> | undefined;
    try {
      capture = await boundedRegexExec(check.match, raw);
    } catch (cause) {
      return { raw, compatible: false, reason: (cause as Error).message };
    }
    if (!capture) return { raw, compatible: false, reason: "version output did not match the declared pattern" };
    matched = capture[1] ?? capture[0] ?? "";
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
  sealedPath: string;
  mode: "snapshot" | "protected_original";
  launchPath: string;
  launchArgsPrefix: string[];
  sourceContentHash: string;
  contentHash: string;
  version?: string;
  interpreter?: {
    path: string;
    sealedPath: string;
    contentHash: string;
    args: string[];
    mode: "snapshot" | "protected_original";
  };
};

type UnavailableExecutableIdentity = {
  ready: false;
  reason: string;
  failureKind: "missing" | "incompatible" | "seal_mismatch";
};

function availabilityStatus(identity: UnavailableExecutableIdentity): ToolAvailabilityStatus {
  if (identity.failureKind === "seal_mismatch") return "seal_mismatch";
  if (identity.failureKind === "incompatible") return "incompatible";
  return "missing_prerequisite";
}

async function shebangInterpreter(
  bytes: Buffer,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; args: string[] } | undefined> {
  if (bytes.subarray(0, 2).toString("utf8") !== "#!") return undefined;
  const firstLine = bytes.subarray(2, Math.min(bytes.length, 1_024)).toString("utf8").split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error("interpreter executable has an empty shebang");
  const tokens = firstLine.split(/\s+/);
  let interpreter = tokens.shift()!;
  let args = tokens;
  if (interpreter === "/usr/bin/env") {
    if (args[0] === "-S") args = args.slice(1);
    if (args.length === 0 || args[0]!.startsWith("-") || args[0]!.includes("=")) {
      throw new Error("only simple /usr/bin/env <interpreter> shebangs are supported");
    }
    interpreter = args.shift()!;
  }
  const path = isAnyPlatformAbsolute(interpreter)
    ? await fs.realpath(interpreter)
    : await pathExecutable(interpreter, env);
  if (!path) throw new Error(`shebang interpreter "${interpreter}" was not found`);
  await fs.access(path, constants.X_OK);
  return { path, args };
}

async function isProtectedExecutablePath(path: string): Promise<boolean> {
  let current = path;
  for (;;) {
    try {
      await fs.access(current, constants.W_OK);
      return false;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") return false;
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

async function executableBytesIdentity(
  root: string,
  record: RegisteredLocalTool,
  spec: Pick<
    LocalToolManifest["command"],
    "executable" | "resolution" | "snapshotMode" | "versionCheck"
  >,
  env: NodeJS.ProcessEnv,
  allowInterpreter = false,
): Promise<ExecutableIdentity | UnavailableExecutableIdentity> {
  const path = await resolvedExecutable(record, spec, env);
  if (!path) {
    return {
      ready: false,
      failureKind: "missing",
      reason: `executable "${spec.executable}" was not found or is not executable`,
    };
  }
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(path)) {
    return {
      ready: false,
      failureKind: "incompatible",
      reason: `Windows command scripts cannot be launched with shell-free execution: "${path}"`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch (cause) {
    return {
      ready: false,
      failureKind: "missing",
      reason: `could not read resolved executable "${path}": ${(cause as Error).message}`,
    };
  }
  const sourceContentHash = sha256(bytes);
  let interpreter: Awaited<ReturnType<typeof shebangInterpreter>>;
  try {
    interpreter = await shebangInterpreter(bytes, env);
  } catch (cause) {
    return {
      ready: false,
      failureKind: "incompatible",
      reason: `could not resolve shebang interpreter: ${(cause as Error).message}`,
    };
  }
  if (interpreter && spec.snapshotMode !== "standalone") {
    return {
      ready: false,
      failureKind: "incompatible",
      reason:
        "interpreter executables must declare snapshotMode \"standalone\"; package-relative entrypoints cannot be sealed as one executable file",
    };
  }
  if (interpreter && !allowInterpreter) {
    return {
      ready: false,
      failureKind: "incompatible",
      reason: "interpreter prerequisites cannot be routed through the sealed shell-free prerequisite PATH",
    };
  }
  if (interpreter && !spec.versionCheck) {
    return {
      ready: false,
      failureKind: "incompatible",
      reason:
        "standalone interpreter executables must declare a versionCheck that runs against the snapshot to verify it does not need package-relative context",
    };
  }
  if (spec.resolution === "asset" && record.ownedExecutable?.contentHash !== sourceContentHash) {
    return {
      ready: false,
      failureKind: "seal_mismatch",
      reason: `asset-owned executable seal is broken (expected ${record.ownedExecutable?.contentHash}, got ${sourceContentHash})`,
    };
  }
  try {
    const protectedOriginal = process.platform === "darwin" && (await isProtectedExecutablePath(path));
    const sealedPath = protectedOriginal
      ? path
      : await sealExecutableSnapshot(root, path, sourceContentHash, extname(path));
    if (!interpreter) {
      return {
        ready: true,
        path,
        sealedPath,
        mode: protectedOriginal ? "protected_original" : "snapshot",
        launchPath: sealedPath,
        launchArgsPrefix: [],
        sourceContentHash,
        contentHash: sourceContentHash,
      };
    }
    const interpreterBytes = await fs.readFile(interpreter.path);
    if (interpreterBytes.subarray(0, 2).toString("utf8") === "#!") {
      throw new Error("nested shebang interpreters are not supported");
    }
    const interpreterHash = sha256(interpreterBytes);
    const protectedInterpreter =
      process.platform === "darwin" && (await isProtectedExecutablePath(interpreter.path));
    const sealedInterpreterPath = protectedInterpreter
      ? interpreter.path
      : await sealExecutableSnapshot(root, interpreter.path, interpreterHash, extname(interpreter.path));
    const contentHash = sha256(
      canonicalize({
        entrypointHash: sourceContentHash,
        interpreterHash,
        interpreterPath: protectedInterpreter ? interpreter.path : undefined,
        interpreterArgs: interpreter.args,
      }),
    );
    return {
      ready: true,
      path,
      sealedPath,
      mode: protectedOriginal ? "protected_original" : "snapshot",
      launchPath: sealedInterpreterPath,
      launchArgsPrefix: [...interpreter.args, sealedPath],
      sourceContentHash,
      contentHash,
      interpreter: {
        path: interpreter.path,
        sealedPath: sealedInterpreterPath,
        contentHash: interpreterHash,
        args: interpreter.args,
        mode: protectedInterpreter ? "protected_original" : "snapshot",
      },
    };
  } catch (cause) {
    return {
      ready: false,
      failureKind: "seal_mismatch",
      reason: `could not seal executable bytes for execution: ${(cause as Error).message}`,
    };
  }
}

async function identityWithVersion(
  identity: ExecutableIdentity,
  check: NonNullable<LocalToolManifest["command"]["versionCheck"]> | undefined,
  executionEnv: NodeJS.ProcessEnv,
  cwd: string,
  execute: (request: ApprovalBoundSubprocessRequest) => Promise<SpawnResult>,
  phase: "command_version_check" | "prerequisite_version_check",
  prerequisite?: string,
): Promise<ExecutableIdentity | UnavailableExecutableIdentity> {
  const version = await inspectVersion(identity, check, executionEnv, cwd, execute, phase, prerequisite);
  if (!version.compatible) {
    return {
      ready: false,
      failureKind: "incompatible",
      reason: version.reason ?? "incompatible executable version",
    };
  }
  return {
    ...identity,
    ...(version.version ? { version: version.version } : {}),
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
  executable?: {
    path: string;
    sealedPath: string;
    mode: ExecutableIdentity["mode"];
    launchPath: string;
    launchArgsPrefix: string[];
    sourceContentHash: string;
    contentHash: string;
    version?: string;
    versionCheckDeferred?: boolean;
    interpreter?: ExecutableIdentity["interpreter"];
  };
  prerequisites: Array<{
    name: string;
    ready: boolean;
    path?: string;
    sealedPath?: string;
    mode?: ExecutableIdentity["mode"];
    launchPath?: string;
    launchArgsPrefix?: string[];
    sourceContentHash?: string;
    contentHash?: string;
    version?: string;
    versionCheckDeferred?: boolean;
    interpreter?: ExecutableIdentity["interpreter"];
    probeDeferred?: boolean;
    reason?: string;
    installHint?: string;
  }>;
  argv?: string[];
  argvHash?: string;
  prerequisiteHashes?: Record<string, string>;
  prerequisitePath?: string;
  resolvedCwd?: string;
  cwdHash?: string;
  reason?: string;
  approvalSummary: {
    asset: string;
    source: ToolProvenance;
    command: { executable: string; snapshotMode?: "standalone"; argsTemplate: string[]; argv?: string[] };
    capability: "command";
    authentication: {
      mode: "inherited" | "aart_secrets";
      description: string;
      inheritedEnvironment: "all" | string[];
      secretRefs: string[];
      secretMappings: Array<{ ref: string; env: string }>;
    };
    effects: LocalToolManifest["effects"];
    cwd: LocalToolManifest["cwd"];
    output: LocalToolManifest["output"];
    subprocesses: Array<{
      phase: "command_version_check" | "prerequisite_version_check" | "prerequisite_probe" | "task";
      prerequisite?: string;
      executable: string;
      argv: string[];
      cwd: string;
      authentication: {
        mode: "inherited" | "aart_secrets";
        inheritedEnvironment: "all" | string[];
        secretMappings: Array<{ ref: string; env: string }>;
      };
      effects: LocalToolManifest["effects"];
    }>;
  };
}

interface ApprovalBoundSubprocessRequest {
  phase: "command_version_check" | "prerequisite_version_check" | "prerequisite_probe";
  prerequisite?: string;
  executable: ExecutableIdentity;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
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
  resolved?: {
    command: ExecutableIdentity;
    cwd: string;
    prerequisites: ReadonlyArray<{
      manifest: LocalToolManifest["prerequisites"][number];
      identity: ExecutableIdentity;
    }>;
  },
): ToolCheckResult["approvalSummary"] {
  const manifest = record.manifest;
  const secretMappings = manifest.authentication.mode === "aart_secrets" ? manifest.authentication.secrets : [];
  const subprocessAuthority = {
    mode: manifest.authentication.mode,
    inheritedEnvironment: manifest.authentication.inheritEnvironment,
    secretMappings,
  };
  const subprocesses: ToolCheckResult["approvalSummary"]["subprocesses"] = [];
  if (resolved) {
    if (manifest.command.versionCheck) {
      subprocesses.push({
        phase: "command_version_check",
        executable: resolved.command.launchPath,
        argv: [...resolved.command.launchArgsPrefix, ...manifest.command.versionCheck.args],
        cwd: resolved.cwd,
        authentication: subprocessAuthority,
        effects: manifest.effects,
      });
    }
    for (const { manifest: prerequisite, identity } of resolved.prerequisites) {
      if (prerequisite.versionCheck) {
        subprocesses.push({
          phase: "prerequisite_version_check",
          prerequisite: prerequisite.name,
          executable: identity.launchPath,
          argv: [...identity.launchArgsPrefix, ...prerequisite.versionCheck.args],
          cwd: resolved.cwd,
          authentication: subprocessAuthority,
          effects: manifest.effects,
        });
      }
      if (prerequisite.probe) {
        subprocesses.push({
          phase: "prerequisite_probe",
          prerequisite: prerequisite.name,
          executable: identity.launchPath,
          argv: [...identity.launchArgsPrefix, ...prerequisite.probe.args],
          cwd: resolved.cwd,
          authentication: subprocessAuthority,
          effects: manifest.effects,
        });
      }
    }
    if (argv) {
      subprocesses.push({
        phase: "task",
        executable: resolved.command.launchPath,
        argv: [...resolved.command.launchArgsPrefix, ...argv],
        cwd: resolved.cwd,
        authentication: subprocessAuthority,
        effects: manifest.effects,
      });
    }
  }
  return {
    asset: `${manifest.id}@${manifest.version}`,
    source: record.provenance,
    command: {
      executable: manifest.command.executable,
      ...(manifest.command.snapshotMode ? { snapshotMode: manifest.command.snapshotMode } : {}),
      argsTemplate: manifest.command.args,
      ...(argv ? { argv } : {}),
    },
    capability: "command",
    authentication: {
      mode: manifest.authentication.mode,
      description: manifest.authentication.description,
      inheritedEnvironment: manifest.authentication.inheritEnvironment,
      secretRefs: secretMappings.map((secret) => secret.ref),
      secretMappings,
    },
    effects: manifest.effects,
    cwd: manifest.cwd,
    output: manifest.output,
    subprocesses,
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
    expectedCwdHash?: string;
    approvalBound?: boolean;
    resolveApprovalEnvironment?: () => Promise<NodeJS.ProcessEnv>;
    executeApprovalBoundSubprocess?: (request: ApprovalBoundSubprocessRequest) => Promise<SpawnResult>;
  } = {},
): Promise<ToolCheckResult> {
  const env = options.env ?? process.env;
  const recomputedContentHash = computeRegisteredLocalToolContentHash(record);
  const recomputedToolHash = computeLocalToolHash(record.manifest);
  if (recomputedContentHash !== record.contentHash || recomputedToolHash !== record.toolHash) {
    return {
      status: "seal_mismatch",
      ready: false,
      contentHash: record.contentHash,
      toolHash: record.toolHash,
      prerequisites: [],
      reason:
        recomputedContentHash !== record.contentHash
          ? `stored local tool content hash ${record.contentHash} does not match recomputed hash ${recomputedContentHash}`
          : `stored local tool hash ${record.toolHash} does not match recomputed hash ${recomputedToolHash}`,
      approvalSummary: approvalSummary(record),
    };
  }
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
  const cwdHash = sha256(canonicalize(cwd.path));
  const sealedBase = { ...base, resolvedCwd: cwd.path, cwdHash };
  if (options.expectedCwdHash !== undefined && cwdHash !== options.expectedCwdHash) {
    return {
      ...sealedBase,
      status: "seal_mismatch",
      ready: false,
      reason: `reviewed working-directory hash ${options.expectedCwdHash} does not match resolved hash ${cwdHash}`,
    };
  }

  const mainBytes = await executableBytesIdentity(root, record, record.manifest.command, env, true);
  if (!mainBytes.ready) {
    return {
      ...sealedBase,
      status: options.expectedExecutableHash === undefined ? availabilityStatus(mainBytes) : "seal_mismatch",
      ready: false,
      reason: mainBytes.reason,
    };
  }
  if (
    options.expectedExecutableHash !== undefined &&
    mainBytes.contentHash !== options.expectedExecutableHash
  ) {
    return {
      ...sealedBase,
      status: "seal_mismatch",
      ready: false,
      reason: `reviewed executable hash ${options.expectedExecutableHash} does not match resolved hash ${mainBytes.contentHash}`,
    };
  }

  const prerequisiteBytes: Array<{
    manifest: LocalToolManifest["prerequisites"][number];
    identity: ExecutableIdentity;
  }> = [];
  for (const prerequisite of record.manifest.prerequisites) {
    const expectedPrerequisiteHash = options.expectedPrerequisiteHashes?.[prerequisite.name];
    const identity = await executableBytesIdentity(
      root,
      record,
      {
        executable: prerequisite.executable,
        resolution: prerequisite.resolution,
        versionCheck: prerequisite.versionCheck,
      },
      env,
    );
    if (!identity.ready) {
      base.prerequisites.push({
        name: prerequisite.name,
        ready: false,
        reason: identity.reason,
        installHint: prerequisite.installHint,
      });
      return {
        ...sealedBase,
        executable: mainBytes,
        status: expectedPrerequisiteHash === undefined ? availabilityStatus(identity) : "seal_mismatch",
        ready: false,
        reason: `${prerequisite.name}: ${identity.reason}`,
      };
    }
    if (options.expectedPrerequisiteHashes !== undefined && expectedPrerequisiteHash === undefined) {
      return {
        ...sealedBase,
        executable: mainBytes,
        status: "seal_mismatch",
        ready: false,
        reason: `${prerequisite.name}: no reviewed executable hash was supplied`,
      };
    }
    if (expectedPrerequisiteHash !== undefined && identity.contentHash !== expectedPrerequisiteHash) {
      return {
        ...sealedBase,
        executable: mainBytes,
        status: "seal_mismatch",
        ready: false,
        reason: `${prerequisite.name}: reviewed executable hash ${expectedPrerequisiteHash} does not match resolved hash ${identity.contentHash}`,
      };
    }
    prerequisiteBytes.push({ manifest: prerequisite, identity });
  }

  let prerequisitePath: string;
  try {
    prerequisitePath = await prepareSealedPrerequisitePath(root, prerequisiteBytes);
  } catch (cause) {
    return {
      ...sealedBase,
      executable: mainBytes,
      status: "seal_mismatch",
      ready: false,
      reason: `could not prepare sealed prerequisite PATH: ${(cause as Error).message}`,
    };
  }

  const reviewableBase = {
    ...sealedBase,
    approvalSummary: approvalSummary(record, argv, {
      command: mainBytes,
      cwd: cwd.path,
      prerequisites: prerequisiteBytes,
    }),
  };

  let executionEnv: NodeJS.ProcessEnv | undefined;
  if (options.approvalBound === true) {
    if (!options.resolveApprovalEnvironment || !options.executeApprovalBoundSubprocess) {
      return {
        ...reviewableBase,
        executable: mainBytes,
        prerequisitePath,
        status: "invalid_input",
        ready: false,
        reason: "approval-bound checks require one durable subprocess lifecycle and one stable execution environment",
      };
    }
    try {
      executionEnv = await options.resolveApprovalEnvironment();
    } catch (cause) {
      return {
        ...reviewableBase,
        executable: mainBytes,
        prerequisitePath,
        status: "missing_prerequisite",
        ready: false,
        reason: (cause as Error).message,
      };
    }
    executionEnv.PATH = prerequisitePath;
  }

  let main: ExecutableIdentity = mainBytes;
  if (options.approvalBound === true) {
    const versionedMain = await identityWithVersion(
      mainBytes,
      record.manifest.command.versionCheck,
      executionEnv!,
      cwd.path,
      options.executeApprovalBoundSubprocess!,
      "command_version_check",
    );
    const sealFailure = await verifySealedExecutionArtifacts(mainBytes, prerequisiteBytes, prerequisitePath);
    if (sealFailure) {
      return {
        ...reviewableBase,
        executable: mainBytes,
        prerequisitePath,
        status: "seal_mismatch",
        ready: false,
        reason: sealFailure,
      };
    }
    if (!versionedMain.ready) {
      return {
        ...reviewableBase,
        prerequisitePath,
        status: availabilityStatus(versionedMain),
        ready: false,
        reason: versionedMain.reason,
      };
    }
    main = versionedMain;
  }
  const mainResult = {
    ...main,
    ...(options.approvalBound !== true && record.manifest.command.versionCheck
      ? { versionCheckDeferred: true as const }
      : {}),
  };

  for (const { manifest: prerequisite, identity: prerequisiteIdentity } of prerequisiteBytes) {
    let identity: ExecutableIdentity = prerequisiteIdentity;
    if (options.approvalBound === true) {
      const versionedIdentity = await identityWithVersion(
        prerequisiteIdentity,
        prerequisite.versionCheck,
        executionEnv!,
        cwd.path,
        options.executeApprovalBoundSubprocess!,
        "prerequisite_version_check",
        prerequisite.name,
      );
      const sealFailure = await verifySealedExecutionArtifacts(mainBytes, prerequisiteBytes, prerequisitePath);
      if (sealFailure) {
        return {
          ...reviewableBase,
          executable: mainResult,
          prerequisitePath,
          status: "seal_mismatch",
          ready: false,
          reason: sealFailure,
        };
      }
      if (!versionedIdentity.ready) {
        base.prerequisites.push({
          name: prerequisite.name,
          ready: false,
          reason: versionedIdentity.reason,
          installHint: prerequisite.installHint,
        });
        return {
          ...reviewableBase,
          executable: mainResult,
          prerequisitePath,
          status: availabilityStatus(versionedIdentity),
          ready: false,
          reason: `${prerequisite.name}: ${versionedIdentity.reason}`,
        };
      }
      identity = versionedIdentity;
    }
    if (prerequisite.probe && options.approvalBound === true) {
      const beforeProbe = await executableBytesIdentity(root, record, prerequisite, env);
      if (!beforeProbe.ready || beforeProbe.contentHash !== identity.contentHash) {
        return {
          ...reviewableBase,
          executable: mainResult,
          prerequisitePath,
          status: "seal_mismatch",
          ready: false,
          reason: `${prerequisite.name}: prerequisite executable changed before its probe`,
        };
      }
      const probe = await options.executeApprovalBoundSubprocess!({
        phase: "prerequisite_probe",
        prerequisite: prerequisite.name,
        executable: identity,
        args: prerequisite.probe.args,
        env: executionEnv!,
        cwd: cwd.path,
        timeoutMs: 10_000,
      });
      const sealFailure = await verifySealedExecutionArtifacts(mainBytes, prerequisiteBytes, prerequisitePath);
      if (sealFailure) {
        return {
          ...reviewableBase,
          executable: mainResult,
          prerequisitePath,
          status: "seal_mismatch",
          ready: false,
          reason: sealFailure,
        };
      }
      if (probe.exitCode !== prerequisite.probe.expectedExitCode || probe.timedOut || probe.outputLimitExceeded) {
        base.prerequisites.push({
          name: prerequisite.name,
          ready: false,
          path: identity.path,
          sealedPath: identity.sealedPath,
          mode: identity.mode,
          launchPath: identity.launchPath,
          launchArgsPrefix: identity.launchArgsPrefix,
          sourceContentHash: identity.sourceContentHash,
          contentHash: identity.contentHash,
          version: identity.version,
          interpreter: identity.interpreter,
          reason: probe.outputLimitExceeded
            ? `probe exceeded the ${MAX_CAPTURE_BYTES}-byte output limit`
            : `probe failed with exit ${String(probe.exitCode)}`,
          installHint: prerequisite.installHint,
        });
        return {
          ...reviewableBase,
          executable: mainResult,
          prerequisitePath,
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
      sealedPath: identity.sealedPath,
      mode: identity.mode,
      launchPath: identity.launchPath,
      launchArgsPrefix: identity.launchArgsPrefix,
      sourceContentHash: identity.sourceContentHash,
      contentHash: identity.contentHash,
      version: identity.version,
      versionCheckDeferred: options.approvalBound !== true && prerequisite.versionCheck !== undefined,
      interpreter: identity.interpreter,
      probeDeferred: prerequisite.probe !== undefined && options.approvalBound !== true,
    });
  }

  if (options.approvalBound === true) {
    const sealFailure = await verifySealedExecutionArtifacts(mainBytes, prerequisiteBytes, prerequisitePath);
    if (sealFailure) {
      return {
        ...reviewableBase,
        executable: mainResult,
        prerequisitePath,
        status: "seal_mismatch",
        ready: false,
        reason: sealFailure,
      };
    }
  }

  return {
    ...reviewableBase,
    executable: mainResult,
    prerequisiteHashes: Object.fromEntries(
      base.prerequisites.map((prerequisite) => [prerequisite.name, prerequisite.contentHash!]),
    ),
    prerequisitePath,
    status: "ready",
    ready: true,
  };
}

function selectEnvironment(
  root: string,
  manifest: LocalToolManifest,
  hostEnv: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; secrets: string[] }> {
  return (async () => {
    const inherited = manifest.authentication.inheritEnvironment;
    const env: NodeJS.ProcessEnv =
      inherited === "all"
        ? { ...hostEnv }
        : Object.fromEntries(inherited.flatMap((name) => (hostEnv[name] === undefined ? [] : [[name, hostEnv[name]]])));
    const secretValues: string[] = [];
    if (manifest.authentication.mode === "aart_secrets") {
      const target = env;
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

function toolCwd(record: RegisteredLocalTool): string {
  const cwd = record.manifest.cwd;
  if (cwd.mode === "inherit") return process.cwd();
  if (cwd.mode === "fixed") return cwd.path;
  if (record.provenance.kind === "inline") throw new Error("cwd mode asset requires file or Pack provenance");
  return record.provenance.kind === "local_file" ? dirname(record.provenance.source) : record.provenance.source;
}

async function availableToolCwd(
  record: RegisteredLocalTool,
): Promise<{ ready: true; path: string } | { ready: false; reason: string }> {
  let path: string;
  try {
    path = toolCwd(record);
  } catch (cause) {
    return { ready: false, reason: (cause as Error).message };
  }
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
  if (
    (typeof value === "number" || typeof value === "boolean" || value === null) &&
    literals.includes(String(value))
  ) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, literals));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        redactText(key, literals),
        redactStructured(item, literals),
      ]),
    );
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
  cwdHash: string;
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
  cwdHash: string;
  prerequisiteHashes: Record<string, string>;
  startedAt: string;
  endedAt?: string;
  status: "running" | "terminal";
  ownerProcess?: {
    pid: number;
    startIdentity?: string;
  };
  activeProcess?: {
    phase: "command_version_check" | "prerequisite_version_check" | "prerequisite_probe" | "task";
    prerequisite?: string;
    pid: number;
    executableHash: string;
    startIdentity?: string;
  };
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
  cwdHash: string,
  prerequisiteHashes: Readonly<Record<string, string>>,
  runId: string,
  startedAt: string,
  activeProcess: NonNullable<LocalToolRunRecord["activeProcess"]>,
  result: Record<string, unknown> & { ok: boolean; ran: true },
): LocalToolRunRecord {
  const durable: LocalToolRunRecord = {
    runId,
    toolId: record.manifest.id,
    toolVersion: record.manifest.version,
    contentHash: record.contentHash,
    executableHash,
    argvHash,
    cwdHash,
    prerequisiteHashes: { ...prerequisiteHashes },
    startedAt,
    status: "running",
    ownerProcess: {
      pid: process.pid,
    },
    activeProcess,
    result,
  };
  writeOnceSync(localToolRunPath(root, runId), `${JSON.stringify(durable, null, 2)}\n`, 0o600);
  return durable;
}

function advanceLocalToolRun(
  root: string,
  running: LocalToolRunRecord,
  activeProcess: LocalToolRunRecord["activeProcess"],
  result: Record<string, unknown> & { ok: boolean; ran: true },
): LocalToolRunRecord {
  const durable: LocalToolRunRecord = {
    ...running,
    result,
  };
  if (activeProcess) durable.activeProcess = activeProcess;
  else delete durable.activeProcess;
  replaceFileSync(localToolRunPath(root, running.runId), `${JSON.stringify(durable, null, 2)}\n`, 0o600);
  return durable;
}

function enrichLocalToolRunProcessIdentities(
  root: string,
  runId: string,
  activeProcess: NonNullable<LocalToolRunRecord["activeProcess"]>,
  ownerStartIdentity: string | undefined,
  activeStartIdentity: string | undefined,
): LocalToolRunRecord | undefined {
  const path = localToolRunPath(root, runId);
  let current: LocalToolRunRecord;
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as LocalToolRunRecord;
  } catch {
    return undefined;
  }
  if (current.runId !== runId || current.status !== "running") return undefined;

  let changed = false;
  const durable: LocalToolRunRecord = { ...current };
  if (ownerStartIdentity && current.ownerProcess?.pid === process.pid && !current.ownerProcess.startIdentity) {
    durable.ownerProcess = { ...current.ownerProcess, startIdentity: ownerStartIdentity };
    changed = true;
  }
  if (
    activeStartIdentity &&
    current.activeProcess?.pid === activeProcess.pid &&
    current.activeProcess.phase === activeProcess.phase &&
    current.activeProcess.prerequisite === activeProcess.prerequisite &&
    !current.activeProcess.startIdentity
  ) {
    durable.activeProcess = { ...current.activeProcess, startIdentity: activeStartIdentity };
    changed = true;
  }
  if (!changed) return current;
  replaceFileSync(path, `${JSON.stringify(durable, null, 2)}\n`, 0o600);
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
  delete durable.activeProcess;
  await replaceFile(localToolRunPath(root, running.runId), `${JSON.stringify(durable, null, 2)}\n`, 0o600);
  return { ...result, runId: running.runId, evidenceStored: true };
}

export async function readLocalToolRun(root: string, runId: string): Promise<LocalToolRunRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(localToolRunPath(root, runId), "utf8")) as LocalToolRunRecord;
    const activeProcess = parsed.activeProcess;
    if (
      parsed.runId !== runId ||
      parsed.result?.ran !== true ||
      typeof parsed.toolId !== "string" ||
      typeof parsed.toolVersion !== "string" ||
      !["running", "terminal"].includes(parsed.status) ||
      typeof parsed.argvHash !== "string" ||
      typeof parsed.cwdHash !== "string" ||
      !parsed.prerequisiteHashes ||
      typeof parsed.prerequisiteHashes !== "object" ||
      (parsed.ownerProcess !== undefined &&
        (!Number.isInteger(parsed.ownerProcess.pid) ||
          parsed.ownerProcess.pid <= 0 ||
          (parsed.ownerProcess.startIdentity !== undefined && parsed.ownerProcess.startIdentity.length === 0))) ||
      (activeProcess !== undefined &&
        (![
          "command_version_check",
          "prerequisite_version_check",
          "prerequisite_probe",
          "task",
        ].includes(activeProcess.phase) ||
          !Number.isInteger(activeProcess.pid) ||
          activeProcess.pid <= 0 ||
          !/^sha256:[a-f0-9]{64}$/.test(activeProcess.executableHash) ||
          (activeProcess.startIdentity !== undefined && activeProcess.startIdentity.length === 0))) ||
      (parsed.status === "terminal" && activeProcess !== undefined)
    ) {
      throw new Error(`local tool run record "${runId}" failed validation`);
    }
    const ownerlessLegacyRun =
      parsed.status === "running" && parsed.ownerProcess === undefined && activeProcess === undefined;
    const ownerNoLongerMatches =
      parsed.status === "running" &&
      parsed.ownerProcess !== undefined &&
      !(await processMatchesIdentity(parsed.ownerProcess.pid, parsed.ownerProcess.startIdentity));
    const activeNoLongerMatches =
      ownerNoLongerMatches &&
      (activeProcess === undefined || !(await processMatchesIdentity(activeProcess.pid, activeProcess.startIdentity)));
    if (
      parsed.status === "running" &&
      (ownerlessLegacyRun ||
        (parsed.ownerProcess !== undefined && ownerNoLongerMatches && activeNoLongerMatches))
    ) {
      const previousEvidence =
        parsed.result.evidence && typeof parsed.result.evidence === "object" && !Array.isArray(parsed.result.evidence)
          ? (parsed.result.evidence as Record<string, unknown>)
          : {};
      const durable: LocalToolRunRecord = {
        ...parsed,
        endedAt: new Date().toISOString(),
        status: "terminal",
        result: {
          ok: false,
          ran: true,
          kind: "caller_interrupted",
          error: ownerlessLegacyRun
            ? "legacy running evidence has no durable caller or subprocess ownership identity"
            : "the approval-bound caller and its active subprocess are no longer running",
          evidence: {
            ...previousEvidence,
            ...(activeProcess ? { phase: activeProcess.phase } : {}),
            callerInterrupted: true,
            ...(ownerlessLegacyRun ? { legacyOwnerMissing: true } : {}),
          },
        },
      };
      delete durable.activeProcess;
      await replaceFile(localToolRunPath(root, runId), `${JSON.stringify(durable, null, 2)}\n`, 0o600);
      return durable;
    }
    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function processMatchesIdentity(pid: number, expected: string | undefined): Promise<boolean> {
  if (!processIsAlive(pid)) return false;
  if (expected === undefined) return true;
  const current = await processStartIdentity(pid);
  return current === undefined || current === expected;
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "linux") {
      const stat = (await fs.readFile(`/proc/${pid}/stat`, "utf8")).trim();
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const fields = stat.slice(commandEnd + 2).split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks) return undefined;
      const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      return `linux:${bootId}:${startTicks}`;
    }
    if (process.platform === "win32") {
      const result = await spawnNoShell(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { timeoutMs: 2_000 },
      );
      const ticks = result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : "";
      return ticks ? `win32:${ticks}` : undefined;
    }
    const result = await spawnNoShell("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
      timeoutMs: 2_000,
    });
    const started = result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : "";
    return started ? `${process.platform}:${started}` : undefined;
  } catch {
    return undefined;
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
  const startedAt = new Date().toISOString();
  const runId = `toolrun_${randomUUID()}`;
  const prerequisiteHashes = { ...(input.prerequisiteHashes ?? {}) };
  const subprocessExecutions: Array<{
    phase: "command_version_check" | "prerequisite_version_check" | "prerequisite_probe" | "task";
    prerequisite?: string;
    executableHash: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
  }> = [];
  const prerequisiteProbes: Array<{
    name: string;
    executableHash: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
  }> = [];
  const lifecycleEvidence = {
    asset: `${record.manifest.id}@${record.manifest.version}`,
    source: record.provenance,
    contentHash: record.contentHash,
    toolHash: record.toolHash,
    argvHash: input.argvHash,
    cwdHash: input.cwdHash,
    prerequisiteHashes,
  };
  let processStarted = false;
  let running: LocalToolRunRecord | undefined;
  let lastStartedPhase: NonNullable<LocalToolRunRecord["activeProcess"]>["phase"] | undefined;
  let lastStartedPrerequisite: string | undefined;
  let selectedEnvironment: Awaited<ReturnType<typeof selectEnvironment>> | undefined;
  const hostEnv = input.env ?? process.env;
  const resolveApprovalEnvironment = async (): Promise<NodeJS.ProcessEnv> => {
    selectedEnvironment ??= await selectEnvironment(root, record.manifest, hostEnv);
    return selectedEnvironment.env;
  };
  const executeLifecycleSubprocess = async (
    request: {
      phase: "command_version_check" | "prerequisite_version_check" | "prerequisite_probe" | "task";
      prerequisite?: string;
      executable: Pick<ExecutableIdentity, "launchPath" | "launchArgsPrefix" | "contentHash">;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
      timeoutMs?: number;
      cwd?: string;
    },
    evidenceContext: Record<string, unknown> = lifecycleEvidence,
  ): Promise<SpawnResult> => {
    let spawned = false;
    const result = await spawnNoShell(
      request.executable.launchPath,
      [...request.executable.launchArgsPrefix, ...request.args],
      {
        cwd: request.cwd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        onSpawn: (pid) => {
          processStarted = true;
          spawned = true;
          lastStartedPhase = request.phase;
          lastStartedPrerequisite = request.prerequisite;
          const activeProcess: NonNullable<LocalToolRunRecord["activeProcess"]> = {
            phase: request.phase,
            ...(request.prerequisite ? { prerequisite: request.prerequisite } : {}),
            pid,
            executableHash: request.executable.contentHash,
          };
          const runningResult = {
            ok: false as const,
            ran: true as const,
            kind: "running",
            evidence: {
              ...evidenceContext,
              phase: request.phase,
              ...(request.prerequisite ? { prerequisite: request.prerequisite } : {}),
              executableHash: request.executable.contentHash,
              pid,
              subprocessExecutions,
            },
          };
          running = running
            ? advanceLocalToolRun(root, running, activeProcess, runningResult)
            : beginLocalToolRun(
                root,
                record,
                input.executableHash,
                input.argvHash,
                input.cwdHash,
                prerequisiteHashes,
                runId,
                startedAt,
                activeProcess,
                runningResult,
              );
          void Promise.all([CURRENT_PROCESS_START_IDENTITY, processStartIdentity(pid)])
            .then(([ownerStartIdentity, activeStartIdentity]) => {
              const enriched = enrichLocalToolRunProcessIdentities(
                root,
                runId,
                activeProcess,
                ownerStartIdentity,
                activeStartIdentity,
              );
              if (enriched && running?.runId === runId && running.status === "running") running = enriched;
            })
            .catch(() => undefined);
        },
      },
    );
    if (!spawned) {
      throw new Error(`${request.phase} closed without emitting a successful spawn event`);
    }
    const execution = {
      phase: request.phase,
      ...(request.prerequisite ? { prerequisite: request.prerequisite } : {}),
      executableHash: request.executable.contentHash,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
    };
    subprocessExecutions.push(execution);
    if (request.phase === "prerequisite_probe" && request.prerequisite) {
      prerequisiteProbes.push({
        name: request.prerequisite,
        executableHash: request.executable.contentHash,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        outputLimitExceeded: result.outputLimitExceeded,
      });
    }
    if (running) {
      running = advanceLocalToolRun(root, running, undefined, {
        ok: false,
        ran: true,
        kind: "running",
        evidence: {
          ...evidenceContext,
          phase: "between_subprocesses",
          lastCompletedPhase: request.phase,
          ...(request.prerequisite ? { prerequisite: request.prerequisite } : {}),
          subprocessExecutions,
        },
      });
    }
    return result;
  };
  let check: ToolCheckResult;
  try {
    check = await checkLocalTool(root, record, {
      inputs: input.inputs,
      env: input.env,
      requireInputs: true,
      expectedArgvHash: input.argvHash,
      expectedExecutableHash: input.executableHash,
      expectedPrerequisiteHashes: prerequisiteHashes,
      expectedCwdHash: input.cwdHash,
      approvalBound: true,
      resolveApprovalEnvironment,
      executeApprovalBoundSubprocess: executeLifecycleSubprocess,
    });
  } catch (cause) {
    const failure = {
      ok: false as const,
      ran: true as const,
      kind: "execution_monitor_failed",
      error: `approval-bound subprocess lifecycle failed after spawn: ${(cause as Error).message}`,
      evidence: {
        ...lifecycleEvidence,
        phase: lastStartedPhase ?? "preflight",
        ...(lastStartedPrerequisite ? { prerequisite: lastStartedPrerequisite } : {}),
        subprocessExecutions,
        prerequisiteProbes,
      },
    };
    if (running) return completeLocalToolRun(root, running, failure);
    return {
      ...failure,
      ran: processStarted,
      kind: processStarted ? "evidence_persistence_failed" : "spawn_failed",
    };
  }
  const sensitiveInputs = record.manifest.inputs
    .filter((definition) => definition.sensitive)
    .flatMap((definition) => (input.inputs?.[definition.name] ? [input.inputs[definition.name]!] : []));
  const inherited = record.manifest.authentication.inheritEnvironment;
  const inheritedSecretValues = (
    inherited === "all"
      ? Object.entries(hostEnv)
          .filter(([name]) => SECRET_ENV_PATTERN.test(name))
          .map(([, value]) => value)
      : inherited.map((name) => hostEnv[name])
  ).filter((value): value is string => typeof value === "string" && value.length > 0);
  const redactions = [...(selectedEnvironment?.secrets ?? []), ...sensitiveInputs, ...inheritedSecretValues];
  const redactedCheck = redactStructured(check, redactions) as ToolCheckResult;
  if (!check.ready || !check.executable || !check.argv) {
    if (running) {
      return completeLocalToolRun(root, running, {
        ok: false,
        ran: true,
        kind: check.status === "seal_mismatch" ? "review_seal_mismatch" : check.status,
        error: redactedCheck.reason ?? "local tool prerequisites are not ready",
        check: redactedCheck,
        evidence: {
          ...lifecycleEvidence,
          phase: lastStartedPhase ?? "preflight",
          ...(lastStartedPrerequisite ? { prerequisite: lastStartedPrerequisite } : {}),
          subprocessExecutions,
          prerequisiteProbes,
        },
      });
    }
    return {
      ok: false,
      ran: false,
      kind: check.status === "seal_mismatch" ? "review_seal_mismatch" : check.status,
      error: redactedCheck.reason ?? "local tool prerequisites are not ready",
      check: redactedCheck,
    };
  }
  const checkedExecutable = check.executable;

  if (!selectedEnvironment) {
    return {
      ok: false,
      ran: false,
      kind: "missing_prerequisite",
      error: "approval-bound environment was not resolved during the sealed preflight",
    };
  }
  selectedEnvironment.env.PATH = check.prerequisitePath;
  const executionArgv = renderArgs(record.manifest, input.inputs);
  const executionContext = {
    asset: `${record.manifest.id}@${record.manifest.version}`,
    source: record.provenance,
    contentHash: record.contentHash,
    toolHash: record.toolHash,
    executable: redactStructured(checkedExecutable, redactions),
    prerequisites: redactStructured(check.prerequisites, redactions),
    argv: executionArgv.map((arg) => redactText(arg, redactions)),
    argvHash: input.argvHash,
    cwdHash: input.cwdHash,
    prerequisiteHashes,
    prerequisitePath: check.prerequisitePath,
    cwd: check.resolvedCwd,
    authentication: check.approvalSummary.authentication,
    subprocessExecutions,
    prerequisiteProbes,
  };
  let result: SpawnResult;
  try {
    result = await executeLifecycleSubprocess({
      phase: "task",
      executable: checkedExecutable,
      args: executionArgv,
      cwd: check.resolvedCwd,
      env: selectedEnvironment.env,
      timeoutMs: record.manifest.command.timeoutMs,
    }, executionContext);
  } catch (cause) {
    if (running) {
      return completeLocalToolRun(root, running, {
        ok: false,
        ran: true,
        kind: lastStartedPhase === "task" ? "execution_monitor_failed" : "spawn_failed_after_preflight",
        error: lastStartedPhase === "task"
          ? `local tool process started but monitoring failed: ${(cause as Error).message}`
          : `local tool failed to spawn after approval-bound preflight ran: ${(cause as Error).message}`,
        evidence: executionContext,
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
      ran: true,
      kind: "evidence_persistence_failed",
      error: "local tool process started without a recoverable running record",
    };
  }
  const activeRun = running;
  const stdout = redactText(result.stdout, redactions);
  const stderr = redactText(result.stderr, redactions);
  const outputText = record.manifest.output.source === "stdout" ? result.stdout : result.stderr;
  let structuredOutput: unknown;
  let outputParseError: string | undefined;
  try {
    structuredOutput = redactStructured(parseStructuredOutput(record.manifest.output.format, outputText), redactions);
  } catch {
    outputParseError = `${record.manifest.output.source} was not valid ${record.manifest.output.format}`;
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
  const missingEvidence =
    outputParseError === undefined
      ? Object.entries(record.manifest.output.evidence)
          .filter(([name]) => mappedEvidence[name] === undefined)
          .map(([name, path]) => ({ name, path }))
      : [];
  const evidence = {
    ...executionContext,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    stdout,
    stderr,
    mapped: mappedEvidence,
    ...(missingEvidence.length > 0 ? { missingEvidence } : {}),
    ...(outputParseError ? { outputParseError } : {}),
  };
  if (result.outputLimitExceeded || result.exitCode !== 0 || result.timedOut) {
    return completeLocalToolRun(root, activeRun, {
      ok: false,
      ran: true,
      kind: result.outputLimitExceeded ? "output_limit_exceeded" : result.timedOut ? "timed_out" : "command_failed",
      error: result.outputLimitExceeded
        ? `local tool exceeded the ${MAX_CAPTURE_BYTES}-byte output limit`
        : result.timedOut
          ? "local tool timed out"
          : `local tool exited with code ${String(result.exitCode)}`,
      ...(outputParseError === undefined ? { structuredOutput } : {}),
      evidence,
    });
  }
  if (outputParseError !== undefined) {
    return completeLocalToolRun(root, activeRun, {
      ok: false,
      ran: true,
      kind: "invalid_structured_output",
      error: `tool ran but ${outputParseError}`,
      evidence,
    });
  }
  if (missingEvidence.length > 0) {
    return completeLocalToolRun(root, activeRun, {
      ok: false,
      ran: true,
      kind: "evidence_contract_failed",
      error: `tool ran but did not produce declared evidence: ${missingEvidence
        .map(({ name, path }) => `${name} (${path})`)
        .join(", ")}`,
      structuredOutput,
      evidence,
    });
  }
  return completeLocalToolRun(root, activeRun, {
    ok: true,
    ran: true,
    structuredOutput,
    evidence,
  });
}
