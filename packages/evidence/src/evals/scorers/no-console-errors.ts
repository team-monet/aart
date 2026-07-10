// no-console-errors.ts — "no console errors", spec §24.3 (the eval-scorer
// counterpart to the assert.no_console_errors BLOCK, spec §15.3 — that
// block is @aart/blocks-core/S3's scope; this is the scorer-kind used when
// grading an eval example against captured console output). Convention
// (undocumented by spec/architecture, decided here): `actual` is an array
// of console entries carrying at least a `level`.
import type { PureScorerFn } from "./types.js";

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | string;
  text?: string;
  message?: string;
}

function toConsoleEntries(actual: unknown): ConsoleEntry[] {
  if (Array.isArray(actual)) return actual as ConsoleEntry[];
  if (actual && typeof actual === "object" && Array.isArray((actual as { console?: unknown }).console)) {
    return (actual as { console: ConsoleEntry[] }).console;
  }
  return [];
}

export const noConsoleErrors: PureScorerFn = (actual) => {
  const entries = toConsoleEntries(actual);
  const errors = entries.filter((e) => e.level === "error");
  const passed = errors.length === 0;
  return { passed, score: passed ? 1 : 0, deterministic: true, detail: `${errors.length} console error(s) of ${entries.length} total entries` };
};
