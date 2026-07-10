import type { BlockImplementation } from "@aart/types";
import { humanReviewBlock } from "./review.js";
import { humanApprovalBlock } from "./approval.js";
import { humanCorrectBlock } from "./correct.js";

/** The Human group — human.review (non-blocking marker), human.approval and human.correct (both wait-shaped via the frozen WaitCondition{type:"approval"} member — see approval.ts/correct.ts's module doc comments). */
export const HUMAN_BLOCKS: BlockImplementation[] = [humanReviewBlock, humanApprovalBlock, humanCorrectBlock];
