import { describe, it, expect } from 'vitest'
import { runNodeBlock, checkNodeSyntax } from './executor'
import type { ExecutionContext } from './context'

// The executor only reads ctx.runId and ctx.vars.
const ctx = { runId: 't', vars: {} } as ExecutionContext

describe('runNodeBlock (isolated-vm sandbox)', () => {
  it('runs a normal block and returns its object', async () => {
    const r = await runNodeBlock('return { sum: inputs.a + inputs.b };', { a: 2, b: 3 }, ctx)
    expect(r.output).toEqual({ sum: 5 })
  })

  it('captures console output', async () => {
    const r = await runNodeBlock('console.log("hi", inputs.x); return {};', { x: 7 }, ctx)
    expect(r.logs).toEqual(['hi 7'])
  })

  it('blocks the constructor-chain escape to the host process', async () => {
    await expect(
      runNodeBlock('return { p: inputs.constructor.constructor("return process")() };', {}, ctx),
    ).rejects.toThrow(/process is not defined/)
  })

  it('cannot require host modules (no fs/network)', async () => {
    await expect(
      runNodeBlock('return require("fs").readFileSync("/etc/hosts", "utf8");', {}, ctx),
    ).rejects.toThrow(/require is not defined/)
  })

  it('hard-kills an infinite loop at the timeout', async () => {
    const t0 = Date.now()
    await expect(runNodeBlock('while (true) {}', {}, ctx, { timeoutMs: 300 })).rejects.toThrow(
      /timed out|timeout/i,
    )
    expect(Date.now() - t0).toBeLessThan(2500)
  }, 6000)

  it('propagates a thrown error message', async () => {
    await expect(runNodeBlock('throw new Error("kaboom");', {}, ctx)).rejects.toThrow(/kaboom/)
  })

  it('a structural break-out cannot hijack the wrapper (fails cleanly)', async () => {
    // A stray `}` that under naive splicing would restructure the wrapper.
    const breakout = 'return 0;\n}; globalThis.LEAK = 1; const z = async () => {'
    await expect(runNodeBlock(breakout, {}, ctx)).rejects.toThrow()
  })
})

describe('checkNodeSyntax (static gate)', () => {
  it('passes syntactically valid code', () => {
    expect(checkNodeSyntax('return { ok: true };')).toBeNull()
  })
  it('rejects invalid code', () => {
    expect(checkNodeSyntax('return { ok: ;')).toBeTruthy()
  })
  it('rejects a structural break-out at registration time', () => {
    expect(checkNodeSyntax('return 0;\n}; globalThis.LEAK = 1; const z = async () => {')).toBeTruthy()
  })
})
