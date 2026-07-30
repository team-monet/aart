// ADVERSARIAL end-to-end redaction pass (S9 Phase 3 security review) — the
// explicit re-verification AMENDMENTS.md A27 recommends. Where real-context.ts's
// "redaction genuinely runs end-to-end" test (the test that ORIGINALLY caught
// A27) proves a single secret is redacted from one flow.noop output, THIS file
// drives the REAL @aart/engine wired to the REAL @aart/governance redactRecord
// through the harder paths: multi-step accumulation, thrown-error traces, LLM
// call metadata (ctx.recordLlmCall), the wait/resume segment boundary, and
// artifacts. Same wiring shape as real-context.test.ts (real engine + real
// redactRecord + a concrete resolveSecret), just adversarial inputs.
//
// Test-design note (mirrors packages/governance/src/redact-adversarial.test.ts):
// the suite stays GREEN by asserting ACTUAL behavior. "[SAFE]" cases assert the
// secret is scrubbed; "[FINDING: Fn]" cases assert it survives and are
// cross-referenced to the security-pass report; "[LIMIT: Fn]" cases assert a
// secret survives as a DOCUMENTED, deliberate, accepted boundary (not a
// residual gap) — see each such case's own comment for why.
//
// S10 completion update: F5 (artifact bytes bypassing the redaction
// chokepoint) is RESOLVED for TEXT-mime artifacts (now "[SAFE: F5]") and
// reclassified from an unaddressed finding to a documented, intentional
// boundary for BINARY-mime artifacts (now "[LIMIT: F5]") — see
// step-executor.ts's buildBlockContext doc comment for the full mechanism.
import { afterEach, describe, expect, it } from "vitest";
import type { BlockImplementation, LlmCallMetadata, Workflow } from "@aart/types";
import { createEngine, type EngineBlockExecutionContext } from "@aart/engine";
import { redactRecord } from "@aart/governance";
import { createFsStore, type AartStore } from "@aart/store";
import { makeTempRoot, cleanupTempRoot } from "./test-utils.js";

const SECRET = "sk-live-ADVERSARIAL-7f8a9b0c1d2e";

let root: string | undefined;
afterEach(async () => {
  if (root) await cleanupTempRoot(root);
  root = undefined;
});

// --- Custom fixture blocks (kept tiny + local; the engine is block-catalog-
// agnostic, it only needs the BlockImplementation contract). ---

/** Echoes `{ value: input.value }` — like flow.noop, used to move a secret through step outputs. */
const echoBlock: BlockImplementation = {
  manifest: { id: "adv.echo", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "echoes value" },
  execute: async (input) => ({ value: (input as { value?: unknown }).value }),
};

/** Reads a secret from its resolved input and throws it inside an Error message (StepTrace.error path). */
const throwSecretBlock: BlockImplementation = {
  manifest: { id: "adv.throw-secret", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "throws its input in an error" },
  execute: async (input) => {
    throw new Error(`upstream auth failed using token ${(input as { secret: string }).secret} — retrying`);
  },
};

/** Emits LLM call metadata (via ctx.recordLlmCall) whose scorerResult echoes the resolved secret — models an llm.judge whose scorer captured a model response that repeated a prompt secret. */
const llmLeakBlock: BlockImplementation = {
  manifest: { id: "adv.llm-leak", version: "1.0.0", capabilities: ["llm"], inputSchema: {}, outputSchema: {}, description: "records llm metadata containing a secret" },
  execute: async (input, ctx) => {
    const secret = (input as { secret: string }).secret;
    const metadata: LlmCallMetadata = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      promptRef: "prompts.adv",
      promptVersion: "1.0.0",
      tokensIn: 10,
      tokensOut: 5,
      latencyMs: 42,
      scorerResult: { modelEchoedBack: `The key you gave me was ${secret}` },
    };
    (ctx as EngineBlockExecutionContext).recordLlmCall?.(metadata);
    return { ok: true };
  },
};

/** Writes a resolved secret's raw bytes into a TEXT-mime artifact via ctx.writeArtifact, returns the artifact id. */
const writeSecretArtifactBlock: BlockImplementation = {
  manifest: { id: "adv.write-secret-artifact", version: "1.0.0", capabilities: ["file.write"], inputSchema: {}, outputSchema: {}, description: "writes secret into a text artifact" },
  execute: async (input, ctx) => {
    const secret = (input as { secret: string }).secret;
    const bytes = new TextEncoder().encode(`report body — apiKey=${secret}`);
    const written = await ctx.writeArtifact({ name: "leak.txt", kind: "file", mime: "text/plain", bytes });
    return { id: written.id };
  },
};

/** Writes a resolved secret's raw bytes into a BINARY-mime artifact (e.g. a screenshot-shaped PNG) via ctx.writeArtifact — models the documented boundary: a "secret" embedded in bitmap-shaped bytes (not literally realistic for a real screenshot, whose pixels wouldn't contain the LITERAL secret string, but this is exactly the worst case: bytes that DO contain the literal string, in a mime type this fix deliberately does not scan). */
const writeSecretBinaryArtifactBlock: BlockImplementation = {
  manifest: { id: "adv.write-secret-binary-artifact", version: "1.0.0", capabilities: ["file.write"], inputSchema: {}, outputSchema: {}, description: "writes secret into a binary-mime artifact" },
  execute: async (input, ctx) => {
    const secret = (input as { secret: string }).secret;
    const bytes = new TextEncoder().encode(`\x89PNG-shaped-bytes apiKey=${secret}`);
    const written = await ctx.writeArtifact({ name: "leak.png", kind: "screenshot", mime: "image/png", bytes });
    return { id: written.id };
  },
};

const ALL_BLOCKS: Record<string, BlockImplementation> = {
  [echoBlock.manifest.id]: echoBlock,
  [throwSecretBlock.manifest.id]: throwSecretBlock,
  [llmLeakBlock.manifest.id]: llmLeakBlock,
  [writeSecretArtifactBlock.manifest.id]: writeSecretArtifactBlock,
  [writeSecretBinaryArtifactBlock.manifest.id]: writeSecretBinaryArtifactBlock,
};

async function makeEngineAndStore(): Promise<{ engine: ReturnType<typeof createEngine>; store: AartStore }> {
  root = await makeTempRoot("aart-mcp-adv-redact-");
  const store = createFsStore(root);
  const engine = createEngine({
    store,
    redact: redactRecord, // the REAL chokepoint
    capabilityCheck: () => true,
    blocks: ALL_BLOCKS,
    resolveSecret: async () => SECRET, // every secrets.* ref resolves to the same concrete value
  });
  return { engine, store };
}

function wf(id: string, steps: Workflow["execution"]["steps"]): Workflow {
  return {
    id,
    name: id,
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
  };
}

async function trigger(engine: ReturnType<typeof createEngine>, workflow: Workflow) {
  return engine.triggerRun({ workflow, trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() }, inputs: {} });
}

describe("adversarial redaction e2e — real engine + real redactRecord", () => {
  it("[SAFE] multi-step: a secret resolved in step 1 and echoed forward by step 2 never reaches the persisted RunRecord", async () => {
    const { engine, store } = await makeEngineAndStore();
    const workflow = wf("adv-multistep", [
      { id: "s1", uses: "adv.echo", with: { value: "{{ secrets.API_KEY }}" } },
      { id: "s2", uses: "adv.echo", with: { value: "carried: {{ steps.s1.outputs.value }}" } },
    ]);
    await store.workflows.put(workflow);
    const run = await trigger(engine, workflow);
    const finished = await engine.executeRun(run.runId);
    expect(finished.status).toBe("completed");

    const persisted = await store.runs.get(run.runId);
    const json = JSON.stringify(persisted);
    expect(json).not.toContain(SECRET); // neither step 1's direct output nor step 2's carried-forward copy leaks
    expect(json).toContain("REDACTED");
    // Matching public leaves are withheld as a unit so a later overlapping
    // secret cannot expose an adjacent suffix.
    expect((persisted!.trace[1]!.outputs as { value: string }).value).toBe("[REDACTED]");
  });

  it("[SAFE] a secret thrown inside a block's Error message is redacted from the persisted StepTrace.error (error paths go through the chokepoint)", async () => {
    const { engine, store } = await makeEngineAndStore();
    const workflow = wf("adv-error", [{ id: "s1", uses: "adv.throw-secret", with: { secret: "{{ secrets.API_KEY }}" } }]);
    await store.workflows.put(workflow);
    const run = await trigger(engine, workflow);
    const finished = await engine.executeRun(run.runId);
    expect(finished.status).toBe("failed");

    const persisted = await store.runs.get(run.runId);
    const json = JSON.stringify(persisted);
    expect(json).not.toContain(SECRET);
    // The failed step's error text is withheld as a unit.
    const errText = persisted!.trace[0]!.error!;
    expect(errText).toBe("[REDACTED]");
    expect(errText).not.toContain(SECRET);
    // The run-level error (finalizeTerminal) is likewise scrubbed.
    expect(persisted!.error ?? "").not.toContain(SECRET);
  });

  it("[SAFE] a secret embedded in ctx.recordLlmCall metadata (LlmCallMetadata.scorerResult) is redacted in the persisted trace", async () => {
    const { engine, store } = await makeEngineAndStore();
    const workflow = wf("adv-llm", [{ id: "s1", uses: "adv.llm-leak", with: { secret: "{{ secrets.API_KEY }}" } }]);
    await store.workflows.put(workflow);
    const run = await trigger(engine, workflow);
    const finished = await engine.executeRun(run.runId);
    expect(finished.status).toBe("completed");

    const persisted = await store.runs.get(run.runId);
    const llmCall = persisted!.trace[0]!.llmCall;
    expect(llmCall).toBeDefined();
    const json = JSON.stringify(persisted);
    expect(json).not.toContain(SECRET);
    // Prove the metadata genuinely made it into the trace AND was scrubbed.
    expect(JSON.stringify(llmCall)).toContain("REDACTED");
    expect(JSON.stringify(llmCall)).not.toContain(SECRET);
  });

  it("[SAFE] wait/resume boundary: a secret resolved BEFORE a wait.manual, echoed by a step AFTER resume, never leaks (fresh per-segment set is safe because persisted state is already redacted)", async () => {
    const { engine, store } = await makeEngineAndStore();
    const workflow = wf("adv-wait", [
      { id: "s1", uses: "adv.echo", with: { value: "{{ secrets.API_KEY }}" }, next: "s2" },
      { id: "s2", uses: "wait.manual", with: {}, next: "s3" },
      { id: "s3", uses: "adv.echo", with: { value: "post-resume echo of {{ steps.s1.outputs.value }}" }, next: "s4" },
      // s4 RE-resolves the secret in the post-resume segment (fresh set) to prove segment-2 redaction also works independently.
      { id: "s4", uses: "adv.echo", with: { value: "post-resume fresh {{ secrets.API_KEY }}" } },
    ]);
    await store.workflows.put(workflow);
    const run = await trigger(engine, workflow);

    const afterFirst = await engine.executeRun(run.runId);
    expect(afterFirst.status).toBe("waiting"); // suspended at s2

    // Nothing leaked in the pre-wait segment (s1's output + the wait checkpoint).
    let json = JSON.stringify(await store.runs.get(run.runId));
    expect(json).not.toContain(SECRET);

    const outcome = await engine.resumeManual(run.runId, "s2");
    expect(outcome.kind).toBe("resumed");

    const persisted = await store.runs.get(run.runId);
    expect(persisted!.status).toBe("completed");
    json = JSON.stringify(persisted);
    // The critical assertion: across the ENTIRE run lifecycle (pre-wait,
    // checkpoint, post-resume echo of a pre-wait secret, AND a fresh
    // post-resume re-resolution) the raw secret never appears once.
    expect(json).not.toContain(SECRET);
    expect((persisted!.trace.find((t) => t.stepId === "s3")!.outputs as { value: string }).value).toBe("[REDACTED]");
    expect((persisted!.trace.find((t) => t.stepId === "s4")!.outputs as { value: string }).value).toBe("[REDACTED]");
  });

  it("[SAFE: F5] TEXT-mime artifact bytes are now redacted before persist (root AMENDMENTS.md, S10 completion — was: '[FINDING: F5] artifact bytes BYPASS the redaction chokepoint')", async () => {
    const { engine, store } = await makeEngineAndStore();
    const workflow = wf("adv-artifact-text", [{ id: "s1", uses: "adv.write-secret-artifact", with: { secret: "{{ secrets.API_KEY }}" } }]);
    await store.workflows.put(workflow);
    const run = await trigger(engine, workflow);
    const finished = await engine.executeRun(run.runId);
    expect(finished.status).toBe("completed");

    // The RunRecord trace is redacted, as before.
    const persisted = await store.runs.get(run.runId);
    expect(JSON.stringify(persisted)).not.toContain(SECRET);

    // The fix: ctx.writeArtifact (step-executor.ts buildBlockContext) now
    // decodes TEXT-mime bytes, runs them through the same conservative
    // whole-leaf redaction used for irreversible public audits, and re-encodes before
    // calling store.artifacts.put — so the artifact content itself is
    // scrubbed too, not just the RunRecord's reference to it.
    const artifacts = await store.artifacts.listByRun(run.runId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.mime).toBe("text/plain");
    const bytes = await store.artifacts.getBytes(artifacts[0]!.id);
    const text = new TextDecoder().decode(bytes!);
    expect(text).not.toContain(SECRET);
    expect(text).toBe("[REDACTED]");
  });

  it("[LIMIT: F5] BINARY-mime artifact bytes are deliberately NOT scan-redacted — the documented boundary, not a residual gap", async () => {
    const { engine, store } = await makeEngineAndStore();
    const workflow = wf("adv-artifact-binary", [{ id: "s1", uses: "adv.write-secret-binary-artifact", with: { secret: "{{ secrets.API_KEY }}" } }]);
    await store.workflows.put(workflow);
    const run = await trigger(engine, workflow);
    const finished = await engine.executeRun(run.runId);
    expect(finished.status).toBe("completed");

    // The RunRecord trace is still redacted — only the artifact BYTES are
    // exempt, and only because their declared mime is not text.
    const persisted = await store.runs.get(run.runId);
    expect(JSON.stringify(persisted)).not.toContain(SECRET);

    const artifacts = await store.artifacts.listByRun(run.runId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.mime).toBe("image/png");
    const bytes = await store.artifacts.getBytes(artifacts[0]!.id);
    const text = new TextDecoder().decode(bytes!);
    // The raw secret IS on disk in the artifact — this is the documented,
    // intentional boundary (step-executor.ts's buildBlockContext doc
    // comment): text-based scan-and-replace cannot operate on binary
    // content, so it deliberately does not try. The compensating control
    // is (a) prevention at capture where possible (browser.screenshot's
    // maskSelectors) and (b) that nothing in this codebase's production
    // paths ever reads artifact bytes back automatically — getBytes, the
    // one call that CAN expose this, is called from nowhere in production
    // code (only test code, this call included) — reading a binary
    // artifact's real content back is necessarily a deliberate, separate
    // act, never a side effect of a run being reported on.
    expect(text).toContain(SECRET);
  });
});
