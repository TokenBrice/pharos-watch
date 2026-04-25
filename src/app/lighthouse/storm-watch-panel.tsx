"use client";

import type { CSSProperties } from "react";
import type { LighthouseStormModel } from "./story-model";

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return "timestamp unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp * 1000));
}

function SignalMast({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "warning" | "alert" | "danger";
}) {
  const height = Math.max(8, Math.min(100, count * 16));
  return (
    <div className="lh-storm-signal" data-tone={tone}>
      <div className="lh-storm-signal__mast" aria-hidden="true">
        <span style={{ height: `${height}%` }} />
      </div>
      <div>
        <p className="font-mono text-lg font-semibold text-foreground">{count}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

export function StormWatchPanel({ storm }: { storm: LighthouseStormModel | null }) {
  if (!storm) {
    return (
      <div className="lh-empty-story-state">
        <p className="text-sm font-medium text-foreground">DEWS storm watch is unavailable.</p>
        <p className="text-sm text-muted-foreground">
          The horizon stays clear unless the aggregate stress-signals payload is present.
        </p>
      </div>
    );
  }

  const pressurePct = Math.max(24, Math.min(48, 24 + storm.totalPressure * 2.5));
  const stormOpacity = Math.max(0.14, Math.min(0.62, 0.14 + storm.totalPressure * 0.035));
  const stormFlashOpacity = Math.max(0.24, Math.min(0.88, 0.24 + storm.totalPressure * 0.045));
  return (
    <div
      className="lh-storm-watch"
      style={
        {
          "--lh-storm-pressure": `${pressurePct}%`,
          "--lh-storm-opacity": String(stormOpacity),
          "--lh-storm-flash-opacity": String(stormFlashOpacity),
        } as CSSProperties
      }
      data-testid="lighthouse-storm-watch"
    >
      <div className="lh-storm-horizon" aria-hidden="true">
        <span className="lh-storm-horizon__line" />
        <span className="lh-storm-horizon__flash lh-storm-horizon__flash--one" />
        <span className="lh-storm-horizon__flash lh-storm-horizon__flash--two" />
        <span className="lh-storm-horizon__flash lh-storm-horizon__flash--three" />
      </div>

      <div className="lh-storm-readout">
        <div className="grid gap-3 sm:grid-cols-3">
          <SignalMast label="Warning" count={storm.warning} tone="warning" />
          <SignalMast label="Alert" count={storm.alert} tone="alert" />
          <SignalMast label="Danger" count={storm.danger} tone="danger" />
        </div>

        <div className="lh-storm-source">
          <div>
            <p className="pharos-kicker">Aggregate Pressure</p>
            <p className="font-mono text-sm font-semibold text-foreground">
              {storm.totalPressure} non-calm signals
            </p>
          </div>
          <div>
            <p className="pharos-kicker">Oldest Row</p>
            <p className="font-mono text-sm font-semibold text-foreground">{formatTimestamp(storm.oldestComputedAt)}</p>
          </div>
          <div>
            <p className="pharos-kicker">Updated</p>
            <p className="font-mono text-sm font-semibold text-foreground">{formatTimestamp(storm.updatedAt)}</p>
          </div>
        </div>

        {storm.malformedRows > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {storm.malformedRows} malformed stress rows were omitted from the horizon count.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{storm.caveat}</p>
      </div>
    </div>
  );
}
