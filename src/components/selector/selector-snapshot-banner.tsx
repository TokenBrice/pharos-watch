"use client";

import { Camera, RefreshCw, ShieldCheck } from "lucide-react";

interface SelectorSnapshotBannerProps {
  mode: "frozen" | "fallback";
  trust?: "verified" | "unverified";
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
  trust = "unverified",
  capturedAt,
  onCompareToToday,
}: SelectorSnapshotBannerProps) {
  if (mode === "frozen") {
    const verified = trust === "verified";
    const SnapshotIcon = verified ? ShieldCheck : Camera;
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <SnapshotIcon className="mt-0.5 h-4 w-4 shrink-0 text-frost-blue" aria-hidden="true" />
            <div className="min-w-0 text-foreground">
              <p className="font-semibold">{verified ? "Pharos-verified snapshot" : "Unverified client snapshot"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {verified
                  ? `Pharos recomputed this snapshot from canonical source data when the link was created${
                      capturedAt ? ` on ${formatDate(capturedAt)}` : ""
                    }.`
                  : `Showing snapshot ${capturedAt ? `from ${formatDate(capturedAt)}` : "from earlier"}. Pharos checked its format and tracked identities, but did not reproduce its scores from canonical source data.`}
              </p>
            </div>
          </div>
          {onCompareToToday ? (
            <button
              type="button"
              onClick={onCompareToToday}
              className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/55 px-3 py-1 text-xs font-medium text-foreground hover:bg-muted/35"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Compare to today&rsquo;s data
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm"
    >
      <Camera className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-foreground">Original snapshot no longer cached; showing current output for the same inputs.</p>
    </div>
  );
}
