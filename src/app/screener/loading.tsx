import { Skeleton } from "@/components/ui/skeleton";
import {
  PageLoadingRowList,
} from "@/components/page-loading-skeleton";
import { PageLoadingRoute } from "@/app/page-loading-route";

// Power-user tier: dense rows, minimal chrome, mono-heavy.
// Mirrors FeaturePageShell header geometry then the screener
// toolbar + sticky-header + 14 tight rows.
const SCREENER_SKELETON_ROW_COUNT = 14;

export function ScreenerContentLoadingState() {
  return (
    <>
      <div className="pharos-card-shell space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-4 w-40 rounded-sm" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-8 w-20 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
          <Skeleton className="h-8 w-20 rounded-full" />
          <Skeleton className="h-8 w-32 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
      </div>

      <PageLoadingRowList
        rowCount={SCREENER_SKELETON_ROW_COUNT}
        titleWidth="w-24"
        actionWidth={null}
        avatarClassName="h-6 w-6 rounded-full"
        primaryWidth="w-32"
        metricWidths={["w-12", "w-12", "w-12", "w-12", "w-12"]}
        containerClassName="pharos-card-shell overflow-hidden"
        headerClassName="flex items-center justify-between border-b border-border/60 px-4 py-3"
        rowClassName="px-4 py-2"
      />
    </>
  );
}

export default function Loading() {
  return (
    <PageLoadingRoute
      sectionWidth="w-24"
      titleWidth="w-72 sm:w-96"
      includeEyebrow={false}
    >
      <ScreenerContentLoadingState />
    </PageLoadingRoute>
  );
}
