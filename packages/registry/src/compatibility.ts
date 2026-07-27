import { satisfies, valid, validRange } from "semver";
import type { PackCompatibility } from "./discovery.js";

export interface PackRuntimeVersions {
  readonly aart: string;
  readonly node: string;
}

export class PackCompatibilityError extends Error {}

/**
 * Validates a Pack's declared runtime ranges at the approval boundary.
 * Installation remains inert and may succeed on an incompatible machine so
 * the user can still inspect the exact artifact and its declaration.
 */
export function assertPackCompatibility(
  compatibility: PackCompatibility | undefined,
  runtime: PackRuntimeVersions,
): void {
  if (!compatibility) return;
  assertRange("AART", compatibility.aart, runtime.aart);
  assertRange("Node.js", compatibility.node, runtime.node);
}

function assertRange(kind: string, range: string | undefined, currentVersion: string): void {
  if (!range) return;
  if (validRange(range) === null) {
    throw new PackCompatibilityError(`Pack declares an invalid ${kind} compatibility range "${range}"`);
  }
  const normalizedVersion = valid(currentVersion);
  if (normalizedVersion === null) {
    throw new PackCompatibilityError(`AART could not determine the current ${kind} version from "${currentVersion}"`);
  }
  if (!satisfies(normalizedVersion, range, { includePrerelease: true })) {
    throw new PackCompatibilityError(
      `Pack requires ${kind} ${range}, but this runtime is ${normalizedVersion}; approval was not recorded`,
    );
  }
}
