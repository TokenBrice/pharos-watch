"use client";

import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

interface TimeRangeButtonsProps {
  options: readonly TimeRangeOption[];
  value: string;
  onChange: (value: TimeRangeOption) => void;
}

export function TimeRangeButtons({ options, value, onChange }: TimeRangeButtonsProps) {
  return (
    <div className="flex gap-1 overflow-x-auto scrollbar-none max-w-full">
      {options.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={`px-3 sm:px-2.5 py-2 sm:py-1 min-h-11 sm:min-h-0 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
            value === r
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          {r === "all" ? "All" : r.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
