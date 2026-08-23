import {
  PageLoadingHeader,
  PageLoadingRowList,
  PageLoadingShell,
} from "@/components/page-loading-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

const COMPLIANCE_SKELETON_ROW_COUNT = 10;

export function ComplianceContentLoadingState() {
  return (
    <>
      <div className="pharos-card-shell overflow-hidden">
        <div className="flex gap-2 border-b border-border/60 px-3 pt-2">
          <Skeleton className="h-10 w-24 rounded-sm" />
          <Skeleton className="h-10 w-20 rounded-sm" />
          <Skeleton className="h-10 w-24 rounded-sm" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <Skeleton className="h-4 w-40 rounded-sm" />
          <div className="flex gap-2">
            <Skeleton className="h-11 w-36 rounded-full md:h-8" />
            <Skeleton className="h-11 w-40 rounded-md md:h-8" />
          </div>
        </div>
      </div>

      <PageLoadingRowList
        rowCount={COMPLIANCE_SKELETON_ROW_COUNT}
        titleWidth="w-44"
        actionWidth="w-16"
        primaryWidth="w-28"
        secondaryWidth="w-36"
        metricWidths={["w-10", "w-16", "w-16"]}
      />
    </>
  );
}

export default function Loading() {
  return (
    <PageLoadingShell>
      <PageLoadingHeader sectionWidth="w-24" titleWidth="w-64 sm:w-80" />
      <ComplianceContentLoadingState />
    </PageLoadingShell>
  );
}
