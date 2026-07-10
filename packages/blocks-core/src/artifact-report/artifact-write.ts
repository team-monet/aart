// artifact.write — spec §15.3 Artifact/report group. The one block whose
// entire job is calling the frozen `BlockExecutionContext.writeArtifact`
// (architecture §2.5) — everything else here is converting a `content`
// string into the `Uint8Array` that contract expects. Capability
// `file.write`, per spec §31.1's explicit pairing: "file.write
// (workspace-scoped) | Medium | file.write, artifact.write".
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  name: z.string().describe('Artifact display name, e.g. "checkout-screenshot.png".'),
  kind: z.string().describe("One of ARTIFACT_KINDS (@aart/types) or a pack-introduced kind — screenshot/file/report/download/trace/console_log/network_log/json_output/pdf/csv/html/diff."),
  mime: z.string().describe('e.g. "image/png", "application/json".'),
  content: z.string().describe("The artifact's content."),
  encoding: z.enum(["utf8", "base64"]).optional().describe('How to decode `content` into bytes. Defaults to "utf8".'),
});
const outputSchema = z.object({
  id: z.string(),
  path: z.string(),
});

export const artifactWriteBlock = defineBlock({
  id: "artifact.write",
  capabilities: ["file.write"],
  category: "artifact",
  description: 'Persists evidence produced during a run as an Artifact. Example: name: "result.json", kind: "json_output", mime: "application/json", content: "{{ steps.compute.outputs }}".',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const bytes = Buffer.from(input.content, input.encoding ?? "utf8");
    const written = await ctx.writeArtifact({ name: input.name, kind: input.kind, mime: input.mime, bytes: new Uint8Array(bytes) });
    return { id: written.id, path: written.path };
  },
});
