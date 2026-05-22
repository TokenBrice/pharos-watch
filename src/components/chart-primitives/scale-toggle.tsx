"use client";

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

/**
 * `LIN / LOG` scale toggle modelled on `TimeRangeButtons` so it reads as the
 * same control family. Used on supply / market-cap charts where the data
 * spans multiple orders of magnitude (USDT vs the long tail).
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
      className={cn("flex gap-1", disabled && "opacity-50", className)}
      role="radiogroup"
      aria-label="Y-axis scale"
      title={disabled ? disabledTitle : undefined}
    >
      {options.map((opt) => {
        const isActive = value === opt;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={cn(
              "pharos-focus-ring pharos-control-pill px-2.5 sm:py-1 text-[10px] tracking-wider",
              isActive ? "pharos-control-pill-active" : "",
              disabled && "cursor-not-allowed",
            )}
          >
            {opt.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
