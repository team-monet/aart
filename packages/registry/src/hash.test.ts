import { describe, expect, it } from "vitest";
import { canonicalize, computePackContentHash } from "./hash.js";

const baseManifest = {
  name: "github",
  version: "0.1.0",
  capabilities: ["github.read", "github.write"],
  secrets: ["GITHUB_TOKEN"],
  blocks: ["github.create_issue", "github.comment_pr", "github.list_pr_files"],
};

const baseBlockSources = {
  "github.create_issue": "export function createIssue() { return 1; }",
  "github.comment_pr": "export function commentPr() { return 2; }",
  "github.list_pr_files": "export function listPrFiles() { return 3; }",
};

describe("computePackContentHash — architecture §11.1", () => {
  it("is deterministic for identical input", () => {
    const a = computePackContentHash(baseManifest, baseBlockSources);
    const b = computePackContentHash(baseManifest, baseBlockSources);
    expect(a).toBe(b);
  });

  it("is prefixed sha256:", () => {
    const hash = computePackContentHash(baseManifest, baseBlockSources);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // The direct mechanical test of "any edit breaks approval seal" (DoD's
  // own framing) — a single-byte change to the manifest invalidates the hash.
  it("a single-byte change to the manifest invalidates the hash", () => {
    const original = computePackContentHash(baseManifest, baseBlockSources);
    const edited = computePackContentHash({ ...baseManifest, version: "0.1.1" }, baseBlockSources);
    expect(edited).not.toBe(original);
  });

  it("a single-character change to a manifest string field invalidates the hash", () => {
    const original = computePackContentHash(baseManifest, baseBlockSources);
    const edited = computePackContentHash({ ...baseManifest, name: "githubx" }, baseBlockSources);
    expect(edited).not.toBe(original);
  });

  // The other half of the same mechanical claim: a single-byte change to
  // BLOCK SOURCE (not just the manifest) also invalidates the hash —
  // architecture §11.1's hash spans "the canonicalized manifest JSON PLUS
  // every block's implementation source", so both halves must be load-bearing.
  it("a single-byte change to any one block's implementation source invalidates the hash", () => {
    const original = computePackContentHash(baseManifest, baseBlockSources);
    const edited = computePackContentHash(baseManifest, {
      ...baseBlockSources,
      "github.comment_pr": "export function commentPr() { return 2 /* edited */; }",
    });
    expect(edited).not.toBe(original);
  });

  it("adding a new block (new key in blockSources) invalidates the hash", () => {
    const original = computePackContentHash(baseManifest, baseBlockSources);
    const edited = computePackContentHash(baseManifest, {
      ...baseBlockSources,
      "github.close_issue": "export function closeIssue() { return 4; }",
    });
    expect(edited).not.toBe(original);
  });

  it("removing a block invalidates the hash", () => {
    const original = computePackContentHash(baseManifest, baseBlockSources);
    const { "github.list_pr_files": _removed, ...rest } = baseBlockSources;
    const edited = computePackContentHash(baseManifest, rest);
    expect(edited).not.toBe(original);
  });

  // Canonicalization property: the hash must NOT be sensitive to
  // incidental object-key or blockSources-key insertion order — only to
  // actual content — otherwise "any edit breaks approval seal" would also
  // false-positive on a no-op re-authoring (e.g. re-saving the manifest
  // YAML with the same fields in a different order), which would make the
  // approval seal impractically brittle.
  it("is stable-key-order canonicalized — differently-ordered-but-identical manifest object produces the same hash", () => {
    const reordered = {
      blocks: baseManifest.blocks,
      secrets: baseManifest.secrets,
      capabilities: baseManifest.capabilities,
      version: baseManifest.version,
      name: baseManifest.name,
    };
    const a = computePackContentHash(baseManifest, baseBlockSources);
    const b = computePackContentHash(reordered, baseBlockSources);
    expect(a).toBe(b);
  });

  it("is stable to blockSources key insertion order (same block set, different insertion order)", () => {
    const reordered = {
      "github.list_pr_files": baseBlockSources["github.list_pr_files"],
      "github.create_issue": baseBlockSources["github.create_issue"],
      "github.comment_pr": baseBlockSources["github.comment_pr"],
    };
    const a = computePackContentHash(baseManifest, baseBlockSources);
    const b = computePackContentHash(baseManifest, reordered);
    expect(a).toBe(b);
  });

  it("is sensitive to a cosmetic reordering of the manifest's own blocks: array — array order IS content, unlike object key order", () => {
    const reordered = { ...baseManifest, blocks: [...baseManifest.blocks].reverse() };
    const a = computePackContentHash(baseManifest, baseBlockSources);
    const b = computePackContentHash(reordered, baseBlockSources);
    expect(a).not.toBe(b);
  });

  it("does not collide across a block-id/source boundary shift (e.g. id 'a' + source 'bc' vs id 'ab' + source 'c')", () => {
    const a = computePackContentHash({ name: "x", version: "1" }, { a: "bc" });
    const b = computePackContentHash({ name: "x", version: "1" }, { ab: "c" });
    expect(a).not.toBe(b);
  });
});

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("preserves array order even when array elements are objects", () => {
    expect(canonicalize([{ b: 1, a: 2 }, { z: 1 }])).toBe('[{"a":2,"b":1},{"z":1}]');
  });
});
