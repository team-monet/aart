import { nativeBlock } from '../../pack/types'

export const apiRequest = nativeBlock(
  {
    id: 'qa.api.request',
    name: 'API Request',
    version: '0.1.0',
    description: 'Make an HTTP request and return status, ok and parsed body.',
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: 'string' },
      { name: 'headers', type: 'object' },
      { name: 'body', type: 'any' },
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
    const headers: Record<string, string> = { ...(inputs.headers as Record<string, string>) }
    const sendBody = inputs.body !== undefined && method !== 'GET' && method !== 'HEAD'
    if (sendBody && !('content-type' in headers) && !('Content-Type' in headers)) {
      headers['content-type'] = 'application/json'
    }
    const res = await fetch(url, {
      method,
      headers,
      body: sendBody
        ? typeof inputs.body === 'string'
          ? inputs.body
          : JSON.stringify(inputs.body)
        : undefined,
    })
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
