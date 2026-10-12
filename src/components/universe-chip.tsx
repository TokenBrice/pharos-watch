"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { UNIVERSES, type UniverseKey } from "@/lib/universe-vocabulary";

interface UniverseChipProps {
  universe: UniverseKey;
  /**
   * The denominator as read this render, e.g. "374 of 396 active". Defaults to
   * the universe's build-time catalog count; runtime universes must pass it.
   */
  value?: ReactNode;
  className?: string;
}

/**
 * Denominator chip under a hero KPI: names the coin set the figure is computed
 * over, with the vocabulary definition one tap away.
 */
export function UniverseChip({ universe, value, className }: UniverseChipProps) {
  const entry = UNIVERSES[universe];
  const shown = value ?? (entry.count != null ? `${entry.count.toLocaleString()} coins` : null);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "pharos-focus-ring inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground",
          className,
        )}
        aria-label={`Universe: ${entry.label}${typeof shown === "string" ? `, ${shown}` : ""}. What this counts`}
      >
        <span className="font-medium text-foreground/80">{entry.label}</span>
        {shown != null ? (
          <>
            <span aria-hidden="true">&middot;</span>
            <span className="truncate tabular-nums">{shown}</span>
          </>
        ) : null}
        <Info className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-1 p-3 text-xs leading-relaxed">
        <p className="font-semibold text-foreground">{entry.label}</p>
        <p className="text-muted-foreground">{entry.definition}</p>
      </PopoverContent>
    </Popover>
  );
}
