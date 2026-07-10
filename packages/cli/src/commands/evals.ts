// aart eval create|add|run <suite> — spec §33.4.
//
// `aart eval create`/`aart eval add --from-run` have no MCP-tool
// counterpart (only `aart_create_eval_from_correction`, which requires an
// existing Correction, does) — genuine CLI-only authoring operations,
// implemented directly against the real @aart/store (creating/growing an
// EvalSuite is straightforward record CRUD, not domain logic belonging to
// another package). `aart eval run` calls the exact same `runEvalHandler`
// aart_run_eval (MCP) calls.
import type { EvalExample, EvalSuite } from "@aart/types";
import { runEvalHandler, wrapResult, type HandlerResult } from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requireFlagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export async function evalCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next?: string }> {
  const [subcommand, ...rest] = tokens.positionals;

  if (subcommand === "create") {
    const suiteId = requirePositional(rest, 0, "suite");
    const scorerKind = flagString(tokens.flags, "scorer") ?? "exact_match";
    const tags = flagString(tokens.flags, "tags")?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
    const suite: EvalSuite = { id: suiteId, name: suiteId, examples: [], scorer: { id: `${suiteId}-scorer`, kind: scorerKind }, tags };
    await cli.aart.store.evals.putSuite(suite);
    return { ok: true, suite };
  }

  if (subcommand === "add") {
    const suiteId = requirePositional(rest, 0, "suite");
    const runId = requireFlagString(tokens.flags, "from-run");
    const run = await cli.aart.store.runs.get(runId);
    if (!run) return { ok: false, error: `Run "${runId}" not found.` };
    const example: EvalExample = {
      id: `example_${crypto.randomUUID()}`,
      suiteId,
      sourceRunId: runId,
      input: run.inputs,
      expected: run.outputs ?? {},
      tags: ["from-run"],
    };
    await cli.aart.store.evals.putExample(example);
    return { ok: true, example };
  }

  if (subcommand === "run") {
    const suiteId = requirePositional(rest, 0, "suite");
    const workflowId = requireFlagString(tokens.flags, "workflow");
    const result = await runEvalHandler(cli.aart, { suiteId, workflowId, workflowVersion: flagString(tokens.flags, "version") });
    return wrapResult("aart_run_eval", result);
  }

  return { ok: false, error: "Usage: aart eval create <suite> | aart eval add <suite> --from-run <runId> | aart eval run <suite> --workflow <workflowId>" };
}
