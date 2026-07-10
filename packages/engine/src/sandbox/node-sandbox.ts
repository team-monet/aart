// isolated-vm execution path for `node`-type blocks (ADR-08, spec §15.1:
// "Custom JavaScript logic"). Engine-owned per implementation plan S1's DoD
// ("node-type block sandboxing... is engine-owned block-type dispatch, not
// S3's scope") — this module IS that ownership: a true V8 isolate gives
// zero ambient capability (no fs/network/`require` reachable from inside
// unless explicitly injected, and this module injects nothing beyond the
// JSON-serialized input), a hard memory limit, and a hard timeout.
//
// Design note (see this session's final report for the fuller rationale):
// the frozen `BlockManifest`/`BlockImplementation` contract (architecture
// §2.5) has no `type` discriminant, so the engine's generic step-dispatch
// loop (step-executor.ts) does not special-case "this is a node block" —
// every non-wait block is dispatched identically via `execute(resolvedInputs,
// ctx)`. This module is instead a standalone, directly-callable, fully
// self-contained sandboxing PRIMITIVE: whoever authors a specific node-type
// `BlockImplementation` (a future @aart/blocks-core or workspace-pack
// block) wires its `execute` to call `runNodeSandbox` with that block's own
// JS source. That keeps the dispatch loop block-type-agnostic while still
// making S1 own and ship the actual sandboxing mechanism, exactly as the
// plan specifies.
import ivm from "isolated-vm";
import { TimeoutError } from "@aart/types";

export interface NodeSandboxOptions {
  /**
   * The block's JS source, as a FUNCTION BODY (not a full program) — this
   * module wraps it as `function(input) { <code> }` and calls the result
   * with the parsed `resolvedInputs`. E.g. `"return { doubled: input.x * 2 };"`.
   * `[DECISION]`: a function-body convention (matching e.g. AWS Lambda
   * inline-code / `new Function(body)` prior art) rather than a bare
   * expression — it's the more familiar shape for multi-statement
   * "custom JavaScript logic" (spec §15.1) and needs no special-casing for
   * single- vs multi-statement bodies.
   */
  code: string;
  resolvedInputs: unknown;
  /** Hard memory ceiling in MB. Default 8 (matches the platform smoke test's own isolate — scripts/smoke/isolated-vm.mjs — a `node`-type block is pure JSON-transform logic, not expected to need more). */
  memoryLimitMb?: number;
  /** Hard wall-clock timeout in ms for the script's execution. Default 5000. */
  timeoutMs?: number;
}

/**
 * Runs `options.code` inside a fresh, disposable V8 isolate and returns its
 * JSON-round-tripped result. Zero ambient capability: nothing is injected
 * into the isolate's global scope besides the JSON-stringified input — no
 * `require`, no `process`, no `fs`, no `console`, no reference back into
 * the host's `global`/`globalThis`. A block author who wants network/fs
 * access must declare the corresponding capability and use the matching
 * capability-providing primitive instead (ADR-08's consequence) — a `node`
 * block structurally cannot reach outside this isolate no matter what its
 * manifest claims (architecture §15 threat-model row 2).
 *
 * Throws `TimeoutError` (`detail.kind: "nodeSandbox"`) on timeout; a plain
 * `Error` for a memory-limit breach or any other isolate/script failure
 * (including the block's own thrown exception, and a non-JSON-serializable
 * return value) — none of `@aart/types`' other nine `AartError` subclasses
 * fit a sandbox failure semantically, and `step-executor.ts` wraps whatever
 * this throws the same way it wraps any other block's thrown error, so no
 * information is lost by not minting an eleventh class.
 */
export async function runNodeSandbox(options: NodeSandboxOptions): Promise<unknown> {
  const memoryLimit = options.memoryLimitMb ?? 8;
  const timeout = options.timeoutMs ?? 5_000;

  const isolate = new ivm.Isolate({ memoryLimit });
  try {
    const context = await isolate.createContext();
    // Deliberately the ONLY thing set on the isolate's global scope: the
    // JSON-serialized input, as a plain string (strings are transferable
    // without `{ copy: true }` reference marshaling, so this can't
    // accidentally leak a live Reference back into the isolate). No
    // `console`, no `require`, no back-reference to this process's
    // `global`/`globalThis` — anything not explicitly set here is simply
    // undefined inside the isolate, which is the actual source of "zero
    // ambient capability," not a denylist this module has to maintain.
    await context.global.set("__AART_INPUT_JSON__", JSON.stringify(options.resolvedInputs ?? null));

    // Output crosses the isolate boundary as a JSON string too (via
    // JSON.stringify inside the isolate), for the same "strings need no
    // copy-marshaling" reason — this sidesteps isolated-vm's Reference/copy
    // semantics for object results entirely, at the cost of requiring a
    // node block's return value to be JSON-serializable, which "pure
    // JSON-transform logic" (ADR-08) already implies.
    const wrapped = `
      (function () {
        "use strict";
        var input = JSON.parse(__AART_INPUT_JSON__);
        var __aartNodeBlockFn = function (input) {
          ${options.code}
        };
        var __aartResult = __aartNodeBlockFn(input);
        return JSON.stringify(__aartResult === undefined ? null : __aartResult);
      })();
    `;

    let resultJson: string;
    try {
      resultJson = (await context.eval(wrapped, { timeout })) as string;
    } catch (err) {
      throw classifySandboxError(err);
    }

    try {
      return JSON.parse(resultJson);
    } catch {
      throw new Error(`node-type block returned a value that did not round-trip through JSON.stringify — node blocks must return JSON-serializable output (ADR-08's "pure JSON-transform logic" constraint).`);
    }
  } finally {
    // Always dispose, even on failure — an undisposed Isolate leaks the V8
    // heap it reserved for `memoryLimit`.
    isolate.dispose();
  }
}

/**
 * isolated-vm surfaces both a script timeout and a memory-limit breach as a
 * thrown `Error` from `context.eval` with no dedicated error subclass to
 * `instanceof`-check — this function classifies by message content (the
 * only signal isolated-vm gives) so callers get `TimeoutError` specifically
 * for the timeout case, matching this package's error-taxonomy discipline
 * (architecture §8) for the one sandbox-failure mode that has a real,
 * frozen home (`TimeoutError`) to map onto.
 */
function classifySandboxError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return new TimeoutError({
      message: `node-type block execution exceeded its sandbox timeout (${message}).`,
      detail: { kind: "nodeSandbox" },
      cause: err,
    });
  }
  // Memory-limit breaches and any other isolate/script failure (including
  // the block's own thrown exception, which isolated-vm re-throws with the
  // isolate-side message/stack) are surfaced as-is, with context added, so
  // step-executor.ts's normal error-wrapping/retry-classification path
  // handles them uniformly with any other block failure.
  return err instanceof Error ? err : new Error(message);
}
