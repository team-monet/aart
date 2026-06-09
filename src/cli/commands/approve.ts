import YAML from 'yaml'
import { unapprovedInTree, type ApprovalStatus } from '../../core/approval'
import { openRuntime } from '../workspace'

interface StatusOpts {
  version?: string
}

/** Shared: set a registered block's approval status (human-only action). */
function setStatus(id: string, status: ApprovalStatus, opts: StatusOpts): void {
  const runtime = openRuntime()
  const block = runtime.registry.getBlock(id, opts.version)
  if (!block) {
    console.error(`Block not found: ${id}${opts.version ? '@' + opts.version : ''}`)
    process.exit(1)
  }
  if (block.execution.type === 'native') {
    console.error(`${id} is a built-in pack block — it is already trusted and cannot be ${status}.`)
    process.exit(1)
  }
  block.approval = status
  // registerBlock persists the (same-version) file with the new status.
  runtime.fileRegistry.registerBlock(block)
  console.log(`${id}@${block.version} → ${status}`)

  if (status === 'approved') {
    const pending = unapprovedInTree(block, runtime.registry, true)
    if (pending.length) {
      console.warn(`note: still references unapproved blocks: ${pending.join(', ')}`)
      console.warn(`approve them too, or runs will require --yes.`)
    }
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
