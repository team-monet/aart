// ActivityFeedPage — V2 Wave 2A (AMENDMENTS.md A64), the visible half of
// John's VISIBILITY SYMMETRY vision: a reverse-chronological view over the
// V1 event log (AMENDMENTS.md A61), backfilled once on mount via
// GET /api/events, then kept live via a GET /api/events/stream
// EventSource (packages/dashboard/src/server.ts). Mirrors RunsPage.tsx's
// own fetch-on-mount/loading/empty-state idiom for the parts this page
// shares with every other list page; the EventSource wiring is this page's
// own addition, isolated to its own effect.
import { useEffect, useState } from "react";
import { Link } from "../router";
import { Button } from "@/components/ui/button";
import { CheckCircle, Info, RefreshCw, Rss, ShieldCheck, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EventLogEntry } from "@aart/types";

/** How many events GET /api/events backfills on mount — a reasonable
 * "recent activity" page size, independent of @aart/server's own
 * DEFAULT_EVENTS_LIMIT (100, the HTTP route's defensive cap on an
 * unauthenticated request) — this is a UI page-size choice, not a safety
 * limit. */
const BACKFILL_LIMIT = 50;

type EventFamily = "green" | "red" | "blue" | "gray";

/**
 * `EventLogEntry.type` is DELIBERATELY a plain string, not a closed zod enum
 * (@aart/types' event-log.ts, own header comment) — every write site across
 * CLI/MCP/server today emits one of the 16 documented values, matched
 * exactly below, but a future write site's new type string must still
 * render sensibly here (see classifyEvent's fallback), never fall through
 * to nothing.
 */
const FAMILY_BY_EXACT_TYPE: Record<string, EventFamily> = {
  // green — a positive terminal outcome
  "run.completed": "green",
  "workflow.approved": "green",
  // red — a negative/blocking outcome
  "run.failed": "red",
  "workflow.gate_failed": "red",
  // blue — review/gate progress (something is being decided or moved through a gate)
  "approval.requested": "blue",
  "approval.decided": "blue",
  "workflow.gate_passed": "blue",
  "workflow.validated": "blue",
  // gray — everything else: ops/authoring/eval bookkeeping
  "deployment.created": "gray",
  "deployment.promoted": "gray",
  "eval.suite_created": "gray",
  "eval.run_completed": "gray",
  "correction.recorded": "gray",
  "run.started": "gray",
  "run.cancelled": "gray",
  "workflow.version_registered": "gray",
  "workflow.deprecated": "gray",
};

function classifyEvent(type: string): EventFamily {
  return FAMILY_BY_EXACT_TYPE[type] ?? "gray";
}

const FAMILY_STYLE: Record<EventFamily, { icon: LucideIcon; className: string }> = {
  green: { icon: CheckCircle, className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  red: { icon: XCircle, className: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  blue: { icon: ShieldCheck, className: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
  gray: { icon: Info, className: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" },
};

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

/**
 * Links a row to whatever detail page its correlation ids actually resolve
 * to TODAY — `/runs/:id` and `/workflows/:id` are the only two id-addressable
 * routes this dashboard has (router.tsx); approvals/corrections/evals/
 * deployments are list-only (V1 Slice 6, deferred — see this slice's own
 * PARITY ID-ROUTES note). A run-scoped event always has `runId`; a
 * workflow-version-level gate/approval event (no run involved yet) falls
 * back to `workflowId` (event-log.ts's own header comment: "an
 * `approval.requested` event for a workflow-version-level review has no
 * `runId` at all"). Anything left over (a deployment/eval/correction-only
 * event) renders unlinked rather than pointing at a route that doesn't
 * exist.
 */
function linkForEvent(event: EventLogEntry): string | undefined {
  if (event.runId) return `/runs/${encodeURIComponent(event.runId)}`;
  if (event.workflowId) return `/workflows/${encodeURIComponent(event.workflowId)}`;
  return undefined;
}

export function ActivityFeedPage() {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);

  const fetchBackfill = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/events?limit=${BACKFILL_LIMIT}`);
      if (res.ok) {
        setEvents((await res.json()) as EventLogEntry[]);
      }
    } catch (err) {
      console.error("Failed to fetch activity feed", err);
    } finally {
      setLoading(false);
    }
  };

  // Backfill once on mount (the history path — newest-first, per
  // GET /api/events' own contract).
  useEffect(() => {
    fetchBackfill();
  }, []);

  // Then stay live: open a same-origin EventSource and prepend anything new,
  // deduping by id (a just-backfilled event and the stream's own seed tick
  // can legitimately overlap at connect time — see server.ts's own cursor
  // comment). Closed on unmount so navigating away from this page doesn't
  // leak an open connection.
  useEffect(() => {
    const source = new EventSource("/api/events/stream");
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (ev) => {
      try {
        const incoming = JSON.parse(ev.data) as EventLogEntry;
        setEvents((prev) => (prev.some((e) => e.id === incoming.id) ? prev : [incoming, ...prev]));
      } catch (err) {
        console.error("Failed to parse activity feed event", err);
      }
    };
    return () => {
      source.close();
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            <Rss className="h-8 w-8 text-primary" />
            Activity Feed
          </h1>
          <p className="text-sm text-zinc-400 flex items-center gap-2">
            Every governance lifecycle event, live.
            <span className={`inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider ${live ? "text-emerald-400" : "text-zinc-600"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
              {live ? "Live" : "Connecting..."}
            </span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchBackfill} className="border-zinc-800 hover:bg-zinc-900 text-zinc-300">
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center items-center py-24 text-zinc-500 text-sm font-medium">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin text-zinc-400" />
            Loading activity...
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-sm">
            No activity recorded yet.
          </div>
        ) : (
          <div className="divide-y divide-zinc-900">
            {events.map((event) => {
              const family = classifyEvent(event.type);
              const { icon: Icon, className } = FAMILY_STYLE[family];
              const href = linkForEvent(event);
              const content = (
                <div className="flex items-start gap-3 px-4 py-3 hover:bg-zinc-900/20">
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${className}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200">{event.summary}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] font-mono text-zinc-500">
                      <span className="uppercase tracking-wider">{event.type}</span>
                      <span>&middot;</span>
                      <span title={event.occurredAt}>{formatRelativeTime(event.occurredAt)}</span>
                    </div>
                  </div>
                </div>
              );
              return href ? (
                <Link key={event.id} href={href} className="block">
                  {content}
                </Link>
              ) : (
                <div key={event.id}>{content}</div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
