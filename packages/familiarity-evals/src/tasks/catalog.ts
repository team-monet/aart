// catalog.ts — authoring-task fixtures (this session's DoD: "authoring-task
// suite definitions — the actual task fixtures a target model attempts
// zero-shot"), drawn directly from spec §32.3's recipe catalog so each task
// is grounded in an already-named target task type, not invented from
// nothing.
import type { AuthoringTask } from "../types.js";

export const AUTHORING_TASK_CATALOG: AuthoringTask[] = [
  {
    id: "verify-page-renders",
    prompt:
      'Write an AART workflow that opens "https://example.com", reads the rendered page text, and asserts it contains "Example Domain".',
    expectedBlocks: ["browser.goto", "web.read", "assert.contains"],
    tags: ["recipe:verify page renders"],
  },
  {
    id: "check-api-health",
    prompt: "Write an AART workflow that checks whether https://example.com/health returns a healthy response.",
    expectedBlocks: ["http.health_check"],
    tags: ["recipe:check API health"],
  },
  {
    id: "download-and-parse-csv",
    prompt: "Write an AART workflow that downloads a CSV file from a URL and parses it into structured data.",
    expectedBlocks: ["http.download", "data.parse"],
    tags: ["recipe:download and parse CSV"],
  },
  {
    id: "fill-web-form-and-screenshot",
    prompt: "Write an AART workflow that fills in a web form field and captures a screenshot of the result.",
    expectedBlocks: ["browser.fill", "browser.screenshot"],
    tags: ["recipe:fill web form and screenshot"],
  },
  {
    id: "watch-webhook-and-resume",
    prompt: "Write an AART workflow that pauses until a specific webhook event arrives, then continues.",
    expectedBlocks: ["wait.for_webhook"],
    tags: ["recipe:watch webhook and resume"],
  },
  {
    id: "wait-for-human-approval",
    prompt: "Write an AART workflow that pauses for a human to review and approve extracted data before continuing.",
    expectedBlocks: ["human.approval"],
    tags: ["recipe:wait for human approval"],
  },
  {
    id: "call-llm-with-schema",
    prompt: "Write an AART workflow that calls an LLM with a defined prompt and output schema to classify some input text.",
    expectedBlocks: ["llm.call"],
    tags: ["recipe:call LLM with schema"],
  },
  {
    id: "run-eval-before-promotion",
    prompt: "Write an AART workflow step that runs an eval suite against a workflow version before it is promoted.",
    expectedBlocks: ["eval.run"],
    tags: ["recipe:run eval before promotion"],
  },
];
