# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S4 Governance

### `redactRecord` — the redaction chokepoint (architecture §7.9, ADR-10)

**Export:** `redactRecord` from `packages/governance/src/redact.ts`, re-exported at the package root `@aart/governance`.
**Signature:** matches the frozen `RedactFn` type in `@aart/types` (`governance.ts`) EXACTLY — `(record: unknown, resolvedSecretRefs: ReadonlySet<string>) => unknown`. No divergence from the frozen type.

**Consumers per the plan:** S1 (`@aart/engine`) wires this in via **constructor injection** at the composition root (server/CLI/MCP) — engine code imports only the `RedactFn` *type* from `@aart/types`, never this package directly (architecture §4.6/§7.9's one-directional engine→governance rule, carved out for redaction the same way it is for `CapabilityCheck`). S2/S6/S8 may import `redactRecord` directly from `@aart/governance` wherever they persist/emit a record.

**Behavior contract consumers should know:**
- Value-scan-and-replace over the record's full tree (arrays/nested objects included), never a field-name allowlist. Never inspects key names.
- Catches a secret's **verbatim** form, its **JSON-string-escaped** form (e.g. embedded inside a JSON-stringified payload), and its **URL-percent-encoded** form (e.g. embedded in a query string) — all three, per secret value.
- `resolvedSecretRefs` is a flat `ReadonlySet<string>` of resolved secret **values** (not names) — this is what the frozen type's single `Set<string>` parameter can carry, and matches architecture §7.9's "replaces any occurrence of that literal resolved value."
- **Marker format note (read before consuming):** because a flat value-set carries no symbolic NAME, `redactRecord`'s marker is **positional**: `[REDACTED:secret-N]`, N = 1-based order of the set's iteration — NOT `[REDACTED:<NAME>]` as architecture's diagram illustrates (that format needs a name this function's frozen signature doesn't receive). The same secret value repeating anywhere in one record gets the same marker within that call. If you need real `[REDACTED:<NAME>]` markers and have a value→name mapping available, use the sibling export `redactRecordWithNames(record, resolvedSecretRefs: ReadonlyMap<string, string>)` instead (not part of the frozen `RedactFn` type, an additional governance-owned convenience).
- Empty-string secret values are ignored (never globally blanket-replace empty string). An empty `resolvedSecretRefs` set is a documented no-op.
- Pure — never mutates the input record, returns a new tree.

### `checkCapability` — the real `CapabilityCheck` implementation (architecture §4.6, ADR-09)

**Export:** `checkCapability` from `packages/governance/src/capability.ts`, re-exported at the package root `@aart/governance`.
**Signature:** matches the frozen `CapabilityCheck` type in `@aart/types` EXACTLY — `(declared: string[], granted: string[]) => boolean`. `declared ⊆ granted`.

**Consumer:** S1 (`@aart/engine`) replaces its always-allow stub with this at the composition root. Same import-the-type-not-the-package discipline as `redactRecord` above (engine imports `CapabilityCheck` from `@aart/types`, receives an implementation via constructor injection).

**What feeds `granted`:** this package also exports `computeCapabilityClosure(steps, lookup)` (capability.ts) for computing a workflow version's full transitive capability closure (ceiling-function risk, not average) and `getGrantedCapabilities(input)` (capability.ts) for resolving the policy-driven `granted` set from approval state + capability closure + standing approvals — see that module's doc comments. Neither of these two has a fixed signature specified anywhere in the source documents (unlike `checkCapability`/`redactRecord`/`computeApprovalState`/`computePromotionState`, which do); their shapes are this package's own reasonable fill for a genuine design gap, documented in AMENDMENTS.md. Flag to S4 if S1/S9 integration needs a different shape — these are easy to adjust since nothing outside this package's own tests depends on their exact signature yet.

### `computePromotionState` / `evaluatePromotionForEnvironment` — per-environment promotion (architecture §7.1, ADR-07)

**Export:** both from `packages/governance/src/approval.ts`, re-exported at the package root `@aart/governance`.
**Signatures:**
- `computePromotionState(globalApproval: ApprovalState, gates: Gates, requiredGatesForEnvironment: readonly GateName[], environment: string): PromotionRecord` — pure, exactly 4 positional args, never writes the workflow version's global `approval` field.
- `evaluatePromotionForEnvironment(params: { workflow: Pick<Workflow, "promotionBlocked">, globalApproval, gates, requiredGatesForEnvironment, environment }): PromotionEvaluation` — the "promotion path" call site that refuses to produce/refresh a record while `workflow.promotionBlocked` is true. Call THIS, not `computePromotionState` directly, from any integration that needs the blocked-refusal behavior.

**Consumer:** S2's own DoD text references `computePromotionState` directly (environment/deployment record integration) — this is a real cross-session dependency the Appendix dependency table doesn't list as a merge-order constraint (S2 merges before S4 in the suggested order), so S2 should treat this as **interface-level** for now (code against this documented shape) the same way S7's approval-flow dependency on S4 is treated, per the plan's own merge-order note — a same-wave convergence point for S9 if timing doesn't line up.

**`PromotionRecord`'s exact field shape is NOT frozen anywhere in the source documents** ("its exact field shape is ADR-07's/S2's to finalize when environment records are built" — architecture §7.1). The shape below is this package's own reasonable fill, open to revision by S2 without needing an `AMENDMENTS.md` entry (nothing outside this package's own tests currently depends on it):
```ts
interface PromotionRecord {
  environment: string;
  promoted: boolean;
  globalApproval: ApprovalState;
  requiredGates: readonly GateName[];
  unmetGates: readonly GateName[];
}
```
`GateName` is `keyof Gates` (`packages/governance/src/gates.ts`), exported from the package root.

