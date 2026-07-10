// file.write — spec §15.3 File group, "workspace-scoped" per §31.1 (same
// traversal guard as file.read — see lib/workspace-fs.ts's doc comment).
// Creates any missing parent directories before writing, so a workflow can
// write to a nested path in one step without a separate mkdir-equivalent
// block.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { resolveWorkspacePath } from "../lib/workspace-fs.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the configured workspace root (or an absolute path inside it)."),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional().describe('Defaults to "utf8".'),
});
const outputSchema = z.object({
  path: z.string(),
  bytes: z.number(),
});

export const fileWriteBlock = defineBlock({
  id: "file.write",
  capabilities: ["file.write"],
  category: "file",
  description:
    'Writes content to a file in the workspace, creating parent directories as needed. Example: path: "output/report.txt", content: "hello", encoding: "utf8".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const resolved = resolveWorkspacePath(input.path);
    await mkdir(dirname(resolved), { recursive: true });
    const buf = Buffer.from(input.content, input.encoding ?? "utf8");
    await writeFile(resolved, buf);
    return { path: resolved, bytes: buf.length };
  },
});
