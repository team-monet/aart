import { nativeBlock } from '../../pack/types'

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
    const equal = actual === expected || JSON.stringify(actual) === JSON.stringify(expected)
    if (!equal) {
      throw new Error(
        `Assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      )
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
      throw new Error(
        `Assertion failed: ${JSON.stringify(value)} does not contain ${JSON.stringify(item)}`,
      )
    }
    return { ok: true }
  },
)
