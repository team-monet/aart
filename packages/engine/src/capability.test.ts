import { CapabilityDeniedError } from "@aart/types";
import { describe, expect, it } from "vitest";
import { alwaysAllowCapabilityCheck, alwaysEmptyGrantedCapabilities, checkCapabilityDispatch } from "./capability.js";
import { fixtureWorkflow } from "./test-utils/fixtures.js";

describe("alwaysAllowCapabilityCheck", () => {
  it("returns true regardless of declared/granted content (the trivial stub, implementation plan S1 DoD)", () => {
    expect(alwaysAllowCapabilityCheck(["command"], [])).toBe(true);
    expect(alwaysAllowCapabilityCheck([], [])).toBe(true);
  });
});

describe("alwaysEmptyGrantedCapabilities", () => {
  it("always resolves an empty granted set", async () => {
    expect(await alwaysEmptyGrantedCapabilities(fixtureWorkflow(), undefined)).toEqual([]);
  });
});

describe("checkCapabilityDispatch — the one chokepoint, allow and deny paths", () => {
  const workflow = fixtureWorkflow();
  const context = { runId: "run1", stepId: "step1", blockId: "browser.click" };

  it("allow path: does not throw when CapabilityCheck permits it", async () => {
    await expect(
      checkCapabilityDispatch(["browser"], workflow, undefined, { capabilityCheck: alwaysAllowCapabilityCheck, getGrantedCapabilities: alwaysEmptyGrantedCapabilities }, context),
    ).resolves.toBeUndefined();
  });

  it("deny path: throws CapabilityDeniedError when CapabilityCheck denies it", async () => {
    const denyingCheck = () => false;
    await expect(
      checkCapabilityDispatch(["browser"], workflow, undefined, { capabilityCheck: denyingCheck, getGrantedCapabilities: alwaysEmptyGrantedCapabilities }, context),
    ).rejects.toThrow(CapabilityDeniedError);
  });

  it("a real subset-checking CapabilityCheck permits a declared set that IS a subset of granted", async () => {
    const subsetCheck = (declared: string[], granted: string[]) => declared.every((d) => granted.includes(d));
    const getGranted = async () => ["browser", "http"];
    await expect(checkCapabilityDispatch(["browser"], workflow, undefined, { capabilityCheck: subsetCheck, getGrantedCapabilities: getGranted }, context)).resolves.toBeUndefined();
  });

  it("a real subset-checking CapabilityCheck denies a declared set that is NOT a subset of granted", async () => {
    const subsetCheck = (declared: string[], granted: string[]) => declared.every((d) => granted.includes(d));
    const getGranted = async () => ["http"]; // "browser" not granted
    await expect(checkCapabilityDispatch(["browser"], workflow, undefined, { capabilityCheck: subsetCheck, getGrantedCapabilities: getGranted }, context)).rejects.toThrow(CapabilityDeniedError);
  });

  it("the thrown CapabilityDeniedError's detail identifies the run/step/block/declared/granted for diagnosability", async () => {
    try {
      await checkCapabilityDispatch(["command"], workflow, "production", { capabilityCheck: () => false, getGrantedCapabilities: async () => ["browser"] }, context);
      expect.fail("expected checkCapabilityDispatch to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDeniedError);
      expect((err as CapabilityDeniedError).detail).toMatchObject({ runId: "run1", stepId: "step1", blockId: "browser.click", declared: ["command"], granted: ["browser"] });
    }
  });

  it("threads the environment parameter through to getGrantedCapabilities", async () => {
    const seen: (string | undefined)[] = [];
    const getGranted = async (_workflow: typeof workflow, environment: string | undefined) => {
      seen.push(environment);
      return [];
    };
    await checkCapabilityDispatch([], workflow, "staging", { capabilityCheck: alwaysAllowCapabilityCheck, getGrantedCapabilities: getGranted }, context);
    expect(seen).toEqual(["staging"]);
  });
});
