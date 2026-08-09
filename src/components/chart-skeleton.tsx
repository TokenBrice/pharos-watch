import { cn } from "@/lib/utils";

export { ChartShellSkeleton } from "@/components/chart-primitives/skeleton";

interface ChartSkeletonProps {
  className?: string;
  /** Decorative mounts (inline chart placeholders) hide themselves from AT. */
  "aria-hidden"?: boolean;
}

export function ChartSkeleton({
  className = "h-[250px] sm:h-[350px]",
  "aria-hidden": ariaHidden,
}: ChartSkeletonProps) {
  return (
    <div
      className={cn(
        "pharos-chart-stage pharos-crossfade-layer skeleton-shimmer relative w-full overflow-hidden",
        className,
      )}
      aria-hidden={ariaHidden ? "true" : undefined}
    >
      {/* Fake y-axis labels */}
      <div className="absolute left-3 top-3 bottom-8 w-8 flex flex-col justify-between">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-2.5 w-full rounded bg-muted/50" />
        ))}
      </div>
      {/* Fake x-axis labels */}
      <div className="absolute bottom-2 left-12 right-3 flex justify-between">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-2 w-8 rounded bg-muted/50" />
        ))}
      </div>
      {/* Fake area shape */}
      <svg
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="none"
        viewBox="0 0 400 100"
      >
        <path
          d="M 40 80 C 80 75, 120 60, 160 65 C 200 70, 240 40, 280 45 C 320 50, 360 30, 400 35 L 400 100 L 40 100 Z"
          fill="currentColor"
          className="text-muted/20"
        />
      </svg>
    </div>
  );
}
