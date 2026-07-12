// createRealServerPort — the REAL ServerPort (AMENDMENTS.md A42; see
// real-context.ts's module doc comment for the corrected story A37 left
// stale). Mirrors stubs/server.ts's documented exports one-for-one, each
// now backed by @aart/server's real, already-complete machinery instead of
// a simplified stand-in:
//   - startServer/startWorker <- @aart/server's real startServer/startWorker,
//     fed a real EngineBoundary (createRealEngineBoundary) over the SAME
//     Engine instance cli-context.ts's createRealAartContextWithEngine call
//     already built for this same process's AartContext — one Engine, one
//     store, shared by every port/command in one CLI invocation, never two
//     divergent ones. AMENDMENTS.md A45: startServer now also wires a real
//     secretResolver (secrets.ts — the piece A44 found missing, so webhook/
//     github/slack HMAC verification can actually succeed) and resolves
//     `config.environment`'s human-readable name into the `environmentId`
//     ServerConfig scopes trigger-binding activation by. AMENDMENTS.md A57
//     (D1 fix pass, BLOCKER): startServer now also resolves
//     resolveDeployToken(root) (secrets.ts) and threads it into
//     ServerConfig.deployToken — A56 built the whole deploy-token gate
//     (/bundles/ingest, /bundles/plan, /environments) plus this exact
//     resolver, but never wired the resolver into this, the ONE real
//     production composition root, so every one of those routes refused
//     every request unconditionally through a real `aart server` until now.
//     AMENDMENTS.md A59 (D2a security hardening): startServer now also
//     threads `config.host` straight through to ServerConfig.host — the
//     breaking-change loopback-only bind default lives in @aart/server
//     itself (ServerHttpConfig.host's own doc comment), this composition
//     root just passes whatever commands/process.ts's --host/AART_HOST
//     resolved (or undefined, letting @aart/server's own default apply).
//   - produceBundle <- AMENDMENTS.md A56 (D1 "remotes + push"): now a thin
//     call into `@aart/mcp`'s `resolveAndProduceBundle` (real-context.ts) —
//     the resolveDeployment/bundleToBundleLike bridge that used to live
//     here as a local, CLI-only copy is EXTRACTED there so `aart_deploy`
//     (MCP's own `BundlerPort`, real-context.ts's `createRealBundlerPort`)
//     shares the identical implementation instead of a second, independently-
//     drifting one — this package already depends on `@aart/mcp`
//     (architecture's three-clients principle), so importing it here is a
//     value-source swap, not a new dependency. Same net behavior as before
//     this extraction: ServerPort.produceBundle's `environment?: string` is
//     a NAME (what a human types after `--environment`); the bridge
//     resolves it to a `Deployment` (throwing only if the NAMED environment
//     doesn't exist — a real environment with no deployment for this
//     workflow yet is a legitimate "bare closure bundle" request, not an
//     error) and flattens the real, richer `Bundle` return into
//     `BundleLike` using the exact on-disk layout @aart/server's own
//     writeBundleToDisk uses.
//   - clearRunFlag/listFlaggedRuns <- @aart/server's real flags.ts exports
//     (the stub already reimplemented these correctly against the real,
//     frozen RunRecord.flag field — this just delegates to the canonical
//     implementation instead of a second copy of the same logic).
import { consoleJsonSink, type AartStore } from "@aart/store";
import { resolveAndProduceBundle } from "@aart/mcp";
import type { BundleLike, ClearRunFlagResult, Engine, ServerHandleLike, ServerPort, WorkerHandleLike } from "@aart/mcp";
import {
  clearRunFlag as realClearRunFlag,
  createRealEngineBoundary,
  listFlaggedRuns as realListFlaggedRuns,
  startServer as startRealServer,
  startWorker as startRealWorker,
} from "@aart/server";
import { writeBundleFilesToDisk } from "./bundle-files.js";
import { createRealSecretResolver, resolveDeployToken } from "./secrets.js";

/** `aart server --environment <name>`'s bridge (AMENDMENTS.md A45): a human names an Environment, `ServerConfig.environmentId` (config.ts) wants its id. A genuinely CLI-only concern (unlike `produceBundle`'s own environment-name resolution above, now shared with MCP) — left as its own local implementation, not part of the `resolveAndProduceBundle` extraction. Same "throw only when the NAME itself doesn't exist" discipline, for the same reason — an operator typo in `--environment` should fail loudly at startup, not silently fall back to "every environment" (this function's caller, `startServer` below, only calls this when `config.environment` is actually given; omitting the flag entirely is the documented "all environments" default and never reaches here). */
async function resolveEnvironmentId(store: AartStore, environmentName: string): Promise<string> {
  const environment = await store.environments.getByName(environmentName);
  if (!environment) {
    throw new Error(`aart server: environment "${environmentName}" not found. Register it first, e.g. "aart deploy <workflowId> --target ${environmentName}".`);
  }
  return environment.id;
}

/**
 * `store`/`engine` mirror `createRealEngineBoundary`'s own inputs (this
 * process's shared Engine — see this file's module doc comment). `root`
 * (AMENDMENTS.md A45) is the resolved `.aart` store root
 * (`CreateAartContextOptions.root`, already resolved once by
 * `cli-context.ts` before this function is called) — needed here so the
 * real `secretResolver`'s store-adjacent `secrets.json` fallback
 * (secrets.ts) reads from the SAME root this CLI invocation's store is
 * actually rooted at, not an independently-recomputed (and potentially
 * divergent, e.g. under `--root`) default.
 */
export function createRealServerPort(store: AartStore, engine: Engine, root: string): ServerPort {
  const boundary = createRealEngineBoundary(store, engine);
  const secretResolver = createRealSecretResolver(root);

  return {
    async startServer(config): Promise<ServerHandleLike> {
      const environmentId = config.environment ? await resolveEnvironmentId(store, config.environment) : undefined;
      // D1 fix pass (AMENDMENTS.md A57) — BLOCKER fixed here: this call used
      // to omit deployToken entirely, so ServerConfig.deployToken was always
      // undefined through a REAL `aart server`, and /bundles/ingest,
      // /bundles/plan, /environments refused every request unconditionally
      // ("no AART_DEPLOY_TOKEN configured") — even a correctly-token'd one.
      // resolveDeployToken (secrets.ts) has existed since A56 but had ZERO
      // production callers until this line. Resolved HERE, not hoisted
      // beside secretResolver above, because resolveDeployToken is async
      // and this factory function itself is sync — startServer is the
      // first async boundary available, and per secrets.ts's own doc
      // comment this resolution is meant to happen "exactly ONCE at
      // process startup," which matches startServer being called exactly
      // once per `aart server` invocation.
      const deployToken = await resolveDeployToken(root);
      // D1 fix pass (AMENDMENTS.md A58) — logSink: consoleJsonSink is the
      // FOURTH occurrence of this exact composition-root-gap bug class in
      // this repo (A48, A53, A57's own FIX 1, now this): @aart/store's
      // createLogger defaults to a silent noopSink (architecture §16's own
      // documented default), and ServerConfig.logSink/WorkerConfig.logSink
      // have existed since S2 — but nothing under packages/cli/src ever
      // passed one through, so a real `aart server`'s structured JSON
      // logging (including this very file's own FIX-3 tokenless-promote
      // startup warning, @aart/server's http/server.ts:232) was firing into
      // a sink that discards every line, despite DEPLOY.md documenting
      // "structured JSON logs to stdout" as the out-of-the-box behavior.
      // Default-on, unconditionally — no new CLI flag/env var: this repo has
      // no existing log-level/format convention to extend (checked), and
      // "structured JSON logs to stdout by default" is the exact claim
      // DEPLOY.md already made and this fix makes true rather than inventing
      // new config surface for.
      // D2a security hardening, breaking-change bind default (AMENDMENTS.md
      // A59) — config.host threaded straight through; @aart/server's own
      // ServerHttpConfig.host defaults to loopback-only when omitted (see
      // that type's doc comment) — this composition root doesn't need its
      // own default, just to pass through whatever the caller (commands/
      // process.ts's --host/AART_HOST) resolved.
      return startRealServer({ store, engine: boundary, port: config.port, host: config.host, secretResolver, environmentId, deployToken, logSink: consoleJsonSink });
    },

    async startWorker(options): Promise<WorkerHandleLike> {
      // installSignalHandler: false — this package's own commands/process.ts
      // owns SIGTERM/SIGINT lifecycle for a CLI-invoked worker/server process
      // (waits on the signal, then calls this handle's stop()/close() itself,
      // so it can also print a clean "stopped" result) rather than letting
      // @aart/server's own default self-installed handler race it — see
      // process.ts's workerCommand/serverCommand.
      // logSink: consoleJsonSink — same fix, same reasoning, as startServer
      // above (AMENDMENTS.md A58).
      return startRealWorker({ store, engine: boundary, workerId: options.workerId, installSignalHandler: false, logSink: consoleJsonSink });
    },

    // AMENDMENTS.md A56: the shared bridge (real-context.ts) resolves
    // params.environment's name to a Deployment, threads it into
    // manifest.targetEnvironment, and flattens the result to BundleLike —
    // see this file's own module doc comment.
    produceBundle: (params): Promise<BundleLike> => resolveAndProduceBundle(store, params),

    async writeBundleToDisk(bundle: BundleLike, outDir: string): Promise<void> {
      await writeBundleFilesToDisk(bundle.files, outDir);
    },

    async clearRunFlag(runId: string, clearedBy: string): Promise<ClearRunFlagResult> {
      return realClearRunFlag(store, runId, clearedBy);
    },

    async listFlaggedRuns() {
      return realListFlaggedRuns(store);
    },
  };
}
