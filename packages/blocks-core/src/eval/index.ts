// The Eval group's composition entrypoint — a FACTORY, not a plain BLOCKS
// array (contrast wait/index.ts, human/index.ts), because both blocks here
// need a ScorerRegistryPort injected at construction time. See
// scorer-registry-port.ts's module doc comment for the injected -> real
// @aart/evidence -> throw resolution order (deliberately no local
// fallback, unlike the report renderers port).
import type { BlockImplementation } from "@aart/types";
import { createEvalRunBlock } from "./run.js";
import { createEvalScoreBlock } from "./score.js";
import type { ScorerRegistryPort } from "./scorer-registry-port.js";

export function createEvalBlocks(deps: { scorerRegistry?: ScorerRegistryPort } = {}): BlockImplementation[] {
  return [createEvalRunBlock(deps.scorerRegistry), createEvalScoreBlock(deps.scorerRegistry)];
}
