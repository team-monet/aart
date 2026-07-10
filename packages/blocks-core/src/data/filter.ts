// data.filter — spec §15.3 Data group. A declarative, path-based predicate
// (equals/notEquals/exists) over each array item — same "no expression
// language needed" philosophy as data.map.
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { tryResolveDataPath } from "../lib/data-path.js";

const inputSchema = z.object({
  items: z.array(z.unknown()),
  path: z.string(),
  equals: z.unknown().optional(),
  notEquals: z.unknown().optional(),
  exists: z.boolean().optional().describe("If omitted alongside equals/notEquals, defaults to true (keep items where path resolves)."),
});
const outputSchema = z.object({
  items: z.array(z.unknown()),
});

export const dataFilterBlock = defineBlock({
  id: "data.filter",
  capabilities: [],
  category: "data",
  description: 'Filters an array by a path-based predicate. Example: items: "{{ steps.fetch.outputs.rows }}", path: "status", equals: "active".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const noPredicateGiven = input.equals === undefined && input.notEquals === undefined && input.exists === undefined;
    const items: unknown[] = [];
    for (const item of input.items) {
      const resolved = await tryResolveDataPath(item, input.path);
      let keep = true;
      if (noPredicateGiven) {
        keep = resolved.found;
      } else {
        if (input.exists !== undefined) keep = keep && resolved.found === input.exists;
        if (input.equals !== undefined) keep = keep && resolved.found && isDeepStrictEqual(resolved.value, input.equals);
        if (input.notEquals !== undefined) keep = keep && (!resolved.found || !isDeepStrictEqual(resolved.value, input.notEquals));
      }
      if (keep) items.push(item);
    }
    return { items };
  },
});
