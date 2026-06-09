import YAML from 'yaml'
import { setApproval } from '../../core/governance'
import type { ApprovalStatus } from '../../core/approval'
import { openRuntime } from '../workspace'

interface StatusOpts {
  version?: string
}

/** Set a registered block's approval status (the user's governance action). */
function setStatus(id: string, status: ApprovalStatus, opts: StatusOpts): void {
  const result = setApproval(openRuntime().registry, id, status, opts.version)
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }
  console.log(`${result.id}@${result.version} → ${status}`)
  if (result.pending?.length) {
    console.warn(`note: still references unapproved blocks: ${result.pending.join(', ')}`)
    console.warn(`approve them too, or runs will require --yes.`)
  }
}

export async function approveCommand(id: string, opts: StatusOpts): Promise<void> {
  setStatus(id, 'approved', opts)
}

export async function deprecateCommand(id: string, opts: StatusOpts): Promise<void> {
  setStatus(id, 'deprecated', opts)
}

/** `aart show <id>` — print a registered definition (for review before approving). */
export async function showCommand(id: string, opts: StatusOpts): Promise<void> {
  const block = openRuntime().registry.getBlock(id, opts.version)
  if (!block) {
    console.error(`Block not found: ${id}${opts.version ? '@' + opts.version : ''}`)
    process.exit(1)
  }
  console.log(YAML.stringify(block))
}
