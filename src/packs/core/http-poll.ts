import type { BlockDefinition } from '../../core/types'

/**
 * http.poll — poll a URL until it returns the expected status code.
 *
 * Control flow:
 *   probe → http.check (non-throwing)
 *     if probe.ok is truthy → workflow ends (then resolves to null → exit)
 *     else → wait
 *   wait → flow.sleep(delayMs) → next: probe  (loop back)
 *
 * The loop is bounded by the engine's STEP_LIMIT (10 000 steps) as the
 * ultimate guard. A configurable max-retries count would need a loop-counter
 * construct; that is a future enhancement noted here intentionally.
 *
 * With outputMapping, outputs come from the last probe step on the successful
 * if-branch exit.  Reaching the engine's STEP_LIMIT is a FAILURE path: the
 * engine throws 'Step limit exceeded' and the run ends with status FAILED and
 * no mapped outputs.
 *
 * Pre-approved at load time (shipped in corePack.workflows). No --yes required.
 */
export const httpPoll: BlockDefinition = {
  id: 'http.poll',
  name: 'HTTP Poll',
  version: '0.1.0',
  description:
    'Poll a URL until it returns the expected HTTP status (default 200). ' +
    'Probes with http.check, sleeps delayMs between attempts, and stops on the first healthy response. ' +
    'Outputs (ok, status, latencyMs, body) are returned only on the successful exit — ' +
    'if the engine STEP_LIMIT (10 000 steps) is reached the run ends FAILED with no outputs. ' +
    'A configurable max-retries count needs a loop-counter construct — noted as a future enhancement.',
  category: 'http',
  keywords: ['poll', 'wait', 'health', 'retry', 'probe', 'ready', 'ping', 'uptime', 'loop'],
  examples: [
    {
      description: 'Wait for a service to become healthy after deploy',
      inputs: { url: 'http://localhost:8080/health', expectStatus: 200, timeoutMs: 5000, delayMs: 2000 },
    },
  ],
  inputs: [
    { name: 'url', type: 'string', required: true },
    { name: 'expectStatus', type: 'number', default: 200 },
    {
      name: 'timeoutMs',
      type: 'number',
      default: 5000,
      description:
        'Per-attempt timeout (ms) for each individual HTTP probe. ' +
        'This does NOT bound the total poll duration — the poll repeats until a ' +
        'healthy response is received, capped only by the engine step limit ' +
        '(~10 000 probes). A bounded max-attempts is a future enhancement.',
    },
    { name: 'delayMs', type: 'number', default: 2000 },
  ],
  outputs: [
    { name: 'ok', type: 'boolean' },
    { name: 'status', type: 'number' },
    { name: 'latencyMs', type: 'number' },
    { name: 'body', type: 'string' },
  ],
  execution: {
    type: 'workflow',
    steps: [
      {
        id: 'probe',
        block: 'http.check',
        inputs: {
          url: '{{inputs.url}}',
          expectStatus: '$inputs.expectStatus',
          timeoutMs: '$inputs.timeoutMs',
        },
        // if probe.ok is true → end (then absent = null = workflow exit)
        // else → wait
        if: '$probe.ok',
        else: 'wait',
      },
      {
        id: 'wait',
        block: 'flow.sleep',
        inputs: { ms: '$inputs.delayMs' },
        next: 'probe',
      },
    ],
    outputMapping: {
      ok: '$probe.ok',
      status: '$probe.status',
      latencyMs: '$probe.latencyMs',
      body: '$probe.body',
    },
  },
}
