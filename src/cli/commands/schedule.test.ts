/**
 * Integration tests for the schedule CLI commands.
 *
 * Strategy: drive the four action functions (scheduleAddCommand,
 * scheduleListCommand, scheduleRemoveCommand, scheduleRunCommand) directly,
 * with a real tmp workspace and real runtime. We mock process.exit and
 * capture console output, mirroring the dashboard.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../../core/runtime'
import { corePack } from '../../packs/core'
import type { BlockDefinition } from '../../core/types'
import { listSchedules } from '../../core/schedule'
import {
  scheduleAddCommand,
  scheduleListCommand,
  scheduleRemoveCommand,
  scheduleRunCommand,
} from './schedule'

// ---------------------------------------------------------------------------
// Env + process.exit mocking
// ---------------------------------------------------------------------------

// Capture console output so assertions can inspect it.
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
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    exitCode = typeof code === 'number' ? code : 1
    // Throw to stop execution after exit — caught in the test wrapper.
    throw new Error(`process.exit(${exitCode})`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

let ws: string

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sched-cli-'))
  // Point the workspace resolver at our tmp dir.
  process.env.AART_WORKSPACE = ws
})
afterEach(() => {
  delete process.env.AART_WORKSPACE
  fs.rmSync(ws, { recursive: true, force: true })
})

/** Register and optionally approve a workflow in the tmp workspace. */
function registerWorkflow(runtime: Runtime, approved: boolean): BlockDefinition {
  const wf: BlockDefinition = {
    id: 'test.schedule.workflow',
    name: 'Test Schedule Workflow',
    version: '0.1.0',
    inputs: [{ name: 'msg', type: 'string' }],
    outputs: [],
    execution: {
      type: 'workflow',
      steps: [
        {
          id: 'echo',
          block: 'artifact.write',
          inputs: { name: 'out.txt', content: '{{inputs.msg}}' },
        },
      ],
    },
    approval: approved ? 'approved' : 'draft',
  }
  runtime.fileRegistry.registerBlock(wf)
  return wf
}

/** Run a command and swallow the process.exit throw; return whether exit was called. */
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
// schedule add
// ---------------------------------------------------------------------------

describe('scheduleAddCommand', () => {
  it('refuses an unresolvable workflow (exit 1)', async () => {
    const { exited } = await run(() =>
      scheduleAddCommand('nonexistent.workflow', {
        cron: '0 9 * * 1-5',
        input: '{}',
        param: '{}',
      }),
    )
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('not found'))).toBe(true)
  })

  it('refuses an unapproved (draft) workflow (exit 1)', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, false /* draft */)

    const { exited } = await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{}',
        param: '{}',
      }),
    )
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('not fully approved'))).toBe(true)
  })

  it('writes a schedule record and prints a crontab line containing schedule run <id>', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, true /* approved */)

    const { exited } = await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{"msg":"hello"}',
        param: '{}',
      }),
    )
    expect(exited).toBe(false)

    // A schedule record must exist.
    const schedules = await listSchedules(ws)
    expect(schedules).toHaveLength(1)
    const rec = schedules[0]!
    expect(rec.workflowId).toBe('test.schedule.workflow')
    expect(rec.enabled).toBe(true)
    expect(rec.inputs).toEqual({ msg: 'hello' })

    // The printed output must contain a ready-to-paste crontab line.
    const allOut = stdoutLines.join('\n')
    expect(allOut).toContain('schedule run')
    expect(allOut).toContain(rec.scheduleId)
    expect(allOut).toContain('0 9 * * 1-5')
  })

  it('warns when an input value matches a secret literal', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, true)

    // Write a secrets.json with a known value.
    const aaDir = path.join(ws, '.aa')
    fs.mkdirSync(aaDir, { recursive: true })
    fs.writeFileSync(path.join(aaDir, 'secrets.json'), JSON.stringify({ mytoken: 'supersecret123' }))

    const { exited } = await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{"msg":"supersecret123"}',
        param: '{}',
      }),
    )
    expect(exited).toBe(false)
    expect(stderrLines.some((l) => l.includes('literal secret'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// schedule run (the tick entry point)
// ---------------------------------------------------------------------------

describe('scheduleRunCommand', () => {
  it('exits 1 for a missing/non-existent scheduleId without throwing', async () => {
    const { exited } = await run(() => scheduleRunCommand('00000000-dead-beef-0000-000000000000'))
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('not found'))).toBe(true)
  })

  it('re-checks approval and refuses (exit 1) when the pinned workflow is now draft', async () => {
    // Step 1: register as approved and create the schedule.
    const runtime = new Runtime(ws, [corePack])
    const wf = registerWorkflow(runtime, true)

    await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{"msg":"hi"}',
        param: '{}',
      }),
    )
    const schedules = await listSchedules(ws)
    const scheduleId = schedules[0]!.scheduleId

    // Step 2: reset the workflow back to draft (simulates re-register or deprecate).
    const degraded = { ...wf, approval: 'draft' as const }
    runtime.fileRegistry.registerBlock(degraded)

    // Step 3: tick — must refuse.
    const { exited } = await run(() => scheduleRunCommand(scheduleId))
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('not approved'))).toBe(true)
  })

  it('re-checks approval and refuses when the workflow is deprecated', async () => {
    const runtime = new Runtime(ws, [corePack])
    const wf = registerWorkflow(runtime, true)

    await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{"msg":"hi"}',
        param: '{}',
      }),
    )
    const scheduleId = (await listSchedules(ws))[0]!.scheduleId

    // Deprecate the workflow.
    runtime.fileRegistry.registerBlock({ ...wf, approval: 'deprecated' })

    const { exited } = await run(() => scheduleRunCommand(scheduleId))
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('not approved'))).toBe(true)
  })

  it('exits 1 without throwing when the workflow is deleted (getBlock returns undefined)', async () => {
    // Write a schedule record pointing at a workflow that does not exist.
    const { writeSchedule } = await import('../../core/schedule')
    await writeSchedule(ws, {
      scheduleId: 'orphan-schedule',
      workflowId: 'deleted.workflow',
      version: '0.1.0',
      cron: '0 9 * * 1-5',
      inputs: {},
      enabled: true,
      createdAt: new Date().toISOString(),
    })

    const { exited } = await run(() => scheduleRunCommand('orphan-schedule'))
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('workflow not found') || l.includes('not found'))).toBe(true)
  })

  it('produces exactly ONE new run dir under .aa/runs and updates lastStatus on success', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, true)

    await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{"msg":"hello from cron"}',
        param: '{}',
      }),
    )
    const scheduleId = (await listSchedules(ws))[0]!.scheduleId

    // Before: no runs.
    const runsDirBefore = path.join(ws, '.aa', 'runs')
    const beforeCount = fs.existsSync(runsDirBefore) ? fs.readdirSync(runsDirBefore).length : 0
    expect(beforeCount).toBe(0)

    const { exited } = await run(() => scheduleRunCommand(scheduleId))
    expect(exited).toBe(false)

    // After: exactly one run dir.
    const afterEntries = fs.readdirSync(runsDirBefore)
    expect(afterEntries).toHaveLength(1)

    // Schedule record updated with lastStatus.
    const updatedSchedules = await listSchedules(ws)
    const updated = updatedSchedules.find((s) => s.scheduleId === scheduleId)!
    expect(updated.lastStatus).toBe('COMPLETED')
    expect(updated.lastRunId).toBeTruthy()
    expect(updated.lastRunAt).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// schedule list + remove
// ---------------------------------------------------------------------------

describe('scheduleListCommand', () => {
  it('prints no-schedules message when empty', async () => {
    const { exited } = await run(() => scheduleListCommand())
    expect(exited).toBe(false)
    expect(stdoutLines.some((l) => l.includes('no schedules'))).toBe(true)
  })

  it('lists a schedule with its workflow and cron', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, true)

    await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '*/5 * * * *',
        input: '{}',
        param: '{}',
      }),
    )
    stdoutLines = []

    await run(() => scheduleListCommand())
    const allOut = stdoutLines.join('\n')
    expect(allOut).toContain('test.schedule.workflow')
    expect(allOut).toContain('*/5 * * * *')
  })
})

describe('scheduleRemoveCommand', () => {
  it('removes an existing schedule (exit 0)', async () => {
    const runtime = new Runtime(ws, [corePack])
    registerWorkflow(runtime, true)

    await run(() =>
      scheduleAddCommand('test.schedule.workflow', {
        cron: '0 9 * * 1-5',
        input: '{}',
        param: '{}',
      }),
    )
    const scheduleId = (await listSchedules(ws))[0]!.scheduleId
    stdoutLines = []

    const { exited } = await run(() => scheduleRemoveCommand(scheduleId))
    expect(exited).toBe(false)
    expect(stdoutLines.some((l) => l.includes('removed'))).toBe(true)
    expect(await listSchedules(ws)).toHaveLength(0)
  })

  it('exits 1 for a non-existent scheduleId', async () => {
    const { exited } = await run(() => scheduleRemoveCommand('no-such-id'))
    expect(exited).toBe(true)
    expect(exitCode).toBe(1)
    expect(stderrLines.some((l) => l.includes('not found'))).toBe(true)
  })
})
