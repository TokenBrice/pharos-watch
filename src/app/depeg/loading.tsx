import {
  PageLoadingChartBlock,
  PageLoadingHeader,
  PageLoadingRowList,
  PageLoadingShell,
  PageLoadingStatGrid,
} from "@/components/page-loading-skeleton";

// Analytics tier: KPI strip, heatmap placeholder, then recent depeg rows.
const DEPEG_SKELETON_ROW_COUNT = 8;

export function DepegContentLoadingState() {
  return (
    <>
      <PageLoadingStatGrid
        count={4}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        labelWidth="w-20"
        valueWidth="w-24"
        valueHeight="h-7"
      />
      <PageLoadingChartBlock className="h-[280px]" shimmer />
      <PageLoadingRowList
        rowCount={DEPEG_SKELETON_ROW_COUNT}
        titleWidth="w-36"
        actionWidth="w-20"
        primaryWidth="w-28"
        secondaryWidth="w-20"
        metricWidths={["w-14", "w-14", "w-14"]}
      />
    </>
  );
}

export default function Loading() {
  return (
    <PageLoadingShell>
      <PageLoadingHeader sectionWidth="w-28" titleWidth="w-64 sm:w-80" />
      <DepegContentLoadingState />
    </PageLoadingShell>
  );
}
