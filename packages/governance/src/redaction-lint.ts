// Redaction-bypass lint / architecture test (ADR-10's consequences,
// architecture §7.9-adjacent) — the structural backstop alongside the
// chokepoint itself. Flags any store.write/console.log/MCP-tool-return call
// site that doesn't visibly pass through `redactRecord` first.
//
// CRITICAL: this must recognize @aart/engine's constructor-injection
// pattern (a RedactFn-TYPED field/parameter being CALLED — e.g.
// `this.redact(record, secretRefs)`), not just a literal `redactRecord(...)`
// import — the engine never imports `redactRecord` directly (architecture
// §4.6/§7.9), it calls its own constructor-injected `RedactFn`. A lint that
// only greps for the literal import would silently miss every engine call
// site, which is exactly the failure mode this check exists to prevent.
import { promises as fs } from "node:fs";
import { join, sep } from "node:path";

export interface RedactionLintFinding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

const CONSOLE_CALL_PATTERN = /\bconsole\.(log|error|warn|info)\s*\(/;

// Known AartStore write-surface member names (store/src/types.ts) — a call
// of the shape `<expr>.<member>.put(` / `.append(` is a store-write call
// site regardless of what the receiver expression is named.
const STORE_WRITE_MEMBERS = [
  "runs",
  "approvals",
  "waits",
  "artifacts",
  "corrections",
  "rejectedTriggers",
  "standingApprovals",
  "evals",
  "deployments",
  "environments",
  "schedules",
  "promptRegistry",
  "schemaRegistry",
  "packManifests",
] as const;
const STORE_WRITE_PATTERN = new RegExp(`\\.(${STORE_WRITE_MEMBERS.join("|")})\\.(put|append)\\s*\\(`);

const REDACT_RECORD_CALL_PATTERN = /\bredactRecord(WithNames)?\s*\(/;

/**
 * Strips a trailing `//` line comment before guard-pattern matching — a
 * comment merely MENTIONING a call (e.g. "// BUG: forgot to call
 * this.redact(...)") must never count as evidence the call actually
 * happened. Deliberately simple (first `//` wins, no string-literal
 * awareness) — an acceptable tradeoff for an advisory architecture lint,
 * not a compiler; the rare false-negative-on-stripping case (a `//` inside
 * a quoted string earlier on the same line as a real guard call) is far
 * less likely and far lower-stakes than a comment silently suppressing a
 * real finding, which is the failure mode this exists to close.
 */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

// Captures an identifier bound to the RedactFn type — e.g.
// `constructor(private readonly redact: RedactFn)`, `redactFn: RedactFn`,
// `#redact: RedactFn`. This is how the lint recognizes the
// constructor-injection pattern rather than only a literal import.
const REDACT_FN_BINDING_PATTERN = /(?:readonly\s+)?(#?[A-Za-z_$][\w$]*)\s*:\s*RedactFn\b/g;

function findRedactFnBoundIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(REDACT_FN_BINDING_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.replace(/^#/, ""));
  }
  return names;
}

function isGuardedByInjectedRedactFn(window: string, boundIdentifiers: ReadonlySet<string>): boolean {
  for (const name of boundIdentifiers) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches `redact(`, `this.redact(`, `this.#redact(`, `self.redact(` —
    // any plain or member-access CALL of a RedactFn-bound identifier — OR
    // `identifier,`/`identifier)` — the identifier PASSED AS AN ARGUMENT to
    // a shared helper that itself calls it (e.g. @aart/engine's real
    // pattern: `applyRedaction(config.redact, record, secretRefs)`,
    // redaction.ts, rather than every one of engine's dozen-plus persist
    // call sites repeating `config.redact(...)` inline). Verified against
    // the real merged @aart/engine at S9 integration time: the direct-call
    // form alone produced 15 false-positive findings across
    // run-lifecycle.ts/step-executor.ts/wait-machine.ts/concurrency.ts, all
    // genuinely-redacted call sites routed through this exact indirection.
    if (new RegExp(`(?:\\bthis\\.#?|\\b)${escaped}\\s*[(,)]`).test(window)) return true;
  }
  return false;
}

/**
 * Naive per-character brace-depth tracking across the whole file — good
 * enough for this heuristic's purpose (scoping a "was it guarded nearby"
 * search to the enclosing function/method body, not a hard compiler-grade
 * parse of string/comment/regex-literal contexts).
 */
function computeLineDepths(lines: readonly string[]): { startDepth: number[]; endDepth: number[] } {
  const startDepth: number[] = [];
  const endDepth: number[] = [];
  let depth = 0;
  for (const line of lines) {
    startDepth.push(depth);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    endDepth.push(depth);
  }
  return { startDepth, endDepth };
}

/**
 * The line index (0-based) where the block CONTAINING line `i` began —
 * i.e., scope a "guarded nearby" search to line i's own enclosing
 * function/method/block, not an arbitrary fixed-line-count window that can
 * bleed across sibling methods (a real false-negative this module's own
 * test suite caught: two sibling methods on one class, the first correctly
 * guarded, the second a real bypass a fixed 8-line lookback missed because
 * it could still see the FIRST method's guard call).
 */
function findEnclosingBlockStart(i: number, startDepth: readonly number[], endDepth: readonly number[]): number {
  const targetDepth = startDepth[i] ?? 0;
  for (let j = i - 1; j >= 0; j--) {
    if ((endDepth[j] ?? 0) < targetDepth) return j + 1;
  }
  return 0;
}

/**
 * Lints a single file's already-read source text. Exported directly (not
 * just the directory-walking entry point below) so this package's own test
 * suite can exercise it against controlled fixture strings — including a
 * fixture reproducing the engine's exact constructor-injection pattern —
 * without needing separately-compilable fixture files on disk.
 */
export function lintSource(filePath: string, source: string): RedactionLintFinding[] {
  const findings: RedactionLintFinding[] = [];
  const boundIdentifiers = findRedactFnBoundIdentifiers(source);
  const isMcpFile = filePath.includes(`${sep}mcp${sep}`) || filePath.includes("/mcp/");
  const lines = source.split("\n");
  const { startDepth, endDepth } = computeLineDepths(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const isConsole = CONSOLE_CALL_PATTERN.test(line);
    const isStoreWrite = STORE_WRITE_PATTERN.test(line);
    const isMcpReturn = isMcpFile && /^\s*return\b/.test(line) && !/^\s*return\s*;\s*$/.test(line) && !/^\s*return\s+(true|false|undefined|null)\s*;?\s*$/.test(line);
    if (!isConsole && !isStoreWrite && !isMcpReturn) continue;

    // A risky call site is GUARDED if its OWN ENCLOSING BLOCK (the current
    // function/method body — found via brace-depth tracking, not a fixed
    // line-count window, which would bleed across sibling methods) either
    // calls `redactRecord(`/`redactRecordWithNames(` directly, or calls a
    // RedactFn-bound identifier (the constructor-injection pattern), at or
    // before this line.
    const blockStart = findEnclosingBlockStart(i, startDepth, endDepth);
    const window = lines.slice(blockStart, i + 1).map(stripLineComment).join("\n");
    const directlyGuarded = REDACT_RECORD_CALL_PATTERN.test(window);
    const injectedGuarded = isGuardedByInjectedRedactFn(window, boundIdentifiers);
    if (directlyGuarded || injectedGuarded) continue;

    findings.push({
      file: filePath,
      line: i + 1,
      snippet: line.trim(),
      reason: isConsole
        ? "console.* call not visibly routed through redactRecord"
        : isStoreWrite
          ? "store write call not visibly routed through redactRecord"
          : "MCP-tool return not visibly routed through redactRecord",
    });
  }
  return findings;
}

// This lint's OWN diagnostic-output files are self-referentially excluded:
// scanning "does this console.log/console.error call route through
// redactRecord" against the LINTER'S OWN status/error reporting is
// nonsensical — that output is the lint's findings about OTHER code, never
// application record data (StepTrace/RunRecord/ApprovalTask/etc.) that
// could carry a secret.
const SELF_EXCLUDED_BASENAMES = new Set(["redaction-lint.ts", "redaction-lint-cli.ts"]);

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist (e.g. a sibling package stub with no src yet) — not an error for this scan
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkTsFiles(full);
    } else if (
      entry.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".d.ts") &&
      !SELF_EXCLUDED_BASENAMES.has(entry.name)
    ) {
      yield full;
    }
  }
}

/**
 * Scans every `.ts` source file (excluding tests/declarations/this lint's
 * own files) under each given root directory. Intended default use: one
 * root per CONSUMING package's `src/` — engine/server/governance/evidence/
 * dashboard/mcp, the packages that WRITE application records (StepTrace/
 * RunRecord/ApprovalTask/etc.) and so are where a redaction bypass would
 * actually matter. Deliberately caller-general (any rootDirs list works) —
 * `redaction-lint-cli.ts`'s own default policy is what excludes
 * `packages/store` (see its module comment: the store adapter/conformance
 * suite operate BELOW the redaction boundary — they're the storage
 * mechanism itself, not a caller that owes it a redacted record; this
 * function has no opinion on that policy, only the CLI's default does). S9
 * wires this into CI once every Wave-1 package has real code to scan (this
 * package's own DoD note: "S9 verifies it actually runs in CI, not just
 * exists as a script nobody wired in").
 */
export async function lintRedactionBypass(rootDirs: readonly string[]): Promise<RedactionLintFinding[]> {
  const findings: RedactionLintFinding[] = [];
  for (const root of rootDirs) {
    for await (const file of walkTsFiles(root)) {
      const source = await fs.readFile(file, "utf8");
      findings.push(...lintSource(file, source));
    }
  }
  return findings;
}
