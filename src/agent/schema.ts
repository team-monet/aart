import { zodToJsonSchema } from 'zod-to-json-schema'
import { BlockDefinitionSchema } from '../core/types'

/**
 * Machine-readable JSON Schema for a definition, so the coding agent authors
 * against a real contract (not prose). A workflow is just a BlockDefinition
 * whose `execution.type === 'workflow'`, so there is one schema.
 */
export function definitionJsonSchema(): object {
  return zodToJsonSchema(BlockDefinitionSchema, 'BlockDefinition')
}
