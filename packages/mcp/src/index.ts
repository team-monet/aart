// @aart/mcp — the 38-tool MCP surface, core/extended mode/data-gated
// registration, result-affordance pattern, YAML uses/with compiler,
// init-agent, recipes (architecture §10, spec §32-34). Package root export.
// @aart/cli imports directly from here so CLI and MCP never diverge into
// two implementations of the same action (architecture's three-clients
// principle).

export {
  createAartContext,
  createRealAartContext,
  createRealAartContextWithEngine,
  resolveTrustModeFromEnv,
  type AartContext,
  type CreateAartContextOptions,
  type RealAartContextResult,
} from "./context.js";

// Re-exported so a consumer that needs the raw @aart/engine Engine instance
// `createRealAartContextWithEngine` hands back (e.g. @aart/cli's real
// ServerPort, which feeds it into @aart/server's createRealEngineBoundary —
// AMENDMENTS.md A42) can name its type without taking its own direct
// @aart/engine dependency — this package already depends on @aart/engine
// for real-context.ts, so threading its type through here broadens this
// package's public surface rather than adding a new one.
export type { Engine } from "@aart/engine";

export type {
  AutoApprovalState,
  BlockCatalogEntry,
  BlockSearchResult,
  BundleLike,
  BundlerPort,
  ClearRunFlagResult,
  EnginePort,
  EvidencePort,
  GateName,
  GovernancePort,
  PromotionEvaluation,
  RegistryPort,
  RemoteEntry,
  RemotesPort,
  ResumeOutcome,
  SemanticRiskDiffShape,
  ServerHandleLike,
  ServerPort,
  ValidationFinding,
  ValidationResultShape,
  WorkerHandleLike,
} from "./types.js";

// D1 "remotes + push" (AMENDMENTS.md A56) — resolveAndProduceBundle is the
// resolveDeployment/bundleToBundleLike bridge @aart/cli's real-server-port.ts
// imports directly (this package already depends on @aart/mcp — architecture's
// three-clients principle — one shared implementation, not two).
export { resolveAndProduceBundle } from "./real-context.js";

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
export { AART_VERSION } from "./version.js";

export * from "./handlers/index.js";

export { getToolDefinition, TOOL_DEFINITIONS, type ToolDefinition } from "./tools/definitions.js";

export { createMcpServer, isToolRegistered, listRegisteredTools, type McpServerLike, type ToolCallResult } from "./tools/server.js";

export { startMcpStdioServer, type McpStdioHandle } from "./mcp-stdio.js";
