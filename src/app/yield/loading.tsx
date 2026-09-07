import { Skeleton } from "@/components/ui/skeleton";
import { PageLoadingRowList } from "@/components/page-loading-skeleton";
import { createPageLoadingRoute } from "@/app/page-loading-route";

// Analytics tier: filter strip + leaderboard table skeleton ~10 rows.
const YIELD_SKELETON_ROW_COUNT = 10;

export function YieldContentLoadingState() {
  return (
    <>
      <div className="pharos-card-shell space-y-3 p-4">
        <Skeleton className="h-3.5 w-44 rounded-sm" />
        <div className="grid gap-3 text-sm leading-relaxed lg:grid-cols-3">
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-12 w-full rounded-md" />
        </div>
      </div>

      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-4 w-32 rounded-sm" />
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
    </>
  );
}

export default createPageLoadingRoute(YieldContentLoadingState, {
  sectionWidth: "w-32",
  titleWidth: "w-72 sm:w-96",
});
