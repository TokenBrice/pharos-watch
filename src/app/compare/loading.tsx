import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";

// Power-user tier: coin-selector strip, radar + comparison chart pair,
// then comparison table. Matches the dynamic chart placeholders used
// by compare/client.tsx.
export function CompareLoadingState() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-20 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-80 rounded-md sm:h-11 sm:w-[26rem]" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
      </div>

      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-28 rounded-sm" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-12 rounded-md" />
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ChartSkeleton className="h-[420px] rounded-xl" />
        <ChartSkeleton className="h-[420px] rounded-xl" />
      </div>

      <ChartSkeleton className="h-[340px] rounded-xl" />
    </div>
  );
}

export default function Loading() {
  return <CompareLoadingState />;
}
