"use client";

const ROW_WIDTHS = ["w-24", "w-32", "w-20", "w-28", "w-24"] as const;

/** Placeholder shaped like the Home status strip and list rows. */
export function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading your alerts" className="animate-pulse">
      <div className="flex items-center gap-3 rounded-xl bg-[var(--mini-card)] px-4 py-4">
        <span className="h-2.5 w-2.5 rounded-full bg-muted" />
        <span className="h-4 w-28 rounded bg-muted" />
      </div>
      <div className="mt-6 px-4 pb-1.5"><span className="block h-3 w-16 rounded bg-muted" /></div>
      <div className="overflow-hidden rounded-xl bg-[var(--mini-card)]">
        {ROW_WIDTHS.map((width, index) => (
          <div key={index} className="flex h-[3.25rem] items-center justify-between px-4">
            <span className={`h-3.5 rounded bg-muted ${width}`} />
            <span className="h-3 w-16 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
