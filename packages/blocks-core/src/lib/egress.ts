// Egress domain allowlist — architecture §4.6 boundary note / ADR-09:
// "egress domain allowlisting... lives *inside* the http and browser
// capability providers themselves... not in the engine's dispatch loop
// [since] the domain check needs the resolved request URL, which only
// exists once the block is actually about to make the call." This module
// is that per-provider chokepoint, shared by `http.request`,
// `http.download`, `browser.goto`, and `web.read` (the 4 blocks in this
// catalog that actually originate a new network request to a
// caller-resolved URL — `browser.*`'s other 9 blocks act on an
// already-navigated page and don't independently resolve a new origin).
//
// Configuration is a module-level, settable-once-at-composition-root
// policy (`setEgressPolicy`), matching this architecture's existing
// constructor-injected-process-lifetime pattern for `RedactFn`/
// `CapabilityCheck` (architecture §4.6/§7.9) — but each egress-checking
// block also accepts an explicit policy override at construction time
// (see `http/request.ts`), for tests and for an explicit composition-root
// wiring that doesn't want to depend on module-level mutable state.
export interface EgressPolicy {
  /** `undefined`/`null` = no restriction (allow all domains) — the default when no policy has been configured, matching v1's local/dev posture (spec §31.3: policy is opt-in, restricting only once an operator configures `allowedDomains`). An empty array denies every domain. Entries are exact hostnames or a `"*.suffix"` wildcard (spec §31.3's own example: `"*.internal.company.com"`). */
  allowedDomains?: readonly string[] | null;
}

export class EgressDeniedError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly allowedDomains: readonly string[],
  ) {
    super(`egress to "${hostname}" is not in the configured domain allowlist (${allowedDomains.join(", ") || "<empty>"})`);
    this.name = "EgressDeniedError";
  }
}

let currentPolicy: EgressPolicy = {};

/** Composition-root call, once at process start (or per-test) — analogous to constructor-injecting a `RedactFn`. */
export function setEgressPolicy(policy: EgressPolicy): void {
  currentPolicy = policy;
}

export function getEgressPolicy(): EgressPolicy {
  return currentPolicy;
}

function hostnameMatches(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1); // "*.example.com" -> ".example.com"
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedPattern;
}

/** Throws `EgressDeniedError` if `url`'s hostname isn't covered by `policy` (defaults to the current module-level policy). A `policy` with no `allowedDomains` configured allows everything — this is a restriction that must be explicitly opted into, not a default-deny posture (matching spec §31.3's framing: "policy CAN restrict," not "policy always restricts"). */
export function checkEgressAllowed(url: string | URL, policy: EgressPolicy = currentPolicy): void {
  const allowedDomains = policy.allowedDomains;
  if (allowedDomains === undefined || allowedDomains === null) return;
  const hostname = (typeof url === "string" ? new URL(url) : url).hostname;
  const ok = allowedDomains.some((pattern) => hostnameMatches(hostname, pattern));
  if (!ok) {
    throw new EgressDeniedError(hostname, allowedDomains);
  }
}
