import type { BlockImplementation } from "@aart/types";
import { waitForSignalBlock } from "./for-signal.js";
import { waitUntilBlock } from "./until.js";
import { waitForWebhookBlock } from "./for-webhook.js";
import { waitForExternalJobBlock } from "./for-external-job.js";
import { waitForQueueBlock } from "./for-queue.js";
import { waitManualBlock } from "./manual.js";

/** The Wait group — one block per WaitCondition union member (packages/types/src/wait.ts's 7-member discriminated union) except "approval", which is human.approval's job (human/approval.ts) since that member is inherently a human-decision wait, not a plain engine-mechanism wait. */
export const WAIT_BLOCKS: BlockImplementation[] = [
  waitForSignalBlock,
  waitUntilBlock,
  waitForWebhookBlock,
  waitForExternalJobBlock,
  waitForQueueBlock,
  waitManualBlock,
];
