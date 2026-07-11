import { describe, expect, it } from "vitest";
import { makeCorrection } from "../test-support/fixtures.js";
import { correctionKey, renderCorrectionQueuePage } from "./corrections.js";

// AMENDMENTS.md A47: `findCorrectionByKey` and every outcome action
// (`recordCorrectionAction`, `updateRunOutputAction`,
// `createEvalExampleFromCorrectionAction`, `createIssueForAgentAction`,
// `triggerImprovementProposalAction`, `blockPromotionAction`,
// `unblockPromotionAction`, `markNeedsReviewAction`,
// `clearNeedsReviewAction`) are deleted from this module — `server.ts`'s
// routes now call `ApiClient` methods that reach real server-side
// implementations directly (`packages/server/src/corrections.ts`'s
// `findCorrectionByKey`, tested there; `@aart/evidence`'s real outcome
// functions, already tested in that package). This file keeps only the
// pure rendering + the `correctionKey` encoding left here.
describe("correctionKey", () => {
  it("matches @aart/evidence's own correctionKey format EXACTLY: '${runId}:${stepId}:${fieldPath}', no timestamp component (architecture §5.3's corrections table primary key has none either)", () => {
    const correction = makeCorrection({ runId: "run-key", stepId: "step1", fieldPath: "outputs.total", createdAt: "2026-07-10T00:00:00.000Z" });
    expect(correctionKey(correction)).toBe("run-key:step1:outputs.total");
  });

  it("round-trips correctly even though createdAt (an ISO timestamp, not part of the key) contains colons — the historical bug this test guards against", () => {
    // An earlier version of this module's key format included createdAt
    // directly in the colon-delimited key and split naively on ":", which
    // silently corrupted both fieldPath and createdAt because ISO 8601
    // timestamps ("2026-07-10T00:00:00.000Z") contain colons themselves.
    // Matching evidence's (runId, stepId, fieldPath)-only format sidesteps
    // this entirely — asserted here so a regression back to the old format
    // fails loudly.
    const correction = makeCorrection({ runId: "run-ts", stepId: "step1", fieldPath: "outputs.total", createdAt: "2026-07-10T12:34:56.789Z" });
    expect(correctionKey(correction)).toBe("run-ts:step1:outputs.total");
  });
});

describe("renderCorrectionQueuePage", () => {
  it("renders a row per correction with outcome-action forms", () => {
    const html = renderCorrectionQueuePage([makeCorrection({ runId: "run-1", reason: "off by one" })]);
    expect(html).toContain("run-1");
    expect(html).toContain("off by one");
    expect(html).toContain("update-run-output");
    expect(html).toContain("create-eval-example");
    expect(html).toContain("create-issue");
  });
});
