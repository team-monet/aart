// ArtifactStore — architecture §5.3 `artifacts` table (metadata only) +
// architecture §5.4: bytes are held in a separate blob store (fs for this
// adapter's dev/single-node-production tier; an S3-compatible backend is a
// documented future extension — plan §8 lists S3 creds as founder-optional,
// not required to build this adapter).
//
// `Artifact.path` (the frozen type's own field, spec §13.7) is
// CALLER-OWNED data that must round-trip verbatim — same discipline as
// every other AartStore member's put()/get() round-trip — NOT something
// this adapter rewrites to point at its own internal blob file location.
// This mirrors the fs adapter's own artifacts.ts exactly: its `blobPath()`
// is a pure function of `(runId, artifactId)`, never persisted into the
// metadata record, always recomputed on read; the persisted `Artifact`
// object (including whatever `path` string the caller supplied) is stored
// untouched. This adapter follows the identical discipline: `path_or_uri`
// stores the caller's own `artifact.path` value verbatim (round-trip
// fidelity — proven by the conformance suite's toEqual check), while this
// adapter's OWN physical blob-file location is a separate, adapter-internal
// pure function of `(runId, artifactId)` that is never persisted anywhere.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact } from "@aart/types";
import type {
  ArtifactRedactionCandidate,
  ArtifactStore,
} from "../../../types.js";
import { dbAll, dbGet, dbRun, type SqlExec } from "../db.js";

interface ArtifactRow {
  artifact_id: string;
  run_id: string;
  step_id: string | null;
  name: string;
  kind: string;
  mime: string;
  path_or_uri: string;
  bytes: number;
  created_at: string;
  redaction_text_eligible: number | null;
  redaction_audit_visible: number;
}

interface ArtifactRedactionJournal {
  version: 1;
  artifactId: string;
  runId: string;
  audit: Pick<Artifact, "name" | "kind" | "mime" | "path">;
  byteCount: number;
  textEligible: number;
  auditVisible?: number;
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

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.artifact_id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    name: row.name,
    kind: row.kind,
    mime: row.mime,
    path: row.path_or_uri,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

function redactionJournalDir(blobsDir: string): string {
  return join(blobsDir, ".artifact-redaction-journal");
}

function artifactBlobPath(
  blobsDir: string,
  runId: string,
  artifactId: string,
): string {
  return join(blobsDir, runId, `${artifactId}.blob`);
}

async function writeRedactionJournal(
  blobsDir: string,
  journal: ArtifactRedactionJournal,
): Promise<string> {
  const dir = redactionJournalDir(blobsDir);
  await fs.mkdir(dir, { recursive: true });
  const nonce = randomUUID();
  const path = join(dir, `${nonce}.json`);
  const temporaryPath = join(dir, `.tmp-${nonce}.json`);
  await fs.writeFile(
    temporaryPath,
    JSON.stringify(journal),
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, path);
  return path;
}

async function readRedactionJournals(
  blobsDir: string,
): Promise<Array<{
  path: string;
  journal: ArtifactRedactionJournal;
}>> {
  const dir = redactionJournalDir(blobsDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter(
      (file) => file.endsWith(".json") && !file.startsWith(".tmp-"),
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  return Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      return {
        path,
        journal: JSON.parse(
          await fs.readFile(path, "utf8"),
        ) as ArtifactRedactionJournal,
      };
    }),
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

/**
 * Completes redaction intents that survived a process exit or an enclosing
 * SQLite transaction rollback. Callers run this before exposing the store
 * and after every transaction outcome.
 */
export async function recoverSqliteArtifactRedactions(
  exec: SqlExec,
  blobsDir: string,
): Promise<void> {
  for (const { path, journal } of await readRedactionJournals(blobsDir)) {
    if (journal.version !== 1) {
      throw new Error(
        `Unsupported SQLite artifact redaction journal at ${path}.`,
      );
    }
    if (journal.stagedBlobName !== undefined) {
      const stagedPath = join(
        blobsDir,
        journal.runId,
        journal.stagedBlobName,
      );
      await moveStagedBlob(
        stagedPath,
        artifactBlobPath(
          blobsDir,
          journal.runId,
          journal.artifactId,
        ),
      );
    }
    await exec((db) =>
      dbRun(
        db,
        `UPDATE artifacts
         SET name = ?, kind = ?, mime = ?, path_or_uri = ?, bytes = ?,
             redaction_text_eligible = ?,
             redaction_audit_visible =
               CASE
                 WHEN redaction_audit_visible = 0 OR ? = 0 THEN 0
                 ELSE 1
               END
         WHERE artifact_id = ? AND run_id = ?`,
        [
          journal.audit.name,
          journal.audit.kind,
          journal.audit.mime,
          journal.audit.path,
          journal.byteCount,
          journal.textEligible,
          journal.auditVisible ?? 1,
          journal.artifactId,
          journal.runId,
        ],
      ),
    );
    await removeFileIfPresent(path);
  }
}

export class SqliteArtifactStore implements ArtifactStore {
  constructor(
    private readonly exec: SqlExec,
    private readonly blobsDir: string,
    private readonly transactionScoped = false,
  ) {}

  /** This adapter's own physical blob-file location — a pure function of (runId, artifactId), never persisted (see module doc comment). */
  private blobFilePath(runId: string, artifactId: string): string {
    return artifactBlobPath(this.blobsDir, runId, artifactId);
  }

  private async recoverPending(): Promise<void> {
    if (!this.transactionScoped) {
      await recoverSqliteArtifactRedactions(
        this.exec,
        this.blobsDir,
      );
    }
  }

  async put(
    artifact: Artifact,
    bytes: Uint8Array,
    options?: { redactionTextEligible?: boolean },
  ): Promise<void> {
    await this.recoverPending();
    const blobFilePath = this.blobFilePath(artifact.runId, artifact.id);
    await fs.mkdir(dirname(blobFilePath), { recursive: true });
    await fs.writeFile(blobFilePath, bytes);
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO artifacts (artifact_id, run_id, step_id, name, kind, mime, path_or_uri, bytes, created_at, redaction_text_eligible, redaction_audit_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           run_id = excluded.run_id, step_id = excluded.step_id, name = excluded.name,
           kind = excluded.kind, mime = excluded.mime, path_or_uri = excluded.path_or_uri,
           bytes = excluded.bytes, created_at = excluded.created_at,
           redaction_text_eligible = COALESCE(artifacts.redaction_text_eligible, excluded.redaction_text_eligible),
           redaction_audit_visible = artifacts.redaction_audit_visible`,
        [
          artifact.id,
          artifact.runId,
          artifact.stepId ?? null,
          artifact.name,
          artifact.kind,
          artifact.mime,
          artifact.path,
          artifact.bytes,
          artifact.createdAt,
          (options?.redactionTextEligible ??
            isTextMime(artifact.mime))
            ? 1
            : 0,
          1,
        ],
      ),
    );
  }

  async getMetadata(artifactId: string): Promise<Artifact | undefined> {
    await this.recoverPending();
    const row = await this.exec((db) =>
      dbGet<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE artifact_id = ? AND redaction_audit_visible = 1",
        [artifactId],
      ),
    );
    return row ? rowToArtifact(row) : undefined;
  }

  async getBytes(artifactId: string): Promise<Uint8Array | undefined> {
    await this.recoverPending();
    const row = await this.exec((db) =>
      dbGet<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE artifact_id = ? AND redaction_audit_visible = 1",
        [artifactId],
      ),
    );
    if (!row) return undefined;
    return this.readBytes(row);
  }

  async getBytesForRedaction(
    artifactId: string,
  ): Promise<Uint8Array | undefined> {
    await this.recoverPending();
    const row = await this.exec((db) =>
      dbGet<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE artifact_id = ?",
        [artifactId],
      ),
    );
    if (!row) return undefined;
    return this.readBytes(row);
  }

  private async readBytes(
    row: ArtifactRow,
  ): Promise<Uint8Array | undefined> {
    try {
      const buffer = await fs.readFile(this.blobFilePath(row.run_id, row.artifact_id));
      // Plain Uint8Array, not a Node Buffer — see the fs adapter's
      // artifacts.ts for why (a Buffer's extra own properties would break
      // the conformance suite's toEqual deep-equality check against a
      // plain Uint8Array).
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Artifact[]> {
    await this.recoverPending();
    const rows = await this.exec((db) =>
      dbAll<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE redaction_audit_visible = 1",
      ),
    );
    return rows.map(rowToArtifact);
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    await this.recoverPending();
    const rows = await this.exec((db) =>
      dbAll<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE run_id = ? AND redaction_audit_visible = 1",
        [runId],
      ),
    );
    return rows.map(rowToArtifact);
  }

  async listForRedaction(
    runId?: string,
  ): Promise<ArtifactRedactionCandidate[]> {
    await this.recoverPending();
    const rows = await this.exec((db) =>
      runId === undefined
        ? dbAll<ArtifactRow>(db, "SELECT * FROM artifacts")
        : dbAll<ArtifactRow>(
            db,
            "SELECT * FROM artifacts WHERE run_id = ?",
            [runId],
          ),
    );
    return rows.map((row) => ({
      artifact: rowToArtifact(row),
      auditVisible: row.redaction_audit_visible === 1,
    }));
  }

  async isTextEligible(artifactId: string): Promise<boolean> {
    await this.recoverPending();
    const row = await this.exec((db) =>
      dbGet<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE artifact_id = ?",
        [artifactId],
      ),
    );
    if (!row) return false;
    return row.redaction_text_eligible === null
      ? isTextMime(row.mime)
      : row.redaction_text_eligible === 1;
  }

  async replaceAudit(
    artifactId: string,
    audit: Pick<Artifact, "name" | "kind" | "mime" | "path">,
    bytes?: Uint8Array,
    options?: { auditVisible?: false },
  ): Promise<Artifact | undefined> {
    await this.recoverPending();
    const row = await this.exec((db) =>
      dbGet<ArtifactRow>(
        db,
        "SELECT * FROM artifacts WHERE artifact_id = ?",
        [artifactId],
      ),
    );
    if (!row) return undefined;
    const byteCount = bytes?.byteLength ?? row.bytes;
    const textEligible =
      row.redaction_text_eligible ??
      (isTextMime(row.mime) ? 1 : 0);
    let stagedBlobName: string | undefined;
    if (bytes !== undefined) {
      const blobDir = dirname(
        this.blobFilePath(row.run_id, artifactId),
      );
      await fs.mkdir(blobDir, { recursive: true });
      stagedBlobName =
        `.${artifactId}.redacted-${randomUUID()}.blob`;
      await fs.writeFile(
        join(blobDir, stagedBlobName),
        bytes,
      );
    }
    const journalPath = await writeRedactionJournal(
      this.blobsDir,
      {
        version: 1,
        artifactId,
        runId: row.run_id,
        audit,
        byteCount,
        textEligible,
        auditVisible:
          row.redaction_audit_visible === 0 ||
          options?.auditVisible === false
            ? 0
            : 1,
        ...(stagedBlobName !== undefined
          ? { stagedBlobName }
          : {}),
      },
    );
    if (stagedBlobName !== undefined) {
      await moveStagedBlob(
        join(this.blobsDir, row.run_id, stagedBlobName),
        this.blobFilePath(row.run_id, artifactId),
      );
    }
    await this.exec((db) =>
      dbRun(
        db,
        `UPDATE artifacts
         SET name = ?, kind = ?, mime = ?, path_or_uri = ?, bytes = ?,
             redaction_text_eligible = ?,
             redaction_audit_visible =
               CASE
                 WHEN redaction_audit_visible = 0 OR ? = 0 THEN 0
                 ELSE 1
               END
         WHERE artifact_id = ?`,
        [
          audit.name,
          audit.kind,
          audit.mime,
          audit.path,
          byteCount,
          textEligible,
          row.redaction_audit_visible === 0 ||
          options?.auditVisible === false
            ? 0
            : 1,
          artifactId,
        ],
      ),
    );
    if (!this.transactionScoped) {
      await removeFileIfPresent(journalPath);
    }
    return rowToArtifact({
      ...row,
      name: audit.name,
      kind: audit.kind,
      mime: audit.mime,
      path_or_uri: audit.path,
      bytes: byteCount,
      redaction_text_eligible: textEligible,
      redaction_audit_visible:
        row.redaction_audit_visible === 0 ||
        options?.auditVisible === false
          ? 0
          : 1,
    });
  }
}
