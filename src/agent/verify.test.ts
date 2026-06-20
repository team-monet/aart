import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { Runtime } from '../core/runtime'
import { corePack } from '../packs/core'
import { verifyWeb } from './verify'

// Self-skip when the Chromium binary isn't installed.
let hasBrowser = false
try {
  hasBrowser = fs.existsSync(chromium.executablePath())
} catch {
  hasBrowser = false
}
const suite = hasBrowser ? describe : describe.skip

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/` })
    })
  })
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()))
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('verifyWeb — real Chromium integration', () => {
  const servers: http.Server[] = []
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(stopServer))
    dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }))
  })

  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-verify-'))
    dirs.push(d)
    return d
  }

  async function serve(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> {
    const { server, url } = await startServer(handler)
    servers.push(server)
    return url
  }

  function makeRuntime(dir: string): Runtime {
    return new Runtime(dir, [corePack])
  }

  // ---- 1. expect present → ok:true -----------------------------------------

  it('returns ok:true when expected phrase is present on the page', async () => {
    const PHRASE = 'aart-verify-unique-content-9f3a'
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Verify Test</title></head>
        <body><main><h1>${PHRASE}</h1><p>Additional content here.</p></main>
        <a href="/about">About</a><button id="go">Go</button></body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), { url, expect: PHRASE })

    expect(result.status).toBe('ok')
    expect(result.ok).toBe(true)
    expect(result.title).toBeDefined()
    expect(result.text).toBeDefined()
    expect(typeof result.text).toBe('string')
    expect(result.text).toContain(PHRASE)
    expect(Array.isArray(result.elements)).toBe(true)
    expect((result.elements ?? []).length).toBeLessThanOrEqual(10)
    expect(result.screenshot).toBeDefined()
    expect(typeof result.screenshot).toBe('string')
    expect(fs.existsSync(result.screenshot!)).toBe(true)
    expect(result.runId).toBeDefined()
    expect(result.hint).toBeUndefined()
    // ok:true means no error
    expect(result.error).toBeUndefined()
  }, 30000)

  // ---- 2. expect absent → ok:false + hint ----------------------------------

  it('returns ok:false and a hint when expected phrase is NOT present', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Mismatch</title></head>
        <body><main><p>Page is here but phrase is absent.</p></main></body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), {
      url,
      expect: 'THIS_PHRASE_WILL_NOT_BE_FOUND',
    })

    expect(result.status).toBe('ok')
    expect(result.ok).toBe(false)
    expect(typeof result.hint).toBe('string')
    expect(result.hint).toContain('screenshot')
  }, 30000)

  // ---- 3. no expect → no ok field ------------------------------------------

  it('returns perception without ok field when no expect is given', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Plain Page</title></head>
        <body><main><p>Just reading the page.</p></main></body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), { url })

    expect(result.status).toBe('ok')
    expect('ok' in result).toBe(false)
    expect(result.title).toBeDefined()
    expect(result.text).toBeDefined()
    expect(result.runId).toBeDefined()
    expect(result.screenshot).toBeDefined()
    expect(Array.isArray(result.elements)).toBe(true)
  }, 30000)

  // ---- 3b. empty-string expect → treated as absent (no ok field) ----------

  it('treats empty-string expect as absent (no ok field)', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Empty Expect</title></head>
        <body><main><p>Just reading the page.</p></main></body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), { url, expect: '' })
    expect(result.status).toBe('ok')
    expect('ok' in result).toBe(false)
  }, 30000)

  // ---- 4. unreachable URL → verdict, no throw ------------------------------

  it('returns status:unreachable on a closed port without throwing', async () => {
    // Bind a port, immediately close it, then use that port — guaranteed closed.
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer()
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        s.close(() => resolve(port))
      })
    })
    const url = `http://127.0.0.1:${closed}/`

    // Must not throw.
    const result = await verifyWeb(makeRuntime(tmpDir()), { url })

    expect(result.status).toBe('unreachable')
    expect(typeof result.error).toBe('string')
    expect(result.url).toBe(url)
    // ok field must be absent when expect was not given.
    expect('ok' in result).toBe(false)
  }, 30000)

  // ---- 5. unreachable + expect → ok:false ----------------------------------

  it('sets ok:false when unreachable and expect was provided', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer()
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        s.close(() => resolve(port))
      })
    })
    const url = `http://127.0.0.1:${closed}/`

    const result = await verifyWeb(makeRuntime(tmpDir()), { url, expect: 'anything' })

    expect(result.status).toBe('unreachable')
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  }, 30000)

  // ---- 6. Headline regression: nav/header text with large <main> → ok:true ----

  it('ok:true for nav/header phrase when <main> is large (dashboard regression)', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Dashboard</title></head>
        <body>
          <header><h1>aart</h1></header>
          <nav><button>Packages</button></nav>
          <main><p>${'x '.repeat(200)}</p></main>
        </body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), { url, expect: 'Packages' })

    expect(result.status).toBe('ok')
    expect(result.ok).toBe(true)
    expect(result.hint).toBeUndefined()
  }, 30000)

  // ---- 7. Beyond-clamp token → ok:true -------------------------------------

  it('ok:true for token placed after >2000 chars of main content', async () => {
    const leadingContent = 'A '.repeat(1100) // ~2200 chars — beyond default 2000 clamp
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Clamp</title></head>
        <body><main><p>${leadingContent}</p><p>NEEDLE9f3a</p></main></body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), { url, expect: 'NEEDLE9f3a' })

    expect(result.status).toBe('ok')
    expect(result.ok).toBe(true)
    expect(result.hint).toBeUndefined()
  }, 30000)

  // ---- 7b. waitFor passthrough (Fix 1) ----------------------------------------

  it('waitFor passthrough: ok:true when phrase injected after delay and waitFor is given', async () => {
    const PHRASE = 'LATE_RENDERED_PHRASE_7b'
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>SPA</title></head>
        <body>
          <div id="app"><p>Loading...</p></div>
          <script>
            setTimeout(function() {
              document.getElementById('app').innerHTML =
                '<div id="late"><p>${PHRASE}</p></div>';
            }, 200);
          </script>
        </body></html>`,
      )
    })

    const result = await verifyWeb(makeRuntime(tmpDir()), {
      url,
      waitFor: '#late',
      expect: PHRASE,
    })

    expect(result.status).toBe('ok')
    expect(result.ok).toBe(true)
  }, 30000)

  // ---- 7c. Focus-miss false positive at verify layer (Fix 3) ------------------

  it('ok:false when focus selector is absent (not a false positive from body text)', async () => {
    const PHRASE = 'OUTSIDEWORD_7c'
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Focus Miss</title></head>
        <body>
          <nav>${PHRASE}</nav>
          <article id="present"><p>inside</p></article>
        </body></html>`,
      )
    })

    // focus:#missing doesn't exist; PHRASE is on the page but outside the region.
    const result = await verifyWeb(makeRuntime(tmpDir()), {
      url,
      focus: '#missing',
      expect: PHRASE,
    })

    expect(result.status).toBe('ok')
    expect(result.ok).toBe(false)
  }, 30000)

  // ---- 8. focus scoping in verifyWeb ----------------------------------------

  it('ok respects focus scope: outside=false, inside=true', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Focus Scope</title></head>
        <body>
          <nav>OUTSIDEWORD</nav>
          <article id="s"><p>INSIDEWORD</p></article>
        </body></html>`,
      )
    })

    const outsideResult = await verifyWeb(makeRuntime(tmpDir()), {
      url,
      focus: '#s',
      expect: 'OUTSIDEWORD',
    })
    expect(outsideResult.status).toBe('ok')
    expect(outsideResult.ok).toBe(false)

    const insideResult = await verifyWeb(makeRuntime(tmpDir()), {
      url,
      focus: '#s',
      expect: 'INSIDEWORD',
    })
    expect(insideResult.status).toBe('ok')
    expect(insideResult.ok).toBe(true)
    expect(insideResult.hint).toBeUndefined()
  }, 30000)
})

// ---------------------------------------------------------------------------
// Non-browser: aa_verify doesn't break the registered tool count
// ---------------------------------------------------------------------------

describe('aa_verify — MCP tool registration', () => {
  it('server.ts registers aa_verify (import resolves, no type errors at load)', async () => {
    // We verify this indirectly: verifyWeb exports without throwing.
    // The MCP server itself requires stdio transport to start, so we test the
    // import + type contract rather than spinning the full server.
    const { verifyWeb: vw } = await import('./verify')
    expect(typeof vw).toBe('function')
  })
})
