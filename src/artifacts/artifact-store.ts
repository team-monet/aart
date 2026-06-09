import fs from 'node:fs'
import path from 'node:path'

/**
 * Where evidence lives. The core only knows about an opaque artifact store;
 * each pack decides what artifacts mean (the QA pack will write screenshots,
 * traces, HAR, console logs here). Files land under `.aa/runs/<runId>/artifacts/`.
 */
export class ArtifactStore {
  private dir: string
  private items: string[] = []

  constructor(runDirectory: string) {
    this.dir = path.join(runDirectory, 'artifacts')
  }

  /** Persist a named artifact and return its path. */
  attach(name: string, data: Buffer | string): string {
    fs.mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, name)
    fs.writeFileSync(file, data)
    this.items.push(file)
    return file
  }

  list(): string[] {
    return [...this.items]
  }
}
