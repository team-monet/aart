// assert.artifact_exists — spec §15.3 Assert group. Capability
// ["file.read"] — UNLIKE the other 6 assert.* blocks (all capability-free,
// pure comparisons over already-provided data), this one performs a real
// filesystem existence check against a resolved artifact path, which is a
// genuine file.read-shaped operation. Deliberately does NOT route through
// lib/workspace-fs.ts's resolveWorkspacePath: an artifact's path (as
// returned by ctx.writeArtifact) may legitimately live outside the
// workspace root entirely (a separate artifact-store directory), so the
// file.* group's workspace-traversal guard would incorrectly reject a
// perfectly valid artifact path here.
import { access } from "node:fs/promises";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";

const inputSchema = z.object({
  path: z.string().describe("An artifact's stored path, typically {{ steps.<id>.outputs.path }} from a prior artifact.write/browser.screenshot/http.download/etc."),
});
const outputSchema = z.object({
  passed: z.literal(true),
  path: z.string(),
});

export const assertArtifactExistsBlock = defineBlock({
  id: "assert.artifact_exists",
  capabilities: ["file.read"],
  category: "assert",
  description: 'Fails the run unless an artifact exists at path. Example: path: "{{ steps.capture.outputs.path }}".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    let exists = true;
    try {
      await access(input.path);
    } catch {
      exists = false;
    }
    assertOrThrow("assert.artifact_exists", exists, `artifact not found at "${input.path}"`, { path: input.path });
    return { passed: true as const, path: input.path };
  },
});
