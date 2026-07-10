// file.read — spec §15.3 File group, "workspace-scoped" per §31.1. Every
// path goes through lib/workspace-fs.ts's traversal guard before touching
// the filesystem — see that module's doc comment for why this exists
// alongside (not instead of) the coarse file.read capability grant.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { resolveWorkspacePath } from "../lib/workspace-fs.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the configured workspace root (or an absolute path inside it)."),
  encoding: z.enum(["utf8", "base64"]).optional().describe('Defaults to "utf8".'),
});
const outputSchema = z.object({
  content: z.string(),
});

export const fileReadBlock = defineBlock({
  id: "file.read",
  capabilities: ["file.read"],
  category: "file",
  description: 'Reads a file from the workspace. Example: path: "data/input.json", encoding: "utf8".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const resolved = resolveWorkspacePath(input.path);
    const content = await readFile(resolved, { encoding: input.encoding ?? "utf8" });
    return { content };
  },
});
