import { createHash } from 'node:crypto'
import { nativeBlock } from '../../pack/types'
import { getPath } from '../../core/resolver'

// ---------------------------------------------------------------------------
// json.get — non-throwing sibling of assert.jsonpath
// ---------------------------------------------------------------------------

export const jsonGet = nativeBlock(
  {
    id: 'json.get',
    name: 'JSON Get',
    version: '0.1.0',
    description:
      'Extract a value by dot-path from a JSON object (or JSON string). ' +
      'Returns `fallback` (or undefined) when the path is missing — never throws on a miss. ' +
      'Non-throwing sibling of assert.jsonpath; use that block when you want the run to fail on a missing path.',
    category: 'data',
    keywords: ['extract', 'path', 'dot-path', 'jsonpath', 'pick', 'pluck', 'get'],
    examples: [
      {
        description: 'Extract a nested field from an API response object',
        inputs: { data: '{"user":{"name":"Alice"}}', path: 'user.name', fallback: 'unknown' },
      },
    ],
    inputs: [
      { name: 'data', type: 'any', required: true },
      { name: 'path', type: 'string', required: true },
      { name: 'fallback', type: 'any' },
    ],
    outputs: [{ name: 'value', type: 'any' }],
  },
  async (_ctx, inputs) => {
    let data: unknown = inputs.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        // If the string isn't JSON, treat it as an opaque value; path will miss.
        data = undefined
      }
    }
    const pathStr = String(inputs.path)
    const segments = pathStr.split('.')
    const value = getPath(data, segments)
    const fallback = 'fallback' in inputs ? inputs.fallback : undefined
    return { value: value !== undefined ? value : fallback }
  },
)

// ---------------------------------------------------------------------------
// text.template — single-brace {key} placeholder rendering
// ---------------------------------------------------------------------------

export const textTemplate = nativeBlock(
  {
    id: 'text.template',
    name: 'Text Template',
    version: '0.1.0',
    description:
      'Render a template string by replacing {key} placeholders with values from `values`. ' +
      'Uses SINGLE braces {key} — NOT double braces {{ }} which collide with aart\'s own resolver syntax. ' +
      'Unknown placeholders are left untouched. Values are stringified.',
    category: 'data',
    keywords: ['template', 'interpolate', 'render', 'format', 'substitute', 'placeholder', 'string'],
    examples: [
      {
        description: 'Build a greeting message from dynamic values',
        inputs: { template: 'Hello, {name}! You have {count} messages.', values: { name: 'Alice', count: 3 } },
      },
    ],
    inputs: [
      { name: 'template', type: 'string', required: true },
      { name: 'values', type: 'object', default: {} },
    ],
    outputs: [{ name: 'text', type: 'string' }],
  },
  async (_ctx, inputs) => {
    const template = String(inputs.template)
    const values = (inputs.values !== null && typeof inputs.values === 'object' && !Array.isArray(inputs.values))
      ? (inputs.values as Record<string, unknown>)
      : {}
    const text = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
      if (key in values) {
        return String(values[key])
      }
      return `{${key}}`
    })
    return { text }
  },
)

// ---------------------------------------------------------------------------
// base64.encode / base64.decode
// ---------------------------------------------------------------------------

export const base64Encode = nativeBlock(
  {
    id: 'base64.encode',
    name: 'Base64 Encode',
    version: '0.1.0',
    description: 'Encode a UTF-8 string to Base64.',
    category: 'data',
    keywords: ['base64', 'encode', 'binary', 'encoding', 'b64'],
    examples: [
      {
        description: 'Encode credentials for Basic auth header',
        inputs: { data: 'user:password' },
      },
    ],
    inputs: [{ name: 'data', type: 'string', required: true }],
    outputs: [{ name: 'encoded', type: 'string' }],
  },
  async (_ctx, inputs) => {
    const encoded = Buffer.from(String(inputs.data), 'utf8').toString('base64')
    return { encoded }
  },
)

export const base64Decode = nativeBlock(
  {
    id: 'base64.decode',
    name: 'Base64 Decode',
    version: '0.1.0',
    description: 'Decode a Base64 string to UTF-8.',
    category: 'data',
    keywords: ['base64', 'decode', 'binary', 'encoding', 'b64'],
    examples: [
      {
        description: 'Decode a Base64-encoded JWT payload segment',
        inputs: { data: 'SGVsbG8gV29ybGQ=' },
      },
    ],
    inputs: [{ name: 'data', type: 'string', required: true }],
    outputs: [{ name: 'decoded', type: 'string' }],
  },
  async (_ctx, inputs) => {
    const decoded = Buffer.from(String(inputs.data), 'base64').toString('utf8')
    return { decoded }
  },
)

// ---------------------------------------------------------------------------
// hash.sha256
// ---------------------------------------------------------------------------

export const hashSha256 = nativeBlock(
  {
    id: 'hash.sha256',
    name: 'SHA-256 Hash',
    version: '0.1.0',
    description: 'Compute the SHA-256 hash of a string. Returns hex or base64 depending on `encoding`.',
    category: 'data',
    keywords: ['hash', 'sha256', 'sha', 'digest', 'checksum', 'crypto'],
    examples: [
      {
        description: 'Hash a payload to verify integrity',
        inputs: { data: 'hello world', encoding: 'hex' },
      },
    ],
    inputs: [
      { name: 'data', type: 'string', required: true },
      { name: 'encoding', type: 'string', enum: ['hex', 'base64'], default: 'hex' },
    ],
    outputs: [{ name: 'hash', type: 'string' }],
  },
  async (_ctx, inputs) => {
    const enc: 'hex' | 'base64' = inputs.encoding === 'base64' ? 'base64' : 'hex'
    const hash = createHash('sha256').update(String(inputs.data)).digest(enc)
    return { hash }
  },
)

// ---------------------------------------------------------------------------
// regex.match
// ---------------------------------------------------------------------------

export const regexMatch = nativeBlock(
  {
    id: 'regex.match',
    name: 'Regex Match',
    version: '0.1.0',
    description:
      'Test a string against a regular expression. Returns matched:true/false, the first full match, ' +
      'and capture groups of the first match. Never throws on no-match — use assert.match when you want to fail on no-match.',
    category: 'data',
    keywords: ['regex', 'regexp', 'match', 'pattern', 'extract', 'capture', 'search'],
    examples: [
      {
        description: 'Extract version number from a string',
        inputs: { text: 'Version: 1.2.3', pattern: 'Version: (\\d+\\.\\d+\\.\\d+)', flags: '' },
      },
    ],
    inputs: [
      { name: 'text', type: 'string', required: true },
      { name: 'pattern', type: 'string', required: true },
      { name: 'flags', type: 'string', default: '' },
    ],
    outputs: [
      { name: 'matched', type: 'boolean' },
      { name: 'match', type: 'any' },   // string on match, null on no-match
      { name: 'groups', type: 'array' },
    ],
  },
  async (_ctx, inputs) => {
    const re = new RegExp(String(inputs.pattern), String(inputs.flags ?? ''))
    const result = re.exec(String(inputs.text))
    if (!result) {
      return { matched: false, match: null, groups: [] }
    }
    // result[0] is the full match; result[1..] are capture groups.
    const [fullMatch, ...captures] = result
    return {
      matched: true,
      match: fullMatch ?? null,
      groups: captures.map((g) => g ?? null),
    }
  },
)
