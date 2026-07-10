// wait.for_external_job — spec §15.3 Wait group. See wait/for-signal.ts's
// module doc comment for the group's shared design rationale. This member
// waits for a long-running job in an external system (e.g. a batch
// pipeline) to complete, tracked by provider + jobId.
import { z } from "zod";
import { WaitConditionExternalJobSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  provider: z.string().describe('The external system running the job, e.g. "databricks", "airflow".'),
  jobId: z.string().describe("The provider's own job identifier to poll/track."),
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if the job hasn't completed in time."),
});
const outputSchema = WaitConditionExternalJobSchema.omit({ schemaVersion: true });

export const waitForExternalJobBlock = defineBlock({
  id: "wait.for_external_job",
  capabilities: [],
  category: "wait",
  description:
    'Pauses the workflow until an external job completes. Example: provider: "databricks", jobId: "{{ steps.submit_job.outputs.jobId }}". The engine persists this as a WaitCondition and resumes the run once the provider reports completion.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { type: "external_job" as const, provider: input.provider, jobId: input.jobId, timeout: input.timeout };
  },
});
