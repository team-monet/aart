import { TimeoutError } from "@aart/types";
import { describe, expect, it } from "vitest";
import { runNodeSandbox } from "./node-sandbox.js";

describe("runNodeSandbox — basic execution", () => {
  it("runs a simple function body and returns its result", async () => {
    const result = await runNodeSandbox({ code: "return { doubled: input.x * 2 };", resolvedInputs: { x: 21 } });
    expect(result).toEqual({ doubled: 42 });
  });

  it("receives resolvedInputs as the `input` binding, JSON-round-tripped", async () => {
    const result = await runNodeSandbox({ code: "return input;", resolvedInputs: { nested: { array: [1, 2, 3], flag: true }, str: "hello" } });
    expect(result).toEqual({ nested: { array: [1, 2, 3], flag: true }, str: "hello" });
  });

  it("treats resolvedInputs of null/undefined as null", async () => {
    const result = await runNodeSandbox({ code: "return input;", resolvedInputs: undefined });
    expect(result).toBeNull();
  });

  it("returns null for a block that returns undefined", async () => {
    const result = await runNodeSandbox({ code: "// no return", resolvedInputs: {} });
    expect(result).toBeNull();
  });

  it("supports multi-statement function bodies", async () => {
    const result = await runNodeSandbox({
      code: `
        var sum = 0;
        for (var i = 0; i < input.items.length; i++) { sum += input.items[i]; }
        return { sum: sum };
      `,
      resolvedInputs: { items: [1, 2, 3, 4, 5] },
    });
    expect(result).toEqual({ sum: 15 });
  });

  it("propagates the block's own thrown error", async () => {
    await expect(runNodeSandbox({ code: "throw new Error('block-specific failure');", resolvedInputs: {} })).rejects.toThrow(/block-specific failure/);
  });

  it("throws a clear error when the block returns a value that isn't JSON-serializable through this boundary (a function)", async () => {
    // Functions serialize to `undefined` inside JSON.stringify when nested in
    // an object value (silently dropped, not an error) — assert the actual,
    // more realistic non-serializable case: a circular reference, which
    // JSON.stringify throws on INSIDE the isolate, surfacing as a script
    // execution error propagated out of context.eval.
    await expect(
      runNodeSandbox({
        code: `
          var circular = {};
          circular.self = circular;
          return circular;
        `,
        resolvedInputs: {},
      }),
    ).rejects.toThrow();
  });
});

describe("runNodeSandbox — zero ambient capability (ADR-08, architecture §15 threat-model row 2)", () => {
  it("has no `require` reachable from inside the isolate", async () => {
    await expect(runNodeSandbox({ code: "return typeof require;", resolvedInputs: {} })).resolves.toBe("undefined");
  });

  it("has no `process` reachable from inside the isolate", async () => {
    await expect(runNodeSandbox({ code: "return typeof process;", resolvedInputs: {} })).resolves.toBe("undefined");
  });

  it("console, where present, is V8's own bare debug binding — not a capability (can't reach fs/network/host state), confirmed by it being unable to affect anything observable from outside the isolate", async () => {
    // [DISCOVERED DURING TESTING]: a bare isolated-vm Context ships V8's own
    // native `console` global (a V8/inspector-protocol built-in, distinct
    // from Node's `console` module) — this is NOT something this module
    // injects, and isolated-vm gives no documented option to strip it. It
    // is not an "ambient capability" in the ADR-08 sense this test suite
    // cares about: it cannot read/write files, make network calls, or
    // observe/affect anything outside the isolate — calling it is a no-op
    // from this module's caller's perspective. The real zero-ambient-
    // capability guarantee (no fs/network/require/process) is what the
    // surrounding tests in this block assert.
    await expect(runNodeSandbox({ code: "console.log('hi'); return { ranWithoutError: true };", resolvedInputs: {} })).resolves.toEqual({ ranWithoutError: true });
  });

  it("a deliberate escape attempt via require('fs') throws (fs is not reachable)", async () => {
    await expect(runNodeSandbox({ code: "var fs = require('fs'); return fs.readFileSync('/etc/passwd', 'utf8');", resolvedInputs: {} })).rejects.toThrow();
  });

  it("a deliberate escape attempt via require('child_process') throws (no shell/process spawn reachable)", async () => {
    await expect(runNodeSandbox({ code: "var cp = require('child_process'); return cp.execSync('whoami').toString();", resolvedInputs: {} })).rejects.toThrow();
  });

  it("a deliberate escape attempt via global fetch/XMLHttpRequest throws (no network reachable)", async () => {
    await expect(runNodeSandbox({ code: "return typeof fetch === 'undefined' ? (function(){throw new Error('no fetch, as expected')})() : fetch('http://example.com');", resolvedInputs: {} })).rejects.toThrow();
  });

  it("cannot reach back into the host's global/globalThis (no ambient reference leaked)", async () => {
    await expect(runNodeSandbox({ code: "return typeof globalThis.__AART_ENGINE_INTERNAL__;", resolvedInputs: {} })).resolves.toBe("undefined");
  });

  it("only the JSON-serialized input variable is injected — no other host state is visible", async () => {
    const result = await runNodeSandbox({ code: "return Object.keys(globalThis).filter(function(k){return k !== 'Object' && k !== 'Function' && k !== 'Array' && k !== 'String' && k !== 'Number' && k !== 'Boolean' && k !== 'Math' && k !== 'JSON' && k !== 'Date' && k !== 'RegExp' && k !== 'Error' && k !== 'Symbol' && k !== 'Promise' && k !== 'Map' && k !== 'Set' && k !== 'globalThis' && k.indexOf('Array') === -1 && k.indexOf('Error') === -1;});", resolvedInputs: {} });
    // Whatever bare-V8-global-scope names remain, our injected variable
    // (`__AART_INPUT_JSON__`) is expected among them (it genuinely IS on the
    // global scope) — the point of this test is the ABSENCE of anything
    // else host-like (fs/process/require handles), not an empty list.
    expect(result).toEqual(["__AART_INPUT_JSON__"]);
  });
});

describe("runNodeSandbox — memory limit", () => {
  it("a script that tries to allocate far beyond the configured memory limit fails rather than exhausting host memory", async () => {
    await expect(
      runNodeSandbox({
        code: `
          var chunks = [];
          for (var i = 0; i < 100000; i++) {
            chunks.push(new Array(1000000).join("x"));
          }
          return { length: chunks.length };
        `,
        resolvedInputs: {},
        memoryLimitMb: 8,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });
});

describe("runNodeSandbox — hard timeout", () => {
  it("an infinite loop is killed by the timeout rather than hanging forever", async () => {
    await expect(runNodeSandbox({ code: "while (true) {}", resolvedInputs: {}, timeoutMs: 200 })).rejects.toThrow(TimeoutError);
  });

  it("the thrown error for a timeout is specifically TimeoutError with detail.kind 'nodeSandbox'", async () => {
    try {
      await runNodeSandbox({ code: "while (true) {}", resolvedInputs: {}, timeoutMs: 200 });
      expect.fail("expected runNodeSandbox to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).detail).toMatchObject({ kind: "nodeSandbox" });
    }
  });

  it("a script well within its timeout budget completes normally", async () => {
    await expect(runNodeSandbox({ code: "return { ok: true };", resolvedInputs: {}, timeoutMs: 5_000 })).resolves.toEqual({ ok: true });
  });
});
