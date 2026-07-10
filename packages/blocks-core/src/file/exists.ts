// file.exists — spec §15.3 File group. A SENSOR, not an assertion: "the
// file isn't there" is a normal, expected outcome a workflow branches on,
// not a step failure — this block only throws for a genuine error (a path
// escaping the workspace root, per lib/workspace-fs.ts), never for a plain
// missing-file.
import { access } from "node:fs/promises";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { resolveWorkspacePath } from "../lib/workspace-fs.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the configured workspace root (or an absolute path inside it)."),
});
const outputSchema = z.object({
  exists: z.boolean(),
});

export const fileExistsBlock = defineBlock({
  id: "file.exists",
  capabilities: ["file.read"],
  category: "file",
  description: 'Reports whether a file exists in the workspace, without failing when it does not. Example: path: "data/input.json" -> { exists: false } if missing.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const resolved = resolveWorkspacePath(input.path);
    try {
      await access(resolved);
      return { exists: true };
    } catch {
      return { exists: false };
    }
  },
});
