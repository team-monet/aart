// createMcpServer — the core/extended mode-gated tool LIST + call dispatch
// (architecture §10.1, §7.2). Deliberately protocol-agnostic: `listTools`/
// `callTool` are plain async functions, unit-testable with no real stdio/
// transport involved. `../mcp-stdio.ts` is the thin adapter that mounts
// this onto the real `@modelcontextprotocol/sdk` for actual `aart mcp`
// runtime use — see that file for why the split.
//
// Mode-gating (architecture §7.2's `[DECISION]`, load-bearing): enforced at
// tool-list construction. `aart_approve` is genuinely ABSENT from
// `listTools()`'s result in strict/production — not merely rejected if
// called — matching "an agent in strict mode should never even see
// aart_approve as an option to attempt."
//
// Progressive disclosure (architecture §10.1's `[DECISION]`): the 5 named
// extended tools gate on real data existing (`aart_deploy_workflow`/
// `aart_trigger_workflow` on >=1 Environment; `aart_create_eval_from_correction`/
// `aart_run_eval`/`aart_promote_workflow` on >=1 EvalSuite) — "a soft
// progressive-disclosure heuristic ... rather than a hard mode gate like
// aart_approve's." The other 6 extended tools have no data-existence
// precondition named anywhere in either source document, so they register
// unconditionally alongside the 9 non-gated core tools.
import type { AartContext } from "../context.js";
import { HANDLERS } from "../handlers/index.js";
import { TOOL_NAMES, wrapResult, type HandlerResult, type ToolName } from "../response.js";
import { getToolDefinition, TOOL_DEFINITIONS, type ToolDefinition } from "./definitions.js";

const ENVIRONMENT_GATED_TOOLS: ReadonlySet<ToolName> = new Set(["aart_deploy_workflow", "aart_trigger_workflow"]);
const EVAL_SUITE_GATED_TOOLS: ReadonlySet<ToolName> = new Set(["aart_create_eval_from_correction", "aart_run_eval", "aart_promote_workflow"]);

export async function isToolRegistered(ctx: AartContext, tool: ToolName): Promise<boolean> {
  if (tool === "aart_approve") {
    return ctx.governance.isAartApproveRegisteredForMode(ctx.trustMode);
  }
  if (ENVIRONMENT_GATED_TOOLS.has(tool)) {
    const environments = await ctx.store.environments.list();
    return environments.length > 0;
  }
  if (EVAL_SUITE_GATED_TOOLS.has(tool)) {
    const suites = await ctx.store.evals.listSuites();
    return suites.length > 0;
  }
  return true;
}

/** The tool list an MCP client actually sees for `ctx`'s current trust mode + store state — this is what the mode-gating test asserts against directly, not "does calling aart_approve fail." */
export async function listRegisteredTools(ctx: AartContext): Promise<ToolDefinition[]> {
  const registered: ToolDefinition[] = [];
  for (const def of TOOL_DEFINITIONS) {
    if (await isToolRegistered(ctx, def.name)) registered.push(def);
  }
  return registered;
}

export type ToolCallResult = HandlerResult & { next: string };

export interface McpServerLike {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: unknown): Promise<ToolCallResult>;
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Builds the protocol-agnostic core: `listTools()`/`callTool()`. See module doc comment for why this doesn't itself speak MCP wire protocol. */
export function createMcpServer(ctx: AartContext): McpServerLike {
  return {
    listTools: () => listRegisteredTools(ctx),

    async callTool(name: string, args: unknown): Promise<ToolCallResult> {
      if (!isToolName(name)) {
        return { ok: false, error: `Unknown tool "${name}".`, next: "Call listTools to see the currently available tools." };
      }
      const registered = await isToolRegistered(ctx, name);
      if (!registered) {
        return {
          ok: false,
          error: `Tool "${name}" is not currently registered (mode-gated, or its progressive-disclosure precondition isn't met yet).`,
          next: "Call listTools to see what's currently available.",
        };
      }
      const definition = getToolDefinition(name);
      const parsed = definition.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return { ok: false, error: `Invalid arguments for "${name}": ${parsed.error.message}`, next: "Fix the arguments and call this tool again." };
      }
      const handler = HANDLERS[name];
      const result = await handler(ctx, parsed.data);
      return wrapResult(name, result);
    },
  };
}
