"use client";

export function HomeAltInlineChartSkeleton({
  className = "h-full w-full",
}: {
  className?: string;
}) {
  return (
    <div
      className={`pharos-chart-stage skeleton-shimmer relative overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div className="absolute bottom-8 left-3 top-3 flex w-8 flex-col justify-between">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-2.5 w-full rounded bg-muted/50" />
        ))}
      </div>
      <div className="absolute bottom-2 left-12 right-3 flex justify-between">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-2 w-8 rounded bg-muted/50" />
        ))}
      </div>
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 400 100">
        <path
          d="M 40 80 C 80 75, 120 60, 160 65 C 200 70, 240 40, 280 45 C 320 50, 360 30, 400 35 L 400 100 L 40 100 Z"
          fill="currentColor"
          className="text-muted/20"
        />
      </svg>
    </div>
  );
}
