import { AUTHORING_GUIDE } from '../../agent/guide'
import { buildCatalog } from '../../agent/catalog'
import { definitionJsonSchema } from '../../agent/schema'
import { openRuntime } from '../workspace'

/**
 * `aart context` — everything a coding agent needs to author for this workspace,
 * in one dump: the authoring guide, the live block catalog, and the schema.
 * Paste it into your agent, or prefer the MCP server (`aart mcp`) which exposes
 * the same surface as tools.
 */
export async function contextCommand(): Promise<void> {
  const catalog = buildCatalog(openRuntime().registry)
  const out = [
    AUTHORING_GUIDE,
    '## Available blocks (catalog)',
    '',
    '```json',
    JSON.stringify(catalog, null, 2),
    '```',
    '',
    '## Definition schema (JSON Schema)',
    '',
    '```json',
    JSON.stringify(definitionJsonSchema(), null, 2),
    '```',
  ].join('\n')
  console.log(out)
}
