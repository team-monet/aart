import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Engine } from './engine'
import { createContext } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { runDir } from './report'
import { FileRegistry } from '../registry/file-registry'
import type { BlockDefinition } from './types'

const echo: BlockDefinition = {
  id: 'echo',
  name: 'Echo',
  version: '0.1.0',
  inputs: [{ name: 'value', type: 'string' }],
  outputs: [{ name: 'value', type: 'string' }],
  execution: { type: 'node', code: 'return { value: inputs.value };' },
}

const upper: BlockDefinition = {
  id: 'upper',
  name: 'Uppercase',
  version: '0.1.0',
  inputs: [{ name: 'value', type: 'string' }],
  outputs: [{ name: 'value', type: 'string' }],
  execution: { type: 'node', code: 'return { value: String(inputs.value).toUpperCase() };' },
}

const workflow: BlockDefinition = {
  id: 'echo-smoke',
  name: 'Echo Smoke',
  version: '0.1.0',
  inputs: [{ name: 'start', type: 'string' }],
  outputs: [],
  execution: {
    type: 'workflow',
    steps: [
      { id: 'echo_it', block: 'echo', inputs: { value: '{{inputs.start}}' } },
      { id: 'shout', block: 'upper', inputs: { value: '$echo_it.value' } },
    ],
    outputMapping: { final: '$shout.value' },
  },
}

describe('Engine', () => {
  let dir: string
  let registry: FileRegistry

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-engine-'))
    registry = new FileRegistry(path.join(dir, 'registry'))
    registry.registerBlock(echo)
    registry.registerBlock(upper)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (wf: BlockDefinition, inputs: Record<string, unknown>) => {
    const runId = 'test-run'
    const ctx = createContext({
      runId,
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, runId)),
    })
    return new Engine(registry).run(wf, inputs, ctx)
  }

  it('runs a two-step workflow end to end', async () => {
    const rec = await run(workflow, { start: 'hello' })
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ final: 'HELLO' })
    expect(rec.trace.map((t) => [t.stepId, t.status])).toEqual([
      ['echo_it', 'COMPLETED'],
      ['shout', 'COMPLETED'],
    ])
  })

  it('snapshots every referenced block for reproducibility', async () => {
    const rec = await run(workflow, { start: 'x' })
    expect(Object.keys(rec.snapshot.blocks).sort()).toEqual(['echo', 'upper'])
  })

  it('resolves {{ctx.runId}} in step inputs and outputMapping', async () => {
    const wf: BlockDefinition = {
      ...workflow,
      id: 'ctx-wf',
      execution: {
        type: 'workflow',
        steps: [{ id: 'e', block: 'echo', inputs: { value: '{{ctx.runId}}' } }],
        outputMapping: { rid: '{{ctx.runId}}' },
      },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ rid: 'test-run' })
    expect(rec.trace[0]!.outputs).toEqual({ value: 'test-run' })
  })

  it('fails fast when a required input is missing', async () => {
    const needsInput: BlockDefinition = {
      id: 'needs-input',
      name: 'Needs Input',
      version: '0.1.0',
      inputs: [{ name: 'value', type: 'string', required: true }],
      outputs: [],
      execution: { type: 'node', code: 'return { value: inputs.value };' },
    }
    registry.registerBlock(needsInput)
    const wf: BlockDefinition = {
      ...workflow,
      id: 'missing-input-wf',
      execution: { type: 'workflow', steps: [{ id: 's', block: 'needs-input', inputs: {} }] },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('FAILED')
    expect(rec.error).toMatch(/Missing required input "value"/)
  })

  it('marks the run FAILED and records the failing step on error', async () => {
    const boom: BlockDefinition = {
      ...upper,
      id: 'boom',
      execution: { type: 'node', code: 'throw new Error("kaboom");' },
    }
    registry.registerBlock(boom)
    const wf: BlockDefinition = {
      ...workflow,
      id: 'fail-wf',
      execution: {
        type: 'workflow',
        steps: [{ id: 'bang', block: 'boom', inputs: {} }],
      },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('FAILED')
    expect(rec.error).toMatch(/kaboom/)
    expect(rec.trace[0]!.status).toBe('FAILED')
  })

  // -------------------------------------------------------------------------
  // input default values
  // -------------------------------------------------------------------------

  it('fills in a declared default when the caller omits the input (native block)', async () => {
    const withDefault: BlockDefinition = {
      id: 'with-default',
      name: 'With Default',
      version: '0.1.0',
      inputs: [
        { name: 'value', type: 'string', default: 'fallback' },
      ],
      outputs: [{ name: 'value', type: 'string' }],
      execution: { type: 'native' },
    }
    const nativeHandlers = new Map([
      ['with-default', async (_ctx: unknown, inputs: Record<string, unknown>) => ({ value: inputs['value'] })],
    ])
    const ctx = createContext({
      runId: 'test-default-native',
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, 'test-default-native')),
    })
    const engine = new Engine(registry, { nativeHandlers: nativeHandlers as Map<string, import('../pack/types').NativeRunFn> })
    // omit input — default fills in
    const rec = await engine.run(withDefault, {}, ctx)
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ value: 'fallback' })
    // Round-3 fix #6: the run record's inputs reflect the effective (defaulted)
    // inputs for a direct run, not the caller's raw {} — preserving the audit trail.
    expect(rec.inputs).toEqual({ value: 'fallback' })
  })

  // Round-4 fix #1: branch (if) evaluation must see workflow params, not just
  // step-input resolution.
  it('passes workflow params into branch (if) evaluation', async () => {
    const wf: BlockDefinition = {
      id: 'param-branch',
      name: 'param-branch',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'gate', block: 'echo', inputs: { value: 'g' }, if: '$params.go === true', then: 'yes', else: 'no' },
          { id: 'no', block: 'echo', inputs: { value: 'took-no' } },
          { id: 'yes', block: 'echo', inputs: { value: 'took-yes' } },
        ],
      },
    }
    const ctx = createContext({
      runId: 'param-branch',
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, 'param-branch')),
    })
    const rec = await new Engine(registry).run(wf, {}, ctx, { go: true })
    expect(rec.status).toBe('COMPLETED')
    const visited = rec.trace.map((t) => t.stepId)
    expect(visited).toContain('yes') // params.go === true → 'then' branch
    expect(visited).not.toContain('no')
  })

  // Round-4 fix #4: a handler that mutates a defaulted object input in place must
  // not corrupt the persisted run record (the recorded inputs are snapshotted).
  it('a handler mutating a defaulted object input does not corrupt the run record', async () => {
    const withObjDefault: BlockDefinition = {
      id: 'obj-default-mut',
      name: 'obj-default-mut',
      version: '0.1.0',
      inputs: [{ name: 'config', type: 'object', default: { n: 1 } }],
      outputs: [],
      execution: { type: 'native' },
    }
    const nativeHandlers = new Map([
      ['obj-default-mut', async (_ctx: unknown, inputs: Record<string, unknown>) => {
        ;(inputs.config as Record<string, unknown>).n = 999 // handler mutates in place
        return {}
      }],
    ])
    const ctx = createContext({
      runId: 'obj-mut',
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, 'obj-mut')),
    })
    const engine = new Engine(registry, { nativeHandlers: nativeHandlers as Map<string, import('../pack/types').NativeRunFn> })
    const rec = await engine.run(withObjDefault, {}, ctx)
    expect(rec.status).toBe('COMPLETED')
    // Persisted inputs reflect the default (n:1), NOT the handler's mutation (999).
    expect(rec.inputs).toEqual({ config: { n: 1 } })
  })

  it('caller-provided value overrides a declared default', async () => {
    const withDefault: BlockDefinition = {
      id: 'with-default2',
      name: 'With Default 2',
      version: '0.1.0',
      inputs: [
        { name: 'value', type: 'string', default: 'fallback' },
      ],
      outputs: [{ name: 'value', type: 'string' }],
      execution: { type: 'native' },
    }
    const nativeHandlers = new Map([
      ['with-default2', async (_ctx: unknown, inputs: Record<string, unknown>) => ({ value: inputs['value'] })],
    ])
    const ctx = createContext({
      runId: 'test-override',
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, 'test-override')),
    })
    const engine = new Engine(registry, { nativeHandlers: nativeHandlers as Map<string, import('../pack/types').NativeRunFn> })
    const rec = await engine.run(withDefault, { value: 'provided' }, ctx)
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ value: 'provided' })
  })

  it('explicit falsy values (0, false, empty string) are NOT overridden by a default', async () => {
    const withDefault: BlockDefinition = {
      id: 'with-default-falsy',
      name: 'With Default Falsy',
      version: '0.1.0',
      inputs: [
        { name: 'count', type: 'number', default: 99 },
        { name: 'flag', type: 'boolean', default: true },
        { name: 'label', type: 'string', default: 'default-label' },
      ],
      outputs: [{ name: 'count', type: 'number' }, { name: 'flag', type: 'boolean' }, { name: 'label', type: 'string' }],
      execution: { type: 'native' },
    }
    const nativeHandlers = new Map([
      ['with-default-falsy', async (_ctx: unknown, inputs: Record<string, unknown>) => ({
        count: inputs['count'],
        flag: inputs['flag'],
        label: inputs['label'],
      })],
    ])
    const ctx = createContext({
      runId: 'test-falsy',
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, 'test-falsy')),
    })
    const engine = new Engine(registry, { nativeHandlers: nativeHandlers as Map<string, import('../pack/types').NativeRunFn> })
    const rec = await engine.run(withDefault, { count: 0, flag: false, label: '' }, ctx)
    expect(rec.status).toBe('COMPLETED')
    // Each explicit falsy value must NOT be replaced by the default
    expect(rec.results).toEqual({ count: 0, flag: false, label: '' })
  })

  it('workflow step can omit an input that the child block defaults (scope site)', async () => {
    // Child block declares a default on 'value'
    const childWithDefault: BlockDefinition = {
      id: 'child-with-default',
      name: 'Child With Default',
      version: '0.1.0',
      inputs: [{ name: 'value', type: 'string', default: 'child-default' }],
      outputs: [{ name: 'value', type: 'string' }],
      execution: { type: 'node', code: 'return { value: inputs.value };' },
    }
    registry.registerBlock(childWithDefault)

    // Workflow step passes no 'value' — child default should fill in
    const wf: BlockDefinition = {
      id: 'wf-step-default',
      name: 'WF Step Default',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 's', block: 'child-with-default', inputs: {} },
        ],
        outputMapping: { value: '$s.value' },
      },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ value: 'child-default' })
    // Round-2 fix: the step trace records the EFFECTIVE inputs (incl. the child's
    // default), not the pre-default step inputs ({}) — so run evidence matches
    // what the block actually ran with.
    expect(rec.trace[0]!.inputs).toEqual({ value: 'child-default' })
  })

  it('workflow {{inputs.x}} resolves to default when workflow-level input has a default', async () => {
    // A workflow input with a default, wired to a child step via {{inputs.x}}
    const childBlock: BlockDefinition = {
      id: 'child-plain',
      name: 'Child Plain',
      version: '0.1.0',
      inputs: [{ name: 'value', type: 'string' }],
      outputs: [{ name: 'value', type: 'string' }],
      execution: { type: 'node', code: 'return { value: inputs.value };' },
    }
    registry.registerBlock(childBlock)

    const wf: BlockDefinition = {
      id: 'wf-input-default',
      name: 'WF Input Default',
      version: '0.1.0',
      inputs: [{ name: 'label', type: 'string', default: 'wf-default' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 's', block: 'child-plain', inputs: { value: '{{inputs.label}}' } },
        ],
        outputMapping: { value: '$s.value' },
      },
    }
    // Caller omits 'label' — the workflow-level default fills in, reaches child via scope
    const rec = await run(wf, {})
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ value: 'wf-default' })
  })

  it('enum constraint still rejects an out-of-range value even when a default exists', async () => {
    const constrained: BlockDefinition = {
      id: 'constrained',
      name: 'Constrained',
      version: '0.1.0',
      inputs: [{ name: 'env', type: 'string', default: 'dev', enum: ['dev', 'staging'] }],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
    }
    const rec = await run(constrained, { env: 'prod' })
    expect(rec.status).toBe('FAILED')
    expect(rec.error).toMatch(/must be one of/)
  })

  // -------------------------------------------------------------------------
  // forEach iteration
  // -------------------------------------------------------------------------

  // A helper block that echoes its inputs back so we can observe what arrived.
  const identity: BlockDefinition = {
    id: 'identity',
    name: 'Identity',
    version: '0.1.0',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'value', type: 'any' },
    ],
    outputs: [{ name: 'label', type: 'string' }, { name: 'value', type: 'any' }],
    execution: { type: 'node', code: 'return { label: inputs.label, value: inputs.value };' },
  }

  describe('forEach', () => {
    beforeEach(() => {
      registry.registerBlock(identity)
    })

    it('runs the child block once per element; stepOutputs has items array in order', async () => {
      const wf: BlockDefinition = {
        id: 'foreach-basic',
        name: 'ForEach Basic',
        version: '0.1.0',
        inputs: [{ name: 'tags', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'identity',
              forEach: '{{inputs.tags}}',
              inputs: { label: '{{item}}', value: '{{item}}' },
            },
          ],
          outputMapping: { results: '$each.items' },
        },
      }
      const rec = await run(wf, { tags: ['a', 'b', 'c'] })
      expect(rec.status).toBe('COMPLETED')
      const items = (rec.results!['results'] as Array<{ label: string }>)
      expect(items).toHaveLength(3)
      expect(items.map((x) => x.label)).toEqual(['a', 'b', 'c'])
    })

    it('produces one trace entry per iteration with the correct iteration field', async () => {
      const wf: BlockDefinition = {
        id: 'foreach-trace',
        name: 'ForEach Trace',
        version: '0.1.0',
        inputs: [{ name: 'items', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'loop',
              block: 'echo',
              forEach: '{{inputs.items}}',
              inputs: { value: '{{item}}' },
            },
          ],
        },
      }
      const rec = await run(wf, { items: ['x', 'y'] })
      expect(rec.status).toBe('COMPLETED')
      expect(rec.trace).toHaveLength(2)
      expect(rec.trace[0]!.iteration).toBe(0)
      expect(rec.trace[1]!.iteration).toBe(1)
      expect(rec.trace.every((t) => t.stepId === 'loop')).toBe(true)
    })

    it('type fidelity: $item.field reaches the child as a real number, not a string', async () => {
      // This is the key distinction between $item.field (typed) and {{item.field}} (string).
      const wf: BlockDefinition = {
        id: 'foreach-typed',
        name: 'ForEach Typed',
        version: '0.1.0',
        inputs: [{ name: 'records', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'identity',
              forEach: '$records',
              as: 'rec',
              inputs: {
                label: '{{rec.name}}',   // interpolation → string
                value: '$rec.count',     // $-ref → typed (number)
              },
            },
          ],
          outputMapping: { results: '$each.items' },
        },
      }
      // forEach also resolves correctly via $-ref to a workflow input step output —
      // but here we test the normal inputs path by wiring directly.
      // We need $records to work as a forEach expression. Since it's a $-ref it
      // resolves against steps first; inputs are the fallback for {{}} only.
      // For this test use the {{inputs.records}} form to keep it simple.
      const wf2: BlockDefinition = {
        ...wf,
        id: 'foreach-typed-2',
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'identity',
              forEach: '{{inputs.records}}',
              as: 'rec',
              inputs: {
                label: '{{rec.name}}',
                value: '$rec.count',
              },
            },
          ],
          outputMapping: { results: '$each.items' },
        },
      }
      const rec = await run(wf2, {
        records: [
          { name: 'alpha', count: 42 },
          { name: 'beta', count: 7 },
        ],
      })
      expect(rec.status).toBe('COMPLETED')
      const results = rec.results!['results'] as Array<{ label: string; value: unknown }>
      // label came through {{}} interpolation → always string
      expect(results[0]!.label).toBe('alpha')
      expect(results[1]!.label).toBe('beta')
      // value came through $-ref → must preserve number type
      expect(results[0]!.value).toBe(42)
      expect(results[1]!.value).toBe(7)
      expect(typeof results[0]!.value).toBe('number')
    })

    it('custom `as` renames the binding so {{endpoint.url}} resolves', async () => {
      const wf: BlockDefinition = {
        id: 'foreach-as',
        name: 'ForEach As',
        version: '0.1.0',
        inputs: [{ name: 'endpoints', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'echo',
              forEach: '{{inputs.endpoints}}',
              as: 'endpoint',
              inputs: { value: '{{endpoint.url}}' },
            },
          ],
          outputMapping: { results: '$each.items' },
        },
      }
      const rec = await run(wf, {
        endpoints: [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      })
      expect(rec.status).toBe('COMPLETED')
      const items = (rec.results!['results'] as Array<{ value: string }>)
      expect(items.map((x) => x.value)).toEqual(['https://a.com', 'https://b.com'])
    })

    it('{{loop.index}} reflects the zero-based iteration index as a string', async () => {
      const wf: BlockDefinition = {
        id: 'foreach-index',
        name: 'ForEach Index',
        version: '0.1.0',
        inputs: [{ name: 'items', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'echo',
              forEach: '{{inputs.items}}',
              inputs: { value: '{{loop.index}}' },
            },
          ],
          outputMapping: { results: '$each.items' },
        },
      }
      const rec = await run(wf, { items: ['x', 'y', 'z'] })
      expect(rec.status).toBe('COMPLETED')
      const items = (rec.results!['results'] as Array<{ value: string }>)
      expect(items.map((x) => x.value)).toEqual(['0', '1', '2'])
    })

    it('a downstream step consumes $<forEachStepId>.items as a typed array', async () => {
      // Demonstrates the full pipeline: forEach step → downstream consumer.
      const consumer: BlockDefinition = {
        id: 'consumer',
        name: 'Consumer',
        version: '0.1.0',
        inputs: [{ name: 'all', type: 'any' }],
        outputs: [{ name: 'count', type: 'number' }, { name: 'all', type: 'any' }],
        execution: {
          type: 'node',
          code: 'return { count: inputs.all.length, all: inputs.all };',
        },
      }
      registry.registerBlock(consumer)

      const wf: BlockDefinition = {
        id: 'foreach-downstream',
        name: 'ForEach Downstream',
        version: '0.1.0',
        inputs: [{ name: 'vals', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'echo',
              forEach: '{{inputs.vals}}',
              inputs: { value: '{{item}}' },
            },
            {
              id: 'collect',
              block: 'consumer',
              inputs: { all: '$each.items' },
            },
          ],
          outputMapping: { count: '$collect.count', all: '$collect.all' },
        },
      }
      const rec = await run(wf, { vals: ['p', 'q', 'r'] })
      expect(rec.status).toBe('COMPLETED')
      expect(rec.results!['count']).toBe(3)
      const all = rec.results!['all'] as Array<{ value: string }>
      expect(all.map((x) => x.value)).toEqual(['p', 'q', 'r'])
    })

    it('forEach over a non-array value throws a clear runtime error', async () => {
      const wf: BlockDefinition = {
        id: 'foreach-nonarray',
        name: 'ForEach NonArray',
        version: '0.1.0',
        inputs: [{ name: 'notAnArray', type: 'string' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'echo',
              forEach: '{{inputs.notAnArray}}',
              inputs: { value: '{{item}}' },
            },
          ],
        },
      }
      const rec = await run(wf, { notAnArray: 'hello' })
      expect(rec.status).toBe('FAILED')
      expect(rec.error).toMatch(/forEach.*must resolve to an array/)
      expect(rec.error).toMatch(/each/)
    })

    it('forEach with a failing iteration fails the whole step', async () => {
      const boom: BlockDefinition = {
        id: 'boom2',
        name: 'Boom2',
        version: '0.1.0',
        inputs: [{ name: 'value', type: 'string' }],
        outputs: [],
        execution: { type: 'node', code: 'if (inputs.value === "bad") throw new Error("boom on bad"); return {};' },
      }
      registry.registerBlock(boom)

      const wf: BlockDefinition = {
        id: 'foreach-fail',
        name: 'ForEach Fail',
        version: '0.1.0',
        inputs: [{ name: 'items', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'boom2',
              forEach: '{{inputs.items}}',
              inputs: { value: '{{item}}' },
            },
          ],
        },
      }
      const rec = await run(wf, { items: ['ok', 'bad', 'ok'] })
      expect(rec.status).toBe('FAILED')
      expect(rec.error).toMatch(/boom on bad/)
      // first iteration (index 0) completed, second (index 1) failed
      expect(rec.trace[0]!.status).toBe('COMPLETED')
      expect(rec.trace[1]!.status).toBe('FAILED')
    })

    // Regression: branching workflow exits from a non-last-declared step; default
    // output must be the last-EXECUTED step, not the last-DECLARED step.
    it('default output is the last EXECUTED step, not the last DECLARED step (branching/polling)', async () => {
      // Two distinguishable steps: probe (first declared) and sentinel (last declared).
      // sentinel's next loops back to probe, so the workflow EXITS from probe — the
      // FIRST declared step — after one pass. With no outputMapping, results must
      // equal probe's outputs ({ tag: 'probe' }), NOT sentinel's ({ tag: 'sentinel' }).
      const probe: BlockDefinition = {
        id: 'probe-block',
        name: 'Probe',
        version: '0.1.0',
        inputs: [],
        outputs: [{ name: 'tag', type: 'string' }],
        execution: { type: 'node', code: 'return { tag: "probe" };' },
      }
      const sentinel: BlockDefinition = {
        id: 'sentinel-block',
        name: 'Sentinel',
        version: '0.1.0',
        inputs: [],
        outputs: [{ name: 'tag', type: 'string' }],
        execution: { type: 'node', code: 'return { tag: "sentinel" };' },
      }
      registry.registerBlock(probe)
      registry.registerBlock(sentinel)

      // Workflow steps (declared order): probe → sentinel.
      // sentinel uses `if` to exit from probe (via then: null / else: probe loop).
      // We exit immediately (condition is always true), so the final executed step
      // is probe (sentinel ran, then the if caused exit by returning null for then).
      // Actually simpler: sentinel.next = 'probe' creates infinite loop — instead,
      // use if/then on sentinel: condition true → exit (then: null), exit path runs
      // probe last. Re-think: the "last executed" is the step whose outputs the
      // workflow should return.
      //
      // Pattern: steps = [probe, sentinel] where sentinel's `if` is always-true
      // and `then` exits (no next step id → null → loop ends). probe runs FIRST,
      // sentinel runs SECOND and the `if` exit means the loop ends after sentinel.
      // That makes sentinel the last executed — same as declared order. Not useful.
      //
      // The regression to test: steps declared as [probe, sentinel] but workflow
      // EXITS from probe, not sentinel. Achieve this by having probe use `if` with
      // an always-true condition whose `then` exits (then: null), and `else` going
      // to sentinel. Probe runs first, condition true → exit immediately. Sentinel
      // never runs. Last executed = probe. Last declared = sentinel.
      const wf: BlockDefinition = {
        id: 'branching-exit-wf',
        name: 'Branching Exit',
        version: '0.1.0',
        inputs: [],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'probe',
              block: 'probe-block',
              inputs: {},
              // Always-true condition: exit immediately (then: undefined → null → loop ends)
              if: '1 === 1',
              // then: undefined → nextStep returns null, workflow exits from probe
              else: 'sentinel',
            },
            {
              id: 'sentinel',
              block: 'sentinel-block',
              inputs: {},
            },
          ],
          // No outputMapping — triggers the default-last-executed path
        },
      }
      const rec = await run(wf, {})
      expect(rec.status).toBe('COMPLETED')
      // Only probe executed (sentinel was skipped by the if/then exit)
      expect(rec.trace.map((t) => t.stepId)).toEqual(['probe'])
      // Default output must be probe's outputs, NOT sentinel's
      expect(rec.results).toEqual({ tag: 'probe' })
    })

    // Fix #8: empty-array forEach as the final step with no outputMapping
    it('empty-array forEach as the final step with no outputMapping returns { items: [] }', async () => {
      const wf: BlockDefinition = {
        id: 'foreach-empty-final',
        name: 'ForEach Empty Final',
        version: '0.1.0',
        inputs: [{ name: 'items', type: 'array' }],
        outputs: [],
        execution: {
          type: 'workflow',
          steps: [
            {
              id: 'each',
              block: 'echo',
              forEach: '{{inputs.items}}',
              inputs: { value: '{{item}}' },
            },
          ],
          // No outputMapping — the default-last-step path kicks in
        },
      }
      const rec = await run(wf, { items: [] })
      expect(rec.status).toBe('COMPLETED')
      expect(rec.trace).toHaveLength(0)
      // Must return { items: [] } not {}
      expect(rec.results).toEqual({ items: [] })
    })
  })

  // -------------------------------------------------------------------------
  // Fix #5: defensive clone of object/array defaults
  // -------------------------------------------------------------------------

  it('a native handler that mutates an object input does not corrupt the registered default', async () => {
    const withObjDefault: BlockDefinition = {
      id: 'obj-default',
      name: 'Obj Default',
      version: '0.1.0',
      inputs: [{ name: 'config', type: 'object', default: { env: 'staging', retries: 3 } }],
      outputs: [{ name: 'env', type: 'string' }],
      execution: { type: 'native' },
    }
    registry.registerBlock(withObjDefault)

    // Capture what the handler received for each run so we can inspect field.default
    const receivedConfigs: Array<Record<string, unknown>> = []
    const nativeHandlers = new Map([
      [
        'obj-default',
        async (_ctx: unknown, inputs: Record<string, unknown>) => {
          // Record a snapshot of what arrived BEFORE mutation, then mutate.
          const cfg = inputs['config'] as Record<string, unknown>
          receivedConfigs.push({ ...cfg })
          cfg['env'] = 'MUTATED'
          cfg['retries'] = 999
          return { env: cfg['env'] as string }
        },
      ],
    ])

    const makeCtx = (id: string) =>
      createContext({
        runId: id,
        workspace: dir,
        artifacts: new ArtifactStore(runDir(dir, id)),
      })
    const engine = new Engine(registry, { nativeHandlers: nativeHandlers as Map<string, import('../pack/types').NativeRunFn> })

    // Run 1 — handler mutates its inputs
    const rec1 = await engine.run(withObjDefault, {}, makeCtx('clone-run-1'))
    expect(rec1.status).toBe('COMPLETED')
    // Run 1 received the original default and mutates — normal
    expect(receivedConfigs[0]).toEqual({ env: 'staging', retries: 3 })

    // Run 2 — must receive a FRESH clone of the original default, not the mutated one.
    // If the clone is missing, field.default would have been mutated in run 1
    // and run 2 would receive { env: 'MUTATED', retries: 999 }.
    const rec2 = await engine.run(withObjDefault, {}, makeCtx('clone-run-2'))
    expect(rec2.status).toBe('COMPLETED')
    expect(receivedConfigs[1]).toEqual({ env: 'staging', retries: 3 })
    expect(receivedConfigs).toHaveLength(2)
  })
})
