import { Skeleton } from "@/components/ui/skeleton";
import { PageLoadingRowList, PageLoadingSplitHero } from "@/components/page-loading-skeleton";

// Analytics tier: risk bar + split hero with scatter chart skeleton + filter strip + leaderboard rows.
const YIELD_SKELETON_ROW_COUNT = 10;

export function YieldContentLoadingState() {
  return (
    <div className="space-y-6">
      <div className="pharos-card-shell flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Skeleton className="h-3.5 w-28 rounded-sm" />
        <div className="flex flex-wrap items-center gap-1.5">
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
        </div>
      </div>

      <PageLoadingSplitHero visualClassName="min-h-[380px] lg:min-h-[440px]" visualVariant="area" />

      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9 w-full rounded-full sm:max-w-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-7 w-28 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-24 rounded-full" />
        </div>
      </div>

      <PageLoadingRowList
        rowCount={YIELD_SKELETON_ROW_COUNT}
        titleWidth="w-28"
        actionWidth={null}
        primaryWidth="w-32"
        secondaryWidth="w-20"
        metricWidths={["w-14", "w-14", "w-14", "w-14"]}
        metricContainerClassName="hidden items-center gap-3 sm:flex"
        mobileMetricWidth="w-12"
        containerClassName="pharos-card-shell overflow-hidden"
        headerClassName="flex items-center justify-between border-b border-border/60 px-4 py-3"
        rowClassName="px-4 py-3"
      />
    </div>
  );
}
