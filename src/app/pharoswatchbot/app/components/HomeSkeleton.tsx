"use client";

import type { MiniAppScreen } from "../use-mini-app-view";

const ROW_WIDTHS = ["w-24", "w-32", "w-20", "w-28", "w-24"] as const;

/** Route-aware placeholder shaped like the screen being opened. */
export function HomeSkeleton({ screenName = "home" }: { screenName?: MiniAppScreen["name"] }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading your alerts" className="motion-safe:animate-pulse">
      {screenName === "add-coins" ? (
        <div className="mb-4 flex h-11 items-center rounded-xl bg-[var(--mini-card)] px-3">
          <span className="h-4 w-40 rounded-sm bg-muted" />
        </div>
      ) : screenName === "home" ? (
        <div className="flex items-center gap-3 rounded-xl bg-[var(--mini-card)] px-4 py-4">
          <span className="h-2.5 w-2.5 rounded-full bg-muted" />
          <span className="h-4 w-28 rounded-sm bg-muted" />
        </div>
      ) : (
        <div className="px-1 pt-2">
          <span className="block h-7 w-32 rounded-sm bg-muted" />
          <span className="mt-2 block h-4 w-48 rounded-sm bg-muted" />
        </div>
      )}
      <div className="mt-6 px-4 pb-1.5"><span className="block h-3 w-16 rounded-sm bg-muted" /></div>
      <div className="overflow-hidden rounded-xl bg-[var(--mini-card)]">
        {ROW_WIDTHS.map((width, index) => (
          <div key={index} className="flex h-[3.25rem] items-center justify-between px-4">
            <span className={`h-3.5 rounded-sm bg-muted ${width}`} />
            <span className="h-3 w-16 rounded-sm bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
