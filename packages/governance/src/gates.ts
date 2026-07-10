// Trust-mode -> required-gates mapping (architecture §7.3) and mode-gated
// tool-registration DATA (architecture §7.2, spec §17.5). Both are pure
// config this module owns as the authoritative source; @aart/mcp (S5) is
// the actual MCP-registration-mechanics consumer for the latter.
import type { Gates, TrustMode } from "@aart/types";

/** A key of the Gates object — spec §17.1's five independent, parallel gates. */
export type GateName = keyof Gates;

export const GATE_NAMES: readonly GateName[] = ["validate", "readiness", "evals", "riskReview", "humanReview"];

/**
 * architecture §7.3's explicit mapping (spec states defaults but not the
 * exact required-gate set per mode — this is the concrete resolution):
 *
 *   dev:         requires nothing — draft runs execute with a warning
 *   governed:    validate=passed, humanReview=passed
 *   strict:      validate=passed, humanReview=passed (same gate set as
 *                governed; the difference from governed is the approval
 *                SURFACE restriction, §7.2, not a different gate set)
 *   production:  all five gates
 */
export const REQUIRED_GATES_BY_MODE: Readonly<Record<TrustMode, readonly GateName[]>> = {
  dev: [],
  governed: ["validate", "humanReview"],
  strict: ["validate", "humanReview"],
  production: ["validate", "readiness", "evals", "riskReview", "humanReview"],
};

/**
 * Mode-gated tool-registration DATA (architecture §7.2, spec §17.5). S4 owns
 * the authoritative mode -> tool-list mapping; the actual MCP registration
 * mechanics (building the `tools[]` array an MCP client sees) are S5's
 * (`@aart/mcp`). This module intentionally scopes to the ONE tool spec
 * §17.5 explicitly mode-gates — `aart_approve` — rather than enumerating
 * the other ~20 MCP tools spec §34 defines, which are S5's own catalog to
 * own and are mode-agnostic from governance's perspective.
 *
 * architecture §7.2: enforced at MCP server STARTUP (the tools[] array
 * itself omits `aart_approve` in strict/production) — NOT a runtime
 * "forbidden" check inside the tool handler. An agent in strict/production
 * mode should never even see `aart_approve` as an option to attempt.
 */
export const AART_APPROVE_TOOL_NAME = "aart_approve";

/** Trust modes where `aart_approve` is registered — spec §17.5's table: dev + governed only. */
export const MODES_WITH_AART_APPROVE: readonly TrustMode[] = ["dev", "governed"];

export function isAartApproveRegisteredForMode(mode: TrustMode): boolean {
  return MODES_WITH_AART_APPROVE.includes(mode);
}
