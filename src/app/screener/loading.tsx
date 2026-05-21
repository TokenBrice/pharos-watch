import { Skeleton } from "@/components/ui/skeleton";

// Power-user tier: dense rows, minimal chrome, mono-heavy.
// Mirrors FeaturePageShell header geometry then the screener
// toolbar + sticky-header + 14 tight rows.
const SCREENER_SKELETON_ROW_COUNT = 14;

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <span className="text-xs text-muted-foreground">/</span>
          <Skeleton className="h-4 w-24 rounded-sm" />
        </div>
        <Skeleton className="h-9 w-72 rounded-md sm:h-11 sm:w-96" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-sm" />
      </div>

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

      <div className="pharos-card-shell overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <Skeleton className="h-3.5 w-24 rounded-sm" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-14 rounded-sm" />
            <Skeleton className="h-3.5 w-14 rounded-sm" />
            <Skeleton className="h-3.5 w-14 rounded-sm" />
            <Skeleton className="h-3.5 w-14 rounded-sm" />
            <Skeleton className="h-3.5 w-14 rounded-sm" />
          </div>
        </div>
        <ul className="divide-y divide-border/60">
          {Array.from({ length: SCREENER_SKELETON_ROW_COUNT }).map((_, index) => (
            <li key={index} className="flex items-center justify-between gap-3 px-4 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-3.5 w-32 rounded-sm" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-3.5 w-12 rounded-sm" />
                <Skeleton className="h-3.5 w-12 rounded-sm" />
                <Skeleton className="h-3.5 w-12 rounded-sm" />
                <Skeleton className="h-3.5 w-12 rounded-sm" />
                <Skeleton className="h-3.5 w-12 rounded-sm" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
