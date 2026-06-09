import { readRun, renderReport } from '../../core/report'
import { workspace } from '../workspace'

export async function reportCommand(runId: string): Promise<void> {
  try {
    const record = await readRun(workspace(), runId)
    console.log(renderReport(record))
  } catch {
    console.error(`Run not found: ${runId}`)
    process.exit(1)
  }
}
