// spawnCommandNoShell — the sandboxing primitive `command.run` is built on
// (ADR-08: "command-type blocks are limited to a fixed, pre-declared binary
// + argv template... a pack cannot expose 'run arbitrary shell' as a
// capability at all"). `command.run` itself (command/run.ts) is a thin
// wrapper around this; this module is the actual no-shell guarantee, kept
// separate so it's independently unit-testable against the exact threat
// this exists to close (shell-metacharacter-laden argv content, spec
// §18.4's "no unsafe interpolation into command binaries").
//
// The guarantee is structural, not sanitization-based (architecture §15's
// stated preference, ADR-08's rejected-alternative note): `child_process
// .spawn(bin, args, { shell: false })` passes `bin`+`args` straight to
// the OS's exec syscall as an argv array — there is no shell in the
// process tree to interpret `;`/`|`/`` ` ``/`$()` at all, so those
// characters can never mean anything other than literal bytes inside
// whichever argv element contains them.
import { spawn } from "node:child_process";

export interface CommandSpawnInput {
  bin: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Piped to the child's stdin, then the stream is closed. Omit to close stdin immediately with no data. */
  stdin?: string;
  timeoutMs?: number;
}

export interface CommandSpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function spawnCommandNoShell(input: CommandSpawnInput): Promise<CommandSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.bin, input.args as string[], {
      cwd: input.cwd,
      env: input.env as NodeJS.ProcessEnv | undefined,
      // ADR-08, non-negotiable: fixed binary + argv template, no shell in
      // the process tree. `shell: false` is Node's own default for
      // spawn() (unlike exec()/execSync()) — set explicitly here so the
      // guarantee is visible at the call site, not an implicit default a
      // future edit could silently flip.
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    if (input.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });

    if (input.stdin !== undefined) {
      child.stdin?.write(input.stdin);
    }
    child.stdin?.end();
  });
}
