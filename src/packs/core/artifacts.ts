import { nativeBlock } from '../../pack/types'

/**
 * Run-output primitives. An artifact lives under `.aa/runs/<runId>/artifacts/`
 * and is listed in the run report — the natural home for anything a workflow
 * PRODUCES (a report, an extract, a downloaded file), as opposed to workspace
 * files it maintains.
 */

export const artifactWrite = nativeBlock(
  {
    id: 'artifact.write',
    name: 'Write Artifact',
    version: '0.1.0',
    description:
      'Save text as a named run artifact (e.g. a generated report.md or data.csv) ' +
      'and return its path. Artifact contents are NOT secret-redacted.',
    inputs: [
      { name: 'name', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ],
    outputs: [{ name: 'artifact', type: 'string' }],
  },
  async (ctx, inputs) => {
    const artifact = ctx.artifacts.attach(String(inputs.name), String(inputs.content))
    return { artifact }
  },
)
