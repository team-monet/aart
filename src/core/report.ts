import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ArtifactMeta, RunRecord, RunStatus } from './types'
import { ArtifactSchema } from './types'

/**
 * Normalize the on-disk artifacts field to ArtifactMeta[]. Legacy run.json
 * files stored artifacts as string[] (bare paths); new records store objects.
 * This function is idempotent: already-normalized objects pass through unchanged.
 */
export function coerceArtifacts(raw: unknown): ArtifactMeta[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry): ArtifactMeta => {
    if (typeof entry === 'string') {
      return {
        name: path.basename(entry),
        path: entry,
        mime: 'application/octet-stream',
        bytes: 0,
        kind: 'file',
      }
    }
    const parsed = ArtifactSchema.safeParse(entry)
    if (parsed.success) return parsed.data
    // Partial object — salvage what we can.
    const e = entry as Record<string, unknown>
    return {
      name: typeof e.name === 'string' ? e.name : 'unknown',
      path: typeof e.path === 'string' ? e.path : '',
      mime: typeof e.mime === 'string' ? e.mime : 'application/octet-stream',
      bytes: typeof e.bytes === 'number' ? e.bytes : 0,
      kind: 'file',
      stepId: typeof e.stepId === 'string' ? e.stepId : undefined,
    }
  })
}

export function runDir(workspace: string, runId: string): string {
  return path.join(workspace, '.aa', 'runs', runId)
}

/** Persist the run record. (Phase 1 writes once; a two-phase RUNNING→terminal
 *  write for crash-visibility is a planned refinement — see the plan.) */
export async function writeRun(workspace: string, record: RunRecord): Promise<string> {
  const dir = runDir(workspace, record.runId)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'run.json')
  await fs.writeFile(file, JSON.stringify(record, null, 2))
  return file
}

export async function readRun(workspace: string, runId: string): Promise<RunRecord> {
  const file = path.join(runDir(workspace, runId), 'run.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as RunRecord
  raw.artifacts = coerceArtifacts((raw as unknown as Record<string, unknown>).artifacts)
  return raw
}

export interface RunSummary {
  runId: string
  blockId: string
  status: RunStatus
  approved?: boolean
  startedAt: string
  endedAt?: string
}

/** Recent run summaries (newest first) for the catalog of past runs. */
export async function listRuns(workspace: string, limit = 20): Promise<RunSummary[]> {
  const dir = path.join(workspace, '.aa', 'runs')
  let ids: string[]
  try {
    ids = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: RunSummary[] = []
  for (const id of ids) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(dir, id, 'run.json'), 'utf8')) as RunRecord
      out.push({
        runId: r.runId,
        blockId: r.blockId,
        status: r.status,
        approved: r.approved,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })
    } catch {
      // skip an unreadable/partial run dir
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit)
}

const glyph = (s: RunStatus): string =>
  s === 'COMPLETED' ? '✓' : s === 'FAILED' ? '✗' : s === 'RUNNING' ? '…' : '○'

/** Render a run record as readable text for the CLI. */
export function renderReport(record: RunRecord): string {
  const lines: string[] = []
  lines.push(`${glyph(record.status)} ${record.blockId}  [${record.status}]  run ${record.runId}`)
  if (record.approved === false) {
    lines.push('  ⚠ ran UNAPPROVED (one-time --yes override)')
  }
  if (record.endedAt) {
    const ms = Date.parse(record.endedAt) - Date.parse(record.startedAt)
    lines.push(`  duration: ${ms}ms`)
  }
  if (Object.keys(record.inputs).length) {
    lines.push(`  inputs: ${JSON.stringify(record.inputs)}`)
  }
  for (const t of record.trace) {
    lines.push(`  ${glyph(t.status)} ${t.stepId} → ${t.block}`)
    if (t.error) lines.push(`      error: ${t.error}`)
    else if (t.outputs) lines.push(`      out: ${JSON.stringify(t.outputs)}`)
  }
  if (record.error) lines.push(`  ✗ ${record.error}`)
  if (record.results) lines.push(`  results: ${JSON.stringify(record.results)}`)
  if (record.artifacts.length) {
    lines.push('  artifacts:')
    for (const a of record.artifacts) {
      if (typeof a === 'string') {
        lines.push(`    - ${a}`)
      } else {
        lines.push(`    - ${a.path} (${a.kind}, ${a.bytes}B)`)
      }
    }
  }
  return lines.join('\n')
}
