import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import {
  scoreToRadius,
  deterministicOffset,
  deterministicRadiusOffset,
  distributeAngles,
} from "@/lib/dews-radar-utils";
import type { ThreatBand } from "@shared/lib/classification";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CX = 280;
export const CY = 240;
export const OUTER_R = 240;
export const VB_W = 560;
export const VB_H = 500;

export type ElevatedBand = Exclude<ThreatBand, "CALM">;
export type BandCounts = Record<ThreatBand, number>;

export const RING_BANDS: ElevatedBand[] = ["WATCH", "ALERT", "WARNING", "DANGER"];
export const LEGEND_BANDS: ThreatBand[] = ["DANGER", "WARNING", "ALERT", "WATCH", "CALM"];
export const RING_RADII: Record<ElevatedBand, number> = {
  DANGER: 45,
  WARNING: 95,
  ALERT: 143,
  WATCH: 178,
};

export const CALM_INNER_R = 212;
const CALM_ZONE_WIDTH = 26; // outer edge 238 - inner edge 212

// 8 spokes at 45-degree intervals, from r=10 to OUTER_R
export const SPOKES = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return {
    x1: CX + 10 * Math.cos(a),
    y1: CY + 10 * Math.sin(a),
    x2: CX + OUTER_R * Math.cos(a),
    y2: CY + OUTER_R * Math.sin(a),
  };
});

// Wake arc: 90-degree sector from 12 o'clock to 3 o'clock in the sweep group's local frame.
export const WAKE_PATH = `M ${CX} ${CY} L ${CX} ${CY - OUTER_R} A ${OUTER_R} ${OUTER_R} 0 0 1 ${CX + OUTER_R} ${CY} Z`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalmDot {
  x: number;
  y: number;
}

export interface ElevatedCoin {
  id: string;
  score: number;
  band: ElevatedBand;
  symbol: string;
  name: string;
  logoUrl?: string;
  mcap?: number;
  x: number;
  y: number;
}

export interface RadarClickOutcome {
  shouldNavigate: boolean;
  nextHoveredId: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Map a circulating supply (USD) to a dot radius. 4 tiers, fallback = undefined (caller uses band-based default). */
export function mcapDotRadius(mcap: number | undefined): number | undefined {
  if (mcap == null) return undefined;
  if (mcap >= 5_000_000_000) return 13; // mega: >$5B
  if (mcap >= 500_000_000) return 10;   // large: >$500M
  if (mcap >= 50_000_000) return 7;     // mid:   >$50M
  return 5;                              // small: <=50M
}

export function computePositions(
  signals: Record<string, { score: number; band: string }>,
  logos: Record<string, string> | undefined,
  mcapById?: Map<string, number>,
): ElevatedCoin[] {
  const byBand: Record<ElevatedBand, Array<{ id: string; score: number }>> = {
    WATCH: [],
    ALERT: [],
    WARNING: [],
    DANGER: [],
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
        mcap: mcapById?.get(coin.id),
        x: CX + r * Math.cos(angle),
        y: CY + r * Math.sin(angle),
      });
    });
  }

  return result;
}

export function computeCalmDots(signals: Record<string, { score: number; band: string }>): CalmDot[] {
  const calmIds = Object.keys(signals).filter((id) => signals[id].band === "CALM");
  const angles = distributeAngles(calmIds.length);
  return calmIds.map((id, i) => {
    const r = CALM_INNER_R + deterministicRadiusOffset(id, CALM_ZONE_WIDTH);
    const angle = angles[i] + deterministicOffset(id);
    return {
      x: CX + r * Math.cos(angle),
      y: CY + r * Math.sin(angle),
    };
  });
}

export function computeBandCounts(signals: Record<string, { score: number; band: string }>): BandCounts {
  const counts: BandCounts = {
    CALM: 0,
    WATCH: 0,
    ALERT: 0,
    WARNING: 0,
    DANGER: 0,
  };

  for (const { band } of Object.values(signals)) {
    if (band in counts) {
      counts[band as ThreatBand] += 1;
    }
  }

  return counts;
}

export function resolveRadarClick(
  isFinePointer: boolean,
  hoveredId: string | null,
  tappedId: string,
): RadarClickOutcome {
  if (isFinePointer) {
    return { shouldNavigate: true, nextHoveredId: hoveredId };
  }
  if (hoveredId === tappedId) {
    return { shouldNavigate: true, nextHoveredId: null };
  }
  return { shouldNavigate: false, nextHoveredId: tappedId };
}
