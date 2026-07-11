"use client";

import { Camera, RefreshCw, ShieldCheck } from "lucide-react";

interface SelectorSnapshotBannerProps {
  mode: "frozen" | "fallback";
  trust?: "verified" | "unverified";
  capturedAt?: number;
  onCompareToToday?: () => void;
  comparison?: {
    status: "idle" | "loading" | "changed" | "unchanged" | "error";
    summary?: string;
    deltas?: readonly {
      label: string;
      previous: string | number;
      current: string | number;
    }[];
  };
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
  comparison,
}: SelectorSnapshotBannerProps) {
  if (mode === "frozen") {
    const verified = trust === "verified";
    const SnapshotIcon = verified ? ShieldCheck : Camera;
    return (
      <div
        role="status"
        aria-busy={comparison?.status === "loading" ? "true" : undefined}
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
        {comparison ? (
          <div className="rounded-md border border-frost-blue/25 bg-background/45 px-3 py-2">
            <p className="font-medium text-foreground">
              {comparison.status === "loading"
                ? "Comparing snapshot to current data..."
                : comparison.status === "unchanged"
                  ? "No shortlist changes against today's data."
                  : comparison.status === "error"
                    ? "Comparison could not be loaded."
                    : (comparison.summary ?? "Snapshot differs from today's data.")}
            </p>
            {comparison.deltas && comparison.deltas.length > 0 ? (
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                {comparison.deltas.map((delta) => (
                  <div key={delta.label} className="min-w-0 rounded border border-border/45 bg-card/40 px-2 py-1">
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {delta.label}
                    </dt>
                    <dd className="break-words text-xs text-foreground">
                      {delta.previous} → {delta.current}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
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
