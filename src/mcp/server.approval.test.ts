/**
 * Tests for the aa_run_workflow approval gate in the MCP server.
 *
 * Since startMcpServer() is not easily instantiated in unit tests (it wires
 * stdio transport and resolves workspace from env), we test the gate logic
 * directly — the same unapprovedInTree + approvalEnforced calls the handler
 * makes — and verify the run record's approved field reflects true status.
 *
 * This is equivalent to testing the handler inline: if the gating expressions
 * pass/fail correctly, the handler behaves correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../core/runtime'
import { corePack } from '../packs/core'
import { unapprovedInTree, approvalEnforced } from '../core/approval'
import type { BlockDefinition } from '../core/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(approval?: 'approved' | 'draft'): BlockDefinition {
  return {
    id: 'test.mcp.workflow',
    name: 'Test MCP Workflow',
    version: '0.1.0',
    inputs: [],
    outputs: [],
    execution: {
      type: 'workflow',
      steps: [
        {
          id: 'write',
          block: 'artifact.write',
          inputs: { name: 'out.txt', content: 'hi' },
        },
      ],
    },
    approval: approval ?? 'draft',
  }
}

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

let ws: string
let runtime: Runtime

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-mcp-appr-'))
  runtime = new Runtime(ws, [corePack])
})

afterEach(() => {
  delete process.env.AART_REQUIRE_APPROVAL
  fs.rmSync(ws, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Gate logic — mirrors aa_run_workflow handler exactly
// ---------------------------------------------------------------------------

/**
 * Simulate the handler gate: returns whether it would fail (enforcement on +
 * unapproved) or run. When it runs, returns the RunRecord.
 */
async function simulateRunWorkflow(
  def: BlockDefinition,
): Promise<{ refused: true } | { refused: false; approved: boolean }> {
  const registry = runtime.registry
  // Handler registers the def for the purposes of resolving referenced blocks.
  // In the MCP flow this is done via aa_register_block first; here we replicate
  // by registering directly, mirroring what the full handler path does.
  runtime.fileRegistry.registerBlock(def)

  // Exact gate logic from server.ts aa_run_workflow handler:
  const pending = unapprovedInTree(def, registry, true) // trustTop=true: from registry
  if (approvalEnforced() && pending.length) {
    return { refused: true }
  }
  const record = await runtime.run(def, {}, undefined, { approved: pending.length === 0 })
  return { refused: false, approved: record.approved ?? false }
}

// ---------------------------------------------------------------------------
// Default off
// ---------------------------------------------------------------------------

describe('aa_run_workflow gate — default off (AART_REQUIRE_APPROVAL unset)', () => {
  it('runs a draft workflow without refusing', async () => {
    delete process.env.AART_REQUIRE_APPROVAL
    const result = await simulateRunWorkflow(makeWorkflow('draft'))
    expect(result.refused).toBe(false)
  })

  it('run record has approved=false for a draft workflow', async () => {
    delete process.env.AART_REQUIRE_APPROVAL
    const result = await simulateRunWorkflow(makeWorkflow('draft'))
    if (result.refused) throw new Error('unexpected refusal')
    expect(result.approved).toBe(false)
  })

  it('run record has approved=true for an approved workflow', async () => {
    delete process.env.AART_REQUIRE_APPROVAL
    const result = await simulateRunWorkflow(makeWorkflow('approved'))
    if (result.refused) throw new Error('unexpected refusal')
    expect(result.approved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Enforced on
// ---------------------------------------------------------------------------

describe('aa_run_workflow gate — enforced on (AART_REQUIRE_APPROVAL=1)', () => {
  beforeEach(() => {
    process.env.AART_REQUIRE_APPROVAL = '1'
  })

  it('refuses a draft workflow', async () => {
    const result = await simulateRunWorkflow(makeWorkflow('draft'))
    expect(result.refused).toBe(true)
  })

  it('runs an approved workflow and records approved=true', async () => {
    const result = await simulateRunWorkflow(makeWorkflow('approved'))
    expect(result.refused).toBe(false)
    if (result.refused) throw new Error('unexpected refusal')
    expect(result.approved).toBe(true)
  })
})
