/**
 * Tests for governed CLI command blocks (Part A + Part B).
 *
 * Test strategy:
 *   - git.*: real end-to-end execution via Runtime — git is available in CI
 *     (this is a git repo). Assert output shape, exitCode, and that the block
 *     runs WITHOUT --yes (pre-approved by pack delivery).
 *   - kubectl / docker / gh: DEFINITION-LEVEL tests only. The binaries are NOT
 *     available in CI, so we do not execute them. We verify registration,
 *     approval stamping, catalog appearance, and the correct command/args/enum/
 *     pattern values in the definition.
 *   - Part A: pack commands[] delivery — stamped approved, getBlock-resolvable,
 *     catalog-listed; type guard rejects non-command defs in commands[]; id
 *     collision is rejected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Runtime } from '../../core/runtime'
import { CompositeRegistry } from '../../pack/composite-registry'
import { FileRegistry } from '../../registry/file-registry'
import { nativeBlock } from '../../pack/types'
import { buildCatalog } from '../../agent/catalog'
import { unapprovedInTree } from '../../core/approval'
import { corePack } from './index'
import {
  gitStatus,
  gitCurrentBranch,
  gitLog,
  gitDiff,
  kubectlGet,
  dockerPs,
  ghApi,
  cliCommands,
} from './cli'
import type { BlockDefinition } from '../../core/types'
import type { Pack } from '../../pack/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aart-cli-'))
}

function cleanupWorkspace(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function fileReg() {
  return new FileRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'aart-cli-reg-')))
}

// ---------------------------------------------------------------------------
// Part A: pack commands[] delivery mechanism
// ---------------------------------------------------------------------------

describe('Part A — pack commands[] delivery', () => {
  it('a command block in pack.commands[] is stamped approval=approved at load time', () => {
    const pack: Pack = {
      name: 'test-cmd-pack',
      blocks: [],
      capabilities: [],
      commands: [gitStatus],
    }
    const ws = tmpWorkspace()
    try {
      const rt = new Runtime(ws, [pack])
      const resolved = rt.registry.getBlock('git.status')
      expect(resolved).toBeDefined()
      expect(resolved!.approval).toBe('approved')
      expect(resolved!.execution.type).toBe('command')
    } finally {
      cleanupWorkspace(ws)
    }
  })

  it('stamped approved even when the author wrote approval=draft', () => {
    const draftCmd: BlockDefinition = { ...gitStatus, id: 'test.git.status.draft', approval: 'draft' }
    const pack: Pack = {
      name: 'test-cmd-draft',
      blocks: [],
      capabilities: [],
      commands: [draftCmd],
    }
    const ws = tmpWorkspace()
    try {
      const rt = new Runtime(ws, [pack])
      expect(rt.registry.getBlock('test.git.status.draft')!.approval).toBe('approved')
    } finally {
      cleanupWorkspace(ws)
    }
  })

  it('command block appears in listBlocks() and buildCatalog() with type=command and status=approved', () => {
    const r = new CompositeRegistry(fileReg(), [], new Map(), [], [gitStatus])
    const ids = r.listBlocks().map((b) => b.id)
    expect(ids).toContain('git.status')
    const entry = buildCatalog(r).find((e) => e.id === 'git.status')
    expect(entry).toBeDefined()
    expect(entry!.type).toBe('command')
    expect(entry!.status).toBe('approved')
    expect(entry!.category).toBe('git')
    expect(entry!.example).toBeDefined()
  })

  it('unapprovedInTree passes for a pack command block (trusted by origin)', () => {
    const r = new CompositeRegistry(fileReg(), [], new Map(), [], [gitStatus])
    const resolved = r.getBlock('git.status')!
    expect(unapprovedInTree(resolved, r, true)).toEqual([])
  })

  it('id collision with a native block is rejected', () => {
    const nb = nativeBlock(
      { id: 'git.status', name: 'git.status', version: '0.1.0', inputs: [], outputs: [] },
      async () => ({}),
    )
    expect(() => new CompositeRegistry(fileReg(), [nb], new Map(), [], [gitStatus])).toThrow(
      /collides with a native block id/,
    )
  })

  it('duplicate command id in commands[] is rejected', () => {
    expect(() => new CompositeRegistry(fileReg(), [], new Map(), [], [gitStatus, gitStatus])).toThrow(
      /Duplicate pack command id/,
    )
  })

  it('a non-command def (workflow type) in commands[] is rejected by the type guard', () => {
    const wfDef: BlockDefinition = {
      id: 'bad.workflow.in.commands',
      name: 'Bad',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [{ id: 's', block: 'something', inputs: {} }],
      },
    }
    expect(() => new CompositeRegistry(fileReg(), [], new Map(), [], [wfDef])).toThrow(
      /expected "command"/,
    )
  })

  it('a non-workflow def (command type) in workflows[] is rejected by the type guard', () => {
    expect(() => new CompositeRegistry(fileReg(), [], new Map(), [gitStatus], [])).toThrow(
      /expected "workflow"/,
    )
  })

  it('registerBlock and deleteBlock are blocked for pack command ids', () => {
    const r = new CompositeRegistry(fileReg(), [], new Map(), [], [gitStatus])
    expect(() => r.registerBlock(gitStatus)).toThrow(/Cannot overwrite built-in pack command block/)
    expect(() => r.deleteBlock('git.status')).toThrow(/Cannot delete built-in pack command block/)
  })

  it('addPackCommands / removePackCommand work after construction', () => {
    const r = new CompositeRegistry(fileReg())
    r.addPackCommands([gitStatus])
    expect(r.getBlock('git.status')!.approval).toBe('approved')
    r.removePackCommand('git.status')
    expect(r.getBlock('git.status')).toBeUndefined()
  })

  it('Runtime.addPack hot-loads command blocks and tracks them for replacement', () => {
    const pack1: Pack = {
      name: 'hot-cmd-pack',
      blocks: [],
      capabilities: [],
      commands: [gitStatus],
    }
    const ws = tmpWorkspace()
    try {
      const rt = new Runtime(ws, [pack1])
      expect(rt.registry.getBlock('git.status')).toBeDefined()
      // Re-add the same pack (simulates re-approval) — should replace cleanly
      rt.addPack(pack1)
      expect(rt.registry.getBlock('git.status')!.approval).toBe('approved')
    } finally {
      cleanupWorkspace(ws)
    }
  })
})

// ---------------------------------------------------------------------------
// Part B — block definitions (definition-level, no binary execution)
// ---------------------------------------------------------------------------

describe('Part B — block definitions', () => {
  describe('all cliCommands are pre-approved via corePack', () => {
    it('all 7 command blocks are registered in corePack and stamped approved', () => {
      const ws = tmpWorkspace()
      try {
        const rt = new Runtime(ws, [corePack])
        for (const cmd of cliCommands) {
          const resolved = rt.registry.getBlock(cmd.id)
          expect(resolved, `missing block: ${cmd.id}`).toBeDefined()
          expect(resolved!.approval, `${cmd.id} not approved`).toBe('approved')
          expect(resolved!.execution.type, `${cmd.id} not a command`).toBe('command')
        }
      } finally {
        cleanupWorkspace(ws)
      }
    })
  })

  describe('git blocks', () => {
    it('git.status: global options precede subcommand, no inputs, category=git, has example', () => {
      expect(gitStatus.execution.type).toBe('command')
      const exec = gitStatus.execution as Extract<typeof gitStatus.execution, { type: 'command' }>
      expect(exec.command).toBe('git')
      // Global options (-c, --no-optional-locks) must appear before the subcommand
      expect(exec.args).toEqual(['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain'])
      expect(gitStatus.inputs).toHaveLength(0)
      expect(gitStatus.category).toBe('git')
      expect(gitStatus.examples?.[0]).toBeDefined()
    })

    it('git.current-branch: uses symbolic-ref, failOnError:false, no inputs', () => {
      const exec = gitCurrentBranch.execution as Extract<typeof gitCurrentBranch.execution, { type: 'command' }>
      expect(exec.command).toBe('git')
      // Must use symbolic-ref (not rev-parse --abbrev-ref HEAD which returns "HEAD" in detached mode)
      expect(exec.args).toContain('symbolic-ref')
      expect(exec.args).toContain('-q')
      expect(exec.args).toContain('--short')
      expect(exec.args).toContain('HEAD')
      // Global -c must precede subcommand
      expect(exec.args[0]).toBe('-c')
      expect(exec.failOnError).toBe(false)
      expect(gitCurrentBranch.inputs).toHaveLength(0)
    })

    it('git.log: count input with pattern ^[1-9][0-9]*$ (positive integer), default 10', () => {
      const exec = gitLog.execution as Extract<typeof gitLog.execution, { type: 'command' }>
      expect(exec.command).toBe('git')
      expect(exec.args).toContain('{{inputs.count}}')
      // Global options before subcommand
      expect(exec.args[0]).toBe('-c')
      expect(exec.args).toContain('--no-optional-locks')
      const countInput = gitLog.inputs.find((i) => i.name === 'count')
      expect(countInput).toBeDefined()
      // Must be positive-integer-only (no 0, negatives, floats)
      expect(countInput!.pattern).toBe('^[1-9][0-9]*$')
      expect(countInput!.default).toBe(10)
    })

    it('git.diff: global options, --no-textconv, --no-ext-diff, no inputs', () => {
      const exec = gitDiff.execution as Extract<typeof gitDiff.execution, { type: 'command' }>
      expect(exec.command).toBe('git')
      expect(exec.args).toEqual([
        '-c', 'core.fsmonitor=false', '--no-optional-locks',
        'diff', '--stat', '--no-textconv', '--no-ext-diff',
      ])
      expect(gitDiff.inputs).toHaveLength(0)
    })
  })

  describe('kubectl.get', () => {
    it('has resource enum and namespace pattern', () => {
      const exec = kubectlGet.execution as Extract<typeof kubectlGet.execution, { type: 'command' }>
      expect(exec.command).toBe('kubectl')
      expect(exec.args).toEqual(['get', '{{inputs.resource}}', '-n', '{{inputs.namespace}}', '-o', 'json'])
      expect(kubectlGet.category).toBe('k8s')

      const resInput = kubectlGet.inputs.find((i) => i.name === 'resource')
      expect(resInput!.enum).toEqual(['pods', 'deployments', 'services', 'nodes', 'configmaps', 'events'])

      const nsInput = kubectlGet.inputs.find((i) => i.name === 'namespace')
      expect(nsInput!.default).toBe('default')
      expect(nsInput!.pattern).toBe('^[a-z0-9][a-z0-9-]*$')

      // The description mentions safe-interface idea for org forks
      expect(kubectlGet.description).toMatch(/enum/)
    })

    it('appears in catalog via corePack with category=k8s', () => {
      const ws = tmpWorkspace()
      try {
        const rt = new Runtime(ws, [corePack])
        const entry = buildCatalog(rt.registry).find((e) => e.id === 'kubectl.get')
        expect(entry).toBeDefined()
        expect(entry!.category).toBe('k8s')
        expect(entry!.status).toBe('approved')
      } finally {
        cleanupWorkspace(ws)
      }
    })
  })

  describe('docker.ps', () => {
    it('uses --format json (not Go-template syntax)', () => {
      const exec = dockerPs.execution as Extract<typeof dockerPs.execution, { type: 'command' }>
      expect(exec.command).toBe('docker')
      expect(exec.args).toEqual(['ps', '--format', 'json'])
      // No {{.Names}}-style args that would conflict with the aart resolver
      expect(exec.args.some((a) => a.includes('{{.'))).toBe(false)
      expect(dockerPs.category).toBe('docker')
    })
  })

  describe('gh.api', () => {
    it('has endpoint pattern and GH_TOKEN env injection', () => {
      const exec = ghApi.execution as Extract<typeof ghApi.execution, { type: 'command' }>
      expect(exec.command).toBe('gh')
      expect(exec.args).toEqual(['api', '{{inputs.endpoint}}'])

      const epInput = ghApi.inputs.find((i) => i.name === 'endpoint')
      expect(epInput!.required).toBe(true)
      expect(epInput!.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9/_.-]*$')

      expect(exec.env?.GH_TOKEN).toBe('{{secrets.gh_token}}')
      expect(ghApi.category).toBe('github')
    })
  })

  describe('all command blocks have correct output fields', () => {
    it('every cli block declares stdout/stderr/exitCode/ok/truncated outputs', () => {
      const expectedOutputNames = ['stdout', 'stderr', 'exitCode', 'ok', 'truncated']
      for (const block of cliCommands) {
        const outputNames = block.outputs.map((o) => o.name)
        for (const name of expectedOutputNames) {
          expect(outputNames, `${block.id} missing output "${name}"`).toContain(name)
        }
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Part B — git real end-to-end execution (git IS available in CI)
// ---------------------------------------------------------------------------

describe('git real execution (end-to-end via Runtime)', () => {
  // A hermetic temp git repo: gives the git.* command blocks a real repo to
  // operate on while keeping the Runtime's .aa state isolated and writable.
  // (Using the source repo as the workspace pollutes it and fails under CI
  // file permissions — the prior hardcoded path EACCES'd on .aa/registry.)
  let WS: string
  beforeEach(() => {
    WS = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-git-'))
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: WS, stdio: 'ignore' })
    git(['init'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'aart test'])
    fs.writeFileSync(path.join(WS, 'a.txt'), 'hello\n')
    git(['add', 'a.txt'])
    git(['commit', '-m', 'first commit'])
    fs.writeFileSync(path.join(WS, 'b.txt'), 'second\n')
    git(['add', 'b.txt'])
    git(['commit', '-m', 'second commit'])
  })
  afterEach(() => {
    fs.rmSync(WS, { recursive: true, force: true })
  })

  it('git.status runs WITHOUT --yes and results carry exitCode + stdout', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.status')!
    expect(def.approval).toBe('approved')

    // Run without opts.approved override — defaults to true (pre-approved path).
    // When a command block is run at the ROOT level (not as a workflow step), the
    // engine returns its output directly in record.results — no trace entry is
    // created (trace entries are only generated for workflow steps). The run
    // record itself IS the audit trail: blockId, approved, startedAt, endedAt.
    const record = await rt.run(def, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.approved).toBe(true)
    expect(record.blockId).toBe('git.status')

    // Results carry the command-runner output shape
    expect(record.results?.exitCode).toBe(0)
    expect(record.results?.ok).toBe(true)
    // stdout is a string (may be empty on a clean repo)
    expect(typeof record.results?.stdout).toBe('string')
  }, 15_000)

  it('git.current-branch runs and returns a branch name in stdout', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.current-branch')!

    const record = await rt.run(def, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.results?.exitCode).toBe(0)
    // Branch name should be a non-empty trimmed string
    const branchName = (record.results?.stdout as string).trim()
    expect(branchName.length).toBeGreaterThan(0)
    // Should not contain spaces (valid git branch names don't)
    expect(branchName).not.toMatch(/\s/)
  }, 15_000)

  it('git.log runs with default count=10 and returns oneline commit lines', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.log')!

    const record = await rt.run(def, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.results?.exitCode).toBe(0)
    const stdout = (record.results?.stdout as string).trim()
    // Each --oneline line is: <short-hash> <message>
    const lines = stdout.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(10)
    // Each line should start with a hex short hash
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{7,}/)
    }
  }, 15_000)

  it('git.log with count=3 returns at most 3 lines', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.log')!

    const record = await rt.run(def, { count: 3 })
    expect(record.status).toBe('COMPLETED')
    const lines = (record.results?.stdout as string).trim().split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(3)
  }, 15_000)

  // Fix B: engine pattern enforcement applies to numeric inputs via String(value)
  it('git.log rejects count=-1 (negative integer)', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.log')!
    const record = await rt.run(def, { count: -1 })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/pattern/)
  }, 15_000)

  it('git.log rejects count=0 (zero is not a positive integer)', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.log')!
    const record = await rt.run(def, { count: 0 })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/pattern/)
  }, 15_000)

  it('git.log rejects count=3.5 (float)', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.log')!
    const record = await rt.run(def, { count: 3.5 })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/pattern/)
  }, 15_000)

  // Fix A4: git.current-branch uses symbolic-ref + failOnError:false
  // so detached HEAD returns ok:false without throwing.
  it('git.current-branch in detached HEAD returns ok:false (not a throw)', async () => {
    // Detach HEAD
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: WS, stdio: 'ignore' })
    git(['checkout', '--detach'])
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.current-branch')!
    const record = await rt.run(def, {})
    // Must complete (not throw) — failOnError:false
    expect(record.status).toBe('COMPLETED')
    expect(record.results?.ok).toBe(false)
    expect(record.results?.exitCode).not.toBe(0)
  }, 15_000)

  it('git.diff runs and returns a stat summary (string stdout, exitCode 0)', async () => {
    const rt = new Runtime(WS, [corePack])
    const def = rt.registry.getBlock('git.diff')!

    const record = await rt.run(def, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.results?.exitCode).toBe(0)
    expect(typeof record.results?.stdout).toBe('string')
  }, 15_000)

  it('every git run record has blockId and exitCode — the run record IS the audit trail', async () => {
    // Command blocks run at root level have no workflow-step trace entries;
    // the run record itself provides the audit trail: blockId, approved, startedAt,
    // endedAt, and results (stdout/stderr/exitCode/ok).
    const rt = new Runtime(WS, [corePack])
    for (const id of ['git.status', 'git.current-branch', 'git.log', 'git.diff']) {
      const def = rt.registry.getBlock(id)!
      const record = await rt.run(def, {})
      expect(record.status, `${id} run failed`).toBe('COMPLETED')
      expect(record.blockId).toBe(id)
      expect(record.approved).toBe(true)
      // Results carry the audit information
      expect(typeof record.results?.exitCode, `${id} missing exitCode`).toBe('number')
      expect(typeof record.results?.stdout, `${id} missing stdout`).toBe('string')
      expect(typeof record.results?.stderr, `${id} missing stderr`).toBe('string')
    }
  }, 30_000)
})
