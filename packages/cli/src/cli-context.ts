// The CLI's composition root — wraps @aart/mcp's shared createAartContext/
// createRealAartContextWithEngine (so `aart run`/`aart validate`/etc.
// dispatch through the exact same handler functions aart_run_workflow/
// aart_validate/etc. do) plus a ServerPort (worker/server/bundle/flag —
// architecture §13.3's stated exception, never exposed via MCP).
//
// AMENDMENTS.md A42: the DEFAULT here is now the REAL stack —
// createRealAartContextWithEngine + createRealServerPort (real-server-port.ts)
// — matching every other production composition root in this codebase
// (@aart/mcp's own bin/E2E entry points already defaulted to
// createRealAartContext; this package was the one holdout still
// unconditionally stub-bound, per A33/A37's findings). `aart run`/`aart
// worker`/`aart server`/`aart bundle`/`aart mcp` — everything bin.ts
// dispatches to — now execute for real.
//
// The STUB composition (createAartContext + createStubServerPort) is kept
// alive, not deleted — this package's own fast/offline/deterministic unit
// test suite is deliberately built against it (context.ts's own doc comment
// on createAartContext explains why: real browser/LLM dispatch has no place
// in a fast unit test). Pass `real: false` to get it — see test-utils.ts's
// createTestCli, the one call site that does.
import {
  createAartContext,
  createRealAartContextWithEngine,
  type AartContext,
  type CreateAartContextOptions,
  type ServerPort,
} from "@aart/mcp";
import { createRealServerPort } from "./real-server-port.js";
import { createStubServerPort } from "./stubs/server.js";

export interface CreateCliContextOptions extends CreateAartContextOptions {
  /** Defaults `true` (every real `aart` invocation). Set `false` only for this package's own fast, offline, stub-engine unit tests (test-utils.ts's `createTestCli`) — see this module's own doc comment. */
  real?: boolean;
}

export interface CliContext {
  aart: AartContext;
  serverPort: ServerPort;
}

export function createCliContext(options: CreateCliContextOptions = {}): CliContext {
  if (options.real === false) {
    const aart = createAartContext(options);
    const serverPort = createStubServerPort(aart.store);
    return { aart, serverPort };
  }

  const { context, engine } = createRealAartContextWithEngine(options);
  if (!engine) {
    // Only reachable if a caller overrides BOTH options.engine and
    // options.evidence, leaving createRealAartContextWithEngine with no
    // real Engine instance to hand back (see its own doc comment). No real
    // call site does this — bin.ts passes no port overrides at all — so
    // this is a defensive, clearly-worded failure rather than silently
    // constructing a SECOND, divergent Engine for the real ServerPort to
    // use instead (which would break the "one Engine, one store, shared by
    // every port in this process" invariant every other real composition
    // root in this codebase upholds).
    throw new Error(
      "createCliContext: the real ServerPort needs a real Engine instance; do not override both options.engine and options.evidence together, or pass { real: false } for the stub composition instead.",
    );
  }
  const serverPort = createRealServerPort(context.store, engine);
  return { aart: context, serverPort };
}
