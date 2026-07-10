// data.merge — spec §15.3 Data group. "deep" recursively merges plain
// objects key-by-key; arrays and non-object values are always REPLACED
// wholesale by the later object's value, never concatenated — called out
// explicitly since it's not the only reasonable interpretation of "deep
// merge" and this package commits to one.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  objects: z.array(z.record(z.string(), z.unknown())),
  strategy: z.enum(["shallow", "deep"]).optional().describe('Defaults to "shallow".'),
});
const outputSchema = z.object({
  value: z.record(z.string(), z.unknown()),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeTwo(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a };
  for (const [key, bValue] of Object.entries(b)) {
    const aValue = result[key];
    result[key] = isPlainObject(aValue) && isPlainObject(bValue) ? deepMergeTwo(aValue, bValue) : bValue;
  }
  return result;
}

export const dataMergeBlock = defineBlock({
  id: "data.merge",
  capabilities: [],
  category: "data",
  description:
    'Merges N objects in order, later wins. Example: objects: [{a:1,b:{x:1}}, {b:{y:2}}], strategy: "deep" -> {a:1,b:{x:1,y:2}}. Arrays are always replaced wholesale, never concatenated, in either strategy.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    if ((input.strategy ?? "shallow") === "shallow") {
      return { value: Object.assign({}, ...input.objects) as Record<string, unknown> };
    }
    return { value: input.objects.reduce((acc, obj) => deepMergeTwo(acc, obj), {} as Record<string, unknown>) };
  },
});
