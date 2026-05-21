import { Skeleton } from "@/components/ui/skeleton";

// Analytics tier: headline stats strip, distribution band, then ~12 graded rows.
const SAFETY_SKELETON_ROW_COUNT = 12;

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-28 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-64 rounded-md sm:h-11 sm:w-80" />
        <Skeleton className="h-3.5 w-48 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="pharos-card-shell space-y-2 p-4">
            <Skeleton className="h-3 w-24 rounded-sm" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        ))}
      </div>

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
    </div>
  );
}
