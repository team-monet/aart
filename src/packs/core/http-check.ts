import { nativeBlock } from '../../pack/types'

const BODY_TRUNCATE = 10_000

export const httpCheck = nativeBlock(
  {
    id: 'http.check',
    name: 'HTTP Health Check',
    version: '0.1.0',
    description:
      'Probe a URL and return ok/status/latencyMs without throwing on bad status or ' +
      'network errors — safe to use inside retry loops and branching health workflows.',
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: 'string', default: 'GET' },
      { name: 'expectStatus', type: 'number', default: 200 },
      { name: 'timeoutMs', type: 'number', default: 5000 },
      { name: 'headers', type: 'object', default: {} },
    ],
    outputs: [
      { name: 'ok', type: 'boolean' },
      { name: 'status', type: 'number' },
      { name: 'latencyMs', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'error', type: 'string' },
    ],
  },
  async (_ctx, inputs) => {
    const url = String(inputs.url)
    const method = (inputs.method != null ? String(inputs.method) : 'GET').toUpperCase()
    const expectStatus = typeof inputs.expectStatus === 'number' ? inputs.expectStatus : 200
    const timeoutMs = typeof inputs.timeoutMs === 'number' ? inputs.timeoutMs : 5000
    const rawHeaders = (inputs.headers as Record<string, string> | undefined) ?? {}

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const t0 = Date.now()

    try {
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: new Headers(rawHeaders),
          signal: controller.signal,
        })
      } catch (err) {
        const latencyMs = Date.now() - t0
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, status: 0, latencyMs, body: '', error: msg }
      } finally {
        clearTimeout(timer)
      }

      const latencyMs = Date.now() - t0
      const raw = await res.text().catch(() => '')
      const body = raw.length > BODY_TRUNCATE ? raw.slice(0, BODY_TRUNCATE) : raw
      const ok = res.status === expectStatus
      return { ok, status: res.status, latencyMs, body, error: '' }
    } finally {
      clearTimeout(timer)
    }
  },
)
