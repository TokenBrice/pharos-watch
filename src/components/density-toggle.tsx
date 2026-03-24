"use client";

import { List, ListCollapse, ListStart, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TableDensity } from "@/hooks/use-table-density";

interface DensityToggleProps {
  value: TableDensity;
  onChange: (density: TableDensity) => void;
  className?: string;
}

const options: { value: TableDensity; label: string; icon: typeof List }[] = [
  { value: "list", label: "List", icon: Rows3 },
  { value: "compact", label: "Compact", icon: ListCollapse },
  { value: "comfortable", label: "Comfortable", icon: List },
  { value: "spacious", label: "Spacious", icon: ListStart },
];

export function DensityToggle({ value, onChange, className }: DensityToggleProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-1 rounded-2xl border border-border/60 p-1 sm:grid-cols-2",
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
              "pharos-focus-ring pharos-control-pill flex w-full items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-all duration-200",
              isActive
                ? "pharos-control-pill-active"
                : "border-transparent shadow-none"
            )}
            title={`${option.label} view`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
