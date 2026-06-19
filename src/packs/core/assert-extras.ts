import { nativeBlock } from '../../pack/types'

/** Stringify for error messages without throwing on circular/odd values. */
function show(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------
// assert.match — regex-based assertion
// ---------------------------------------------------------------------------

export const assertMatch = nativeBlock(
  {
    id: 'assert.match',
    name: 'Assert Match',
    version: '0.1.0',
    description: 'Fail unless `value` (string) matches the given regular expression.',
    category: 'assert',
    keywords: ['assert', 'match', 'regex', 'regexp', 'pattern', 'check', 'test'],
    examples: [
      {
        description: 'Assert a response body contains a version string',
        inputs: { value: 'version: 2.3.1', pattern: '\\d+\\.\\d+\\.\\d+', flags: '' },
      },
    ],
    inputs: [
      { name: 'value', type: 'string', required: true },
      { name: 'pattern', type: 'string', required: true },
      { name: 'flags', type: 'string', default: '' },
    ],
    outputs: [
      { name: 'ok', type: 'boolean' },
      { name: 'match', type: 'string' },
    ],
  },
  async (_ctx, inputs) => {
    const text = String(inputs.value)
    const re = new RegExp(String(inputs.pattern), String(inputs.flags ?? ''))
    const result = re.exec(text)
    if (!result) {
      throw new Error(
        `Assertion failed: ${show(text)} does not match /${String(inputs.pattern)}/${String(inputs.flags ?? '')}`,
      )
    }
    return { ok: true, match: result[0] ?? null }
  },
)

// ---------------------------------------------------------------------------
// assert.range — numeric range assertion
// ---------------------------------------------------------------------------

export const assertRange = nativeBlock(
  {
    id: 'assert.range',
    name: 'Assert Range',
    version: '0.1.0',
    description:
      'Fail unless `value` (number) is within the given [min, max] bounds. ' +
      'Either bound is optional: omit `min` to only check an upper bound, omit `max` for a lower bound only. ' +
      'Example: `assert.range value=$probe.latencyMs max=2000` asserts latency under 2 seconds.',
    category: 'assert',
    keywords: ['assert', 'range', 'min', 'max', 'bounds', 'threshold', 'numeric', 'check', 'latency'],
    examples: [
      {
        description: 'Assert latency is under 2 seconds',
        inputs: { value: 450, max: 2000 },
      },
    ],
    inputs: [
      { name: 'value', type: 'number', required: true },
      { name: 'min', type: 'number' },
      { name: 'max', type: 'number' },
    ],
    outputs: [{ name: 'ok', type: 'boolean' }],
  },
  async (_ctx, inputs) => {
    const value = Number(inputs.value)
    // NaN / Infinity: a non-finite value makes every comparison false, which
    // would silently pass a gate that was meant to reject. Throw instead so
    // callers get a clear error rather than a wrong ok:true.
    if (!Number.isFinite(value)) {
      throw new Error(`assert.range: value must be a finite number (got ${show(inputs.value)})`)
    }
    if (inputs.min !== undefined) {
      const min = Number(inputs.min)
      if (!Number.isFinite(min)) {
        throw new Error(`assert.range: min must be a finite number (got ${show(inputs.min)})`)
      }
      if (value < min) {
        throw new Error(`Assertion failed: ${value} is less than min ${min}`)
      }
    }
    if (inputs.max !== undefined) {
      const max = Number(inputs.max)
      if (!Number.isFinite(max)) {
        throw new Error(`assert.range: max must be a finite number (got ${show(inputs.max)})`)
      }
      if (value > max) {
        throw new Error(`Assertion failed: ${value} is greater than max ${max}`)
      }
    }
    return { ok: true }
  },
)
