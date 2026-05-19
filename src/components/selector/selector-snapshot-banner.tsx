"use client";

import { Camera, RefreshCw } from "lucide-react";

interface SelectorSnapshotBannerProps {
  mode: "frozen" | "fallback";
  capturedAt?: number;
  onCompareToToday?: () => void;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function SelectorSnapshotBanner({
  mode,
  capturedAt,
  onCompareToToday,
}: SelectorSnapshotBannerProps) {
  if (mode === "frozen") {
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-lg border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-start gap-2">
          <Camera className="mt-0.5 h-4 w-4 shrink-0 text-frost-blue" aria-hidden="true" />
          <p className="text-foreground">
            Showing snapshot {capturedAt ? `from ${formatDate(capturedAt)}` : "from earlier"}.
          </p>
        </div>
        {onCompareToToday ? (
          <button
            type="button"
            onClick={onCompareToToday}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-frost-blue/45 px-3 py-1 text-xs font-medium text-foreground hover:bg-frost-blue/[0.1]"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Compare to today&rsquo;s data
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.07] px-4 py-3 text-sm"
    >
      <Camera className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-200" aria-hidden="true" />
      <p className="text-foreground">
        Original snapshot no longer cached; showing current output for the same inputs.
      </p>
    </div>
  );
}
