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
  return new Promise((r) => server.close(() => r()))
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
})
