// Flow group aggregate (spec §15.3) — the engine's block catalog imports
// this array rather than each flow.* block individually.
import type { BlockImplementation } from "@aart/types";
import { flowSleepBlock } from "./sleep.js";
import { flowFailBlock } from "./fail.js";
import { flowBranchBlock } from "./branch.js";
import { flowNoopBlock } from "./noop.js";

export const FLOW_BLOCKS: BlockImplementation[] = [flowSleepBlock, flowFailBlock, flowBranchBlock, flowNoopBlock];
