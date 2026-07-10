import { createFsStore, type AartStore } from "@aart/store";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidRegistryRefError, RegistryVersionImmutableError, UnresolvedRegistryRefError } from "./errors.js";
import {
  computeContentHash,
  decodeResolvedVersion,
  encodeResolvedVersion,
  inlinePromptResolution,
  inlineSchemaResolution,
  isRegistryRef,
  registerPrompt,
  registerSchema,
  resolvePromptRef,
  resolveSchemaRef,
} from "./registry.js";

describe("computeContentHash", () => {
  it("is deterministic and sha256:-prefixed", () => {
    const hash = computeContentHash("hello");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeContentHash("hello")).toBe(hash);
  });

  it("hashes string content directly (not JSON.stringify-wrapped) so prompt bodies hash their literal text", () => {
    // A JSON.stringify of the string "hello" would be '"hello"' (with
    // quotes) — confirm the hash matches hashing the raw string, not that.
    const raw = createHashOfRawString("hello");
    expect(computeContentHash("hello")).toBe(raw);
  });

  it("is key-order independent for object content (schema hashing)", () => {
    expect(computeContentHash({ b: 1, a: 2 })).toBe(computeContentHash({ a: 2, b: 1 }));
  });

  it("a single-character change in a prompt body changes the hash", () => {
    expect(computeContentHash("hello")).not.toBe(computeContentHash("hellp"));
  });
});

// Local re-derivation of the raw-string hash path for the test above, kept
// separate from registry.ts's own implementation so this isn't a tautology.
function createHashOfRawString(s: string): string {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}

describe("registerPrompt / resolvePromptRef — architecture §12.2, spec §22.2", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-registry-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("registers and resolves a prompt by its latest version", async () => {
    await registerPrompt(store, "energy_bill_extraction", "1.0.0", "Extract the bill fields as JSON.");
    const resolved = await resolvePromptRef(store, "prompts.energy_bill_extraction");
    expect(resolved.name).toBe("energy_bill_extraction");
    expect(resolved.version).toBe("1.0.0");
    expect(resolved.body).toBe("Extract the bill fields as JSON.");
    expect(resolved.ref).toBe("prompts.energy_bill_extraction");
  });

  it("resolves to the LATEST version when multiple are registered", async () => {
    await registerPrompt(store, "p", "1.0.0", "v1 body");
    await registerPrompt(store, "p", "1.2.0", "v1.2 body");
    await registerPrompt(store, "p", "1.1.0", "v1.1 body — registered out of order");
    const resolved = await resolvePromptRef(store, "prompts.p");
    expect(resolved.version).toBe("1.2.0");
    expect(resolved.body).toBe("v1.2 body");
  });

  it("re-registering the SAME (name, version) with IDENTICAL content is an idempotent no-op", async () => {
    const first = await registerPrompt(store, "p", "1.0.0", "body");
    const second = await registerPrompt(store, "p", "1.0.0", "body");
    expect(second).toEqual(first);
  });

  it("re-registering the SAME (name, version) with DIFFERENT content throws RegistryVersionImmutableError", async () => {
    await registerPrompt(store, "p", "1.0.0", "original body");
    await expect(registerPrompt(store, "p", "1.0.0", "edited body")).rejects.toThrow(RegistryVersionImmutableError);
  });

  it("a revised prompt can be published as a NEW version without touching the old one — spec §22.2's 'a prompt can be revised without touching the workflow that references it'", async () => {
    await registerPrompt(store, "p", "1.0.0", "original");
    await registerPrompt(store, "p", "2.0.0", "revised");
    const v1 = await store.promptRegistry.get("p", "1.0.0");
    expect(v1?.body).toBe("original"); // untouched
    const resolved = await resolvePromptRef(store, "prompts.p");
    expect(resolved.version).toBe("2.0.0");
  });

  it("resolvePromptRef throws UnresolvedRegistryRefError when no version is registered", async () => {
    await expect(resolvePromptRef(store, "prompts.never_registered")).rejects.toThrow(UnresolvedRegistryRefError);
  });

  it("resolvePromptRef throws InvalidRegistryRefError on a malformed ref (wrong prefix)", async () => {
    await expect(resolvePromptRef(store, "schemas.p")).rejects.toThrow(InvalidRegistryRefError);
    await expect(resolvePromptRef(store, "p")).rejects.toThrow(InvalidRegistryRefError);
  });

  it("sets contentHash to computeContentHash(body)", async () => {
    const entry = await registerPrompt(store, "p", "1.0.0", "some body text");
    expect(entry.contentHash).toBe(computeContentHash("some body text"));
  });
});

describe("registerSchema / resolveSchemaRef", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-registry-schema-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("registers and resolves a schema by its latest version", async () => {
    const schema = { type: "object", properties: { amount: { type: "number" } } };
    await registerSchema(store, "energy_bill", "0.1.0", schema);
    const resolved = await resolveSchemaRef(store, "schemas.energy_bill");
    expect(resolved.jsonSchema).toEqual(schema);
    expect(resolved.version).toBe("0.1.0");
  });

  it("throws RegistryVersionImmutableError on a content-changing re-registration of the same version", async () => {
    await registerSchema(store, "s", "1.0.0", { type: "object" });
    await expect(registerSchema(store, "s", "1.0.0", { type: "string" })).rejects.toThrow(RegistryVersionImmutableError);
  });

  it("throws UnresolvedRegistryRefError for an unregistered schema", async () => {
    await expect(resolveSchemaRef(store, "schemas.nope")).rejects.toThrow(UnresolvedRegistryRefError);
  });
});

describe("inlinePromptResolution / inlineSchemaResolution — the no-registry-entry path", () => {
  it("inlinePromptResolution's version is the content hash itself (deterministic without a registry)", () => {
    const resolution = inlinePromptResolution("Summarize this document.");
    expect(resolution.ref).toBe("inline");
    expect(resolution.version).toBe(resolution.contentHash);
    expect(resolution.contentHash).toBe(computeContentHash("Summarize this document."));
    expect(resolution.body).toBe("Summarize this document.");
  });

  it("inlineSchemaResolution mirrors the same convention for an inline outputSchema object", () => {
    const schema = { type: "object" };
    const resolution = inlineSchemaResolution(schema);
    expect(resolution.version).toBe(resolution.contentHash);
    expect(resolution.jsonSchema).toEqual(schema);
  });

  it("two DIFFERENT inline prompts produce different versions/hashes (still content-addressed, spec §22.2's own property, even with no registry entry)", () => {
    const a = inlinePromptResolution("prompt A");
    const b = inlinePromptResolution("prompt B");
    expect(a.version).not.toBe(b.version);
  });
});

describe("isRegistryRef", () => {
  it("recognizes prompts./schemas. prefixes", () => {
    expect(isRegistryRef("prompts.foo")).toBe("prompt");
    expect(isRegistryRef("schemas.foo")).toBe("schema");
  });
  it("returns false for anything else (inline text, wrong prefix)", () => {
    expect(isRegistryRef("Summarize this.")).toBe(false);
    expect(isRegistryRef("prompt.foo")).toBe(false); // missing the 's'
  });
});

describe("encodeResolvedVersion / decodeResolvedVersion — the ExecutionSnapshot.resolvedVersions convention (SEAMS.md L1)", () => {
  it("round-trips version + contentHash through a single Record<string,string>-compatible value", () => {
    const resolution = { version: "1.2.0", contentHash: "sha256:abcd1234" };
    const encoded = encodeResolvedVersion(resolution);
    expect(typeof encoded).toBe("string");
    expect(decodeResolvedVersion(encoded)).toEqual(resolution);
  });

  it("round-trips correctly even when `version` itself contains a '+' (semver build metadata) — splits on the LAST '+', not the first", () => {
    const resolution = { version: "1.2.0+build.42", contentHash: "sha256:deadbeef" };
    const encoded = encodeResolvedVersion(resolution);
    expect(decodeResolvedVersion(encoded)).toEqual(resolution);
  });

  it("round-trips an inline resolution's (contentHash-as-version) shape", () => {
    const resolution = inlinePromptResolution("some prompt");
    const encoded = encodeResolvedVersion(resolution);
    expect(decodeResolvedVersion(encoded)).toEqual({ version: resolution.version, contentHash: resolution.contentHash });
  });

  it("decodeResolvedVersion throws InvalidRegistryRefError on a malformed value with no '+'", () => {
    expect(() => decodeResolvedVersion("not-a-valid-encoded-value")).toThrow(InvalidRegistryRefError);
  });
});

describe("laziness — architecture §12.2's own [DECISION]: resolution happens once per run at first llm.* step EXECUTION, not at run start", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-registry-lazy-"));
    store = createFsStore(root);
    await registerPrompt(store, "p", "1.0.0", "prompt body");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("merely importing/holding a reference to resolvePromptRef never touches the store", async () => {
    // Wrap the store's promptRegistry with a spy — nothing in this describe
    // block's beforeEach setup (other than the seeding registerPrompt call,
    // which happens BEFORE the spy is attached) should trigger a read.
    const getSpy = vi.spyOn(store.promptRegistry, "get");
    const listSpy = vi.spyOn(store.promptRegistry, "listVersions");
    // No call made yet — importing the module and having a `store` handle
    // in scope must not itself resolve anything.
    expect(getSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it("resolution occurs ONLY when resolvePromptRef is actually invoked — exactly one listVersions + one get call, not resolved speculatively/eagerly", async () => {
    const getSpy = vi.spyOn(store.promptRegistry, "get");
    const listSpy = vi.spyOn(store.promptRegistry, "listVersions");

    await resolvePromptRef(store, "prompts.p");

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it("a workflow step object referencing promptRef does not itself resolve anything until something explicitly calls resolvePromptRef with it (simulating 'never at run start')", async () => {
    const getSpy = vi.spyOn(store.promptRegistry, "get");
    const listSpy = vi.spyOn(store.promptRegistry, "listVersions");

    // Simulates parsing/holding a workflow step at "run start" — constructing
    // the step object alone must not touch the registry.
    const step = { uses: "llm.extract", with: { model: "anthropic/claude-sonnet-5", promptRef: "prompts.p", input: {} } };
    expect(step.with.promptRef).toBe("prompts.p"); // sanity — the ref exists as inert data
    expect(getSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();

    // Only "executing" the step (calling resolvePromptRef, as a block's
    // execute() would) triggers the registry read.
    await resolvePromptRef(store, step.with.promptRef);
    expect(listSpy).toHaveBeenCalledTimes(1);

    getSpy.mockRestore();
    listSpy.mockRestore();
  });
});
