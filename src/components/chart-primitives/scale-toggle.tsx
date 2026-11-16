"use client";

import { ControlPillToggle } from "@/components/control-pill-toggle";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// D5 — Linear / Log Y-axis toggle
// ---------------------------------------------------------------------------

export type ChartScale = "lin" | "log";

interface ChartScaleToggleProps {
  value: ChartScale;
  onChange: (next: ChartScale) => void;
  /**
   * Greys out both buttons (the active pill still reads as the current
   * setting). Use when log scale is mathematically misleading for the active
   * view (stacked area, etc.) so users can still see *what would happen* but
   * can't trip themselves up.
   */
  disabled?: boolean;
  /** `title=` rendered when disabled — explain *why* the toggle is locked. */
  disabledTitle?: string;
  className?: string;
}

const SCALE_LABELS: Record<ChartScale, string> = { lin: "Lin", log: "Log" };

/**
 * `Lin / Log` scale toggle on the same segmented track as `ChartRangeToggle`,
 * so a chart header carries one control family. Used on supply / market-cap
 * charts where the data spans multiple orders of magnitude (USDT vs the long tail).
 *
 * IMPORTANT: log + stacked area = misleading (areas don't sum on a log axis).
 * Pass `disabled` in stacked layouts with a `disabledTitle` explanation.
 */
export function ChartScaleToggle({
  value,
  onChange,
  disabled = false,
  disabledTitle,
  className,
}: ChartScaleToggleProps) {
  const options: ChartScale[] = ["lin", "log"];
  return (
    <div
      className={cn("pharos-segmented", disabled && "opacity-50", className)}
      role="group"
      aria-label="Y-axis scale"
      title={disabled ? disabledTitle : undefined}
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          disabled={disabled}
          onClick={() => onChange(opt)}
          className={cn("pharos-focus-ring pharos-segmented-item", disabled && "cursor-not-allowed")}
        >
          {SCALE_LABELS[opt]}
        </button>
      ))}
    </div>
  );
}

const formatRangeLabel = (range: TimeRangeOption) => (range === "all" ? "All" : range);

/**
 * The detail page's one time-range control: the shared segmented track, with
 * durations in the page's lowercase unit style ("7d", "1y", like "24h").
 */
export function ChartRangeToggle({
  options,
  value,
  onChange,
}: {
  options: readonly TimeRangeOption[];
  value: TimeRangeOption;
  onChange: (next: TimeRangeOption) => void;
}) {
  return (
    <ControlPillToggle
      variant="segmented"
      ariaLabel="Chart time range"
      options={options}
      value={value}
      onChange={onChange}
      formatLabel={formatRangeLabel}
    />
  );
}
