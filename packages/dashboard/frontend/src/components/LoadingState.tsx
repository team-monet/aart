import { RefreshCw } from "lucide-react";

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = "Loading..." }: LoadingStateProps) {
  return (
    <div className="flex justify-center items-center py-24 text-zinc-500 text-sm font-medium" aria-live="polite">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin text-zinc-400" />
      {message}
    </div>
  );
}
