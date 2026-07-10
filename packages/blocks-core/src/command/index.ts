import type { BlockImplementation } from "@aart/types";
import { commandRunBlock } from "./run.js";

/** The Command group is a single block per spec §15.3 — `command.run` is explicitly "the only block of execution type `command`". */
export const COMMAND_BLOCKS: BlockImplementation[] = [commandRunBlock];
