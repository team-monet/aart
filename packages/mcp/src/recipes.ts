// Recipes — structured retrieval targets, spec §32.3 / architecture §10.5.
//
// `type Recipe = { id: string; triggerPhrases: string[]; skeleton: string }`
// — "models are reliably good at instantiating a skeleton and reliably weak
// at composing a multi-step workflow from raw blocks with no scaffold."
//
// `[DECISION]` (architecture §10.5): stored as static data shipped with the
// package, not a store-backed/editable entity in v1 — spec's initial
// catalog (9 recipes, listed verbatim below in spec §32.3's own order) is
// fixed content. `aart_propose_workflow` matches `triggerPhrases` against
// the agent's request via simple substring/fuzzy match — `[DECISION]`: no
// embedding-based semantic match in v1, the phrase lists are small and
// hand-curated, so lexical matching is sufficient.
//
// The last two recipes (spec §32.3's own list order) describe an
// AUTHORING-LOOP tool-call sequence rather than a runnable workflow — their
// `skeleton` is a short annotated tool-call snippet, not `uses`/`with` YAML,
// since "create an eval from a correction" and "gate promotion on an eval
// pass" are operations ON the authoring loop itself, not workflows a run
// executes.
export interface Recipe {
  id: string;
  triggerPhrases: string[];
  skeleton: string;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: "verify-page-renders",
    triggerPhrases: [
      "verify page renders",
      "check the page renders",
      "does the page load",
      "check whether the dashboard loads",
      "verify a web page works",
    ],
    skeleton: `id: verify-page-renders
name: Verify Page Renders
version: 0.1.0
inputs:
  url:
    type: string
    required: true
  expectedText:
    type: string
    required: true
steps:
  - id: open
    uses: browser.goto
    with:
      url: "{{ inputs.url }}"
  - id: read
    uses: web.read
  - id: assert
    uses: assert.contains
    with:
      value: "{{ steps.read.outputs.text }}"
      expected: "{{ inputs.expectedText }}"
  - id: screenshot
    uses: browser.screenshot
    with:
      name: verify-page-renders
`,
  },
  {
    id: "check-api-health",
    triggerPhrases: ["check api health", "check API health", "health check", "is the api up", "is the service reachable"],
    skeleton: `id: check-api-health
name: Check API Health
version: 0.1.0
inputs:
  url:
    type: string
    required: true
steps:
  - id: ping
    uses: http.request
    with:
      method: GET
      url: "{{ inputs.url }}"
  - id: assert
    uses: assert.equals
    with:
      actual: "{{ steps.ping.outputs.status }}"
      expected: 200
`,
  },
  {
    id: "download-and-parse-csv",
    triggerPhrases: ["download and parse csv", "download and parse a csv", "fetch a csv and parse it", "pull a csv report"],
    skeleton: `id: download-and-parse-csv
name: Download And Parse CSV
version: 0.1.0
inputs:
  url:
    type: string
    required: true
steps:
  - id: download
    uses: http.download
    with:
      url: "{{ inputs.url }}"
  - id: read
    uses: file.read
    with:
      path: "{{ steps.download.outputs.artifact }}"
  - id: parse
    uses: data.parse
    with:
      text: "{{ steps.read.outputs.content }}"
      format: csv
`,
  },
  {
    id: "fill-web-form-and-screenshot",
    triggerPhrases: [
      "fill web form and screenshot",
      "fill out a form and take a screenshot",
      "submit a form and capture evidence",
      "fill a form and screenshot",
    ],
    skeleton: `id: fill-web-form-and-screenshot
name: Fill Web Form And Screenshot
version: 0.1.0
inputs:
  url:
    type: string
    required: true
  value:
    type: string
    required: true
steps:
  - id: open
    uses: browser.goto
    with:
      url: "{{ inputs.url }}"
  - id: fill
    uses: browser.fill
    with:
      selector: "input"
      value: "{{ inputs.value }}"
  - id: submit
    uses: browser.click
    with:
      selector: "text=Submit"
  - id: screenshot
    uses: browser.screenshot
    with:
      name: after-submit
`,
  },
  {
    id: "watch-webhook-and-resume",
    triggerPhrases: ["watch webhook and resume", "wait for a webhook then continue", "pause until a webhook arrives", "resume on webhook"],
    skeleton: `id: watch-webhook-and-resume
name: Watch Webhook And Resume
version: 0.1.0
inputs:
  correlationId:
    type: string
    required: true
steps:
  - id: wait
    uses: wait.for_webhook
    with:
      event: external-update
      correlationId: "{{ inputs.correlationId }}"
      timeout: 24h
  - id: report
    uses: report.summarize
    with:
      title: "Webhook received, resuming"
`,
  },
  {
    id: "wait-for-human-approval",
    triggerPhrases: ["wait for human approval", "require human approval", "pause for approval", "need a human to approve this step"],
    skeleton: `id: wait-for-human-approval
name: Wait For Human Approval
version: 0.1.0
steps:
  - id: approve
    uses: human.approval
    with:
      title: "Approve this action"
      description: "Review before this workflow continues."
      timeout: 48h
`,
  },
  {
    id: "call-llm-with-schema",
    triggerPhrases: ["call llm with schema", "call a model with a schema", "extract structured data with an llm", "use an llm to extract fields"],
    skeleton: `id: call-llm-with-schema
name: Call LLM With Schema
version: 0.1.0
inputs:
  text:
    type: string
    required: true
steps:
  - id: extract
    uses: llm.call
    with:
      model: "anthropic/claude-sonnet-5"
      input: "{{ inputs.text }}"
`,
  },
  {
    id: "create-eval-from-correction",
    triggerPhrases: ["create eval from correction", "turn this correction into a test", "add a regression test from this fix", "create an eval example from a correction"],
    skeleton: `# Authoring-loop pattern (tool calls, not a workflow):
1. aart_record_correction({ runId, stepId, fieldPath, observed, corrected, reason, reviewer })
2. aart_create_eval_from_correction({ runId, stepId, fieldPath, suiteId })
   -> a new EvalExample is added to <suiteId>, expected = the corrected value.
3. aart_run_eval({ suiteId, workflowId, workflowVersion }) to confirm the fix holds.
`,
  },
  {
    id: "run-eval-before-promotion",
    triggerPhrases: ["run eval before promotion", "run evals before promoting", "gate promotion on eval pass", "check evals before shipping"],
    skeleton: `# Authoring-loop pattern (tool calls, not a workflow):
1. aart_run_eval({ suiteId, workflowId, workflowVersion })
   -> writes an EvalRun; check .failed === 0 before proceeding.
2. aart_promote_workflow({ workflowId, workflowVersion })
   -> refuses to promote while the "evals" gate (production mode) is unmet.
`,
  },
];

/** Whole-word tokens only (lowercased) — `.includes()` substring matching alone would let a short token like "on" false-positive-match inside an unrelated word like "python". */
function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

// Common connector words excluded from the token-overlap signal — two
// unrelated phrases both containing "the"/"is"/"for" is noise, not real
// conceptual overlap. Deliberately small (this is lexical matching over a
// small hand-curated phrase list, architecture §10.5's own stated scope,
// not a general-purpose NLP stopword list).
export const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "of", "for", "and", "or", "but", "with", "from",
  "this", "that", "these", "those", "it", "its", "as", "by", "so", "if",
]);

function phraseScore(phrase: string, request: string): number {
  const p = phrase.toLowerCase().trim();
  const r = request.toLowerCase().trim();
  if (p === r) return 100;
  if (r.includes(p) || p.includes(r)) return 70;
  const requestWords = wordSet(r);
  const phraseTokens = p.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (phraseTokens.length === 0) return 0;
  const overlap = phraseTokens.filter((t) => requestWords.has(t)).length;
  return overlap > 0 ? (overlap / phraseTokens.length) * 40 : 0;
}

export interface RecipeMatch {
  recipe: Recipe;
  score: number;
  matchedPhrase: string;
}

/** Every recipe whose best `triggerPhrases` match scores > 0, sorted best-first. */
export function matchRecipes(request: string): RecipeMatch[] {
  const results: RecipeMatch[] = [];
  for (const recipe of RECIPES) {
    let best = 0;
    let bestPhrase = "";
    for (const phrase of recipe.triggerPhrases) {
      const s = phraseScore(phrase, request);
      if (s > best) {
        best = s;
        bestPhrase = phrase;
      }
    }
    if (best > 0) results.push({ recipe, score: best, matchedPhrase: bestPhrase });
  }
  return results.sort((a, b) => b.score - a.score);
}

/** The single best-matching recipe, or `undefined` if nothing scores above 0 (`aart_propose_workflow` falls back to "no match" — it never calls an LLM to invent one, spec §34's own note). */
export function matchRecipe(request: string): Recipe | undefined {
  return matchRecipes(request)[0]?.recipe;
}
