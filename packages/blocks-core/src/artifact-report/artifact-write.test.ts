import { describe, expect, it } from "vitest";
import { artifactWriteBlock } from "./artifact-write.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("artifact.write", () => {
  it("has complete, correctly-declared metadata (capability: file.write, per spec §31.1)", () => {
    expect(artifactWriteBlock.manifest.id).toBe("artifact.write");
    expect(artifactWriteBlock.manifest.capabilities).toEqual(["file.write"]);
    expect(artifactWriteBlock.manifest.category).toBe("artifact");
  });

  it("writes utf8 content through ctx.writeArtifact and returns {id, path}", async () => {
    const ctx = fakeExecutionContext();
    const result = await artifactWriteBlock.execute(
      { name: "result.json", kind: "json_output", mime: "application/json", content: '{"ok":true}' },
      ctx,
    );
    expect(result).toMatchObject({ id: expect.any(String), path: expect.any(String) });
    expect(ctx.writtenArtifacts).toHaveLength(1);
    expect(ctx.writtenArtifacts[0]).toMatchObject({ name: "result.json", kind: "json_output", mime: "application/json" });
    expect(Buffer.from(ctx.writtenArtifacts[0]!.bytes).toString("utf8")).toBe('{"ok":true}');
  });

  it("decodes base64 content before writing", async () => {
    const ctx = fakeExecutionContext();
    const original = "binary-ish-content";
    await artifactWriteBlock.execute(
      { name: "shot.png", kind: "screenshot", mime: "image/png", content: Buffer.from(original).toString("base64"), encoding: "base64" },
      ctx,
    );
    expect(Buffer.from(ctx.writtenArtifacts[0]!.bytes).toString("utf8")).toBe(original);
  });
});
