import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWorkspace, workspaceSourceLabel, setWorkspace, defaultWorkspace } from './workspace'

// On macOS /tmp is a symlink to /private/tmp, so realpath temp dirs before comparing.
function mktmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('resolveWorkspace precedence (--workspace > $AART_WORKSPACE > ~/.aart)', () => {
  const origEnv = process.env.AART_WORKSPACE

  afterEach(() => {
    if (origEnv === undefined) delete process.env.AART_WORKSPACE
    else process.env.AART_WORKSPACE = origEnv
    setWorkspace(undefined)
  })

  it('the --workspace flag wins over env — source is flag', () => {
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

  it('$AART_WORKSPACE wins over the default when no flag is set — source is env', () => {
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

  it('falls back to the per-user default ~/.aart when no flag/env — source is default', () => {
    delete process.env.AART_WORKSPACE
    setWorkspace(undefined)
    const result = resolveWorkspace()
    expect(result.source).toBe('default')
    expect(result.dir).toBe(defaultWorkspace())
    expect(result.dir).toBe(path.join(os.homedir(), '.aart'))
  })

  it('treats a whitespace-only AART_WORKSPACE as unset (falls back to the default)', () => {
    process.env.AART_WORKSPACE = '   '
    setWorkspace(undefined)
    const result = resolveWorkspace()
    expect(result.source).toBe('default')
    expect(result.dir).toBe(defaultWorkspace())
  })

  it('does NOT depend on cwd — a .aa in the current directory is ignored (no discovery)', () => {
    const dirWithAa = mktmp('aart-cwd-')
    const origCwd = process.cwd()
    try {
      fs.mkdirSync(path.join(dirWithAa, '.aa'))
      delete process.env.AART_WORKSPACE
      setWorkspace(undefined)
      process.chdir(dirWithAa)
      const result = resolveWorkspace()
      // Pre-0.7 this would have "discovered" dirWithAa; now cwd is irrelevant.
      expect(result.dir).toBe(defaultWorkspace())
      expect(result.source).toBe('default')
    } finally {
      process.chdir(origCwd)
      fs.rmSync(dirWithAa, { recursive: true, force: true })
    }
  })

  it('workspaceSourceLabel returns correct strings for all sources', () => {
    expect(workspaceSourceLabel('flag')).toBe('via --workspace')
    expect(workspaceSourceLabel('env')).toBe('via $AART_WORKSPACE')
    expect(workspaceSourceLabel('default')).toBe('default workspace (~/.aart)')
  })

  it('env ~/ expands to the home directory — not a literal ~ segment under cwd', () => {
    process.env.AART_WORKSPACE = '~/.aart'
    setWorkspace(undefined)
    const result = resolveWorkspace()
    expect(result.source).toBe('env')
    expect(result.dir).toBe(path.join(os.homedir(), '.aart'))
    expect(result.dir).not.toContain('/~/')
    expect(result.dir).not.toMatch(/\/~$/)
  })

  it('env bare ~ expands to homedir', () => {
    process.env.AART_WORKSPACE = '~'
    setWorkspace(undefined)
    const result = resolveWorkspace()
    expect(result.source).toBe('env')
    expect(result.dir).toBe(os.homedir())
  })

  it('flag ~/foo expands to homedir/foo — source is flag', () => {
    setWorkspace('~/foo')
    const result = resolveWorkspace()
    expect(result.source).toBe('flag')
    expect(result.dir).toBe(path.join(os.homedir(), 'foo'))
    expect(result.dir).not.toContain('/~/')
  })

  it('flag bare ~ expands to homedir — source is flag', () => {
    setWorkspace('~')
    const result = resolveWorkspace()
    expect(result.source).toBe('flag')
    expect(result.dir).toBe(os.homedir())
  })

  it('a relative non-tilde env value still resolves against cwd (intentional behaviour)', () => {
    process.env.AART_WORKSPACE = './scratch'
    setWorkspace(undefined)
    const result = resolveWorkspace()
    expect(result.source).toBe('env')
    expect(result.dir).toBe(path.resolve('./scratch'))
    expect(result.dir).not.toContain('/~/')
  })
})
