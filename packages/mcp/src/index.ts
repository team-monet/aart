// @aart/mcp — the 21-tool MCP surface, core/extended mode-gated
// registration, result-affordance pattern, YAML uses/with compiler,
// init-agent, recipes (architecture §10, spec §32-34). Package root export.
// @aart/cli imports directly from here so CLI and MCP never diverge into
// two implementations of the same action (architecture's three-clients
// principle).

export { createAartContext, resolveTrustModeFromEnv, type AartContext, type CreateAartContextOptions } from "./context.js";

export type {
  AutoApprovalState,
  BlockCatalogEntry,
  BlockSearchResult,
  BundleLike,
  ClearRunFlagResult,
  EnginePort,
  EvidencePort,
  GateName,
  GovernancePort,
  PromotionEvaluation,
  RegistryPort,
  ResumeOutcome,
  SemanticRiskDiffShape,
  ServerHandleLike,
  ServerPort,
  ValidationFinding,
  ValidationResultShape,
  WorkerHandleLike,
} from "./types.js";

export {
  computeNext,
  wrapResult,
  TOOL_NAMES,
  TOOL_TIERS,
  type HandlerResult,
  type ToolName,
  type ToolOutcome,
  type ToolTier,
} from "./response.js";

export { compileWorkflowInput, compileWorkflowObject, compileYamlWorkflow, YamlCompileError } from "./yaml-compiler.js";

export { matchRecipe, matchRecipes, RECIPES, type Recipe, type RecipeMatch } from "./recipes.js";

export { generateInitAgentOutputs, type GenerateInitAgentOptions, type InitAgentOutputs, type McpConfig } from "./init-agent.js";

export { BUILTIN_BLOCK_CATALOG, NATIVE_ALIASES } from "./catalog.js";

export * from "./handlers/index.js";

export { getToolDefinition, TOOL_DEFINITIONS, type ToolDefinition } from "./tools/definitions.js";

export { createMcpServer, isToolRegistered, listRegisteredTools, type McpServerLike, type ToolCallResult } from "./tools/server.js";

export { startMcpStdioServer, type McpStdioHandle } from "./mcp-stdio.js";
