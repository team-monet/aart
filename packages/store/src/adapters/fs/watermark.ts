// fs-backed MigrationWatermarkStore — `.aart/schema-version.json` (architecture §5.2/§5.5).
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { MigrationWatermarkStore } from "../../migrations/types.js";
import { schemaVersionFile } from "./paths.js";

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

export class FsMigrationWatermarkStore implements MigrationWatermarkStore {
  constructor(private readonly root: string) {}

  async read(): Promise<number> {
    try {
      const buf = await fs.readFile(schemaVersionFile(this.root));
      const parsed = JSON.parse(buf.toString("utf8")) as { version?: number };
      return parsed.version ?? 0;
    } catch (err) {
      if (isEnoent(err)) return 0;
      throw err;
    }
  }

  async write(version: number): Promise<void> {
    const path = schemaVersionFile(this.root);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ version }, null, 2));
  }
}
