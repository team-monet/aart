import { describe, it, expect } from 'vitest'
import { resolveValue, resolveInputs, evalCondition, type ResolveScope } from './resolver'

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
