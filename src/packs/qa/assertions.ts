import { isDeepStrictEqual } from 'node:util'
import { nativeBlock } from '../../pack/types'

/** Stringify for error messages without throwing on circular/odd values. */
function show(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export const assertEquals = nativeBlock(
  {
    id: 'qa.assert.equals',
    name: 'Assert Equals',
    version: '0.1.0',
    description: 'Fail unless `actual` equals `expected`.',
    inputs: [
      { name: 'actual', type: 'any', required: true },
      { name: 'expected', type: 'any', required: true },
    ],
    outputs: [{ name: 'ok', type: 'boolean' }],
  },
  async (_ctx, inputs) => {
    const { actual, expected } = inputs
    // Deep, order-insensitive equality. Handles NaN, undefined-vs-missing, and
    // circular refs correctly (a JSON.stringify compare did not).
    const equal = actual === expected || isDeepStrictEqual(actual, expected)
    if (!equal) {
      throw new Error(`Assertion failed: expected ${show(expected)}, got ${show(actual)}`)
    }
    return { ok: true }
  },
)

export const assertContains = nativeBlock(
  {
    id: 'qa.assert.contains',
    name: 'Assert Contains',
    version: '0.1.0',
    description: 'Fail unless `value` (a string or array) contains `item`.',
    inputs: [
      { name: 'value', type: 'any', required: true },
      { name: 'item', type: 'any', required: true },
    ],
    outputs: [{ name: 'ok', type: 'boolean' }],
  },
  async (_ctx, inputs) => {
    const { value, item } = inputs
    const ok =
      typeof value === 'string'
        ? value.includes(String(item))
        : Array.isArray(value)
          ? value.includes(item)
          : false
    if (!ok) {
      throw new Error(`Assertion failed: ${show(value)} does not contain ${show(item)}`)
    }
    return { ok: true }
  },
)
