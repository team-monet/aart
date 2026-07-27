import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAartContext, createRealAartContext } from "../context.js";
import { compileWorkflowInput } from "../yaml-compiler.js";
import { registerWorkflowHandler } from "./authoring.js";
import { runWorkflowHandler } from "./execution.js";
import {
  approvePackHandler,
  findPacksHandler,
  installPackHandler,
  listPacksHandler,
  preparePackHandler,
} from "./packs.js";

const blockSource = `module.exports = {
  manifest: {
    id: "demo.echo",
    version: "1.0.0",
    capabilities: [],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { message: { type: "string" } } },
    description: "Return a reusable greeting",
    category: "demo"
  },
  execute() {
    return { message: "hello from public pack" };
  }
};
`;

const workflowSource = `id: demo-echo-flow
name: Demo echo flow
version: 1.0.0
category: demo
keywords: [echo, reusable]
steps:
  - id: echo
    uses: demo.echo
`;

describe("public Pack loop", () => {
  let root: string;
  let publisherRoot: string;
  let packageRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-pack-consumer-"));
    publisherRoot = await fs.mkdtemp(join(tmpdir(), "aart-pack-publisher-"));
    packageRoot = join(publisherRoot, "aart-pack-demo");
    await fs.mkdir(join(packageRoot, "blocks"), { recursive: true });
    await fs.mkdir(join(packageRoot, "workflows"), { recursive: true });
    await fs.writeFile(
      join(packageRoot, "aart-pack.yaml"),
      `name: demo
version: 1.0.0
displayName: Demo Pack
description: Reusable demo assets
categories: [examples]
tags: [starter, reusable]
author:
  name: Demo Publisher
  url: https://example.com/demo
license: Apache-2.0
repository: https://example.com/demo/repository
homepage: https://example.com/demo
compatibility:
  aart: ">=0.10.0 <0.11.0"
  node: ">=22"
  runtimes: [Node, Server]
capabilities: []
blocks: [demo.echo]
workflows: [demo-echo-flow]
`,
      "utf8",
    );
    await fs.writeFile(join(packageRoot, "blocks", "demo.echo.cjs"), blockSource, "utf8");
    await fs.writeFile(join(packageRoot, "workflows", "demo-echo-flow.yaml"), workflowSource, "utf8");
    await fs.writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-demo", version: "1.0.0", files: ["aart-pack.yaml", "blocks", "workflows"] }),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(publisherRoot, { recursive: true, force: true });
  });

  it("searches a static public index, installs inert, requires approval, then loads the block and reuses the workflow", async () => {
    const publicIndex = {
      packs: [
        {
          npmPackageName: "aart-pack-demo",
          packName: "demo",
          version: "1.0.0",
          displayName: "Demo Pack",
          description: "Reusable demo assets",
          contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          categories: ["demo"],
          tags: ["reusable"],
          author: { name: "Demo Publisher" },
          license: "Apache-2.0",
          compatibility: { aart: ">=0.12.0", runtimes: ["Node"] },
          verification: { status: "community", note: "Fixture review" },
          stats: { reuses: 12 },
          blocks: [
            {
              manifest: {
                id: "demo.echo",
                version: "1.0.0",
                capabilities: [],
                inputSchema: {},
                outputSchema: {},
                description: "Return a reusable greeting",
                category: "demo",
              },
              examples: [],
            },
          ],
          workflows: [
            {
              id: "demo-echo-flow",
              name: "Demo echo flow",
              version: "1.0.0",
              inputs: [],
              outputs: [],
              execution: { type: "workflow", steps: [{ id: "echo", uses: "demo.echo" }] },
              approval: "draft",
              gates: {
                validate: "pending",
                readiness: "pending",
                evals: "pending",
                riskReview: "pending",
                humanReview: "pending",
              },
              category: "demo",
              keywords: ["echo", "reusable"],
            },
          ],
        },
      ],
    };
    const indexUrl = `data:application/json,${encodeURIComponent(JSON.stringify(publicIndex))}`;
    const ctx = createAartContext({ root, trustMode: "governed" });

    const found = await findPacksHandler(ctx, { query: "reusable echo", indexUrl });
    expect(found.ok).toBe(true);
    expect(found.packs).toEqual([
      expect.objectContaining({
        name: "demo",
        displayName: "Demo Pack",
        version: "1.0.0",
        categories: ["demo"],
        verification: { status: "community", note: "Fixture review" },
        stats: { reuses: 12 },
        blocks: ["demo.echo"],
      }),
    ]);

    const installed = await installPackHandler(ctx, { name: "demo", version: "1.0.0", sourcePath: packageRoot });
    expect(installed).toEqual(expect.objectContaining({ ok: true, approvalStatus: "unapproved" }));
    const awaitingReview = await listPacksHandler(ctx, { status: "unapproved" });
    expect(awaitingReview.count).toBe(1);
    expect(awaitingReview.packs).toEqual([
      expect.objectContaining({
        name: "demo",
        contentHash: installed.contentHash,
        active: false,
        sealStatus: "verified",
        displayName: "Demo Pack",
        description: "Reusable demo assets",
        capabilities: [],
        secrets: [],
        assets: {
          blocks: ["demo.echo"],
          workflows: ["demo-echo-flow"],
        },
      }),
    ]);

    const beforeApproval = createRealAartContext({ root, trustMode: "dev" });
    expect(beforeApproval.registry.getBlock("demo.echo")).toBeUndefined();
    expect(await beforeApproval.store.workflows.getLatest("demo-echo-flow")).toBeUndefined();

    const approved = await approvePackHandler(ctx, {
      name: "demo",
      version: "1.0.0",
      contentHash: installed.contentHash as string,
      reviewer: "human-reviewer",
    });
    expect(approved).toEqual(
      expect.objectContaining({
        ok: true,
        approvalStatus: "approved",
        loadedOnNextProcessStart: ["demo.echo"],
        registeredDraftWorkflows: [{ id: "demo-echo-flow", version: "1.0.0" }],
      }),
    );
    expect(await listPacksHandler(ctx, { status: "approved" })).toEqual(
      expect.objectContaining({
        packs: [expect.objectContaining({ name: "demo", active: true })],
      }),
    );

    const consumer = createRealAartContext({ root, trustMode: "dev" });
    expect(consumer.registry.getBlock("demo.echo")?.packName).toBe("demo");
    expect((await consumer.store.workflows.getLatest("demo-echo-flow"))?.approval).toBe("draft");
    const run = await runWorkflowHandler(consumer, { workflowId: "demo-echo-flow" });
    expect(run.ok).toBe(true);
    expect(run.status).toBe("completed");
    expect(run.trace).toEqual([expect.objectContaining({ block: "demo.echo", status: "completed" })]);
    const storedRun = await consumer.store.runs.get(run.runId as string);
    expect(storedRun?.snapshot.packHashes).toEqual({ demo: expect.stringMatching(/^sha256:/) });
  });

  it("keeps Pack management usable to inspect and reinstall a broken approved Pack", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await approvePackHandler(ctx, {
      name: "demo",
      version: "1.0.0",
      contentHash: installed.contentHash as string,
      reviewer: "human-reviewer",
    });
    await fs.writeFile(
      join(root, "packs", "installed", "demo", "1.0.0", "blocks", "demo.echo.cjs"),
      `${blockSource}\n// broken after approval`,
      "utf8",
    );

    const recovery = createRealAartContext({ root, trustMode: "governed" });
    expect(recovery.registry.getBlock("demo.echo")).toBeUndefined();
    expect(await listPacksHandler(recovery, {})).toEqual(
      expect.objectContaining({
        packs: [expect.objectContaining({ name: "demo", sealStatus: "broken" })],
      }),
    );

    await installPackHandler(recovery, { name: "demo", sourcePath: packageRoot });
    expect(await listPacksHandler(recovery, {})).toEqual(
      expect.objectContaining({
        packs: [expect.objectContaining({ name: "demo", sealStatus: "verified" })],
      }),
    );
  });

  it("keeps a changed approved version sealed instead of silently replacing it", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await approvePackHandler(ctx, {
      name: "demo",
      version: "1.0.0",
      contentHash: installed.contentHash as string,
      reviewer: "human-reviewer",
    });
    await fs.writeFile(join(packageRoot, "blocks", "demo.echo.cjs"), `${blockSource}\n// changed`, "utf8");
    await expect(installPackHandler(ctx, { name: "demo", sourcePath: packageRoot })).rejects.toThrow(
      /refusing to replace approved pack/,
    );
  });

  it("binds approval to the exact content hash the human reviewed", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const first = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await fs.writeFile(join(packageRoot, "blocks", "demo.echo.cjs"), `${blockSource}\n// replacement`, "utf8");
    const replacement = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });

    expect(replacement.contentHash).not.toBe(first.contentHash);
    await expect(
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: first.contentHash as string,
        reviewer: "human-reviewer",
      }),
    ).rejects.toThrow(/reviewed content hash does not match/);
    expect((await listPacksHandler(ctx, { status: "unapproved" })).count).toBe(1);
  });

  it("refuses approval when the Pack requires an unsupported AART version", async () => {
    await fs.writeFile(
      join(packageRoot, "aart-pack.yaml"),
      (await fs.readFile(join(packageRoot, "aart-pack.yaml"), "utf8")).replace(
        'aart: ">=0.10.0 <0.11.0"',
        'aart: ">=0.12.0"',
      ),
      "utf8",
    );
    const ctx = createAartContext({ root, trustMode: "governed" });
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });

    await expect(
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: installed.contentHash as string,
        reviewer: "human-reviewer",
      }),
    ).rejects.toThrow(/requires AART >=0\.12\.0.*runtime is 0\.10\.0/i);
    expect((await listPacksHandler(ctx, { status: "unapproved" })).count).toBe(1);
  });

  it("preserves preview catalog status instead of advertising fixtures as installable Packs", async () => {
    const indexUrl = `data:application/json,${encodeURIComponent(
      JSON.stringify({
        schemaVersion: 1,
        mode: "preview",
        packs: [
          {
            npmPackageName: "aart-pack-demo",
            packName: "demo",
            version: "1.0.0",
            blocks: [],
          },
        ],
      }),
    )}`;
    const result = await findPacksHandler(createAartContext({ root }), {
      query: "demo",
      indexUrl,
    });
    expect(result).toEqual(
      expect.objectContaining({
        indexMode: "preview",
        packs: [expect.objectContaining({ name: "demo", installable: false })],
      }),
    );
  });

  it("uses only the explicitly active version and never revives a dormant conflicting version", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const otherRoot = join(publisherRoot, "aart-pack-other");
    await fs.mkdir(join(otherRoot, "blocks"), { recursive: true });
    await fs.writeFile(
      join(otherRoot, "aart-pack.yaml"),
      "name: other\nversion: 1.0.0\nblocks: [demo.echo]\n",
      "utf8",
    );
    await fs.writeFile(join(otherRoot, "blocks", "demo.echo.cjs"), blockSource, "utf8");
    await fs.writeFile(
      join(otherRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-other", version: "1.0.0" }),
      "utf8",
    );
    const oldVersion = await installPackHandler(ctx, { name: "other", sourcePath: otherRoot });
    await approvePackHandler(ctx, {
      name: "other",
      version: "1.0.0",
      contentHash: oldVersion.contentHash as string,
      reviewer: "human-reviewer",
    });

    await fs.writeFile(
      join(otherRoot, "aart-pack.yaml"),
      "name: other\nversion: 2.0.0\nblocks: [other.current]\n",
      "utf8",
    );
    await fs.rm(join(otherRoot, "blocks", "demo.echo.cjs"));
    await fs.writeFile(
      join(otherRoot, "blocks", "other.current.cjs"),
      blockSource.replaceAll("demo.echo", "other.current"),
      "utf8",
    );
    await fs.writeFile(
      join(otherRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-other", version: "2.0.0" }),
      "utf8",
    );
    const activeVersion = await installPackHandler(ctx, { name: "other", sourcePath: otherRoot });
    await approvePackHandler(ctx, {
      name: "other",
      version: "2.0.0",
      contentHash: activeVersion.contentHash as string,
      reviewer: "human-reviewer",
    });

    const candidate = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await expect(
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: candidate.contentHash as string,
        reviewer: "human-reviewer",
      }),
    ).resolves.toEqual(expect.objectContaining({ approvalStatus: "approved" }));

    // Reinstalling the active other@2 makes that exact version unapproved.
    // The explicit active selection must not fall back to approved other@1,
    // whose old demo.echo id now belongs to the Demo Pack.
    await installPackHandler(ctx, { name: "other", sourcePath: otherRoot });
    const restarted = createRealAartContext({ root, trustMode: "dev" });
    expect(restarted.registry.getBlock("demo.echo")?.packName).toBe("demo");
    expect(restarted.registry.getBlock("other.current")).toBeUndefined();
  });

  it("rejects a Pack block that would make the next process fail on an existing Block id", async () => {
    await fs.writeFile(
      join(packageRoot, "aart-pack.yaml"),
      "name: demo\nversion: 1.0.0\nblocks: [data.stringify]\n",
      "utf8",
    );
    await fs.rm(join(packageRoot, "workflows"), { recursive: true, force: true });
    await fs.rm(join(packageRoot, "blocks"), { recursive: true, force: true });
    await fs.mkdir(join(packageRoot, "blocks"), { recursive: true });
    await fs.writeFile(
      join(packageRoot, "blocks", "data.stringify.cjs"),
      blockSource.replaceAll("demo.echo", "data.stringify"),
      "utf8",
    );

    const ctx = createAartContext({ root, trustMode: "governed" });
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await expect(
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: installed.contentHash as string,
        reviewer: "human-reviewer",
      }),
    ).rejects.toThrow(/conflicts with AART core/);
    expect((await listPacksHandler(ctx, { status: "unapproved" })).count).toBe(1);
  });

  it("detects a Block collision after another Pack is approved in the same long-lived context", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const first = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await approvePackHandler(ctx, {
      name: "demo",
      version: "1.0.0",
      contentHash: first.contentHash as string,
      reviewer: "human-reviewer",
    });

    const otherRoot = join(publisherRoot, "aart-pack-other");
    await fs.mkdir(join(otherRoot, "blocks"), { recursive: true });
    await fs.writeFile(
      join(otherRoot, "aart-pack.yaml"),
      "name: other\nversion: 1.0.0\nblocks: [demo.echo]\n",
      "utf8",
    );
    await fs.writeFile(join(otherRoot, "blocks", "demo.echo.cjs"), blockSource, "utf8");
    await fs.writeFile(
      join(otherRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-other", version: "1.0.0" }),
      "utf8",
    );

    const second = await installPackHandler(ctx, { name: "other", sourcePath: otherRoot });
    await expect(
      approvePackHandler(ctx, {
        name: "other",
        version: "1.0.0",
        contentHash: second.contentHash as string,
        reviewer: "human-reviewer",
      }),
    ).rejects.toThrow(/conflicts with approved pack "demo"/);
    expect((await listPacksHandler(ctx, { status: "approved" })).count).toBe(1);
    expect((await listPacksHandler(ctx, { status: "unapproved" })).count).toBe(1);
  });

  it("serializes concurrent approvals so two Packs cannot claim the same Block id", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const otherRoot = join(publisherRoot, "aart-pack-other");
    await fs.mkdir(join(otherRoot, "blocks"), { recursive: true });
    await fs.writeFile(
      join(otherRoot, "aart-pack.yaml"),
      "name: other\nversion: 1.0.0\nblocks: [demo.echo]\n",
      "utf8",
    );
    await fs.writeFile(join(otherRoot, "blocks", "demo.echo.cjs"), blockSource, "utf8");
    await fs.writeFile(
      join(otherRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-other", version: "1.0.0" }),
      "utf8",
    );

    const demo = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    const other = await installPackHandler(ctx, { name: "other", sourcePath: otherRoot });
    const outcomes = await Promise.allSettled([
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: demo.contentHash as string,
        reviewer: "reviewer-a",
      }),
      approvePackHandler(ctx, {
        name: "other",
        version: "1.0.0",
        contentHash: other.contentHash as string,
        reviewer: "reviewer-b",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await listPacksHandler(ctx, { status: "approved" })).count).toBe(1);
    expect((await listPacksHandler(ctx, { status: "unapproved" })).count).toBe(1);
  });

  it("preserves an existing local workflow version instead of replacing it during Pack approval", async () => {
    const localWorkflow = compileWorkflowInput(workflowSource.replace("Demo echo flow", "Locally authored flow"));
    const ctx = createAartContext({ root, trustMode: "governed" });
    await ctx.store.workflows.put(localWorkflow);
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });

    await expect(
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: installed.contentHash as string,
        reviewer: "human-reviewer",
      }),
    ).rejects.toThrow(/conflicts with an existing registered version/);
    expect((await ctx.store.workflows.get("demo-echo-flow", "1.0.0"))?.name).toBe("Locally authored flow");
    expect((await listPacksHandler(ctx, { status: "unapproved" })).count).toBe(1);
  });

  it("serializes Pack approval with ordinary registration so neither can overwrite the other", async () => {
    const ctx = createAartContext({ root, trustMode: "governed" });
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    const localSource = workflowSource.replace("Demo echo flow", "Concurrent local flow");
    const [approvalOutcome, registrationOutcome] = await Promise.allSettled([
      approvePackHandler(ctx, {
        name: "demo",
        version: "1.0.0",
        contentHash: installed.contentHash as string,
        reviewer: "human-reviewer",
      }),
      registerWorkflowHandler(ctx, { workflow: localSource }),
    ]);
    const approvalWon = approvalOutcome.status === "fulfilled";
    const registrationWon =
      registrationOutcome.status === "fulfilled" && registrationOutcome.value.ok === true;
    expect(Number(approvalWon) + Number(registrationWon)).toBe(1);
    const stored = await ctx.store.workflows.get("demo-echo-flow", "1.0.0");
    expect(stored?.name).toBe(approvalWon ? "Demo echo flow" : "Concurrent local flow");
  });

  it("preserves advanced governance state when the Pack workflow definition is unchanged", async () => {
    const existing = {
      ...compileWorkflowInput(workflowSource),
      approval: "approved" as const,
      gates: {
        validate: "passed" as const,
        readiness: "passed" as const,
        evals: "passed" as const,
        riskReview: "passed" as const,
        humanReview: "passed" as const,
      },
      needsReview: true,
      promotionBlocked: true,
    };
    const ctx = createAartContext({ root, trustMode: "governed" });
    await ctx.store.workflows.put(existing);
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });

    await approvePackHandler(ctx, {
      name: "demo",
      version: "1.0.0",
      contentHash: installed.contentHash as string,
      reviewer: "human-reviewer",
    });
    expect(await ctx.store.workflows.get("demo-echo-flow", "1.0.0")).toEqual(existing);
  });

  it("checks the installed artifact version even when the user did not request a version", async () => {
    await fs.writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "aart-pack-demo", version: "9.9.9" }),
      "utf8",
    );
    const ctx = createAartContext({ root, trustMode: "governed" });
    await expect(installPackHandler(ctx, { name: "demo", sourcePath: packageRoot })).rejects.toThrow(
      /package\.json version 9\.9\.9 does not match manifest version 1\.0\.0/,
    );
    expect((await listPacksHandler(ctx, {})).count).toBe(0);
  });

  it("never evaluates Pack modules in the host process during prepare, approval, startup, or execution", async () => {
    const marker = join(publisherRoot, "host-code-ran.txt");
    const guardedSource = `
if (typeof process !== "undefined") {
  require("node:fs").writeFileSync(${JSON.stringify(marker)}, "host escape");
}
module.exports = {
  manifest: {
    id: "demo.echo",
    version: "1.0.0",
    capabilities: [],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    description: "Prove the public Pack sandbox boundary"
  },
  execute(_input, ctx) {
    return {
      processType: typeof process,
      requireType: typeof require,
      contextKeys: Object.keys(ctx).sort()
    };
  }
};
`;
    await fs.writeFile(join(packageRoot, "blocks", "demo.echo.cjs"), guardedSource, "utf8");
    const ctx = createAartContext({ root, trustMode: "governed" });

    await preparePackHandler(ctx, { sourcePath: packageRoot });
    const installed = await installPackHandler(ctx, { name: "demo", sourcePath: packageRoot });
    await approvePackHandler(ctx, {
      name: "demo",
      version: "1.0.0",
      contentHash: installed.contentHash as string,
      reviewer: "human-reviewer",
    });
    const consumer = createRealAartContext({ root, trustMode: "dev" });
    const run = await runWorkflowHandler(consumer, { workflowId: "demo-echo-flow" });
    const storedRun = await consumer.store.runs.get(run.runId as string);

    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(run.status).toBe("completed");
    expect(storedRun?.trace[0]?.outputs).toEqual({
      processType: "undefined",
      requireType: "undefined",
      contextKeys: ["runId", "stepId"],
    });
  });

  it("rejects public Pack blocks that request ambient capabilities before publication", async () => {
    await fs.writeFile(
      join(packageRoot, "blocks", "demo.echo.cjs"),
      blockSource.replace("capabilities: []", 'capabilities: ["filesystem"]'),
      "utf8",
    );
    const ctx = createAartContext({ root: publisherRoot });
    await expect(preparePackHandler(ctx, { sourcePath: packageRoot })).rejects.toThrow(/pure JSON transforms/);
  });

  it("rejects a package whose manifest claims a different Pack identity before persisting it", async () => {
    await fs.writeFile(
      join(packageRoot, "aart-pack.yaml"),
      `name: impostor
version: 1.0.0
blocks: [demo.echo]
`,
      "utf8",
    );
    const ctx = createAartContext({ root, trustMode: "governed" });
    await expect(installPackHandler(ctx, { name: "demo", sourcePath: packageRoot })).rejects.toThrow(
      /declares pack name "impostor", expected "demo"/,
    );
    await expect(fs.stat(join(root, "packs", "installed", "impostor"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares a deterministic static-index entry before standard npm publication", async () => {
    const ctx = createAartContext({ root: publisherRoot });
    const prepared = await preparePackHandler(ctx, { sourcePath: packageRoot });
    expect(prepared).toEqual(
      expect.objectContaining({
        ok: true,
        pack: "demo",
        npmPackageName: "aart-pack-demo",
        contentHash: expect.stringMatching(/^sha256:/),
      }),
    );
    const entry = JSON.parse(await fs.readFile(join(packageRoot, "aart-index-entry.json"), "utf8")) as {
      packName: string;
      displayName: string;
      categories: string[];
      tags: string[];
      author: { name: string; url: string };
      license: string;
      compatibility: { aart: string; node: string; runtimes: string[] };
      blocks: Array<{ manifest: { id: string } }>;
      workflows: Array<{ id: string; approval: string }>;
    };
    expect(entry.packName).toBe("demo");
    expect(entry.displayName).toBe("Demo Pack");
    expect(entry.categories).toEqual(["demo", "examples"]);
    expect(entry.tags).toEqual(["reusable", "starter"]);
    expect(entry.author).toEqual({ name: "Demo Publisher", url: "https://example.com/demo" });
    expect(entry.license).toBe("Apache-2.0");
    expect(entry.compatibility).toEqual({ aart: ">=0.10.0 <0.11.0", node: ">=22", runtimes: ["Node", "Server"] });
    expect(entry.blocks[0]?.manifest.id).toBe("demo.echo");
    expect(entry.workflows).toEqual([expect.objectContaining({ id: "demo-echo-flow", approval: "draft" })]);
  });

  it("inspects prepared Pack modules asynchronously under one Pack-wide budget", async () => {
    await fs.writeFile(
      join(packageRoot, "blocks", "demo.echo.cjs"),
      "while (true) {}\n",
      "utf8",
    );
    const ctx = createAartContext({ root: publisherRoot });
    const startedAt = Date.now();
    const preparing = preparePackHandler(
      ctx,
      { sourcePath: packageRoot },
      { inspectionBudgetMs: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Date.now() - startedAt).toBeLessThan(80);
    await expect(preparing).rejects.toThrow();
  });

  it("keeps arbitrary preparation output paths on the explicit CLI surface", async () => {
    const ctx = createAartContext({ root: publisherRoot });
    await expect(
      preparePackHandler(ctx, {
        sourcePath: packageRoot,
        outputPath: join(publisherRoot, "unrelated.json"),
      }),
    ).rejects.toThrow(/CLI-only/);
  });

  it("does not follow a symlink at the fixed MCP preparation output", async () => {
    const victim = join(publisherRoot, "victim.txt");
    await fs.writeFile(victim, "keep me", "utf8");
    await fs.symlink(victim, join(packageRoot, "aart-index-entry.json"));
    const ctx = createAartContext({ root: publisherRoot });

    await expect(preparePackHandler(ctx, { sourcePath: packageRoot })).rejects.toThrow();
    await expect(fs.readFile(victim, "utf8")).resolves.toBe("keep me");
  });
});
