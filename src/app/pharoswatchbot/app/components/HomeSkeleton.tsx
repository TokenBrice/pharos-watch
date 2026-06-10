"use client";

export function HomeSkeleton() {
  return (
    <div className="mt-4 space-y-4" role="status" aria-busy="true" aria-live="polite" aria-label="Loading Telegram settings">
      <div className="h-32 animate-pulse rounded-2xl border border-border/70 bg-card/90" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-20 animate-pulse rounded-2xl border border-border/70 bg-card/90" />
        <div className="h-20 animate-pulse rounded-2xl border border-border/70 bg-card/90" />
      </div>
      <div className="h-12 animate-pulse rounded-xl border border-border/65 bg-background/60" />
    </div>
  );
}
