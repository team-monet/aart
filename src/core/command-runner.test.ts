import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommandBlock } from './command-runner'
import { createContext } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { Runtime } from './runtime'
import { validateDraft } from '../agent/validate'
import { FileRegistry } from '../registry/file-registry'
import type { BlockDefinition, Execution } from './types'
import type { ExecutionContext } from './context'

type CommandExecution = Extract<Execution, { type: 'command' }>

let dir: string
let ctx: ExecutionContext

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-cmd-'))
  ctx = createContext({
    workspace: dir,
    artifacts: new ArtifactStore(path.join(dir, 'run')),
    secrets: { TOKEN: 'hunter2' },
  })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const node = (over: Partial<CommandExecution>): CommandExecution => ({
  type: 'command',
  command: 'node',
  args: [],
  ...over,
})

describe('runCommandBlock', () => {
  it('interpolates inputs into argv slots and captures stdout', async () => {
    const res = await runCommandBlock(
      node({ args: ['-e', 'console.log("hello", process.argv[1])', '{{inputs.who}}'] }),
      { who: 'world' },
      undefined,
      ctx,
    )
    expect(res.output.stdout).toBe('hello world\n')
    expect(res.output).toMatchObject({ exitCode: 0, ok: true, truncated: false })
  })

  it('an injection-shaped input stays a literal argument (no shell)', async () => {
    const evil = '; echo pwned > escaped.txt'
    const res = await runCommandBlock(
      node({ args: ['-e', 'console.log(JSON.stringify(process.argv[1]))', '{{inputs.x}}'] }),
      { x: evil },
      undefined,
      ctx,
    )
    expect(JSON.parse(String(res.output.stdout))).toBe(evil) // arrived verbatim as ONE arg
    expect(fs.existsSync(path.join(dir, 'escaped.txt'))).toBe(false)
  })

  it('non-zero exit fails by default, but branches when failOnError is false', async () => {
    await expect(
      runCommandBlock(node({ args: ['-e', 'console.error("boom"); process.exit(3)'] }), {}, undefined, ctx),
    ).rejects.toThrow(/exited 3[\s\S]*boom/)

    const res = await runCommandBlock(
      node({ args: ['-e', 'process.exit(3)'], failOnError: false }),
      {},
      undefined,
      ctx,
    )
    expect(res.output).toMatchObject({ exitCode: 3, ok: false })
  })

  it('env: an unset secret (lone {{secrets.*}} ref) is omitted; argv-slot missing still throws', async () => {
    // When a secret referenced in env is a lone {{secrets.X}} template and the
    // secret is not set, the env entry is omitted rather than throwing.
    const res = await runCommandBlock(
      node({
        args: ['-e', 'console.log(JSON.stringify(typeof process.env.ABSENT_KEY))'],
        env: { ABSENT_KEY: '{{secrets.missing_secret}}' },
      }),
      {},
      undefined,
      ctx,
    )
    // The env entry was omitted, so the child sees it as undefined
    expect(res.output.stdout).toContain('"undefined"')

    // Argv-slot interpolation remains strict: an unresolvable slot still throws
    await expect(
      runCommandBlock(
        node({ args: ['-e', 'process.exit(0)', '{{inputs.missing}}'] }),
        {},
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/Unresolved/)
  })

  // Fix C1: typo'd non-secret env template must THROW, not be silently omitted.
  it('env: a typo\'d {{inputs.x}} reference in env value throws (not silently omitted)', async () => {
    await expect(
      runCommandBlock(
        node({
          args: ['-e', 'process.exit(0)'],
          // inputs.token is not in the inputs map — this is a typo, not an
          // optional secret. It must throw so the user sees the bug.
          env: { MY_TOKEN: '{{inputs.token}}' },
        }),
        {}, // inputs map — token is absent
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/Unresolved/)
  })

  // Fix C2: KUBECONFIG passes through from process.env (config-file path, not a secret).
  // GH_TOKEN and GITHUB_TOKEN are intentionally NOT in the whitelist — passing them
  // to every child would leak CI tokens unredacted into run reports.
  it('env: KUBECONFIG from process.env is inherited by child', async () => {
    const prev = process.env.KUBECONFIG
    process.env.KUBECONFIG = '/tmp/kube.yaml'
    try {
      const res = await runCommandBlock(
        node({ args: ['-e', 'console.log(process.env.KUBECONFIG ?? "absent")'] }),
        {},
        undefined,
        ctx,
      )
      expect((res.output.stdout as string).trim()).toBe('/tmp/kube.yaml')
    } finally {
      if (prev === undefined) delete process.env.KUBECONFIG
      else process.env.KUBECONFIG = prev
    }
  })

  it('env: GH_TOKEN is NOT passed through from process.env (would leak unredacted into reports)', async () => {
    const prev = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ambient-gh-token'
    try {
      const res = await runCommandBlock(
        node({ args: ['-e', 'console.log(process.env.GH_TOKEN ?? "absent")'] }),
        {},
        undefined,
        ctx,
      )
      expect((res.output.stdout as string).trim()).toBe('absent')
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = prev
    }
  })

  it('env template resolves secrets; cwd is workspace-rooted', async () => {
    const res = await runCommandBlock(
      node({
        args: ['-e', 'console.log(process.env.MY_TOKEN, process.cwd())'],
        env: { MY_TOKEN: '{{secrets.TOKEN}}' },
        cwd: 'sub',
      }),
      {},
      undefined,
      (fs.mkdirSync(path.join(dir, 'sub')), ctx),
    )
    expect(res.output.stdout).toContain('hunter2')
    expect(res.output.stdout).toContain(fs.realpathSync(path.join(dir, 'sub')))
    await expect(
      runCommandBlock(node({ cwd: '../outside' }), {}, undefined, ctx),
    ).rejects.toThrow(/escapes the workspace/)
  })

  it('kills a hung command at the timeout and reports ENOENT clearly', async () => {
    await expect(
      runCommandBlock(node({ args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 500 }), {}, undefined, ctx),
    ).rejects.toThrow(/timed out/)
    await expect(
      runCommandBlock(node({ command: 'definitely-not-a-binary-xyz' }), {}, undefined, ctx),
    ).rejects.toThrow(/failed to start/)
  }, 10000)
})

describe('command blocks via Runtime + governance surfaces', () => {
  it('runs in a workflow and the secret is redacted from the persisted record', async () => {
    const cmdBlock: BlockDefinition = {
      id: 'cmd.echo-token',
      name: 'Echo Token',
      version: '0.1.0',
      inputs: [],
      outputs: [{ name: 'stdout', type: 'string' }],
      execution: {
        type: 'command',
        command: 'node',
        args: ['-e', 'console.log("token is", process.env.T)'],
        // env-var secrets load lowercased: AART_SECRET_TOKEN → {{secrets.token}}
        env: { T: '{{secrets.token}}' },
      },
    }
    process.env.AART_SECRET_TOKEN = 'hunter2'
    try {
      const record = await new Runtime(dir, []).run(cmdBlock, {})
      expect(record.status).toBe('COMPLETED')
      // The command ran with the secret, but the report must not contain it.
      expect(JSON.stringify(record)).not.toContain('hunter2')
      expect(String(record.results?.stdout)).toContain('token is')
    } finally {
      delete process.env.AART_SECRET_TOKEN
    }
  })

  it('validateDraft rejects interpolation in command/cwd but allows it in args', () => {
    const registry = new FileRegistry(path.join(dir, '.aa', 'registry'))
    const bad = {
      id: 'b',
      name: 'B',
      inputs: [],
      outputs: [],
      execution: { type: 'command', command: '{{inputs.cmd}}', args: [] },
    }
    expect(validateDraft(bad, registry).errors.join(' ')).toMatch(/fixed binary/)
    const good = {
      id: 'g',
      name: 'G',
      inputs: [{ name: 'ns', type: 'string', required: true }],
      outputs: [],
      execution: { type: 'command', command: 'kubectl', args: ['get', 'pods', '-n', '{{inputs.ns}}'] },
    }
    expect(validateDraft(good, registry).ok).toBe(true)
  })
})
