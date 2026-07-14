// The item-review flagship-workflow E2E test. Per this test's own DoD
// (narrower than `review-cycle.e2e.test.ts`'s): "item submitted →
// llm.classify → rule check → risk score → conditional human review
// branch → publish/reject → correction-becomes-eval, exercising the
// if/branch logic, llm.classify dispatch, correction capture, and
// eval-from-correction creation together." There is no requirement to
// genuinely kill and restart a worker OS process (that heavy requirement
// is scoped specifically to the review-cycle E2E) — so, deliberately
// unlike `review-cycle.e2e.test.ts`/`review-cycle-worker.mjs`, this is a
// normal, single-process `vitest` test with no spawned child process.
//
// Because this file never needs to run as a genuinely separate OS process,
// it also doesn't need `review-cycle-worker.mjs`'s dist/-relative-import
// trick: that trick exists only because that file is a standalone script
// executed directly by `node` (which cannot run `.ts` without a loader).
// This file IS a `vitest` test (`packages/mcp/vitest.config.ts`'s
// `include: ["src/**/*.test.ts"]`), executed by vitest's own
// TypeScript-aware runner like every other test in this package — so it
// imports `buildRealCatalog`/`createRealEngine` directly from TypeScript
// SOURCE (`../real-context.js`, resolving to `real-context.ts` — this
// repo's NodeNext-ESM convention of writing `.js` for a same-package
// relative import even though the real file is `.ts`), with no `pnpm run
// build`/`dist/` precondition. `createRealAartContext` (`../context.js`)
// is NOT used here: it has no seam for folding extra blocks into the real
// 56-block catalog it builds internally (its `options` only override whole
// ports, never add to the catalog) — so, exactly like `real-context.test.ts`'s
// own "redaction genuinely runs end-to-end" test (the established
// precedent for this exact need), this file builds the engine directly via
// `buildRealCatalog`+`createRealEngine`, folding the four `demo.*` fixture
// blocks in alongside the real 56, and builds its evidence calls directly
// via `createRealEvidencePort` — both real, exported `real-context.ts`
// functions, no context-wrapping layer needed.
//
// Domain-pack-shaped fixture blocks (a neutral `demo.*` namespace, plus
// `demo.score` — see `fixtures/item-review.yaml`'s header comment for why
// that one exists beyond the other three) — none are real, shipped blocks.
// Matches `review-cycle-worker.mjs`/`packages/engine/src/guarded-loop.test.ts`'s
// own established fixture-registration precedent: `capabilities: []` on
// every one (capability-grant testing is not this E2E's concern; dev trust
// mode, which this test's engine runs under, grants the full capability
// closure unconditionally regardless).
//
// Deliberately industry-neutral (AMENDMENTS.md A70): this file and its
// fixture workflow replace a former test/fixture pair that carried a
// specific customer/domain narrative, removed from the product
// (2026-07-14, zero customer/domain-specific content). Every assertion
// below is preserved from that file; only naming/vocabulary changed. See
// this session's AMENDMENTS.md A70 entry for the full before/after
// coverage mapping.
import { afterEach, describe, expect, it } from "vitest";
import type { AnthropicClientLike } from "@aart/llm";
import { createFsStore } from "@aart/store";
import type { BlockImplementation, Workflow } from "@aart/types";
import { WorkflowSchema } from "@aart/types";
import { correctionKey } from "@aart/evidence";
import fixtureJson from "./fixtures/item-review.workflow.json" with { type: "json" };
import { buildRealCatalog, createRealEngine, createRealEvidencePort } from "../real-context.js";
import { makeTempRoot, cleanupTempRoot } from "../test-utils.js";

function fixtureManifest(id: string, description: string) {
  return { id, version: "0.1.0", capabilities: [] as string[], inputSchema: {}, outputSchema: {}, description };
}

// A small, fixed list a real rule-check pack might flag — just enough to
// prove "rule check" is a genuinely separate, deterministic signal from
// `llm.classify`'s own read (this step never consults classify_item's
// output at all — see fixtures/item-review.yaml's header comment on why
// check_rules and classify_item are deliberately independent).
const BANNED_CLAIM_PHRASES = ["guaranteed win", "zero risk", "instant approval"];

const domainFixtureBlocks: Record<string, BlockImplementation> = {
  "demo.check": {
    manifest: fixtureManifest("demo.check", "fixture - domain-pack-shaped, not a real shipped block"),
    execute: async (input) => {
      const itemText = String((input as Record<string, unknown>).itemText ?? "").toLowerCase();
      const violations = BANNED_CLAIM_PHRASES.filter((phrase) => itemText.includes(phrase));
      return { passed: violations.length === 0, violations };
    },
  },
  "demo.score": {
    manifest: fixtureManifest(
      "demo.score",
      "fixture - domain-pack-shaped; fuses the LLM classification with the rule-check result into the risk score (see fixtures/item-review.yaml's header comment).",
    ),
    execute: async (input) => {
      const record = input as Record<string, unknown>;
      const claimsLabel = String(record.claimsLabel ?? "");
      const rulesPassed = Boolean(record.rulesPassed);
      const violations = Array.isArray(record.violations) ? record.violations : [];
      let score = 0;
      if (claimsLabel === "prohibited") score += 60;
      else if (claimsLabel === "needs_review") score += 30;
      if (!rulesPassed) score += 30;
      score = Math.min(100, score + violations.length * 10);
      const riskTier = score >= 50 ? "high" : "low";
      return { riskScore: score, riskTier, needsReview: riskTier === "high" };
    },
  },
  "demo.publish": {
    manifest: fixtureManifest("demo.publish", "fixture - domain-pack-shaped, not a real shipped block"),
    execute: async (input) => {
      const record = input as Record<string, unknown>;
      const status = String(record.reviewStatus ?? "");
      const approved = status === "approved" || status === "auto-approved";
      if (approved) return { action: "published", itemId: record.itemId, publishedAt: new Date().toISOString() };
      return { action: "rejected", itemId: record.itemId, reason: `item rejected (reviewStatus: "${status}")` };
    },
  },
  "demo.notify": {
    manifest: fixtureManifest("demo.notify", "fixture - domain-pack-shaped, not a real shipped block"),
    execute: async (input) => {
      const record = input as Record<string, unknown>;
      return { notified: true, itemId: record.itemId, outcome: record.outcome, channel: "email" };
    },
  },
};

// ---------------------------------------------------------------------------
// Fake Anthropic client (no real LLM provider API key is available in this
// environment — verified: none of ANTHROPIC_API_KEY/OPENAI_API_KEY/
// GOOGLE_API_KEY/GEMINI_API_KEY are set). Injected via buildRealCatalog's
// llmOptions (same `{ anthropic: { client } }` seam review-cycle-worker.mjs
// and real-context.test.ts both use) — the REAL llm.classify block still
// runs its real dispatch/schema-validation/enum-synthesis logic; only the
// network call this client.messages.create replaces is faked. Returns
// exactly one of classify_item's own declared labels, parameterized per
// test so each scenario can deterministically drive score_risk's fixture
// logic toward "low risk" or "high risk".
// ---------------------------------------------------------------------------
function fakeAnthropicClassifyClient(label: string, confidence = 0.9): AnthropicClientLike {
  return {
    messages: {
      async create() {
        return {
          content: [{ type: "text", text: JSON.stringify({ label, confidence }) }],
          usage: { input_tokens: 24, output_tokens: 8 },
        };
      },
    },
  };
}

function fixtureTrigger() {
  return { id: `e2e-trigger-${Math.random().toString(36).slice(2)}`, type: "manual" as const, source: "item-review.e2e.test", payload: null, receivedAt: new Date().toISOString() };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => cleanupTempRoot(r)));
});

/** Builds a real engine (56-block catalog + the 4 demo.* fixtures) and a real evidence port over a fresh temp store, with the fake Anthropic client seeded to return `label` for every classify_item dispatch in this scenario. */
async function setupEngine(label: string) {
  const root = await makeTempRoot("aart-e2e-item-review-");
  roots.push(root);
  const store = createFsStore(root);
  const catalog = buildRealCatalog(store, { anthropic: { client: fakeAnthropicClassifyClient(label) } });
  const blocks = { ...catalog.blocks, ...domainFixtureBlocks };
  // "dev" passed explicitly (AMENDMENTS.md A48: createRealEngine's
  // trustMode param is required, not silently defaulted) — matches this
  // file's own header comment: "dev trust mode, which this test's engine
  // runs under, grants the full capability closure unconditionally
  // regardless" (capability-grant gating is not this E2E's concern; every
  // domain-pack fixture block also declares capabilities: [] independently).
  const engine = createRealEngine(store, blocks, "dev");
  const evidence = createRealEvidencePort(store, engine);
  return { store, engine, evidence };
}

const HIGH_RISK_ITEM_TEXT = "This product is a guaranteed win with zero risk and instant approval — act now, results are certified 100% guaranteed.";
const LOW_RISK_ITEM_TEXT = "Item description: standard configuration, adjustable range 10-15 units, compatible with common setups. Ready to ship.";

describe("the item-review workflow, imported literally from this package's own e2e/fixtures/", () => {
  it("the imported fixture round-trips through WorkflowSchema exactly (proves the JSON form is a genuinely valid canonical Workflow, not just JSON-shaped)", () => {
    const parsed = WorkflowSchema.parse(fixtureJson);
    expect(parsed.id).toBe("item-review");
    expect(parsed.execution.steps.map((s) => s.id)).toEqual([
      "classify_item",
      "check_rules",
      "score_risk",
      "human_review",
      "finalize_reviewed",
      "notify_reviewed",
      "finalize_auto",
      "notify_auto",
      "item_processed",
    ]);
    const humanReview = parsed.execution.steps.find((s) => s.id === "human_review");
    expect(humanReview).toMatchObject({
      uses: "human.approval",
      if: "{{ steps.score_risk.outputs.needsReview }}",
      then: "finalize_reviewed",
      else: "finalize_auto",
    });
    const notifyReviewed = parsed.execution.steps.find((s) => s.id === "notify_reviewed");
    const notifyAuto = parsed.execution.steps.find((s) => s.id === "notify_auto");
    expect(notifyReviewed?.next).toBe("item_processed");
    expect(notifyAuto?.next).toBe("item_processed");
    const classify = parsed.execution.steps.find((s) => s.id === "classify_item");
    expect(classify).toMatchObject({ uses: "llm.classify" });
  });

  describe("LOW RISK branch — if/branch logic: a compliant item SKIPS human.approval entirely (else route), never creates a wait", () => {
    it("runs straight through to completion in one executeRun call, auto-publishes, and records human_review as genuinely skipped (not dispatched)", async () => {
      const { store, engine } = await setupEngine("compliant");
      const workflow = WorkflowSchema.parse(fixtureJson) as Workflow;
      await store.workflows.put(workflow);

      const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: { itemId: "item-low-1", itemText: LOW_RISK_ITEM_TEXT } });
      const finished = await engine.executeRun(run.runId);

      // The single most important assertion in this branch: the run never
      // entered "waiting" at all — if `if` were miscoded (e.g. inverted, or
      // absent), a low-risk item would incorrectly pause on
      // human.approval, and this would catch it directly.
      expect(finished.status).toBe("completed");
      expect(finished.trace.map((t) => t.stepId)).toEqual(["classify_item", "check_rules", "score_risk", "human_review", "finalize_auto", "notify_auto", "item_processed"]);

      const classifyTrace = finished.trace.find((t) => t.stepId === "classify_item");
      expect(classifyTrace?.outputs).toMatchObject({ label: "compliant" });

      const rulesTrace = finished.trace.find((t) => t.stepId === "check_rules");
      expect(rulesTrace?.outputs).toEqual({ passed: true, violations: [] });

      const riskTrace = finished.trace.find((t) => t.stepId === "score_risk");
      expect(riskTrace?.outputs).toMatchObject({ riskTier: "low", needsReview: false });

      // human_review was SKIPPED, not dispatched — no `outputs` at all, and
      // critically, no WaitCondition/ApprovalTask was ever created for it.
      const humanReviewTrace = finished.trace.find((t) => t.stepId === "human_review");
      expect(humanReviewTrace?.status).toBe("skipped");
      expect(humanReviewTrace?.outputs).toBeUndefined();

      const publishTrace = finished.trace.find((t) => t.stepId === "finalize_auto");
      expect(publishTrace?.outputs).toMatchObject({ action: "published", itemId: "item-low-1" });
      const notifyTrace = finished.trace.find((t) => t.stepId === "notify_auto");
      expect(notifyTrace?.outputs).toMatchObject({ notified: true, outcome: "published" });

      // Direct store confirmation that this run never touched WaitStore/
      // ApprovalStore at all (not just that the final status looks right).
      const wait = await store.waits.get(run.runId, "human_review");
      expect(wait).toBeUndefined();
    });
  });

  describe("HIGH RISK branch — if/branch logic: a prohibited-claims item REQUIRES human.approval (then route), a genuine wait is created and resumed", () => {
    it("pauses on a real human.approval wait, resumes on APPROVAL, publishes, and the resulting classification is later corrected into an eval example (full lifecycle)", async () => {
      const { store, engine, evidence } = await setupEngine("prohibited");
      const workflow = WorkflowSchema.parse(fixtureJson) as Workflow;
      await store.workflows.put(workflow);

      const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: { itemId: "item-high-1", itemText: HIGH_RISK_ITEM_TEXT } });
      const waiting = await engine.executeRun(run.runId);

      expect(waiting.status).toBe("waiting");
      expect(waiting.trace.map((t) => t.stepId)).toEqual(["classify_item", "check_rules", "score_risk", "human_review"]);
      const waitingTrace = waiting.trace.find((t) => t.stepId === "human_review");
      expect(waitingTrace?.status).toBe("waiting"); // if=true genuinely dispatched — this is the branch review-cycle's if/then/else sibling test proves inverted for

      const rulesTrace = waiting.trace.find((t) => t.stepId === "check_rules");
      expect(rulesTrace?.outputs).toMatchObject({ passed: false });
      expect((rulesTrace?.outputs?.["violations"] as string[]).sort()).toEqual(["guaranteed win", "instant approval", "zero risk"]);
      const riskTrace = waiting.trace.find((t) => t.stepId === "score_risk");
      expect(riskTrace?.outputs).toMatchObject({ riskTier: "high", needsReview: true, riskScore: 100 });

      // Confirm a REAL WaitCondition + ApprovalTask were durably persisted
      // (not just that RunRecord.status says "waiting").
      const wait = await store.waits.get(run.runId, "human_review");
      expect(wait?.type).toBe("approval");
      const approvals = await store.approvals.list({ runId: run.runId });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe("pending");

      const outcome = await engine.resumeApproval(run.runId, "human_review", {
        id: approvals[0]!.id,
        status: "approved",
        decision: { note: "Reviewed the item directly — approving with a note to soften the classification (see correction below)." },
        reviewer: "reviewer@demo.example",
      });
      expect(outcome.kind).toBe("resumed");
      if (outcome.kind !== "resumed") throw new Error("unreachable");

      expect(outcome.run.status).toBe("completed");
      expect(outcome.run.trace.map((t) => t.stepId)).toEqual(["classify_item", "check_rules", "score_risk", "human_review", "finalize_reviewed", "notify_reviewed", "item_processed"]);

      const humanReviewTrace = outcome.run.trace.find((t) => t.stepId === "human_review");
      expect(humanReviewTrace?.status).toBe("completed");
      expect(humanReviewTrace?.outputs).toMatchObject({ status: "approved", reviewer: "reviewer@demo.example" });

      const publishTrace = outcome.run.trace.find((t) => t.stepId === "finalize_reviewed");
      expect(publishTrace?.outputs).toMatchObject({ action: "published", itemId: "item-high-1" });
      const notifyTrace = outcome.run.trace.find((t) => t.stepId === "notify_reviewed");
      expect(notifyTrace?.outputs).toMatchObject({ notified: true, outcome: "published" });

      // --- POST-HOC: "correction becomes eval" (see fixtures/item-review.yaml's
      // header comment for why this is a separate action against the
      // completed run, not a workflow step). ---

      const classifyTrace = outcome.run.trace.find((t) => t.stepId === "classify_item");
      expect(classifyTrace?.outputs).toMatchObject({ label: "prohibited" });

      const suiteId = "item-classify-suite";
      await store.evals.putSuite({ id: suiteId, name: "Item classification regressions", examples: [], scorer: { id: "exact-label", kind: "exact_match" }, tags: ["demo"] });

      const correction = await evidence.recordCorrection({
        runId: run.runId,
        stepId: "classify_item",
        fieldPath: "outputs.label",
        observed: "prohibited",
        corrected: "needs_review",
        reason: "Claims were borderline (unverified, not outright false) — the LLM over-flagged this item as prohibited when a human reviewer judged it merely needs-review.",
        reviewer: "reviewer@demo.example",
      });
      expect(correction).toMatchObject({ runId: run.runId, stepId: "classify_item", fieldPath: "outputs.label", observed: "prohibited", corrected: "needs_review" });

      const example = await evidence.createEvalExampleFromCorrection(correction, suiteId);
      expect(example.suiteId).toBe(suiteId);
      expect(example.sourceRunId).toBe(run.runId);
      expect(example.expected).toBe("needs_review");
      expect(example.createdFromCorrection).toBe(correctionKey(correction));

      // Direct store re-reads — a FOURTH, independent confirmation (beyond
      // the returned objects) that both the correction and the eval example
      // are genuinely, durably persisted, not just returned in-memory.
      const persistedCorrections = await store.corrections.list({ runId: run.runId });
      expect(persistedCorrections).toEqual([correction]);
      const persistedExamples = await store.evals.listExamples(suiteId);
      expect(persistedExamples).toEqual([example]);
    });

    it("resumes on REJECTION: the item is rejected, never published, and the recipient is notified of the rejection", async () => {
      const { store, engine } = await setupEngine("prohibited");
      const workflow = WorkflowSchema.parse(fixtureJson) as Workflow;
      await store.workflows.put(workflow);

      const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: { itemId: "item-high-2", itemText: HIGH_RISK_ITEM_TEXT } });
      const waiting = await engine.executeRun(run.runId);
      expect(waiting.status).toBe("waiting");

      const approvals = await store.approvals.list({ runId: run.runId });
      const outcome = await engine.resumeApproval(run.runId, "human_review", {
        id: approvals[0]!.id,
        status: "rejected",
        decision: { note: "Claims are not substantiated — rejecting." },
        reviewer: "reviewer@demo.example",
      });
      expect(outcome.kind).toBe("resumed");
      if (outcome.kind !== "resumed") throw new Error("unreachable");

      expect(outcome.run.status).toBe("completed"); // the WORKFLOW run still completes — "rejected" is a normal outcome, not a run failure
      // Still routes through the SAME then-branch (finalize_reviewed/
      // notify_reviewed) as the approved case — `if`/`then`/`else` route on
      // WHETHER human_review ran, not on its decision; the approve-vs-reject
      // fork happens inside demo.publish's own fixture logic (see
      // fixtures/item-review.yaml's header comment).
      expect(outcome.run.trace.map((t) => t.stepId)).toEqual(["classify_item", "check_rules", "score_risk", "human_review", "finalize_reviewed", "notify_reviewed", "item_processed"]);

      const publishTrace = outcome.run.trace.find((t) => t.stepId === "finalize_reviewed");
      expect(publishTrace?.outputs).toMatchObject({ action: "rejected", itemId: "item-high-2" });
      const notifyTrace = outcome.run.trace.find((t) => t.stepId === "notify_reviewed");
      expect(notifyTrace?.outputs).toMatchObject({ notified: true, outcome: "rejected" });
    });
  });
});
