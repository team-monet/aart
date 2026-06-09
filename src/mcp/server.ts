import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { BlockDefinitionSchema } from '../core/types'
import { buildCatalog } from '../agent/catalog'
import { definitionJsonSchema } from '../agent/schema'
import { validateDraft } from '../agent/validate'
import { AUTHORING_GUIDE } from '../agent/guide'
import { runDefinition } from '../core/run-service'
import { renderReport, readRun } from '../core/report'
import { openRegistry, workspace } from '../cli/workspace'

/**
 * The agent-callable interface. A coding agent connects over stdio and uses
 * these tools to discover blocks, learn how to author, validate its drafts,
 * register them, run them deterministically, and read evidence reports. The
 * server's `instructions` carry the authoring guide so the agent is aware of
 * "what and how" the moment it connects. aart never calls an LLM itself.
 */

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'aart', version: '0.0.1' },
    { instructions: AUTHORING_GUIDE },
  )

  server.registerTool(
    'aa_list_blocks',
    {
      title: 'List blocks',
      description: 'List all blocks & workflows in the local registry (the catalog to compose from).',
    },
    async () => json(buildCatalog(openRegistry())),
  )

  server.registerTool(
    'aa_get_block',
    {
      title: 'Get block definition',
      description: 'Fetch the full definition of one block/workflow by id.',
      inputSchema: { id: z.string(), version: z.string().optional() },
    },
    async ({ id, version }) => {
      const block = openRegistry().getBlock(id, version)
      return block ? json(block) : fail(`Block not found: ${id}`)
    },
  )

  server.registerTool(
    'aa_get_schema',
    {
      title: 'Get authoring schema & guide',
      description: 'Return the definition JSON Schema and the authoring guide (how to author for aart).',
    },
    async () => json({ guide: AUTHORING_GUIDE, schema: definitionJsonSchema() }),
  )

  server.registerTool(
    'aa_validate',
    {
      title: 'Validate a draft',
      description: 'Validate an agent-authored block/workflow definition (schema + that referenced blocks exist).',
      inputSchema: { definition: z.record(z.unknown()) },
    },
    async ({ definition }) => {
      const result = validateDraft(definition, openRegistry())
      return json({ ok: result.ok, errors: result.errors })
    },
  )

  server.registerTool(
    'aa_register_block',
    {
      title: 'Register a block',
      description: 'Validate and save a definition to the local registry. Get human approval before calling this.',
      inputSchema: { definition: z.record(z.unknown()) },
    },
    async ({ definition }) => {
      const registry = openRegistry()
      const result = validateDraft(definition, registry)
      if (!result.ok || !result.block) {
        return fail(`Refused — invalid definition:\n- ${result.errors.join('\n- ')}`)
      }
      registry.registerBlock(result.block)
      return text(`registered ${result.block.id}@${result.block.version}`)
    },
  )

  server.registerTool(
    'aa_run_workflow',
    {
      title: 'Run a workflow',
      description: 'Run a workflow by registry id or by inline definition, with inputs. Returns the structured run report.',
      inputSchema: {
        id: z.string().optional(),
        definition: z.record(z.unknown()).optional(),
        input: z.record(z.unknown()).optional(),
        params: z.record(z.unknown()).optional(),
      },
    },
    async ({ id, definition, input, params }) => {
      const registry = openRegistry()
      let def
      if (definition) {
        const parsed = BlockDefinitionSchema.safeParse(definition)
        if (!parsed.success) {
          return fail(`Invalid definition:\n- ${parsed.error.issues.map((i) => i.message).join('\n- ')}`)
        }
        def = parsed.data
      } else if (id) {
        def = registry.getBlock(id)
        if (!def) return fail(`Workflow not found: ${id}`)
      } else {
        return fail('Provide either `id` or `definition`.')
      }
      const record = await runDefinition(workspace(), registry, def, input ?? {}, params)
      return {
        content: [{ type: 'text' as const, text: renderReport(record) }],
        structuredContent: record as unknown as Record<string, unknown>,
        isError: record.status === 'FAILED',
      }
    },
  )

  server.registerTool(
    'aa_get_report',
    {
      title: 'Get a run report',
      description: 'Fetch a previous run record (the structured evidence report) by run id.',
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      try {
        return json(await readRun(workspace(), runId))
      } catch {
        return fail(`Run not found: ${runId}`)
      }
    },
  )

  await server.connect(new StdioServerTransport())
  // stderr is safe for logs; stdout is the JSON-RPC channel.
  console.error('aart MCP server ready (stdio)')
}
