import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactMeta } from '../core/types'

/**
 * Where evidence lives. The core only knows about an opaque artifact store;
 * each pack decides what artifacts mean (the core pack writes screenshots here).
 * Files land under `.aa/runs/<runId>/artifacts/`.
 *
 * NOTE: artifact CONTENTS are written verbatim and are NOT passed through secret
 * redaction — a screenshot of a secret typed into a visible field will contain
 * it in cleartext. Use the screenshot block's `mask` option for such fields.
 * NEW: trace.zip/console.json/network.json also capture request headers, bodies,
 * console logs, and full DOM snapshots in cleartext — treat these as
 * high-sensitivity artifacts.
 */
export class ArtifactStore {
  private dir: string
  private items: ArtifactMeta[] = []
  private _currentStep: string | undefined

  constructor(runDirectory: string) {
    this.dir = path.join(runDirectory, 'artifacts')
  }

  /** Set the current step id for subsequent attach() calls. Call with undefined
   *  to clear (root/native blocks outside a step get stepId undefined). */
  setStep(stepId: string | undefined): void {
    this._currentStep = stepId
  }

  /** Return the current step id (for save/restore by callers like the engine). */
  get currentStep(): string | undefined {
    return this._currentStep
  }

  /** Persist a named artifact and return its path. `name` is untrusted authoring
   *  data, so it is reduced to a basename and confined to the store directory.
   *  meta.mime defaults to extension inference; meta.kind defaults to 'file'. */
  attach(name: string, data: Buffer | string, meta?: { mime?: string; kind?: ArtifactMeta['kind'] }): string {
    fs.mkdirSync(this.dir, { recursive: true })
    const safe = path.basename(name)
    const target = path.resolve(this.dir, safe)
    if (!safe || !target.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error(`unsafe artifact name: ${name}`)
    }
    fs.writeFileSync(target, data)
    const bytes = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(data)
    const mime = meta?.mime ?? inferMime(safe)
    const kind = meta?.kind ?? 'file'
    this.items.push({
      name: safe,
      mime,
      path: target,
      bytes,
      kind,
      stepId: this.currentStep,
    })
    return target
  }

  list(): ArtifactMeta[] {
    return [...this.items]
  }
}

/** Infer a MIME type from a file extension. Falls back to application/octet-stream. */
function inferMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    case '.webp': return 'image/webp'
    case '.json': return 'application/json'
    case '.zip': return 'application/zip'
    case '.txt': return 'text/plain'
    case '.md': return 'text/markdown'
    case '.csv': return 'text/csv'
    case '.html': return 'text/html'
    case '.xml': return 'application/xml'
    case '.pdf': return 'application/pdf'
    default: return 'application/octet-stream'
  }
}
