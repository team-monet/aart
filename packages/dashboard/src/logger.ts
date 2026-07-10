// Dashboard's own structured logger instance — architecture §16/ADR-16:
// "every package that logs must use the shared structured logger." The
// logger utility itself lives in @aart/store (architecture §16's own
// placement rationale: store operations are the most universally-called
// code path); this module just binds a dashboard-scoped child logger, the
// same pattern @aart/server's own logger.ts follows (observed in the S2
// sibling worktree) — no-op sink by default, opt into consoleJsonSink for
// a real running process.
import { createLogger, consoleJsonSink, type Logger, type LogSink } from "@aart/store";

export function createDashboardLogger(sink?: LogSink): Logger {
  return createLogger({ sink, context: { component: "dashboard" } });
}

export { consoleJsonSink };
export type { Logger };
