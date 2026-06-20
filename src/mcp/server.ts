import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildCatalog, filterCatalog } from '../agent/catalog'
import { definitionJsonSchema } from '../agent/schema'
import { validateDraft } from '../agent/validate'
import { renderDefinition } from '../agent/render'
import { unapprovedInTree, approvalEnforced, deprecatedInTree } from '../core/approval'
import { setApproval } from '../core/governance'
import { approveWorkspacePack, loadWorkspacePack, registerWorkspacePack } from '../pack/loader'
import { AUTHORING_GUIDE } from '../agent/guide'
import { renderReport, readRun, listRuns } from '../core/report'
import { openRuntime, resolveWorkspace, workspaceSourceLabel } from '../cli/workspace'
import type { RunRecord } from '../core/types'
import { verifyWeb } from '../agent/verify'

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

const statusEnum = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'])

/** Lean, self-describing view of a run for the wire (omits the heavy snapshot,
 *  which stays on disk and is retrievable via aa_get_report). */
const runViewShape = {
  runId: z.string(),
  blockId: z.string(),
  status: statusEnum,
  approved: z.boolean().optional(),
  inputs: z.record(z.unknown()),
  params: z.record(z.unknown()).optional(),
  results: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  trace: z.array(
    z.object({
      seq: z.number(),
      stepId: z.string(),
      block: z.string(),
      status: statusEnum,
      inputs: z.record(z.unknown()),
      outputs: z.record(z.unknown()).optional(),
      error: z.string().optional(),
      startedAt: z.string(),
      endedAt: z.string().optional(),
      // forEach iterations carry a per-iteration index (rendered as step[i]).
      iteration: z.number().optional(),
    }),
  ),
  artifacts: z.array(z.string()),
  startedAt: z.string(),
  endedAt: z.string().optional(),
}

function runView(record: RunRecord) {
  return {
    runId: record.runId,
    blockId: record.blockId,
    status: record.status,
    approved: record.approved,
    inputs: record.inputs,
    params: record.params,
    results: record.results,
    error: record.error,
    trace: record.trace,
    // Normalise to string paths on the wire so the outputSchema (z.array(z.string()))
    // validates correctly and agents receive consistent path strings.
    artifacts: record.artifacts.map((a) => (typeof a === 'string' ? a : a.path)),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  }
}

export async function startMcpServer(): Promise<void> {
  // Build the runtime once so its packs (QA, …) are available to every run;
  // registry reads are fresh, so an out-of-band `aart approve` is seen.
  const { dir: ws, source } = resolveWorkspace()
  const runtime = openRuntime(ws)
  const registry = runtime.registry

  // Make the resolved workspace loud on startup — a wrong cwd is the main
  // footgun (it silently shows only native blocks and writes a stray .aa).
  const hasRegistry = fs.existsSync(path.join(ws, '.aa', 'registry'))
  console.error(
    `aart MCP server — workspace: ${ws}  (${workspaceSourceLabel(source)})${hasRegistry ? '' : '  (no .aa/registry here yet)'}`,
  )

  const server = new McpServer(
    { name: 'aart', version: '0.8.0' },
    { instructions: AUTHORING_GUIDE },
  )

  server.registerTool(
    'aa_list_blocks',
    {
      title: 'List blocks',
      description: 'List all blocks & workflows in the local registry (the catalog to compose from).',
    },
    async () => json(buildCatalog(registry)),
  )

  server.registerTool(
    'aa_find_blocks',
    {
      title: 'Find blocks by category or keyword',
      description:
        'Search the block catalog by category (e.g. "http","browser","data","flow","assert","file","report") and/or a free-text query matched against id, name, description, and keywords. Returns the same entry shape as aa_list_blocks. Use when you know the domain (category:"browser") or the verb you want (query:"health check") — returns a focused slice rather than the full catalog.',
      inputSchema: { category: z.string().optional(), query: z.string().optional() },
    },
    async ({ category, query }) => {
      const results = filterCatalog(buildCatalog(registry), { category, query })
      return json(results)
    },
  )

  server.registerTool(
    'aa_get_block',
    {
      title: 'Get block definition',
      description: 'Fetch the full definition of one block/workflow by id.',
      inputSchema: { id: z.string(), version: z.string().optional() },
    },
    async ({ id, version }) => {
      const block = registry.getBlock(id, version)
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
      const result = validateDraft(definition, registry)
      return json({ ok: result.ok, errors: result.errors, warnings: result.warnings })
    },
  )

  server.registerTool(
    'aa_register_block',
    {
      title: 'Register a block/workflow',
      description:
        'Save a validated definition to the registry. It lands as DRAFT (not yet runnable). ' +
        'Next: ask the user to approve it, then call aa_approve. Re-registering after an edit resets it to draft.',
      inputSchema: { definition: z.record(z.unknown()) },
    },
    async ({ definition }) => {
      const result = validateDraft(definition, registry)
      if (!result.ok || !result.block) {
        return fail(`Refused — invalid definition:\n- ${result.errors.join('\n- ')}`)
      }
      // Always lands as draft — approval is a separate step.
      result.block.approval = 'draft'
      try {
        registry.registerBlock(result.block)
      } catch (err) {
        return fail(
          `Failed to register ${result.block.id}@${result.block.version}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      const warningLines = result.warnings.length
        ? `\nValidation warnings (advisory):\n${result.warnings.map((w) => `  ⚠ ${w}`).join('\n')}\n`
        : ''
      return text(
        `Registered ${result.block.id}@${result.block.version} as DRAFT.${warningLines}\n\n` +
          `SHOW the user exactly what they're approving:\n\n${renderDefinition(result.block)}\n\n` +
          `Then ask them to approve it. Once they say yes, call aa_approve with id "${result.block.id}".`,
      )
    },
  )

  server.registerTool(
    'aa_run_workflow',
    {
      title: 'Run a workflow',
      description:
        'Run an APPROVED workflow by registry id (optionally a version), with inputs. ' +
        'Returns the structured run report (per-step trace, outputs, artifacts). ' +
        'A DEPRECATED workflow is always refused (re-approve it first with aa_approve). ' +
        'If it refuses as not-approved, get the user to approve it (aa_approve), then run.',
      inputSchema: {
        id: z.string().optional(),
        version: z.string().optional(),
        definition: z.record(z.unknown()).optional(),
        input: z.record(z.unknown()).optional(),
        params: z.record(z.unknown()).optional(),
      },
      outputSchema: runViewShape,
    },
    async ({ id, version, definition, input, params }) => {
      let def
      if (definition) {
        // Same gate as registration: structure + referenced blocks must resolve.
        const result = validateDraft(definition, registry)
        if (!result.ok || !result.block) {
          return fail(`Invalid definition:\n- ${result.errors.join('\n- ')}`)
        }
        def = result.block
      } else if (id) {
        def = registry.getBlock(id, version)
        if (!def) return fail(`Workflow not found: ${id}${version ? '@' + version : ''}`)
      } else {
        return fail('Provide either `id` or `definition`.')
      }
      // Deprecation is an always-on hard stop (independent of AART_REQUIRE_APPROVAL).
      // MCP runs are unattended (like scheduled runs) — no interactive override.
      const deprecated = deprecatedInTree(def, registry, !definition)
      if (deprecated.length) {
        return fail(
          `Refused — deprecated: ${deprecated.join(', ')}. ` +
            `This workflow is no longer approved to run; re-approve it (aa_approve) before running.`,
        )
      }
      // Governance gate: only run user-approved definitions. An inline
      // definition is never pre-trusted; a registry id's status is.
      //
      // Enforcement is opt-in (AART_REQUIRE_APPROVAL=1). When unset (the
      // default), unapproved/draft blocks run immediately. The approved field
      // in the run record always reflects true approval status regardless.
      const pending = unapprovedInTree(def, registry, !definition)
      if (approvalEnforced() && pending.length) {
        return fail(
          `Not approved: ${pending.join(', ')}. Approval enforcement is on (AART_REQUIRE_APPROVAL=1); ` +
            `ask the user to approve, then call aa_approve for: ${pending.join(', ')}.`,
        )
      }
      const record = await runtime.run(def, input ?? {}, params, { approved: pending.length === 0 })
      return {
        content: [{ type: 'text' as const, text: renderReport(record) }],
        structuredContent: runView(record),
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
        return json(await readRun(ws, runId))
      } catch {
        return fail(`Run not found: ${runId}`)
      }
    },
  )

  server.registerTool(
    'aa_list_runs',
    {
      title: 'List recent runs',
      description: 'List recent runs (id, block, status). Use aa_get_report for the full report of one.',
    },
    async () => json(await listRuns(ws)),
  )

  server.registerTool(
    'aa_verify',
    {
      title: 'Verify a web page renders / works',
      description:
        'Your "did it actually work?" check for anything affecting a web page. Loads the URL in a ' +
        'real browser, waits for it to settle (incl. JS-rendered SPAs), and returns a COMPACT view of ' +
        "what's actually on the page — title, the main rendered text, interactive elements, console " +
        'errors, and a screenshot — plus `ok` (is the `expect` text present?) when you pass `expect`. ' +
        'Reach for this RIGHT AFTER you change something that affects how a page renders, BEFORE ' +
        "claiming it works — don't guess from the code or unit tests. One call, no workflow authoring. " +
        'Pass `waitFor` (a CSS selector) to wait for content that only renders after page load (SPAs). ' +
        'Pass `focus` (a CSS selector) to scope the read and `expect` match to a specific region of the page.',
      inputSchema: {
        url: z.string(),
        focus: z.string().optional(),
        expect: z.string().optional(),
        waitFor: z.string().optional(),
      },
    },
    async ({ url, focus, expect, waitFor }) => {
      const result = await verifyWeb(runtime, { url, focus, expect, waitFor })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: result.status !== 'ok' }
    },
  )

  server.registerTool(
    'aa_register_pack',
    {
      title: 'Register a workspace pack',
      description:
        'Register a pack of native blocks you authored under <workspace>/.aa/packs/<name>/ ' +
        '(CommonJS: module.exports = { name, blocks: [{ def, run }], capabilities? }). ' +
        'Registration records a content hash as DRAFT and never executes the pack. ' +
        'Next: show the user the returned summary and ask them to approve; pack code runs ' +
        'unsandboxed inside the runtime once approved.',
      inputSchema: { name: z.string(), path: z.string().optional() },
    },
    async ({ name, path: relPath }) => {
      try {
        const r = registerWorkspacePack(ws, name, relPath)
        return text(
          `Registered pack "${r.name}" (${r.path}) as DRAFT — not loaded yet.\n` +
            `Files sealed by the approval hash: ${r.files.join(', ')}\n\n` +
            `SHOW the user what they would be approving (unsandboxed runtime code):\n\n${r.preview}\n\n` +
            `When the user agrees, call aa_approve_pack with name "${r.name}".`,
        )
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // Conversational approval: the user approves in chat, you record it here.
  // Set AART_STRICT_APPROVAL=1 to require the `aart approve` CLI instead.
  if (!process.env.AART_STRICT_APPROVAL) {
    server.registerTool(
      'aa_approve',
      {
        title: 'Approve a definition',
        description:
          'Mark a registered block/workflow approved so it can run. ONLY call this after the user ' +
          'has approved it in the conversation — never approve your own work unprompted.',
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      async ({ id, version }) => {
        const r = setApproval(registry, id, 'approved', version)
        if (!r.ok) return fail(r.error ?? 'failed to approve')
        let msg = `approved ${r.id}@${r.version} — it can now run.`
        if (r.pending?.length) {
          msg += ` Note: it still references unapproved blocks (${r.pending.join(', ')}); approve those too.`
        }
        return text(msg)
      },
    )

    server.registerTool(
      'aa_approve_pack',
      {
        title: 'Approve a workspace pack',
        description:
          'Approve a registered pack and load it into the live runtime (its blocks become ' +
          'usable immediately). ONLY call this after the user has approved the pack in the ' +
          'conversation — pack code runs unsandboxed. Re-approval is needed after any edit.',
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        try {
          // Validate the pack loads BEFORE recording approval, so a broken pack
          // is rejected outright instead of being approved-but-unloadable.
          const pack = loadWorkspacePack(ws, name)
          runtime.addPack(pack)
          approveWorkspacePack(ws, name)
          const ids = pack.blocks.map((b) => b.def.id).join(', ')
          return text(`approved pack "${name}" — loaded ${pack.blocks.length} block(s): ${ids}. Ready to compose.`)
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      },
    )

    server.registerTool(
      'aa_deprecate',
      {
        title: 'Deprecate a definition',
        description: 'Mark a registered block/workflow deprecated (no longer approved to run).',
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      async ({ id, version }) => {
        const r = setApproval(registry, id, 'deprecated', version)
        return r.ok ? text(`deprecated ${r.id}@${r.version}`) : fail(r.error ?? 'failed')
      },
    )
  }

  await server.connect(new StdioServerTransport())
  // stderr is safe for logs; stdout is the JSON-RPC channel.
  console.error('aart MCP server ready (stdio)')
}
