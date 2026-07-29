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
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Artifact } from "@aart/types";
import type { ArtifactStore } from "../../types.js";
import { JsonFileHandle } from "./json-file.js";

interface StoredArtifact extends Artifact {
  redactionTextEligible?: boolean;
}

interface ArtifactRedactionJournal {
  version: 1;
  artifactId: string;
  runId: string;
  updated: StoredArtifact;
  stagedBlobName?: string;
}

function isTextMime(mime: string): boolean {
  const normalized = mime.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("yaml")
  );
}

async function moveStagedBlob(
  stagedPath: string,
  canonicalPath: string,
): Promise<void> {
  try {
    await fs.rename(stagedPath, canonicalPath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    await fs.access(canonicalPath);
  }
}

async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

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
  private redactionJournalDir(): string {
    return join(this.dir, ".redaction-journal");
  }

  private async recoverPendingRedactions(): Promise<void> {
    let files: string[];
    try {
      files = (await fs.readdir(
        this.redactionJournalDir(),
      )).filter(
        (file) =>
          file.endsWith(".json") && !file.startsWith(".tmp-"),
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    for (const file of files) {
      const journalPath = join(
        this.redactionJournalDir(),
        file,
      );
      const journal = JSON.parse(
        await fs.readFile(journalPath, "utf8"),
      ) as ArtifactRedactionJournal;
      if (journal.version !== 1) {
        throw new Error(
          `Unsupported fs artifact redaction journal at ${journalPath}.`,
        );
      }
      await new JsonFileHandle<StoredArtifact>(
        this.metaPath(journal.runId, journal.artifactId),
      ).write(journal.updated);
      if (journal.stagedBlobName !== undefined) {
        const stagedPath = join(
          this.runDir(journal.runId),
          journal.stagedBlobName,
        );
        await moveStagedBlob(
          stagedPath,
          this.blobPath(journal.runId, journal.artifactId),
        );
      }
      await removeFileIfPresent(journalPath);
    }
  }

  async put(artifact: Artifact, bytes: Uint8Array): Promise<void> {
    await this.recoverPendingRedactions();
    await fs.mkdir(this.runDir(artifact.runId), { recursive: true });
    const existing =
      await new JsonFileHandle<StoredArtifact>(
        this.metaPath(artifact.runId, artifact.id),
      ).read();
    await fs.writeFile(this.blobPath(artifact.runId, artifact.id), bytes);
    await new JsonFileHandle<StoredArtifact>(
      this.metaPath(artifact.runId, artifact.id),
    ).write({
      ...artifact,
      redactionTextEligible:
        existing?.redactionTextEligible ??
        isTextMime(artifact.mime),
    });
  }

  async getMetadata(artifactId: string): Promise<Artifact | undefined> {
    await this.recoverPendingRedactions();
    const found = await this.findByArtifactId(artifactId);
    return found
      ? this.publicArtifact(found.metadata)
      : undefined;
  }

  async getBytes(artifactId: string): Promise<Uint8Array | undefined> {
    await this.recoverPendingRedactions();
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

  async list(): Promise<Artifact[]> {
    await this.recoverPendingRedactions();
    let runIds: string[];
    try {
      runIds = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return (
      await Promise.all(
        runIds.map((runId) => this.listByRun(runId)),
      )
    ).flat();
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    await this.recoverPendingRedactions();
    let files: string[];
    try {
      files = (await fs.readdir(this.runDir(runId))).filter((f) => f.endsWith(".meta.json"));
    } catch {
      return [];
    }
    const values = await Promise.all(
      files.map((file) =>
        new JsonFileHandle<StoredArtifact>(
          join(this.runDir(runId), file),
        ).read(),
      ),
    );
    return values.flatMap((value) =>
      value === undefined ? [] : [this.publicArtifact(value)],
    );
  }

  async isTextEligible(artifactId: string): Promise<boolean> {
    await this.recoverPendingRedactions();
    const found = await this.findByArtifactId(artifactId);
    if (!found) return false;
    return (
      found.metadata.redactionTextEligible ??
      isTextMime(found.metadata.mime)
    );
  }

  async replaceAudit(
    artifactId: string,
    audit: Pick<Artifact, "name" | "kind" | "mime" | "path">,
    bytes?: Uint8Array,
  ): Promise<Artifact | undefined> {
    await this.recoverPendingRedactions();
    const found = await this.findByArtifactId(artifactId);
    if (!found) return undefined;
    const updated: StoredArtifact = {
      ...found.metadata,
      ...audit,
      bytes: bytes?.byteLength ?? found.metadata.bytes,
      redactionTextEligible:
        found.metadata.redactionTextEligible ??
        isTextMime(found.metadata.mime),
    };
    let stagedBlobName: string | undefined;
    if (bytes !== undefined) {
      stagedBlobName =
        `.${artifactId}.redacted-${randomUUID()}.blob`;
      await fs.writeFile(
        join(
          this.runDir(found.metadata.runId),
          stagedBlobName,
        ),
        bytes,
      );
    }
    const journal: ArtifactRedactionJournal = {
      version: 1,
      artifactId,
      runId: found.metadata.runId,
      updated,
      ...(stagedBlobName !== undefined
        ? { stagedBlobName }
        : {}),
    };
    const journalNonce = randomUUID();
    const journalPath = join(
      this.redactionJournalDir(),
      `${journalNonce}.json`,
    );
    await new JsonFileHandle<ArtifactRedactionJournal>(
      journalPath,
    ).write(journal);
    await new JsonFileHandle<StoredArtifact>(
      this.metaPath(found.metadata.runId, artifactId),
    ).write(updated);
    if (stagedBlobName !== undefined) {
      await moveStagedBlob(
        join(
          this.runDir(found.metadata.runId),
          stagedBlobName,
        ),
        this.blobPath(found.metadata.runId, artifactId),
      );
    }
    await removeFileIfPresent(journalPath);
    return this.publicArtifact(updated);
  }

  private async findByArtifactId(artifactId: string): Promise<{ metadata: StoredArtifact } | undefined> {
    let runDirs: string[];
    try {
      runDirs = await fs.readdir(this.dir);
    } catch {
      return undefined;
    }
    for (const runId of runDirs) {
      const metadata = await new JsonFileHandle<StoredArtifact>(this.metaPath(runId, artifactId)).read();
      if (metadata) return { metadata };
    }
    return undefined;
  }

  private publicArtifact(stored: StoredArtifact): Artifact {
    const {
      redactionTextEligible: _redactionTextEligible,
      ...artifact
    } = stored;
    return artifact;
  }
}
