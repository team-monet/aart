// custom-node.ts — "custom node scorer", spec §24.3.
import type { PureScorerFn } from "./types.js";

export interface CustomNodeScorerConfig {
  /**
   * A caller-supplied pure scoring function. Deliberately NOT a
   * sandboxed/eval()'d string: @aart/evidence does not own isolated-vm
   * sandboxing (that's @aart/engine's scope for `node`-type BLOCKS, ADR-08
   * — a different mechanism serving a different purpose from this scorer
   * kind) and eval()-ing an arbitrary scorerConfig string would be a real
   * security foot-gun with no sandbox backing it in this package. This kind
   * is the escape hatch for a caller (a test author, or a future dedicated
   * sandboxed wrapper built elsewhere) to inject an arbitrary pure function
   * programmatically, keeping this scorer itself deterministic and safe.
   */
  fn?: (actual: unknown, expected: unknown) => { passed: boolean; score: number; detail?: string };
}

export const customNode: PureScorerFn = (actual, expected, config) => {
  const fn = (config as CustomNodeScorerConfig | undefined)?.fn;
  if (!fn) {
    throw new Error("custom_node scorer requires config.fn — see CustomNodeScorerConfig's doc comment for why this is a function value, not an eval()'d string");
  }
  const result = fn(actual, expected);
  return { ...result, deterministic: true };
};
