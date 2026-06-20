import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { Runtime } from '../../core/runtime'
import { corePack } from './index'
import type { BlockDefinition } from '../../core/types'

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
  return new Promise((r) => {
    // Node ≥20: closeAllConnections() terminates keep-alive / SSE / long-poll
    // sockets immediately so server.close() completes without hanging.
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
      ;(server as { closeAllConnections: () => void }).closeAllConnections()
    }
    server.close(() => r())
  })
}

/**
 * Run web.read as a single-step workflow.
 *
 * String inputs are passed via workflow-level {{inputs.*}} template substitution.
 * Non-string inputs (numbers, booleans) are embedded as literals in the step
 * inputs map so they arrive at the block with the correct JS type — the same
 * pattern the existing browser.* tests use for maxChars/maxElements.
 */
async function runWebRead(
  dir: string,
  inputs: Record<string, unknown>,
): Promise<{
  status: string
  results: Record<string, unknown> | undefined
  error?: string
  artifacts: Array<{ name: string; path: string; kind: string; mime: string }>
}> {
  // Separate string vs. non-string inputs.
  const stringInputs: Record<string, unknown> = {}
  const literalInputs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string') {
      stringInputs[k] = v
    } else {
      literalInputs[k] = v
    }
  }

  const stepInputs: Record<string, unknown> = {
    ...Object.fromEntries(Object.keys(stringInputs).map((k) => [k, `{{inputs.${k}}}`])),
    ...literalInputs,
  }

  const wf: BlockDefinition = {
    id: 'web-read-test',
    name: 'Web Read Test',
    version: '0.1.0',
    inputs: Object.keys(stringInputs).map((k) => ({ name: k, type: 'string' })),
    outputs: [],
    execution: {
      type: 'workflow',
      steps: [{ id: 'read', block: 'web.read', inputs: stepInputs }],
      outputMapping: {
        url: '$read.url',
        title: '$read.title',
        text: '$read.text',
        truncated: '$read.truncated',
        elements: '$read.elements',
        consoleErrors: '$read.consoleErrors',
        screenshot: '$read.screenshot',
        fullText: '$read.fullText',
        settled: '$read.settled',
        // Only map matched when expect was given — when absent from the block
        // output the resolver throws "Unresolved reference" and fails the run.
        ...(inputs.expect !== undefined ? { matched: '$read.matched' } : {}),
      },
    },
  }
  const record = await new Runtime(dir, [corePack]).run(wf, stringInputs)
  return {
    status: record.status,
    results: record.results as Record<string, unknown> | undefined,
    error: record.error,
    artifacts: record.artifacts as Array<{ name: string; path: string; kind: string; mime: string }>,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('web.read — real Chromium integration', () => {
  const servers: http.Server[] = []
  const dirs: string[] = []

  afterEach(async () => {
    // Close servers and clean dirs created in this test.
    await Promise.all(servers.splice(0).map(stopServer))
    dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }))
  })

  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-web-'))
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

  // ---- 1. Basic static page ------------------------------------------------

  it('reads title, main text, elements, screenshot, fullText from a static page', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>My Page</title></head>
        <body>
          <nav><a href="/about">About</a></nav>
          <main>
            <h1>Welcome to the site</h1>
            <p>This is the main content of the page with enough text to matter.</p>
          </main>
          <footer><p>Footer text — should not dominate in main extraction</p></footer>
          <button id="cta">Get Started</button>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results, artifacts } = await runWebRead(dir, { url })

    expect(status).toBe('COMPLETED')
    expect(results?.title).toBe('My Page')
    expect(results?.url).toBe(url)
    expect(results?.settled).toBe(true)
    expect(results?.truncated).toBe(false)

    // Main content extracted — the heuristic prefers <main> content.
    const text = String(results?.text ?? '')
    expect(text).toContain('Welcome to the site')
    expect(text).toContain('main content')

    // Interactive elements: About link + CTA button.
    const elements = results?.elements as Array<{ role: string; name: string; selector: string; href?: string }>
    expect(Array.isArray(elements)).toBe(true)
    const aboutLink = elements.find((e) => e.name === 'About')
    expect(aboutLink).toBeDefined()
    expect(aboutLink?.role).toBe('link')
    expect(aboutLink?.href).toBe('/about')
    const ctaButton = elements.find((e) => e.selector === '#cta')
    expect(ctaButton).toBeDefined()
    expect(ctaButton?.role).toBe('button')

    // Screenshot artifact on disk.
    const shotArt = artifacts.find((a) => a.name === 'web-read.png')
    expect(shotArt).toBeDefined()
    expect(shotArt?.kind).toBe('screenshot')
    expect(fs.existsSync(shotArt!.path)).toBe(true)
    expect(fs.statSync(shotArt!.path).size).toBeGreaterThan(0)

    // Full-text artifact on disk.
    const textArt = artifacts.find((a) => a.name === 'web-read.txt')
    expect(textArt).toBeDefined()
    expect(textArt?.mime).toBe('text/plain')
    expect(fs.existsSync(textArt!.path)).toBe(true)
    const savedText = fs.readFileSync(textArt!.path, 'utf8')
    expect(savedText).toContain('Welcome to the site')

    // The output screenshot/fullText fields are paths.
    expect(String(results?.screenshot)).toBe(shotArt?.path)
    expect(String(results?.fullText)).toBe(textArt?.path)
  }, 30000)

  // ---- 2. SPA / late-rendered content with waitFor -------------------------

  it('waits for a late-rendered element and captures its content (SPA settle)', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>SPA</title></head>
        <body>
          <div id="app"><p>Loading...</p></div>
          <script>
            setTimeout(function() {
              document.getElementById('app').innerHTML =
                '<main id="late-content"><h1>SPA Content Loaded</h1>' +
                '<p>This paragraph was injected after a delay.</p></main>';
            }, 200);
          </script>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url, waitFor: '#late-content' })

    expect(status).toBe('COMPLETED')
    expect(results?.settled).toBe(true)
    const text = String(results?.text ?? '')
    expect(text).toContain('SPA Content Loaded')
    expect(text).toContain('injected after a delay')
  }, 30000)

  // ---- 3. maxChars clamps inline text but fullText artifact is complete -----

  it('clamps inline text to maxChars while fullText artifact holds the complete text', async () => {
    const longContent = 'A'.repeat(500) + ' ' + 'B'.repeat(500)
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Long</title></head>
        <body><main><p>${longContent}</p></main></body></html>`,
      )
    })

    const dir = tmpDir()
    // maxChars much smaller than content length. Pass as number literal so it
    // arrives at the block as a JS number (same pattern as browser.html maxChars: 10).
    const { status, results, artifacts } = await runWebRead(dir, { url, maxChars: 50 })

    expect(status).toBe('COMPLETED')
    expect(results?.truncated).toBe(true)
    const inlineText = String(results?.text ?? '')
    expect(inlineText.length).toBeLessThanOrEqual(50)

    // Full text artifact is NOT clamped.
    const textArt = artifacts.find((a) => a.name === 'web-read.txt')
    expect(textArt).toBeDefined()
    const saved = fs.readFileSync(textArt!.path, 'utf8')
    expect(saved.length).toBeGreaterThan(50)
    expect(saved).toContain('AAAAAAA')
    expect(saved).toContain('BBBBBBB')
  }, 30000)

  // ---- 4. Console errors captured ------------------------------------------

  it('reports console.error calls in consoleErrors output', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Errors</title></head>
        <body>
          <main><p>Content here</p></main>
          <script>
            console.error('Something went wrong on the page');
            console.error('Another error occurred');
          </script>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url })

    expect(status).toBe('COMPLETED')
    const errs = results?.consoleErrors as { count: number; sample: string[] }
    expect(errs.count).toBeGreaterThanOrEqual(1)
    expect(errs.sample.length).toBeGreaterThanOrEqual(1)
    expect(errs.sample.some((s) => s.includes('Something went wrong'))).toBe(true)
  }, 30000)

  // ---- 5. settled=false when waitFor selector never appears ----------------

  it('degrades gracefully (settled=false) when waitFor selector never appears', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(`<!doctype html><html><head><title>No Wait</title></head>
        <body><main><p>Static page, selector never appears</p></main></body></html>`)
    })

    const dir = tmpDir()
    // The selector will never appear — waitFor should degrade, not throw.
    const { status, results } = await runWebRead(dir, { url, waitFor: '#does-not-exist' })

    expect(status).toBe('COMPLETED')
    expect(results?.settled).toBe(false)
    // Still extracted content despite the miss.
    expect(String(results?.text ?? '')).toContain('Static page')
  }, 30000)

  // ---- 6. focus selector scopes extraction ---------------------------------

  it('scopes text extraction to the focus selector when provided', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Focus</title></head>
        <body>
          <header>HEADER TEXT</header>
          <article id="story">
            <h2>Article Headline</h2>
            <p>Article body goes here and is the only thing we want.</p>
          </article>
          <footer>FOOTER TEXT</footer>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url, focus: '#story' })

    expect(status).toBe('COMPLETED')
    const text = String(results?.text ?? '')
    expect(text).toContain('Article Headline')
    expect(text).toContain('Article body')
    // Header/footer should NOT appear — focus confined the extraction.
    expect(text).not.toContain('HEADER TEXT')
    expect(text).not.toContain('FOOTER TEXT')
  }, 30000)

  // ---- 7. expect: nav text with large <main> → matched:true (core regression) ----

  it('matched:true for nav text outside <main> even when <main> is non-trivial', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Nav Test</title></head>
        <body>
          <nav><button>Packages</button></nav>
          <main><p>${'x '.repeat(200)}</p></main>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url, expect: 'Packages' })

    expect(status).toBe('COMPLETED')
    expect(results?.matched).toBe(true)
    // Prove it matched the full page, not compact text — 'Packages' is not in
    // the main-content heuristic output (the <main> is 400+ chars, so the
    // heuristic picks <main> and excludes nav).
    expect(String(results?.text ?? '')).not.toContain('Packages')
  }, 30000)

  // ---- 8. expect: text beyond maxChars clamp → matched:true -----------------

  it('matched:true for token beyond maxChars clamp', async () => {
    // Place a unique token after enough leading content to be cut by default maxChars (2000).
    const leadingContent = 'A '.repeat(1100) // ~2200 chars — exceeds default 2000
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Clamp Test</title></head>
        <body><main><p>${leadingContent}</p><p>NEEDLE9f3a</p></main></body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url, expect: 'NEEDLE9f3a' })

    expect(status).toBe('COMPLETED')
    expect(results?.matched).toBe(true)
    // The inline text is truncated before the needle.
    expect(results?.truncated).toBe(true)
    expect(String(results?.text ?? '')).not.toContain('NEEDLE9f3a')
  }, 30000)

  // ---- 9. expect: absent text → matched:false --------------------------------

  it('matched:false when the expected phrase is not on the page', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Absent</title></head>
        <body><main><p>Nothing special here.</p></main></body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url, expect: 'DEFINITELY_NOT_PRESENT_xyz' })

    expect(status).toBe('COMPLETED')
    expect(results?.matched).toBe(false)
  }, 30000)

  // ---- 10. expect: focus scoping — inside/outside -------------------------

  it('matched respects focus scope: outside=false, inside=true', async () => {
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

    const dir = tmpDir()

    // OUTSIDEWORD is outside the focus region → matched:false
    const { status: s1, results: r1 } = await runWebRead(dir, {
      url,
      focus: '#s',
      expect: 'OUTSIDEWORD',
    })
    expect(s1).toBe('COMPLETED')
    expect(r1?.matched).toBe(false)

    // INSIDEWORD is inside the focus region → matched:true
    const { status: s2, results: r2 } = await runWebRead(tmpDir(), {
      url,
      focus: '#s',
      expect: 'INSIDEWORD',
    })
    expect(s2).toBe('COMPLETED')
    expect(r2?.matched).toBe(true)
  }, 30000)

  // ---- 11. no expect → matched absent ----------------------------------------

  it('matched is absent when expect is not provided', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>No Expect</title></head>
        <body><main><p>Just reading.</p></main></body></html>`,
      )
    })

    const dir = tmpDir()
    const { status, results } = await runWebRead(dir, { url })

    expect(status).toBe('COMPLETED')
    // matched should be absent (undefined) — it is only set when expect is given
    expect(results?.matched).toBeUndefined()
  }, 30000)

  // ---- 12. Persistent-connection page still reads (Fix 2) -------------------

  it('reads a page that keeps a connection open (SSE / long-poll) without timing out', async () => {
    // Serve a page with real content AND a script that opens a never-resolving
    // fetch — simulating SSE / analytics that prevent networkidle forever.
    const url = await serve((req, res) => {
      if (req.url === '/hang') {
        // Never respond — simulate a long-poll that never closes.
        res.writeHead(200, { 'content-type': 'text/plain' })
        // Don't call res.end() — intentionally hang.
        return
      }
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Persistent Conn</title></head>
        <body>
          <main><h1>PERSISTENT_PAGE_CONTENT</h1><p>This page has a hanging request.</p></main>
          <script>fetch('/hang').catch(function() {})</script>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    const start = Date.now()
    const { status, results } = await runWebRead(dir, { url })
    const elapsed = Date.now() - start

    expect(status).toBe('COMPLETED')
    expect(String(results?.text ?? '')).toContain('PERSISTENT_PAGE_CONTENT')
    // Must complete well under the old 30s networkidle timeout.
    expect(elapsed).toBeLessThan(15000)
  }, 25000)

  // ---- 13. Console scoping: step 2 must not inherit step 1's errors (Fix 1) --

  it('consoleErrors only reflects errors from the current navigation, not prior steps', async () => {
    // Step 1: a page that emits console.error
    const errorUrl = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Error Page</title></head>
        <body>
          <main><p>Page with errors</p></main>
          <script>console.error('STEP1_ERROR')</script>
        </body></html>`,
      )
    })
    // Step 2: a clean page with no errors
    const cleanUrl = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Clean Page</title></head>
        <body><main><p>Clean page, no errors here</p></main></body></html>`,
      )
    })

    const dir = tmpDir()

    // Two-step workflow sharing the same browser capability.
    const wf: BlockDefinition = {
      id: 'console-scope-test',
      name: 'Console Scope Test',
      version: '0.1.0',
      inputs: [
        { name: 'errorUrl', type: 'string' },
        { name: 'cleanUrl', type: 'string' },
      ],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'step1',
            block: 'web.read',
            inputs: { url: '{{inputs.errorUrl}}' },
          },
          {
            id: 'step2',
            block: 'web.read',
            inputs: { url: '{{inputs.cleanUrl}}' },
          },
        ],
        outputMapping: {
          step1Errors: '$step1.consoleErrors',
          step2Errors: '$step2.consoleErrors',
        },
      },
    }

    const record = await new Runtime(dir, [corePack]).run(wf, { errorUrl, cleanUrl })
    expect(record.status).toBe('COMPLETED')

    const results = record.results as Record<string, unknown>
    const step1Errors = results.step1Errors as { count: number; sample: string[] }
    const step2Errors = results.step2Errors as { count: number; sample: string[] }

    // Step 1 should have caught the error.
    expect(step1Errors.count).toBeGreaterThanOrEqual(1)
    expect(step1Errors.sample.some((s) => s.includes('STEP1_ERROR'))).toBe(true)

    // Step 2 must NOT inherit step 1's error — the clean page has zero errors.
    expect(step2Errors.count).toBe(0)
  }, 60000)

  // ---- 14. screenshot:false skips the artifact and omits the output field ----

  it('screenshot:false produces no web-read.png artifact and no screenshot output', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>No Shot</title></head>
        <body><main><p>Sensitive page — no screenshot wanted</p></main></body></html>`,
      )
    })

    const dir = tmpDir()

    // Build a workflow that does NOT map screenshot in outputMapping (it won't be
    // present in block output when screenshot:false), mirroring how matched is handled.
    const wf: BlockDefinition = {
      id: 'no-screenshot-test',
      name: 'No Screenshot Test',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'read',
            block: 'web.read',
            inputs: { url: '{{inputs.url}}', screenshot: false },
          },
        ],
        outputMapping: {
          text: '$read.text',
          fullText: '$read.fullText',
        },
      },
    }

    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')

    // No screenshot artifact attached.
    const artifacts = record.artifacts as Array<{ name: string }>
    expect(artifacts.find((a) => a.name === 'web-read.png')).toBeUndefined()

    // Full-text artifact still present.
    const textArt = artifacts.find((a) => a.name === 'web-read.txt')
    expect(textArt).toBeDefined()
  }, 30000)

  // ---- 15. mask:['#secret'] completes and attaches screenshot ----------------

  it('mask selectors: web.read still completes and attaches screenshot', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Masked</title></head>
        <body>
          <main><p>Public content</p></main>
          <div id="secret">super-secret-token-12345</div>
        </body></html>`,
      )
    })

    const dir = tmpDir()
    // Pass mask as a literal array (non-string) — same pattern as maxChars: 50.
    const wf: BlockDefinition = {
      id: 'mask-test',
      name: 'Mask Test',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'read',
            block: 'web.read',
            inputs: { url: '{{inputs.url}}', mask: ['#secret'] },
          },
        ],
        outputMapping: {
          screenshot: '$read.screenshot',
          text: '$read.text',
        },
      },
    }

    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')

    // Screenshot artifact is attached (we can't inspect pixels, but it must exist).
    const artifacts = record.artifacts as Array<{ name: string; path: string; kind: string }>
    const shotArt = artifacts.find((a) => a.name === 'web-read.png')
    expect(shotArt).toBeDefined()
    expect(shotArt?.kind).toBe('screenshot')
    expect(fs.existsSync(shotArt!.path)).toBe(true)
    expect(fs.statSync(shotArt!.path).size).toBeGreaterThan(0)
  }, 30000)

  // ---- 17. consoleErrors count survives buffer eviction (Fix 1 regression test) --
  //
  // The prior index-based approach (consoleStart = cap.consoleLog.length; slice(consoleStart))
  // silently broke when cappedPush evicted entries from the front of the shared buffer:
  // after N evictions every index slid down by N, so slice(consoleStart) returned []
  // and reported 0 errors even on a page with real errors.
  //
  // This test proves the entry-set-diff approach is correct:
  //   step 1 saturates the 500-entry buffer (≥ 520 console.errors → forces evictions)
  //   step 2 visits a page with exactly 3 console.errors
  //   the assertion is step2.consoleErrors.count === 3 (not 0)

  it('consoleErrors count is exact even after the shared buffer is evicted past its cap', async () => {
    // Step 1: emit 520 console.errors to overflow the 500-entry BUFFER_CAP and force evictions.
    const floodUrl = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Flood</title></head>
        <body>
          <main><p>Flood page</p></main>
          <script>for (var i = 0; i < 520; i++) console.error('fill' + i)</script>
        </body></html>`,
      )
    })

    // Step 2: a page with exactly 3 console.errors.
    const threeErrorUrl = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Three Errors</title></head>
        <body>
          <main><p>Three errors page</p></main>
          <script>
            console.error('ERR_EVICTION_A');
            console.error('ERR_EVICTION_B');
            console.error('ERR_EVICTION_C');
          </script>
        </body></html>`,
      )
    })

    const dir = tmpDir()

    const wf: BlockDefinition = {
      id: 'eviction-test',
      name: 'Eviction Test',
      version: '0.1.0',
      inputs: [
        { name: 'floodUrl', type: 'string' },
        { name: 'threeErrorUrl', type: 'string' },
      ],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'step1',
            block: 'web.read',
            inputs: { url: '{{inputs.floodUrl}}' },
          },
          {
            id: 'step2',
            block: 'web.read',
            inputs: { url: '{{inputs.threeErrorUrl}}' },
          },
        ],
        outputMapping: {
          step1Count: '$step1.consoleErrors',
          step2Errors: '$step2.consoleErrors',
        },
      },
    }

    const record = await new Runtime(dir, [corePack]).run(wf, { floodUrl, threeErrorUrl })
    expect(record.status).toBe('COMPLETED')

    const results = record.results as Record<string, unknown>
    const step2Errors = results.step2Errors as { count: number; sample: string[] }

    // With the old index approach this would be 0 (all entries evicted past the index).
    // With the entry-set-diff it must be exactly 3.
    expect(step2Errors.count).toBe(3)
    expect(step2Errors.sample).toContain('ERR_EVICTION_A')
    expect(step2Errors.sample).toContain('ERR_EVICTION_B')
    expect(step2Errors.sample).toContain('ERR_EVICTION_C')
  }, 90000)

  // ---- 16. Focus-miss is not a match (Fix 3) ---------------------------------

  it('matched:false when focus selector is absent from the page', async () => {
    const url = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<!doctype html><html><head><title>Focus Miss</title></head>
        <body>
          <nav>OUTSIDEWORD</nav>
          <article id="present"><p>hi</p></article>
        </body></html>`,
      )
    })

    const dir = tmpDir()

    // Focus selector is absent; OUTSIDEWORD is present elsewhere — must NOT match.
    const { status: s1, results: r1 } = await runWebRead(dir, {
      url,
      focus: '#missing',
      expect: 'OUTSIDEWORD',
    })
    expect(s1).toBe('COMPLETED')
    expect(r1?.matched).toBe(false)
    // settled is unaffected by a focus-miss (no waitFor was passed — page is static)
    expect(r1?.settled).toBe(true)

    // Guard: focus selector IS present and word is inside it → matched:true.
    const { status: s2, results: r2 } = await runWebRead(tmpDir(), {
      url,
      focus: '#present',
      expect: 'hi',
    })
    expect(s2).toBe('COMPLETED')
    expect(r2?.matched).toBe(true)
  }, 30000)
})
