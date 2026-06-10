import path from 'node:path'
import {
  approveWorkspacePack,
  hashPackDir,
  loadWorkspacePack,
  readPackManifest,
  registerWorkspacePack,
} from '../../pack/loader'
import { workspace } from '../workspace'

/** `aart pack register <name>` — record a pack as draft (never executes it). */
export async function packRegisterCommand(name: string, opts: { path?: string }): Promise<void> {
  const r = registerWorkspacePack(workspace(), name, opts.path)
  console.log(`registered pack "${r.name}" (${r.path}) as draft — not loaded yet.`)
  console.log(`files sealed by the approval hash: ${r.files.join(', ')}`)
  console.log(`review it, then run: aart pack approve ${r.name}`)
}

/** `aart pack approve <name>` — the user's governance action for packs. */
export async function packApproveCommand(name: string): Promise<void> {
  const ws = workspace()
  // Load (and shape-validate) before recording approval, so a broken pack is
  // rejected instead of approved-but-unloadable.
  const pack = loadWorkspacePack(ws, name)
  approveWorkspacePack(ws, name)
  const ids = pack.blocks.map((b) => b.def.id).join(', ')
  console.log(`approved pack "${name}" — ${pack.blocks.length} block(s): ${ids}`)
}

/** `aart pack list` — manifest entries with their live status. */
export async function packListCommand(): Promise<void> {
  const ws = workspace()
  const manifest = readPackManifest(ws)
  const names = Object.keys(manifest.packs)
  if (!names.length) {
    console.log('no workspace packs registered (.aa/packs.json is empty)')
    return
  }
  for (const name of names) {
    const entry = manifest.packs[name]!
    let status: string
    if (!entry.approved) status = 'draft'
    else {
      try {
        status = hashPackDir(path.resolve(ws, entry.path)) === entry.sha256 ? 'approved' : 'CHANGED since approval — re-approve to load'
      } catch {
        status = 'MISSING on disk'
      }
    }
    console.log(`${name}  ${entry.path}  ${status}`)
  }
}
