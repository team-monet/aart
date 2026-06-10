import fs from 'node:fs'
import path from 'node:path'

/**
 * Where evidence lives. The core only knows about an opaque artifact store;
 * each pack decides what artifacts mean (the core pack writes screenshots here).
 * Files land under `.aa/runs/<runId>/artifacts/`.
 *
 * NOTE: artifact CONTENTS are written verbatim and are NOT passed through secret
 * redaction — a screenshot of a secret typed into a visible field will contain
 * it in cleartext. Use the screenshot block's `mask` option for such fields.
 */
export class ArtifactStore {
  private dir: string
  private items: string[] = []

  constructor(runDirectory: string) {
    this.dir = path.join(runDirectory, 'artifacts')
  }

  /** Persist a named artifact and return its path. `name` is untrusted authoring
   *  data, so it is reduced to a basename and confined to the store directory. */
  attach(name: string, data: Buffer | string): string {
    fs.mkdirSync(this.dir, { recursive: true })
    const safe = path.basename(name)
    const target = path.resolve(this.dir, safe)
    if (!safe || !target.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error(`unsafe artifact name: ${name}`)
    }
    fs.writeFileSync(target, data)
    this.items.push(target)
    return target
  }

  list(): string[] {
    return [...this.items]
  }
}
