import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintRedactionBypass, lintSource } from "./redaction-lint.js";

describe("redaction-bypass lint — catches real bypasses (ADR-10's consequences)", () => {
  it("flags a console.log call with no redaction anywhere nearby", () => {
    const source = `
      export function trace(record: unknown) {
        console.log(record);
      }
    `;
    const findings = lintSource("fake/logger.ts", source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("console.*");
  });

  it("flags a store write call site (store.runs.put) with no redaction", () => {
    const source = `
      export async function persistRun(store: AartStore, run: RunRecord) {
        await store.runs.put(run);
      }
    `;
    const findings = lintSource("fake/persist.ts", source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("store write");
  });

  it("flags an MCP tool return with no redaction, in a file under an mcp/ directory", () => {
    const source = `
      export async function handleGetRun(runId: string) {
        const run = await store.runs.get(runId);
        return run;
      }
    `;
    const findings = lintSource("/repo/packages/mcp/src/tools/get-run.ts", source);
    expect(findings.some((f) => f.reason.includes("MCP-tool return"))).toBe(true);
  });

  it("does NOT flag files outside an mcp/ directory for bare return statements", () => {
    const source = `
      export function computeSomething(x: number) {
        return x + 1;
      }
    `;
    const findings = lintSource("/repo/packages/engine/src/util.ts", source);
    expect(findings).toHaveLength(0);
  });
});

describe("redaction-bypass lint — does not false-positive on correctly-guarded call sites", () => {
  it("does not flag a store write preceded by a direct redactRecord( call", () => {
    const source = `
      import { redactRecord } from "@aart/governance";
      export async function persistRun(store: AartStore, run: RunRecord, secretRefs: ReadonlySet<string>) {
        const redacted = redactRecord(run, secretRefs);
        await store.runs.put(redacted);
      }
    `;
    const findings = lintSource("fake/persist-guarded.ts", source);
    expect(findings).toHaveLength(0);
  });

  it("does not flag a console.log of an already-redacted value", () => {
    const source = `
      import { redactRecord } from "@aart/governance";
      function log(record: unknown, refs: ReadonlySet<string>) {
        console.log(redactRecord(record, refs));
      }
    `;
    const findings = lintSource("fake/logger-guarded.ts", source);
    expect(findings).toHaveLength(0);
  });
});

describe("redaction-bypass lint — recognizes the engine's constructor-injection pattern (F2 chokepoint fix, this session's own DoD)", () => {
  // This is THE critical test: @aart/engine never imports redactRecord
  // directly (architecture §4.6/§7.9) — it accepts a RedactFn via
  // constructor injection and calls that instead. A lint that only greps
  // for a literal `redactRecord(` import/call would silently MISS every
  // one of the engine's real persist call sites.
  const engineLikeSource = `
    import type { RedactFn } from "@aart/types";

    export class Engine {
      constructor(private readonly redact: RedactFn) {}

      async persistStepTrace(store: AartStore, trace: StepTrace, secretRefs: ReadonlySet<string>) {
        const redacted = this.redact(trace, secretRefs);
        await store.runs.put(redacted);
      }
    }
  `;

  it("does NOT flag the engine-pattern call site — this.redact(...) is recognized as the constructor-injected RedactFn, not a bypass", () => {
    const findings = lintSource("fake/engine.ts", engineLikeSource);
    expect(findings).toHaveLength(0);
  });

  it("STILL flags a sibling call site in the SAME class that skips the injected redactor (proves this isn't just 'the file mentions RedactFn so everything passes')", () => {
    const bypassingEngineSource = `
      import type { RedactFn } from "@aart/types";

      export class Engine {
        constructor(private readonly redact: RedactFn) {}

        async persistStepTrace(store: AartStore, trace: StepTrace, secretRefs: ReadonlySet<string>) {
          const redacted = this.redact(trace, secretRefs);
          await store.runs.put(redacted);
        }

        async persistRunRecordWithoutRedaction(store: AartStore, run: RunRecord) {
          // BUG: forgot to call this.redact(...) before persisting.
          await store.runs.put(run);
        }
      }
    `;
    const findings = lintSource("fake/engine-with-bug.ts", bypassingEngineSource);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.snippet).toContain("store.runs.put(run)");
  });

  it("recognizes a private-field (#redact) constructor-injection form too", () => {
    const source = `
      import type { RedactFn } from "@aart/types";
      export class Engine {
        #redact: RedactFn;
        constructor(redact: RedactFn) { this.#redact = redact; }
        async persist(store: AartStore, record: unknown, refs: ReadonlySet<string>) {
          const safe = this.#redact(record, refs);
          await store.approvals.put(safe);
        }
      }
    `;
    const findings = lintSource("fake/engine-private-field.ts", source);
    expect(findings).toHaveLength(0);
  });
});

describe("lintRedactionBypass — directory walking", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-redaction-lint-walk-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finds a real bypass in an ordinary .ts file", async () => {
    await fs.writeFile(join(root, "handler.ts"), 'export function h(r: unknown) { console.log(r); }\n');
    const findings = await lintRedactionBypass([root]);
    expect(findings).toHaveLength(1);
  });

  it("skips .test.ts and .d.ts files", async () => {
    await fs.writeFile(join(root, "handler.test.ts"), 'console.log("x");\n');
    await fs.writeFile(join(root, "handler.d.ts"), 'console.log("x");\n');
    const findings = await lintRedactionBypass([root]);
    expect(findings).toHaveLength(0);
  });

  it("self-excludes its own redaction-lint.ts / redaction-lint-cli.ts files — scanning the linter's own diagnostic output for redaction bypasses is nonsensical (verified against the real repo during this session: this exact exclusion is what keeps a self-scan clean)", async () => {
    await fs.writeFile(join(root, "redaction-lint.ts"), 'console.error("findings: " + JSON.stringify([]));\n');
    await fs.writeFile(join(root, "redaction-lint-cli.ts"), 'console.log("clean");\n');
    const findings = await lintRedactionBypass([root]);
    expect(findings).toHaveLength(0);
  });

  it("does not error on a root directory that doesn't exist (e.g. a sibling package stub with no src/ yet)", async () => {
    const findings = await lintRedactionBypass([join(root, "does-not-exist")]);
    expect(findings).toHaveLength(0);
  });

  it("recurses into subdirectories, skipping node_modules and dist", async () => {
    await fs.mkdir(join(root, "nested"), { recursive: true });
    await fs.mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(join(root, "dist"), { recursive: true });
    await fs.writeFile(join(root, "nested", "deep.ts"), 'console.log("x");\n');
    await fs.writeFile(join(root, "node_modules", "pkg", "index.ts"), 'console.log("x");\n');
    await fs.writeFile(join(root, "dist", "index.ts"), 'console.log("x");\n');
    const findings = await lintRedactionBypass([root]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toContain("nested");
  });
});

describe("self-check — this package's OWN real source must stay clean (runs on every `pnpm test`, not just a manual CLI invocation)", () => {
  // This is a belt-and-suspenders addition beyond this session's own DoD
  // note ("S9 verifies it actually runs in CI") — S9 wires the lint into
  // repo-wide CI across every Wave-1 package; this test wires it into
  // @aart/governance's OWN automated suite specifically, so a regression
  // introduced by a future change to THIS package doesn't have to wait for
  // that cross-repo CI step to be caught. Found and fixed two real
  // findings this exact way during this session (this package's own
  // approval-tasks.ts, and this lint's own CLI diagnostic output) — this
  // test locks in "stays clean," it doesn't just hope it does.
  it("packages/governance/src has zero redaction-bypass findings", async () => {
    const srcDir = new URL("./", import.meta.url).pathname;
    const findings = await lintRedactionBypass([srcDir]);
    expect(findings).toEqual([]);
  });
});
