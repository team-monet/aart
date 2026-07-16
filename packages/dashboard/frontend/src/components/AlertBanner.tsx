import { AlertTriangle, CheckCircle, Info, XCircle } from "lucide-react";

const VARIANTS = {
  error: {
    container: "bg-red-950/30 border-red-500/20 text-red-400",
    icon: XCircle,
  },
  success: {
    container: "bg-emerald-950/30 border-emerald-500/20 text-emerald-400",
    icon: CheckCircle,
  },
  warning: {
    container: "bg-amber-950/30 border-amber-500/20 text-amber-400",
    icon: AlertTriangle,
  },
  info: {
    container: "bg-sky-950/30 border-sky-500/20 text-sky-400",
    icon: Info,
  },
} as const;

interface AlertBannerProps {
  variant: keyof typeof VARIANTS;
  message: string | null | undefined;
}

export function AlertBanner({ variant, message }: AlertBannerProps) {
  if (!message) return null;

  const { container, icon: Icon } = VARIANTS[variant];

  return (
    <div className={`flex items-center gap-2.5 p-3 border rounded-lg text-xs font-medium animate-fade-in ${container}`} role="alert">
      <Icon className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
