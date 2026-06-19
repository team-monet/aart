import { nativeBlock } from '../../pack/types'
import { secretValues, redactText } from '../../core/secrets'

export const reportSummarize = nativeBlock(
  {
    id: 'report.summarize',
    name: 'Report Summarize',
    version: '0.1.0',
    description:
      'Aggregate an array of pass/fail result objects into a human-readable evidence report. ' +
      'Accepts a raw array or a forEach step output `{items:[...]}`. ' +
      'Optionally persists the summary as a run artifact.',
    category: 'report',
    keywords: ['report', 'summarize', 'aggregate', 'pass', 'fail', 'results', 'health', 'summary', 'evidence'],
    examples: [
      {
        description: 'Summarize health-check probe results into a pass/fail report',
        inputs: { results: [{ ok: true, url: 'https://api.example.com' }], title: 'Health Check' },
      },
    ],
    inputs: [
      { name: 'results', type: 'any', required: true },
      { name: 'okKey', type: 'string', default: 'ok' },
      { name: 'title', type: 'string', default: 'Report' },
      { name: 'writeArtifact', type: 'boolean', default: true },
    ],
    outputs: [
      { name: 'total', type: 'number' },
      { name: 'passed', type: 'number' },
      { name: 'failed', type: 'number' },
      { name: 'ok', type: 'boolean' },
      { name: 'summary', type: 'string' },
    ],
  },
  async (ctx, inputs) => {
    // Normalize: unwrap forEach's {items:[...]} shape, or accept a raw array.
    let rawResults: unknown = inputs.results
    if (
      rawResults !== null &&
      typeof rawResults === 'object' &&
      !Array.isArray(rawResults) &&
      Array.isArray((rawResults as Record<string, unknown>).items)
    ) {
      rawResults = (rawResults as Record<string, unknown>).items
    }

    // Reject a non-array results shape (a plain object, string, etc.) rather than
    // silently coercing it to an empty array — otherwise a wiring bug becomes a
    // false "0 failures" pass. (A forEach {items:[...]} shape was unwrapped above.)
    if (!Array.isArray(rawResults)) {
      throw new Error(
        `report.summarize: 'results' must be an array or a forEach {items:[...]} shape (got ${
          rawResults === null ? 'null' : typeof rawResults
        })`,
      )
    }
    const items: unknown[] = rawResults
    const okKey = typeof inputs.okKey === 'string' && inputs.okKey ? inputs.okKey : 'ok'
    const title = typeof inputs.title === 'string' && inputs.title ? inputs.title : 'Report'
    const writeArtifact = inputs.writeArtifact !== false

    // A result passes only if its okKey is boolean true (or the string "true",
    // common when a command block produced the value). A bare truthy check would
    // count the string "false" as a pass and under-report failures.
    const isPass = (v: unknown): boolean =>
      v === true || (typeof v === 'string' && v.toLowerCase() === 'true')

    const total = items.length
    let passed = 0
    for (const item of items) {
      if (item !== null && typeof item === 'object' && isPass((item as Record<string, unknown>)[okKey])) {
        passed++
      }
    }
    const failed = total - passed
    // An empty result set is NOT a pass — "0 of 0 passed" must not report healthy
    // (e.g. http.health-check with endpoints: [] would otherwise show ALL PASSED).
    const ok = total > 0 && failed === 0

    // Build a readable multi-line summary.
    const lines: string[] = []
    lines.push(`# ${title}`)
    lines.push(`Total: ${total}  Passed: ${passed}  Failed: ${failed}  ${total === 0 ? 'NO RESULTS' : ok ? 'ALL PASSED' : 'FAILURES DETECTED'}`)
    lines.push('')
    for (const item of items) {
      if (item === null || typeof item !== 'object') {
        lines.push(`  - ${String(item)}`)
        continue
      }
      const r = item as Record<string, unknown>
      const pass = isPass(r[okKey])
      const statusMark = pass ? 'PASS' : 'FAIL'
      // Include any key detail if present: url, status, error, name.
      const detail: string[] = []
      if (r.url !== undefined) detail.push(`url=${r.url}`)
      if (r.status !== undefined) detail.push(`status=${r.status}`)
      if (!pass && r.error) detail.push(`error=${r.error}`)
      if (r.name !== undefined) detail.push(`name=${r.name}`)
      lines.push(`  [${statusMark}] ${detail.join('  ')}`)
    }
    // Redact secret values before the summary is written to disk or returned.
    // Artifact file CONTENTS are NOT covered by the run-record redaction, so a
    // secret embedded in a probe URL or error would otherwise leak verbatim into
    // health-summary.md.
    const summary = redactText(lines.join('\n'), secretValues(ctx.secrets ?? {}))

    if (writeArtifact) {
      ctx.artifacts.attach('health-summary.md', summary, { mime: 'text/markdown', kind: 'report' })
    }

    return { total, passed, failed, ok, summary }
  },
)
