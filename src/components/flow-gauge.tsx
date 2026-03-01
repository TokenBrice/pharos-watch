"use client";

import { useId } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowGaugeProps {
  score: number | null;
  band: string | null;
  flightToQuality: boolean;
  flightIntensity: number;
  trackedCoins: number;
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Band configuration — static Tailwind classes (never construct dynamically)
// ---------------------------------------------------------------------------

interface BandConfig {
  label: string;
  hex: string;
  textClass: string;
  bgClass: string;
}

const GAUGE_BANDS: Record<string, BandConfig> = {
  CRISIS: { label: "Crisis", hex: "#ef4444", textClass: "text-red-500", bgClass: "bg-red-500" },
  STRESS: { label: "Stress", hex: "#f97316", textClass: "text-orange-500", bgClass: "bg-orange-500" },
  CAUTIOUS: { label: "Cautious", hex: "#f59e0b", textClass: "text-amber-500", bgClass: "bg-amber-500" },
  NEUTRAL: { label: "Neutral", hex: "#6b7280", textClass: "text-gray-500", bgClass: "bg-gray-500" },
  HEALTHY: { label: "Healthy", hex: "#84cc16", textClass: "text-lime-500", bgClass: "bg-lime-500" },
  CONFIDENT: { label: "Confident", hex: "#22c55e", textClass: "text-green-500", bgClass: "bg-green-500" },
  SURGE: { label: "Surge", hex: "#10b981", textClass: "text-emerald-500", bgClass: "bg-emerald-500" },
};

const DEFAULT_BAND: BandConfig = {
  label: "Unknown",
  hex: "#6b7280",
  textClass: "text-muted-foreground",
  bgClass: "bg-muted",
};

// ---------------------------------------------------------------------------
// SVG geometry constants
// ---------------------------------------------------------------------------

const CX = 150;
const CY = 130;
const R = 110;
const SW = 14;

/** Map a 0-100 score to an angle on the semicircle (180deg..0deg). */
function scoreToAngle(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return 180 - (clamped / 100) * 180;
}

function toXY(angleDeg: number, r: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
}

/**
 * Describe an arc path from startAngle to endAngle (in degrees).
 * Angles are measured counter-clockwise from 3-o'clock position.
 * For a semicircle left-to-right, start=180 and end=0.
 */
function arcPath(startDeg: number, endDeg: number, radius: number): string {
  const [x1, y1] = toXY(startDeg, radius);
  const [x2, y2] = toXY(endDeg, radius);
  const sweep = startDeg - endDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
}

// Arc segment boundaries (score 0..100 mapped to angle 180..0)
const ARC_SEGMENTS = [
  { min: 0, max: 15, band: "CRISIS" },
  { min: 15, max: 30, band: "STRESS" },
  { min: 30, max: 45, band: "CAUTIOUS" },
  { min: 45, max: 55, band: "NEUTRAL" },
  { min: 55, max: 70, band: "HEALTHY" },
  { min: 70, max: 85, band: "CONFIDENT" },
  { min: 85, max: 100, band: "SURGE" },
] as const;

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function GaugeSkeleton() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full max-w-[300px] aspect-[300/170]">
        <svg viewBox="0 0 300 170" className="w-full h-full">
          <path
            d={arcPath(180, 0, R)}
            fill="none"
            stroke="currentColor"
            strokeWidth={SW}
            strokeLinecap="round"
            className="text-muted/40 animate-pulse"
          />
        </svg>
      </div>
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-5 w-24" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calibrating state
// ---------------------------------------------------------------------------

function GaugeCalibrating({ trackedCoins }: { trackedCoins: number }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full max-w-[300px] aspect-[300/170]">
        <svg viewBox="0 0 300 170" className="w-full h-full" role="img" aria-label="Bank Run Gauge: Calibrating">
          {/* Gray arc */}
          <path
            d={arcPath(180, 0, R)}
            fill="none"
            stroke="currentColor"
            strokeWidth={SW}
            strokeLinecap="round"
            className="text-muted/30"
          />
          {/* Center pivot */}
          <circle cx={CX} cy={CY} r={5} className="fill-muted/40" />
        </svg>
      </div>
      <span className="text-lg font-bold text-muted-foreground animate-pulse">
        Calibrating...
      </span>
      <span className="text-xs text-muted-foreground">
        Tracking {trackedCoins} stablecoins
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active gauge
// ---------------------------------------------------------------------------

function GaugeActive({
  score,
  band,
  flightToQuality,
  flightIntensity,
  trackedCoins,
}: {
  score: number;
  band: string;
  flightToQuality: boolean;
  flightIntensity: number;
  trackedCoins: number;
}) {
  const rawId = useId();
  const uniqueId = rawId.replace(/:/g, "");
  const bandConfig = GAUGE_BANDS[band] ?? DEFAULT_BAND;

  const angleDeg = scoreToAngle(score);
  const needleR = R - 4;
  const [nx, ny] = toXY(angleDeg, needleR);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-full max-w-[300px] aspect-[300/170]">
        <svg
          viewBox="0 0 300 170"
          className="w-full h-full"
          role="img"
          aria-label={`Bank Run Gauge: score ${score}, ${bandConfig.label}`}
        >
          <defs>
            {/* Drop shadow for needle */}
            <filter id={`needle-shadow-${uniqueId}`} x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor={bandConfig.hex} floodOpacity="0.4" />
            </filter>
          </defs>

          {/* Colored arc segments */}
          {ARC_SEGMENTS.map((seg) => {
            const startAngle = 180 - (seg.min / 100) * 180;
            const endAngle = 180 - (seg.max / 100) * 180;
            const segBand = GAUGE_BANDS[seg.band] ?? DEFAULT_BAND;
            return (
              <path
                key={seg.band}
                d={arcPath(startAngle, endAngle, R)}
                fill="none"
                stroke={segBand.hex}
                strokeWidth={SW}
                opacity={seg.band === band ? 0.9 : 0.3}
              />
            );
          })}

          {/* Tick marks at segment boundaries */}
          {[0, 15, 30, 45, 55, 70, 85, 100].map((tick) => {
            const angle = 180 - (tick / 100) * 180;
            const [ox, oy] = toXY(angle, R + SW / 2 + 2);
            const [ix, iy] = toXY(angle, R - SW / 2 - 2);
            return (
              <line
                key={tick}
                x1={ox}
                y1={oy}
                x2={ix}
                y2={iy}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground/30"
              />
            );
          })}

          {/* Needle */}
          <line
            x1={CX}
            y1={CY}
            x2={nx}
            y2={ny}
            stroke={bandConfig.hex}
            strokeWidth={2.5}
            strokeLinecap="round"
            filter={`url(#needle-shadow-${uniqueId})`}
            className="transition-all duration-700 ease-out"
          />

          {/* Center pivot */}
          <circle cx={CX} cy={CY} r={5} fill={bandConfig.hex} opacity={0.9} />
          <circle cx={CX} cy={CY} r={2.5} className="fill-background" />

          {/* Score text */}
          <text
            x={CX}
            y={CY - 20}
            textAnchor="middle"
            fill={bandConfig.hex}
            fontSize={32}
            fontWeight="800"
            fontFamily="var(--font-mono, monospace)"
          >
            {Math.round(score)}
          </text>

          {/* Min / max labels */}
          <text
            x={CX - R - 4}
            y={CY + 16}
            textAnchor="middle"
            fill="currentColor"
            opacity={0.3}
            fontSize={9}
            fontFamily="var(--font-mono, monospace)"
          >
            0
          </text>
          <text
            x={CX + R + 4}
            y={CY + 16}
            textAnchor="middle"
            fill="currentColor"
            opacity={0.3}
            fontSize={9}
            fontFamily="var(--font-mono, monospace)"
          >
            100
          </text>
        </svg>
      </div>

      {/* Band label */}
      <span className={`text-sm font-bold uppercase tracking-wide ${bandConfig.textClass}`}>
        {bandConfig.label}
      </span>

      {/* Flight to quality badge */}
      {flightToQuality && (
        <Badge
          variant="outline"
          className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-xs"
        >
          Flight to Quality &middot; {Math.round(flightIntensity * 100)}% intensity
        </Badge>
      )}

      {/* Tracked coins label */}
      <span className="text-xs text-muted-foreground">
        Tracking {trackedCoins} stablecoins
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function FlowGauge({
  score,
  band,
  flightToQuality,
  flightIntensity,
  trackedCoins,
  isLoading,
}: FlowGaugeProps) {
  if (isLoading) {
    return <GaugeSkeleton />;
  }

  if (score === null || band === null) {
    return <GaugeCalibrating trackedCoins={trackedCoins} />;
  }

  return (
    <GaugeActive
      score={score}
      band={band}
      flightToQuality={flightToQuality}
      flightIntensity={flightIntensity}
      trackedCoins={trackedCoins}
    />
  );
}

export { GAUGE_BANDS };
export type { FlowGaugeProps };
