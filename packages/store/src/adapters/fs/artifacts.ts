// ArtifactStore's fs implementation — architecture §5.2/§5.4: blob bytes
// and Artifact metadata are stored separately (`artifacts/<runId>/<artifactId>.<ext>`
// + `.meta.json`). This implementation uses a fixed `.blob` extension for
// the bytes file rather than deriving a real extension from `mime`
// (avoiding a mime-to-extension mapping table this task's scope doesn't
// call for) — nothing reads the blob file directly by extension; all access
// goes through `getBytes(artifactId)`. Deliberately NOT staged by
// transact() (architecture only requires the transactional contract for
// the run/wait/dedupe co-location — see architecture §5.8; nothing in
// either doc requires artifact blob writes to participate in it, and
// buffering large binary blobs in memory for the lifetime of a transaction
// would be a real cost for no documented benefit).
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Artifact } from "@aart/types";
import type { ArtifactStore } from "../../types.js";
import { JsonFileHandle } from "./json-file.js";

export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  private runDir(runId: string): string {
    return join(this.dir, runId);
  }
  private metaPath(runId: string, artifactId: string): string {
    return join(this.runDir(runId), `${artifactId}.meta.json`);
  }
  private blobPath(runId: string, artifactId: string): string {
    return join(this.runDir(runId), `${artifactId}.blob`);
  }

  async put(artifact: Artifact, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(this.runDir(artifact.runId), { recursive: true });
    await fs.writeFile(this.blobPath(artifact.runId, artifact.id), bytes);
    await new JsonFileHandle<Artifact>(this.metaPath(artifact.runId, artifact.id)).write(artifact);
  }

  async getMetadata(artifactId: string): Promise<Artifact | undefined> {
    const found = await this.findByArtifactId(artifactId);
    return found?.metadata;
  }

  async getBytes(artifactId: string): Promise<Uint8Array | undefined> {
    const found = await this.findByArtifactId(artifactId);
    if (!found) return undefined;
    try {
      const buffer = await fs.readFile(this.blobPath(found.metadata.runId, artifactId));
      // Return a plain Uint8Array, not a Node Buffer — Buffer is a Uint8Array
      // subclass so it satisfies the interface, but a caller that put() a
      // plain Uint8Array and deep-equality-compares what getBytes() returns
      // against it (as the conformance suite does) would otherwise see a
      // structural mismatch (Buffer carries extra own properties).
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch {
      return undefined;
    }
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.runDir(runId))).filter((f) => f.endsWith(".meta.json"));
    } catch {
      return [];
    }
    const values = await Promise.all(files.map((f) => new JsonFileHandle<Artifact>(join(this.runDir(runId), f)).read()));
    return values.filter((v): v is Artifact => v !== undefined);
  }

  private async findByArtifactId(artifactId: string): Promise<{ metadata: Artifact } | undefined> {
    let runDirs: string[];
    try {
      runDirs = await fs.readdir(this.dir);
    } catch {
      return undefined;
    }
    for (const runId of runDirs) {
      const metadata = await new JsonFileHandle<Artifact>(this.metaPath(runId, artifactId)).read();
      if (metadata) return { metadata };
    }
    return undefined;
  }
}
