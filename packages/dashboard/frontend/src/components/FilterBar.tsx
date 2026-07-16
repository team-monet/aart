import type { ReactNode } from "react";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FilterBarProps {
  children: ReactNode;
  onClear?: () => void;
  showClear?: boolean;
}

export function FilterBar({ children, onClear, showClear }: FilterBarProps) {
  return (
    <div className="flex flex-wrap gap-4 items-center p-4 bg-zinc-900/30 border border-zinc-800 rounded-xl animate-fade-in">
      <div className="flex items-center gap-1.5 text-zinc-400 text-sm">
        <Filter className="h-4 w-4" />
        <span>Filters:</span>
      </div>
      <div className="flex gap-2 flex-wrap">{children}</div>
      {showClear && onClear && (
        <Button variant="ghost" size="sm" onClick={onClear} className="text-zinc-500 hover:text-zinc-300 text-xs">
          Clear Filters
        </Button>
      )}
    </div>
  );
}
