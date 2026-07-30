// ArtifactStore's fs implementation — architecture §5.2/§5.4: blob bytes
// and Artifact metadata are stored separately (`artifacts/<runId>/<artifactId>.<ext>`
// + `.meta.json`). This implementation uses a fixed `.blob` extension for
// the bytes file rather than deriving a real extension from `mime`
// (avoiding a mime-to-extension mapping table this task's scope doesn't
// call for) — nothing reads the blob file directly by extension; all access
// goes through `getBytes(artifactId)`. Metadata and blob writes participate
// in transact()'s shared redo journal so a secret repair commits together
// with cache revocation and the protected run transition.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Artifact } from "@aart/types";
import type {
  ArtifactRedactionCandidate,
  ArtifactStore,
} from "../../types.js";
import {
  BinaryFileHandle,
  JsonFileHandle,
  listDirectoryEntries,
  moveFile,
  type StagingBuffer,
} from "./json-file.js";

interface StoredArtifact extends Artifact {
  redactionTextEligible?: boolean;
  redactionAuditVisible?: boolean;
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
  staging?: StagingBuffer,
): Promise<void> {
  try {
    await moveFile(stagedPath, canonicalPath, staging);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    if (
      (await new BinaryFileHandle(
        canonicalPath,
        staging,
      ).read()) === undefined
    ) {
      throw error;
    }
  }
}

async function removeFileIfPresent(
  path: string,
  staging?: StagingBuffer,
): Promise<void> {
  await new BinaryFileHandle(path, staging).delete();
}

export class FsArtifactStore implements ArtifactStore {
  constructor(
    private readonly dir: string,
    private readonly staging?: StagingBuffer,
  ) {}

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
    const files = (
      await listDirectoryEntries(
        this.redactionJournalDir(),
        this.staging,
      )
    ).filter(
      (file) =>
        file.endsWith(".json") && !file.startsWith(".tmp-"),
    );
    for (const file of files) {
      const journalPath = join(
        this.redactionJournalDir(),
        file,
      );
      const journal =
        await new JsonFileHandle<ArtifactRedactionJournal>(
          journalPath,
          this.staging,
        ).read();
      if (journal === undefined) continue;
      if (journal.version !== 1) {
        throw new Error(
          `Unsupported fs artifact redaction journal at ${journalPath}.`,
        );
      }
      await new JsonFileHandle<StoredArtifact>(
        this.metaPath(journal.runId, journal.artifactId),
        this.staging,
      ).write(journal.updated);
      if (journal.stagedBlobName !== undefined) {
        const stagedPath = join(
          this.runDir(journal.runId),
          journal.stagedBlobName,
        );
        await moveStagedBlob(
          stagedPath,
          this.blobPath(journal.runId, journal.artifactId),
          this.staging,
        );
      }
      await removeFileIfPresent(journalPath, this.staging);
    }
  }

  async put(
    artifact: Artifact,
    bytes: Uint8Array,
    options?: {
      redactionTextEligible?: boolean;
      auditVisible?: false;
    },
  ): Promise<void> {
    await this.recoverPendingRedactions();
    if (!this.staging) {
      await fs.mkdir(this.runDir(artifact.runId), {
        recursive: true,
      });
    }
    const existing =
      await new JsonFileHandle<StoredArtifact>(
        this.metaPath(artifact.runId, artifact.id),
        this.staging,
      ).read();
    await new BinaryFileHandle(
      this.blobPath(artifact.runId, artifact.id),
      this.staging,
    ).write(bytes);
    await new JsonFileHandle<StoredArtifact>(
      this.metaPath(artifact.runId, artifact.id),
      this.staging,
    ).write({
      ...artifact,
      redactionTextEligible:
        existing?.redactionTextEligible ??
        options?.redactionTextEligible ??
        isTextMime(artifact.mime),
      redactionAuditVisible:
        existing?.redactionAuditVisible === false ||
        options?.auditVisible === false
          ? false
          : true,
    });
  }

  async getMetadata(artifactId: string): Promise<Artifact | undefined> {
    await this.recoverPendingRedactions();
    const found = await this.findByArtifactId(artifactId);
    return found && this.isAuditVisible(found.metadata)
      ? this.publicArtifact(found.metadata)
      : undefined;
  }

  async getBytes(artifactId: string): Promise<Uint8Array | undefined> {
    await this.recoverPendingRedactions();
    const found = await this.findByArtifactId(artifactId);
    if (!found || !this.isAuditVisible(found.metadata)) {
      return undefined;
    }
    return this.readBytes(found.metadata.runId, artifactId);
  }

  async getBytesForRedaction(
    artifactId: string,
  ): Promise<Uint8Array | undefined> {
    await this.recoverPendingRedactions();
    const found = await this.findByArtifactId(artifactId);
    if (!found) return undefined;
    return this.readBytes(found.metadata.runId, artifactId);
  }

  private async readBytes(
    runId: string,
    artifactId: string,
  ): Promise<Uint8Array | undefined> {
    try {
      const buffer = await new BinaryFileHandle(
        this.blobPath(runId, artifactId),
        this.staging,
      ).read();
      if (buffer === undefined) return undefined;
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
      runIds = await listDirectoryEntries(
        this.dir,
        this.staging,
      );
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
    return (await this.listForRedaction(runId)).flatMap(
      ({ artifact, auditVisible }) =>
        auditVisible ? [artifact] : [],
    );
  }

  async listForRedaction(
    runId?: string,
  ): Promise<ArtifactRedactionCandidate[]> {
    await this.recoverPendingRedactions();
    if (runId === undefined) {
      let runIds: string[];
      try {
        runIds = await listDirectoryEntries(
          this.dir,
          this.staging,
        );
      } catch {
        return [];
      }
      return (
        await Promise.all(
          runIds.map((candidateRunId) =>
            this.listForRedaction(candidateRunId),
          ),
        )
      ).flat();
    }
    let files: string[];
    try {
      files = (
        await listDirectoryEntries(
          this.runDir(runId),
          this.staging,
        )
      ).filter((f) => f.endsWith(".meta.json"));
    } catch {
      return [];
    }
    const values = await Promise.all(
      files.map((file) =>
        new JsonFileHandle<StoredArtifact>(
          join(this.runDir(runId), file),
          this.staging,
        ).read(),
      ),
    );
    return values.flatMap((value) =>
      value === undefined
        ? []
        : [
            {
              artifact: this.publicArtifact(value),
              auditVisible: this.isAuditVisible(value),
            },
          ],
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
    options?: { auditVisible?: false },
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
      redactionAuditVisible:
        found.metadata.redactionAuditVisible === false ||
        options?.auditVisible === false
          ? false
          : true,
    };
    let stagedBlobName: string | undefined;
    if (bytes !== undefined) {
      stagedBlobName =
        `.${artifactId}.redacted-${randomUUID()}.blob`;
      await new BinaryFileHandle(
        join(
          this.runDir(found.metadata.runId),
          stagedBlobName,
        ),
        this.staging,
      ).write(bytes);
    }
    if (this.staging) {
      await new JsonFileHandle<StoredArtifact>(
        this.metaPath(found.metadata.runId, artifactId),
        this.staging,
      ).write(updated);
      if (stagedBlobName !== undefined) {
        await moveStagedBlob(
          join(
            this.runDir(found.metadata.runId),
            stagedBlobName,
          ),
          this.blobPath(found.metadata.runId, artifactId),
          this.staging,
        );
      }
      return this.publicArtifact(updated);
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
      runDirs = await listDirectoryEntries(
        this.dir,
        this.staging,
      );
    } catch {
      return undefined;
    }
    for (const runId of runDirs) {
      const metadata =
        await new JsonFileHandle<StoredArtifact>(
          this.metaPath(runId, artifactId),
          this.staging,
        ).read();
      if (metadata) return { metadata };
    }
    return undefined;
  }

  private publicArtifact(stored: StoredArtifact): Artifact {
    const {
      redactionTextEligible: _redactionTextEligible,
      redactionAuditVisible: _redactionAuditVisible,
      ...artifact
    } = stored;
    return artifact;
  }

  private isAuditVisible(stored: StoredArtifact): boolean {
    return stored.redactionAuditVisible !== false;
  }
}
