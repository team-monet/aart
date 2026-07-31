import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalToolManifest } from "@aart/registry";
import { createTestContext, type TestContext } from "../test-utils.js";
import { approvePackHandler, installPackHandler, listPacksHandler, preparePackHandler } from "./packs.js";
import {
  checkToolHandler,
  findToolsHandler,
  getToolRunHandler,
  listToolRunsHandler,
  registerToolHandler,
  runToolHandler,
} from "./local-tools.js";

let tc: TestContext;

afterEach(async () => {
  await tc?.cleanup();
});

function toolManifest(overrides: Partial<LocalToolManifest> = {}): LocalToolManifest {
  return {
    id: "codex-review.wait",
    name: "Wait for Codex review",
    version: "1.0.0",
    description: "Wait for one terminal Codex pull-request review outcome",
    keywords: ["codex", "review", "pull request"],
    triggers: ["wait for Codex review", "watch this PR review"],
    examples: [{ description: "Watch one review round", inputs: { target: "owner/repo#1" } }],
    inputs: [{ name: "target", description: "PR target", required: true, sensitive: false }],
    command: {
      executable: process.execPath,
      resolution: "absolute",
      args: ["-e", "console.log(JSON.stringify({outcome:'approved', target:process.argv[1]}))", "{{target}}"],
      versionCheck: { args: ["--version"], semverRange: ">=20", match: "v?(\\d+\\.\\d+\\.\\d+)" },
    },
    prerequisites: [],
    platforms: [process.platform],
    capabilities: ["command"],
    effects: { reads: ["GitHub PR review metadata"], writes: [], network: ["github.com"] },
    cwd: { mode: "inherit" },
    authentication: {
      mode: "inherited",
      description: "Reuse the current user's authenticated gh session",
      inheritEnvironment: "all",
    },
    output: { source: "stdout", format: "json", evidence: { outcome: "$.outcome" } },
    ...overrides,
  };
}

describe("local tool MCP handlers", () => {
  it("registers, rediscovers by customer task wording, checks, and executes one sealed command", async () => {
    tc = await createTestContext();
    const registered = await registerToolHandler(tc.ctx, { tool: toolManifest() });
    expect(registered.ok).toBe(true);
    const sealed = registered.tool as { contentHash: string };

    const found = await findToolsHandler(tc.ctx, { query: "wait for Codex review" });
    expect(found).toMatchObject({
      ok: true,
      matched: true,
      tools: [
        {
          id: "codex-review.wait",
          authentication: { mode: "inherited" },
          availability: { status: "requires_explicit_check", ready: false },
          effects: { reads: ["GitHub PR review metadata"], writes: [], network: ["github.com"] },
        },
      ],
    });

    const checked = await checkToolHandler(tc.ctx, {
      id: "codex-review.wait",
      inputs: { target: "team-monet/aart#11" },
    });
    expect(checked.ok).toBe(true);
    const check = checked.check as {
      executable: { contentHash: string };
      argvHash: string;
      cwdHash: string;
      prerequisiteHashes: Record<string, string>;
    };
    const ran = await runToolHandler(tc.ctx, {
      id: "codex-review.wait",
      inputs: { target: "team-monet/aart#11" },
      contentHash: sealed.contentHash,
      executableHash: check.executable.contentHash,
      argvHash: check.argvHash,
      cwdHash: check.cwdHash,
      prerequisiteHashes: check.prerequisiteHashes,
    });
    expect(ran).toMatchObject({
      ok: true,
      ran: true,
      runId: expect.stringMatching(/^toolrun_/),
      evidenceStored: true,
      structuredOutput: { outcome: "approved", target: "team-monet/aart#11" },
      evidence: { mapped: { outcome: "approved" } },
    });
    const fetched = await getToolRunHandler(tc.ctx, { runId: ran.runId as string });
    expect(fetched).toMatchObject({
      ok: true,
      run: {
        runId: ran.runId,
        toolId: "codex-review.wait",
        result: { ok: true, ran: true, evidence: { mapped: { outcome: "approved" } } },
      },
    });
    await expect(listToolRunsHandler(tc.ctx, { toolId: "codex-review.wait" })).resolves.toMatchObject({
      ok: true,
      count: 1,
      runs: [{ runId: ran.runId, status: "terminal", argvHash: check.argvHash }],
    });
    await expect(getToolRunHandler(tc.ctx, { runId: "../escape" })).resolves.toEqual({
      ok: false,
      error: 'Unknown local tool run "../escape".',
    });
  });

  it("returns a missing prerequisite as an honest non-run result", async () => {
    tc = await createTestContext();
    await registerToolHandler(tc.ctx, {
      tool: toolManifest({
        command: {
          executable: "missing-aart-test-review-watcher",
          resolution: "path",
          args: ["{{target}}"],
        },
      }),
    });
    const found = await findToolsHandler(tc.ctx, { query: "Codex review" });
    expect(found).toMatchObject({
      tools: [{ availability: { ready: false, status: "requires_explicit_check" } }],
    });
    const checked = await checkToolHandler(tc.ctx, {
      id: "codex-review.wait",
      inputs: { target: "team-monet/aart#11" },
    });
    expect(checked).toMatchObject({ ok: false, check: { ready: false, status: "missing_prerequisite" } });
  });

  it("keeps discovery inert and defers manifest-defined version commands to explicit check", async () => {
    tc = await createTestContext();
    const marker = join(tc.root, "version-check-ran");
    await registerToolHandler(tc.ctx, {
      tool: toolManifest({
        command: {
          executable: process.execPath,
          resolution: "absolute",
          args: ["-e", "console.log(JSON.stringify({outcome:'approved'}))"],
          versionCheck: {
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
          },
        },
        inputs: [],
      }),
    });

    await expect(findToolsHandler(tc.ctx, { query: "Codex review" })).resolves.toMatchObject({
      tools: [{ availability: { status: "requires_explicit_check" } }],
    });
    await expect(fs.access(marker)).rejects.toThrow();

    await expect(checkToolHandler(tc.ctx, { id: "codex-review.wait" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("ran");
  });

  it("requires concrete required inputs on the explicit review check path", async () => {
    tc = await createTestContext();
    await registerToolHandler(tc.ctx, { tool: toolManifest() });
    await expect(checkToolHandler(tc.ctx, { id: "codex-review.wait" })).resolves.toMatchObject({
      ok: false,
      check: {
        ready: false,
        status: "invalid_input",
        reason: 'missing required tool input "target"',
      },
    });
  });
});

describe("Pack tool declarations", () => {
  it("remain inert until Pack approval, then join the same reuse-first discovery path", async () => {
    tc = await createTestContext();
    const packageRoot = join(tc.root, "tool-pack-source");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-review-tools", version: "1.0.0" }),
      "utf8",
    );
    const manifest = toolManifest({
      id: "pack-review.wait",
      command: {
        executable: process.execPath,
        resolution: "absolute",
        args: ["-e", "console.log(JSON.stringify({outcome:'approved'}))"],
      },
      inputs: [],
    });
    await fs.writeFile(
      join(packageRoot, "aart-pack.yaml"),
      [
        "name: review-tools",
        "version: 1.0.0",
        "description: Portable local review tool declarations",
        "tools:",
        ...JSON.stringify(manifest, null, 2)
          .split("\n")
          .map((line, index) => `${index === 0 ? "  - " : "    "}${line}`),
        "",
      ].join("\n"),
      "utf8",
    );

    const installed = await installPackHandler(tc.ctx, { name: "review-tools", sourcePath: packageRoot });
    expect(installed).toMatchObject({
      ok: true,
      approvalStatus: "unapproved",
      assets: { blocks: [], workflows: [], tools: ["pack-review.wait"] },
    });
    expect(await findToolsHandler(tc.ctx, { query: "Portable local review" })).toMatchObject({
      matched: false,
      tools: [],
    });

    const listed = await listPacksHandler(tc.ctx, { status: "unapproved" });
    expect(listed).toMatchObject({
      packs: [{ assets: { tools: ["pack-review.wait"] }, sealStatus: "verified" }],
    });
    await approvePackHandler(tc.ctx, {
      name: "review-tools",
      version: "1.0.0",
      contentHash: installed.contentHash as string,
      reviewer: "reviewer",
    });
    const found = await findToolsHandler(tc.ctx, { query: "Portable local review" });
    expect(found).toMatchObject({
      matched: true,
      tools: [{ id: "pack-review.wait", source: "pack", provenance: { packName: "review-tools" } }],
    });

    await registerToolHandler(tc.ctx, {
      tool: { ...manifest, description: "Conflicting local contract at the same id and version" },
    });
    const ambiguous = await findToolsHandler(tc.ctx, { query: "pack review wait conflicting" });
    expect(ambiguous).toMatchObject({
      matched: true,
      tools: expect.arrayContaining([
        expect.objectContaining({
          id: "pack-review.wait",
          availability: expect.objectContaining({
            status: "ambiguous",
            ready: false,
            candidates: expect.arrayContaining([
              expect.objectContaining({ provenance: expect.objectContaining({ kind: "pack" }) }),
              expect.objectContaining({ provenance: expect.objectContaining({ kind: "inline" }) }),
            ]),
          }),
        }),
      ]),
    });
    await expect(checkToolHandler(tc.ctx, { id: "pack-review.wait" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("ambiguous"),
    });
  });

  it("publishes portable tool metadata into the static index and supports remote search", async () => {
    tc = await createTestContext();
    const packageRoot = join(tc.root, "prepared-tool-pack");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-review-tools", version: "1.0.0" }),
      "utf8",
    );
    const manifest = toolManifest({ id: "public-review.wait" });
    await fs.writeFile(
      join(packageRoot, "aart-pack.yaml"),
      [
        "name: review-tools",
        "version: 1.0.0",
        "tools:",
        ...JSON.stringify(manifest, null, 2)
          .split("\n")
          .map((line, index) => `${index === 0 ? "  - " : "    "}${line}`),
        "",
      ].join("\n"),
      "utf8",
    );
    const prepared = await preparePackHandler(tc.ctx, { sourcePath: packageRoot });
    expect(prepared).toMatchObject({ ok: true, entry: { tools: [{ id: "public-review.wait" }] } });
    const preparedEntry = prepared.entry as { contentHash: string };
    const indexUrl = `data:application/json,${encodeURIComponent(
      JSON.stringify({ schemaVersion: 1, mode: "production", packs: [prepared.entry] }),
    )}`;
    const found = await findToolsHandler(tc.ctx, {
      query: "wait for Codex review",
      scope: "remote",
      indexUrl,
    });
    expect(found).toMatchObject({
      matched: true,
      indexMode: "production",
      tools: [
        {
          id: "public-review.wait",
          source: "public",
          installable: true,
          inputs: [{ name: "target", description: "PR target", required: true, sensitive: false }],
          provenance: { packName: "review-tools", packVersion: "1.0.0" },
          installation: {
            name: "review-tools",
            version: "1.0.0",
            contentHash: preparedEntry.contentHash,
          },
        },
      ],
    });
  });
});
