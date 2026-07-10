// command.run — spec §15.3 Command group, THE only block of execution
// type `command` (§15.1) and the only block declaring the `command`
// capability (High risk, §31.1). "Fixed binary + argv template, spawned
// WITHOUT a shell" (ADR-08) is enforced structurally by
// lib/command-spawn.ts's spawnCommandNoShell, not by this block — this
// module is a thin, capability-declaring wrapper; see that module's own
// doc comment and command-spawn.test.ts for the actual no-shell-injection
// proof (shell-metacharacter-laden argv values pass through inert).
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { spawnCommandNoShell } from "../lib/command-spawn.js";

const inputSchema = z.object({
  bin: z.string().describe('The fixed binary to execute, e.g. "git" or "/usr/local/bin/mytool". Never a shell command string.'),
  args: z.array(z.string()).describe('Argv elements, passed exactly as given — never shell-interpreted (ADR-08). Example: ["status", "--short"].'),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
  timeoutMs: z.number().optional().describe("Kills the process (SIGKILL) if it exceeds this budget."),
});
const outputSchema = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});

export const commandRunBlock = defineBlock({
  id: "command.run",
  capabilities: ["command"],
  category: "command",
  description:
    'Runs a fixed binary with an explicit argv array, with no shell in the process tree — shell metacharacters in args are inert literal content, never interpreted. Example: bin: "git", args: ["status", "--short"].',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return spawnCommandNoShell({
      bin: input.bin,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
    });
  },
});
