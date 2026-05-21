import { Skeleton } from "@/components/ui/skeleton";

// Analytics tier: filter strip + leaderboard table skeleton ~10 rows.
const YIELD_SKELETON_ROW_COUNT = 10;

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-32 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-72 rounded-md sm:h-11 sm:w-96" />
        <Skeleton className="h-3.5 w-48 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
      </div>

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

      <div className="pharos-card-shell overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <Skeleton className="h-3.5 w-28 rounded-sm" />
          <div className="hidden items-center gap-3 sm:flex">
            <Skeleton className="h-3.5 w-16 rounded-sm" />
            <Skeleton className="h-3.5 w-16 rounded-sm" />
            <Skeleton className="h-3.5 w-16 rounded-sm" />
            <Skeleton className="h-3.5 w-16 rounded-sm" />
          </div>
        </div>
        <ul className="divide-y divide-border/60">
          {Array.from({ length: YIELD_SKELETON_ROW_COUNT }).map((_, index) => (
            <li key={index} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-32 rounded-sm" />
                  <Skeleton className="h-3 w-20 rounded-sm" />
                </div>
              </div>
              <div className="hidden items-center gap-3 sm:flex">
                <Skeleton className="h-4 w-14 rounded-sm" />
                <Skeleton className="h-4 w-14 rounded-sm" />
                <Skeleton className="h-4 w-14 rounded-sm" />
                <Skeleton className="h-4 w-14 rounded-sm" />
              </div>
              <Skeleton className="h-4 w-12 rounded-sm sm:hidden" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
