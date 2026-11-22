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
      variant="segmented"
      ariaLabel="Chart time range"
      className="min-w-0 max-w-full overflow-x-auto scrollbar-none"
      buttonClassName="min-h-11 shrink-0 px-3 sm:min-h-8 sm:px-2.5"
      options={options}
      // Parents track the active range as a plain string; options carry the domain.
      value={value as TimeRangeOption}
      onChange={onChange}
      formatLabel={formatTimeRangeLabel}
    />
  );
}
