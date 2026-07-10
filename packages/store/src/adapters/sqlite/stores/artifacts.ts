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
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact } from "@aart/types";
import type { ArtifactStore } from "../../../types.js";
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

export class SqliteArtifactStore implements ArtifactStore {
  constructor(
    private readonly exec: SqlExec,
    private readonly blobsDir: string,
  ) {}

  /** This adapter's own physical blob-file location — a pure function of (runId, artifactId), never persisted (see module doc comment). */
  private blobFilePath(runId: string, artifactId: string): string {
    return join(this.blobsDir, runId, `${artifactId}.blob`);
  }

  async put(artifact: Artifact, bytes: Uint8Array): Promise<void> {
    const blobFilePath = this.blobFilePath(artifact.runId, artifact.id);
    await fs.mkdir(dirname(blobFilePath), { recursive: true });
    await fs.writeFile(blobFilePath, bytes);
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO artifacts (artifact_id, run_id, step_id, name, kind, mime, path_or_uri, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           run_id = excluded.run_id, step_id = excluded.step_id, name = excluded.name,
           kind = excluded.kind, mime = excluded.mime, path_or_uri = excluded.path_or_uri,
           bytes = excluded.bytes, created_at = excluded.created_at`,
        [artifact.id, artifact.runId, artifact.stepId ?? null, artifact.name, artifact.kind, artifact.mime, artifact.path, artifact.bytes, artifact.createdAt],
      ),
    );
  }

  async getMetadata(artifactId: string): Promise<Artifact | undefined> {
    const row = await this.exec((db) => dbGet<ArtifactRow>(db, "SELECT * FROM artifacts WHERE artifact_id = ?", [artifactId]));
    return row ? rowToArtifact(row) : undefined;
  }

  async getBytes(artifactId: string): Promise<Uint8Array | undefined> {
    const row = await this.exec((db) => dbGet<ArtifactRow>(db, "SELECT * FROM artifacts WHERE artifact_id = ?", [artifactId]));
    if (!row) return undefined;
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

  async listByRun(runId: string): Promise<Artifact[]> {
    const rows = await this.exec((db) => dbAll<ArtifactRow>(db, "SELECT * FROM artifacts WHERE run_id = ?", [runId]));
    return rows.map(rowToArtifact);
  }
}
