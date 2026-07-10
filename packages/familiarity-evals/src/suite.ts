// suite.ts — runs the full familiarity-eval suite, aggregating spec §32.4's
// four named metrics: first-draft validity %, loops-to-valid,
// correct-block-choice, unprompted-adoption rate.
import { scoreToolChoice, type ChoiceResult, type ChoiceTask } from "./adoption.js";
import { scoreAuthoringAttempt, type FamiliarityScoreResult } from "./scoring.js";
import type { AuthoringTask, ModelRunner, RunSuccessFn, ValidateFn } from "./types.js";

export interface FamiliarityEvalMetrics {
  firstDraftValidityRate: number;
  /** -1 when no task ever converged (undefined would also be reasonable; -1 keeps this a plain number, matching FamiliarityScoreResult.loopsToValid's own not-converged sentinel). */
  averageLoopsToValid: number;
  correctBlockChoiceRate: number;
  /** undefined when no ChoiceTask/choiceModelRunner was supplied — this metric requires its own (optional) harness, see adoption.ts. */
  unpromptedAdoptionRate?: number;
}

export interface RunFamiliarityEvalSuiteOptions {
  validate: ValidateFn;
  runSuccess?: RunSuccessFn;
  maxCorrectiveRounds?: number;
  choiceTasks?: ChoiceTask[];
  /** Only consulted when `choiceTasks` is supplied. */
  choiceModelRunner?: (task: ChoiceTask) => Promise<string>;
}

export interface RunFamiliarityEvalSuiteResult {
  results: FamiliarityScoreResult[];
  choiceResults: ChoiceResult[];
  metrics: FamiliarityEvalMetrics;
}

/** Runs every task in `tasks` against `modelRunner` (ONE target model per call — registering multiple named models, e.g. "deliberately including one weak model" per spec §32.4, is a caller/S9 concern: call this once per model). */
export async function runFamiliarityEvalSuite(
  tasks: AuthoringTask[],
  modelRunner: ModelRunner,
  options: RunFamiliarityEvalSuiteOptions,
): Promise<RunFamiliarityEvalSuiteResult> {
  const results: FamiliarityScoreResult[] = [];
  for (const task of tasks) {
    results.push(await scoreAuthoringAttempt(task, modelRunner, options));
  }

  const choiceResults: ChoiceResult[] = [];
  if (options.choiceTasks && options.choiceModelRunner) {
    for (const task of options.choiceTasks) {
      const rawOutput = await options.choiceModelRunner(task);
      choiceResults.push(scoreToolChoice(task, rawOutput));
    }
  }

  const n = results.length;
  const converged = results.filter((r) => r.loopsToValid !== -1);
  const metrics: FamiliarityEvalMetrics = {
    firstDraftValidityRate: n === 0 ? 0 : results.filter((r) => r.firstDraftValid).length / n,
    averageLoopsToValid: converged.length === 0 ? -1 : converged.reduce((sum, r) => sum + r.loopsToValid, 0) / converged.length,
    correctBlockChoiceRate: n === 0 ? 0 : results.filter((r) => r.correctBlockChoice).length / n,
    unpromptedAdoptionRate: choiceResults.length === 0 ? undefined : choiceResults.filter((c) => c.choseAart).length / choiceResults.length,
  };

  return { results, choiceResults, metrics };
}
