import type { Runtime } from '../core/runtime'
import type { BlockDefinition } from '../core/types'

/**
 * The compact verdict returned by verifyWeb. Small enough to drop directly into
 * an agent's context window — heavy artifacts (fullText, full trace) stay on
 * disk and are retrievable via aa_get_report.
 */
export interface VerifyResult {
  status: 'ok' | 'unreachable'
  /** Present only when `expect` was provided: true if the expected text is in the page. */
  ok?: boolean
  url: string
  title?: string
  /** Clamped inline text (already trimmed by web.read's maxChars contract). */
  text?: string
  /** First ~10 interactive elements — enough to orient the agent without overwhelming. */
  elements?: Array<{ role: string; name: string; selector: string; href?: string }>
  consoleErrors?: { count: number; sample: string[] }
  /** Path to the screenshot artifact (use aa_get_report for the full run). */
  screenshot?: string
  /** Run id — pass to aa_get_report for the full trace + fullText + all artifacts. */
  runId?: string
  /** Short nudge when something noteworthy: expected text missing, page unsettled, etc. */
  hint?: string
  /** Error message when the page was unreachable or the run failed. */
  error?: string
}

/**
 * The one-call verification primitive for coding agents.
 *
 * Loads `url` in a real browser via the web.read native block, waits for the
 * page to settle, and returns a DISTILLED, compact verdict — small enough to
 * fit in an agent's context window. Failures are returned as verdicts (status:
 * 'unreachable'), never thrown, so "the page is broken" is itself the answer.
 *
 * @param runtime  The live Runtime (has corePack loaded, which provides web.read).
 * @param args.url     The URL to verify.
 * @param args.focus   Optional CSS selector to scope text extraction.
 * @param args.expect  Optional phrase to look for in the rendered text.
 */
export async function verifyWeb(
  runtime: Runtime,
  args: { url: string; focus?: string; expect?: string },
): Promise<VerifyResult> {
  const { url, focus, expect: expectedText } = args

  // Resolve the web.read native block — always present in corePack (native
  // blocks are pre-approved, so approval enforcement is irrelevant here).
  const def = runtime.registry.getBlock('web.read') as BlockDefinition | undefined
  if (!def) {
    return {
      status: 'unreachable',
      url,
      error: 'web.read block not found — ensure corePack is loaded',
      ...(expectedText !== undefined ? { ok: false } : {}),
      hint: 'corePack may not have been passed to the Runtime constructor',
    }
  }

  let record: Awaited<ReturnType<typeof runtime.run>>
  try {
    // Run web.read directly (it's native, always approved).
    record = await runtime.run(
      def,
      { url, ...(focus ? { focus } : {}) },
      undefined,
      { approved: true },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hint = /chromium|playwright|executable|browser/i.test(message)
      ? 'browser not available — run: npx playwright install --with-deps chromium'
      : undefined
    return {
      status: 'unreachable',
      url,
      error: message,
      ...(expectedText !== undefined ? { ok: false } : {}),
      ...(hint ? { hint } : {}),
    }
  }

  // A FAILED run record means the block itself threw (e.g. network error,
  // Chromium crash). Surface as a verdict, not a throw.
  if (record.status === 'FAILED') {
    const message = record.error ?? 'web.read run failed'
    const hint = /chromium|playwright|executable|browser/i.test(message)
      ? 'browser not available — run: npx playwright install --with-deps chromium'
      : undefined
    return {
      status: 'unreachable',
      url,
      error: message,
      runId: record.runId,
      ...(expectedText !== undefined ? { ok: false } : {}),
      ...(hint ? { hint } : {}),
    }
  }

  // COMPLETED — distil the result into the compact verdict.
  const r = (record.results ?? {}) as Record<string, unknown>

  const pageText = typeof r['text'] === 'string' ? r['text'] : undefined
  const pageTitle = typeof r['title'] === 'string' ? r['title'] : undefined
  const settled = typeof r['settled'] === 'boolean' ? r['settled'] : true

  // elements: web.read caps at 30; we trim further to ~10 for compactness.
  const allElements = Array.isArray(r['elements'])
    ? (r['elements'] as Array<{ role: string; name: string; selector: string; href?: string }>)
    : []
  const elements = allElements.slice(0, 10)

  const consoleErrors =
    r['consoleErrors'] != null && typeof r['consoleErrors'] === 'object'
      ? (r['consoleErrors'] as { count: number; sample: string[] })
      : undefined

  // screenshot: web.read attaches it as an artifact and returns the path.
  const screenshot = typeof r['screenshot'] === 'string' ? r['screenshot'] : undefined

  // Compute ok + hint from expect.
  let ok: boolean | undefined
  let hint: string | undefined

  if (expectedText !== undefined) {
    ok = typeof pageText === 'string' && pageText.includes(expectedText)
    if (!ok) {
      hint = 'expected text not found — look at the screenshot artifact'
    }
  }

  // settled=false is worth surfacing even when no expect was given.
  if (!settled && !hint) {
    hint = 'page did not reach the waited-for state (waitFor timed out)'
  }

  return {
    status: 'ok',
    url: typeof r['url'] === 'string' ? r['url'] : url,
    ...(pageTitle !== undefined ? { title: pageTitle } : {}),
    ...(pageText !== undefined ? { text: pageText } : {}),
    elements,
    ...(consoleErrors !== undefined ? { consoleErrors } : {}),
    ...(screenshot !== undefined ? { screenshot } : {}),
    runId: record.runId,
    ...(ok !== undefined ? { ok } : {}),
    ...(hint !== undefined ? { hint } : {}),
  }
}
