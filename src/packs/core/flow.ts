import { nativeBlock } from '../../pack/types'

/**
 * Flow primitives that make a workflow's `if`/`next` control flow practical:
 * sleep enables poll-until loops (jump back with `next`), fail makes a branch's
 * failure explicit instead of forcing an awkward assert.
 */

const MAX_SLEEP_MS = 120_000

export const flowSleep = nativeBlock(
  {
    id: 'flow.sleep',
    name: 'Sleep',
    version: '0.1.0',
    description:
      `Wait \`ms\` milliseconds (max ${MAX_SLEEP_MS} per step), then continue. ` +
      'For polling: sleep → re-check → `if`/`next` back to the check step.',
    inputs: [{ name: 'ms', type: 'number', required: true }],
    outputs: [{ name: 'sleptMs', type: 'number' }],
  },
  async (_ctx, inputs) => {
    const ms = Number(inputs.ms)
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid ms: ${String(inputs.ms)}`)
    if (ms > MAX_SLEEP_MS) {
      throw new Error(`ms ${ms} exceeds the ${MAX_SLEEP_MS}ms cap — sleep in a loop instead`)
    }
    await new Promise((r) => setTimeout(r, ms))
    return { sleptMs: ms }
  },
)

export const flowFail = nativeBlock(
  {
    id: 'flow.fail',
    name: 'Fail',
    version: '0.1.0',
    description:
      'Fail the run with a message. Use as the target of an `else` branch so a ' +
      'bad state stops the workflow with a clear, intended error.',
    inputs: [{ name: 'message', type: 'string', required: true }],
    outputs: [],
  },
  async (_ctx, inputs) => {
    throw new Error(String(inputs.message))
  },
)
