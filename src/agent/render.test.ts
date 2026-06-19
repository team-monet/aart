import { describe, it, expect } from 'vitest'
import { renderDefinition } from './render'
import type { BlockDefinition } from '../core/types'

// Fix #1: renderDefinition must show default values and forEach/as in the approval surface.

describe('renderDefinition', () => {
  it('shows a default value for an input in the constraint field', () => {
    const b: BlockDefinition = {
      id: 'deploy',
      name: 'Deploy',
      version: '0.1.0',
      inputs: [
        { name: 'namespace', type: 'string', default: 'staging' },
        { name: 'replicas', type: 'number', default: 2 },
        { name: 'env', type: 'string', required: true, enum: ['dev', 'staging'], default: 'dev' },
      ],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
    }
    const rendered = renderDefinition(b)
    // Default should appear for each defaulted field
    expect(rendered).toContain('= "staging"')
    expect(rendered).toContain('= 2')
    // enum constraint + default both appear
    expect(rendered).toContain('dev, staging')
    expect(rendered).toContain('= "dev"')
  })

  it('does not show a default clause when no default is declared', () => {
    const b: BlockDefinition = {
      id: 'simple',
      name: 'Simple',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string', required: true }],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
    }
    const rendered = renderDefinition(b)
    expect(rendered).not.toMatch(/= /)
  })

  it('shows forEach and as on a workflow step', () => {
    const b: BlockDefinition = {
      id: 'fan-out-wf',
      name: 'Fan Out',
      version: '0.1.0',
      inputs: [{ name: 'endpoints', type: 'array', required: true }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'probe',
            block: 'http.request',
            forEach: '{{inputs.endpoints}}',
            as: 'endpoint',
            inputs: { url: '{{endpoint.url}}' },
          },
        ],
      },
    }
    const rendered = renderDefinition(b)
    expect(rendered).toContain('forEach {{inputs.endpoints}} as endpoint')
  })

  it('shows forEach with default "item" binding when as is not set', () => {
    const b: BlockDefinition = {
      id: 'implicit-item-wf',
      name: 'Implicit Item',
      version: '0.1.0',
      inputs: [{ name: 'tags', type: 'array' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'each',
            block: 'echo',
            forEach: '{{inputs.tags}}',
            inputs: { value: '{{item}}' },
          },
        ],
      },
    }
    const rendered = renderDefinition(b)
    expect(rendered).toContain('forEach {{inputs.tags}} as item')
  })

  it('a non-forEach step does not show a forEach clause', () => {
    const b: BlockDefinition = {
      id: 'plain-wf',
      name: 'Plain',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'step1', block: 'echo', inputs: { value: 'hello' } },
        ],
      },
    }
    const rendered = renderDefinition(b)
    expect(rendered).not.toContain('forEach')
  })
})
