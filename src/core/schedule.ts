import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RunStatus } from './types'

export interface ScheduleRecord {
  scheduleId: string
  workflowId: string
  /**
   * The workflow version pinned at `schedule add` time. Pinning records the
   * exact shape the user reviewed. However, pinning does NOT freeze behavior
   * across in-place re-registers: re-registering the same version resets
   * approval to draft (per AGENTS.md), so `schedule run` will refuse —
   * the schedule goes dark deterministically (the safe failure mode). Use
   * `aart schedule list` (unapproved? column) and OS mail-on-nonzero for
   * visibility; there is no push alert.
   */
  version?: string
  /**
   * Whether approval enforcement was on when this schedule was created.
   * Honored at fire time regardless of the cron/launchd environment, so a
   * user who set AART_REQUIRE_APPROVAL=1 at add-time gets enforcement on
   * unattended ticks even when that env var is absent in cron's environment.
   * Undefined on records written before this field existed — falls back to
   * the current env (preserving prior behavior).
   */
  requireApproval?: boolean
  /** cron(5) expression (5 or 6 fields). Stored for documentation; the OS
   *  scheduler owns the cadence — aart never polls or loops. */
  cron: string
  inputs: Record<string, unknown>
  params?: Record<string, unknown>
  enabled: boolean
  createdAt: string
  lastRunId?: string
  lastStatus?: RunStatus
  lastRunAt?: string
}

export function scheduleDir(workspace: string): string {
  return path.join(workspace, '.aa', 'schedules')
}

export async function writeSchedule(workspace: string, rec: ScheduleRecord): Promise<void> {
  const dir = scheduleDir(workspace)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${rec.scheduleId}.json`), JSON.stringify(rec, null, 2))
}

export async function readSchedule(workspace: string, id: string): Promise<ScheduleRecord> {
  const file = path.join(scheduleDir(workspace), `${id}.json`)
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text) as ScheduleRecord
}

/** All schedule records. Skips malformed/partial files. Missing dir returns []. */
export async function listSchedules(workspace: string): Promise<ScheduleRecord[]> {
  const dir = scheduleDir(workspace)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: ScheduleRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const text = await fs.readFile(path.join(dir, name), 'utf8')
      const parsed = JSON.parse(text) as ScheduleRecord
      // Minimal shape-check: require the fields the rest of the code relies on.
      if (typeof parsed.scheduleId === 'string' && typeof parsed.workflowId === 'string') {
        out.push(parsed)
      }
    } catch {
      // Skip a malformed or partial file — mirror listRuns in src/core/report.ts.
    }
  }
  return out
}

/** Remove a schedule file. Returns true if it existed, false if not found. */
export async function removeSchedule(workspace: string, id: string): Promise<boolean> {
  const file = path.join(scheduleDir(workspace), `${id}.json`)
  try {
    await fs.unlink(file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
