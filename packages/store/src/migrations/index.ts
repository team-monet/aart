export { migration0001Init } from "./0001_init.js";
export { MigrationRunner, type Migration, type MigrationWatermarkStore } from "./types.js";

import { migration0001Init } from "./0001_init.js";
import type { Migration } from "./types.js";

/** Every migration registered for this store, in the order they're defined (MigrationRunner sorts by ordinal regardless). Wave-1/Wave-2 sessions append new migrations here as the schema evolves. */
export const ALL_MIGRATIONS: Migration[] = [migration0001Init];
