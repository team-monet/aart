// file.list — spec §15.3 File group. `pattern` is a deliberately minimal
// glob — only `*` as an "any characters" wildcard, no `?`/character
// classes/brace expansion — the smallest primitive that covers the common
// case (same philosophy flow.branch's doc comment applies to branching).
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { resolveWorkspacePath } from "../lib/workspace-fs.js";

const inputSchema = z.object({
  path: z.string().describe("Directory path relative to the configured workspace root (or an absolute path inside it)."),
  pattern: z.string().optional().describe('A simple glob using "*" as a wildcard, e.g. "*.txt". Matches all entries when omitted.'),
});
const outputSchema = z.object({
  entries: z.array(z.string()),
});

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export const fileListBlock = defineBlock({
  id: "file.list",
  capabilities: ["file.read"],
  category: "file",
  description: 'Lists entries in a workspace directory, optionally filtered by a simple glob. Example: path: "data", pattern: "*.txt" -> { entries: ["a.txt", "b.txt"] }.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const resolved = resolveWorkspacePath(input.path);
    const entries = await readdir(resolved);
    if (input.pattern === undefined) {
      return { entries };
    }
    const regex = globToRegExp(input.pattern);
    return { entries: entries.filter((entry) => regex.test(entry)) };
  },
});
