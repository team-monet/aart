import { isDeepStrictEqual } from 'node:util'
import { nativeBlock } from '../../pack/types'
import { getPath } from '../../core/resolver'

/** Stringify for error messages without throwing on circular/odd values. */
function show(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export const assertJsonpath = nativeBlock(
  {
    id: 'assert.jsonpath',
    name: 'Assert JSON Path',
    version: '0.1.0',
    description:
      'Extract a value by dot-path from a JSON object (or JSON string) and optionally ' +
      'assert it equals `expected` or that it `exists`.',
    category: 'assert',
    keywords: ['assert', 'jsonpath', 'json', 'path', 'dot-path', 'extract', 'exists', 'check', 'nested'],
    examples: [
      {
        description: 'Assert a nested field in an API response equals a specific value',
        inputs: { data: '{"user":{"role":"admin"}}', path: 'user.role', expected: 'admin' },
      },
    ],
    inputs: [
      { name: 'data', type: 'any', required: true },
      { name: 'path', type: 'string', required: true },
      { name: 'expected', type: 'any' },
      { name: 'exists', type: 'boolean', default: false },
    ],
    outputs: [
      { name: 'value', type: 'any' },
      { name: 'ok', type: 'boolean' },
    ],
  },
  async (_ctx, inputs) => {
    // If data is a string, try to JSON-parse it first.
    let data: unknown = inputs.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        throw new Error(`assert.jsonpath: data is a string but not valid JSON: ${String(data).slice(0, 200)}`)
      }
    }

    const pathStr = String(inputs.path)
    const segments = pathStr.split('.')
    const value = getPath(data, segments)

    // If `expected` was provided, assert deep equality.
    const hasExpected = 'expected' in inputs && inputs.expected !== undefined
    if (hasExpected) {
      const equal = value === inputs.expected || isDeepStrictEqual(value, inputs.expected)
      if (!equal) {
        throw new Error(
          `Assertion failed: at path "${pathStr}" expected ${show(inputs.expected)}, got ${show(value)}`,
        )
      }
    }

    // If `exists:true`, assert value is not undefined.
    const exists = inputs.exists === true
    if (exists && value === undefined) {
      throw new Error(`Assertion failed: path "${pathStr}" does not exist in data`)
    }

    return { value, ok: true }
  },
)
