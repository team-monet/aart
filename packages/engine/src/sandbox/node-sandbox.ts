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
import { BlockManifestSchema, TimeoutError, type BlockManifest } from "@aart/types";

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

export interface CommonJsBlockSandboxOptions {
  /** Complete source of a self-contained CommonJS block module. */
  source: string;
  expectedId: string;
  resolvedInputs: unknown;
  /** Only non-secret trace correlation metadata crosses the isolate boundary. */
  executionContext: {
    runId: string;
    stepId: string;
  };
  memoryLimitMb?: number;
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
 * Inspects a public Pack's CommonJS module inside a disposable isolate.
 * Running the module is necessary to obtain its exported manifest, but this
 * function never evaluates it in the host process: `require`, `process`,
 * network, filesystem, and host globals are absent.
 */
export function inspectCommonJsBlockSourceSync(
  source: string,
  expectedId: string,
  options: { memoryLimitMb?: number; timeoutMs?: number } = {},
): BlockManifest {
  const result = evaluateCommonJsBlockSync({
    source,
    expectedId,
    memoryLimitMb: options.memoryLimitMb,
    timeoutMs: options.timeoutMs,
    mode: "inspect",
  }) as { manifest?: unknown; executeType?: unknown; executeTag?: unknown };
  return validateInspectedCommonJsBlock(result, expectedId);
}

function validateInspectedCommonJsBlock(
  result: { manifest?: unknown; executeType?: unknown; executeTag?: unknown },
  expectedId: string,
): BlockManifest {
  const parsed = BlockManifestSchema.safeParse(result.manifest);
  if (!parsed.success || result.executeType !== "function") {
    throw new Error(`block ${expectedId} must export a valid { manifest, execute } implementation`);
  }
  if (result.executeTag !== "[object Function]") {
    throw new Error(`public Pack block ${expectedId} must use a synchronous execute() function`);
  }
  if (parsed.data.id !== expectedId) {
    throw new Error(`block file ${expectedId}.cjs exports manifest id "${parsed.data.id}"`);
  }
  if (parsed.data.capabilities.length > 0) {
    throw new Error(
      `public Pack block ${expectedId} declares unsupported ambient capabilities (${parsed.data.capabilities.join(", ")}); ` +
        "Pack block execution is currently limited to pure JSON transforms inside the zero-ambient-capability sandbox",
    );
  }
  return parsed.data;
}

/**
 * Executes a previously inspected public Pack block in a fresh isolate.
 * The source is re-evaluated in the isolate for each dispatch, so neither
 * module state nor attacker-controlled globals survive between runs.
 */
export async function runCommonJsBlockSandbox(options: CommonJsBlockSandboxOptions): Promise<unknown> {
  // Runtime re-inspection and dispatch both use isolated-vm's asynchronous
  // evaluation path. A slow Pack transform must not block host timers,
  // worker lease heartbeats, health checks, or unrelated HTTP requests.
  const inspection = (await evaluateCommonJsBlock({
    source: options.source,
    expectedId: options.expectedId,
    memoryLimitMb: options.memoryLimitMb,
    timeoutMs: options.timeoutMs,
    mode: "inspect",
  })) as { manifest?: unknown; executeType?: unknown; executeTag?: unknown };
  validateInspectedCommonJsBlock(inspection, options.expectedId);
  return evaluateCommonJsBlock({
    ...options,
    mode: "execute",
  });
}

type CommonJsEvaluationOptions = Omit<CommonJsBlockSandboxOptions, "resolvedInputs" | "executionContext"> &
  Partial<Pick<CommonJsBlockSandboxOptions, "resolvedInputs" | "executionContext">> & {
    mode: "inspect" | "execute";
  };

async function evaluateCommonJsBlock(options: CommonJsEvaluationOptions): Promise<unknown> {
  const memoryLimit = options.memoryLimitMb ?? 8;
  const timeout = options.timeoutMs ?? 5_000;
  const isolate = new ivm.Isolate({ memoryLimit });
  try {
    const context = await isolate.createContext();
    await context.global.set("__AART_INPUT_JSON__", JSON.stringify(options.resolvedInputs ?? null));
    await context.global.set(
      "__AART_CONTEXT_JSON__",
      JSON.stringify(options.executionContext ?? { runId: "", stepId: "" }),
    );
    const wrapped = commonJsProgram(options);
    let resultJson: string;
    try {
      resultJson = (await context.eval(wrapped, { timeout })) as string;
    } catch (err) {
      throw classifySandboxError(err);
    }
    return parseCommonJsResult(resultJson, options.expectedId);
  } finally {
    isolate.dispose();
  }
}

function evaluateCommonJsBlockSync(options: CommonJsEvaluationOptions): unknown {
  const memoryLimit = options.memoryLimitMb ?? 8;
  const timeout = options.timeoutMs ?? 5_000;
  const isolate = new ivm.Isolate({ memoryLimit });
  try {
    const context = isolate.createContextSync();
    context.global.setSync("__AART_INPUT_JSON__", JSON.stringify(options.resolvedInputs ?? null));
    context.global.setSync(
      "__AART_CONTEXT_JSON__",
      JSON.stringify(options.executionContext ?? { runId: "", stepId: "" }),
    );
    const wrapped = commonJsProgram(options);
    let resultJson: string;
    try {
      resultJson = context.evalSync(wrapped, { timeout }) as string;
    } catch (err) {
      throw classifySandboxError(err);
    }
    return parseCommonJsResult(resultJson, options.expectedId);
  } finally {
    isolate.dispose();
  }
}

function commonJsProgram(options: CommonJsEvaluationOptions): string {
  const operation =
    options.mode === "inspect"
      ? `return JSON.stringify({
          manifest: candidate && candidate.manifest,
          executeType: candidate && typeof candidate.execute,
          executeTag: candidate && Object.prototype.toString.call(candidate.execute)
        });`
      : `
        if (!candidate || typeof candidate !== "object" || typeof candidate.execute !== "function") {
          throw new Error("block ${escapeForDoubleQuotedString(options.expectedId)} must export { manifest, execute }");
        }
        var result = candidate.execute(
          JSON.parse(__AART_INPUT_JSON__),
          JSON.parse(__AART_CONTEXT_JSON__)
        );
        if (result && typeof result.then === "function") {
          throw new Error("public Pack block execute() must return synchronously; asynchronous host capabilities are not available inside the Pack sandbox");
        }
        return JSON.stringify(result === undefined ? null : result);
      `;
  return `
      (function () {
        "use strict";
        var Date = (function (NativeDate) {
          var safePrototype = Object.create(null);
          function DeterministicDate() {
            if (!new.target || arguments.length === 0) {
              throw new Error("public Pack blocks cannot read ambient time; pass time as an explicit input");
            }
            var instance = Reflect.construct(NativeDate, Array.from(arguments));
            Object.setPrototypeOf(instance, safePrototype);
            return instance;
          }
          DeterministicDate.now = function () {
            throw new Error("public Pack blocks cannot read ambient time; pass time as an explicit input");
          };
          DeterministicDate.parse = NativeDate.parse;
          DeterministicDate.UTC = NativeDate.UTC;
          for (var key of Reflect.ownKeys(NativeDate.prototype)) {
            if (key !== "constructor") {
              Object.defineProperty(safePrototype, key, Object.getOwnPropertyDescriptor(NativeDate.prototype, key));
            }
          }
          Object.defineProperty(safePrototype, "constructor", {
            value: DeterministicDate,
            writable: false,
            configurable: false
          });
          Object.freeze(safePrototype);
          DeterministicDate.prototype = safePrototype;
          Object.freeze(DeterministicDate);
          return DeterministicDate;
        })(globalThis.Date);
        var Math = (function (NativeMath) {
          var DeterministicMath = Object.create(null);
          for (var key of Reflect.ownKeys(NativeMath)) {
            if (key !== "random") {
              Object.defineProperty(DeterministicMath, key, Object.getOwnPropertyDescriptor(NativeMath, key));
            }
          }
          Object.defineProperty(DeterministicMath, "random", {
            value: function () {
              throw new Error("public Pack blocks cannot use ambient randomness; pass a deterministic value as an explicit input");
            }
          });
          return DeterministicMath;
        })(globalThis.Math);
        Object.freeze(Math);
        Object.defineProperty(globalThis, "Date", { value: Date, writable: false, configurable: false });
        Object.defineProperty(globalThis, "Math", { value: Math, writable: false, configurable: false });
        var module = { exports: {} };
        var exports = module.exports;
        ${options.source}
        var candidate =
          module.exports && typeof module.exports === "object" && "default" in module.exports
            ? module.exports.default
            : module.exports;
        ${operation}
      })();
    `;
}

function parseCommonJsResult(resultJson: string, expectedId: string): unknown {
  try {
    return JSON.parse(resultJson);
  } catch {
    throw new Error(`public Pack block ${expectedId} returned a value that did not round-trip through JSON`);
  }
}

function escapeForDoubleQuotedString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
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
