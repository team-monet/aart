import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { validateDraft } from './validate'
import type { BlockDefinition } from '../core/types'

const node = (id: string): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'node', code: 'return {};' },
})

const wf = (id: string, block: string, version?: string): unknown => ({
  id,
  name: id,
  version: '0.1.0',
  execution: { type: 'workflow', steps: [{ id: 's1', block, version, inputs: {} }] },
})

describe('validateDraft', () => {
  let dir: string
  let registry: FileRegistry
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-val-'))
    registry = new FileRegistry(path.join(dir, 'registry'))
    registry.registerBlock(node('echo'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('accepts a valid node block', () => {
    expect(validateDraft(node('thing'), registry).ok).toBe(true)
  })

  it('accepts a workflow referencing a known block', () => {
    expect(validateDraft(wf('w', 'echo'), registry).ok).toBe(true)
  })

  it('rejects a workflow referencing an unknown block', () => {
    const r = validateDraft(wf('w', 'ghost'), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/unknown block: ghost/)
  })

  it('rejects a self-referencing (non-terminating) workflow', () => {
    const r = validateDraft(wf('loop', 'loop'), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/references itself/)
  })

  it('rejects a step pinned to a nonexistent version of a known block', () => {
    const r = validateDraft(wf('w', 'echo', '9.9.9'), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/unknown block: echo@9\.9\.9/)
  })

  it('rejects structurally invalid input', () => {
    expect(validateDraft({ id: 'x' }, registry).ok).toBe(false)
  })

  // -------------------------------------------------------------------------
  // input default validation
  // -------------------------------------------------------------------------

  it('accepts a field with a valid default (no enum/pattern)', () => {
    const b: unknown = { ...node('with-default'), inputs: [{ name: 'x', type: 'string', default: 'hello' }] }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('emits a WARNING (not error) when a field has both required:true and a default', () => {
    const b: unknown = {
      ...node('req-default'),
      inputs: [{ name: 'x', type: 'string', required: true, default: 'hello' }],
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(true)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings.join()).toMatch(/required.*default|default.*required/)
  })

  it('rejects a default that violates its own enum constraint', () => {
    const b: unknown = {
      ...node('bad-default-enum'),
      inputs: [{ name: 'env', type: 'string', default: 'prod', enum: ['dev', 'staging'] }],
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/default.*prod|prod.*enum/)
  })

  it('rejects a default that violates its own pattern constraint', () => {
    const b: unknown = {
      ...node('bad-default-pattern'),
      inputs: [{ name: 'tag', type: 'string', default: 'bad tag!', pattern: '[a-z-]+' }],
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/default.*pattern|does not match/)
  })

  it('accepts a default that satisfies its own enum constraint', () => {
    const b: unknown = {
      ...node('good-default-enum'),
      inputs: [{ name: 'env', type: 'string', default: 'dev', enum: ['dev', 'staging'] }],
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('accepts a default that satisfies its own pattern constraint', () => {
    const b: unknown = {
      ...node('good-default-pattern'),
      inputs: [{ name: 'tag', type: 'string', default: 'my-tag', pattern: '[a-z-]+' }],
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  // -------------------------------------------------------------------------
  // forEach validation
  // -------------------------------------------------------------------------

  const forEachWf = (overrides: Record<string, unknown>): unknown => ({
    id: 'fe-wf',
    name: 'fe-wf',
    version: '0.1.0',
    execution: {
      type: 'workflow',
      steps: [
        {
          id: 's1',
          block: 'echo',
          forEach: '{{inputs.items}}',
          ...overrides,
          inputs: {},
        },
      ],
    },
  })

  it('accepts a valid forEach step', () => {
    const r = validateDraft(forEachWf({}), registry)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects forEach combined with `if`', () => {
    const r = validateDraft(forEachWf({ if: 'inputs.x === 1', then: 's1' }), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/forEach.*if|if.*forEach/)
  })

  it('rejects forEach combined with `next`', () => {
    const r = validateDraft(forEachWf({ next: 's1' }), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/forEach.*next|next.*forEach/)
  })

  it('rejects forEach combined with `then`', () => {
    const r = validateDraft(forEachWf({ then: 's1' }), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/forEach.*then|then.*forEach/)
  })

  it('rejects forEach combined with `else`', () => {
    const r = validateDraft(forEachWf({ else: 's1' }), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/forEach.*else|else.*forEach/)
  })

  it('rejects an empty-string forEach', () => {
    const b: unknown = {
      id: 'fe-empty',
      name: 'fe-empty',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/forEach.*empty|empty.*forEach/)
  })

  it('emits a warning when `as` is set without `forEach`', () => {
    const b: unknown = {
      id: 'as-no-foreach',
      name: 'as-no-foreach',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', as: 'item', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/"as".*"forEach"|forEach.*as/)
  })

  // -------------------------------------------------------------------------
  // Fix #3: reserved names — 'loop' as step id or as `as` binding
  // -------------------------------------------------------------------------

  it('rejects a step with id "loop" (reserved for $loop.index builtin)', () => {
    const b: unknown = {
      id: 'reserved-loop-id',
      name: 'reserved-loop-id',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 'loop', block: 'echo', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/loop.*reserved|reserved.*loop/)
  })

  it('rejects a step with as: "loop" (collides with $loop builtin)', () => {
    const b: unknown = {
      id: 'reserved-loop-as',
      name: 'reserved-loop-as',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'loop', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/loop.*reserved|reserved.*loop/)
  })

  // Fix #1: all typed $-ref root names must be rejected as `as` binding names.
  // `as: inputs` would make `$inputs.x` resolve to the loop item while
  // `{{inputs.x}}` still resolves to the workflow input — silent divergence.
  it('rejects as: "inputs" (would shadow $inputs typed-ref root)', () => {
    const b: unknown = {
      id: 'reserved-inputs-as',
      name: 'reserved-inputs-as',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'inputs', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/inputs.*reserved|reserved.*inputs/)
  })

  it('rejects as: "params" (would shadow $params typed-ref root)', () => {
    const b: unknown = {
      id: 'reserved-params-as',
      name: 'reserved-params-as',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'params', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/params.*reserved|reserved.*params/)
  })

  it('rejects as: "secrets" (would shadow $secrets typed-ref root)', () => {
    const b: unknown = {
      id: 'reserved-secrets-as',
      name: 'reserved-secrets-as',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'secrets', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/secrets.*reserved|reserved.*secrets/)
  })

  it('accepts as: "item" (the default loop variable — not reserved)', () => {
    const b: unknown = {
      id: 'item-as-ok',
      name: 'item-as-ok',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'item', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.errors.filter((e) => /reserved/.test(e))).toHaveLength(0)
  })

  it('accepts as: "ep" (an arbitrary non-reserved name)', () => {
    const b: unknown = {
      id: 'ep-as-ok',
      name: 'ep-as-ok',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'ep', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.errors.filter((e) => /reserved/.test(e))).toHaveLength(0)
  })

  // Round-3 fix #5: `as` must be a valid resolver identifier — a hyphenated name
  // passes the reserved-name check but {{endpoint-item.url}} never resolves.
  it('rejects as: "endpoint-item" (not a valid resolver identifier)', () => {
    const b: unknown = {
      id: 'bad-as-name',
      name: 'bad-as-name',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 's1', block: 'echo', forEach: '{{inputs.items}}', as: 'endpoint-item', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/valid binding name/)
  })

  it('does NOT reject a step with id "item" (shadowing is documented behavior)', () => {
    const b: unknown = {
      id: 'item-id-ok',
      name: 'item-id-ok',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 'item', block: 'echo', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    // 'item' is not reserved; only 'loop' is.
    expect(r.errors.filter((e) => /reserved/.test(e))).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Fix: reserve typed $-ref root names as step ids
  // -------------------------------------------------------------------------

  it('rejects a step with id "inputs" (collides with $inputs typed-ref root)', () => {
    const b: unknown = {
      id: 'reserved-inputs-id',
      name: 'reserved-inputs-id',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 'inputs', block: 'echo', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/inputs.*reserved|reserved.*inputs/)
  })

  it('rejects a step with id "steps" (collides with $steps typed-ref root)', () => {
    const b: unknown = {
      id: 'reserved-steps-id',
      name: 'reserved-steps-id',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 'steps', block: 'echo', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/steps.*reserved|reserved.*steps/)
  })

  it('rejects a step with id "params" (collides with $params typed-ref root)', () => {
    const b: unknown = {
      id: 'reserved-params-id',
      name: 'reserved-params-id',
      version: '0.1.0',
      execution: {
        type: 'workflow',
        steps: [{ id: 'params', block: 'echo', inputs: {} }],
      },
    }
    const r = validateDraft(b, registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/params.*reserved|reserved.*params/)
  })
})
