import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLocalTool,
  listLocalToolRuns,
  listLocalTools,
  LocalToolManifestError,
  LocalToolVersionConflictError,
  parseLocalToolManifest,
  pathExecutableCandidates,
  readLocalToolRun,
  registerLocalTool,
  runLocalTool,
  searchLocalTools,
  type LocalToolManifest,
} from "./local-tools.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await fs.mkdtemp(join(tmpdir(), "aart-local-tools-"));
  roots.push(created);
  return created;
}

function manifest(overrides: Partial<LocalToolManifest> = {}): LocalToolManifest {
  return parseLocalToolManifest({
    id: "review.wait",
    name: "Wait for review",
    version: "1.0.0",
    description: "Wait for a terminal code review outcome",
    keywords: ["review", "codex"],
    triggers: ["wait for Codex review", "watch this pull request"],
    examples: [{ description: "Wait for one PR review round", inputs: { target: "owner/repo#1" } }],
    inputs: [{ name: "target", description: "Pull request target", required: true, sensitive: false }],
    command: {
      executable: process.execPath,
      resolution: "absolute",
      args: ["-e", "console.log(JSON.stringify({target: process.argv[1]}))", "{{target}}"],
      versionCheck: {
        args: ["--version"],
        semverRange: ">=20",
        match: "v?(\\d+\\.\\d+\\.\\d+)",
      },
    },
    prerequisites: [],
    platforms: [process.platform],
    capabilities: ["command"],
    effects: { reads: ["review metadata"], writes: [], network: ["github.com"] },
    cwd: { mode: "inherit" },
    authentication: {
      mode: "inherited",
      description: "Reuse the current user's authenticated CLI session",
      inheritEnvironment: "all",
    },
    output: { source: "stdout", format: "json", evidence: { target: "$.target" } },
    ...overrides,
  });
}

describe("local tool manifest", () => {
  it("requires explicit command authority and whole-argv placeholders", () => {
    expect(() => parseLocalToolManifest({ ...manifest(), capabilities: [] })).toThrow(LocalToolManifestError);
    expect(() =>
      parseLocalToolManifest({
        ...manifest(),
        command: { ...manifest().command, args: ["--target={{target}}"] },
      }),
    ).toThrow(/whole/);
  });

  it("rejects optional argv placeholders and unsealed asset working directories", () => {
    expect(() =>
      parseLocalToolManifest({
        ...manifest(),
        inputs: [{ name: "target", description: "Optional target", required: false, sensitive: false }],
      }),
    ).toThrow(/optional input.*target.*cannot be an argv placeholder/);
    expect(() => parseLocalToolManifest({ ...manifest(), cwd: { mode: "asset" } })).toThrow(
      /asset working directories are not supported/,
    );
    expect(() =>
      parseLocalToolManifest({
        ...manifest(),
        command: { ...manifest().command, timeoutMs: 2_147_483_648 },
      }),
    ).toThrow(/2147483647/);
  });

  it("keeps an already-suffixed Windows PATH command unchanged before trying PATHEXT variants", () => {
    expect(pathExecutableCandidates("node.exe", "win32", ".EXE;.CMD;.BAT")).toEqual(["node.exe"]);
    expect(pathExecutableCandidates("node", "win32", ".EXE;.CMD")).toEqual(["node", "node.EXE"]);
    expect(pathExecutableCandidates("node.cmd", "win32", ".EXE;.CMD;.BAT")).toEqual([]);
    expect(pathExecutableCandidates("node.bat", "win32", ".EXE;.CMD;.BAT")).toEqual([]);
  });

  it("allows a Pack-portable external prerequisite but rejects ambiguous executable resolution", () => {
    expect(parseLocalToolManifest(manifest()).command.resolution).toBe("absolute");
    expect(() =>
      parseLocalToolManifest({
        ...manifest(),
        command: { ...manifest().command, executable: "../escape", resolution: "asset" },
      }),
    ).toThrow(/safe path/);
  });

  it("validates version-match regexes and cross-platform absolute paths at registration", () => {
    expect(() =>
      parseLocalToolManifest({
        ...manifest(),
        command: {
          ...manifest().command,
          versionCheck: { args: ["--version"], match: "[" },
        },
      }),
    ).toThrow(/valid regular expression/);
    expect(() =>
      parseLocalToolManifest({
        ...manifest(),
        platforms: ["win32"],
        command: {
          executable: "C:\\tools\\review.exe",
          resolution: "absolute",
          args: ["{{target}}"],
        },
      }),
    ).not.toThrow();
  });
});

describe("versioned registration and discovery", () => {
  it("survives a fresh read and matches task wording, not only the id", async () => {
    const storeRoot = await root();
    const source = join(storeRoot, "review-tool.yaml");
    const sourceTool = manifest();
    await fs.writeFile(source, JSON.stringify(sourceTool), "utf8");
    const registered = await registerLocalTool(storeRoot, sourceTool, { sourcePath: source });

    const freshRecords = await listLocalTools(storeRoot);
    expect(freshRecords).toHaveLength(1);
    expect(freshRecords[0]).toEqual(registered);
    expect(searchLocalTools(freshRecords, "wait for Codex review")[0]?.record.manifest.id).toBe("review.wait");
  });

  it("is idempotent for identical bytes and refuses replacement of an immutable version", async () => {
    const storeRoot = await root();
    const first = await registerLocalTool(storeRoot, manifest());
    await expect(registerLocalTool(storeRoot, manifest())).resolves.toEqual(first);
    await expect(
      registerLocalTool(storeRoot, manifest({ description: "Different bytes at the same version" })),
    ).rejects.toThrow(LocalToolVersionConflictError);
  });

  it("rejects asset working directories until their complete contents can be sealed", async () => {
    const storeRoot = await root();
    await expect(
      registerLocalTool(storeRoot, { ...manifest(), cwd: { mode: "asset" } }),
    ).rejects.toThrow(/asset working directories are not supported/);
  });

  it("rejects source provenance that does not contain the supplied manifest contract", async () => {
    const storeRoot = await root();
    const source = join(storeRoot, "review-tool.json");
    await fs.writeFile(source, JSON.stringify(manifest({ description: "Different source contract" })), "utf8");

    await expect(registerLocalTool(storeRoot, manifest(), { sourcePath: source })).rejects.toThrow(
      /does not match the supplied local tool contract/,
    );
  });

  it("copies asset-owned executable bytes inertly and seals the stored copy", async () => {
    const storeRoot = await root();
    const sourceDir = join(storeRoot, "source");
    await fs.mkdir(sourceDir);
    const sourceManifest = join(sourceDir, "tool.yaml");
    const executable = join(sourceDir, "owned-tool");
    const ownedManifest = manifest({
      command: {
        executable: "owned-tool",
        resolution: "asset",
        snapshotMode: "standalone",
        args: [],
        versionCheck: { args: ["--version"] },
      },
      inputs: [],
    });
    await fs.writeFile(sourceManifest, JSON.stringify(ownedManifest), "utf8");
    await fs.writeFile(executable, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n", { mode: 0o755 });
    const registered = await registerLocalTool(
      storeRoot,
      ownedManifest,
      { sourcePath: sourceManifest },
    );
    expect(registered.ownedExecutable?.path).toContain(join("tools", "owned", "review.wait", "1.0.0"));

    await fs.unlink(registered.ownedExecutable!.path);
    await expect(
      registerLocalTool(
        storeRoot,
        ownedManifest,
        { sourcePath: sourceManifest },
      ),
    ).resolves.toEqual(registered);
    await expect(fs.access(registered.ownedExecutable!.path)).resolves.toBeUndefined();

    await fs.writeFile(executable, "#!/bin/sh\nprintf 'changed\\n'\n", { mode: 0o755 });
    const check = await checkLocalTool(storeRoot, registered);
    expect(check.ready).toBe(true);
    expect(check.executable?.sourceContentHash).toBe(registered.ownedExecutable?.contentHash);
    expect(check.executable?.contentHash).not.toBe(registered.ownedExecutable?.contentHash);
    expect(check.executable?.interpreter).toMatchObject({
      contentHash: expect.stringMatching(/^sha256:/),
      mode: process.platform === "darwin" ? "protected_original" : "snapshot",
    });
  });

  it("rejects an asset executable reached through an intermediate symlink outside the manifest directory", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const sourceDir = join(storeRoot, "source");
    const outsideDir = join(storeRoot, "outside");
    await fs.mkdir(sourceDir);
    await fs.mkdir(outsideDir);
    const symlinkManifest = manifest({
      command: { executable: "bin/tool", resolution: "asset", args: [] },
      inputs: [],
    });
    await fs.writeFile(join(sourceDir, "tool.yaml"), JSON.stringify(symlinkManifest), "utf8");
    await fs.writeFile(join(outsideDir, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink(outsideDir, join(sourceDir, "bin"));

    await expect(
      registerLocalTool(
        storeRoot,
        symlinkManifest,
        { sourcePath: join(sourceDir, "tool.yaml") },
      ),
    ).rejects.toThrow(/resolves outside/);
  });

  it("reports copied asset bytes without execute permission as unavailable", async () => {
    const storeRoot = await root();
    const sourceDir = join(storeRoot, "source");
    await fs.mkdir(sourceDir);
    const sourceManifest = join(sourceDir, "tool.yaml");
    const nonExecutableManifest = manifest({
      command: { executable: "owned-tool", resolution: "asset", args: [] },
      inputs: [],
    });
    await fs.writeFile(sourceManifest, JSON.stringify(nonExecutableManifest), "utf8");
    await fs.writeFile(join(sourceDir, "owned-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const registered = await registerLocalTool(
      storeRoot,
      nonExecutableManifest,
      { sourcePath: sourceManifest },
    );

    await expect(checkLocalTool(storeRoot, registered)).resolves.toMatchObject({
      ready: false,
      status: "missing_prerequisite",
      reason: expect.stringContaining("not found or is not executable"),
    });
  });
});

describe("preflight and execution", () => {
  it("resolves sealed identities and exposes every inert subprocess before approval", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "node-runtime",
            executable: basename(process.execPath),
            resolution: "path",
            versionCheck: {
              args: ["--version"],
              semverRange: ">=20",
              match: "v?(\\d+\\.\\d+\\.\\d+)",
            },
            probe: { args: ["-e", "process.exit(0)"], expectedExitCode: 0 },
            installHint: "Install Node.js 20 or newer",
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } });
    expect(check).toMatchObject({
      ready: true,
      status: "ready",
      argv: ["-e", expect.any(String), "owner/repo#1"],
      executable: {
        path: process.execPath,
        contentHash: expect.stringMatching(/^sha256:/),
        versionCheckDeferred: true,
      },
      prerequisites: [{ name: "node-runtime", ready: true, versionCheckDeferred: true, probeDeferred: true }],
      prerequisitePath: expect.stringContaining("prerequisite-paths"),
    });
    expect(check.approvalSummary.authentication.mode).toBe("inherited");
    expect(check.approvalSummary.capability).toBe("command");
    expect(check.approvalSummary.subprocesses).toMatchObject([
      {
        phase: "command_version_check",
        executable: check.executable!.launchPath,
        argv: [...check.executable!.launchArgsPrefix, "--version"],
        authentication: { mode: "inherited", inheritedEnvironment: "all" },
        effects: registered.manifest.effects,
      },
      {
        phase: "prerequisite_version_check",
        prerequisite: "node-runtime",
        executable: check.prerequisites[0]!.launchPath,
        argv: [...check.prerequisites[0]!.launchArgsPrefix!, "--version"],
      },
      {
        phase: "prerequisite_probe",
        prerequisite: "node-runtime",
        executable: check.prerequisites[0]!.launchPath,
        argv: [...check.prerequisites[0]!.launchArgsPrefix!, "-e", "process.exit(0)"],
      },
      {
        phase: "task",
        executable: check.executable!.launchPath,
        argv: [...check.executable!.launchArgsPrefix, "-e", expect.any(String), "owner/repo#1"],
      },
    ]);
  });

  it("shows argv shape without exposing inputs declared sensitive", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        inputs: [{ name: "target", description: "Sensitive target", required: true, sensitive: true }],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "secret-target" } });
    expect(check.argv).toEqual(["-e", expect.any(String), "[REDACTED]"]);
    expect(JSON.stringify(check)).not.toContain("secret-target");
  });

  it("reports a missing fixed working directory during check, before approval or spawn", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({ cwd: { mode: "fixed", path: join(storeRoot, "missing-cwd") } }),
    );
    await expect(
      checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } }),
    ).resolves.toMatchObject({
      ready: false,
      status: "missing_prerequisite",
      reason: expect.stringContaining("does not exist or cannot be entered"),
    });
  });

  it("returns an actionable missing-prerequisite result and never claims the asset ran", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "missing-cli",
            executable: "definitely-not-an-installed-aart-test-command",
            resolution: "path",
            installHint: "Install missing-cli",
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } });
    expect(check).toMatchObject({
      ready: false,
      status: "missing_prerequisite",
      reason: expect.stringContaining("missing-cli"),
      prerequisites: [{ ready: false, installHint: "Install missing-cli" }],
    });
    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: {},
    });
    expect(result).toMatchObject({ ok: false, ran: false, kind: "missing_prerequisite" });
  });

  it("defers an incompatible main version to the approval-bound durable lifecycle", async () => {
    const storeRoot = await root();
    const versionMarker = join(storeRoot, "main-version-ran");
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          ...manifest().command,
          versionCheck: {
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(versionMarker)}, "ran"); console.log(process.version)`,
            ],
            semverRange: ">=999.0.0",
            match: "v?(\\d+\\.\\d+\\.\\d+)",
          },
        },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } });
    expect(check).toMatchObject({
      ready: true,
      status: "ready",
      executable: { versionCheckDeferred: true },
    });
    await expect(fs.access(versionMarker)).rejects.toThrow();
    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "incompatible",
      error: expect.stringContaining("does not satisfy"),
      evidence: {
        phase: "command_version_check",
        subprocessExecutions: [{ phase: "command_version_check", exitCode: 0 }],
      },
    });
    await expect(fs.readFile(versionMarker, "utf8")).resolves.toBe("ran");
    await expect(readLocalToolRun(storeRoot, result.runId as string)).resolves.toMatchObject({
      status: "terminal",
      result: { kind: "incompatible", ran: true },
    });
  });

  it("does not classify a missing executable as incompatible just because its name contains version", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: "version-checker-that-is-not-installed",
          resolution: "path",
          args: ["{{target}}"],
        },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      env: { PATH: "" },
    });
    expect(check).toMatchObject({
      ready: false,
      status: "missing_prerequisite",
      reason: expect.stringContaining("version-checker-that-is-not-installed"),
    });
  });

  it("rejects interpreter entrypoints that do not declare standalone snapshot compatibility", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const packageCli = join(storeRoot, "package-cli");
    await fs.writeFile(packageCli, "#!/usr/bin/env node\nrequire('../lib/runtime.js')\n", { mode: 0o755 });
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: packageCli,
          resolution: "absolute",
          args: [],
        },
        inputs: [],
      }),
    );
    await expect(checkLocalTool(storeRoot, registered)).resolves.toMatchObject({
      ready: false,
      status: "incompatible",
      reason: expect.stringContaining('snapshotMode "standalone"'),
    });
    const declaredWithoutProbe = await registerLocalTool(
      storeRoot,
      manifest({
        version: "2.0.0",
        command: {
          executable: packageCli,
          resolution: "absolute",
          snapshotMode: "standalone",
          args: [],
        },
        inputs: [],
      }),
    );
    await expect(checkLocalTool(storeRoot, declaredWithoutProbe)).resolves.toMatchObject({
      ready: false,
      status: "incompatible",
      reason: expect.stringContaining("must declare a versionCheck"),
    });
  });

  it("binds a mutable shebang interpreter into the reviewed executable seal", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const interpreter = join(storeRoot, "custom-node");
    const executable = join(storeRoot, "interpreted-tool");
    await fs.copyFile(process.execPath, interpreter);
    await fs.chmod(interpreter, 0o755);
    await fs.writeFile(
      executable,
      [
        "#!/usr/bin/env custom-node",
        'if (process.argv[2] === "--version") console.log("tool 1.0.0");',
        'else console.log(JSON.stringify({value:"sealed"}));',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable,
          resolution: "absolute",
          snapshotMode: "standalone",
          args: [],
          versionCheck: { args: ["--version"], semverRange: ">=1", match: "tool (\\d+\\.\\d+\\.\\d+)" },
        },
        inputs: [],
        output: { source: "stdout", format: "json", evidence: { value: "$.value" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { env });
    expect(check).toMatchObject({
      ready: true,
      executable: {
        contentHash: expect.stringMatching(/^sha256:/),
        sourceContentHash: expect.stringMatching(/^sha256:/),
        interpreter: {
          path: await fs.realpath(interpreter),
          sealedPath: expect.stringContaining("execution-snapshots"),
          contentHash: expect.stringMatching(/^sha256:/),
          mode: "snapshot",
        },
      },
    });
    expect(check.executable?.contentHash).not.toBe(check.executable?.sourceContentHash);

    await fs.copyFile("/bin/echo", interpreter);
    await fs.chmod(interpreter, 0o755);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({ ok: false, ran: false, kind: "review_seal_mismatch" });
  });

  it("bounds catastrophic version-match expressions inside the approval-bound lifecycle", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [],
          versionCheck: {
            args: ["-e", "process.stdout.write('a'.repeat(30_000)+'!')"],
            match: "(a+)+$",
          },
        },
        inputs: [],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    expect(check).toMatchObject({ ready: true, executable: { versionCheckDeferred: true } });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ran: true,
      kind: "incompatible",
      error: expect.stringContaining("regex time budget"),
    });
  });

  it("binds task inputs to the reviewed rendered argv hash", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(storeRoot, manifest());
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "reviewed/target#1" } });
    expect(check.ready).toBe(true);

    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target: "different/target#2" },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: false,
      kind: "review_seal_mismatch",
      error: expect.stringContaining("argv hash"),
    });
  });

  it("recomputes a loaded record seal before trusting its stored content hash", async () => {
    const storeRoot = await root();
    const marker = join(storeRoot, "tampered-record-ran");
    const registered = await registerLocalTool(storeRoot, manifest());
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "reviewed/target#1" } });
    const tampered = {
      ...registered,
      manifest: {
        ...registered.manifest,
        command: {
          executable: process.execPath,
          resolution: "absolute" as const,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
        },
        inputs: [],
      },
    };

    const result = await runLocalTool(storeRoot, tampered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: false,
      kind: "review_seal_mismatch",
      error: expect.stringContaining("recomputed hash"),
    });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("binds version-check and probe argv to the reviewed asset seal", async () => {
    const storeRoot = await root();
    const marker = join(storeRoot, "unreviewed-subprocess-ran");
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "node-runtime",
            executable: basename(process.execPath),
            resolution: "path",
            probe: { args: ["-e", "process.exit(0)"], expectedExitCode: 0 },
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } });
    const unreviewedArgs = [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
    ];
    const changedVersionCheck = {
      ...registered,
      manifest: {
        ...registered.manifest,
        command: { ...registered.manifest.command, versionCheck: { args: unreviewedArgs } },
      },
    };
    const changedProbe = {
      ...registered,
      manifest: {
        ...registered.manifest,
        prerequisites: registered.manifest.prerequisites.map((prerequisite) => ({
          ...prerequisite,
          probe: { args: unreviewedArgs, expectedExitCode: 0 },
        })),
      },
    };
    for (const changed of [changedVersionCheck, changedProbe]) {
      await expect(
        runLocalTool(storeRoot, changed, {
          inputs: { target: "owner/repo#1" },
          contentHash: registered.contentHash,
          executableHash: check.executable!.contentHash,
          argvHash: check.argvHash!,
          cwdHash: check.cwdHash!,
          prerequisiteHashes: check.prerequisiteHashes,
        }),
      ).resolves.toMatchObject({ ok: false, ran: false, kind: "review_seal_mismatch" });
    }
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("refuses a changed native prerequisite before executing its version check or probe", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "review-helper");
    await fs.copyFile(process.execPath, prerequisite);
    await fs.chmod(prerequisite, 0o755);
    const env = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "review-helper",
            executable: "review-helper",
            resolution: "path",
            versionCheck: { args: ["--version"], semverRange: ">=20", match: "v?(\\d+\\.\\d+\\.\\d+)" },
            probe: { args: ["--version"], expectedExitCode: 0 },
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" }, env });
    expect(check.ready).toBe(true);
    await fs.copyFile("/bin/echo", prerequisite);
    await fs.chmod(prerequisite, 0o755);

    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({ ok: false, ran: false, kind: "review_seal_mismatch" });
  });

  it("routes task subprocesses through reviewed prerequisite snapshots only", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "review-helper");
    const resultFile = join(storeRoot, "sealed-result.json");
    await fs.copyFile(process.execPath, prerequisite);
    await fs.chmod(prerequisite, 0o755);
    const task = [
      'const fs = require("node:fs");',
      'const {spawnSync} = require("node:child_process");',
      `fs.writeFileSync(${JSON.stringify(prerequisite)}, "changed after approval");`,
      'const child = spawnSync("review-helper", ["-e", "console.log(JSON.stringify({sealed:true}))"], {encoding:"utf8"});',
      'if (child.error || child.status !== 0) throw child.error ?? new Error(child.stderr);',
      `fs.writeFileSync(${JSON.stringify(resultFile)}, child.stdout);`,
      `const output = spawnSync("cat", [${JSON.stringify(resultFile)}], {encoding:"utf8"});`,
      'if (output.error || output.status !== 0) throw output.error ?? new Error(output.stderr);',
      "process.stdout.write(output.stdout);",
    ].join("");
    const env = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: { ...manifest().command, args: ["-e", task] },
        inputs: [],
        prerequisites: [
          {
            name: "review-helper",
            executable: "review-helper",
            resolution: "path",
            versionCheck: {
              args: ["--version"],
              semverRange: ">=20",
              match: "v?(\\d+\\.\\d+\\.\\d+)",
            },
          },
          {
            name: "output-cat",
            executable: "cat",
            resolution: "path",
          },
        ],
        output: { source: "stdout", format: "json", evidence: { sealed: "$.sealed" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });

    expect(result).toMatchObject({
      ok: true,
      ran: true,
      structuredOutput: { sealed: true },
      evidence: {
        prerequisitePath: check.prerequisitePath,
        prerequisiteHashes: check.prerequisiteHashes,
      },
    });
    await expect(fs.readFile(prerequisite, "utf8")).resolves.toBe("changed after approval");
  });

  it("executes the sealed snapshot even when a version check replaces the original executable", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const executable = join(storeRoot, "mutable-tool");
    const replacement = join(storeRoot, "replacement-tool");
    const copyCommand = basename(process.execPath);
    const originalBytes = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  ${copyCommand} -e 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])' "$2" "$3"`,
      "  printf 'tool 1.0.0\\n'",
      "  exit 0",
      "fi",
      "printf '{\"value\":\"reviewed\"}\\n'",
      "",
    ].join("\n");
    const replacementBytes = "#!/bin/sh\nprintf '{\"value\":\"changed\"}\\n'\n";
    await fs.writeFile(executable, originalBytes, { mode: 0o755 });
    await fs.writeFile(replacement, replacementBytes, { mode: 0o755 });
    const canonicalExecutable = await fs.realpath(executable);
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable,
          resolution: "absolute",
          snapshotMode: "standalone",
          args: [],
          versionCheck: {
            args: ["--version", replacement, executable],
            semverRange: ">=1",
            match: "tool (\\d+\\.\\d+\\.\\d+)",
          },
        },
        prerequisites: [
          {
            name: "copy-command",
            executable: copyCommand,
            resolution: "path",
          },
        ],
        inputs: [],
        output: { source: "stdout", format: "json", evidence: { value: "$.value" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    expect(check).toMatchObject({
      ready: true,
      executable: {
        path: canonicalExecutable,
        sealedPath: expect.stringContaining("execution-snapshots"),
      },
    });
    await fs.writeFile(executable, originalBytes, { mode: 0o755 });

    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { value: "reviewed" },
      evidence: {
        executable: {
          path: canonicalExecutable,
          sealedPath: check.executable!.sealedPath,
        },
      },
    });
    await expect(fs.readFile(executable, "utf8")).resolves.toBe(replacementBytes);
  });

  it("rejects a working directory that resolves differently from the reviewed cwd seal", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const firstCwd = join(storeRoot, "cwd-a");
    const secondCwd = join(storeRoot, "cwd-b");
    const cwdLink = join(storeRoot, "current-cwd");
    await fs.mkdir(firstCwd);
    await fs.mkdir(secondCwd);
    await fs.symlink(firstCwd, cwdLink);
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "console.log(JSON.stringify({cwd:process.cwd()}))"],
        },
        inputs: [],
        cwd: { mode: "fixed", path: cwdLink },
        output: { source: "stdout", format: "json", evidence: { cwd: "$.cwd" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    expect(check.resolvedCwd).toBe(await fs.realpath(firstCwd));
    await fs.unlink(cwdLink);
    await fs.symlink(secondCwd, cwdLink);

    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: false,
      kind: "review_seal_mismatch",
      error: expect.stringContaining("working-directory hash"),
    });
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "const b=Buffer.from(JSON.stringify({value:'€'})); const i=b.indexOf(Buffer.from('€')); process.stdout.write(b.subarray(0,i+1)); setTimeout(()=>process.stdout.end(b.subarray(i+1)),20)",
          ],
        },
        inputs: [],
        output: { source: "stdout", format: "json", evidence: { value: "$.value" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { value: "€" },
      evidence: { mapped: { value: "€" } },
    });
  });

  it("advances recovery evidence from a completed probe to the active main process", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "setTimeout(()=>console.log(JSON.stringify({done:true})),750)"],
        },
        inputs: [],
        prerequisites: [
          {
            name: "phase-probe",
            executable: basename(process.execPath),
            resolution: "path",
            probe: { args: ["-e", "process.exit(0)"], expectedExitCode: 0 },
          },
        ],
        output: { source: "stdout", format: "json", evidence: { done: "$.done" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const completion = runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });

    await expect
      .poll(async () => (await listLocalToolRuns(storeRoot, { status: "running" }))[0], { timeout: 4_000 })
      .toMatchObject({
        toolId: "review.wait",
        status: "running",
        argvHash: check.argvHash,
        cwdHash: check.cwdHash,
        activeProcess: {
          phase: "task",
          pid: expect.any(Number),
          executableHash: check.executable!.contentHash,
        },
        result: {
          ran: true,
          kind: "running",
          evidence: { phase: "task", pid: expect.any(Number) },
        },
      });
    const result = await completion;
    const records = await listLocalToolRuns(storeRoot);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: result.runId,
      status: "terminal",
      argvHash: check.argvHash,
      cwdHash: check.cwdHash,
      prerequisiteHashes: check.prerequisiteHashes,
      result: {
        ok: true,
        ran: true,
        structuredOutput: { done: true },
        evidence: {
          subprocessExecutions: [
            { phase: "prerequisite_probe", prerequisite: "phase-probe", exitCode: 0 },
            { phase: "task", exitCode: 0 },
          ],
        },
      },
    });
  });

  it("repairs an interrupted running record once both caller and subprocess are gone", async () => {
    const storeRoot = await root();
    const runId = "toolrun_00000000-0000-4000-8000-000000000013";
    const hash = `sha256:${"0".repeat(64)}`;
    let deadPid: number | undefined;
    for (let candidate = 999_999; candidate > 999_900; candidate -= 1) {
      try {
        process.kill(candidate, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
          deadPid = candidate;
          break;
        }
      }
    }
    expect(deadPid).toBeDefined();
    const runPath = join(storeRoot, "tools", "runs", `${runId}.json`);
    await fs.mkdir(join(storeRoot, "tools", "runs"), { recursive: true });
    await fs.writeFile(
      runPath,
      JSON.stringify({
        runId,
        toolId: "review.wait",
        toolVersion: "1.0.0",
        contentHash: hash,
        executableHash: hash,
        argvHash: hash,
        cwdHash: hash,
        prerequisiteHashes: {},
        startedAt: new Date(0).toISOString(),
        status: "running",
        ownerPid: deadPid,
        activeProcess: { phase: "task", pid: deadPid, executableHash: hash },
        result: { ok: false, ran: true, kind: "running", evidence: { phase: "task", pid: deadPid } },
      }),
    );

    await expect(readLocalToolRun(storeRoot, runId)).resolves.toMatchObject({
      status: "terminal",
      endedAt: expect.any(String),
      result: {
        ok: false,
        ran: true,
        kind: "caller_interrupted",
        evidence: { phase: "task", callerInterrupted: true },
      },
    });
    const persisted = JSON.parse(await fs.readFile(runPath, "utf8")) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("activeProcess");
  });

  it("kills the subprocess group on timeout and keeps timed_out primary when output is invalid", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const marker = join(storeRoot, "grandchild-survived");
    const childScript = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),300)`;
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'}); process.stdout.write('{'); setInterval(()=>{},1000)`,
          ],
          timeoutMs: 60,
        },
        inputs: [],
        output: { source: "stdout", format: "json", evidence: {} },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "timed_out",
      evidence: { timedOut: true, outputParseError: expect.any(String) },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("keeps command_failed primary when nonzero output is not valid structured data", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "process.stdout.write('not-json'); process.exit(3)"],
        },
        inputs: [],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "command_failed",
      evidence: { exitCode: 3, outputParseError: expect.any(String) },
    });
  });

  it("closes stdin so non-interactive commands waiting for EOF can finish", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({eof:true})))",
          ],
          timeoutMs: 1_000,
        },
        inputs: [],
        output: { source: "stdout", format: "json", evidence: { eof: "$.eof" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { eof: true },
      evidence: { mapped: { eof: true } },
    });
  });

  it("bounds captured output and reports the limit as the primary terminal failure", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "process.stdout.write('x'.repeat(2_000_000))"],
        },
        inputs: [],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "output_limit_exceeded",
      evidence: {
        outputLimitExceeded: true,
        outputParseError: expect.any(String),
      },
    });
    expect(Buffer.byteLength((result.evidence as { stdout: string }).stdout, "utf8")).toBeLessThanOrEqual(1_048_576);
  });

  it("defers credentialed prerequisite probes until the approval-bound run", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "credential-probe");
    const marker = join(storeRoot, "credential-probe-ran");
    await fs.copyFile(process.execPath, prerequisite);
    await fs.chmod(prerequisite, 0o755);
    const envWithoutSecret = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "credential-probe",
            executable: "credential-probe",
            resolution: "path",
            probe: {
              args: [
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env.LOCAL_TOOL_TOKEN ? "credential-present" : "missing"); process.exit(process.env.LOCAL_TOOL_TOKEN ? 0 : 1)`,
              ],
              expectedExitCode: 0,
            },
          },
        ],
        authentication: {
          mode: "aart_secrets",
          description: "Resolve credentials only after the reviewed seals are supplied",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      env: envWithoutSecret,
    });
    expect(check).toMatchObject({
      ready: true,
      prerequisites: [{ name: "credential-probe", ready: true, probeDeferred: true }],
    });
    await expect(fs.access(marker)).rejects.toThrow();

    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env: { ...envWithoutSecret, AART_SECRET_TOOL_TOKEN: "approval-bound-secret" },
    });
    expect(result).toMatchObject({ ok: true, ran: true });
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("credential-present");
  });

  it("selects credentials once for probe and task even when the secret source disappears", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "remove-secret-source");
    const secretsPath = join(storeRoot, "secrets.json");
    await fs.copyFile(process.execPath, prerequisite);
    await fs.chmod(prerequisite, 0o755);
    await fs.writeFile(secretsPath, JSON.stringify({ TOOL_TOKEN: "stable-lifecycle-secret" }));
    const env = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "console.log(JSON.stringify({credential:process.env.LOCAL_TOOL_TOKEN}))"],
        },
        inputs: [],
        prerequisites: [
          {
            name: "remove-secret-source",
            executable: "remove-secret-source",
            resolution: "path",
            probe: {
              args: ["-e", `require("node:fs").unlinkSync(${JSON.stringify(secretsPath)})`],
              expectedExitCode: 0,
            },
          },
        ],
        authentication: {
          mode: "aart_secrets",
          description: "Use one stable credential selection for the approved lifecycle",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        output: { source: "stdout", format: "json", evidence: { credential: "$.credential" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { env });
    await expect(fs.access(secretsPath)).resolves.toBeUndefined();

    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: true,
      ran: true,
      structuredOutput: { credential: "[REDACTED]" },
      evidence: {
        subprocessExecutions: [
          { phase: "prerequisite_probe", prerequisite: "remove-secret-source", exitCode: 0 },
          { phase: "task", exitCode: 0 },
        ],
      },
    });
    await expect(fs.access(secretsPath)).rejects.toThrow();
  });

  it("records a failed approval-bound prerequisite probe as a real execution", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "failing-probe");
    const probeMarker = join(storeRoot, "probe-ran");
    const commandMarker = join(storeRoot, "command-ran");
    await fs.copyFile(process.execPath, prerequisite);
    await fs.chmod(prerequisite, 0o755);
    const env = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(commandMarker)}, "ran"); console.log(JSON.stringify({outcome:"approved"}))`,
          ],
        },
        inputs: [],
        prerequisites: [
          {
            name: "failing-probe",
            executable: "failing-probe",
            resolution: "path",
            probe: {
              args: [
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(probeMarker)}, "ran"); process.exit(7)`,
              ],
              expectedExitCode: 0,
            },
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { env });
    expect(check).toMatchObject({
      ready: true,
      prerequisites: [{ name: "failing-probe", ready: true, probeDeferred: true }],
    });

    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "missing_prerequisite",
      runId: expect.stringMatching(/^toolrun_/),
      evidenceStored: true,
      evidence: {
        phase: "prerequisite_probe",
        prerequisiteProbes: [
          {
            name: "failing-probe",
            exitCode: 7,
            timedOut: false,
            outputLimitExceeded: false,
          },
        ],
      },
    });
    await expect(fs.readFile(probeMarker, "utf8")).resolves.toBe("ran");
    await expect(fs.access(commandMarker)).rejects.toThrow();
    await expect(readLocalToolRun(storeRoot, result.runId as string)).resolves.toMatchObject({
      status: "terminal",
      result: { ok: false, ran: true, kind: "missing_prerequisite" },
    });
  });

  it("records a failed prerequisite version check and never runs its probe or task", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "bad-version");
    const versionMarker = join(storeRoot, "version-ran");
    const probeMarker = join(storeRoot, "probe-must-not-run");
    const taskMarker = join(storeRoot, "task-must-not-run");
    await fs.copyFile(process.execPath, prerequisite);
    await fs.chmod(prerequisite, 0o755);
    const env = { ...process.env, PATH: `${storeRoot}${delimiter}${process.env.PATH ?? ""}` };
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(taskMarker)}, "ran")`],
        },
        inputs: [],
        prerequisites: [
          {
            name: "bad-version",
            executable: "bad-version",
            resolution: "path",
            versionCheck: {
              args: [
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(versionMarker)}, "ran"); process.exit(6)`,
              ],
            },
            probe: {
              args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(probeMarker)}, "ran")`],
              expectedExitCode: 0,
            },
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { env });
    expect(check).toMatchObject({
      ready: true,
      prerequisites: [{ name: "bad-version", versionCheckDeferred: true, probeDeferred: true }],
    });
    await expect(fs.access(versionMarker)).rejects.toThrow();

    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "incompatible",
      runId: expect.stringMatching(/^toolrun_/),
      evidence: {
        phase: "prerequisite_version_check",
        prerequisite: "bad-version",
        subprocessExecutions: [
          {
            phase: "prerequisite_version_check",
            prerequisite: "bad-version",
            exitCode: 6,
          },
        ],
      },
    });
    await expect(fs.readFile(versionMarker, "utf8")).resolves.toBe("ran");
    await expect(fs.access(probeMarker)).rejects.toThrow();
    await expect(fs.access(taskMarker)).rejects.toThrow();
    await expect(readLocalToolRun(storeRoot, result.runId as string)).resolves.toMatchObject({
      status: "terminal",
      result: { kind: "incompatible", ran: true },
    });
  });

  it("requires the complete reviewed seal set, runs without a shell, redacts secrets, and maps structured evidence", async () => {
    const storeRoot = await root();
    const sentinel = join(storeRoot, "must-not-exist");
    const target = `owner/repo#1; touch ${sentinel}`;
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "console.log(JSON.stringify({target: process.argv[1], credential: process.env.LOCAL_TOOL_TOKEN}))",
            "{{target}}",
          ],
          versionCheck: {
            args: ["--version"],
            semverRange: ">=20",
            match: "v?(\\d+\\.\\d+\\.\\d+)",
          },
        },
        authentication: {
          mode: "aart_secrets",
          description: "Resolve the credential from AART instead of inheriting user authentication",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        output: {
          source: "stdout",
          format: "json",
          evidence: { target: "$.target", credential: "$.credential" },
        },
      }),
    );
    const secret = 'x"y';
    const env = { ...process.env, AART_SECRET_TOOL_TOKEN: secret };
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target }, env });
    expect(check.ready).toBe(true);
    expect(check.approvalSummary.authentication).toMatchObject({
      mode: "aart_secrets",
      secretRefs: ["TOOL_TOKEN"],
      secretMappings: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
    });

    const wrongSeal = await runLocalTool(storeRoot, registered, {
      inputs: { target },
      contentHash: registered.contentHash,
      executableHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(wrongSeal).toMatchObject({ ok: false, ran: false, kind: "review_seal_mismatch" });

    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: true,
      ran: true,
      runId: expect.stringMatching(/^toolrun_/),
      evidenceStored: true,
      structuredOutput: { target, credential: "[REDACTED]" },
      evidence: {
        executable: { path: process.execPath, contentHash: check.executable!.contentHash },
        authentication: {
          secretMappings: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        argv: ["-e", expect.any(String), target],
        exitCode: 0,
        mapped: { target, credential: "[REDACTED]" },
      },
    });
    const durable = await readLocalToolRun(storeRoot, result.runId as string);
    expect(durable).toMatchObject({
      runId: result.runId,
      toolId: "review.wait",
      status: "terminal",
      argvHash: check.argvHash,
      result: {
        ok: true,
        ran: true,
        structuredOutput: { target, credential: "[REDACTED]" },
      },
    });
    await expect(fs.access(sentinel)).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(durable)).not.toContain(secret);
  });

  it("uses the supplied environment for inherit-all execution and redacts its secret-like values", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "console.log(JSON.stringify({provided:process.env.AART_TEST_SUPPLIED,token:process.env.API_TOKEN}))",
          ],
        },
        inputs: [],
        output: {
          source: "stdout",
          format: "json",
          evidence: { provided: "$.provided", token: "$.token" },
        },
      }),
    );
    const secret = "secret-from-supplied-env";
    const env = {
      PATH: process.env.PATH,
      AART_TEST_SUPPLIED: "from-run-input",
      API_TOKEN: secret,
    };
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });

    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { provided: "from-run-input", token: "[REDACTED]" },
      evidence: { mapped: { provided: "from-run-input", token: "[REDACTED]" } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts every explicitly inherited value even when its name and length are not heuristic matches", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "console.log(JSON.stringify({credential:process.env.CUSTOM_AUTHORITY}))"],
        },
        inputs: [],
        authentication: {
          mode: "inherited",
          description: "Pass one explicitly reviewed credential",
          inheritEnvironment: ["CUSTOM_AUTHORITY"],
        },
        output: { source: "stdout", format: "json", evidence: { credential: "$.credential" } },
      }),
    );
    const secret = "qz";
    const env = { PATH: process.env.PATH, CUSTOM_AUTHORITY: secret };
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { credential: "[REDACTED]" },
      evidence: { mapped: { credential: "[REDACTED]" } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("parses structured output before redacting a secret that is also JSON syntax", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "console.log(JSON.stringify({flag:true,credential:process.env.LOCAL_TOOL_TOKEN}))",
          ],
        },
        inputs: [],
        authentication: {
          mode: "aart_secrets",
          description: "Inject a value that must not corrupt JSON parsing",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        output: {
          source: "stdout",
          format: "json",
          evidence: { flag: "$.flag", credential: "$.credential" },
        },
      }),
    );
    const env = { AART_SECRET_TOOL_TOKEN: "true" };
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { flag: "[REDACTED]", credential: "[REDACTED]" },
      evidence: { mapped: { flag: "[REDACTED]", credential: "[REDACTED]" } },
    });
  });

  it("redacts secrets emitted as non-string JSON scalars", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "console.log(JSON.stringify({credential:Number(process.env.LOCAL_TOOL_TOKEN)}))",
          ],
        },
        inputs: [],
        authentication: {
          mode: "aart_secrets",
          description: "Inject a numeric-looking secret",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        output: { source: "stdout", format: "json", evidence: { credential: "$.credential" } },
      }),
    );
    const secret = "1234";
    const env = { AART_SECRET_TOOL_TOKEN: secret };
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { credential: "[REDACTED]" },
      evidence: { mapped: { credential: "[REDACTED]" } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts secret literals used as structured-output object keys", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: [
            "-e",
            "console.log(JSON.stringify({[process.env.LOCAL_TOOL_TOKEN]:'value'}))",
          ],
        },
        inputs: [],
        authentication: {
          mode: "aart_secrets",
          description: "Inject a secret that must be removed from object keys",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        output: { source: "stdout", format: "json", evidence: {} },
      }),
    );
    const secret = "secret-object-key";
    const env = { AART_SECRET_TOOL_TOKEN: secret };
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { "[REDACTED]": "value" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts secret literals from structured-output parse diagnostics", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "process.stdout.write(process.env.LOCAL_TOOL_TOKEN)"],
        },
        inputs: [],
        authentication: {
          mode: "aart_secrets",
          description: "Inject a secret into malformed output",
          inheritEnvironment: [],
          secrets: [{ ref: "TOOL_TOKEN", env: "LOCAL_TOOL_TOKEN" }],
        },
        output: { source: "stdout", format: "json", evidence: {} },
      }),
    );
    const secret = "secret-diagnostic-value";
    const env = { AART_SECRET_TOOL_TOKEN: secret };
    const check = await checkLocalTool(storeRoot, registered, { env });
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
      env,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "invalid_structured_output",
      evidence: { outputParseError: "stdout was not valid json" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("records a terminal output-contract failure when declared evidence is missing", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "console.log(JSON.stringify({present:true}))"],
        },
        inputs: [],
        output: { source: "stdout", format: "json", evidence: { requiredProof: "$.missing" } },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered);
    const result = await runLocalTool(storeRoot, registered, {
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({
      ok: false,
      ran: true,
      kind: "evidence_contract_failed",
      error: expect.stringContaining("requiredProof ($.missing)"),
      evidence: {
        missingEvidence: [{ name: "requiredProof", path: "$.missing" }],
      },
    });
  });
});
