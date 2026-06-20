/**
 * Integration tests for the run CLI command — specifically the approval gate.
 *
 * Strategy: drive runCommand() directly with a real tmp workspace and real
 * runtime, mock process.exit and console, and test both the default-off
 * and enforced-on behaviours. Mirrors the schedule.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../../core/runtime'
import { corePack } from '../../packs/core'
import type { BlockDefinition } from '../../core/types'
import { runCommand } from './run'

// ---------------------------------------------------------------------------
// Console + process.exit mocking
// ---------------------------------------------------------------------------

let stdoutLines: string[]
let stderrLines: string[]
let exitCode: number | undefined

beforeEach(() => {
  stdoutLines = []
  stderrLines = []
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(' '))
  })
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    exitCode = typeof code === 'number' ? code : 1
    throw new Error(`process.exit(${exitCode})`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AART_REQUIRE_APPROVAL
})

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

let ws: string

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-run-cli-'))
  process.env.AART_WORKSPACE = ws
})

afterEach(() => {
  delete process.env.AART_WORKSPACE
  fs.rmSync(ws, { recursive: true, force: true })
})

/** A minimal workflow that writes an artifact — runnable with corePack. */
function makeWorkflow(approval?: 'approved' | 'draft' | 'deprecated'): BlockDefinition {
  return {
    id: 'test.run.workflow',
    name: 'Test Run Workflow',
    version: '0.1.0',
    inputs: [],
    outputs: [],
    execution: {
      type: 'workflow',
      steps: [
        {
          id: 'write',
          block: 'artifact.write',
          inputs: { name: 'out.txt', content: 'hello' },
        },
      ],
    },
    approval: approval ?? 'draft',
  }
}

function registerWorkflow(runtime: Runtime, approval?: 'approved' | 'draft' | 'deprecated'): BlockDefinition {
  const wf = makeWorkflow(approval)
  runtime.fileRegistry.registerBlock(wf)
  return wf
}

/** Run a command function, swallowing the process.exit throw. */
async function run(fn: () => Promise<void>): Promise<{ exited: boolean }> {
  try {
    await fn()
    return { exited: false }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('process.exit(')) {
      return { exited: true }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Approval gate — default OFF
// ---------------------------------------------------------------------------

describe('approval gate — default off (AART_REQUIRE_APPROVAL unset)', () => {
  it('runs a draft workflow without --yes and records approved=false', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'draft')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: false,
        json: true,
      }),
    )

    expect(exited).toBe(false)
    // The JSON output line on stdout must report approved=false (truthful status).
    const jsonLine = stdoutLines.find((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    })
    expect(jsonLine).toBeDefined()
    const record = JSON.parse(jsonLine!)
    expect(record.approved).toBe(false)
    expect(record.status).toBe('COMPLETED')
  })

  it('runs an approved workflow and records approved=true', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'approved')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: false,
        json: true,
      }),
    )

    expect(exited).toBe(false)
    const jsonLine = stdoutLines.find((l) => {
      try { JSON.parse(l); return true } catch { return false }
    })
    const record = JSON.parse(jsonLine!)
    expect(record.approved).toBe(true)
    expect(record.status).toBe('COMPLETED')
    // M1: deprecated must be false (or falsy) for a non-deprecated workflow.
    expect(record.deprecated).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// Approval gate — enforced ON (AART_REQUIRE_APPROVAL=1)
// ---------------------------------------------------------------------------

describe('approval gate — enforced on (AART_REQUIRE_APPROVAL=1)', () => {
  beforeEach(() => {
    process.env.AART_REQUIRE_APPROVAL = '1'
  })

  it('refuses a draft workflow without --yes (exit 1)', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'draft')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: false,
        json: false,
      }),
    )

    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('refused') || l.includes('not approved'))).toBe(true)
  })

  it('allows a draft workflow with --yes and records approved=false', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'draft')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: true,
        json: true,
      }),
    )

    expect(exited).toBe(false)
    const jsonLine = stdoutLines.find((l) => {
      try { JSON.parse(l); return true } catch { return false }
    })
    const record = JSON.parse(jsonLine!)
    expect(record.approved).toBe(false)
    expect(record.status).toBe('COMPLETED')
  })

  it('runs an approved workflow without --yes and records approved=true', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'approved')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: false,
        json: true,
      }),
    )

    expect(exited).toBe(false)
    const jsonLine = stdoutLines.find((l) => {
      try { JSON.parse(l); return true } catch { return false }
    })
    const record = JSON.parse(jsonLine!)
    expect(record.approved).toBe(true)
    expect(record.status).toBe('COMPLETED')
  })
})

// ---------------------------------------------------------------------------
// Deprecation gate — always-on hard stop
// ---------------------------------------------------------------------------

describe('deprecation gate — refuses regardless of AART_REQUIRE_APPROVAL', () => {
  it('refuses a deprecated workflow when approval enforcement is OFF and no --yes (exit 1)', async () => {
    // Approval enforcement is deliberately unset — deprecation must still refuse.
    delete process.env.AART_REQUIRE_APPROVAL
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'deprecated')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: false,
        json: false,
      }),
    )

    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('deprecated'))).toBe(true)
  })

  it('allows a deprecated workflow with --yes (exit 0) and records deprecated:true', async () => {
    delete process.env.AART_REQUIRE_APPROVAL
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'deprecated')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: true,
        json: true,
      }),
    )

    expect(exited).toBe(false)
    const jsonLine = stdoutLines.find((l) => {
      try { JSON.parse(l); return true } catch { return false }
    })
    expect(jsonLine).toBeDefined()
    const record = JSON.parse(jsonLine!)
    expect(record.status).toBe('COMPLETED')
    // M1: the --json output must expose deprecated so CI wrappers can gate on it.
    expect(record.deprecated).toBe(true)
    // The run record must carry deprecated:true so renderReport can warn.
    // Read back the on-disk record to verify it persisted (not just in-memory).
    const { readRun } = await import('../../core/report')
    const onDisk = await readRun(ws, record.runId)
    expect(onDisk.deprecated).toBe(true)
  })

  it('an approved workflow is unaffected by the deprecation gate', async () => {
    delete process.env.AART_REQUIRE_APPROVAL
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, 'approved')

    const { exited } = await run(() =>
      runCommand('test.run.workflow', {
        input: '{}',
        param: '{}',
        verbose: false,
        yes: false,
        json: true,
      }),
    )

    expect(exited).toBe(false)
    const jsonLine = stdoutLines.find((l) => {
      try { JSON.parse(l); return true } catch { return false }
    })
    const record = JSON.parse(jsonLine!)
    expect(record.approved).toBe(true)
    expect(record.status).toBe('COMPLETED')
  })
})
