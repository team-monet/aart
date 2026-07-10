// Thin convenience wrapper around @aart/store's shared structured logger
// (architecture §16/ADR-16) — every @aart/server subsystem (ticker, worker,
// trigger intake, HTTP API) gets a `.child({ component: "..." })` logger
// rather than reimplementing logging. No new logging mechanism here: this
// module exists only so call sites import from one local place.
import { createLogger, type Logger, type LogSink } from "@aart/store";

export function createServerLogger(sink?: LogSink): Logger {
  return createLogger({ sink, context: { service: "@aart/server" } });
}

export type { Logger, LogSink } from "@aart/store";
