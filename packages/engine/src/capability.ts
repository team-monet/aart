// Capability enforcement at dispatch (architecture §4.6, ADR-09) — one
// function, one call site, exactly as the architecture's stated design goal
// requires. The *policy data* (what's granted) is owned by @aart/governance;
// this package only calls the frozen `CapabilityCheck` predicate against
// whatever `declared`/`granted` it's handed.
import type { CapabilityCheck } from "@aart/types";
import { CapabilityDeniedError } from "@aart/types";
import type { GetGrantedCapabilities } from "./types.js";

/**
 * Trivial always-allow `CapabilityCheck` stub (architecture §4.6/micro-
 * decision #17, implementation plan S1 DoD: "ships a trivial always-allow
 * stub implementation so its own tests don't block on S4's completion").
 * `@aart/governance` (S4) ships the real policy implementation; this
 * package never redefines the `CapabilityCheck` type itself (frozen in
 * `@aart/types`), only this one stub value.
 */
export const alwaysAllowCapabilityCheck: CapabilityCheck = () => true;

/** Pairs with `alwaysAllowCapabilityCheck` as this package's out-of-the-box default `GetGrantedCapabilities` — since the paired check always returns `true` regardless of content, an empty granted set is a safe, honest default (it's never actually consulted for a decision unless a test swaps in a real subset-checking `CapabilityCheck`). */
export const alwaysEmptyGrantedCapabilities: GetGrantedCapabilities = () => [];

/**
 * The one capability-dispatch call site (architecture §4.6): resolves
 * `granted` via the injected `GetGrantedCapabilities`, then calls the
 * injected `CapabilityCheck` predicate with `(declared, granted)`. Throws
 * `CapabilityDeniedError` — distinguishable from a generic step failure in
 * traces/reports, per architecture's explicit requirement — on denial.
 * Callers pass `declared` from the dispatched block's own
 * `BlockManifest.capabilities` (architecture §2.5); this function has no
 * opinion on where `declared` comes from.
 */
export async function checkCapabilityDispatch(
  declared: readonly string[],
  workflow: Parameters<GetGrantedCapabilities>[0],
  environment: string | undefined,
  config: { capabilityCheck: CapabilityCheck; getGrantedCapabilities: GetGrantedCapabilities },
  context: { runId: string; stepId: string; blockId: string },
): Promise<void> {
  const granted = await config.getGrantedCapabilities(workflow, environment);
  const allowed = config.capabilityCheck(declared as string[], granted as string[]);
  if (!allowed) {
    throw new CapabilityDeniedError({
      message: `Step "${context.stepId}" (block "${context.blockId}") declares capabilities [${declared.join(", ")}] which are not a subset of this run's granted capabilities [${granted.join(", ")}] (architecture §4.6, ADR-09).`,
      detail: { kind: "capabilityDenied", runId: context.runId, stepId: context.stepId, blockId: context.blockId, declared: [...declared], granted: [...granted] },
    });
  }
}
