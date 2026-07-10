// Artifact — spec §13.7.
import { z } from "zod";

export const ARTIFACT_KINDS = [
  "screenshot",
  "file",
  "report",
  "download",
  "trace",
  "console_log",
  "network_log",
  "json_output",
  "pdf",
  "csv",
  "html",
  "diff",
] as const;

export const ArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string().optional(),
  name: z.string(),
  // spec §13.7's `kind` is documented via a prose list (this module's
  // ARTIFACT_KINDS above), not an explicit closed TS union in the type
  // block itself — kept as z.string() rather than z.enum(ARTIFACT_KINDS) so
  // a pack-introduced artifact kind isn't rejected by @aart/types itself.
  kind: z.string(),
  mime: z.string(),
  path: z.string(),
  bytes: z.number(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
