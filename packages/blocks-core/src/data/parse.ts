// data.parse — spec §15.3 Data group. Capability-free (pure computation
// over already-resolved data, per spec §31.1's explicit zero-capability
// example for this group).
import { z } from "zod";
import { parse as parseYamlDoc } from "yaml";
import { defineBlock } from "../lib/define-block.js";
import { parseCsv } from "../lib/csv.js";

const inputSchema = z.object({
  input: z.string(),
  format: z.enum(["json", "yaml", "csv"]),
});
const outputSchema = z.object({
  value: z.unknown(),
});

export const dataParseBlock = defineBlock({
  id: "data.parse",
  capabilities: [],
  category: "data",
  description: 'Parses a string into structured data. Example: input: "{{ steps.fetch.outputs.body }}", format: "json".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    if (input.format === "json") return { value: JSON.parse(input.input) };
    if (input.format === "yaml") return { value: parseYamlDoc(input.input) };
    return { value: parseCsv(input.input) };
  },
});
