import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";

// Analytics tier: filter strip + DEX depth chart placeholder + cohort table.
const LIQUIDITY_SKELETON_ROW_COUNT = 10;

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-24 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-64 rounded-md sm:h-11 sm:w-80" />
        <Skeleton className="h-3.5 w-48 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="pharos-card-shell space-y-2 p-4">
          <Skeleton className="h-3 w-32 rounded-sm" />
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-3/4 rounded-sm" />
        </div>
        <div className="pharos-card-shell space-y-2 p-4">
          <Skeleton className="h-3 w-28 rounded-sm" />
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-5/6 rounded-sm" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="pharos-card-shell space-y-2 p-4">
            <Skeleton className="h-3 w-24 rounded-sm" />
            <Skeleton className="h-8 w-32 rounded-md" />
          </div>
        ))}
      </div>

      <ChartSkeleton className="h-[320px] rounded-xl" />

      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-40 rounded-sm" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
        <ul className="divide-y divide-border/60">
          {Array.from({ length: LIQUIDITY_SKELETON_ROW_COUNT }).map((_, index) => (
            <li key={index} className="flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <Skeleton className="h-3.5 w-32 rounded-sm" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-16 rounded-sm" />
                <Skeleton className="h-4 w-16 rounded-sm" />
                <Skeleton className="h-4 w-12 rounded-sm" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
