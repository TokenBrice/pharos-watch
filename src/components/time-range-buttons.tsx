"use client";

import { ControlPillToggle } from "@/components/control-pill-toggle";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

interface TimeRangeButtonsProps {
  options: readonly TimeRangeOption[];
  value: string;
  onChange: (value: TimeRangeOption) => void;
}

const formatTimeRangeLabel = (range: TimeRangeOption): string =>
  range === "all" ? "All" : range.toUpperCase();

export function TimeRangeButtons({ options, value, onChange }: TimeRangeButtonsProps) {
  return (
    <ControlPillToggle
      className="flex min-w-0 max-w-full flex-1 gap-1 overflow-x-auto scrollbar-none sm:flex-none"
      buttonClassName="shrink-0 px-3 sm:px-2.5 sm:py-1"
      options={options}
      // Parents track the active range as a plain string; options carry the domain.
      value={value as TimeRangeOption}
      onChange={onChange}
      formatLabel={formatTimeRangeLabel}
    />
  );
}
