"use client";

import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

interface TimeRangeButtonsProps {
  options: readonly TimeRangeOption[];
  value: string;
  onChange: (value: TimeRangeOption) => void;
}

export function TimeRangeButtons({ options, value, onChange }: TimeRangeButtonsProps) {
  return (
    <div className="flex min-w-0 max-w-full flex-1 gap-1 overflow-x-auto scrollbar-none sm:flex-none">
      {options.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={`pharos-focus-ring pharos-control-pill shrink-0 px-3 sm:px-2.5 sm:py-1 ${
            value === r ? "pharos-control-pill-active" : ""
          }`}
        >
          {r === "all" ? "All" : r.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
