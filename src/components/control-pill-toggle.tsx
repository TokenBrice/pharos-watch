"use client";

import { cn } from "@/lib/utils";

interface ControlPillOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface ControlPillToggleProps<T extends string | number | boolean> {
  /**
   * Raw option values (labels via `formatLabel`) or `{ value, label }`
   * descriptors. Hoist the array at module scope so raw values don't need a
   * per-render descriptor copy.
   */
  options: readonly (T | ControlPillOption<T>)[];
  value: T;
  onChange: (value: T) => void;
  /** Label formatter for raw option values; defaults to `String(value)`. */
  formatLabel?: (value: T) => string;
  /** When provided, the container is exposed as a labelled `role="group"`. */
  ariaLabel?: string;
  /** Exact container classes (layout/overflow); nothing is injected. */
  className?: string;
  /** Per-button sizing/typography classes appended to the shared pill pair. */
  buttonClassName?: string;
}

/**
 * Pressed-state pill group over the canonical control-pill contract:
 * `pharos-focus-ring pharos-control-pill` buttons with
 * `pharos-control-pill-active` on the selected value, `type="button"`,
 * `aria-pressed`, and native `disabled`. Containers stay unlabeled `<div>`s
 * unless `ariaLabel` upgrades them to `role="group"` — matching the
 * hand-rolled groups this replaces.
 */
export function ControlPillToggle<T extends string | number | boolean>({
  options,
  value,
  onChange,
  formatLabel,
  ariaLabel,
  className,
  buttonClassName,
}: ControlPillToggleProps<T>) {
  return (
    <div
      className={className}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const descriptor = typeof option === "object" ? option : null;
        const optionValue = typeof option === "object" ? option.value : option;
        const label =
          descriptor?.label ?? (formatLabel ? formatLabel(optionValue) : String(optionValue));
        const isActive = value === optionValue;
        return (
          <button
            key={String(optionValue)}
            type="button"
            aria-pressed={isActive}
            disabled={descriptor?.disabled}
            onClick={() => onChange(optionValue)}
            className={cn(
              "pharos-focus-ring pharos-control-pill",
              isActive && "pharos-control-pill-active",
              buttonClassName,
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
