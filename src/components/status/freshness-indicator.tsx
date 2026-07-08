"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface FreshnessIndicatorProps {
  updatedAtMs: number;
  staleAfterMs: number;
  labelPrefix?: string;
  className?: string;
  compact?: boolean;
}

function formatAge(ageMs: number): string {
  if (ageMs < 5000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

export function FreshnessIndicator({
  updatedAtMs,
  staleAfterMs,
  labelPrefix,
  className,
  compact = false,
}: FreshnessIndicatorProps) {
  const [label, setLabel] = useState(() => formatAge(Math.max(0, Date.now() - updatedAtMs)));
  const [isStale, setIsStale] = useState(() => Math.max(0, Date.now() - updatedAtMs) > staleAfterMs);

  useEffect(() => {
    const recompute = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const ageMs = Math.max(0, Date.now() - updatedAtMs);
      setLabel((prev) => {
        const next = formatAge(ageMs);
        return next === prev ? prev : next;
      });
      setIsStale(ageMs > staleAfterMs);
    };
    recompute();
    const id = setInterval(recompute, 1000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") recompute();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [updatedAtMs, staleAfterMs]);

  const absolute =
    updatedAtMs > 0 ? new Date(updatedAtMs).toLocaleString(undefined, { timeZoneName: "long" }) : "never";
  const fullLabel = `${labelPrefix ?? "Refreshed"} at ${absolute}`;
  const visibleLabel = compact ? label.replace(/\s+ago$/, "") : labelPrefix ? `${labelPrefix}: ${label}` : label;
  return (
    <TooltipProvider delayDuration={220}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="status"
            data-stale={isStale ? "true" : "false"}
            aria-label={fullLabel}
            className={cn(
              "inline-flex cursor-help items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              compact && "h-5 rounded-md px-2 py-0 leading-none",
              isStale
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-border/60 bg-background/60 text-muted-foreground",
              className,
            )}
          >
            {compact ? (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            ) : (
              <span
                className={cn("h-1.5 w-1.5 rounded-full", isStale ? "bg-amber-500" : "bg-green-500")}
                aria-hidden="true"
              />
            )}
            {visibleLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-[11px]">{fullLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
