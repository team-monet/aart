import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { buildCatalog } from '../../agent/catalog'
import { listRuns, readRun, runDir } from '../../core/report'
import { hashPackDir, readPackManifest } from '../../pack/loader'
import { openRuntime, workspace } from '../workspace'

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
        return send(200, JSON.stringify({ workspace: ws }))
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
          const artifacts = record.artifacts.map((a) => path.basename(a))
          return send(200, JSON.stringify({ ...record, artifacts }))
        } catch {
          return send(404, JSON.stringify({ error: 'run not found' }))
        }
      }
      if (url.pathname === '/api/packs') {
        const manifest = readPackManifest(ws)
        const packs = Object.entries(manifest.packs).map(([name, entry]) => {
          let status = entry.approved ? 'approved' : 'draft'
          if (entry.approved) {
            try {
              if (hashPackDir(path.resolve(ws, entry.path)) !== entry.sha256) status = 'changed'
            } catch {
              status = 'missing'
            }
          }
          return { name, path: entry.path, status, registeredAt: entry.registeredAt }
        })
        return send(200, JSON.stringify(packs))
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
        const type =
          ext === '.png' ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.gif' ? 'image/gif'
          : ext === '.svg' ? 'image/svg+xml'
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
  const ws = workspace()
  const port = opts.port ? Number(opts.port) : 4400
  const server = await startDashboard(ws, port)
  const addr = server.address()
  const actual = typeof addr === 'object' && addr ? addr.port : port
  console.log(`aart dashboard — http://127.0.0.1:${actual}  (workspace: ${ws})`)
  console.log('read-only; Ctrl-C to stop')
}

// ---------------------------------------------------------------------------
// The page. One file, no framework. Data comes from the JSON endpoints above.
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html>
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
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const pill = (s) => '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>'
const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(await r.text()); return r.json() }
let tab = 'runs'

function setTab(t) { tab = t; $('#detail').hidden = true; render() }

async function render() {
  for (const t of ['runs', 'blocks', 'packs']) $('#tab-' + t).className = t === tab ? 'on' : ''
  if (tab === 'runs') return renderRuns()
  if (tab === 'blocks') return renderBlocks()
  return renderPacks()
}

async function renderRuns() {
  const runs = await j('/api/runs')
  if (!runs.length) { $('#content').innerHTML = '<div class="empty">No runs yet — run a workflow and it appears here.</div>'; return }
  $('#content').innerHTML = '<table><tr><th>started</th><th>block</th><th>status</th><th>duration</th><th>run</th></tr>' +
    runs.map((r) => {
      const dur = r.endedAt ? (Date.parse(r.endedAt) - Date.parse(r.startedAt)) + 'ms' : ''
      return '<tr class="row" onclick="showRun(\\'' + esc(r.runId) + '\\')"><td>' + esc(r.startedAt.replace('T', ' ').slice(0, 19)) +
        '</td><td class="mono">' + esc(r.blockId) + '</td><td>' + pill(r.status) +
        (r.approved === false ? ' <span class="err">unapproved</span>' : '') +
        '</td><td>' + dur + '</td><td class="mono">' + esc(r.runId.slice(0, 8)) + '</td></tr>'
    }).join('') + '</table>'
}

async function showRun(id) {
  const r = await j('/api/run?id=' + encodeURIComponent(id))
  const steps = r.trace.map((t) =>
    '<div class="step">' + pill(t.status) + ' <b>' + esc(t.stepId) + '</b> → <span class="mono">' + esc(t.block) + '</span>' +
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
}

async function renderBlocks() {
  const blocks = await j('/api/blocks')
  $('#content').innerHTML = '<table><tr><th>id</th><th>type</th><th>status</th><th>inputs</th><th>description</th></tr>' +
    blocks.map((b) => '<tr><td class="mono">' + esc(b.id) + '</td><td>' + esc(b.type) + '</td><td>' + pill(b.status) +
      '</td><td class="mono">' + esc(b.inputs.map((i) => i.name + (i.required ? '*' : '')).join(', ')) +
      '</td><td>' + esc(b.description || '') + '</td></tr>').join('') + '</table>'
}

async function renderPacks() {
  const packs = await j('/api/packs')
  if (!packs.length) { $('#content').innerHTML = '<div class="empty">No workspace packs registered.</div>'; return }
  $('#content').innerHTML = '<table><tr><th>name</th><th>path</th><th>status</th><th>registered</th></tr>' +
    packs.map((p) => '<tr><td class="mono">' + esc(p.name) + '</td><td class="mono">' + esc(p.path) +
      '</td><td>' + pill(p.status) + '</td><td>' + esc((p.registeredAt || '').slice(0, 19)) + '</td></tr>').join('') + '</table>'
}

j('/api/overview').then((o) => { $('#ws').textContent = o.workspace })
render()
setInterval(() => { if (tab === 'runs' && $('#detail').hidden && !document.hidden) render() }, 5000)
</script>
</body>
</html>`
