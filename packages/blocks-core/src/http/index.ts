// HTTP group aggregate (spec §15.3) — the engine's block catalog imports
// this array rather than each http.* block individually.
import type { BlockImplementation } from "@aart/types";
import { httpRequestBlock } from "./request.js";
import { httpDownloadBlock } from "./download.js";
import { httpHealthCheckBlock } from "./health-check.js";

export const HTTP_BLOCKS: BlockImplementation[] = [httpRequestBlock, httpDownloadBlock, httpHealthCheckBlock];
