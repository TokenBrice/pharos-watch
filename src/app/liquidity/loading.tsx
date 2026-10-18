import { Skeleton } from "@/components/ui/skeleton";
import { PageLoadingRowList } from "@/components/page-loading-skeleton";
import { createPageLoadingRoute } from "@/app/page-loading-route";

// Stacked One Beam hero (beam row, exit route map, ledger) + leaderboard.
const LIQUIDITY_SKELETON_ROW_COUNT = 10;

export function LiquidityContentLoadingState() {
  return (
    <>
      <div className="pharos-card-shell overflow-hidden">
        <div className="grid gap-5 border-b border-border/50 p-5 sm:p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8 lg:p-7">
          <div className="space-y-3">
            <Skeleton className="h-4 w-40 rounded-sm" />
            <Skeleton className="h-10 w-44 rounded-sm" />
            <Skeleton className="h-6 w-56 rounded-full" />
          </div>
          <div className="space-y-3 lg:self-end">
            <Skeleton className="h-4 w-full rounded-sm" />
            <Skeleton className="h-4 w-full rounded-sm" />
            <Skeleton className="h-4 w-full rounded-sm" />
          </div>
        </div>
        <div className="p-5 sm:p-6 lg:p-7">
          <Skeleton className="h-[240px] w-full rounded-lg md:h-[440px]" />
        </div>
        <div className="space-y-4 border-t border-border/50 p-5 sm:p-6 lg:px-7 lg:py-5">
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      </div>

      <PageLoadingRowList
        rowCount={LIQUIDITY_SKELETON_ROW_COUNT}
        titleWidth="w-40"
        actionWidth="w-20"
        primaryWidth="w-32"
        metricWidths={["w-16", "w-16", "w-12"]}
      />
    </>
  );
}

export default createPageLoadingRoute(LiquidityContentLoadingState, {
  sectionWidth: "w-24",
  titleWidth: "w-64 sm:w-80",
});
