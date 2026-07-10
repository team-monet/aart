import type { BlockImplementation } from "@aart/types";
import { dataPickBlock } from "./pick.js";
import { dataParseBlock } from "./parse.js";
import { dataStringifyBlock } from "./stringify.js";
import { dataMapBlock } from "./map.js";
import { dataFilterBlock } from "./filter.js";
import { dataMergeBlock } from "./merge.js";

/** 6 blocks — spec §15.3's Data group, all capability-free (pure computation over already-resolved data). */
export const DATA_BLOCKS: BlockImplementation[] = [dataPickBlock, dataParseBlock, dataStringifyBlock, dataMapBlock, dataFilterBlock, dataMergeBlock];
