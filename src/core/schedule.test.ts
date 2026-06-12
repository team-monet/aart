import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  writeSchedule,
  readSchedule,
  listSchedules,
  removeSchedule,
  scheduleDir,
} from './schedule'
import type { ScheduleRecord } from './schedule'

let ws: string

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sched-'))
})
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))

function makeRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    scheduleId: 'test-id-1',
    workflowId: 'my.workflow',
    version: '0.1.0',
    cron: '0 9 * * 1-5',
    inputs: { url: 'https://example.com' },
    params: { retries: 3 },
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('writeSchedule / readSchedule round-trip', () => {
  it('writes and reads back an identical record', async () => {
    const rec = makeRecord()
    await writeSchedule(ws, rec)
    const loaded = await readSchedule(ws, rec.scheduleId)
    expect(loaded).toEqual(rec)
  })

  it('creates the schedules dir if it does not exist', async () => {
    const rec = makeRecord({ scheduleId: 'new-dir-test' })
    await writeSchedule(ws, rec)
    expect(fs.existsSync(path.join(scheduleDir(ws), 'new-dir-test.json'))).toBe(true)
  })

  it('overwrites the record on a second write (lastRun fields update)', async () => {
    const rec = makeRecord()
    await writeSchedule(ws, rec)

    const updated: ScheduleRecord = {
      ...rec,
      lastRunId: 'run-abc',
      lastStatus: 'COMPLETED',
      lastRunAt: '2026-06-12T09:00:01.000Z',
    }
    await writeSchedule(ws, updated)

    const loaded = await readSchedule(ws, rec.scheduleId)
    expect(loaded.lastRunId).toBe('run-abc')
    expect(loaded.lastStatus).toBe('COMPLETED')
    expect(loaded.lastRunAt).toBe('2026-06-12T09:00:01.000Z')
  })

  it('readSchedule throws ENOENT for a missing id', async () => {
    await expect(readSchedule(ws, 'does-not-exist')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('listSchedules', () => {
  it('returns [] for a missing schedules dir', async () => {
    const freshWs = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sched-fresh-'))
    try {
      expect(await listSchedules(freshWs)).toEqual([])
    } finally {
      fs.rmSync(freshWs, { recursive: true, force: true })
    }
  })

  it('returns [] for an empty schedules dir', async () => {
    await fs.promises.mkdir(scheduleDir(ws), { recursive: true })
    expect(await listSchedules(ws)).toEqual([])
  })

  it('lists all valid records', async () => {
    const r1 = makeRecord({ scheduleId: 'id-one' })
    const r2 = makeRecord({ scheduleId: 'id-two', workflowId: 'other.workflow' })
    await writeSchedule(ws, r1)
    await writeSchedule(ws, r2)

    const list = await listSchedules(ws)
    const ids = list.map((r) => r.scheduleId).sort()
    expect(ids).toEqual(['id-one', 'id-two'])
  })

  it('SKIPS a malformed/partial file and returns the valid ones', async () => {
    const r1 = makeRecord({ scheduleId: 'valid-id' })
    await writeSchedule(ws, r1)

    // Write a corrupted JSON file next to the valid one.
    const dir = scheduleDir(ws)
    await fs.promises.writeFile(path.join(dir, 'bad-json.json'), '{ not valid json !!!', 'utf8')

    // Write a structurally valid JSON that lacks the required fields.
    await fs.promises.writeFile(
      path.join(dir, 'missing-fields.json'),
      JSON.stringify({ someRandomKey: 'value' }),
      'utf8',
    )

    const list = await listSchedules(ws)
    expect(list).toHaveLength(1)
    expect(list[0]!.scheduleId).toBe('valid-id')
  })

  it('ignores non-.json files', async () => {
    await fs.promises.mkdir(scheduleDir(ws), { recursive: true })
    await fs.promises.writeFile(path.join(scheduleDir(ws), 'README'), 'not json', 'utf8')
    expect(await listSchedules(ws)).toEqual([])
  })
})

describe('removeSchedule', () => {
  it('removes an existing schedule and returns true', async () => {
    const rec = makeRecord({ scheduleId: 'to-remove' })
    await writeSchedule(ws, rec)

    const result = await removeSchedule(ws, 'to-remove')
    expect(result).toBe(true)
    await expect(readSchedule(ws, 'to-remove')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns false for a non-existent schedule (does not throw)', async () => {
    const result = await removeSchedule(ws, 'ghost-id')
    expect(result).toBe(false)
  })
})

describe('lastRun fields update', () => {
  it('persists all lastRun fields after an update', async () => {
    const rec = makeRecord({ scheduleId: 'upd-test' })
    await writeSchedule(ws, rec)

    // Simulate what scheduleRunCommand does after a successful run.
    const updated: ScheduleRecord = {
      ...rec,
      lastRunId: 'run-xyz-123',
      lastStatus: 'FAILED',
      lastRunAt: '2026-06-12T10:30:00.000Z',
    }
    await writeSchedule(ws, updated)

    const loaded = await readSchedule(ws, 'upd-test')
    expect(loaded.lastRunId).toBe('run-xyz-123')
    expect(loaded.lastStatus).toBe('FAILED')
    expect(loaded.lastRunAt).toBe('2026-06-12T10:30:00.000Z')
    // Other fields unchanged.
    expect(loaded.workflowId).toBe('my.workflow')
    expect(loaded.cron).toBe('0 9 * * 1-5')
    expect(loaded.inputs).toEqual({ url: 'https://example.com' })
  })
})
