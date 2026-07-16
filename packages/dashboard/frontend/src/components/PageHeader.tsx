import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface PageHeaderProps {
  icon?: LucideIcon;
  iconColor?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ icon: Icon, iconColor = "text-primary", title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex justify-between items-start gap-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="mt-1 p-2 rounded-lg bg-zinc-900 border border-zinc-800">
            <Icon className={`h-5 w-5 ${iconColor}`} />
          </div>
        )}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">{title}</h1>
          {subtitle && <p className="text-sm text-zinc-400 mt-1">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
