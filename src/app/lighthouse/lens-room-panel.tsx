"use client";

import type { CSSProperties } from "react";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import type { LighthouseLensModel } from "./story-model";

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "timestamp unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp * 1000));
}

export function LensRoomPanel({ lens }: { lens: LighthouseLensModel | null }) {
  if (!lens) {
    return (
      <div className="lh-empty-story-state">
        <p className="text-sm font-medium text-foreground">PSI is unavailable.</p>
        <p className="text-sm text-muted-foreground">
          The lens room stays locked until the published Stability Index sample is available.
        </p>
      </div>
    );
  }

  const lensColor = PSI_HEX_COLORS[lens.band as ConditionBand] ?? "var(--frost-blue)";

  return (
    <div className="lh-lens-room" data-testid="lighthouse-lens-room">
      <div className="lh-lens-optic" style={{ "--lh-lens-color": lensColor } as CSSProperties} aria-hidden="true">
        <div className="lh-lens-optic__beam" style={{ width: `${Math.max(18, lens.lightReachPct)}%` }} />
        <div className="lh-lens-optic__glass">
          <span />
          <span />
          <span />
        </div>
      </div>

      <div className="lh-lens-readout">
        <div>
          <p className="pharos-kicker">Light Source</p>
          <p className="font-mono text-2xl font-semibold text-foreground">{lens.scoreLabel}</p>
          <p className="text-xs text-muted-foreground">
            Methodology {lens.methodologyVersion} · {formatTimestamp(lens.computedAt)}
          </p>
        </div>

        <div className="grid gap-2">
          {lens.slats.map((slat) => (
            <div key={slat.key} className="lh-lens-slat">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-foreground">{slat.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{slat.value.toFixed(1)}</span>
              </div>
              <div className="lh-lens-slat__track" aria-hidden="true">
                <span style={{ width: `${Math.max(4, slat.widthPct)}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">{slat.copy}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">{lens.caveat}</p>
      </div>
    </div>
  );
}
