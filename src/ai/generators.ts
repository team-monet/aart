import type { BlockDefinition } from '../core/types'
import type { Registry } from '../registry/file-registry'

/**
 * AI generation entrypoints — signatures are fixed now so the CLI/MCP can be
 * wired against them; implementations land in Phases 4–5. All three return a
 * DRAFT for human approval; nothing is registered or run without a gate.
 *
 * A provider abstraction (real OpenAI / local Ollama / others) goes in
 * `ai/provider.ts` — the legacy client was hardwired to Ollama-via-OpenAI-SDK
 * with an unused `PROVIDER` constant, so switching meant a rewrite. Don't repeat.
 */

export interface GenerateContext {
  registry: Registry
  model?: string
}

/** L1 (Phase 4): compose existing blocks into a workflow from a NL request. */
export async function generateWorkflow(
  _request: string,
  _ctx: GenerateContext,
): Promise<BlockDefinition> {
  throw new Error('generateWorkflow not implemented — Phase 4')
}

/** L2 (Phase 5): draft a block SPEC (inputs/outputs/capabilities, no code). */
export async function generateBlockSpec(
  _request: string,
  _ctx: GenerateContext,
): Promise<BlockDefinition> {
  throw new Error('generateBlockSpec not implemented — Phase 5')
}

/** L3 (Phase 5): draft block CODE for an approved spec (gated by validators). */
export async function generateBlockCode(
  _spec: BlockDefinition,
  _ctx: GenerateContext,
): Promise<BlockDefinition> {
  throw new Error('generateBlockCode not implemented — Phase 5')
}
