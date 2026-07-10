// ADVERSARIAL isolated-vm escape/abuse pass (S9 Phase 3 security review, spec
// §15.1 node-type block sandbox, ADR-08). The existing node-sandbox.test.ts
// covers the baseline no-ambient-capability guarantees (no require/process/
// fs/child_process/fetch/globalThis, memory limit, timeout). This file probes
// AART's OWN wrapping (runNodeSandbox) with active ESCAPE techniques — the
// question is whether the wrapper correctly constrains sandboxed code, NOT
// whether isolated-vm itself is sound (that's the library's concern, out of
// scope). isolated-vm pin: 7.0.0 (packages/engine/package.json).
//
// "[SAFE]" = the escape attempt is correctly contained. "[FINDING]"/"[INFO]"
// = documents a real limitation, cross-referenced to the security-pass report.
import { TimeoutError } from "@aart/types";
import { describe, expect, it } from "vitest";
import { runNodeSandbox } from "./node-sandbox.js";

describe("runNodeSandbox adversarial — breakout attempts", () => {
  it("[SAFE] the classic `constructor.constructor('return process')()` vm-escape returns an ISOLATE-local Function, not host process", async () => {
    // In Node's built-in `vm` module this leaks the host realm; in a true V8
    // isolate the Function constructor builds a function in the ISOLATE's
    // context, where `process` is undefined.
    const result = await runNodeSandbox({
      code: `
        try {
          var f = (function(){}).constructor("return typeof process");
          return { got: f() };
        } catch (e) {
          return { threw: String(e).slice(0, 40) };
        }
      `,
      resolvedInputs: {},
    });
    // Either it threw, or it evaluated to "undefined" — never a live host process.
    expect(result).toEqual({ got: "undefined" });
  });

  it("[SAFE] `this.constructor.constructor` and `globalThis.constructor` give no route to host require/process", async () => {
    const result = await runNodeSandbox({
      code: `
        var reachable = [];
        try { if ((globalThis).constructor.constructor("return typeof require")() !== "undefined") reachable.push("require"); } catch (e) {}
        try { if ((globalThis).constructor.constructor("return typeof process")() !== "undefined") reachable.push("process"); } catch (e) {}
        try { if ((globalThis).constructor.constructor("return typeof globalThis.process")() !== "undefined") reachable.push("gt.process"); } catch (e) {}
        return { reachable: reachable };
      `,
      resolvedInputs: {},
    });
    expect(result).toEqual({ reachable: [] });
  });

  it("[SAFE] prototype pollution INSIDE the isolate does not reach the HOST realm's Object.prototype", async () => {
    await runNodeSandbox({
      code: `
        Object.prototype.__polluted_by_sandbox__ = "yes";
        Array.prototype.__polluted_by_sandbox__ = "yes";
        return { didPollute: ({}).__polluted_by_sandbox__ === "yes" };
      `,
      resolvedInputs: {},
    });
    // The pollution took effect INSIDE the isolate (separate heap) but the host
    // realm — this very test process — is unaffected (isolate has its own prototypes).
    expect(({} as Record<string, unknown>).__polluted_by_sandbox__).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).__polluted_by_sandbox__).toBeUndefined();
  });

  it("[SAFE] no event-loop / timer primitives are injected (setTimeout/setInterval/queueMicrotask/setImmediate all undefined)", async () => {
    const result = await runNodeSandbox({
      code: `return [typeof setTimeout, typeof setInterval, typeof queueMicrotask, typeof setImmediate];`,
      resolvedInputs: {},
    });
    expect(result).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });

  it("[INFO] a returned Promise does not resolve across the boundary — it JSON-serializes to `{}` (node blocks must return sync JSON-serializable values, ADR-08)", async () => {
    // Not an escape, but a correctness boundary worth pinning: async work in a
    // node block is silently dropped rather than awaited.
    const result = await runNodeSandbox({ code: `return Promise.resolve({ secret: 42 });`, resolvedInputs: {} });
    expect(result).toEqual({});
  });

  it("[SAFE] sandboxed code cannot learn host filesystem paths from its OWN error stacks (isolate frames are abstracted to `<isolated-vm>`)", async () => {
    // The security-relevant question is what the SANDBOX can observe. (The host's
    // own re-thrown Error naturally includes a host call frame for node-sandbox.ts
    // — that trace belongs to the engine, is never exposed to sandboxed code, and
    // is not a leak.) From INSIDE, an error stack must reveal no host paths.
    const inside = (await runNodeSandbox({
      code: `try { throw new Error("introspect"); } catch (e) { return { stack: String(e.stack || "") }; }`,
      resolvedInputs: {},
    })) as { stack: string };
    expect(inside.stack).toContain("introspect");
    expect(inside.stack).toContain("<isolated-vm>"); // isolate frames, abstracted
    expect(inside.stack).not.toMatch(/\/Users\//);
    expect(inside.stack).not.toMatch(/node_modules/);
    expect(inside.stack).not.toMatch(/packages\/engine/);
  });

  it("[SAFE] dynamic code generation inside the isolate (eval / new Function) stays contained — no host require/process", async () => {
    // Even codegen at runtime builds functions in the ISOLATE's realm; a block
    // author 'breaking out' via eval/Function just runs more isolate code.
    const result = await runNodeSandbox({
      code: `return { viaEval: eval("typeof process"), viaFunction: (new Function("return typeof require"))(), viaGt: eval("typeof globalThis.process") };`,
      resolvedInputs: {},
    });
    expect(result).toEqual({ viaEval: "undefined", viaFunction: "undefined", viaGt: "undefined" });
  });
});

describe("runNodeSandbox adversarial — resource-exhaustion / DoS attempts", () => {
  it("[SAFE] an infinite loop is bounded by the wall-clock timeout (TimeoutError), not a host hang", async () => {
    const start = Date.now();
    await expect(runNodeSandbox({ code: `while (true) { Math.sqrt(2); }`, resolvedInputs: {}, timeoutMs: 200 })).rejects.toThrow(TimeoutError);
    expect(Date.now() - start).toBeLessThan(5_000); // interrupted promptly, nowhere near a hang
  });

  it("[SAFE] a tight synchronous allocation loop is bounded by the memory limit rather than exhausting host memory", async () => {
    await expect(
      runNodeSandbox({
        code: `var a = []; while (true) { a.push(new Array(100000).fill("x").join("")); }`,
        resolvedInputs: {},
        memoryLimitMb: 8,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });

  it("[SAFE/PROBE] Atomics.wait on a SharedArrayBuffer cannot block the host past the isolate's wall-clock timeout", async () => {
    // A known technique for defeating cooperative-interrupt timeouts: block on a
    // primitive V8's TerminateExecution can't unwind. Probe whether SAB/Atomics
    // are even reachable, and if so whether the timeout still bounds them.
    const start = Date.now();
    let outcome: string;
    try {
      await runNodeSandbox({
        code: `
          if (typeof SharedArrayBuffer === "undefined" || typeof Atomics === "undefined") { return "no-sab"; }
          var ia = new Int32Array(new SharedArrayBuffer(8));
          Atomics.wait(ia, 0, 0, 1500); // try to block 1.5s
          return "waited-full";
        `,
        resolvedInputs: {},
        timeoutMs: 200,
      });
      outcome = "resolved";
    } catch {
      outcome = "threw";
    }
    const elapsed = Date.now() - start;
    // Safe outcomes: SAB unavailable, OR the timeout interrupted it (< ~600ms),
    // OR Atomics.wait threw (main-thread Atomics.wait is disallowed in many
    // builds). A finding would be `elapsed >= ~1500` (the isolate blocked the
    // host thread for the full Atomics timeout, unbounded by timeoutMs).
    expect(elapsed).toBeLessThan(1_400);
  });

  it("[SAFE] returning a huge string is bounded by the memory limit (does not crash or OOM the host)", async () => {
    // A large result must be materialized inside the isolate before crossing the
    // boundary — the isolate memory limit should catch a result far larger than it.
    await expect(
      runNodeSandbox({
        code: `var s = "x"; while (s.length < 200000000) { s = s + s; } return s;`,
        resolvedInputs: {},
        memoryLimitMb: 16,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });
});

describe("runNodeSandbox adversarial — data-isolation", () => {
  it("[SAFE] sandboxed code sees ONLY its own injected input, not any other host/engine state", async () => {
    const result = await runNodeSandbox({
      code: `
        // Try to discover anything the host might have leaked onto global scope.
        var globals = Object.getOwnPropertyNames(globalThis);
        var suspicious = globals.filter(function (k) {
          return /secret|token|resolveSecret|store|config|engine|process|require|__AART_ENGINE/i.test(k);
        });
        return { input: input, suspicious: suspicious };
      `,
      resolvedInputs: { onlyThis: "is-visible" },
    });
    expect(result).toEqual({ input: { onlyThis: "is-visible" }, suspicious: [] });
  });

  it("[SAFE] a fresh isolate per call — no state persists between two runNodeSandbox invocations", async () => {
    await runNodeSandbox({ code: `globalThis.__leftover__ = "from-call-1"; return 1;`, resolvedInputs: {} });
    const result = await runNodeSandbox({ code: `return typeof globalThis.__leftover__;`, resolvedInputs: {} });
    expect(result).toBe("undefined");
  });
});
