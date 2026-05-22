import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export { ChartShellSkeleton } from "@/components/chart-primitives/skeleton";

interface ChartSkeletonProps {
  className?: string;
  /** "area" shows a fake area chart shape; "bars" shows horizontal bar placeholders */
  variant?: "area" | "bars";
  /** Homepage skeleton variants keep the route-local loading chrome intact. */
  type?: "area" | "bar" | "radar";
  height?: string;
  /**
   * When set, the skeleton fades out over 180ms so the resolved chart can
   * cross-fade in (M7). Defaults to false; consumers that mount the skeleton
   * during loading and the real chart once data lands can leave it untouched.
   */
  fadingOut?: boolean;
}

export function ChartSkeleton({
  className = "h-[250px] sm:h-[350px]",
  variant = "area",
  type,
  height = "h-[300px]",
  fadingOut = false,
}: ChartSkeletonProps) {
  if (type) {
    return (
      <div
        className={cn(
          "pharos-crossfade-layer relative overflow-hidden rounded-xl border border-border/50 bg-card/50",
          className,
        )}
        data-fading-out={fadingOut ? "true" : undefined}
      >
        <div className="flex items-center justify-between border-b border-border/30 px-4 py-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <div className="relative px-4 pb-4 pt-3">
          <div className="absolute bottom-4 left-4 top-3 flex flex-col justify-between py-2">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-6" />
          </div>
          <div className={cn("relative ml-12", height)}>
            {type === "area" ? (
              <>
                <div className="absolute inset-0 rounded-lg bg-gradient-to-b from-muted/60 via-muted/30 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 h-1/2 rounded-b-lg bg-gradient-to-t from-muted/40 to-transparent" />
                <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
                  <path
                    d="M0,80 C50,70 100,90 150,60 S250,40 300,50 S400,30 450,45 S550,35 600,40"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-muted-foreground/30"
                  />
                </svg>
              </>
            ) : null}
            {type === "radar" ? (
              <div className="flex h-full items-center justify-center">
                <div className="relative h-4/5 w-4/5">
                  <div className="absolute inset-0 rounded-full border-2 border-dashed border-muted-foreground/20" />
                  <div className="absolute inset-[15%] rounded-full border-2 border-dashed border-muted-foreground/20" />
                  <div className="absolute inset-[30%] rounded-full border-2 border-dashed border-muted-foreground/20" />
                  <div className="absolute inset-[45%] rounded-full bg-muted-foreground/10" />
                </div>
              </div>
            ) : null}
            {type === "bar" ? (
              <div className="flex h-full items-end justify-around gap-2 px-4">
                <Skeleton variant="shimmer" className="h-[40%] w-8" />
                <Skeleton variant="shimmer" className="h-[65%] w-8" />
                <Skeleton variant="shimmer" className="h-[50%] w-8" />
                <Skeleton variant="shimmer" className="h-[80%] w-8" />
                <Skeleton variant="shimmer" className="h-[45%] w-8" />
                <Skeleton variant="shimmer" className="h-[70%] w-8" />
              </div>
            ) : null}
            <div className="absolute -bottom-6 left-0 right-0 flex justify-between">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-10" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pharos-chart-stage pharos-crossfade-layer skeleton-shimmer relative w-full overflow-hidden",
        className,
      )}
      data-fading-out={fadingOut ? "true" : undefined}
    >
      {variant === "area" ? (
        <>
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
        </>
      ) : (
        /* Bar-style skeleton for non-chart cards (governance, peg-type, etc.) */
        <div className="absolute inset-3 flex flex-col justify-center gap-3">
          {[75, 50, 30].map((w, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-2 w-20 rounded bg-muted/50" />
              <div
                className="h-3 rounded bg-muted/50"
                style={{ width: `${w}%` }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
