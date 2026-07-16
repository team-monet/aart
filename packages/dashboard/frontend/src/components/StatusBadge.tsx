import { Badge } from "@/components/ui/badge";

const STATUS_STYLES: Record<string, { badge: string; dot?: string }> = {
  completed: { badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  approved: { badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  passed: { badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  ok: { badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  cleared: { badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  failed: { badge: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  rejected: { badge: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  error: { badge: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  poison: { badge: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  running: { badge: "bg-sky-500/10 text-sky-400 border-sky-500/20", dot: "bg-sky-400" },
  active: { badge: "bg-sky-500/10 text-sky-400 border-sky-500/20", dot: "bg-sky-400" },
  pending: { badge: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  draft: { badge: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  needs_changes: { badge: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  waiting: { badge: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  needs_review: { badge: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
};

const DEFAULT_STYLE = { badge: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" };

export function StatusBadge({ status }: { status: string }) {
  const s = status ? status.toLowerCase() : "";
  const style = STATUS_STYLES[s] || DEFAULT_STYLE;

  return (
    <Badge
      variant="outline"
      className={`${style.badge} uppercase tracking-wider text-[10px] px-2 py-0.5 rounded font-mono font-semibold transition-transform hover:scale-105 inline-flex items-center gap-1.5`}
    >
      {style.dot && (
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot} animate-pulse-dot`} />
      )}
      {status || "unknown"}
    </Badge>
  );
}
