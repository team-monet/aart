// scoring.ts — deterministic scoring wiring (spec §32.4: "Scored
// deterministically: aart_validate result plus run success are enough to
// score every example — no LLM judge is needed, which keeps the gate
// itself trustworthy and cheap to run on every change." ADR-15's own
// framing: "deterministic pass/fail via aart_validate + run success.").
import type { AuthoringTask, ModelRunner, RunSuccessFn, ValidateFn } from "./types.js";

export interface FamiliarityScoreResult {
  taskId: string;
  /** Did the ZERO-SHOT (round 0) attempt validate with no corrective round — spec §32.4's "first-draft validity %" metric. */
  firstDraftValid: boolean;
  /** How many corrective rounds until the attempt validated — 0 if first-draft valid; -1 if it never converged within maxCorrectiveRounds — spec §32.4's "loops-to-valid" metric. */
  loopsToValid: number;
  /** Did the model pick the intended block(s), not a plausible-but-wrong one — spec §32.4's "correct-block-choice" metric, checked against `task.expectedBlocks`. Always false if the attempt never converged. */
  correctBlockChoice: boolean;
  ranSuccessfully: boolean;
  passed: boolean;
  score: number;
  /** Always true — this suite is scored deterministically via aart_validate + run success (spec §32.4), never an LLM judge. */
  deterministic: true;
  /** How many rounds (including the zero-shot attempt) were actually spent. */
  rounds: number;
}

export interface ScoreAuthoringAttemptOptions {
  validate: ValidateFn;
  /** Optional — when omitted, a converged (valid) attempt is treated as having "run successfully" by validity alone. */
  runSuccess?: RunSuccessFn;
  /** Default 3 — matches spec §32.2b's "loops-to-valid converges in ≤1 round" design goal plus headroom to actually MEASURE a worse-than-ideal convergence rather than only ever reporting pass/fail at a fixed round count. */
  maxCorrectiveRounds?: number;
}

function extractBlockIds(workflow: unknown): string[] {
  if (!workflow || typeof workflow !== "object") return [];
  const steps = (workflow as { execution?: { steps?: unknown } }).execution?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => (s && typeof s === "object" ? (s as { uses?: unknown }).uses : undefined))
    .filter((u): u is string => typeof u === "string");
}

/**
 * Runs one authoring task against `modelRunner` for up to
 * `options.maxCorrectiveRounds` rounds, stopping at the first round whose
 * output validates. Scores deterministically: no LLM judge anywhere in
 * this function.
 */
export async function scoreAuthoringAttempt(
  task: AuthoringTask,
  modelRunner: ModelRunner,
  options: ScoreAuthoringAttemptOptions,
): Promise<FamiliarityScoreResult> {
  const maxRounds = options.maxCorrectiveRounds ?? 3;
  const priorAttempts: Array<{ output: string; errors: string[] }> = [];
  let loopsToValid = -1;
  let firstDraftValid = false;
  let validWorkflow: unknown;
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const attempt = await modelRunner(task, priorAttempts);
    if (attempt.workflow === undefined) {
      priorAttempts.push({ output: attempt.rawOutput, errors: ["response did not contain a parseable workflow"] });
      continue;
    }
    const validation = await options.validate(attempt.workflow);
    if (validation.valid) {
      if (round === 0) firstDraftValid = true;
      loopsToValid = round;
      validWorkflow = attempt.workflow;
      break;
    }
    priorAttempts.push({ output: attempt.rawOutput, errors: validation.errors });
  }

  const converged = loopsToValid !== -1;
  const correctBlockChoice = converged && task.expectedBlocks.every((b) => extractBlockIds(validWorkflow).includes(b));

  let ranSuccessfully = false;
  if (converged) {
    ranSuccessfully = options.runSuccess ? (await options.runSuccess(validWorkflow)).succeeded : true;
  }

  const passed = converged && correctBlockChoice && ranSuccessfully;
  const score = [converged, correctBlockChoice, ranSuccessfully].filter(Boolean).length / 3;

  return { taskId: task.id, firstDraftValid, loopsToValid, correctBlockChoice, ranSuccessfully, passed, score, deterministic: true, rounds };
}
