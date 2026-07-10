// Shared structured logger — architecture §16/ADR-16, micro-decision #47.
// A sibling utility inside @aart/store's package (not a dedicated trivial
// package, and not inside @aart/types either — store operations are the
// most universally-called code path across the workspace starting Wave 1,
// per architecture §16's own stated rationale for this placement).
//
// Emits `{ level, msg, runId?, stepId?, workflowId?, ...context }` shaped
// lines through a pluggable sink; no-op by default. Every package that logs
// is expected to use this (architecture ADR-16's consequence: ad hoc
// console.log defeats the point of a structured-log/OTel-bridge floor) —
// S0's job is only to build the utility itself, not to enforce the
// convention across Wave-1 packages.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  runId?: string;
  stepId?: string;
  workflowId?: string;
  [key: string]: unknown;
}

export interface LogLine extends LogContext {
  level: LogLevel;
  msg: string;
  time: string;
}

/** A sink receives every emitted line. The no-op default sink (used when no sink is configured) is intentionally silent — a caller that wants output wires one in explicitly (e.g. a JSON-to-stdout sink for a running process, or an OTel exporter per architecture §16's "optional OTel export... enabled via config"). */
export type LogSink = (line: LogLine) => void;

export const noopSink: LogSink = () => {
  /* intentionally does nothing — the default sink */
};

/** A sink that writes each line as a single JSON-stringified line to stdout/stderr (error/warn to stderr, debug/info to stdout) — the concrete shape a real `aart server`/`aart worker` process would typically configure. Provided here since it's a natural, obvious sink implementation every consuming package would otherwise reimplement identically; still opt-in, never the default. */
export const consoleJsonSink: LogSink = (line) => {
  const json = JSON.stringify(line);
  if (line.level === "error" || line.level === "warn") {
    console.error(json);
  } else {
    console.log(json);
  }
};

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  /** Returns a new Logger with `context` merged into every future call's context (and merged under any per-call context, which wins on key collision) — for threading runId/stepId/workflowId through a call chain without repeating them at every log call site. */
  child(context: LogContext): Logger;
}

function createLoggerWithSink(sink: LogSink, baseContext: LogContext): Logger {
  function emit(level: LogLevel, msg: string, context?: LogContext): void {
    sink({ level, msg, time: new Date().toISOString(), ...baseContext, ...context });
  }
  return {
    debug: (msg, context) => emit("debug", msg, context),
    info: (msg, context) => emit("info", msg, context),
    warn: (msg, context) => emit("warn", msg, context),
    error: (msg, context) => emit("error", msg, context),
    child: (context) => createLoggerWithSink(sink, { ...baseContext, ...context }),
  };
}

/** Creates a Logger. Defaults to the no-op sink (architecture §16: "no-op default") — pass `consoleJsonSink`, or your own `LogSink` (e.g. an OTel bridge), to actually emit anything. */
export function createLogger(options: { sink?: LogSink; context?: LogContext } = {}): Logger {
  return createLoggerWithSink(options.sink ?? noopSink, options.context ?? {});
}

/** A ready-to-use, silent-by-default logger for callers that don't need a custom sink or base context. */
export const logger: Logger = createLogger();
