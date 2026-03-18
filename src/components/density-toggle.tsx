"use client";

import { List, ListCollapse, ListStart } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TableDensity } from "@/hooks/use-table-density";

interface DensityToggleProps {
  value: TableDensity;
  onChange: (density: TableDensity) => void;
  className?: string;
}

const options: { value: TableDensity; label: string; icon: typeof List }[] = [
  { value: "compact", label: "Compact", icon: ListCollapse },
  { value: "comfortable", label: "Comfortable", icon: List },
  { value: "spacious", label: "Spacious", icon: ListStart },
];

export function DensityToggle({ value, onChange, className }: DensityToggleProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border border-border/60 bg-background/50 p-0.5",
        className
      )}
      role="radiogroup"
      aria-label="Table density"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const isActive = value === option.value;

        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-200",
              isActive
                ? "bg-foreground text-background shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
            title={`${option.label} view`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
