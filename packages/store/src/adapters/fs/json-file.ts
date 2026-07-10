// Low-level atomic JSON file I/O + the staging-buffer mechanism transact()
// is built on (architecture §5.8).
//
// The fs adapter has no native cross-file transaction primitive. This
// module's `StagingBuffer` is what `transact()` (adapters/fs/index.ts)
// uses to give a real, testable all-or-nothing guarantee for the writes
// that actually need it (co-located in a single run file per architecture's
// design, but this mechanism is written generically over "any file touched
// during the callback," not hard-coded to the run-file case specifically):
// every write/delete issued through a staged `KeyedJsonCollection` is held
// in memory, keyed by absolute file path (so N writes to the same file
// within one transaction coalesce to the last value); nothing touches disk
// until the transaction's callback resolves, at which point every staged
// entry is flushed as its own atomic write-temp-then-rename (or removed).
// If the callback throws, the buffer is discarded — nothing was ever
// written.
import { promises as fs } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export interface StagingBuffer {
  /** absolute file path -> pending JSON content (write) | null (delete) */
  readonly pending: Map<string, Buffer | null>;
}

export function createStagingBuffer(): StagingBuffer {
  return { pending: new Map() };
}

async function atomicWriteFile(path: string, content: Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${basename(path)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, path);
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

/** Flushes every staged write/delete to disk. Called by `transact()` only after its callback has resolved successfully. */
export async function flushStagingBuffer(buffer: StagingBuffer): Promise<void> {
  for (const [path, content] of buffer.pending) {
    if (content === null) {
      await removeFileIfExists(path);
    } else {
      await atomicWriteFile(path, content);
    }
  }
}

/** A single JSON-file-backed record, with optional staging. */
export class JsonFileHandle<T> {
  constructor(
    private readonly path: string,
    private readonly staging?: StagingBuffer,
  ) {}

  async read(): Promise<T | undefined> {
    if (this.staging?.pending.has(this.path)) {
      const staged = this.staging.pending.get(this.path);
      if (staged === null) return undefined;
      return JSON.parse(staged!.toString("utf8")) as T;
    }
    try {
      const buf = await fs.readFile(this.path);
      return JSON.parse(buf.toString("utf8")) as T;
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }

  async write(value: T): Promise<void> {
    const buf = Buffer.from(JSON.stringify(value, null, 2), "utf8");
    if (this.staging) {
      this.staging.pending.set(this.path, buf);
      return;
    }
    await atomicWriteFile(this.path, buf);
  }

  async delete(): Promise<void> {
    if (this.staging) {
      this.staging.pending.set(this.path, null);
      return;
    }
    await removeFileIfExists(this.path);
  }
}

async function listDirEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/**
 * A directory of `<key>.json` files, keyed by an arbitrary string
 * (composite keys are the caller's job to encode/decode, e.g.
 * `${workflowId}__${version}`). Reused across most `AartStore` members —
 * the ones with genuinely different shapes (ArtifactStore's blob+metadata
 * pairing, SignalStore/WaitStore's scan-oriented queries) are implemented
 * separately in adapters/fs/index.ts, on top of the same JsonFileHandle/
 * staging primitives.
 */
export class KeyedJsonCollection<T> {
  constructor(
    private readonly dir: string,
    private readonly staging?: StagingBuffer,
  ) {}

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<T | undefined> {
    return new JsonFileHandle<T>(this.pathFor(key), this.staging).read();
  }

  async put(key: string, value: T): Promise<void> {
    return new JsonFileHandle<T>(this.pathFor(key), this.staging).write(value);
  }

  async delete(key: string): Promise<void> {
    return new JsonFileHandle<T>(this.pathFor(key), this.staging).delete();
  }

  async listKeys(): Promise<string[]> {
    const onDisk = (await listDirEntries(this.dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")).map((f) => f.slice(0, -".json".length));
    const keys = new Set(onDisk);
    if (this.staging) {
      const prefix = this.dir.endsWith(sep) ? this.dir : this.dir + sep;
      for (const [path, content] of this.staging.pending) {
        if (!path.startsWith(prefix)) continue;
        const key = basename(path, ".json");
        if (content === null) keys.delete(key);
        else keys.add(key);
      }
    }
    return Array.from(keys).sort();
  }

  async list(): Promise<T[]> {
    const keys = await this.listKeys();
    const values: Array<T | undefined> = await Promise.all(keys.map((k) => this.get(k)));
    const result: T[] = [];
    for (const value of values) {
      if (value !== undefined) result.push(value);
    }
    return result;
  }

  /** Rebinds this collection to a (possibly undefined) staging buffer — how `transact()` constructs its `tx` view over the same on-disk directories. */
  withStaging(staging: StagingBuffer | undefined): KeyedJsonCollection<T> {
    return new KeyedJsonCollection<T>(this.dir, staging);
  }
}
