"use client";

import { useId } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { useMotionPreference, type MotionPreference } from "@/hooks/use-motion-preference";
import { cn } from "@/lib/utils";

const OPTIONS: ReadonlyArray<{ value: MotionPreference; label: string; description: string }> = [
  { value: "system", label: "System", description: "Follow OS reduce-motion preference" },
  { value: "full", label: "Full", description: "Always show motion" },
  { value: "reduced", label: "Reduced", description: "Always reduce motion" },
];

export function MotionPreferenceToggle({ className }: { className?: string }) {
  const hydrated = useHydrated();
  const { preference, setPreference } = useMotionPreference();
  const labelId = useId();
  const descriptionId = useId();

  // Until hydrated, render the group as if "system" is selected so SSR markup
  // matches and we don't flash a different active button.
  const activeValue: MotionPreference = hydrated ? preference : "system";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={labelId} className="text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground">
          Motion
        </span>
        <span id={descriptionId} className="text-[10px] text-muted-foreground/70">
          {OPTIONS.find((opt) => opt.value === activeValue)?.description}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className="inline-flex w-full overflow-hidden rounded-md border border-border/70 bg-muted/20"
      >
        {OPTIONS.map((opt) => {
          const active = opt.value === activeValue;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPreference(opt.value)}
              className={cn(
                "pharos-focus-ring flex-1 min-h-9 px-2 text-xs font-medium transition-colors",
                "first:rounded-l-[5px] last:rounded-r-[5px]",
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
