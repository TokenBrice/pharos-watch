"use client";

import { cn } from "@/lib/utils";

/**
 * A 2px-tall horizontal band that signals an in-flight background refresh.
 *
 * Pair with TanStack Query hooks that opt into `placeholderData: keepPreviousData`
 * (i.e. via `keepPreviousData: true` in the hook overrides). The previous data
 * stays visible during the refetch; this bar communicates the work is happening.
 *
 * Consumer pattern:
 *   <RefreshingBar active={!isPending && isFetching} />
 *
 * - `isPending` covers the very first fetch (skeletons own that state).
 * - `isFetching && !isPending` is the SWR refetch window — the band's only job.
 *
 * Honors `prefers-reduced-motion`: the shimmer falls back to a static tint.
 */
export function RefreshingBar({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={active ? "Refreshing data" : undefined}
      className={cn(
        "pointer-events-none h-[2px] w-full overflow-hidden bg-transparent transition-opacity duration-200",
        active ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {active ? (
        <div
          aria-hidden
          className={cn(
            "h-full w-full",
            "bg-[linear-gradient(90deg,transparent_0%,var(--brand-accent)_50%,transparent_100%)]",
            "bg-[length:200%_100%]",
            "animate-[pharos-shimmer_1.5s_ease-in-out_infinite]",
            "motion-reduce:animate-none motion-reduce:bg-[var(--brand-accent)] motion-reduce:opacity-40",
          )}
        />
      ) : null}
    </div>
  );
}
