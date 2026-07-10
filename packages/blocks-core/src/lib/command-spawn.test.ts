import { describe, expect, it } from "vitest";
import { spawnCommandNoShell } from "./command-spawn.js";

// A tiny, dependency-free "echo my argv back as JSON" child script, run via
// `node -e`. Using node itself (process.execPath) rather than a shell
// builtin like /bin/echo keeps this test deterministic/portable and, more
// importantly, means the ARGV ARRAY node receives is exactly what the test
// asserts on — the whole point of these tests is proving no shell sits
// between spawnCommandNoShell and the child process.
const ARGV_ECHO_SCRIPT = "console.log(JSON.stringify(process.argv.slice(1)))";

async function echoArgv(args: string[]) {
  const result = await spawnCommandNoShell({
    bin: process.execPath,
    args: ["-e", ARGV_ECHO_SCRIPT, "--", ...args],
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.trim()) as string[];
}

describe("spawnCommandNoShell", () => {
  it("runs a fixed binary with an argv array and captures stdout/exitCode", async () => {
    const result = await spawnCommandNoShell({
      bin: process.execPath,
      args: ["-e", "console.log('hello-from-child')"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-child");
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code without throwing", async () => {
    const result = await spawnCommandNoShell({
      bin: process.execPath,
      args: ["-e", "process.exit(7)"],
    });
    expect(result.exitCode).toBe(7);
  });

  it("captures stderr separately from stdout", async () => {
    const result = await spawnCommandNoShell({
      bin: process.execPath,
      args: ["-e", "console.error('oops')"],
    });
    expect(result.stderr).toContain("oops");
    expect(result.stdout).toBe("");
  });

  // --- The security-critical suite: shell metacharacters pass through as
  // inert literal argv content, never shell-interpreted (ADR-08, spec
  // §18.4's "no unsafe interpolation into command binaries"). Each case
  // below would behave very differently under `shell: true` (command
  // chaining, piping, command substitution, subshell) — proving the argv
  // value round-trips byte-for-byte is what proves no shell ever saw it.

  it("passes a semicolon-laden argv value through inert (no command chaining)", async () => {
    const argv = await echoArgv(["hello; rm -rf /tmp/should-not-run"]);
    expect(argv).toEqual(["hello; rm -rf /tmp/should-not-run"]);
  });

  it("passes a pipe-laden argv value through inert (no piping)", async () => {
    const argv = await echoArgv(["hello | cat /etc/passwd"]);
    expect(argv).toEqual(["hello | cat /etc/passwd"]);
  });

  it("passes a backtick-laden argv value through inert (no command substitution)", async () => {
    const argv = await echoArgv(["hello `whoami`"]);
    expect(argv).toEqual(["hello `whoami`"]);
  });

  it("passes a $() command-substitution-laden argv value through inert", async () => {
    const argv = await echoArgv(["hello $(whoami)"]);
    expect(argv).toEqual(["hello $(whoami)"]);
  });

  it("passes a combined shell-metacharacter payload through inert, argument boundaries preserved", async () => {
    const argv = await echoArgv(["a;b|c`d`$(e)", "second arg with spaces", "&&rm -rf ~"]);
    expect(argv).toEqual(["a;b|c`d`$(e)", "second arg with spaces", "&&rm -rf ~"]);
  });

  it("passes a redirection-laden argv value through inert (no file redirection)", async () => {
    const argv = await echoArgv(["hello > /tmp/pwned.txt"]);
    expect(argv).toEqual(["hello > /tmp/pwned.txt"]);
  });

  // --- Timeout / stdin

  it("kills the child and reports timedOut when it exceeds timeoutMs", async () => {
    const result = await spawnCommandNoShell({
      bin: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("pipes stdin through to the child when provided", async () => {
    const result = await spawnCommandNoShell({
      bin: process.execPath,
      args: ["-e", "process.stdin.resume(); let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => console.log('got:'+d));"],
      stdin: "piped-value",
    });
    expect(result.stdout).toContain("got:piped-value");
  });

  it("rejects (does not throw synchronously) when the binary doesn't exist", async () => {
    await expect(
      spawnCommandNoShell({ bin: "/definitely/not/a/real/binary/path/aart-test", args: [] }),
    ).rejects.toThrow();
  });
});
