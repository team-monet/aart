import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: LucideIcon;
  message: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon = Inbox, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-zinc-500 animate-fade-in" role="status">
      <div className="p-4 rounded-2xl bg-zinc-900/50 border border-zinc-800/50 mb-4">
        <Icon className="h-8 w-8 text-zinc-600" />
      </div>
      <p className="text-sm font-medium">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
