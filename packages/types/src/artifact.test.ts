import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "./artifact.js";

describe("ArtifactSchema", () => {
  it("round-trips an Artifact", () => {
    const input = {
      id: "art_1",
      runId: "run_1",
      stepId: "screenshot",
      name: "checkout.png",
      kind: "screenshot",
      mime: "image/png",
      path: "artifacts/run_1/art_1.png",
      bytes: 12345,
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    expect(ArtifactSchema.parse(input)).toEqual(input);
  });

  it("allows stepId to be omitted (a run-level, not step-level, artifact)", () => {
    const parsed = ArtifactSchema.parse({
      id: "art_2",
      runId: "run_1",
      name: "report.json",
      kind: "json_output",
      mime: "application/json",
      path: "artifacts/run_1/art_2.json",
      bytes: 42,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(parsed.stepId).toBeUndefined();
  });

  it("rejects an Artifact missing a required field (mime)", () => {
    const result = ArtifactSchema.safeParse({
      id: "art_3",
      runId: "run_1",
      name: "x",
      kind: "file",
      path: "x",
      bytes: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
