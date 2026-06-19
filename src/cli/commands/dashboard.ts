import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { buildCatalog } from '../../agent/catalog'
import { listRuns, readRun, runDir } from '../../core/report'
import { hashPackDir, readPackManifest } from '../../pack/loader'
import { builtinPacks } from '../../packs'
import { openRuntime, resolveWorkspace, workspaceSourceLabel } from '../workspace'

/**
 * `aart dashboard` — a local, READ-ONLY view of the workspace: block catalog,
 * run history (step traces, outputs, errors), artifacts (screenshots render
 * inline), and pack status. Deliberately minimal:
 *  - binds 127.0.0.1 only — it is a local viewer, never a remote surface;
 *  - GET only — approval and registration stay in the governed MCP/CLI flows;
 *  - zero dependencies, no build step — one HTML page, vanilla JS, JSON APIs.
 */

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/

export function startDashboard(ws: string, port: number): Promise<http.Server> {
  // Whether this was already an aart workspace BEFORE we touch it. openRuntime
  // (next line) eagerly creates .aa/registry, so we must snapshot first — this
  // is what lets the empty state tell a wrong-directory launch from a real
  // workspace that simply has no runs yet (e.g. blocks registered, none run).
  const aa = path.join(ws, '.aa')
  const wasWorkspace = fs.existsSync(aa) && fs.statSync(aa).isDirectory()
  const runtime = openRuntime(ws)

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: string | Buffer, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    try {
      if (req.method !== 'GET') return send(405, JSON.stringify({ error: 'read-only' }))
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8')
      if (url.pathname === '/api/overview') {
        return send(200, JSON.stringify({ workspace: ws, initialized: wasWorkspace }))
      }
      if (url.pathname === '/api/blocks') {
        return send(200, JSON.stringify(buildCatalog(runtime.registry)))
      }
      if (url.pathname === '/api/runs') {
        return send(200, JSON.stringify(await listRuns(ws, 100)))
      }
      if (url.pathname === '/api/run') {
        const id = url.searchParams.get('id') ?? ''
        if (!RUN_ID.test(id)) return send(400, JSON.stringify({ error: 'bad run id' }))
        try {
          const record = await readRun(ws, id)
          // Ship artifact basenames so the page can link them through /artifact.
          const artifacts = record.artifacts.map((a) =>
            typeof a === 'string' ? path.basename(a) : a.name,
          )
          return send(200, JSON.stringify({ ...record, artifacts }))
        } catch {
          return send(404, JSON.stringify({ error: 'run not found' }))
        }
      }
      if (url.pathname === '/api/packs') {
        // Built-in packs ship with the runtime and are always loaded — surface
        // them so the catalog's `native` blocks have a visible home (the "core"
        // pack, formerly "qa"). Workspace packs (.aa/packs.json) follow, with
        // their draft/approved/changed/missing seal status.
        const builtin = builtinPacks.map((p) => ({
          name: p.name,
          kind: 'built-in',
          status: 'native',
          blocks: p.blocks.length,
          commands: (p.commands ?? []).length,
          workflows: (p.workflows ?? []).length,
          capabilities: p.capabilities.map((c) => c.name),
          aliases: Object.keys(p.aliases ?? {}),
        }))
        const manifest = readPackManifest(ws)
        const workspacePacks = Object.entries(manifest.packs).map(([name, entry]) => {
          let status = entry.approved ? 'approved' : 'draft'
          if (entry.approved) {
            try {
              if (hashPackDir(path.resolve(ws, entry.path)) !== entry.sha256) status = 'changed'
            } catch {
              status = 'missing'
            }
          }
          return { name, kind: 'workspace', path: entry.path, status, registeredAt: entry.registeredAt }
        })
        return send(200, JSON.stringify([...builtin, ...workspacePacks]))
      }
      if (url.pathname === '/artifact') {
        const id = url.searchParams.get('run') ?? ''
        const name = path.basename(url.searchParams.get('name') ?? '')
        if (!RUN_ID.test(id) || !name) return send(400, JSON.stringify({ error: 'bad request' }))
        const base = path.join(runDir(ws, id), 'artifacts')
        const file = path.resolve(base, name)
        if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file)) {
          return send(404, JSON.stringify({ error: 'not found' }))
        }
        const ext = path.extname(file).toLowerCase()
        if (ext === '.zip') {
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${name}"`,
            'cache-control': 'no-store',
          })
          res.end(fs.readFileSync(file))
          return
        }
        const type =
          ext === '.png' ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.gif' ? 'image/gif'
          : ext === '.svg' ? 'image/svg+xml'
          : ext === '.json' ? 'application/json'
          : 'text/plain; charset=utf-8'
        return send(200, fs.readFileSync(file), type)
      }
      return send(404, JSON.stringify({ error: 'not found' }))
    } catch (err) {
      return send(500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

export async function dashboardCommand(opts: { port?: string }): Promise<void> {
  const { dir: ws, source } = resolveWorkspace()
  const port = opts.port ? Number(opts.port) : 4400
  const server = await startDashboard(ws, port)
  const addr = server.address()
  const actual = typeof addr === 'object' && addr ? addr.port : port
  console.log(`aart dashboard — http://127.0.0.1:${actual}  (workspace: ${ws} — ${workspaceSourceLabel(source)})`)
  console.log('read-only; Ctrl-C to stop')
}

// ---------------------------------------------------------------------------
// The page. One file, no framework. Data comes from the JSON endpoints above.
// ---------------------------------------------------------------------------
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aart dashboard</title>
<style>
  :root { --ok:#16a34a; --bad:#dc2626; --warn:#d97706; --info:#2563eb; --mut:#6b7280; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #111; background: #fafafa; }
  header { padding: 14px 20px; background: #111; color: #fff; display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 16px; margin: 0; }
  header .ws { color: #9ca3af; font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 10px 20px 0; }
  nav button { border: 1px solid #ddd; background: #fff; padding: 6px 14px; border-radius: 6px 6px 0 0; cursor: pointer; font: inherit; }
  nav button.on { background: #111; color: #fff; border-color: #111; }
  main { padding: 16px 20px 40px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e5e7eb; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  tr.row:hover { background: #f0f9ff; cursor: pointer; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; color: #fff; }
  .COMPLETED,.approved { background: var(--ok); } .FAILED,.missing { background: var(--bad); }
  .RUNNING,.draft,.changed { background: var(--warn); } .native { background: var(--info); }
  .deprecated,.PENDING { background: var(--mut); }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  #detail { margin-top: 16px; background: #fff; border: 1px solid #e5e7eb; padding: 14px; }
  #detail h3 { margin: 0 0 8px; }
  pre { background: #f6f8fa; padding: 8px; overflow: auto; margin: 4px 0; font-size: 12px; }
  details { margin: 4px 0; }
  .step { padding: 4px 0; border-bottom: 1px dashed #eee; }
  .art img { max-width: 480px; border: 1px solid #ddd; display: block; margin: 6px 0; }
  .err { color: var(--bad); }
  .empty { color: var(--mut); padding: 24px; text-align: center; }
  .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .bar input { padding: 5px 9px; border: 1px solid #ddd; border-radius: 6px; font: inherit; min-width: 280px; }
  .mut { color: var(--mut); font-size: 12px; }
</style>
</head>
<body>
<header><h1>aart</h1><span class="ws" id="ws"></span></header>
<nav>
  <button id="tab-runs" onclick="setTab('runs')">Runs</button>
  <button id="tab-blocks" onclick="setTab('blocks')">Blocks</button>
  <button id="tab-packs" onclick="setTab('packs')">Packs</button>
</nav>
<main><div id="content"></div><div id="detail" hidden></div></main>
<script>
const $ = (s) => document.querySelector(s)
// Escapes & < > " — enough for element text and DOUBLE-quoted attributes, which
// is the only way values are interpolated below. It does NOT escape ' — so never
// build a single-quoted attribute or drop a raw value into a JS string from data;
// keep dynamic JS args constrained (runId is RUN_ID-validated, showBlock takes an index).
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const pill = (s) => '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>'
const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(await r.text()); return r.json() }
let tab = 'runs'
let overview = {}
let blocksCache = []
const filters = { runs: '', blocks: '' }
const NOUN = { runs: 'runs', blocks: 'blocks' }

// "3m ago" style relative time; the absolute timestamp goes in the cell title.
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!isFinite(s)) return ''
  if (s < 60) return Math.max(0, Math.floor(s)) + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

// Reusable client-side filter: a search box that hides non-matching rows (each
// row carries a lowercased data-k key) WITHOUT re-fetching, so it survives the
// 5s auto-refresh. wireFilter restores the typed text and re-applies after each
// full re-render.
function filterBar(kind, placeholder, extra) {
  return '<div class="bar"><input id="filter-' + kind + '" placeholder="' + esc(placeholder) + '">' +
    '<span class="mut" id="count-' + kind + '"></span>' + (extra || '') + '</div>'
}
function applyFilter(kind) {
  const f = filters[kind].trim().toLowerCase()
  const rows = document.querySelectorAll('#tbl-' + kind + ' tr.frow')
  let shown = 0
  rows.forEach((tr) => {
    const hit = !f || (tr.getAttribute('data-k') || '').indexOf(f) >= 0
    tr.style.display = hit ? '' : 'none'
    if (hit) shown++
  })
  const c = $('#count-' + kind)
  if (c) c.textContent = (f ? shown + ' / ' + rows.length : rows.length) + ' ' + NOUN[kind]
}
function wireFilter(kind) {
  const fi = $('#filter-' + kind)
  if (!fi) return
  fi.value = filters[kind]
  applyFilter(kind)
  fi.oninput = () => { filters[kind] = fi.value; applyFilter(kind) }
}

function setTab(t) { tab = t; $('#detail').hidden = true; render() }

async function render() {
  for (const t of ['runs', 'blocks', 'packs']) $('#tab-' + t).className = t === tab ? 'on' : ''
  try {
    if (tab === 'runs') await renderRuns()
    else if (tab === 'blocks') await renderBlocks()
    else await renderPacks()
  } catch (e) {
    $('#content').innerHTML = '<div class="empty err">Could not load ' + esc(tab) + ': ' + esc((e && e.message) || e) + '</div>'
  }
}

async function renderRuns() {
  const runs = await j('/api/runs')
  if (!runs.length) {
    const ws = esc(overview.workspace || '')
    const msg = overview.initialized
      ? 'No runs yet — run a workflow and it appears here, e.g. <span class="mono">aart run examples/workflows/echo-smoke.workflow.yaml --yes</span>.'
      : 'No runs in this workspace yet — run a workflow to populate it, or set <span class="mono">--workspace</span> / <span class="mono">$AART_WORKSPACE</span> to point at a specific project.'
    $('#content').innerHTML = '<div class="empty">' + msg + '<div class="mono" style="margin-top:8px">workspace: ' + ws + '</div></div>'
    return
  }
  const by = {}
  runs.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1 })
  const summary = '<span class="mut">' +
    [['COMPLETED', 'completed'], ['FAILED', 'failed'], ['RUNNING', 'running'], ['PENDING', 'pending']]
      .filter(([s]) => by[s]).map(([s, label]) => ' · ' + by[s] + ' ' + label).join('') + '</span>'
  $('#content').innerHTML = filterBar('runs', 'filter by block or status…', summary) +
    '<table id="tbl-runs"><tr><th>started</th><th>block</th><th>status</th><th>duration</th><th>run</th></tr>' +
    runs.map((r) => {
      const ms = r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : NaN
      const dur = Number.isFinite(ms) ? ms + 'ms' : ''
      // Defensive: a partial/hand-edited run.json may lack startedAt — degrade
      // this one row rather than throwing and blanking the whole list.
      const abs = r.startedAt ? esc(r.startedAt.replace('T', ' ').slice(0, 19)) : ''
      const k = esc((r.blockId + ' ' + r.status + (r.approved === false ? ' unapproved' : '')).toLowerCase())
      return '<tr class="row frow" data-k="' + k + '" onclick="showRun(\\'' + esc(r.runId) + '\\')">' +
        '<td title="' + abs + '">' + esc(ago(r.startedAt)) + '</td>' +
        '<td class="mono">' + esc(r.blockId) + '</td><td>' + pill(r.status) +
        (r.approved === false ? ' <span class="err">unapproved</span>' : '') +
        '</td><td>' + dur + '</td><td class="mono">' + esc(r.runId.slice(0, 8)) + '</td></tr>'
    }).join('') + '</table>'
  wireFilter('runs')
}

async function showRun(id) {
  try {
  const r = await j('/api/run?id=' + encodeURIComponent(id))
  const steps = r.trace.map((t) =>
    '<div class="step">' + pill(t.status) + ' <b>' + esc(t.iteration !== undefined ? t.stepId + '[' + t.iteration + ']' : t.stepId) + '</b> → <span class="mono">' + esc(t.block) + '</span>' +
    (t.error ? '<div class="err">' + esc(t.error) + '</div>' : '') +
    '<details><summary>in / out</summary><pre>' + esc(JSON.stringify(t.inputs, null, 2)) + '</pre>' +
    (t.outputs ? '<pre>' + esc(JSON.stringify(t.outputs, null, 2)) + '</pre>' : '') + '</details></div>'
  ).join('')
  const arts = r.artifacts.map((name) => {
    const u = '/artifact?run=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name)
    const img = /\\.(png|jpe?g|gif|svg)$/i.test(name)
    return '<div class="art"><a href="' + u + '" target="_blank" class="mono">' + esc(name) + '</a>' +
      (img ? '<img src="' + u + '">' : '') + '</div>'
  }).join('')
  $('#detail').hidden = false
  $('#detail').innerHTML = '<h3>' + pill(r.status) + ' <span class="mono">' + esc(r.blockId) + '</span> — run ' +
    esc(id) + '</h3>' +
    '<details open><summary>inputs</summary><pre>' + esc(JSON.stringify(r.inputs, null, 2)) + '</pre></details>' +
    (r.error ? '<div class="err">' + esc(r.error) + '</div>' : '') +
    (r.results ? '<details open><summary>results</summary><pre>' + esc(JSON.stringify(r.results, null, 2)) + '</pre></details>' : '') +
    '<h4>steps</h4>' + (steps || '<span class="empty">no steps</span>') +
    (arts ? '<h4>artifacts</h4>' + arts : '')
  $('#detail').scrollIntoView({ behavior: 'smooth' })
  } catch (e) {
    $('#detail').hidden = false
    $('#detail').innerHTML = '<div class="err">Could not load run ' + esc(id) + ': ' + esc((e && e.message) || e) + '</div>'
  }
}

async function renderBlocks() {
  const blocks = await j('/api/blocks')
  blocksCache = blocks
  $('#content').innerHTML = filterBar('blocks', 'filter by id, type, or capability…') +
    '<table id="tbl-blocks"><tr><th>id</th><th>type</th><th>status</th><th>capabilities</th><th>inputs</th><th>description</th></tr>' +
    blocks.map((b, i) => {
      const caps = (b.capabilities || []).join(', ')
      const k = esc((b.id + ' ' + b.type + ' ' + b.status + ' ' + caps).toLowerCase())
      return '<tr class="row frow" data-k="' + k + '" onclick="showBlock(' + i + ')"><td class="mono">' + esc(b.id) + '</td><td>' + esc(b.type) +
        '</td><td>' + pill(b.status) + '</td><td class="mono">' + esc(caps) +
        '</td><td class="mono">' + esc(b.inputs.map((f) => f.name + (f.required ? '*' : '')).join(', ')) +
        '</td><td>' + esc(b.description || '') + '</td></tr>'
    }).join('') + '</table>'
  wireFilter('blocks')
}

// One field (input/output) table for the block detail panel.
function fieldTable(arr) {
  if (!arr || !arr.length) return '<span class="mut">none</span>'
  return '<table><tr><th>name</th><th>type</th><th>required</th><th>constraints</th></tr>' +
    arr.map((f) => {
      const cons = [f.enum ? 'enum: ' + f.enum.join(' | ') : '', f.pattern ? 'pattern: ' + f.pattern : '']
        .filter(Boolean).join('; ')
      return '<tr><td class="mono">' + esc(f.name) + '</td><td class="mono">' + esc(f.type || 'any') + '</td><td>' +
        (f.required ? '✓' : '') + '</td><td class="mono">' + esc(cons) +
        (f.description ? '<div class="mut">' + esc(f.description) + '</div>' : '') + '</td></tr>'
    }).join('') + '</table>'
}

function showBlock(i) {
  const b = blocksCache[i]
  if (!b) return
  const meta = 'type: ' + esc(b.type) +
    (b.capabilities && b.capabilities.length ? ' · capabilities: ' + esc(b.capabilities.join(', ')) : '') +
    (b.dependencies && b.dependencies.length ? ' · deps: ' + esc(b.dependencies.join(', ')) : '')
  $('#detail').hidden = false
  $('#detail').innerHTML = '<h3>' + pill(b.status) + ' <span class="mono">' + esc(b.id) + '</span> ' +
    '<span class="mut">' + esc(b.name || '') + (b.version ? ' v' + esc(b.version) : '') + '</span></h3>' +
    (b.description ? '<p>' + esc(b.description) + '</p>' : '') +
    '<div class="mut" style="margin-bottom:8px">' + meta + '</div>' +
    '<h4>inputs</h4>' + fieldTable(b.inputs) +
    '<h4>outputs</h4>' + fieldTable(b.outputs)
  $('#detail').scrollIntoView({ behavior: 'smooth' })
}

async function renderPacks() {
  const packs = await j('/api/packs')
  if (!packs.length) { $('#content').innerHTML = '<div class="empty">No packs.<div class="mono" style="margin-top:8px">workspace: ' + esc(overview.workspace || '') + '</div></div>'; return }
  $('#content').innerHTML = '<table><tr><th>name</th><th>kind</th><th>status</th><th>provides</th><th>source</th></tr>' +
    packs.map((p) => {
      const provides = p.kind === 'built-in'
        ? esc(p.blocks + ' blocks' +
            (p.capabilities && p.capabilities.length ? ' · caps: ' + p.capabilities.join(', ') : '') +
            (p.aliases && p.aliases.length ? ' · ' + p.aliases.length + ' legacy ids' : ''))
        : ''
      const source = p.kind === 'built-in'
        ? 'built-in'
        : '<span class="mono">' + esc(p.path || '') + '</span>' + (p.registeredAt ? ' ' + esc(p.registeredAt.slice(0, 19)) : '')
      return '<tr><td class="mono">' + esc(p.name) + '</td><td>' + esc(p.kind) + '</td><td>' + pill(p.status) +
        '</td><td>' + provides + '</td><td>' + source + '</td></tr>'
    }).join('') + '</table>'
}

;(async () => {
  try { overview = await j('/api/overview') } catch (e) { overview = {} }
  $('#ws').textContent = overview.workspace || ''
  render()
})()
setInterval(() => {
  const el = document.activeElement
  const typing = el && typeof el.id === 'string' && el.id.indexOf('filter-') === 0
  if (tab === 'runs' && $('#detail').hidden && !document.hidden && !typing) render()
}, 5000)
</script>
</body>
</html>`
