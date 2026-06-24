import fs from 'node:fs'
import path from 'node:path'
import type { RunRecord } from './types'

/**
 * Thrown by loadSecrets when two keys in secrets.json or two AART_SECRET_*
 * env vars collapse to the same canonical (lowercased) name. Using a typed
 * error mirrors SecretNotDefinedError in resolver.ts and lets callers branch
 * on error TYPE rather than fragile message-string matching — rewording the
 * message cannot accidentally change control flow.
 */
export class SecretCollisionError extends Error {
  readonly code = 'SECRET_COLLISION' as const
  constructor(message: string) {
    super(message)
    this.name = 'SecretCollisionError'
  }
}

/**
 * Secrets are referenced from a workflow as `{{secrets.NAME}}` in step inputs.
 * They are sourced from (env overrides file):
 *   - `<workspace>/.aa/secrets.json` — a flat { name: value } object (gitignored)
 *   - environment variables `AART_SECRET_<NAME>` (NAME lowercased)
 *
 * Resolved secret values are then masked from the run report by
 * `redactRecord`. This is BEST-EFFORT defense-in-depth, NOT a hard guarantee:
 * it masks verbatim, JSON-escaped, and URL-encoded forms of each value wherever
 * they appear in the record, but it cannot catch other transforms (base64,
 * hashing, partial reflections) and it does NOT scrub artifact file contents
 * (e.g. a screenshot of a secret typed into a visible field). Treat the run
 * report as low-sensitivity, not secret-free.
 */
export function loadSecrets(workspace: string): Record<string, string> {
  const secrets: Record<string, string> = {}

  const file = path.join(workspace, '.aa', 'secrets.json')
  if (fs.existsSync(file)) {
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      // ignore a malformed secrets file; treat as no file secrets
    }
    if (parsed !== undefined) {
      // Collision detection: two keys that differ only in case would collapse to
      // the same canonical (lowercased) name — that is ambiguous, so throw.
      const seen = new Map<string, string>() // canonical -> original key
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string') continue
        const canonical = k.toLowerCase()
        const prior = seen.get(canonical)
        if (prior !== undefined) {
          throw new SecretCollisionError(
            `secrets.json has two keys that collide on the same canonical name "${canonical}": ` +
              `"${prior}" and "${k}". Remove one of them.`,
          )
        }
        seen.set(canonical, k)
        secrets[canonical] = v
      }
    }
  }

  // Collision detection: two AART_SECRET_* env vars that collapse to the same
  // lowercased name are ambiguous — throw rather than silently picking one.
  const envSeen = new Map<string, string>() // canonical -> original env key
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AART_SECRET_') && typeof v === 'string') {
      const name = k.slice('AART_SECRET_'.length).toLowerCase()
      if (!name) continue
      const prior = envSeen.get(name)
      if (prior !== undefined) {
        throw new SecretCollisionError(
          `Two environment variables collide on the same secret name "${name}": ` +
            `${prior} and ${k}. Remove one of them.`,
        )
      }
      envSeen.set(name, k)
      secrets[name] = v // env overrides file (same lowercased namespace)
    }
  }

  return secrets
}

/** Variant encodings of a secret value that commonly appear in records. */
function encodedForms(v: string): string[] {
  const out = new Set<string>([v])
  try {
    out.add(JSON.stringify(v).slice(1, -1)) // JSON-escaped (e.g. inside an api body)
  } catch {
    /* ignore */
  }
  try {
    out.add(encodeURIComponent(v)) // URL-encoded (e.g. in a query string)
  } catch {
    /* ignore */
  }
  return [...out]
}

/**
 * The list of strings to mask, longest-first so a longer secret is masked
 * before a shorter one that is its prefix. Values < 4 chars are skipped to
 * avoid mangling unrelated text.
 */
export function secretValues(secrets: Record<string, string>): string[] {
  const vals = new Set<string>()
  for (const v of Object.values(secrets)) {
    for (const form of encodedForms(v)) {
      if (form.length >= 4) vals.add(form)
    }
  }
  return [...vals].sort((a, b) => b.length - a.length)
}

/** Mask every occurrence of each value (assumed pre-sorted longest-first). */
export function redactText(s: string, values: string[]): string {
  let out = s
  for (const v of values) out = out.split(v).join('***')
  return out
}

function redactValue(value: unknown, values: string[]): unknown {
  if (typeof value === 'string') return redactText(value, values)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, values))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, values)
    return out
  }
  return value
}

/** Return a copy of the run record with secret values masked (best-effort). */
export function redactRecord(record: RunRecord, secrets: Record<string, string>): RunRecord {
  const values = secretValues(secrets)
  if (!values.length) return record
  return redactValue(record, values) as RunRecord
}
