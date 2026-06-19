import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { BlockDefinitionSchema, type BlockDefinition } from '../core/types'
import { nativeBlock, type Capability, type NativeBlock, type Pack } from './types'

// A real CommonJS require (works the same compiled and under vitest's ESM
// transform), so pack loading and cache-busting are dependable.
const requirePack = createRequire(__filename)

/**
 * Workspace packs: agent-authored native blocks + capabilities, loaded from
 * `<workspace>/.aa/packs/<name>/` (plain CommonJS — `module.exports = pack`).
 *
 * Trust model. A pack is real code running unsandboxed inside the runtime, so
 * loading is governed exactly like block approval, with one extra property:
 * REGISTERING A PACK NEVER EXECUTES IT. Registration only records a content
 * hash in `.aa/packs.json` as a draft; the user reviews and approves; only
 * approved packs whose on-disk hash still matches the approved hash are
 * require()d at startup. Any edit after approval flips the hash → the pack is
 * skipped with a loud warning until the user re-approves.
 *
 * The hash covers every file in the pack dir EXCEPT `node_modules` and `.git`
 * — a pack's own installed deps are outside the seal, the source is inside it.
 */

export interface PackManifestEntry {
  /** Pack dir, relative to the workspace. */
  path: string
  sha256: string
  approved: boolean
  registeredAt: string
  approvedAt?: string
}

export interface PackManifest {
  packs: Record<string, PackManifestEntry>
}

const manifestPath = (ws: string) => path.join(ws, '.aa', 'packs.json')

export function readPackManifest(ws: string): PackManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(ws), 'utf8')) as PackManifest
    return { packs: raw.packs ?? {} }
  } catch {
    return { packs: {} }
  }
}

function writePackManifest(ws: string, manifest: PackManifest): void {
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true })
  fs.writeFileSync(manifestPath(ws), JSON.stringify(manifest, null, 2))
}

const HASH_EXCLUDE = new Set(['node_modules', '.git'])

/** Files covered by the pack seal, as workspace-relative sorted paths. */
function packFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (HASH_EXCLUDE.has(entry.name)) continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(path.relative(dir, full))
    }
  }
  walk(dir)
  return out
}

export function hashPackDir(dir: string): string {
  const h = createHash('sha256')
  for (const rel of packFiles(dir)) {
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

/** The pack's entry file: package.json `main`, else index.js / index.cjs. */
export function resolvePackEntry(dir: string): string {
  const pkgPath = path.join(dir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const main = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { main?: string }).main
      if (main && fs.existsSync(path.join(dir, main))) return path.join(dir, main)
    } catch {
      /* fall through to index.* */
    }
  }
  for (const candidate of ['index.js', 'index.cjs']) {
    const p = path.join(dir, candidate)
    if (fs.existsSync(p)) return p
  }
  throw new Error(`pack has no entry file (package.json "main", index.js, or index.cjs): ${dir}`)
}

export interface RegisterPackResult {
  name: string
  path: string
  files: string[]
  /** Entry-file code preview for the approval conversation. */
  preview: string
}

const PACK_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/
/** Built-in pack names can't be shadowed ('core', plus its pre-rename name 'qa'). */
const RESERVED_PACK_NAMES = new Set(['core', 'qa'])

/**
 * Record a pack as a draft in the manifest. Does NOT load or execute any of
 * its code — that only ever happens after user approval.
 */
export function registerWorkspacePack(ws: string, name: string, relPath?: string): RegisterPackResult {
  if (!PACK_NAME_RE.test(name)) {
    throw new Error(`invalid pack name "${name}" (lowercase letters, digits, - and _)`)
  }
  if (RESERVED_PACK_NAMES.has(name)) {
    throw new Error(`pack name "${name}" is reserved by a built-in pack`)
  }
  const rel = relPath ?? path.join('.aa', 'packs', name)
  const dir = path.resolve(ws, rel)
  if (!dir.startsWith(path.resolve(ws) + path.sep)) {
    throw new Error(`pack path must be inside the workspace: ${rel}`)
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`pack directory not found: ${dir}`)
  }
  const entry = resolvePackEntry(dir)
  const manifest = readPackManifest(ws)
  manifest.packs[name] = {
    path: rel,
    sha256: hashPackDir(dir),
    approved: false, // every (re-)registration lands as draft
    registeredAt: new Date().toISOString(),
  }
  writePackManifest(ws, manifest)
  const code = fs.readFileSync(entry, 'utf8')
  return {
    name,
    path: rel,
    files: packFiles(dir),
    preview: code.length > 2000 ? code.slice(0, 2000) + '\n…' : code,
  }
}

/**
 * Approve a registered pack: re-hash what is on disk RIGHT NOW (the user
 * approves the current content, not whatever was registered earlier) and mark
 * it approved. Loading is the caller's choice (e.g. hot-add to a live Runtime).
 */
export function approveWorkspacePack(ws: string, name: string): PackManifestEntry {
  const manifest = readPackManifest(ws)
  const entry = manifest.packs[name]
  if (!entry) throw new Error(`pack not registered: ${name} (call aa_register_pack first)`)
  const dir = path.resolve(ws, entry.path)
  entry.sha256 = hashPackDir(dir)
  entry.approved = true
  entry.approvedAt = new Date().toISOString()
  writePackManifest(ws, manifest)
  return entry
}

/** Require + shape-validate one pack. EXECUTES the pack's entry file. */
export function loadWorkspacePack(ws: string, name: string): Pack {
  const manifest = readPackManifest(ws)
  const entry = manifest.packs[name]
  if (!entry) throw new Error(`pack not registered: ${name}`)
  const dir = path.resolve(ws, entry.path)
  const entryFile = resolvePackEntry(dir)
  // Bust the require cache so an approved edit is picked up by a live server.
  delete requirePack.cache[requirePack.resolve(entryFile)]
  const mod = requirePack(entryFile) as Record<string, unknown>
  const candidate = (mod?.pack ?? (mod as { default?: unknown }).default ?? mod) as unknown
  return validatePackShape(candidate, name)
}

/** Structural validation of a loaded pack module (clear errors, no zod for fns). */
function validatePackShape(value: unknown, name: string): Pack {
  const fail = (msg: string): never => {
    throw new Error(`pack "${name}": ${msg}`)
  }
  if (!value || typeof value !== 'object') fail('entry must export a pack object ({ name, blocks, capabilities? })')
  const p = value as { name?: unknown; blocks?: unknown; capabilities?: unknown; workflows?: unknown }
  if (p.name !== name) fail(`pack.name must be "${name}" (got ${JSON.stringify(p.name)})`)
  if (!Array.isArray(p.blocks) || p.blocks.length === 0) fail('pack.blocks must be a non-empty array')

  // Workspace packs may NOT ship a `workflows` array.
  //
  // The workspace-pack approval review (aa_register_pack / aa_approve_pack) shows
  // the user the raw entry-file source code preview — it does NOT render each
  // workflow via renderDefinition.  A shipped workflow would therefore become
  // runnable (stamped approved by origin) without the human approver ever seeing
  // it in the approval surface — violating the governance trust-surface rule.
  //
  // TODO(follow-up): surface workspace-pack workflows via renderDefinition in the
  // approval conversation, then parse and validate them here (mirror how corePack
  // ships workflows), and lift this restriction.
  if (Array.isArray(p.workflows) && p.workflows.length > 0) {
    fail(
      'workspace packs may not export a `workflows` array — shipped workflows are not yet shown in the ' +
      'pack approval review and would run unapproved.  Move the workflow logic into a native block, or ' +
      'register it separately via aa_register / aart register.',
    )
  }

  const blocks: NativeBlock[] = (p.blocks as unknown[]).map((b: unknown, i: number) => {
    const nb = b as { def?: unknown; run?: unknown }
    if (typeof nb?.run !== 'function') fail(`blocks[${i}].run must be a function`)
    // Workspace packs may only contribute native blocks — force the type, then
    // validate the definition like any other.
    const rawDef = { ...(nb.def as Record<string, unknown>) }
    delete rawDef.execution
    const parsed = BlockDefinitionSchema.omit({ execution: true }).safeParse(rawDef)
    if (!parsed.success) {
      fail(`blocks[${i}].def invalid: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`)
    }
    return nativeBlock(parsed.data as Omit<BlockDefinition, 'execution'>, nb.run as NativeBlock['run'])
  })

  const capabilities: Capability[] = ((p.capabilities as unknown[]) ?? []).map((c: unknown, i: number) => {
    const cap = c as { name?: unknown; setup?: unknown; teardown?: unknown }
    if (typeof cap?.name !== 'string' || !cap.name) fail(`capabilities[${i}].name must be a string`)
    if (typeof cap?.setup !== 'function') fail(`capabilities[${i}].setup must be a function`)
    if (typeof cap?.teardown !== 'function') fail(`capabilities[${i}].teardown must be a function`)
    return cap as Capability
  })

  return { name, blocks, capabilities }
}

export interface LoadedPacks {
  packs: Pack[]
  warnings: string[]
}

/**
 * Load every approved pack whose on-disk content still matches its approved
 * hash. Anything else (edited since approval, missing dir, load/shape error)
 * is skipped with a warning — a broken pack must never take the runtime down.
 */
export function loadApprovedPacks(ws: string): LoadedPacks {
  const packs: Pack[] = []
  const warnings: string[] = []
  const manifest = readPackManifest(ws)
  for (const [name, entry] of Object.entries(manifest.packs)) {
    if (!entry.approved) continue
    const dir = path.resolve(ws, entry.path)
    try {
      const now = hashPackDir(dir)
      if (now !== entry.sha256) {
        warnings.push(
          `pack "${name}" changed since it was approved — skipped. Re-approve it (aa_approve_pack) to load it.`,
        )
        continue
      }
      packs.push(loadWorkspacePack(ws, name))
    } catch (err) {
      warnings.push(`pack "${name}" failed to load — skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { packs, warnings }
}

/**
 * Combine built-in packs with workspace packs, dropping any workspace pack
 * that collides (block id, workflow id, or capability name) with what's already
 * loaded — with a warning, instead of letting the Runtime constructor throw.
 *
 * Built-in WORKFLOW ids are included in the taken-id set.  Without this a
 * workspace pack whose native block id equals a core workflow id (e.g.
 * `http.health-check`) would pass this check, then throw inside CompositeRegistry
 * construction (_loadPackDef) causing a hard CLI/MCP startup failure.
 */
export function mergePacks(base: Pack[], extra: Pack[]): LoadedPacks {
  // Legacy alias ids count as taken too — a workspace pack must not shadow them.
  // Built-in workflow ids (pack.workflows[].id) are also reserved so a workspace
  // pack block that collides with one is skipped here rather than crashing at
  // CompositeRegistry construction.
  const blockIds = new Set(
    base.flatMap((p) => [
      ...p.blocks.map((b) => b.def.id),
      ...Object.keys(p.aliases ?? {}),
      ...(p.workflows ?? []).map((w) => w.id),
    ]),
  )
  const capNames = new Set(base.flatMap((p) => p.capabilities.map((c) => c.name)))
  const packs = [...base]
  const warnings: string[] = []
  for (const pack of extra) {
    const dupBlock = pack.blocks.find((b) => blockIds.has(b.def.id))
    const dupCap = pack.capabilities.find((c) => capNames.has(c.name))
    if (dupBlock || dupCap) {
      warnings.push(
        `pack "${pack.name}" skipped: ${
          dupBlock ? `block id "${dupBlock.def.id}"` : `capability "${dupCap!.name}"`
        } is already provided by another pack`,
      )
      continue
    }
    for (const b of pack.blocks) blockIds.add(b.def.id)
    for (const c of pack.capabilities) capNames.add(c.name)
    packs.push(pack)
  }
  return { packs, warnings }
}
