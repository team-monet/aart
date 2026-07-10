// BlockManifest, BlockImplementation — architecture §2.5. The single most
// load-bearing seam between the engine (architecture §4.2, built by S1) and
// every block-authoring package (@aart/blocks-core/S3, @aart/llm's llm.*
// blocks/S7). Frozen here in S0, verbatim per architecture §2.5, rather
// than left for Wave-1 sessions to informally converge on mid-build.
import { z } from "zod";

// A JSON Schema document — deliberately loose (any well-formed JSON object
// is a valid JSON Schema fragment); the actual schema *content* here is
// derived per-block from that block's own Zod input/output shape via
// zod-to-json-schema (json-schema.ts), not authored by hand against a
// tighter meta-schema @aart/types would have to also maintain.
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JSONSchema = z.infer<typeof JsonSchemaSchema>;

export const BlockManifestSchema = z.object({
  id: z.string(), // e.g. "browser.click", "llm.extract"
  version: z.string(),
  capabilities: z.array(z.string()), // §31.0 taxonomy — checked at dispatch, architecture §4.6
  inputSchema: JsonSchemaSchema, // derived from the block's Zod input shape
  outputSchema: JsonSchemaSchema, // derived from the block's Zod output shape
  description: z.string(), // model-facing — spec §32.1 model-native design law
  category: z.string().optional(),
});
export type BlockManifest = z.infer<typeof BlockManifestSchema>;

// BlockExecutionContext carries what a block needs from the engine at call
// time. Architecture §2.5: "its exact shape is S1's to specify as part of
// shipping the dispatch loop (§4.2), since the engine is
// BlockExecutionContext's only caller and constructor" — S0 freezes only
// the minimum architecture itself names ("at minimum: resolved-secret
// access via the same injected-resolver pattern §3.2 uses, artifact-write
// access, and the current runId/stepId for trace correlation") so
// @aart/blocks-core (S3) and @aart/llm (S7) have a real type to implement
// BlockImplementation against today; S1 owns finalizing/extending it when
// the dispatch loop is actually built. A shape-changing extension by S1 is
// exactly the kind of post-freeze change the amendment protocol (plan §7)
// covers, since BlockExecutionContext is part of the frozen
// BlockImplementation contract's surface.
export interface BlockExecutionContext {
  readonly runId: string;
  readonly stepId: string;
  /** Resolves a `secrets.<NAME>`-style symbolic reference to its value — same injected-resolver pattern @aart/expr's secretResolver uses (architecture §3.2), never a direct secret-adapter import from inside a block. */
  resolveSecret(ref: string): Promise<string>;
  /** Writes an Artifact's bytes + metadata and returns its store identity. */
  writeArtifact(input: {
    name: string;
    kind: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; path: string }>;
}

// `execute`/`BlockImplementation` embed a real function value, not JSON
// data — modeled as a plain TS type rather than a Zod schema, matching this
// package's treatment of CapabilityCheck/RedactFn (governance.ts): nothing
// ever needs to runtime-validate "is this callable," only to type-check the
// call site every block-authoring package builds against.
export interface BlockImplementation {
  manifest: BlockManifest;
  execute: (resolvedInputs: unknown, ctx: BlockExecutionContext) => Promise<unknown>;
}
