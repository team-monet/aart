import { nativeBlock } from '../../pack/types'

const MAX_DOWNLOAD_BYTES = 25_000_000

export const httpDownload = nativeBlock(
  {
    id: 'http.download',
    name: 'HTTP Download',
    version: '0.1.0',
    description:
      'Download a URL (binary-safe) and attach it as a named run artifact — a PDF, ' +
      'image, archive, dataset. Fails on non-2xx. `maxBytes` caps the size ' +
      `(default ${MAX_DOWNLOAD_BYTES}).`,
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'headers', type: 'object' },
      { name: 'maxBytes', type: 'number' },
      { name: 'timeoutMs', type: 'number' },
    ],
    outputs: [
      { name: 'artifact', type: 'string' },
      { name: 'bytes', type: 'number' },
      { name: 'status', type: 'number' },
    ],
  },
  async (ctx, inputs) => {
    const url = String(inputs.url)
    const timeoutMs = typeof inputs.timeoutMs === 'number' ? inputs.timeoutMs : 60_000
    const maxBytes =
      typeof inputs.maxBytes === 'number' && inputs.maxBytes > 0 ? inputs.maxBytes : MAX_DOWNLOAD_BYTES
    let res: Response
    try {
      res = await fetch(url, {
        headers: new Headers((inputs.headers as Record<string, string> | undefined) ?? undefined),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`download of ${url} timed out after ${timeoutMs}ms`)
      }
      throw err
    }
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > maxBytes) {
      throw new Error(`download too large: ${declared} bytes > maxBytes ${maxBytes}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      throw new Error(`download too large: ${buf.byteLength} bytes > maxBytes ${maxBytes}`)
    }
    const artifact = ctx.artifacts.attach(String(inputs.name), buf)
    return { artifact, bytes: buf.byteLength, status: res.status }
  },
)

export const apiRequest = nativeBlock(
  {
    id: 'http.request',
    name: 'HTTP Request',
    version: '0.1.0',
    description: 'Make an HTTP request and return status, ok and parsed body.',
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: 'string' },
      { name: 'headers', type: 'object' },
      { name: 'body', type: 'any' },
      { name: 'timeoutMs', type: 'number' },
    ],
    outputs: [
      { name: 'status', type: 'number' },
      { name: 'ok', type: 'boolean' },
      { name: 'body', type: 'any' },
    ],
  },
  async (_ctx, inputs) => {
    const url = String(inputs.url)
    const method = (inputs.method ? String(inputs.method) : 'GET').toUpperCase()
    // WHATWG Headers handles case-insensitive names and de-duplication.
    const headers = new Headers((inputs.headers as Record<string, string> | undefined) ?? undefined)
    const sendBody = inputs.body !== undefined && method !== 'GET' && method !== 'HEAD'
    if (sendBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const timeoutMs = typeof inputs.timeoutMs === 'number' ? inputs.timeoutMs : 30_000
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: sendBody
          ? typeof inputs.body === 'string'
            ? inputs.body
            : JSON.stringify(inputs.body)
          : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`)
      }
      throw err
    }
    const raw = await res.text()
    let body: unknown = raw
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        body = JSON.parse(raw)
      } catch {
        // keep raw text
      }
    }
    return { status: res.status, ok: res.ok, body }
  },
)
