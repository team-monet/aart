import type { BlockImplementation } from "@aart/types";
import { humanReviewBlock } from "./review.js";
import { humanApprovalBlock } from "./approval.js";
import { humanCorrectBlock } from "./correct.js";

/** The Human group — human.approval (the one real Human-group wait, via the frozen WaitCondition{type:"approval"} member — architecture §4.4's exhaustive 7-member wait-block-id list); human.review and human.correct are both non-blocking synchronous markers (see review.ts/correct.ts's module doc comments — correct.ts's covers an S9 integration fix: it used to falsely claim wait-shaped behavior it was never architecturally granted). */
export const HUMAN_BLOCKS: BlockImplementation[] = [humanReviewBlock, humanApprovalBlock, humanCorrectBlock];
