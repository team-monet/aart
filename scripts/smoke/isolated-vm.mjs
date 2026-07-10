#!/usr/bin/env node
// Platform smoke test — isolated-vm (implementation plan §2/§6 Risk 3
// mitigation): spins up one isolated-vm Isolate + Context and confirms it
// can actually execute JS and return a value across the isolate boundary.
// isolated-vm is a native addon (V8 isolate bindings) — this is exactly the
// kind of dependency that can have build/install friction across Node
// versions or CI runner architectures, which is why this is surfaced now,
// at the foundation layer, rather than whenever S1 (which owns the
// node-type block sandbox, ADR-08) first depends on it working.
import ivm from "isolated-vm";

async function main() {
  console.log("[smoke:isolated-vm] creating isolate...");
  const isolate = new ivm.Isolate({ memoryLimit: 8 });
  try {
    const context = await isolate.createContext();
    const result = await context.eval("1 + 1");
    if (result !== 2) {
      throw new Error(`expected eval("1 + 1") to return 2, got ${JSON.stringify(result)}`);
    }
    console.log("[smoke:isolated-vm] OK — isolate created, context created, eval executed and returned correctly.");
  } finally {
    isolate.dispose();
  }
}

main().catch((err) => {
  console.error("[smoke:isolated-vm] FAILED —", err);
  process.exitCode = 1;
});
