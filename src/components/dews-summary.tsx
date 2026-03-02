"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { PSI_ELIGIBLE_META_BY_ID } from "@/lib/psi-eligible";
import { THREAT_BAND_HEX } from "@/lib/classification";
import type { ThreatBand } from "@/lib/classification";
import {
  scoreToRadius,
  deterministicOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CX = 280;
const CY = 240;
const OUTER_R = 240;

type ElevatedBand = Exclude<ThreatBand, "CALM">;

const RING_BANDS: ElevatedBand[] = ["WATCH", "ALERT", "WARNING", "DANGER"];
const RING_RADII: Record<ElevatedBand, number> = {
  WATCH: 75, ALERT: 118, WARNING: 161, DANGER: 204,
};

// 8 spokes at 45° intervals, from r=10 to OUTER_R
const SPOKES = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return {
    x1: CX + 10 * Math.cos(a), y1: CY + 10 * Math.sin(a),
    x2: CX + OUTER_R * Math.cos(a), y2: CY + OUTER_R * Math.sin(a),
  };
});

// Wake arc: 90° sector from 12 o'clock to 3 o'clock in the sweep group's local frame.
// The sweep line points right (0°). The wake is the quadrant behind it (-90° to 0°).
const WAKE_PATH = `M ${CX} ${CY} L ${CX} ${CY - OUTER_R} A ${OUTER_R} ${OUTER_R} 0 0 1 ${CX + OUTER_R} ${CY} Z`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ElevatedCoin {
  id: string;
  score: number;
  band: ElevatedBand;
  symbol: string;
  name: string;
  logoUrl?: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePositions(
  signals: Record<string, { score: number; band: string }>,
  logos: Record<string, string> | undefined,
): ElevatedCoin[] {
  const byBand: Record<ElevatedBand, Array<{ id: string; score: number }>> = {
    WATCH: [], ALERT: [], WARNING: [], DANGER: [],
  };

  for (const [id, entry] of Object.entries(signals)) {
    if (entry.band === "CALM") continue;
    const b = entry.band as ElevatedBand;
    if (byBand[b]) byBand[b].push({ id, score: entry.score });
  }

  const result: ElevatedCoin[] = [];

  for (const band of RING_BANDS) {
    const coins = byBand[band];
    const angles = distributeAngles(coins.length);
    coins.forEach((coin, i) => {
      const r = scoreToRadius(coin.score, band);
      const angle = angles[i] + deterministicOffset(coin.id);
      const meta = PSI_ELIGIBLE_META_BY_ID.get(coin.id);
      result.push({
        id: coin.id,
        score: coin.score,
        band,
        symbol: meta?.symbol ?? coin.id,
        name: meta?.name ?? coin.id,
        logoUrl: logos?.[coin.id],
        x: CX + r * Math.cos(angle),
        y: CY + r * Math.sin(angle),
      });
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sub-components (unexported)
// ---------------------------------------------------------------------------

// Placeholder — will be replaced in Task 4
function DEWSRadarSkeleton({ hex }: { hex: string }) {
  return (
    <svg viewBox="0 0 560 480" width="100%" style={{ maxHeight: 440 }}
      aria-label="DEWS radar" role="img">
      {/* Spokes */}
      {SPOKES.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
      ))}
      {/* Band ring boundaries */}
      {RING_BANDS.map((band) => (
        <circle key={band} cx={CX} cy={CY} r={RING_RADII[band]}
          fill="none" stroke={THREAT_BAND_HEX[band]}
          strokeOpacity={0.25} strokeWidth={1} strokeDasharray="4 6" />
      ))}
      {/* Outer boundary */}
      <circle cx={CX} cy={CY} r={OUTER_R}
        fill="none" stroke={hex}
        strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 6" />
      {/* Center placeholder */}
      <circle cx={CX} cy={CY} r={38}
        fill={hex} fillOpacity={0.12}
        stroke={hex} strokeOpacity={0.35} strokeWidth={1.5} />
      <text x={CX} y={CY - 4} textAnchor="middle" dominantBaseline="middle"
        fill={hex} fontSize={11} fontWeight={700} fontFamily="var(--font-mono)" letterSpacing={1}>
        DEWS
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface DEWSSummaryProps {
  logos?: Record<string, string>;
}

export function DEWSSummary({ logos }: DEWSSummaryProps) {
  const { data, isLoading } = useStressSignals();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[440px] rounded-lg bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.signals || Object.keys(data.signals).length === 0) return null;

  const elevated = computePositions(data.signals, logos);
  const highest = highestBand(elevated.map((c) => c.band));
  const hex = THREAT_BAND_HEX[highest];

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
      </CardHeader>
      <CardContent>
        <DEWSRadarSkeleton hex={hex} />
      </CardContent>
    </Card>
  );
}
