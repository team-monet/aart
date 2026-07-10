// data.pick — spec §15.3 Data group. Picks a set of property paths out of
// `from` into a flat result object keyed by the FULL path string (not the
// path's last segment) — this avoids a silent collision when two picked
// paths share a last segment (e.g. "user.id" and "order.id") and keeps the
// mapping unambiguously round-trippable. Capability-free: a pure,
// deterministic transform over already-resolved data (spec §31.1's
// explicit "data.*" zero-capability example).
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { resolveDataPath } from "../lib/data-path.js";

const inputSchema = z.object({
  from: z.unknown().describe("The object to pick properties from."),
  paths: z.array(z.string()).describe('Property paths to extract, e.g. ["user.name", "items[0].id"].'),
});
const outputSchema = z.object({
  value: z.record(z.string(), z.unknown()).describe('The picked properties, keyed by their full source path (e.g. "user.name").'),
});

export const dataPickBlock = defineBlock({
  id: "data.pick",
  capabilities: [],
  category: "data",
  description:
    'Picks a set of property paths out of an object into a flat result keyed by path. Example: from: {{ steps.fetch.outputs.body }}, paths: ["user.name", "user.email"] -> { "user.name": "Ada", "user.email": "ada@example.com" }.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const value: Record<string, unknown> = {};
    for (const path of input.paths) {
      value[path] = await resolveDataPath(input.from, path);
    }
    return { value };
  },
});
