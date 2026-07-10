// The scheduler ticker (architecture §4.4.3/§4.7) — @aart/server owns and
// runs this loop. "S1 exports getDueWaits(now)... S2's ticker loop calls
// that export on a fixed interval and layers cron/poll-specific scheduling
// logic... on top. S2's loop is also where §4.7's lease-reclaim sweep
// runs." ONE logical component driving THREE consumers (timer-wait wake,
// §29 cron schedules, §21.2 poll triggers) plus the reclaim sweep — not
// four separate polling loops.
import type { AartStore } from "@aart/store";
import type { Schedule } from "@aart/types";
import type { Clock } from "../clock.js";
import { DEFAULT_MAX_RECLAIM_COUNT, DEFAULT_TICK_INTERVAL_MS, type BackpressureConfig, type PoisonGuardConfig } from "../config.js";
import type { EngineBoundary } from "../engine/boundary.js";
import type { Logger } from "../logger.js";
import { adaptPollFire, adaptScheduleFire } from "../triggers/adapters.js";
import { processTriggerIntake } from "../triggers/intake.js";
import { loadTriggerBindingsFromDeployments } from "../triggers/registry.js";
import type { TriggerBinding } from "../triggers/types.js";
import { runReclaimSweep, type ReclaimSweepResult } from "../worker/reclaim.js";
import { cronFireTimesBetween } from "./cron.js";

export interface TickerDeps {
  store: AartStore;
  engine: EngineBoundary;
  clock: Clock;
  logger: Logger;
}

export interface TickerOptions {
  tickIntervalMs?: number;
  maxReclaimCount?: number;
  backpressure?: BackpressureConfig;
  poisonGuard?: PoisonGuardConfig;
  /** How far back to look for cron fire times that should have happened while nothing was ticking (a restart, a slow deploy) — this is what makes `missedRunPolicy` meaningful across a process gap despite the frozen `Schedule` type carrying no `lastFiredAt`/`nextFireAt` field (see this task's final report / AMENDMENTS.md: this ticker instead treats existing `RunRecord`s as the ground truth for "did this occurrence already fire"). Defaults to 24h. */
  missedRunLookbackMs?: number;
  /** Injectable fetch for poll triggers — defaults to the global `fetch`. */
  fetchImpl?: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;
}

export interface TickResult {
  timerWaitsResumed: number;
  scheduleFires: number;
  pollFires: number;
  reclaim: ReclaimSweepResult;
}

export interface TickerHandle {
  start(): void;
  stop(): void;
  /** Runs one tick immediately, outside the interval — used by tests and by `start()`'s own first tick. */
  tickOnce(): Promise<TickResult>;
}

function evaluatePollCondition(_expr: string | undefined, _response: unknown): boolean {
  // A poll `condition` (architecture §6.1 `[DECISION]`: "a {{ }} expression
  // over the poll response... fires only when true") needs a boolean-typed
  // resolution against a `{ response }`-shaped context. @aart/expr's
  // grammar (architecture §3.1) is deliberately property-paths-only, with
  // no comparison operators — so a condition like "value changed since last
  // poll" cannot be expressed as a single {{ }} property-path lookup at
  // all; it inherently needs comparison against PRIOR poll state, which
  // @aart/expr's stateless resolver has no notion of. Default: fire on
  // every poll tick when no richer condition mechanism is wired in — a
  // safe, honest default (never silently drops a fire) rather than
  // guessing at a comparison DSL neither document specifies. A caller
  // wanting real change-detection semantics supplies its own predicate via
  // `TriggerBinding.pollCondition`'s companion mechanism if/when one is
  // designed (documented gap — see this task's final report).
  return true;
}

export function createTicker(deps: TickerDeps, options: TickerOptions = {}): TickerHandle {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const maxReclaimCount = options.maxReclaimCount ?? DEFAULT_MAX_RECLAIM_COUNT;
  const missedRunLookbackMs = options.missedRunLookbackMs ?? 24 * 60 * 60 * 1000;
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url));

  let intervalHandle: { cancel(): void } | undefined;
  let lastCronCheckAt: Date | undefined;
  const lastPolledAt = new Map<string, number>();
  let startupReconciled = false;

  async function fireSchedule(schedule: Schedule, firedAt: Date): Promise<void> {
    const binding: TriggerBinding = { id: schedule.id, type: "schedule", workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, mode: "start" };
    const adapted = adaptScheduleFire(schedule, firedAt.toISOString(), deps.clock);
    const outcome = await processTriggerIntake({ store: deps.store, engine: deps.engine, clock: deps.clock, logger: deps.logger, backpressure: options.backpressure, poisonGuard: options.poisonGuard }, binding, adapted);
    deps.logger.info("schedule fired", { scheduleId: schedule.id, firedAt: firedAt.toISOString(), outcome: outcome.kind });
  }

  /** Which cron fire times in a window already have a corresponding run — the run-history-scan this ticker uses in place of a persisted `lastFiredAt` (see module doc comment on `missedRunLookbackMs`). A fire time counts as "already fired" if a `schedule`-type run exists for this schedule whose `trigger.payload.firedAt` falls within the same minute. */
  async function alreadyFiredMinutes(schedule: Schedule): Promise<Set<number>> {
    const runs = await deps.store.runs.list({ workflowId: schedule.workflowId });
    const minutes = new Set<number>();
    for (const run of runs) {
      if (run.trigger.type !== "schedule" || run.trigger.source !== schedule.id) continue;
      const payload = run.trigger.payload as { firedAt?: string } | null;
      if (!payload?.firedAt) continue;
      const t = new Date(payload.firedAt).getTime();
      if (!Number.isNaN(t)) minutes.add(Math.floor(t / 60_000));
    }
    return minutes;
  }

  async function reconcileMissedRuns(now: Date): Promise<void> {
    const schedules = (await deps.store.schedules.list({ paused: false })) ?? [];
    for (const schedule of schedules) {
      const from = new Date(now.getTime() - missedRunLookbackMs);
      const fires = cronFireTimesBetween(schedule.cron, schedule.timezone, from, now);
      if (fires.length === 0) continue;
      const already = await alreadyFiredMinutes(schedule);
      const missed = fires.filter((f) => !already.has(Math.floor(f.getTime() / 60_000)));
      if (missed.length === 0) continue;
      const policy = schedule.missedRunPolicy;
      if (policy === "skip") {
        deps.logger.info("schedule had missed occurrences — skipping per missedRunPolicy", { scheduleId: schedule.id, missed: missed.length });
        continue;
      }
      if (policy === "fire_once") {
        await fireSchedule(schedule, missed[missed.length - 1]!);
        continue;
      }
      // fire_all
      for (const fire of missed) {
        await fireSchedule(schedule, fire);
      }
    }
  }

  async function checkCronSchedules(now: Date): Promise<number> {
    const from = lastCronCheckAt ?? new Date(now.getTime() - tickIntervalMs);
    lastCronCheckAt = now;
    const schedules = (await deps.store.schedules.list({ paused: false })) ?? [];
    let count = 0;
    for (const schedule of schedules) {
      const fires = cronFireTimesBetween(schedule.cron, schedule.timezone, from, now);
      for (const fire of fires) {
        await fireSchedule(schedule, fire);
        count += 1;
      }
    }
    return count;
  }

  async function checkPollTriggers(now: Date): Promise<number> {
    const bindings = (await loadTriggerBindingsFromDeployments(deps.store)).filter((b) => b.type === "poll" && b.pollUrl);
    let count = 0;
    for (const binding of bindings) {
      const interval = binding.pollIntervalMs ?? 60_000;
      const last = lastPolledAt.get(binding.id) ?? 0;
      if (now.getTime() - last < interval) continue;
      lastPolledAt.set(binding.id, now.getTime());
      try {
        const response = await (binding.pollFetch ?? fetchImpl)(binding.pollUrl!);
        const body = await response.json();
        if (!evaluatePollCondition(binding.pollCondition, body)) continue;
        const adapted = adaptPollFire(binding, body, deps.clock);
        const outcome = await processTriggerIntake({ store: deps.store, engine: deps.engine, clock: deps.clock, logger: deps.logger, backpressure: options.backpressure, poisonGuard: options.poisonGuard }, binding, adapted);
        deps.logger.info("poll trigger fired", { bindingId: binding.id, outcome: outcome.kind });
        count += 1;
      } catch (err) {
        deps.logger.error("poll trigger fetch failed", { bindingId: binding.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return count;
  }

  async function resumeTimerWaits(now: Date): Promise<number> {
    const due = await deps.engine.getDueWaits(now.toISOString());
    let count = 0;
    for (const { runId, stepId } of due) {
      const result = await deps.engine.resumeDirect(runId, stepId, { resumedAt: now.toISOString(), mechanism: "timer" });
      if (result.kind === "resumed") count += 1;
      deps.logger.info("timer wait checked at tick", { runId, stepId, outcome: result.kind });
    }
    return count;
  }

  async function tickOnce(): Promise<TickResult> {
    const now = deps.clock.now();
    if (!startupReconciled) {
      startupReconciled = true;
      await reconcileMissedRuns(now);
      lastCronCheckAt = now;
    }
    const timerWaitsResumed = await resumeTimerWaits(now);
    const scheduleFires = await checkCronSchedules(now);
    const pollFires = await checkPollTriggers(now);
    const reclaim = await runReclaimSweep(deps.store, deps.clock, deps.logger, maxReclaimCount);
    return { timerWaitsResumed, scheduleFires, pollFires, reclaim };
  }

  return {
    start() {
      if (intervalHandle) return;
      void tickOnce().catch((err) => deps.logger.error("ticker tick failed", { error: err instanceof Error ? err.message : String(err) }));
      const schedule = (): void => {
        intervalHandle = deps.clock.setTimeout(() => {
          void tickOnce()
            .catch((err) => deps.logger.error("ticker tick failed", { error: err instanceof Error ? err.message : String(err) }))
            .finally(schedule);
        }, tickIntervalMs);
      };
      schedule();
    },
    stop() {
      intervalHandle?.cancel();
      intervalHandle = undefined;
    },
    tickOnce,
  };
}
