import { PageLoadingRowList, PageLoadingSplitHero } from "@/components/page-loading-skeleton";
import { createPageLoadingRoute } from "@/app/page-loading-route";

// Analytics tier: split outlook hero (command rail + DEWS radar), then recent depeg rows.
const DEPEG_SKELETON_ROW_COUNT = 8;

export function DepegContentLoadingState() {
  return (
    <>
      <PageLoadingSplitHero visualClassName="h-80 lg:h-[36rem]" />
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

export default createPageLoadingRoute(DepegContentLoadingState, {
  sectionWidth: "w-28",
  titleWidth: "w-64 sm:w-80",
});
