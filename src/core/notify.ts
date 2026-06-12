import fs from 'node:fs'
import path from 'node:path'
import { resolveValue } from './resolver'
import type { RunRecord, RunStatus } from './types'

export interface NotifyConfig {
  url: string
  format?: 'generic' | 'slack'
  on?: RunStatus[]
}

/**
 * Load the optional notification config from <workspace>/.aa/notify.json.
 * Absent file OR malformed JSON OR missing url => return undefined silently.
 * Mirrors the fault-tolerance of loadSecrets.
 */
export function loadNotifyConfig(workspace: string): NotifyConfig | undefined {
  const file = path.join(workspace, '.aa', 'notify.json')
  if (!fs.existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    const obj = parsed as Record<string, unknown>
    if (typeof obj['url'] !== 'string' || !obj['url']) return undefined
    const config: NotifyConfig = { url: obj['url'] }
    if (obj['format'] === 'slack' || obj['format'] === 'generic') {
      config.format = obj['format']
    }
    if (Array.isArray(obj['on'])) {
      const valid: RunStatus[] = []
      for (const v of obj['on']) {
        if (v === 'PENDING' || v === 'RUNNING' || v === 'COMPLETED' || v === 'FAILED') {
          valid.push(v as RunStatus)
        }
      }
      config.on = valid
    }
    return config
  } catch {
    return undefined
  }
}

interface NotifyPayload {
  runId: string
  blockId: string
  status: RunStatus
  error?: string
  startedAt: string
  durationMs?: number
}

/**
 * Build the minimal off-box payload from a run record.
 * ONLY the 6 listed fields — no trace, no snapshot, no inputs.
 * Read-only over the record (no mutation).
 */
function buildPayload(record: RunRecord): NotifyPayload {
  const payload: NotifyPayload = {
    runId: record.runId,
    blockId: record.blockId,
    status: record.status,
    startedAt: record.startedAt,
  }
  if (record.error !== undefined) payload.error = record.error
  if (record.startedAt && record.endedAt) {
    const durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt)
    if (!Number.isNaN(durationMs)) payload.durationMs = durationMs
  }
  return payload
}

/**
 * Fire a single webhook notification. Fully guarded — never throws.
 *
 * URL resolution failure (e.g. a misspelled {{secrets.NAME}}) is treated as a
 * configuration error and gets a loud warn. A transport failure (network down,
 * timeout) is a quieter warn-and-continue. In both cases the run record is
 * unaffected.
 */
export async function sendNotification(
  config: NotifyConfig,
  record: RunRecord,
  secrets: Record<string, string>,
  logger: { warn: (m: string) => void },
): Promise<void> {
  // Resolve the URL — this may reference {{secrets.NAME}}.
  // resolveValue THROWS on a missing secret reference; treat that as a loud
  // config-error (the operator mis-wired .aa/notify.json) and bail early.
  let resolvedUrl: string
  try {
    resolvedUrl = resolveValue(config.url, {
      inputs: {},
      steps: {},
      secrets,
    }) as string
  } catch (err) {
    logger.warn(
      `aart notify: webhook URL could not be resolved (check {{secrets.X}} / .aa/notify.json): ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }

  // Build the body.
  const payload = buildPayload(record)
  let body: string
  if (config.format === 'slack') {
    const errorSuffix = payload.error ? `: ${payload.error}` : ''
    body = JSON.stringify({
      text: `aart run ${record.blockId} ${record.status}${errorSuffix}`,
    })
  } else {
    body = JSON.stringify(payload)
  }

  // POST to the webhook. On failure, warn with only the host (not the full URL
  // which may carry a token) and continue.
  try {
    await fetch(resolvedUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    let host = resolvedUrl
    try {
      host = new URL(resolvedUrl).host
    } catch {
      // If the URL itself is invalid, fall back to a placeholder rather than
      // exposing the raw value (it might contain a token from the secrets map).
      host = '(invalid URL)'
    }
    logger.warn(
      `aart notify: webhook POST to ${host} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Convenience entry point: load config, check the status filter, and send.
 * Entirely guarded — never throws, never makes network calls when unconfigured.
 *
 * Because both CLI and MCP runs go through Runtime.run, agent-triggered
 * aa_run_workflow calls also notify when .aa/notify.json is present — this
 * is intentional (the operator opted in workspace-wide).
 */
export async function notify(
  workspace: string,
  record: RunRecord,
  secrets: Record<string, string>,
  logger: { warn: (m: string) => void },
): Promise<void> {
  try {
    const config = loadNotifyConfig(workspace)
    if (!config) return
    const filter = config.on ?? ['FAILED']
    if (!filter.includes(record.status)) return
    await sendNotification(config, record, secrets, logger)
  } catch (err) {
    // Belt-and-suspenders: sendNotification is internally guarded, but if
    // loadNotifyConfig or the filter logic somehow throws, suppress it.
    logger.warn(
      `aart notify: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
