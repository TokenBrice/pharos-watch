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
const VB_W = 560;
const VB_H = 480;

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

const RADAR_KEYFRAMES = `
  @keyframes dews-sweep-rotate {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes dews-glow {
    0%, 100% { opacity: 0.10; }
    50%      { opacity: 0.35; }
  }
  @keyframes dews-center-pulse {
    0%, 100% { opacity: 0.65; }
    50%      { opacity: 1.00; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dews-sweep-g  { animation-play-state: paused !important; }
    .dews-glow-r   { animation: none !important; opacity: 0.15; }
    .dews-center-r { animation: none !important; opacity: 0.80; }
  }
`;

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

function DEWSDot({
  coin,
  onHover,
  onClick,
}: {
  coin: ElevatedCoin;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}) {
  const hex = THREAT_BAND_HEX[coin.band];
  const isHighTier = coin.band === "WARNING" || coin.band === "DANGER";
  const dotR = isHighTier ? 9 : 6;
  const glowR = dotR + 7;
  const dur = pulseDuration(coin.band);

  return (
    <g
      transform={`translate(${coin.x.toFixed(1)}, ${coin.y.toFixed(1)})`}
      role="button"
      tabIndex={0}
      aria-label={`${coin.symbol}: DEWS score ${coin.score}, band ${coin.band}`}
      style={{ cursor: "pointer" }}
      onMouseEnter={() => onHover(coin.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(coin.id)}
      onBlur={() => onHover(null)}
      onClick={() => onClick(coin.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(coin.id); }}
    >
      {/* Animated glow ring */}
      <circle r={glowR} fill={hex}
        className="dews-glow-r"
        style={{ animation: `dews-glow ${dur}s ease-in-out infinite` }} />
      {/* Main dot */}
      <circle r={dotR} fill={hex} fillOpacity={0.92} />
      {/* Always-visible label: WARNING and DANGER only */}
      {isHighTier && (
        <text
          y={-(dotR + 7)}
          textAnchor="middle"
          dominantBaseline="auto"
          fill={hex}
          fontSize={10}
          fontWeight={700}
          fontFamily="var(--font-mono)"
        >
          {coin.symbol}
        </text>
      )}
    </g>
  );
}

function DEWSTooltip({ coin }: { coin: ElevatedCoin }) {
  const hex = THREAT_BAND_HEX[coin.band];
  const W = 124;
  const H = 46;
  // Clamp so tooltip stays within viewBox; flip below the dot when near the top edge
  const tx = Math.min(Math.max(coin.x + 14, 4), VB_W - W - 4);
  const preferAbove = coin.y - H - 10 >= 4;
  const ty = preferAbove
    ? coin.y - H - 10
    : Math.min(coin.y + 14, VB_H - H - 4);

  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={W} height={H} rx={6}
        fill="var(--color-popover)" stroke="var(--color-border)" strokeWidth={1} />
      <text x={tx + 10} y={ty + 16}
        fill="var(--color-foreground)" fontSize={11} fontWeight={600}
        fontFamily="var(--font-sans)">
        {coin.symbol}
      </text>
      <text x={tx + 10} y={ty + 32}
        fill={hex} fontSize={10} fontWeight={600}
        fontFamily="var(--font-mono)">
        {coin.band}
      </text>
      <text x={tx + W - 10} y={ty + 32}
        fill="var(--color-muted-foreground)" fontSize={10}
        fontFamily="var(--font-mono)" textAnchor="end">
        {coin.score}/100
      </text>
    </g>
  );
}

function DEWSCenter({
  highest,
  elevatedCount,
  totalCount,
  sweepDur,
}: {
  highest: ThreatBand;
  elevatedCount: number;
  totalCount: number;
  sweepDur: number;
}) {
  const hex = THREAT_BAND_HEX[highest];
  const label = highest === "CALM" ? "ALL CALM" : highest;
  const sublabel =
    highest === "CALM" ? `${totalCount} monitored` : `${elevatedCount} elevated`;

  return (
    <g>
      <circle
        cx={CX} cy={CY} r={38}
        fill={hex} fillOpacity={0.13}
        stroke={hex} strokeOpacity={0.38} strokeWidth={1.5}
        className="dews-center-r"
        style={{ animation: `dews-center-pulse ${sweepDur}s ease-in-out infinite` }}
      />
      <text
        x={CX} y={CY - 5}
        textAnchor="middle" dominantBaseline="middle"
        fill={hex} fontSize={11} fontWeight={700}
        fontFamily="var(--font-mono)" letterSpacing={1}
      >
        {label}
      </text>
      <text
        x={CX} y={CY + 11}
        textAnchor="middle" dominantBaseline="middle"
        fill="var(--color-muted-foreground)" fontSize={9}
        fontFamily="var(--font-mono)"
      >
        {sublabel}
      </text>
    </g>
  );
}

function DEWSRadar({
  elevated,
  highest,
  totalCount,
  onCoinClick,
}: {
  elevated: ElevatedCoin[];
  highest: ThreatBand;
  totalCount: number;
  onCoinClick: (id: string) => void;
}) {
  const uid = useId();
  const wakeGradId = `dews-wake-${uid}`;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const hex = THREAT_BAND_HEX[highest];
  const dur = sweepDuration(highest);

  return (
    <svg viewBox="0 0 560 480" width="100%" style={{ maxHeight: 440 }}
      aria-label={`DEWS radar — ${elevated.length === 0 ? "all coins calm" : `${elevated.length} elevated, highest: ${highest}`}`}
      role="img">
      <defs>
        <style>{RADAR_KEYFRAMES}</style>
        <radialGradient id={wakeGradId} cx={CX} cy={CY} r={OUTER_R} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={hex} stopOpacity={0.18} />
          <stop offset="100%" stopColor={hex} stopOpacity={0} />
        </radialGradient>
      </defs>

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
      <circle cx={CX} cy={CY} r={OUTER_R}
        fill="none" stroke={hex} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 6" />

      {/* Sweep group — wake arc + line, rotates together */}
      <g
        className="dews-sweep-g"
        style={{
          transformOrigin: `${CX}px ${CY}px`,
          animation: `dews-sweep-rotate ${dur}s linear infinite`,
        }}
      >
        <path d={WAKE_PATH} fill={`url(#${wakeGradId})`} />
        <line
          x1={CX} y1={CY} x2={CX + OUTER_R} y2={CY}
          stroke={hex} strokeOpacity={0.65} strokeWidth={1.5} strokeLinecap="round"
        />
      </g>

      {/* Coin dots */}
      {elevated.map((coin) => (
        <DEWSDot
          key={coin.id}
          coin={coin}
          onHover={setHoveredId}
          onClick={onCoinClick}
        />
      ))}
      {hoveredId && (() => {
        const hovered = elevated.find((c) => c.id === hoveredId);
        return hovered ? <DEWSTooltip coin={hovered} /> : null;
      })()}
      <DEWSCenter
        highest={highest}
        elevatedCount={elevated.length}
        totalCount={totalCount}
        sweepDur={dur}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DEWSLegend
// ---------------------------------------------------------------------------

function DEWSLegend({ updatedAt }: { updatedAt: number }) {
  const minsAgo = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
  const ageLabel = minsAgo <= 1 ? "just now" : `${minsAgo}m ago`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 border-t">
      {RING_BANDS.map((band) => (
        <div key={band} className="flex items-center gap-1.5">
          <svg width={20} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={20} y2={2}
              stroke={THREAT_BAND_HEX[band]} strokeWidth={2} />
          </svg>
          <span className="text-xs text-muted-foreground capitalize">
            {band.charAt(0) + band.slice(1).toLowerCase()}
          </span>
        </div>
      ))}
      <span className="ml-auto text-xs text-muted-foreground/50 tabular-nums font-mono">
        Updated {ageLabel}
      </span>
    </div>
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
  const router = useRouter();

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

  const totalCount = Object.keys(data.signals).length;
  const elevated = computePositions(data.signals, logos);
  const highest = highestBand(elevated.map((c) => c.band));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {elevated.length > 0
              ? `${elevated.length} elevated · ${totalCount - elevated.length} calm`
              : `All ${totalCount} coins calm`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-0 pb-4">
        <DEWSRadar
          elevated={elevated}
          highest={highest}
          totalCount={totalCount}
          onCoinClick={(id) => router.push(`/stablecoin/${id}`)}
        />
        <DEWSLegend updatedAt={data.updatedAt * 1000} />
      </CardContent>
    </Card>
  );
}
