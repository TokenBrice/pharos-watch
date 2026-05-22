import { Skeleton } from "@/components/ui/skeleton";

// Analytics tier: KPI strip, heatmap placeholder, then recent depeg rows.
const DEPEG_SKELETON_ROW_COUNT = 8;

export function DepegLoadingState() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-28 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-64 rounded-md sm:h-11 sm:w-80" />
        <Skeleton className="h-3.5 w-48 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="pharos-card-shell space-y-2 p-4">
            <Skeleton className="h-3 w-20 rounded-sm" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
        ))}
      </div>

      <div className="pharos-card-shell h-[280px] p-4">
        <Skeleton className="h-full w-full rounded-md" variant="shimmer" />
      </div>

      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-36 rounded-sm" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
        <ul className="divide-y divide-border/60">
          {Array.from({ length: DEPEG_SKELETON_ROW_COUNT }).map((_, index) => (
            <li key={index} className="flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-28 rounded-sm" />
                  <Skeleton className="h-3 w-20 rounded-sm" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-14 rounded-sm" />
                <Skeleton className="h-4 w-14 rounded-sm" />
                <Skeleton className="h-6 w-14 rounded-full" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function Loading() {
  return <DepegLoadingState />;
}
