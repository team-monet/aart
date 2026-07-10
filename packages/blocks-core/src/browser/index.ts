import type { BlockImplementation } from "@aart/types";
import { browserGotoBlock } from "./goto.js";
import { browserClickBlock } from "./click.js";
import { browserBackBlock } from "./back.js";
import { browserFillBlock } from "./fill.js";
import { browserTextVisibleBlock } from "./text-visible.js";
import { browserExtractTextBlock } from "./extract-text.js";
import { browserHtmlBlock } from "./html.js";
import { browserEvalBlock } from "./eval.js";
import { browserSnapshotBlock } from "./snapshot.js";
import { browserScreenshotBlock } from "./screenshot.js";
import { webReadBlock } from "./web-read.js";

/** 11 blocks — spec §15.3's Browser group, plus `web.read` folded in per this session's grouping (S3 DoD note: "web folded into Browser"). */
export const BROWSER_BLOCKS: BlockImplementation[] = [
  browserGotoBlock,
  browserClickBlock,
  browserBackBlock,
  browserFillBlock,
  browserTextVisibleBlock,
  browserExtractTextBlock,
  browserHtmlBlock,
  browserEvalBlock,
  browserSnapshotBlock,
  browserScreenshotBlock,
  webReadBlock,
];
