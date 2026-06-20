import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { unapprovedInTree, deprecatedInTree, approvalEnforced } from '../../core/approval'
import { openRuntime, resolveWorkspace } from '../workspace'
import {
  writeSchedule,
  readSchedule,
  listSchedules,
  removeSchedule,
} from '../../core/schedule'
import type { ScheduleRecord } from '../../core/schedule'
import { renderReport } from '../../core/report'
import { loadSecrets } from '../../core/secrets'

// ---------------------------------------------------------------------------
// Option interfaces
// ---------------------------------------------------------------------------

interface AddOpts {
  cron: string
  input: string
  param: string
  version?: string
}

// ---------------------------------------------------------------------------
// schedule add
// ---------------------------------------------------------------------------

/**
 * `aart schedule add <workflowId>` — pin a workflow to an OS-cron schedule.
 *
 * This command writes a .aa/schedules/<id>.json record and prints the
 * crontab line to install. aart holds NO long-lived process; the OS scheduler
 * owns the cadence, firing `aart schedule run <id>` on each tick.
 *
 * Version-pinning note: pinning records the version the user reviewed, but
 * does NOT freeze behavior if the workflow is re-registered in-place — a
 * re-register resets approval to draft and the next tick will refuse (the
 * safe failure mode). Watch `aart schedule list` (unapproved? flag) and
 * configure your OS mailer for mail-on-nonzero exit.
 */
export async function scheduleAddCommand(workflowId: string, opts: AddOpts): Promise<void> {
  const { dir: ws } = resolveWorkspace()
  const runtime = openRuntime(ws)

  // Resolve the workflow from the registry.
  const wf = runtime.registry.getBlock(workflowId, opts.version)
  if (!wf) {
    console.error(
      `Workflow not found in registry: ${workflowId}${opts.version ? `@${opts.version}` : ''}`,
    )
    console.error('List what is registered with:  aart list')
    process.exit(1)
  }

  // Approval gate: a scheduled workflow must have standing approval — no --yes.
  // Unattended runs cannot prompt the user. A DEPRECATED workflow always refuses
  // (independent of AART_REQUIRE_APPROVAL). A DRAFT/unapproved one refuses only
  // when approval enforcement is on.
  const pending = unapprovedInTree(wf, runtime.registry, true)
  const deprecated = deprecatedInTree(wf, runtime.registry, true)
  if (deprecated.length > 0) {
    console.error(`✗ refused — workflow is deprecated: ${deprecated.join(', ')}`)
    console.error('A deprecated workflow cannot be scheduled. Re-approve it first, or schedule a different workflow.')
    process.exit(1)
  }
  if (approvalEnforced() && pending.length > 0) {
    console.error(`✗ refused — workflow is not fully approved: ${pending.join(', ')}`)
    console.error(
      `Approve it first with:  aart approve ${pending.join(' && aart approve ')}`,
    )
    console.error(
      'Scheduled runs are unattended and cannot use --yes. Standing approval is required.',
    )
    process.exit(1)
  }

  // Parse --input / --param as JSON objects.
  const inputs = parseJsonObj(opts.input, '--input')
  const params = opts.param !== '{}' ? parseJsonObj(opts.param, '--param') : undefined

  // Warn if any input value looks like a loaded secret literal.
  const secrets = loadSecretsQuiet(ws)
  const secretValues = new Set(Object.values(secrets).filter((v): v is string => typeof v === 'string' && v.length > 0))
  for (const [key, val] of Object.entries(inputs)) {
    if (typeof val === 'string' && secretValues.has(val)) {
      console.error(
        `warn  --input ${key} appears to be a literal secret value. ` +
          'Schedule inputs are stored verbatim under .aa/schedules — use {{secrets.X}} instead.',
      )
    }
  }

  const scheduleId = randomUUID()
  const now = new Date().toISOString()

  const record: ScheduleRecord = {
    scheduleId,
    workflowId: wf.id,
    version: wf.version, // pin the resolved version
    cron: opts.cron,
    inputs,
    params,
    enabled: true,
    createdAt: now,
    requireApproval: approvalEnforced(),
  }

  await writeSchedule(ws, record)

  const absWs = path.resolve(ws)
  console.log(`schedule ${scheduleId} created`)
  console.log(`workflow: ${wf.id}@${wf.version}`)
  console.log(`workspace: ${absWs}`)
  console.log('')
  console.log('Install this crontab line (crontab -e):')
  console.log(`# m h dom mon dow`)
  console.log(`${opts.cron}  aart --workspace ${absWs} schedule run ${scheduleId}`)
  console.log('')
  console.log(
    'Note: "aart" must be on PATH as seen by cron/launchd (check with `which aart`).',
  )
  console.log(
    'Failed ticks (exit 1) are visible via the OS mailer (MAILTO in crontab, or launchd StandardErrorPath).',
  )
  if (approvalEnforced()) {
    console.log(
      'Approval enforcement: this schedule was created with AART_REQUIRE_APPROVAL=1 and will',
    )
    console.log(
      'refuse draft/unapproved workflows at fire time regardless of the cron environment.',
    )
  }
  console.log(
    'Version-pinning note: if the workflow is re-registered (same version), approval resets to draft',
  )
  console.log(
    'and the next tick will refuse — the schedule goes dark. Watch `aart schedule list` for the unapproved? flag.',
  )
}

// ---------------------------------------------------------------------------
// schedule list
// ---------------------------------------------------------------------------

/** `aart schedule list` — table of all schedules with a live unapproved? flag. */
export async function scheduleListCommand(): Promise<void> {
  const { dir: ws } = resolveWorkspace()
  const runtime = openRuntime(ws)
  const schedules = await listSchedules(ws)

  if (!schedules.length) {
    console.log('no schedules registered yet — try:  aart schedule add <workflow>')
    return
  }

  // Header
  console.log(
    [
      'ID'.padEnd(12),
      'WORKFLOW'.padEnd(30),
      'CRON'.padEnd(20),
      'ENABLED'.padEnd(8),
      'LAST_STATUS'.padEnd(12),
      'LAST_RUN_AT'.padEnd(24),
      'UNAPPROVED?',
    ].join('  '),
  )

  for (const s of schedules) {
    const shortId = s.scheduleId.slice(0, 8)
    const workflowCol = `${s.workflowId}${s.version ? `@${s.version}` : ''}`.slice(0, 30)
    const cronCol = s.cron.slice(0, 20)
    const enabledCol = s.enabled ? 'yes' : 'no'
    const statusCol = s.lastStatus ?? '-'
    const runAtCol = s.lastRunAt ? s.lastRunAt.slice(0, 23) : '-'

    // Live unapproved? flag: re-resolve the workflow and check approval.
    let unapprovedFlag = '-'
    try {
      const wf = runtime.registry.getBlock(s.workflowId, s.version)
      if (!wf) {
        unapprovedFlag = 'DELETED'
      } else {
        const pending = unapprovedInTree(wf, runtime.registry, true)
        unapprovedFlag = pending.length > 0 ? `yes (${pending.join(',')})` : 'no'
      }
    } catch {
      unapprovedFlag = 'ERR'
    }

    console.log(
      [
        shortId.padEnd(12),
        workflowCol.padEnd(30),
        cronCol.padEnd(20),
        enabledCol.padEnd(8),
        statusCol.padEnd(12),
        runAtCol.padEnd(24),
        unapprovedFlag,
      ].join('  '),
    )
  }
}

// ---------------------------------------------------------------------------
// schedule remove
// ---------------------------------------------------------------------------

/** `aart schedule remove <scheduleId>` — delete a schedule record. */
export async function scheduleRemoveCommand(scheduleId: string): Promise<void> {
  const { dir: ws } = resolveWorkspace()
  const removed = await removeSchedule(ws, scheduleId)
  if (!removed) {
    console.error(`schedule not found: ${scheduleId}`)
    process.exit(1)
  }
  console.log(`removed schedule ${scheduleId}`)
  console.log('Remember to remove the corresponding crontab/launchd entry.')
}

// ---------------------------------------------------------------------------
// schedule run  (the OS-tick entry point)
// ---------------------------------------------------------------------------

/**
 * `aart schedule run <scheduleId>` — the cron/launchd tick handler.
 *
 * This is the command installed into the OS scheduler. It:
 *   1. Reads the schedule record.
 *   2. Re-checks approval at fire time (a deprecated workflow always refuses;
 *      a draft/unapproved one refuses only when approval enforcement is on).
 *   3. Runs the workflow via runtime.run(..., { approved: true }).
 *   4. Updates lastRunId/lastStatus/lastRunAt on the record.
 *   5. Exits 1 on FAILED (so OS mailers report the failure).
 *
 * Version-pinning safety: if the pinned version was re-registered in-place,
 * its approval is reset to draft and this command exits 1 without running —
 * the safe failure mode. The schedule going dark is deterministic and visible
 * via `aart schedule list` and OS mail-on-nonzero.
 */
export async function scheduleRunCommand(scheduleId: string): Promise<void> {
  const { dir: ws } = resolveWorkspace()

  // Read the schedule record — missing ⇒ clear error, exit 1.
  let schedule: ScheduleRecord
  try {
    schedule = await readSchedule(ws, scheduleId)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`schedule not found: ${scheduleId}`)
      console.error(`Workspace: ${ws}`)
      console.error('If this workspace differs from the one used at schedule add time, pass --workspace.')
      process.exit(1)
    }
    console.error(
      `failed to read schedule ${scheduleId}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  const runtime = openRuntime(ws)

  // Resolve the workflow — getBlock returning undefined must NOT throw.
  const wf = runtime.registry.getBlock(schedule.workflowId, schedule.version)
  if (!wf) {
    console.error(
      `schedule ${scheduleId}: workflow not found — ${schedule.workflowId}${schedule.version ? `@${schedule.version}` : ''}`,
    )
    console.error(
      'The workflow may have been deleted or is not registered on this host (schedules are workspace-local).',
    )
    console.error(`Remove this schedule with:  aart schedule remove ${scheduleId}`)
    process.exit(1)
  }

  // Re-check approval at fire time. No --yes for unattended runs.
  // A DEPRECATED workflow always refuses (independent of AART_REQUIRE_APPROVAL).
  // A DRAFT/unapproved one refuses only when approval enforcement is on.
  const pending = unapprovedInTree(wf, runtime.registry, true)
  const deprecated = deprecatedInTree(wf, runtime.registry, true)
  if (deprecated.length > 0) {
    console.error(`schedule ${scheduleId}: refused — workflow is deprecated: ${deprecated.join(', ')}`)
    console.error(`A deprecated workflow will not run on a schedule. Re-approve it, or remove the schedule with:  aart schedule remove ${scheduleId}`)
    process.exit(1)
  }
  if ((schedule.requireApproval || approvalEnforced()) && pending.length > 0) {
    console.error(
      `schedule ${scheduleId}: refused — workflow is not approved: ${pending.join(', ')}`,
    )
    console.error(
      'The workflow may have been re-registered (resetting approval to draft).',
    )
    console.error(
      `Re-approve with:  aart approve ${pending.join(' && aart approve ')}`,
    )
    console.error(
      'Unattended runs require standing approval — there is no --yes override for scheduled runs.',
    )
    process.exit(1)
  }

  // Run the workflow.
  const record = await runtime.run(
    wf,
    schedule.inputs,
    schedule.params,
    { approved: pending.length === 0 },
  )

  // Update the schedule record with the outcome.
  const updated: ScheduleRecord = {
    ...schedule,
    lastRunId: record.runId,
    lastStatus: record.status,
    lastRunAt: record.endedAt ?? record.startedAt,
  }
  await writeSchedule(ws, updated)

  // Print the report.
  const reportPath = `.aa/runs/${record.runId}/run.json`
  console.log(renderReport(record))
  console.log(`\nreport: ${reportPath}`)

  if (record.status === 'FAILED') process.exit(1)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonObj(value: string, flag: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    console.error(`Invalid ${flag}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** Load secrets without crashing if the file is absent or malformed. */
function loadSecretsQuiet(ws: string): Record<string, string> {
  try {
    return loadSecrets(ws)
  } catch {
    return {}
  }
}
