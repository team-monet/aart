import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findWorkspaceRoot,
  resolveWorkspace,
  workspaceSourceLabel,
  setWorkspace,
  defaultWorkspace,
} from './workspace'

// On macOS /tmp is a symlink to /private/tmp, so we must realpath temp dirs
// before comparing paths to avoid spurious mismatches.
function mktmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('findWorkspaceRoot', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mktmp('aart-ws-')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns the directory itself when it directly contains .aa', () => {
    fs.mkdirSync(path.join(tmp, '.aa'))
    expect(findWorkspaceRoot(tmp)).toBe(tmp)
  })

  it('walks up to the nearest ancestor that has .aa', () => {
    const proj = path.join(tmp, 'proj')
    const deep = path.join(proj, 'a', 'b', 'c')
    fs.mkdirSync(path.join(proj, '.aa'), { recursive: true })
    fs.mkdirSync(deep, { recursive: true })
    // Realpath the project dir — it IS under tmp which we already realpath'd, so fine.
    expect(findWorkspaceRoot(deep)).toBe(proj)
  })

  it('returns the CLOSER .aa when multiple ancestors have one', () => {
    const proj = path.join(tmp, 'proj')
    const sub = path.join(proj, 'sub')
    const child = path.join(sub, 'x')
    fs.mkdirSync(path.join(proj, '.aa'), { recursive: true })
    fs.mkdirSync(path.join(sub, '.aa'), { recursive: true })
    fs.mkdirSync(child, { recursive: true })
    expect(findWorkspaceRoot(child)).toBe(sub)
  })

  it('returns undefined when no .aa exists above the start path', () => {
    // tmp has no .aa and is a fresh isolated dir — no ancestor in /tmp has one.
    const leaf = path.join(tmp, 'a', 'b')
    fs.mkdirSync(leaf, { recursive: true })
    // We can only assert undefined if no real ancestor has .aa; this holds for
    // a brand-new mkdtemp'd tree (neither /tmp itself nor / has .aa in practice).
    const result = findWorkspaceRoot(leaf)
    // Either undefined (expected) or some ancestor coincidentally has .aa (CI edge).
    // Accept undefined explicitly; any found dir MUST contain .aa as a sanity check.
    if (result !== undefined) {
      expect(fs.existsSync(path.join(result, '.aa'))).toBe(true)
    } else {
      expect(result).toBeUndefined()
    }
  })
})

describe('resolveWorkspace precedence', () => {
  const origEnv = process.env.AART_WORKSPACE
  const origCwd = process.cwd()

  afterEach(() => {
    // Restore env, cwd, and clear override after each test.
    if (origEnv === undefined) delete process.env.AART_WORKSPACE
    else process.env.AART_WORKSPACE = origEnv
    setWorkspace(undefined)
    process.chdir(origCwd)
  })

  it('flag wins over env and cwd — source is flag', () => {
    const tmp = mktmp('aart-flag-')
    try {
      process.env.AART_WORKSPACE = '/some/env/path'
      setWorkspace(tmp)
      const result = resolveWorkspace()
      expect(result.dir).toBe(tmp)
      expect(result.source).toBe('flag')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('env wins over discovery when no flag is set — source is env', () => {
    const tmp = mktmp('aart-env-')
    try {
      process.env.AART_WORKSPACE = tmp
      setWorkspace(undefined)
      const result = resolveWorkspace()
      expect(result.dir).toBe(tmp)
      expect(result.source).toBe('env')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('discovers an ancestor .aa when no flag/env is set — source is discovered', () => {
    const root = mktmp('aart-disc-')
    try {
      fs.mkdirSync(path.join(root, '.aa'))
      const deep = path.join(root, 'x', 'y')
      fs.mkdirSync(deep, { recursive: true })
      delete process.env.AART_WORKSPACE
      setWorkspace(undefined)
      process.chdir(deep)
      const result = resolveWorkspace()
      expect(result.dir).toBe(root)
      expect(result.source).toBe('discovered')
    } finally {
      process.chdir(origCwd)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats a whitespace-only AART_WORKSPACE as unset and falls through to discovery', () => {
    const root = mktmp('aart-blank-')
    try {
      fs.mkdirSync(path.join(root, '.aa'))
      process.env.AART_WORKSPACE = '   '
      setWorkspace(undefined)
      process.chdir(root)
      const result = resolveWorkspace()
      expect(result.source).not.toBe('env')
      expect(result.dir).toBe(root)
      expect(result.source).toBe('discovered')
    } finally {
      process.chdir(origCwd)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the per-user default (~/.aart) when nothing else resolves — source is default', () => {
    const bare = mktmp('aart-bare-') // a fresh dir with no .aa anywhere above it
    try {
      delete process.env.AART_WORKSPACE
      setWorkspace(undefined)
      process.chdir(bare)
      const result = resolveWorkspace()
      expect(result.source).toBe('default')
      expect(result.dir).toBe(defaultWorkspace())
      expect(result.dir).toBe(path.join(os.homedir(), '.aart'))
    } finally {
      process.chdir(origCwd)
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })

  it('workspaceSourceLabel returns correct strings for all sources', () => {
    expect(workspaceSourceLabel('flag')).toBe('via --workspace')
    expect(workspaceSourceLabel('env')).toBe('via $AART_WORKSPACE')
    expect(workspaceSourceLabel('discovered')).toBe('discovered .aa in a parent directory')
    expect(workspaceSourceLabel('default')).toBe('default workspace (~/.aart)')
  })
})
