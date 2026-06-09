import fs from 'node:fs'
import path from 'node:path'
import type { RunRecord } from './types'

/**
 * Secrets are referenced from a workflow as `{{secrets.NAME}}` in step inputs.
 * They are sourced from (env overrides file):
 *   - `<workspace>/.aa/secrets.json` — a flat { name: value } object (gitignored)
 *   - environment variables `AART_SECRET_<NAME>` (NAME lowercased)
 * The resolved values are REDACTED from the run report so credentials never
 * land in `.aa/runs/*.json`, the printed report, or the MCP tool result.
 */
export function loadSecrets(workspace: string): Record<string, string> {
  const secrets: Record<string, string> = {}

  const file = path.join(workspace, '.aa', 'secrets.json')
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') secrets[k] = v
      }
    } catch {
      // ignore a malformed secrets file; treat as no file secrets
    }
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AART_SECRET_') && typeof v === 'string') {
      secrets[k.slice('AART_SECRET_'.length).toLowerCase()] = v
    }
  }

  return secrets
}

/** Replace every occurrence of a secret value with `***` inside a string. */
function redactString(s: string, values: string[]): string {
  let out = s
  for (const v of values) out = out.split(v).join('***')
  return out
}

function redactValue(value: unknown, values: string[]): unknown {
  if (typeof value === 'string') return redactString(value, values)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, values))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, values)
    return out
  }
  return value
}

/**
 * Return a copy of the run record with all secret values masked. Very short
 * secrets (< 4 chars) are skipped to avoid mangling unrelated text.
 */
export function redactRecord(record: RunRecord, secrets: Record<string, string>): RunRecord {
  const values = Object.values(secrets).filter((v) => v.length >= 4)
  if (!values.length) return record
  return redactValue(record, values) as RunRecord
}
