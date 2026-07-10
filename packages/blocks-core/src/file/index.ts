// File group aggregate (spec §15.3) — the engine's block catalog imports
// this array rather than each file.* block individually.
import type { BlockImplementation } from "@aart/types";
import { fileReadBlock } from "./read.js";
import { fileWriteBlock } from "./write.js";
import { fileExistsBlock } from "./exists.js";
import { fileListBlock } from "./list.js";

export const FILE_BLOCKS: BlockImplementation[] = [fileReadBlock, fileWriteBlock, fileExistsBlock, fileListBlock];
