// defineBlock — the one place a @aart/blocks-core block turns a Zod
// input/output shape + an `execute` function into the S0-frozen
// `BlockImplementation` contract (architecture §2.5, packages/types/src/
// block.ts). Every block in this package is built through this helper
// rather than hand-assembling `{ manifest, execute }` object literals, so
// the JSON Schema derivation (via `@aart/types`'s `toJsonSchema`, itself a
// thin wrapper over Zod 4's native `z.toJSONSchema`) and the
// input/output-shape self-validation below are applied uniformly across
// all 51 blocks, not re-implemented per block.
//
// `category` is required here even though `BlockManifest.category` is
// optional on the frozen type — every block in this catalog declares one
// (namespace grouping, e.g. "browser"/"http"/"assert") as a matter of this
// package's own internal discipline, not a frozen-type requirement.
import { z } from "zod";
import { toJsonSchema, type BlockExecutionContext, type BlockImplementation, type BlockManifest } from "@aart/types";

export interface BlockSpec<TInput, TOutput> {
  id: string;
  /** Defaults to "0.1.0" — this package's own block-catalog version, distinct from AART's package version. */
  version?: string;
  /** §31.0 taxonomy (browser/http/file.read/file.write/command/queue/db.read/db.write/llm, plus secrets:<NAME>/domain:<pattern> families) — may be empty for a capability-free block (e.g. the data or flow groups), never omitted. */
  capabilities: string[];
  /** Model-facing (spec §32.1) — written to also carry a worked example inline in prose, since BlockManifest has no separate `examples` field (see this session's final report re: the task-briefing/DoD-text discrepancy on this point). */
  description: string;
  category: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute: (input: TInput, ctx: BlockExecutionContext) => Promise<TOutput>;
}

/** Thrown when a block's own resolved input (or its own computed output) fails to parse against its declared Zod shape — a defensive, per-block correctness check distinct from governance's schema validation (spec §18.1, a different layer/owner). Kept local to blocks-core rather than added to the frozen `AartError` hierarchy (packages/types/src/errors.ts is not this package's to extend). */
export class BlockSchemaError extends Error {
  constructor(
    public readonly blockId: string,
    public readonly phase: "input" | "output",
    public readonly cause: unknown,
  ) {
    const detail = cause instanceof z.ZodError ? cause.message : String(cause);
    super(`${blockId}: ${phase} failed schema validation — ${detail}`);
    this.name = "BlockSchemaError";
  }
}

export function defineBlock<TInput, TOutput>(spec: BlockSpec<TInput, TOutput>): BlockImplementation {
  const manifest: BlockManifest = {
    id: spec.id,
    version: spec.version ?? "0.1.0",
    capabilities: spec.capabilities,
    inputSchema: toJsonSchema(spec.inputSchema),
    outputSchema: toJsonSchema(spec.outputSchema),
    description: spec.description,
    category: spec.category,
  };

  return {
    manifest,
    execute: async (resolvedInputs: unknown, ctx: BlockExecutionContext): Promise<unknown> => {
      let parsedInput: TInput;
      try {
        parsedInput = spec.inputSchema.parse(resolvedInputs);
      } catch (cause) {
        throw new BlockSchemaError(spec.id, "input", cause);
      }

      const output = await spec.execute(parsedInput, ctx);

      try {
        return spec.outputSchema.parse(output);
      } catch (cause) {
        throw new BlockSchemaError(spec.id, "output", cause);
      }
    },
  };
}
