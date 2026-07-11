import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: string }) {
  const s = status ? status.toLowerCase() : "";
  let className = "bg-zinc-500/10 text-zinc-400 border-zinc-500/20";
  
  if (s === "completed" || s === "approved" || s === "passed" || s === "ok" || s === "cleared") {
    className = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  } else if (s === "failed" || s === "rejected" || s === "error" || s === "poison") {
    className = "bg-rose-500/10 text-rose-400 border-rose-500/20";
  } else if (s === "running" || s === "active") {
    className = "bg-sky-500/10 text-sky-400 border-sky-500/20";
  } else if (s === "pending" || s === "draft" || s === "needs_changes") {
    className = "bg-amber-500/10 text-amber-400 border-amber-500/20";
  } else if (s === "waiting" || s === "needs_review") {
    className = "bg-purple-500/10 text-purple-400 border-purple-500/20";
  }
  
  return (
    <Badge variant="outline" className={`${className} uppercase tracking-wider text-[10px] px-2 py-0.5 rounded font-mono font-semibold`}>
      {status || "unknown"}
    </Badge>
  );
}
