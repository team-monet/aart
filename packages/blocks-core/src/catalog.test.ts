import { describe, expect, it } from "vitest";
import { createBlockCatalog, getBlockGroupCounts } from "./catalog.js";
import { createFakeScorerRegistry } from "./test-support/fake-scorer-registry.js";

// A fully-injected catalog (real scorer registry fake) so metadata/shape
// assertions below don't depend on @aart/evidence's stub state — manifest
// construction itself never depends on injection (see catalog.ts's doc
// comment), but building via createBlockCatalog(deps) here matches how a
// real composition root would call it once S9 merges the real S6 package.
const catalog = createBlockCatalog({ scorerRegistry: createFakeScorerRegistry() });

describe("createBlockCatalog", () => {
  it("assembles exactly 51 blocks total (spec §15.1-15.3's full core-builtin catalog minus llm.*/S7)", () => {
    expect(catalog).toHaveLength(51);
  });

  it("matches the DoD's exact per-group counts (11 groups covering the 13 core-builtin namespaces)", () => {
    expect(getBlockGroupCounts()).toEqual({
      browser: 11, // incl. web.read
      http: 3,
      data: 6,
      file: 4,
      flow: 4,
      wait: 6,
      human: 3,
      assert: 7,
      artifactReport: 4,
      command: 1,
      eval: 2,
    });
  });

  it("every block id is unique", () => {
    const ids = catalog.map((block) => block.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every block id is namespaced as <namespace>.<name>, one of the 13 core-builtin namespaces", () => {
    const allowedNamespaces = new Set([
      "browser",
      "web",
      "http",
      "file",
      "data",
      "flow",
      "wait",
      "human",
      "assert",
      "artifact",
      "report",
      "command",
      "eval",
    ]);
    for (const block of catalog) {
      const namespace = block.manifest.id.split(".")[0];
      expect(allowedNamespaces.has(namespace ?? ""), `unexpected namespace on block id "${block.manifest.id}"`).toBe(true);
    }
  });

  // --- The metadata-completeness test named explicitly in this session's
  // brief: "a test that walks every block's manifest and confirms it has,
  // at minimum, a description, an input schema, an output schema, and a
  // declared capability set (possibly empty)." (implementation plan §3,
  // S3 DoD). See this session's final report for a flagged discrepancy
  // between this exact plan-document wording and the task briefing's own
  // shorthand ("description/category/examples") — BlockManifest (frozen,
  // packages/types/src/block.ts) has no `examples` field at all, so this
  // test covers exactly what the plan document (the authoritative, freshly
  // -read primary source) actually specifies, plus `category` as a bonus
  // check (this package's own internal discipline, not a frozen-type
  // requirement).
  it("metadata completeness: every block declares a description, input schema, output schema, and capability set", () => {
    for (const block of catalog) {
      const { manifest } = block;
      expect(typeof manifest.id, `${manifest.id}: id`).toBe("string");
      expect(manifest.id.length, `${manifest.id}: id must be non-empty`).toBeGreaterThan(0);

      expect(typeof manifest.description, `${manifest.id}: description`).toBe("string");
      expect(manifest.description.length, `${manifest.id}: description must be non-empty`).toBeGreaterThan(0);

      expect(manifest.inputSchema, `${manifest.id}: inputSchema`).toBeTypeOf("object");
      expect(manifest.inputSchema, `${manifest.id}: inputSchema must not be null`).not.toBeNull();

      expect(manifest.outputSchema, `${manifest.id}: outputSchema`).toBeTypeOf("object");
      expect(manifest.outputSchema, `${manifest.id}: outputSchema must not be null`).not.toBeNull();

      expect(Array.isArray(manifest.capabilities), `${manifest.id}: capabilities must be an array (possibly empty)`).toBe(true);
      for (const capability of manifest.capabilities) {
        expect(typeof capability, `${manifest.id}: each capability must be a string`).toBe("string");
      }
    }
  });

  it("bonus completeness check (this package's own discipline, beyond the frozen type's minimum): every block declares a non-empty category", () => {
    for (const block of catalog) {
      expect(typeof block.manifest.category, `${block.manifest.id}: category`).toBe("string");
      expect((block.manifest.category ?? "").length, `${block.manifest.id}: category must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("bonus completeness check: every description reads as a real sentence with a worked example (not a bare label) — a heuristic length/format floor, not a semantic guarantee", () => {
    for (const block of catalog) {
      expect(block.manifest.description.length, `${block.manifest.id}: description too short to plausibly carry a worked example`).toBeGreaterThan(
        20,
      );
    }
  });

  it("every block declares a version", () => {
    for (const block of catalog) {
      expect(typeof block.manifest.version, `${block.manifest.id}: version`).toBe("string");
      expect(block.manifest.version.length).toBeGreaterThan(0);
    }
  });

  // --- Capability-declaration correctness spot checks (DoD: "every
  // block's manifest-level capability declaration must be correct and
  // tested, since an under-declared capability is a security hole ... and
  // an over-declared one is a usability regression"). Per-block reasoning
  // lives in each block's own module doc comment; this is the catalog-wide
  // cross-check that the notable/non-obvious ones actually landed as
  // designed.
  it("capability declarations: the notable non-obvious cases are exactly as designed", () => {
    const byId = new Map(catalog.map((b) => [b.manifest.id, b.manifest]));
    // Blocks that write an artifact via ctx.writeArtifact declare file.write
    // in ADDITION to their primary I/O capability (spec §31.1's file.write
    // <-> artifact.write pairing, extended consistently to every other
    // artifact-writing block in this catalog).
    expect(byId.get("artifact.write")?.capabilities).toEqual(["file.write"]);
    expect(byId.get("browser.screenshot")?.capabilities).toEqual(["browser", "file.write"]);
    expect(byId.get("http.download")?.capabilities).toEqual(["http", "file.write"]);
    expect(byId.get("eval.run")?.capabilities).toEqual(["file.write", "llm"]);
    // eval.score defensively declares "llm" for the llm_judge kind even
    // though 11 of 12 scorer kinds don't need it (kind is a runtime input,
    // not knowable at manifest-declaration time).
    expect(byId.get("eval.score")?.capabilities).toEqual(["llm"]);
    // assert.* is capability-free EXCEPT the two that touch real state.
    expect(byId.get("assert.equals")?.capabilities).toEqual([]);
    expect(byId.get("assert.artifact_exists")?.capabilities).toEqual(["file.read"]);
    expect(byId.get("assert.no_console_errors")?.capabilities).toEqual(["browser"]);
    // Wait/human wait-shaped blocks construct a value, they don't perform
    // I/O themselves — all capability-free, including human.approval and
    // human.correct (both wait-shaped) and human.review (a marker).
    for (const id of ["wait.for_signal", "wait.until", "wait.for_webhook", "wait.for_external_job", "wait.for_queue", "wait.manual", "human.approval", "human.correct", "human.review"]) {
      expect(byId.get(id)?.capabilities, id).toEqual([]);
    }
    // command.run is the one High-risk "command" capability in the catalog.
    expect(byId.get("command.run")?.capabilities).toEqual(["command"]);
  });
});
