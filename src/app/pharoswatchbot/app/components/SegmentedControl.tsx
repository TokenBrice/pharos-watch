"use client";

import { cn } from "@/lib/utils";

export function SegmentedControl<T>({ value, options, onChange, disabled, ariaLabel, getOptionAriaLabel }: {
  value: T;
  options: readonly { value: T; label: string; caption?: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  getOptionAriaLabel?: (option: { value: T; label: string; caption?: string }) => string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.label}
            type="button"
            aria-label={getOptionAriaLabel?.(option)}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring min-h-12 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "mini-selected" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
            )}
          >
            <span className="block text-sm font-semibold">{option.label}</span>
            {option.caption ? <span className="block text-[11px] leading-tight">{option.caption}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
