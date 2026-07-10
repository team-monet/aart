import type { BlockImplementation } from "@aart/types";
import { assertEqualsBlock } from "./equals.js";
import { assertContainsBlock } from "./contains.js";
import { assertJsonpathBlock } from "./jsonpath.js";
import { assertRegexBlock } from "./regex.js";
import { assertRangeBlock } from "./range.js";
import { assertArtifactExistsBlock } from "./artifact-exists.js";
import { assertNoConsoleErrorsBlock } from "./no-console-errors.js";

/** 7 blocks — spec §15.3's Assert group. Capability-free except assert.artifact_exists (["file.read"]) and assert.no_console_errors (["browser"]) — both perform a real read against live state, unlike the other 5's pure data comparisons. */
export const ASSERT_BLOCKS: BlockImplementation[] = [
  assertEqualsBlock,
  assertContainsBlock,
  assertJsonpathBlock,
  assertRegexBlock,
  assertRangeBlock,
  assertArtifactExistsBlock,
  assertNoConsoleErrorsBlock,
];
