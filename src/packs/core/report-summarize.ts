import { nativeBlock } from '../../pack/types'

export const reportSummarize = nativeBlock(
  {
    id: 'report.summarize',
    name: 'Report Summarize',
    version: '0.1.0',
    description:
      'Aggregate an array of pass/fail result objects into a human-readable evidence report. ' +
      'Accepts a raw array or a forEach step output `{items:[...]}`. ' +
      'Optionally persists the summary as a run artifact.',
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

    const items: unknown[] = Array.isArray(rawResults) ? rawResults : []
    const okKey = typeof inputs.okKey === 'string' && inputs.okKey ? inputs.okKey : 'ok'
    const title = typeof inputs.title === 'string' && inputs.title ? inputs.title : 'Report'
    const writeArtifact = inputs.writeArtifact !== false

    const total = items.length
    let passed = 0
    for (const item of items) {
      if (item !== null && typeof item === 'object' && (item as Record<string, unknown>)[okKey]) {
        passed++
      }
    }
    const failed = total - passed
    const ok = failed === 0

    // Build a readable multi-line summary.
    const lines: string[] = []
    lines.push(`# ${title}`)
    lines.push(`Total: ${total}  Passed: ${passed}  Failed: ${failed}  ${ok ? 'ALL PASSED' : 'FAILURES DETECTED'}`)
    lines.push('')
    for (const item of items) {
      if (item === null || typeof item !== 'object') {
        lines.push(`  - ${String(item)}`)
        continue
      }
      const r = item as Record<string, unknown>
      const pass = Boolean(r[okKey])
      const statusMark = pass ? 'PASS' : 'FAIL'
      // Include any key detail if present: url, status, error, name.
      const detail: string[] = []
      if (r.url !== undefined) detail.push(`url=${r.url}`)
      if (r.status !== undefined) detail.push(`status=${r.status}`)
      if (!pass && r.error) detail.push(`error=${r.error}`)
      if (r.name !== undefined) detail.push(`name=${r.name}`)
      lines.push(`  [${statusMark}] ${detail.join('  ')}`)
    }
    const summary = lines.join('\n')

    if (writeArtifact) {
      ctx.artifacts.attach('health-summary.md', summary, { mime: 'text/markdown', kind: 'report' })
    }

    return { total, passed, failed, ok, summary }
  },
)
