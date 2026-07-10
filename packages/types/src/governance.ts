// gates object, trust modes, capability taxonomy, ConcurrencyPolicy,
// RetryPolicy, CapabilityCheck, RedactFn — spec §17.1-17.2, §30.1, §30.3,
// §31.0-31.1; architecture §4.6 micro-decision #17, §7.9.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Approval / gates — spec §17.1
// ---------------------------------------------------------------------------

export const ApprovalStateSchema = z.enum(["draft", "approved", "deprecated"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const GateStatusSchema = z.enum(["pending", "passed", "failed", "waived"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GatesSchema = z.object({
  validate: GateStatusSchema,
  readiness: GateStatusSchema,
  evals: GateStatusSchema,
  riskReview: GateStatusSchema,
  humanReview: GateStatusSchema,
});
export type Gates = z.infer<typeof GatesSchema>;

// ---------------------------------------------------------------------------
// Trust modes — spec §17.2
// ---------------------------------------------------------------------------

export const TrustModeSchema = z.enum(["dev", "governed", "strict", "production"]);
export type TrustMode = z.infer<typeof TrustModeSchema>;

// ---------------------------------------------------------------------------
// Capability taxonomy — spec §31.0. Coarse grants, not one capability per
// block. `secrets:<NAME>` and `domain:<pattern>` are parameterized families
// (not enumerable literals), so this taxonomy is documented for reference
// but BlockManifest.capabilities (block.ts) stays string[] rather than a
// closed Zod enum — a closed enum can't express `secrets:GITHUB_TOKEN` or
// `domain:api.github.com` as valid members without degrading to a
// regex-typed escape hatch that provides little real validation value over
// z.string(), and governance (S4) is the actual owner of validating
// capability strings against this taxonomy at policy-check time, not
// @aart/types.
// ---------------------------------------------------------------------------

export const CAPABILITY_TAXONOMY = [
  "browser",
  "http",
  "file.read",
  "file.write",
  "command",
  "email.send",
  "queue",
  "db.read",
  "db.write",
  "llm",
] as const;
export type BaseCapability = (typeof CAPABILITY_TAXONOMY)[number];

// ---------------------------------------------------------------------------
// Concurrency / retry — spec §30.1, §30.3
// ---------------------------------------------------------------------------

export const ConcurrencyPolicySchema = z.enum(["queue", "cancel_existing", "reject_new", "allow"]);
export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number(),
  // Spec §30.3's only confirmed member is "exponential"; architecture §4.2
  // writes the TS shape as `backoff: "exponential" | ...`, explicitly
  // leaving the rest of the set open rather than enumerating it. Kept as
  // z.string() rather than inventing unlisted enum members (e.g. "fixed",
  // "linear") that appear nowhere in either source document.
  backoff: z.string(),
  // Matched against the AartError taxonomy (errors.ts) at runtime by the
  // engine (architecture micro-decision #9), not a closed set here.
  retryOn: z.array(z.string()),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// ---------------------------------------------------------------------------
// CapabilityCheck — architecture §4.6 / micro-decision #17. A function-type
// dependency-injection seam, not a data shape: "the CapabilityCheck
// interface type itself lives in @aart/types (frozen in S0) ... engine
// calls it with a trivial always-allow stub implementation, governance
// ships the real implementation." Modeled as a plain TS function type
// rather than a Zod schema — nothing ever needs to runtime-validate "is
// this a function," only to type-check the call site — matching this
// module's treatment of RedactFn immediately below and
// BlockImplementation.execute in block.ts. See this task's final report
// for the fuller rationale.
// ---------------------------------------------------------------------------

export type CapabilityCheck = (declared: string[], granted: string[]) => boolean;

// ---------------------------------------------------------------------------
// RedactFn — architecture §2.1 governance.ts, §7.9 (F2 chokepoint fix),
// arity corrected to 2-arg by architecture's own A27 fix.
// `(record, resolvedSecretRefs) => record`. The engine accepts an
// implementation via constructor injection at process start (process-
// lifetime); the claimed run's currently-resolved secret-refs set is
// threaded in fresh on every call (per-run, load-bearing under
// maxConcurrentRuns — architecture §4.3/§4.6). Engine imports only this
// type, never `@aart/governance` itself (architecture §4.6's one-directional
// engine→governance dependency, carved out for redaction the same way it is
// for CapabilityCheck above).
// ---------------------------------------------------------------------------

export type RedactFn = (record: unknown, resolvedSecretRefs: ReadonlySet<string>) => unknown;
