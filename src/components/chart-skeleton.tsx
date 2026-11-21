import { cn } from "@/lib/utils";

export { ChartShellSkeleton } from "@/components/chart-primitives/skeleton";

export type ChartSkeletonVariant = "area" | "bars" | "radar";

interface ChartSkeletonProps {
  className?: string;
  /** Visual silhouette matching the target chart family (defaults to `"area"`). */
  variant?: ChartSkeletonVariant;
  /** Decorative mounts (inline chart placeholders) hide themselves from AT. */
  "aria-hidden"?: boolean;
}

const BAR_HEIGHT_CLASSES = [
  "h-[38%]",
  "h-[62%]",
  "h-[48%]",
  "h-[76%]",
  "h-[54%]",
  "h-[84%]",
  "h-[44%]",
  "h-[68%]",
  "h-[58%]",
  "h-[72%]",
] as const;

export function ChartSkeleton({
  className = "h-[250px] sm:h-[350px]",
  variant = "area",
  "aria-hidden": ariaHidden,
}: ChartSkeletonProps) {
  if (variant === "radar") {
    return (
      <div
        data-chart-skeleton-variant="radar"
        className={cn(
          "pharos-chart-stage pharos-crossfade-layer relative flex w-full flex-col items-center justify-center overflow-hidden",
          className,
        )}
        aria-hidden={ariaHidden ? "true" : undefined}
      >
        <svg
          className="h-[78%] w-[78%] max-h-64 max-w-64"
          viewBox="0 0 160 160"
          aria-hidden="true"
        >
          <circle cx="80" cy="80" r="64" fill="none" stroke="var(--color-border)" strokeDasharray="3 4" strokeOpacity={0.75} />
          <circle cx="80" cy="80" r="44" fill="none" stroke="var(--color-border)" strokeDasharray="3 4" strokeOpacity={0.65} />
          <circle cx="80" cy="80" r="24" fill="none" stroke="var(--color-border)" strokeDasharray="3 4" strokeOpacity={0.55} />
          <line x1="16" y1="80" x2="144" y2="80" stroke="var(--color-border)" strokeOpacity={0.5} />
          <line x1="80" y1="16" x2="80" y2="144" stroke="var(--color-border)" strokeOpacity={0.5} />
          <polygon
            points="80,30 122,62 110,116 54,112 38,66"
            fill="var(--skeleton-base)"
            fillOpacity={0.55}
            stroke="var(--skeleton-highlight)"
            strokeWidth={1.5}
          />
          <circle cx="80" cy="80" r="3" fill="var(--skeleton-highlight)" />
        </svg>
        <div className="mt-3 flex items-center gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="skeleton-shimmer h-2 w-2 rounded-full" />
              <div className="skeleton-shimmer h-2 w-10 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      data-chart-skeleton-variant={variant}
      className={cn(
        "pharos-chart-stage pharos-crossfade-layer relative w-full overflow-hidden",
        className,
      )}
      aria-hidden={ariaHidden ? "true" : undefined}
    >
      <div className="absolute left-3 top-4 bottom-9 flex w-9 flex-col justify-between">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton-shimmer h-2 w-full rounded-sm" />
        ))}
      </div>
      <div className="absolute right-3 bottom-3 left-14 flex justify-between">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton-shimmer h-2 w-8 rounded-sm" />
        ))}
      </div>
      <div className="absolute top-4 right-3 bottom-9 left-14">
        <svg className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 400 100" aria-hidden="true">
          {[10, 35, 60, 85].map((y) => (
            <line
              key={y}
              x1="0"
              x2="400"
              y1={y}
              y2={y}
              stroke="var(--color-border)"
              strokeDasharray="2 6"
              strokeOpacity={0.75}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {variant === "area" ? (
            <>
              <path
                d="M 0 78 C 45 72, 85 56, 130 62 C 175 68, 220 36, 265 44 C 310 52, 355 24, 400 30 L 400 100 L 0 100 Z"
                fill="var(--skeleton-base)"
                fillOpacity={0.65}
              />
              <path
                d="M 0 78 C 45 72, 85 56, 130 62 C 175 68, 220 36, 265 44 C 310 52, 355 24, 400 30"
                fill="none"
                stroke="var(--skeleton-highlight)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
        </svg>
        {variant === "bars" ? (
          <div className="absolute inset-0 flex items-end gap-2 px-1 pt-2">
            {BAR_HEIGHT_CLASSES.map((heightClass, i) => (
              <div key={i} className={cn("skeleton-shimmer flex-1 rounded-t-sm", heightClass)} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
