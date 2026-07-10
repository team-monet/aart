// json.ts — spec §19.3 full-fidelity JSON dump. Deliberately does NOT go
// through the 9-element ReportModel/ordering discipline (that discipline is
// for human-scannable text formats) — this renderer's whole job is to be a
// complete, lossless (post-redaction) dump of the RunRecord.
import type { RunRecord } from "@aart/types";
import { applyRedaction, type RedactFn } from "../redact.js";

/** Renders `run` as a full-fidelity, pretty-printed JSON dump — always redacted first (architecture §9.2). */
export function renderJson(run: RunRecord, redact: RedactFn, resolvedSecretRefs: ReadonlySet<string> = new Set()): string {
  const clean = applyRedaction(run, redact, resolvedSecretRefs);
  return JSON.stringify(clean, null, 2);
}
