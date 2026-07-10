// adoption.ts — spec §32.4's fourth named metric: "unprompted-adoption rate
// (measured in a harness where AART competes against generic tools the
// model could reach for instead — shell, raw fetch, ad hoc scripts)." A
// genuinely different harness shape from the authoring-task scoring in
// scoring.ts (that one asks "did the model use AART correctly"; this one
// asks "did the model reach for AART at all, unprompted, when a generic
// alternative was equally available").
export interface ChoiceTask {
  id: string;
  /** A prompt presenting a scenario where the model could reach for AART OR a generic tool, without AART being named/mandated in the prompt itself. */
  prompt: string;
}

export interface ChoiceResult {
  taskId: string;
  /** True iff the model's response shows an AART-native invocation (a `uses:` block reference, an `aart` CLI invocation, a recognizable block-namespace call). */
  choseAart: boolean;
}

const AART_MARKERS = ["uses:", "aart ", "browser.", "http.request", "file.", "assert.", "artifact.", "flow.", "llm."];

/**
 * A deterministic, string-based detector for tool choice. Intentionally
 * simple (string-sniffing rawOutput for AART-block-shaped tokens): this
 * metric's own harness design (multiple *real* candidate tools genuinely
 * offered to a model, not just text pattern-matched after the fact) is a
 * fuller apparatus this package's fake-model, offline-testing scope
 * doesn't need — a natural extension point once real target models are
 * wired in (S9's baseline run). See this task's report.
 */
export function scoreToolChoice(task: ChoiceTask, rawOutput: string): ChoiceResult {
  const lower = rawOutput.toLowerCase();
  const choseAart = AART_MARKERS.some((marker) => lower.includes(marker));
  return { taskId: task.id, choseAart };
}
