import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { nativeBlock } from '../../pack/types'

/**
 * Structured-data primitives: turn text into values and values into text.
 * These cover the formats automations actually meet (JSON, YAML, CSV) without
 * needing a dependency-bearing node block.
 */

/** Minimal RFC-4180 CSV reader: quoted fields, "" escapes, \r\n or \n rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAny = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
      sawAny = true
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAny = true
    } else field += c
  }
  if (field !== '' || row.length || !sawAny) {
    row.push(field)
    rows.push(row)
  }
  // A trailing newline produces a phantom empty row — drop it.
  const last = rows[rows.length - 1]
  if (rows.length > 1 && last && last.length === 1 && last[0] === '') rows.pop()
  return rows
}

export const dataParse = nativeBlock(
  {
    id: 'data.parse',
    name: 'Parse Data',
    version: '0.1.0',
    description:
      'Parse text into a structured value. `format`: "json", "yaml", or "csv". ' +
      'CSV returns an array of objects keyed by the header row (set `csvHeader` ' +
      'false for raw row arrays).',
    category: 'data',
    keywords: ['parse', 'json', 'yaml', 'csv', 'decode', 'deserialize', 'text', 'format', 'convert'],
    examples: [
      {
        description: 'Parse a JSON API response body into a structured value',
        inputs: { text: '{"status":"ok","count":3}', format: 'json' },
      },
    ],
    inputs: [
      { name: 'text', type: 'string', required: true },
      { name: 'format', type: 'string', required: true },
      { name: 'csvHeader', type: 'boolean' },
    ],
    outputs: [{ name: 'value', type: 'any' }],
  },
  async (_ctx, inputs) => {
    const text = String(inputs.text)
    const format = String(inputs.format).toLowerCase()
    if (format === 'json') return { value: JSON.parse(text) as unknown }
    if (format === 'yaml') return { value: parseYaml(text) as unknown }
    if (format === 'csv') {
      const rows = parseCsv(text)
      if (inputs.csvHeader === false) return { value: rows }
      const [header, ...rest] = rows
      if (!header) return { value: [] }
      return {
        value: rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))),
      }
    }
    throw new Error(`unknown format "${format}" — use json, yaml, or csv`)
  },
)

export const dataStringify = nativeBlock(
  {
    id: 'data.stringify',
    name: 'Stringify Data',
    version: '0.1.0',
    description:
      'Turn a value into text. `format`: "json" (pretty by default; `pretty` false ' +
      'for compact), "yaml", or "csv" (value must be an array of flat objects or ' +
      'an array of arrays).',
    category: 'data',
    keywords: ['stringify', 'serialize', 'json', 'yaml', 'csv', 'encode', 'text', 'format', 'convert'],
    examples: [
      {
        description: 'Serialize a result object to compact JSON for an HTTP body',
        inputs: { value: { status: 'ok' }, format: 'json', pretty: false },
      },
    ],
    inputs: [
      { name: 'value', type: 'any', required: true },
      { name: 'format', type: 'string', required: true },
      { name: 'pretty', type: 'boolean' },
    ],
    outputs: [{ name: 'text', type: 'string' }],
  },
  async (_ctx, inputs) => {
    const format = String(inputs.format).toLowerCase()
    const value = inputs.value
    if (format === 'json') {
      return { text: JSON.stringify(value, null, inputs.pretty === false ? undefined : 2) ?? 'null' }
    }
    if (format === 'yaml') return { text: stringifyYaml(value) }
    if (format === 'csv') {
      if (!Array.isArray(value)) throw new Error('csv needs an array of objects or arrays')
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : String(v)
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const rows = value as unknown[]
      if (rows.every((r) => Array.isArray(r))) {
        return { text: (rows as unknown[][]).map((r) => r.map(esc).join(',')).join('\n') }
      }
      const objs = rows as Record<string, unknown>[]
      const header = [...new Set(objs.flatMap((o) => Object.keys(o)))]
      const lines = [header.map(esc).join(',')]
      for (const o of objs) lines.push(header.map((h) => esc(o[h])).join(','))
      return { text: lines.join('\n') }
    }
    throw new Error(`unknown format "${format}" — use json, yaml, or csv`)
  },
)
