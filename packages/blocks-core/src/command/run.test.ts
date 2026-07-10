import { describe, expect, it } from "vitest";
import { commandRunBlock } from "./run.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("command.run", () => {
  it("has complete, correctly-declared metadata (capability: command)", () => {
    expect(commandRunBlock.manifest.id).toBe("command.run");
    expect(commandRunBlock.manifest.capabilities).toEqual(["command"]);
    expect(commandRunBlock.manifest.category).toBe("command");
  });

  it("runs a fixed binary with an argv array and captures stdout", async () => {
    const result = await commandRunBlock.execute(
      { bin: process.execPath, args: ["-e", "console.log('ran-ok')"] },
      fakeExecutionContext(),
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect((result as { stdout: string }).stdout).toContain("ran-ok");
  });

  // The block-level restatement of command-spawn.test.ts's security-critical
  // suite — proving the guarantee holds through the actual command.run
  // BlockImplementation.execute() call path, not just the underlying
  // spawnCommandNoShell primitive in isolation.
  it("passes shell-metacharacter-laden argv content through inert (no shell interpretation)", async () => {
    const script = "console.log(JSON.stringify(process.argv.slice(1)))";
    const payload = "a; rm -rf / | cat `whoami` $(id) && echo pwned";
    const result = (await commandRunBlock.execute(
      { bin: process.execPath, args: ["-e", script, "--", payload] },
      fakeExecutionContext(),
    )) as { stdout: string; exitCode: number | null };
    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(result.stdout.trim()) as string[];
    expect(argv).toEqual([payload]);
  });

  it("reports a non-zero exitCode without throwing", async () => {
    const result = await commandRunBlock.execute(
      { bin: process.execPath, args: ["-e", "process.exit(3)"] },
      fakeExecutionContext(),
    );
    expect(result).toMatchObject({ exitCode: 3 });
  });

  it("honors timeoutMs and reports timedOut", async () => {
    const result = await commandRunBlock.execute(
      { bin: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 200 },
      fakeExecutionContext(),
    );
    expect(result).toMatchObject({ timedOut: true });
  });
});
