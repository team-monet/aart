// data.stringify — spec §15.3 Data group. Capability-free, the inverse of
// data.parse.
import { z } from "zod";
import { stringify as stringifyYamlDoc } from "yaml";
import { defineBlock } from "../lib/define-block.js";
import { stringifyCsv } from "../lib/csv.js";

const inputSchema = z.object({
  value: z.unknown(),
  format: z.enum(["json", "yaml", "csv"]),
  pretty: z.boolean().optional().describe('Only affects "json" (2-space indent when true). Defaults to false (compact).'),
});
const outputSchema = z.object({
  output: z.string(),
});

export const dataStringifyBlock = defineBlock({
  id: "data.stringify",
  capabilities: [],
  category: "data",
  description:
    'Serializes structured data to a string. Example: value: "{{ steps.compute.outputs }}", format: "json", pretty: true. For "csv", value must be an array of flat records (Record<string, unknown>[]).',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    if (input.format === "json") return { output: JSON.stringify(input.value, null, input.pretty ? 2 : undefined) };
    if (input.format === "yaml") return { output: stringifyYamlDoc(input.value) };
    return { output: stringifyCsv(input.value as Record<string, unknown>[]) };
  },
});
