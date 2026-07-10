// BUILTIN_BLOCK_CATALOG — a placeholder block catalog for wiring/testing
// aart_find_blocks / aart_get_block / aart_list_blocks / aart_get_schema.
//
// @aart/blocks-core (S3) — the real owner of the browser/web/http/file/data/
// flow/wait/human/assert/artifact/report/command/eval namespaces (spec
// §15.1-15.3, architecture §1) — is still an S0 `export {}` stub in this
// worktree (S3 builds it in a concurrent, unmerged worktree). This catalog
// is NOT a port of S3's real manifests; it exists only so this session's
// discovery tools (find/get/list/schema) have real, schema-valid
// `BlockManifest` data to search and return, using every block id spec §14.2
// and §32.5's native-feeling-alias table name explicitly. At S9 merge time
// this module is superseded by the real @aart/blocks-core catalog (plus
// @aart/registry's pack-delivered blocks) assembled the way S7's SEAMS.md
// (R2) describes: "whoever assembles the actual local catalog (core
// @aart/blocks-core manifests + store.packManifests-derived pack blocks)."
import type { BlockManifest } from "@aart/types";
import type { BlockCatalogEntry } from "./types.js";

function manifest(m: BlockManifest): BlockManifest {
  return m;
}

const jsonSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

const BLOCKS: BlockManifest[] = [
  manifest({
    id: "browser.goto",
    version: "0.1.0",
    capabilities: ["browser"],
    inputSchema: jsonSchema({ url: { type: "string" } }, ["url"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Navigate a real browser page to a URL. Use this to open the page you're about to inspect or act on — a screenshot or assertion downstream needs a page that's actually loaded, not just fetched.",
    category: "browser",
  }),
  manifest({
    id: "browser.click",
    version: "0.1.0",
    capabilities: ["browser"],
    inputSchema: jsonSchema({ selector: { type: "string" } }, ["selector"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Click a page element by CSS or text= selector.",
    category: "browser",
  }),
  manifest({
    id: "browser.fill",
    version: "0.1.0",
    capabilities: ["browser"],
    inputSchema: jsonSchema({ selector: { type: "string" }, value: { type: "string" } }, ["selector", "value"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Fill a form field by selector.",
    category: "browser",
  }),
  manifest({
    id: "browser.screenshot",
    version: "0.1.0",
    capabilities: ["browser"],
    inputSchema: jsonSchema({ name: { type: "string" } }, ["name"]),
    outputSchema: jsonSchema({ artifact: { type: "string" } }),
    description: "Capture a screenshot of the current page as an evidence artifact — the standard way to make a visual claim ('the page renders correctly') checkable by a human reading the report, not just asserted in prose.",
    category: "browser",
  }),
  manifest({
    id: "web.read",
    version: "0.1.0",
    capabilities: ["browser"],
    inputSchema: jsonSchema({}),
    outputSchema: jsonSchema({ text: { type: "string" } }),
    description: "Read the rendered text of the current (possibly JS-heavy) page compactly — prefer this over browser.html when you need what a human would actually see, not raw markup.",
    category: "browser",
  }),
  manifest({
    id: "http.request",
    version: "0.1.0",
    capabilities: ["http"],
    inputSchema: jsonSchema(
      { method: { type: "string" }, url: { type: "string" }, headers: { type: "object" }, body: {} },
      ["method", "url"],
    ),
    outputSchema: jsonSchema({ status: { type: "number" }, body: {} }),
    description: "Make an HTTP request with the same shape as the fetch API (method/headers/body). Use this for any API call worth repeating — every call is captured in run history, unlike a one-off curl.",
    category: "http",
  }),
  manifest({
    id: "http.download",
    version: "0.1.0",
    capabilities: ["http"],
    inputSchema: jsonSchema({ url: { type: "string" } }, ["url"]),
    outputSchema: jsonSchema({ artifact: { type: "string" } }),
    description: "Download a binary file and attach it as an artifact.",
    category: "http",
  }),
  manifest({
    id: "data.parse",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ text: { type: "string" }, format: { type: "string", enum: ["json", "yaml", "csv"] } }, ["text", "format"]),
    outputSchema: jsonSchema({}),
    description: "Parse JSON, YAML, or CSV text into structured data.",
    category: "data",
  }),
  manifest({
    id: "data.stringify",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ value: {}, format: { type: "string", enum: ["json", "yaml", "csv"] } }, ["value", "format"]),
    outputSchema: jsonSchema({ text: { type: "string" } }),
    description: "Serialize structured data to JSON, YAML, or CSV.",
    category: "data",
  }),
  manifest({
    id: "file.read",
    version: "0.1.0",
    capabilities: ["file.read"],
    inputSchema: jsonSchema({ path: { type: "string" } }, ["path"]),
    outputSchema: jsonSchema({ content: { type: "string" } }),
    description: "Read a file from the workspace.",
    category: "file",
  }),
  manifest({
    id: "file.write",
    version: "0.1.0",
    capabilities: ["file.write"],
    inputSchema: jsonSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Write a file to the workspace.",
    category: "file",
  }),
  manifest({
    id: "flow.sleep",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ ms: { type: "number" } }, ["ms"]),
    outputSchema: jsonSchema({}),
    description: "Pause execution for N milliseconds — combine with a `next` back-edge to poll.",
    category: "flow",
  }),
  manifest({
    id: "flow.fail",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ message: { type: "string" } }),
    outputSchema: jsonSchema({}),
    description: "Fail the run with an intentional error — use this to end a dead-end branch with a clear message instead of letting it fall through silently.",
    category: "flow",
  }),
  manifest({
    id: "wait.for_signal",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ name: { type: "string" }, correlationId: { type: "string" }, timeout: { type: "string" } }, ["name", "correlationId"]),
    outputSchema: jsonSchema({}),
    description: "Durably pause the run until a matching named signal arrives. AART runs and is kept: this step survives a process restart, unlike an in-memory poll loop.",
    category: "wait",
  }),
  manifest({
    id: "wait.until",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ until: { type: "string" } }, ["until"]),
    outputSchema: jsonSchema({}),
    description: "Durably pause the run until a specific timestamp.",
    category: "wait",
  }),
  manifest({
    id: "wait.for_webhook",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ event: { type: "string" }, correlationId: { type: "string" }, timeout: { type: "string" } }, ["event", "correlationId"]),
    outputSchema: jsonSchema({}),
    description: "Durably pause the run until a matching inbound webhook arrives.",
    category: "wait",
  }),
  manifest({
    id: "wait.for_external_job",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ provider: { type: "string" }, jobId: { type: "string" }, timeout: { type: "string" } }, ["provider", "jobId"]),
    outputSchema: jsonSchema({}),
    description: "Durably pause the run until a polled external job (e.g. a long-running third-party task) reports completion.",
    category: "wait",
  }),
  manifest({
    id: "wait.for_queue",
    version: "0.1.0",
    capabilities: ["queue"],
    inputSchema: jsonSchema({ queue: { type: "string" }, correlationId: { type: "string" }, timeout: { type: "string" } }, ["queue", "correlationId"]),
    outputSchema: jsonSchema({}),
    description: "Durably pause the run until a matching message arrives on a queue.",
    category: "wait",
  }),
  manifest({
    id: "wait.manual",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ timeout: { type: "string" } }),
    outputSchema: jsonSchema({}),
    description: "Durably pause the run until manually resumed (aart_resume_run / aart resume).",
    category: "wait",
  }),
  manifest({
    id: "human.approval",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ title: { type: "string" }, description: { type: "string" }, timeout: { type: "string" } }, ["title", "description"]),
    outputSchema: jsonSchema({}),
    description: "Wait for a human approval decision before continuing — creates an ApprovalTask; the agent cannot self-approve (spec §17.5).",
    category: "human",
  }),
  manifest({
    id: "assert.equals",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ actual: {}, expected: {} }, ["actual", "expected"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Assert two values are equal — fails the run loudly (test/expect-shaped, matching Jest/pytest priors) rather than continuing on a silently wrong value.",
    category: "assert",
  }),
  manifest({
    id: "assert.contains",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ value: {}, expected: {} }, ["value", "expected"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Assert a string/array contains a value.",
    category: "assert",
  }),
  manifest({
    id: "assert.jsonpath",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ value: {}, path: { type: "string" }, expected: {} }, ["value", "path"]),
    outputSchema: jsonSchema({ ok: { type: "boolean" } }),
    description: "Assert a JSONPath expression matches against a value.",
    category: "assert",
  }),
  manifest({
    id: "artifact.write",
    version: "0.1.0",
    capabilities: ["file.write"],
    inputSchema: jsonSchema({ name: { type: "string" }, kind: { type: "string" } }, ["name", "kind"]),
    outputSchema: jsonSchema({ artifact: { type: "string" } }),
    description: "Attach a produced artifact (report, file, JSON output) to the run's evidence trail.",
    category: "artifact",
  }),
  manifest({
    id: "report.summarize",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ title: { type: "string" } }, ["title"]),
    outputSchema: jsonSchema({ artifact: { type: "string" } }),
    description: "Summarize a run for a human reader.",
    category: "report",
  }),
  manifest({
    id: "command.run",
    version: "0.1.0",
    capabilities: ["command"],
    inputSchema: jsonSchema({ command: { type: "string" }, args: { type: "array" } }, ["command"]),
    outputSchema: jsonSchema({ stdout: { type: "string" }, stderr: { type: "string" }, exitCode: { type: "number" } }),
    description: "Run a fixed binary + argv template safely (no shell) — turns a CLI command you'd otherwise run by hand into an approved, audited step. Spawned without a shell: an input containing \";\" or \"|\" is a literal argument, never a second command.",
    category: "command",
  }),
  manifest({
    id: "eval.run",
    version: "0.1.0",
    capabilities: [],
    inputSchema: jsonSchema({ suiteId: { type: "string" } }, ["suiteId"]),
    outputSchema: jsonSchema({}),
    description: "Run an eval suite inline as a workflow step.",
    category: "eval",
  }),
  manifest({
    id: "llm.call",
    version: "0.1.0",
    capabilities: ["llm"],
    inputSchema: jsonSchema({ model: { type: "string" }, input: {} }, ["model", "input"]),
    outputSchema: jsonSchema({}),
    description: "Call a model explicitly (provider/model id convention) — every LLM call in AART is a visible, traced step, never a hidden call inside the runtime itself (spec §7.2: AART is a runtime, not an LLM brain).",
    category: "llm",
  }),
];

export const BUILTIN_BLOCK_CATALOG: readonly BlockCatalogEntry[] = BLOCKS.map((m) => ({ manifest: m, examples: [] }));

// spec §32.5's native-feeling-aliases table, verbatim — consumed by
// aart_find_blocks so a familiar phrase ("open page", "read page", "test/
// expect", "run shell safely") resolves to its AART block even when the
// query text doesn't literally contain the block id.
export const NATIVE_ALIASES: Readonly<Record<string, string>> = {
  "open page": "browser.goto",
  "read page": "web.read",
  click: "browser.click",
  screenshot: "browser.screenshot",
  fetch: "http.request",
  "test/expect": "assert.*",
  "output artifact": "artifact.write",
  "wait approval": "human.approval",
  "call model": "llm.call",
  "run shell safely": "command.run",
};
