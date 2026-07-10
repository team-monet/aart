// data.map — spec §15.3 Data group. Reshapes/renames fields per array item
// without needing an expression language (AART's {{ }} grammar deliberately
// excludes function calls, architecture §3.1) — this block is the
// declarative alternative for "extract/rename a few fields from each item."
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { resolveDataPath } from "../lib/data-path.js";

const inputSchema = z.object({
  items: z.array(z.unknown()),
  fields: z.record(z.string(), z.string()).describe('Output key -> source path within each item, e.g. {"name": "user.name"}.'),
});
const outputSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
});

export const dataMapBlock = defineBlock({
  id: "data.map",
  capabilities: [],
  category: "data",
  description: 'Reshapes each array item into a new object per a field-path mapping. Example: items: [{user:{name:"Ada"}}], fields: {name: "user.name"} -> [{name: "Ada"}].',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const items = await Promise.all(
      input.items.map(async (item) => {
        const mapped: Record<string, unknown> = {};
        for (const [outputKey, path] of Object.entries(input.fields)) {
          mapped[outputKey] = await resolveDataPath(item, path);
        }
        return mapped;
      }),
    );
    return { items };
  },
});
