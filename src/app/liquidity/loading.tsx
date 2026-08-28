import { Skeleton } from "@/components/ui/skeleton";
import {
  PageLoadingChartBlock,
  PageLoadingRowList,
  PageLoadingStatGrid,
} from "@/components/page-loading-skeleton";
import { PageLoadingRoute } from "@/app/page-loading-route";

// Analytics tier: filter strip + DEX depth chart placeholder + cohort table.
const LIQUIDITY_SKELETON_ROW_COUNT = 10;

export function LiquidityContentLoadingState() {
  return (
    <>
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

      <PageLoadingStatGrid
        count={6}
        className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6"
        labelWidth="w-24"
        valueWidth="w-32"
      />

      <PageLoadingChartBlock className="h-[320px] rounded-xl" />

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

export default function Loading() {
  return (
    <PageLoadingRoute sectionWidth="w-24" titleWidth="w-64 sm:w-80">
      <LiquidityContentLoadingState />
    </PageLoadingRoute>
  );
}
