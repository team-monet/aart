import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadNotifyConfig, sendNotification, notify } from './notify'
import type { RunRecord } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aart-notify-'))
}

function writeNotifyJson(workspace: string, content: unknown): void {
  const dir = path.join(workspace, '.aa')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'notify.json'), JSON.stringify(content))
}

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    runId: 'run-1',
    blockId: 'my.block',
    status: 'FAILED',
    inputs: {},
    trace: [],
    snapshot: { root: {} as never, blocks: {} },
    artifacts: [],
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T00:00:05.000Z',
    error: 'something went wrong',
  }
  return { ...base, ...overrides }
}

function makeLogger() {
  const warns: string[] = []
  return { warn: (m: string) => warns.push(m), warns }
}

// ---------------------------------------------------------------------------
// loadNotifyConfig
// ---------------------------------------------------------------------------

describe('loadNotifyConfig', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }) })

  it('returns undefined when notify.json is absent', () => {
    expect(loadNotifyConfig(workspace)).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    fs.mkdirSync(path.join(workspace, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.aa', 'notify.json'), '{not json')
    expect(loadNotifyConfig(workspace)).toBeUndefined()
  })

  it('returns undefined when url is missing', () => {
    writeNotifyJson(workspace, { format: 'slack' })
    expect(loadNotifyConfig(workspace)).toBeUndefined()
  })

  it('returns undefined when url is empty string', () => {
    writeNotifyJson(workspace, { url: '' })
    expect(loadNotifyConfig(workspace)).toBeUndefined()
  })

  it('returns undefined for non-object JSON (e.g. a bare array)', () => {
    writeNotifyJson(workspace, ['not', 'an', 'object'])
    expect(loadNotifyConfig(workspace)).toBeUndefined()
  })

  it('parses a minimal valid config', () => {
    writeNotifyJson(workspace, { url: 'https://example.com/hook' })
    const c = loadNotifyConfig(workspace)
    expect(c).toEqual({ url: 'https://example.com/hook' })
  })

  it('parses format and on fields', () => {
    writeNotifyJson(workspace, { url: 'https://hooks.slack.com/x', format: 'slack', on: ['FAILED', 'COMPLETED'] })
    const c = loadNotifyConfig(workspace)
    expect(c?.format).toBe('slack')
    expect(c?.on).toEqual(['FAILED', 'COMPLETED'])
  })

  it('silently drops invalid on[] entries', () => {
    writeNotifyJson(workspace, { url: 'https://example.com', on: ['FAILED', 'UNKNOWN_STATUS', 42] })
    const c = loadNotifyConfig(workspace)
    expect(c?.on).toEqual(['FAILED'])
  })
})

// ---------------------------------------------------------------------------
// buildPayload (tested via sendNotification body assertion)
// ---------------------------------------------------------------------------

describe('buildPayload (via sendNotification body)', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('posts only the 6 allowed fields — no trace, no inputs, no snapshot', async () => {
    const capturedBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(init?.body as string)
      return new Response('ok', { status: 200 })
    }))

    const record = makeRecord()
    const logger = makeLogger()
    await sendNotification(
      { url: 'https://example.com/hook' },
      record,
      {},
      logger,
    )

    expect(capturedBodies).toHaveLength(1)
    const body = JSON.parse(capturedBodies[0]!) as Record<string, unknown>

    // Only the 6 permitted fields
    expect(Object.keys(body).sort()).toEqual(['blockId', 'durationMs', 'error', 'runId', 'startedAt', 'status'].sort())
    expect(body['runId']).toBe('run-1')
    expect(body['blockId']).toBe('my.block')
    expect(body['status']).toBe('FAILED')
    expect(body['error']).toBe('something went wrong')
    expect(body['startedAt']).toBe('2024-01-01T00:00:00.000Z')
    expect(body['durationMs']).toBe(5000)
  })

  it('does not include durationMs when endedAt is absent', async () => {
    const capturedBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(init?.body as string)
      return new Response('ok', { status: 200 })
    }))

    const record = makeRecord({ endedAt: undefined })
    const logger = makeLogger()
    await sendNotification({ url: 'https://example.com/hook' }, record, {}, logger)

    const body = JSON.parse(capturedBodies[0]!) as Record<string, unknown>
    expect(body['durationMs']).toBeUndefined()
  })

  it('does not mutate the original record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))

    const record = makeRecord()
    const originalJson = JSON.stringify(record)
    await sendNotification({ url: 'https://example.com/hook' }, record, {}, makeLogger())
    expect(JSON.stringify(record)).toBe(originalJson)
  })
})

// ---------------------------------------------------------------------------
// notify() — status filter
// ---------------------------------------------------------------------------

describe('notify() status filter', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('makes ZERO fetch calls for a COMPLETED record when on defaults to [FAILED]', async () => {
    writeNotifyJson(workspace, { url: 'https://example.com/hook' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const record = makeRecord({ status: 'COMPLETED', error: undefined })
    await notify(workspace, record, {}, makeLogger())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes exactly ONE fetch call for a FAILED record', async () => {
    writeNotifyJson(workspace, { url: 'https://example.com/hook' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))

    await notify(workspace, makeRecord({ status: 'FAILED' }), {}, makeLogger())
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('makes ZERO fetch calls when workspace has no notify.json', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await notify(workspace, makeRecord(), {}, makeLogger())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('notifies on COMPLETED when on includes COMPLETED', async () => {
    writeNotifyJson(workspace, { url: 'https://example.com/hook', on: ['COMPLETED', 'FAILED'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))

    await notify(workspace, makeRecord({ status: 'COMPLETED', error: undefined }), {}, makeLogger())
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Slack vs generic format
// ---------------------------------------------------------------------------

describe('notify() format', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('posts a generic payload by default', async () => {
    writeNotifyJson(workspace, { url: 'https://example.com/hook' })
    const capturedBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(init?.body as string)
      return new Response('ok', { status: 200 })
    }))

    await notify(workspace, makeRecord({ status: 'FAILED' }), {}, makeLogger())

    const body = JSON.parse(capturedBodies[0]!) as Record<string, unknown>
    expect(body).toHaveProperty('runId')
    expect(body).not.toHaveProperty('text')
  })

  it('posts a Slack incoming-webhook shape when format is slack', async () => {
    writeNotifyJson(workspace, { url: 'https://hooks.slack.com/x', format: 'slack' })
    const capturedBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(init?.body as string)
      return new Response('ok', { status: 200 })
    }))

    await notify(workspace, makeRecord({ status: 'FAILED', blockId: 'my.block', error: 'oops' }), {}, makeLogger())

    const body = JSON.parse(capturedBodies[0]!) as Record<string, unknown>
    expect(body).toHaveProperty('text')
    expect(typeof body['text']).toBe('string')
    expect(body['text']).toContain('my.block')
    expect(body['text']).toContain('FAILED')
    expect(body['text']).toContain('oops')
  })

  it('Slack format omits error suffix for COMPLETED', async () => {
    writeNotifyJson(workspace, { url: 'https://hooks.slack.com/x', format: 'slack', on: ['COMPLETED'] })
    const capturedBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(init?.body as string)
      return new Response('ok', { status: 200 })
    }))

    await notify(workspace, makeRecord({ status: 'COMPLETED', error: undefined }), {}, makeLogger())

    const body = JSON.parse(capturedBodies[0]!) as Record<string, unknown>
    expect(body['text']).not.toContain(':')
  })
})

// ---------------------------------------------------------------------------
// Secret URL resolution
// ---------------------------------------------------------------------------

describe('notify() secret URL resolution', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('resolves {{secrets.NAME}} in the URL and posts to the resolved URL', async () => {
    writeNotifyJson(workspace, { url: '{{secrets.webhook_url}}' })
    const capturedUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrls.push(url)
      return new Response('ok', { status: 200 })
    }))

    await notify(workspace, makeRecord({ status: 'FAILED' }), { webhook_url: 'https://real.example.com/hook' }, makeLogger())
    expect(capturedUrls).toEqual(['https://real.example.com/hook'])
  })

  it('warns loudly and makes NO fetch call when the secret reference is missing', async () => {
    writeNotifyJson(workspace, { url: '{{secrets.missing_webhook}}' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logger = makeLogger()

    await notify(workspace, makeRecord({ status: 'FAILED' }), {}, logger)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toMatch(/webhook URL could not be resolved/)
    expect(logger.warns[0]).toMatch(/secrets/)
  })

  it('does not throw even when the secret reference is missing', async () => {
    writeNotifyJson(workspace, { url: '{{secrets.missing_webhook}}' })
    vi.stubGlobal('fetch', vi.fn())
    await expect(notify(workspace, makeRecord({ status: 'FAILED' }), {}, makeLogger())).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

describe('notify() transport failures', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('swallows a fetch rejection and warns (does not throw)', async () => {
    writeNotifyJson(workspace, { url: 'https://down.example.com/hook' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const logger = makeLogger()

    await expect(notify(workspace, makeRecord({ status: 'FAILED' }), {}, logger)).resolves.toBeUndefined()
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toMatch(/down\.example\.com/)
    // Must NOT include the full URL (which could carry a token) — only the host
    expect(logger.warns[0]).not.toMatch(/\/hook/)
  })

  it('swallows an AbortError (timeout) and warns (does not throw)', async () => {
    writeNotifyJson(workspace, { url: 'https://slow.example.com/hook' })
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new DOMException('The operation was aborted', 'AbortError')
      throw err
    }))
    const logger = makeLogger()

    await expect(notify(workspace, makeRecord({ status: 'FAILED' }), {}, logger)).resolves.toBeUndefined()
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toMatch(/slow\.example\.com/)
  })
})

// ---------------------------------------------------------------------------
// Masked error values pass through unchanged
// ---------------------------------------------------------------------------

describe('notify() masked error pass-through', () => {
  let workspace: string
  beforeEach(() => { workspace = makeWorkspace() })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('passes the already-redacted error field through unchanged (does not un-redact)', async () => {
    writeNotifyJson(workspace, { url: 'https://example.com/hook' })
    const capturedBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(init?.body as string)
      return new Response('ok', { status: 200 })
    }))

    // Simulate what redactRecord does: the error on the record already has *** in it
    const maskedRecord = makeRecord({ status: 'FAILED', error: 'failed: token=***' })
    await notify(workspace, maskedRecord, {}, makeLogger())

    const body = JSON.parse(capturedBodies[0]!) as Record<string, unknown>
    expect(body['error']).toBe('failed: token=***')
  })
})
