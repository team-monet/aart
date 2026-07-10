// Shared by both ServerPort implementations (stubs/server.ts,
// real-server-port.ts) — ServerPort.writeBundleToDisk(bundle: BundleLike,
// outDir) only ever needs to write a flat relPath->content map to disk;
// that's pure I/O with no dependency on which produceBundle implementation
// built the map, so both implementations call this one function rather than
// each carrying its own (previously duplicated in stubs/server.ts) copy.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeBundleFilesToDisk(files: Record<string, string>, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(outDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
}
