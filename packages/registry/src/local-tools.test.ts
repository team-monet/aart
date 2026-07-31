import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(pathExecutableCandidates("node", "win32", ".EXE;.CMD")).toEqual([
      "node",
      "node.EXE",
      "node.CMD",
    ]);
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
    expect(check.executable?.contentHash).toBe(registered.ownedExecutable?.contentHash);
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
  it("resolves executable identity/version and checks additional command probes", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "node-runtime",
            executable: process.execPath,
            resolution: "absolute",
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
      executable: { path: process.execPath, contentHash: expect.stringMatching(/^sha256:/) },
      prerequisites: [{ name: "node-runtime", ready: true }],
    });
    expect(check.approvalSummary.authentication.mode).toBe("inherited");
    expect(check.approvalSummary.capability).toBe("command");
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

  it("distinguishes an incompatible executable version from an absent executable", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          ...manifest().command,
          versionCheck: {
            args: ["--version"],
            semverRange: ">=999.0.0",
            match: "v?(\\d+\\.\\d+\\.\\d+)",
          },
        },
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } });
    expect(check).toMatchObject({
      ready: false,
      status: "incompatible",
      reason: expect.stringContaining("does not satisfy"),
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

  it("bounds catastrophic version-match expressions outside the MCP event loop", async () => {
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
    await expect(checkLocalTool(storeRoot, registered)).resolves.toMatchObject({
      ready: false,
      status: "incompatible",
      reason: expect.stringContaining("regex time budget"),
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

  it("refuses a changed prerequisite before executing its version check or probe", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const prerequisite = join(storeRoot, "prerequisite");
    const marker = join(storeRoot, "changed-prerequisite-ran");
    await fs.writeFile(prerequisite, "#!/bin/sh\nprintf 'tool 1.0.0\\n'\n", { mode: 0o755 });
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        prerequisites: [
          {
            name: "review-helper",
            executable: prerequisite,
            resolution: "absolute",
            snapshotMode: "standalone",
            versionCheck: { args: ["--version"], semverRange: ">=1", match: "tool (\\d+\\.\\d+\\.\\d+)" },
            probe: { args: ["probe"], expectedExitCode: 0 },
          },
        ],
      }),
    );
    const check = await checkLocalTool(storeRoot, registered, { inputs: { target: "owner/repo#1" } });
    expect(check.ready).toBe(true);
    await fs.writeFile(
      prerequisite,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf 'tool 2.0.0\\n'\n`,
      { mode: 0o755 },
    );

    const result = await runLocalTool(storeRoot, registered, {
      inputs: { target: "owner/repo#1" },
      contentHash: registered.contentHash,
      executableHash: check.executable!.contentHash,
      argvHash: check.argvHash!,
      cwdHash: check.cwdHash!,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(result).toMatchObject({ ok: false, ran: false, kind: "review_seal_mismatch" });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("executes the sealed snapshot even when a version check replaces the original executable", async () => {
    if (process.platform === "win32") return;
    const storeRoot = await root();
    const executable = join(storeRoot, "mutable-tool");
    const replacement = join(storeRoot, "replacement-tool");
    const originalBytes = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  cp "$2" "$3"',
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

  it("persists a recoverable running record on spawn and atomically completes the same run", async () => {
    const storeRoot = await root();
    const registered = await registerLocalTool(
      storeRoot,
      manifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "setTimeout(()=>console.log(JSON.stringify({done:true})),150)"],
        },
        inputs: [],
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
      .poll(async () => (await listLocalToolRuns(storeRoot, { status: "running" }))[0])
      .toMatchObject({
        toolId: "review.wait",
        status: "running",
        argvHash: check.argvHash,
        cwdHash: check.cwdHash,
        result: { ran: true, kind: "running" },
      });
    const result = await completion;
    const records = await listLocalToolRuns(storeRoot);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: result.runId,
      status: "terminal",
      argvHash: check.argvHash,
      cwdHash: check.cwdHash,
      prerequisiteHashes: {},
      result: { ok: true, ran: true, structuredOutput: { done: true } },
    });
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
