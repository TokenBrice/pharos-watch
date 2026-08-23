import { Skeleton } from "@/components/ui/skeleton";
import {
  PageLoadingHeader,
  PageLoadingShell,
  PageLoadingStatGrid,
} from "@/components/page-loading-skeleton";

// Analytics tier: headline stats strip, distribution band, then ~12 graded rows.
const SAFETY_SKELETON_ROW_COUNT = 12;

export function SafetyScoresContentLoadingState() {
  return (
    <>
      <PageLoadingStatGrid
        count={4}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        labelWidth="w-24"
        valueWidth="w-20"
      />

      <div className="pharos-card-shell space-y-3 p-4">
        <Skeleton className="h-3.5 w-32 rounded-sm" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-16 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-12 w-full rounded-md" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: SAFETY_SKELETON_ROW_COUNT }).map((_, index) => (
          <div key={index} className="pharos-card-shell space-y-3 p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-24 rounded-sm" />
                <Skeleton className="h-3 w-16 rounded-sm" />
              </div>
              <Skeleton className="h-7 w-10 rounded-md" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </div>
    </>
  );
}

export default function Loading() {
  return (
    <PageLoadingShell>
      <PageLoadingHeader sectionWidth="w-28" titleWidth="w-64 sm:w-80" />
      <SafetyScoresContentLoadingState />
    </PageLoadingShell>
  );
}
