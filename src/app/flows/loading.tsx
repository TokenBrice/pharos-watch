import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";

// Analytics tier: bank-run gauge + mint/burn area chart + flow table.
const FLOWS_SKELETON_ROW_COUNT = 10;

export function FlowsLoadingState() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-32 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-72 rounded-md sm:h-11 sm:w-96" />
        <Skeleton className="h-3.5 w-48 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
        <Skeleton className="h-7 w-44 rounded-full" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="pharos-card-shell space-y-3 p-4">
          <Skeleton className="h-3 w-24 rounded-sm" />
          <Skeleton className="h-10 w-32 rounded-md" />
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-3 w-3/4 rounded-sm" />
        </div>
        <ChartSkeleton className="h-[280px] rounded-xl" />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Skeleton className="h-8 w-16 rounded-full" />
        <Skeleton className="h-8 w-16 rounded-full" />
        <Skeleton className="h-8 w-16 rounded-full" />
      </div>

      <ChartSkeleton className="h-[360px] rounded-xl" />

      <div className="pharos-card-shell space-y-3 p-4">
        <Skeleton className="h-4 w-36 rounded-sm" />
        <ul className="divide-y divide-border/60">
          {Array.from({ length: FLOWS_SKELETON_ROW_COUNT }).map((_, index) => (
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

export default function Loading() {
  return <FlowsLoadingState />;
}
