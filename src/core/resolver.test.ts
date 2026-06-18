import { describe, it, expect } from 'vitest'
import { resolveValue, resolveInputs, resolveTyped, evalCondition, type ResolveScope } from './resolver'

const scope: ResolveScope = {
  inputs: { name: 'ada', n: 5, flag: true },
  steps: { step1: { val: 42, nested: { x: 'deep' } } },
}

describe('resolveValue', () => {
  it('interpolates {{inputs.x}} as a string', () => {
    expect(resolveValue('hi {{inputs.name}}', scope)).toBe('hi ada')
  })
  it('resolves a $step ref preserving its type', () => {
    expect(resolveValue('$step1.val', scope)).toBe(42)
  })
  it('resolves NESTED $step refs (legacy was one level deep)', () => {
    expect(resolveValue('$step1.nested.x', scope)).toBe('deep')
  })
  it('throws on an unknown step reference', () => {
    expect(() => resolveValue('$nope.val', scope)).toThrow(/Unknown step/)
  })
  it('throws on an unresolved interpolation', () => {
    expect(() => resolveValue('{{inputs.missing}}', scope)).toThrow(/Unresolved/)
  })
  it('passes through non-strings', () => {
    expect(resolveValue(7, scope)).toBe(7)
    expect(resolveValue(true, scope)).toBe(true)
  })
  it('resolves nested objects and arrays', () => {
    expect(resolveInputs({ a: '{{inputs.name}}', b: '$step1.val', c: ['$step1.val'] }, scope)).toEqual(
      { a: 'ada', b: 42, c: [42] },
    )
  })
})

describe('evalCondition (safe, no eval)', () => {
  it('compares numbers', () => {
    expect(evalCondition('inputs.n > 3', scope)).toBe(true)
    expect(evalCondition('inputs.n < 3', scope)).toBe(false)
    expect(evalCondition('inputs.n === 5', scope)).toBe(true)
  })
  it('evaluates bare truthiness', () => {
    expect(evalCondition('inputs.flag', scope)).toBe(true)
  })
  it('compares against quoted strings', () => {
    expect(evalCondition("inputs.name === 'ada'", scope)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveTyped — type-preserving resolution for forEach expressions
// ---------------------------------------------------------------------------

describe('resolveTyped', () => {
  const typedScope: ResolveScope = {
    inputs: { tags: ['a', 'b', 'c'], count: 5 },
    steps: { s1: { items: [1, 2, 3] } },
  }

  it('{{inputs.tags}} returns the actual array (not "a,b,c")', () => {
    expect(resolveTyped('{{inputs.tags}}', typedScope)).toEqual(['a', 'b', 'c'])
  })

  it('{{inputs.count}} returns the number (not "5")', () => {
    expect(resolveTyped('{{inputs.count}}', typedScope)).toBe(5)
  })

  it('$s1.items returns the typed array via $-ref', () => {
    expect(resolveTyped('$s1.items', typedScope)).toEqual([1, 2, 3])
  })

  it('a multi-token string still stringifies (not a whole-template)', () => {
    expect(resolveTyped('prefix {{inputs.count}}', typedScope)).toBe('prefix 5')
  })
})

// ---------------------------------------------------------------------------
// forEach loop bindings
// ---------------------------------------------------------------------------

describe('forEach loop bindings', () => {
  const loopScope: ResolveScope = {
    inputs: { name: 'outer' },
    steps: { prev: { result: 'done' } },
    loopVar: { name: 'item', value: { url: 'https://example.com', status: 200, ok: true } },
    loopIndex: 2,
  }

  it('$item.field preserves the original type (number)', () => {
    expect(resolveValue('$item.status', loopScope)).toBe(200)
  })

  it('$item.field preserves boolean type', () => {
    expect(resolveValue('$item.ok', loopScope)).toBe(true)
  })

  it('{{item.url}} interpolates as a string', () => {
    expect(resolveValue('{{item.url}}', loopScope)).toBe('https://example.com')
  })

  it('{{item.status}} converts number to string via interpolation', () => {
    expect(resolveValue('{{item.status}}', loopScope)).toBe('200')
  })

  it('$loop.index returns the zero-based iteration index (typed number)', () => {
    expect(resolveValue('$loop.index', loopScope)).toBe(2)
  })

  it('{{loop.index}} returns the index as a string', () => {
    expect(resolveValue('{{loop.index}}', loopScope)).toBe('2')
  })

  it('custom `as` name resolves correctly via $-ref', () => {
    const customScope: ResolveScope = {
      inputs: {},
      steps: {},
      loopVar: { name: 'endpoint', value: { port: 8080 } },
      loopIndex: 0,
    }
    expect(resolveValue('$endpoint.port', customScope)).toBe(8080)
  })

  it('custom `as` name resolves via {{}} interpolation', () => {
    const customScope: ResolveScope = {
      inputs: {},
      steps: {},
      loopVar: { name: 'endpoint', value: { url: 'http://localhost' } },
      loopIndex: 0,
    }
    expect(resolveValue('{{endpoint.url}}', customScope)).toBe('http://localhost')
  })

  it('loop binding shadows an input of the same name', () => {
    const shadowScope: ResolveScope = {
      inputs: { item: 'from-inputs' },
      steps: {},
      loopVar: { name: 'item', value: { data: 'from-loop' } },
      loopIndex: 0,
    }
    // $item.data should resolve from the loop binding, not inputs
    expect(resolveValue('$item.data', shadowScope)).toBe('from-loop')
  })

  it('outside a forEach (no loopVar) the existing $stepId resolution still works', () => {
    expect(resolveValue('$step1.val', scope)).toBe(42)
  })

  it('outside a forEach inputs still resolve via bare name', () => {
    expect(resolveValue('{{name}}', scope)).toBe('ada')
  })

  // ---------------------------------------------------------------------------
  // Fix #2: $loop.* / {{loop.*}} outside a forEach must NOT silently return 0
  // ---------------------------------------------------------------------------

  it('$loop.index outside a forEach throws Unknown step reference (not silently 0)', () => {
    const noLoopScope: ResolveScope = {
      inputs: { x: 1 },
      steps: { prev: { result: 'ok' } },
      // no loopVar — outside any forEach
    }
    expect(() => resolveValue('$loop.index', noLoopScope)).toThrow(/Unknown step reference/)
  })

  it('{{loop.index}} outside a forEach falls through to bare-input lookup (not silently 0)', () => {
    // With no loopVar set, {{loop.index}} should look up 'loop.index' in inputs —
    // there is no such input, so it throws Unresolved interpolation.
    const noLoopScope: ResolveScope = {
      inputs: { x: 1 },
      steps: {},
    }
    expect(() => resolveValue('{{loop.index}}', noLoopScope)).toThrow(/Unresolved/)
  })

  it('a real step named "loop" is referenceable when there is no forEach active', () => {
    // Without the guard, $loop.index would hijack any step named 'loop'.
    // After the fix, it falls through to normal step lookup.
    const stepLoopScope: ResolveScope = {
      inputs: {},
      steps: { loop: { value: 'from-loop-step', index: 99 } },
      // no loopVar
    }
    expect(resolveValue('$loop.value', stepLoopScope)).toBe('from-loop-step')
    expect(resolveValue('$loop.index', stepLoopScope)).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// $-ref typed roots: $inputs.x, $params.x, $ctx.x, $secrets.x, $steps.x.y
// ---------------------------------------------------------------------------

describe('$-ref typed roots (type-preserving; {{ }} stringifies)', () => {
  const rootScope: ResolveScope = {
    inputs: { n: 9000, flag: false, label: 'hello' },
    params: { retries: 3 },
    ctx: { runId: 'abc123' },
    secrets: { token: 'secret-value' },
    steps: { fetchStep: { count: 7, nested: { deep: true } } },
  }

  it('$inputs.n resolves to a real NUMBER (not string "9000")', () => {
    expect(resolveValue('$inputs.n', rootScope)).toBe(9000)
  })

  it('{{inputs.n}} resolves to the STRING "9000"', () => {
    expect(resolveValue('{{inputs.n}}', rootScope)).toBe('9000')
  })

  it('$inputs.flag preserves boolean false', () => {
    expect(resolveValue('$inputs.flag', rootScope)).toBe(false)
  })

  it('{{inputs.flag}} stringifies boolean to "false"', () => {
    expect(resolveValue('{{inputs.flag}}', rootScope)).toBe('false')
  })

  it('$inputs.label preserves string type', () => {
    expect(resolveValue('$inputs.label', rootScope)).toBe('hello')
  })

  it('$params.retries resolves to a real NUMBER', () => {
    expect(resolveValue('$params.retries', rootScope)).toBe(3)
  })

  it('$ctx.runId resolves to the string value typed', () => {
    expect(resolveValue('$ctx.runId', rootScope)).toBe('abc123')
  })

  it('$secrets.token resolves to the secret string', () => {
    expect(resolveValue('$secrets.token', rootScope)).toBe('secret-value')
  })

  it('$steps.fetchStep.count resolves typed (the explicit-form analog of $fetchStep.count)', () => {
    expect(resolveValue('$steps.fetchStep.count', rootScope)).toBe(7)
  })

  it('$steps.fetchStep.nested.deep resolves nested path', () => {
    expect(resolveValue('$steps.fetchStep.nested.deep', rootScope)).toBe(true)
  })

  it('$undefinedRoot.x throws Unknown step reference (not a real step)', () => {
    expect(() => resolveValue('$undefinedRoot.x', rootScope)).toThrow(/Unknown step reference/)
  })

  it('existing $stepId.field resolution still works (regression guard)', () => {
    expect(resolveValue('$fetchStep.count', rootScope)).toBe(7)
  })

  it('existing {{inputs.x}} string resolution still works (regression guard)', () => {
    expect(resolveValue('{{inputs.n}}', rootScope)).toBe('9000')
  })
})
