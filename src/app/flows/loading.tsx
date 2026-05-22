import { Skeleton } from "@/components/ui/skeleton";
import {
  PageLoadingChartBlock,
  PageLoadingHeader,
  PageLoadingRowList,
  PageLoadingShell,
} from "@/components/page-loading-skeleton";

// Analytics tier: bank-run gauge + mint/burn area chart + flow table.
const FLOWS_SKELETON_ROW_COUNT = 10;

export function FlowsLoadingState() {
  return (
    <PageLoadingShell>
      <PageLoadingHeader sectionWidth="w-32" titleWidth="w-72 sm:w-96" />
      <Skeleton className="-mt-3 h-7 w-44 rounded-full" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="pharos-card-shell space-y-3 p-4">
          <Skeleton className="h-3 w-24 rounded-sm" />
          <Skeleton className="h-10 w-32 rounded-md" />
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-3 w-3/4 rounded-sm" />
        </div>
        <PageLoadingChartBlock className="h-[280px] rounded-xl" />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Skeleton className="h-8 w-16 rounded-full" />
        <Skeleton className="h-8 w-16 rounded-full" />
        <Skeleton className="h-8 w-16 rounded-full" />
      </div>

      <PageLoadingChartBlock className="h-[360px] rounded-xl" />

      <PageLoadingRowList
        rowCount={FLOWS_SKELETON_ROW_COUNT}
        titleWidth="w-36"
        actionWidth={null}
        primaryWidth="w-32"
        metricWidths={["w-16", "w-16", "w-12"]}
      />
    </PageLoadingShell>
  );
}

export default function Loading() {
  return <FlowsLoadingState />;
}
