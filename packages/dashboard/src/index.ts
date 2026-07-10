// @aart/dashboard — architecture §13, spec §35. Server-rendered v1
// read-only pages / v2 writable actions / v3 production views over
// @aart/server's HTTP API, with every writable action a thin call to the
// same function its CLI/MCP counterpart calls (architecture §13.2's
// three-client principle).
//
// Composition-root usage:
//
//   import { startDashboard, createHttpApiClient, createStubDeps } from "@aart/dashboard";
//   import { createFsStore } from "@aart/store";
//
//   const store = createFsStore("./.aart");
//   const handle = await startDashboard({
//     store,
//     api: createHttpApiClient("http://localhost:8080"), // a running `aart server`
//     deps: createStubDeps(store),                        // swap for real S4/S6 imports at S9 merge
//     workerUrls: ["http://localhost:8787"],
//   });

export { startDashboard, buildDashboardRouter, type DashboardHandle } from "./server.js";
export { type DashboardConfig, DEFAULT_DASHBOARD_PORT } from "./config.js";

export { createHttpApiClient, createFakeApiClient, type ApiClient, type WaitingRunEntry, type HealthPayload } from "./api-client.js";

export { createStubDeps, identityRedact, echoExecute } from "./stub-deps.js";
export type {
  DashboardDeps,
  ClearRunFlagResult,
  TriggerRunInput,
  ResumeOutcome,
  ResumeMechanism,
  PromotionRecord,
  PromotionEvaluation,
  PromoteResult,
  RecordCorrectionInput,
  ReportRenderers,
  ScorerRegistry,
  ScorerResult,
  RunEvalSuiteResult,
  GateName,
} from "./deps.js";

export { systemClock, createFakeClock, type Clock } from "./clock.js";
export { createDashboardLogger, consoleJsonSink, type Logger } from "./logger.js";
