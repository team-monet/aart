import type { BlockDefinition } from '../../core/types'

/**
 * Built-in health-check workflow: probe a list of endpoints with `http.check`
 * (forEach) then aggregate results with `report.summarize`.
 *
 * Pre-approved at load time (shipped in corePack.workflows). No --yes required.
 */
export const httpHealthCheck: BlockDefinition = {
  id: 'http.health-check',
  name: 'HTTP Health Check',
  version: '0.1.0',
  description:
    'Probe each endpoint in `endpoints` (each an object with a `url`) using http.check ' +
    '(GET, expecting HTTP 200) and return a pass/fail summary plus a health-summary.md ' +
    'artifact. v1 forwards only the endpoint url and the workflow-level timeoutMs; ' +
    'per-endpoint method/expectStatus/headers overrides are not supported yet.',
  inputs: [
    {
      name: 'endpoints',
      type: 'array',
      required: true,
      description: 'Array of { url } objects to probe (each checked with GET, expecting HTTP 200).',
    },
    { name: 'timeoutMs', type: 'number', default: 5000 },
  ],
  outputs: [
    { name: 'ok', type: 'boolean' },
    { name: 'total', type: 'number' },
    { name: 'passed', type: 'number' },
    { name: 'failed', type: 'number' },
    { name: 'report', type: 'string' },
  ],
  execution: {
    type: 'workflow',
    steps: [
      {
        id: 'probe',
        block: 'http.check',
        forEach: '{{inputs.endpoints}}',
        as: 'ep',
        inputs: {
          url: '{{ep.url}}',
          timeoutMs: '$inputs.timeoutMs',
        },
      },
      {
        id: 'summary',
        block: 'report.summarize',
        inputs: {
          results: '$probe.items',
          title: 'Health Check',
        },
      },
    ],
    outputMapping: {
      ok: '$summary.ok',
      total: '$summary.total',
      passed: '$summary.passed',
      failed: '$summary.failed',
      report: '$summary.summary',
    },
  },
}
