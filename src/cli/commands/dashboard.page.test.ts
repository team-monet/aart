/**
 * Client-side page tests for the aart dashboard.
 *
 * These tests mount the full inline HTML+JS page in jsdom (runScripts:
 * 'dangerously') so the inline <script> block executes in the same VM context,
 * letting us call page functions (setTab, showBlock, …) and assert on the live
 * DOM without spinning up an HTTP server.
 *
 * happy-dom was attempted first (per project ethos) but its script sandbox
 * isolates each <script> block into its own scope, making const/let/function
 * declarations from the page script inaccessible from injected scripts or from
 * the outer test context — even with enableJavaScriptEvaluation=true. jsdom's
 * 'dangerously' mode shares a single VM context across all scripts, which is
 * what these tests require.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { PAGE } from './dashboard'

// ---------------------------------------------------------------------------
// Mount helper
// ---------------------------------------------------------------------------

interface RunRecord {
  runId: string
  blockId: string
  status: string
  approved?: boolean
  startedAt?: string
  endedAt?: string
}

interface FieldDef {
  name: string
  type?: string
  required?: boolean
  enum?: string[]
  pattern?: string
  description?: string
}

interface BlockRecord {
  id: string
  version?: string
  type: string
  status: string
  name?: string
  description?: string
  capabilities?: string[]
  dependencies?: string[]
  inputs: FieldDef[]
  outputs: FieldDef[]
}

interface Fixtures {
  overview?: { workspace: string; initialized: boolean }
  runs?: RunRecord[]
  blocks?: BlockRecord[]
  packs?: object[]
  run?: object
}

interface MountResult {
  /** The jsdom window — use to call page globals like setTab, showBlock, render */
  win: Window & typeof globalThis & Record<string, unknown>
  doc: Document
  /** Close the window and clean up */
  close: () => void
  /** Flush the microtask / timer queue */
  flush: (ticks?: number) => Promise<void>
}

function mount(fixtures: Fixtures = {}): MountResult {
  const ov = fixtures.overview ?? { workspace: '/test/ws', initialized: true }
  const runs = fixtures.runs ?? []
  const blocks = fixtures.blocks ?? []
  const packs = fixtures.packs ?? []
  const run = fixtures.run ?? {}

  const dom = new JSDOM(PAGE, {
    runScripts: 'dangerously',
    url: 'http://localhost',
    beforeParse(window: Window & typeof globalThis) {
      // Disable the 5-second auto-refresh timer so tests exit cleanly.
      ;(window as Record<string, unknown>).setInterval = () => 0
      // happy-dom stub not needed here but jsdom also lacks this.
      window.HTMLElement.prototype.scrollIntoView = () => {}
      // Stub fetch: route by URL fragment.
      ;(window as Record<string, unknown>).fetch = (url: unknown) => {
        const u = String(url)
        const body =
          u.includes('/api/overview') ? ov
          : u.includes('/api/run?') ? run
          : u.includes('/api/runs') ? runs
          : u.includes('/api/blocks') ? blocks
          : u.includes('/api/packs') ? packs
          : {}
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        })
      }
    },
  })

  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>
  const doc = dom.window.document

  async function flush(ticks = 5) {
    for (let i = 0; i < ticks; i++) await new Promise<void>((r) => setTimeout(r, 20))
  }

  return { win, doc, close: () => dom.window.close(), flush }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const openMounts: MountResult[] = []
afterEach(() => {
  while (openMounts.length) openMounts.pop()!.close()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard page — client-side JavaScript', () => {
  /**
   * Test 1 (HIGH bug pin): a partial/hand-edited run.json that lacks startedAt
   * and endedAt must degrade gracefully — both rows render, no "NaN" appears,
   * and no error panel is shown.  This pins the bug caught by manual review
   * that CI could not see.
   */
  it('partial run record degrades without collapsing the runs tab', async () => {
    const m = mount({
      runs: [
        {
          runId: 'run-complete-001',
          blockId: 'echo.block',
          status: 'COMPLETED',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: '2024-01-01T00:00:05Z',
        },
        {
          // Deliberately omit startedAt and endedAt — simulates a partial record.
          runId: 'run-partial-002',
          blockId: 'broken.block',
          status: 'RUNNING',
        },
      ],
    })
    openMounts.push(m)
    await m.flush()

    const rows = m.doc.querySelectorAll('#tbl-runs tr.row')
    expect(rows).toHaveLength(2)

    const content = m.doc.getElementById('content')!
    expect(content.innerHTML).toContain('broken.block')
    expect(content.innerHTML).not.toContain('NaN')
    // No error panel (class "empty err") should have been rendered.
    expect(m.doc.querySelector('#content .empty.err')).toBeNull()
  })

  /**
   * Test 2: a run whose endedAt is present but startedAt is missing/garbage
   * must not produce a "NaN ms" duration cell.
   */
  it('unparseable startedAt timestamp produces no NaN in duration cell', async () => {
    const m = mount({
      runs: [
        {
          runId: 'run-badstart-001',
          blockId: 'timing.block',
          status: 'COMPLETED',
          startedAt: 'not-a-date',
          endedAt: '2024-06-01T12:00:05Z',
        },
      ],
    })
    openMounts.push(m)
    await m.flush()

    const content = m.doc.getElementById('content')!
    expect(content.innerHTML).not.toContain('NaN')

    // The duration cell for this row must be empty (no finite ms value possible).
    const rows = m.doc.querySelectorAll('#tbl-runs tr.row')
    expect(rows).toHaveLength(1)
    // The 4th <td> is the duration cell.
    const cells = rows[0].querySelectorAll('td')
    expect(cells[3].textContent).toBe('')
  })

  /**
   * Test 3: XSS in block description and field pattern is neutralised.
   * The table row AND the detail panel must escape the payload — no live
   * <img> element must appear in the DOM.
   */
  it('XSS in block description and field pattern is escaped in table and detail', async () => {
    const xss = '<img src=x onerror="alert(1)">'
    const xssWithQuote = `${xss}'`

    const m = mount({
      blocks: [
        {
          id: 'xss.test.block',
          type: 'native',
          status: 'active',
          name: xssWithQuote,
          description: xssWithQuote,
          capabilities: [],
          dependencies: [],
          inputs: [{ name: 'q', type: 'string', required: true, pattern: xssWithQuote }],
          outputs: [],
        },
      ],
    })
    openMounts.push(m)
    await m.flush()

    // Switch to the Blocks tab and let it render.
    await (m.win.setTab as (t: string) => Promise<void>)('blocks')
    await m.flush()

    const content = m.doc.getElementById('content')!
    // No live <img> element injected from data.
    expect(content.querySelector('img')).toBeNull()
    // The escaped form must be present.
    expect(content.innerHTML).toContain('&lt;img')

    // Open the block detail panel.
    ;(m.win.showBlock as (i: number) => void)(0)
    await m.flush(2)

    const detail = m.doc.getElementById('detail')!
    expect(detail.querySelector('img')).toBeNull()
    expect(detail.innerHTML).toContain('&lt;img')
  })

  /**
   * Test 4: an unknown run status must not throw and the row must still render.
   * The status summary only tallies known statuses but must not crash on extras.
   */
  it('unknown run status renders without throwing', async () => {
    const m = mount({
      runs: [
        {
          runId: 'run-weird-001',
          blockId: 'some.block',
          status: 'WEIRD',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: '2024-01-01T00:00:01Z',
        },
      ],
    })
    openMounts.push(m)

    // mount itself must not reject
    await expect(m.flush()).resolves.toBeUndefined()

    const rows = m.doc.querySelectorAll('#tbl-runs tr.row')
    expect(rows).toHaveLength(1)

    // The status pill text is present.
    expect(m.doc.getElementById('content')!.innerHTML).toContain('WEIRD')

    // No error panel.
    expect(m.doc.querySelector('#content .empty.err')).toBeNull()
  })

  /**
   * Test 5: filtering the Blocks table hides non-matching rows but the baked-in
   * index passed to showBlock must still resolve to the correct block even after
   * some rows are hidden.
   */
  it('block detail index stays valid after client-side filter hides rows', async () => {
    const allBlocks: BlockRecord[] = [
      {
        id: 'text.process',
        type: 'native',
        status: 'active',
        name: 'Text Process',
        capabilities: ['text'],
        dependencies: [],
        inputs: [{ name: 'input', type: 'string', required: true }],
        outputs: [{ name: 'output', type: 'string' }],
      },
      {
        id: 'browser.goto',
        type: 'native',
        status: 'active',
        name: 'Browser Goto',
        description: 'Navigates the browser',
        capabilities: ['browser'],
        dependencies: [],
        inputs: [{ name: 'url', type: 'string', required: true }],
        outputs: [],
      },
      {
        id: 'file.read',
        type: 'native',
        status: 'active',
        name: 'File Read',
        capabilities: ['file'],
        dependencies: [],
        inputs: [{ name: 'path', type: 'string', required: true }],
        outputs: [{ name: 'content', type: 'string' }],
      },
    ]

    const m = mount({ blocks: allBlocks })
    openMounts.push(m)
    await m.flush()

    // Navigate to Blocks tab.
    await (m.win.setTab as (t: string) => Promise<void>)('blocks')
    await m.flush()

    const allRows = m.doc.querySelectorAll('#tbl-blocks tr.frow')
    expect(allRows).toHaveLength(3)

    // Apply the filter — simulate typing in the filter input.
    const filterInput = m.doc.querySelector('#filter-blocks') as HTMLInputElement
    filterInput.value = 'browser'
    filterInput.dispatchEvent(new m.win.Event('input'))
    await m.flush(2)

    // Non-matching rows must be hidden.
    const hidden = Array.from(allRows).filter((r) => (r as HTMLElement).style.display === 'none')
    const visible = Array.from(allRows).filter((r) => (r as HTMLElement).style.display !== 'none')
    expect(hidden).toHaveLength(2)
    expect(visible).toHaveLength(1)
    expect(visible[0].textContent).toContain('browser.goto')

    // showBlock with the original cache index (1) must show browser.goto in the
    // detail panel — proving the index still maps correctly despite hidden rows.
    ;(m.win.showBlock as (i: number) => void)(1)
    await m.flush(2)

    const detail = m.doc.getElementById('detail')!
    expect(detail.hidden).toBe(false)
    expect(detail.innerHTML).toContain('browser.goto')
  })
})
