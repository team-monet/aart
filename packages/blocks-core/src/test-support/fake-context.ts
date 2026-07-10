// Shared test fixture — a fake `BlockExecutionContext` (architecture §2.5,
// packages/types/src/block.ts). The real implementation is S1's
// (@aart/engine, the dispatch loop's only caller/constructor of this
// type) — every block test in this package runs against this fake rather
// than a real engine, exactly as the S3 injection brief instructs ("code
// against frozen types with fakes in tests").
import { vi } from "vitest";
import type { BlockExecutionContext } from "@aart/types";

export interface FakeExecutionContextOptions {
  runId?: string;
  stepId?: string;
  /** Keyed by the bare `<NAME>` a block passes to `resolveSecret` (i.e. NOT the `secrets.<NAME>` wire form). */
  secrets?: Record<string, string>;
}

export interface FakeExecutionContext extends BlockExecutionContext {
  /** Every {name, kind, mime, bytes} this fake was asked to persist, in call order — inspect this in tests instead of re-deriving it from mock-call args. */
  readonly writtenArtifacts: Array<{ name: string; kind: string; mime: string; bytes: Uint8Array }>;
}

let artifactCounter = 0;

export function fakeExecutionContext(options: FakeExecutionContextOptions = {}): FakeExecutionContext {
  const secrets = options.secrets ?? {};
  const writtenArtifacts: FakeExecutionContext["writtenArtifacts"] = [];

  return {
    runId: options.runId ?? "run-fake-0001",
    stepId: options.stepId ?? "step-fake-0001",
    resolveSecret: vi.fn(async (ref: string) => {
      const name = ref.startsWith("secrets.") ? ref.slice("secrets.".length) : ref;
      if (!(name in secrets)) {
        throw new Error(`fakeExecutionContext: no fixture value for secret "${name}"`);
      }
      return secrets[name]!;
    }),
    writeArtifact: vi.fn(async (input: { name: string; kind: string; mime: string; bytes: Uint8Array }) => {
      writtenArtifacts.push(input);
      artifactCounter += 1;
      const id = `artifact-fake-${String(artifactCounter).padStart(4, "0")}`;
      return { id, path: `/tmp/aart-fake-artifacts/${id}-${input.name}` };
    }),
    writtenArtifacts,
  };
}
