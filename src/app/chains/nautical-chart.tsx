"use client";

import type { KeyboardEvent } from "react";
import { Anchor, Activity, ShipWheel } from "lucide-react";
import type { ChainSummary } from "@shared/types/chains";
import { HEALTH_BADGE_CLASSES, HEALTH_HEX_FILL } from "@/lib/chain-ui";
import type { HealthBand } from "@shared/types/chains";
import { cn } from "@/lib/utils";
import { logosById } from "@/lib/logos";
import { formatCompactUsd } from "@shared/lib/format";
import { buildChainHarborModel, type ChainHarborEntry } from "./harbor-map";
import { hullWidth, cargoCapacityForHull, depthLayers, wakeLength, aggregateSkyBand } from "./nautical-scene-math";
import "./nautical-chart.css";

const SCENE_WIDTH = 1200;
const SCENE_HEIGHT = 320;
const WATERLINE_Y = 224;
const PIER_X = 58;
const LIGHTHOUSE_ZONE = 220;

const CHAIN_ACCENT_HEX: Record<string, string> = {
  arbitrum: "#28a0f0",
  base: "#0052ff",
  bsc: "#f3ba2f",
  ethereum: "#627eea",
  hyperliquid: "#50e3c2",
  polygon: "#8247e5",
  solana: "#14f195",
  tron: "#ff060a",
};

function healthHex(band: HealthBand | null): string {
  return band ? HEALTH_HEX_FILL[band] : "#94a3b8";
}

function chainAccentHex(id: string): string {
  const curated = CHAIN_ACCENT_HEX[id];
  if (curated) return curated;

  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return `oklch(0.68 0.14 ${hash})`;
}

type ShipGeometry = {
  hullTop: number;
  hullBottom: number;
  hullMidY: number;
  keelY: number;
  deckLeft: number;
  deckRight: number;
  sternInset: number;
  bowRise: number;
  railY: number;
  mainMastX: number;
  foreMastX: number;
  aftMastX: number;
  mastTopY: number;
  foreTopY: number;
  aftTopY: number;
  rigScale: number;
  hullDepth: number;
  hullW: number;
  flagWidth: number;
  logoSize: number;
  sailSealY: number;
};

function shipDimensions(entry: ChainHarborEntry, x: number, hullW: number, laneY: number, supplyScale: number): ShipGeometry {
  const rigScale = 0.62 + supplyScale * 0.7;
  const hullDepth = 16 + supplyScale * 12;
  const hullTop = laneY + 12 - supplyScale * 7;
  const hullBottom = hullTop + hullDepth;
  const deckLeft = x;
  const deckRight = x + hullW;
  const sternInset = Math.min(13, Math.max(7, hullW * 0.1));
  const bowRise = Math.min(22, Math.max(12, hullW * 0.18));
  const hullMidY = hullTop + hullDepth * 0.55;
  const keelY = hullBottom - 2;
  const mainMastX = deckLeft + hullW * 0.55;
  const foreMastX = deckLeft + hullW * 0.27;
  const aftMastX = deckLeft + hullW * 0.76;
  const mastTopY = hullTop - 78 * rigScale;
  const foreTopY = hullTop - 56 * rigScale;
  const aftTopY = hullTop - 49 * rigScale;
  const railY = hullTop - 3;
  const flagWidth = Math.max(14, Math.min(48, (entry.dominantSharePct / 100) * 48)) * (0.86 + supplyScale * 0.24);
  const logoSize = 13 + supplyScale * 7;
  const sailSealY = hullTop - 18 - supplyScale * 6;
  return {
    hullTop, hullBottom, hullMidY, keelY, deckLeft, deckRight, sternInset, bowRise,
    railY, mainMastX, foreMastX, aftMastX, mastTopY, foreTopY, aftTopY, rigScale,
    hullDepth, hullW, flagWidth, logoSize, sailSealY,
  };
}

function Lighthouse({ dim }: { dim: boolean }) {
  // Pharos of Alexandria: square base → octagonal middle → cylindrical top, crowned with a fire brazier.
  // Built of pale limestone, ~140 m tall in antiquity. Here, three tapering tiers in stone, no candy stripes.
  const baseX = SCENE_WIDTH - 110;
  const waterline = WATERLINE_Y;
  const rockTop = waterline - 14;

  // Tier 1: square base
  const t1Bottom = rockTop - 4;
  const t1Top = t1Bottom - 64;
  const t1HalfBottom = 26;
  const t1HalfTop = 22;

  // Tier 2: octagonal middle
  const t2Bottom = t1Top - 1;
  const t2Top = t2Bottom - 36;
  const t2HalfBottom = 17;
  const t2HalfTop = 14;

  // Tier 3: cylindrical top with open colonnade
  const t3Bottom = t2Top - 1;
  const t3Top = t3Bottom - 22;
  const t3Half = 11;

  // Brazier (open fire bowl) and beam origin
  const brazierBottom = t3Top - 1;
  const beamY = brazierBottom - 4;
  const beamTopY = Math.max(8, beamY - 74);
  const beamBottomY = Math.min(waterline - 12, beamY + 126);

  const beamOpacity = dim ? 0.32 : 0.72;
  const flameOpacity = dim ? 0.55 : 1;

  return (
    <g aria-hidden="true">
      {/* Beam — sweeping left across the harbor from the brazier */}
      <g className="nc-lighthouse-beam">
        <path
          d={`M ${baseX} ${beamY} L 20 ${beamTopY} L 20 ${beamBottomY} Z`}
          fill="url(#nc-beam)"
          opacity={beamOpacity}
        />
        <path
          d={`M ${baseX} ${beamY} L ${baseX - 280} ${beamY - 30} L ${baseX - 280} ${beamY + 42} Z`}
          fill="url(#nc-beam)"
          opacity={dim ? 0.2 : 0.42}
        />
      </g>

      {/* Rocky promontory */}
      <path
        d={`M ${baseX - 50} ${waterline + 2} Q ${baseX - 38} ${rockTop + 1} ${baseX - 28} ${rockTop + 4} Q ${baseX - 14} ${rockTop - 6} ${baseX - 2} ${rockTop - 2} Q ${baseX + 12} ${rockTop + 4} ${baseX + 28} ${rockTop} Q ${baseX + 40} ${waterline} ${baseX + 52} ${waterline + 2} Z`}
        fill="oklch(0.16 0.022 250)"
        stroke="oklch(0.06 0.018 250)"
        strokeWidth={0.7}
      />
      <path d={`M ${baseX - 32} ${rockTop + 2} Q ${baseX - 20} ${rockTop - 1} ${baseX - 8} ${rockTop + 1}`} fill="none" stroke="oklch(0.34 0.018 250 / 0.7)" strokeWidth={0.6} />
      <path d={`M ${baseX + 6} ${rockTop} Q ${baseX + 20} ${rockTop - 2} ${baseX + 30} ${rockTop + 2}`} fill="none" stroke="oklch(0.34 0.018 250 / 0.6)" strokeWidth={0.6} />

      {/* Tier 1 — square base, slight taper */}
      <path
        d={`M ${baseX - t1HalfBottom} ${t1Bottom} L ${baseX - t1HalfTop} ${t1Top} L ${baseX + t1HalfTop} ${t1Top} L ${baseX + t1HalfBottom} ${t1Bottom} Z`}
        fill="url(#nc-stone)"
        stroke="oklch(0.32 0.025 75)"
        strokeWidth={0.7}
      />
      {/* Block courses — horizontal seams */}
      {[14, 28, 42, 56].map((dy) => (
        <line
          key={`t1-course-${dy}`}
          x1={baseX - t1HalfBottom + (dy / 64) * (t1HalfBottom - t1HalfTop) + 1}
          y1={t1Bottom - dy}
          x2={baseX + t1HalfBottom - (dy / 64) * (t1HalfBottom - t1HalfTop) - 1}
          y2={t1Bottom - dy}
          stroke="oklch(0.45 0.025 75 / 0.4)"
          strokeWidth={0.35}
        />
      ))}
      {/* Vertical block edge hints */}
      <line x1={baseX - 8} y1={t1Bottom - 4} x2={baseX - 7.4} y2={t1Top + 4} stroke="oklch(0.45 0.025 75 / 0.45)" strokeWidth={0.35} />
      <line x1={baseX + 8} y1={t1Bottom - 4} x2={baseX + 7.4} y2={t1Top + 4} stroke="oklch(0.45 0.025 75 / 0.45)" strokeWidth={0.35} />
      {/* Door at base */}
      <path
        d={`M ${baseX - 4} ${t1Bottom} L ${baseX - 4} ${t1Bottom - 11} Q ${baseX - 4} ${t1Bottom - 14} ${baseX} ${t1Bottom - 14} Q ${baseX + 4} ${t1Bottom - 14} ${baseX + 4} ${t1Bottom - 11} L ${baseX + 4} ${t1Bottom} Z`}
        fill="oklch(0.16 0.022 60)"
        stroke="oklch(0.32 0.025 75 / 0.7)"
        strokeWidth={0.4}
      />
      {/* Window slits */}
      {[24, 40].map((dy) => (
        <rect
          key={`t1-win-${dy}`}
          x={baseX - 1.4}
          y={t1Bottom - dy}
          width={2.8}
          height={5}
          fill="oklch(0.94 0.04 75 / 0.7)"
          rx={0.6}
        />
      ))}
      {/* Cornice — capping the base */}
      <rect x={baseX - t1HalfTop - 3} y={t1Top - 3} width={(t1HalfTop + 3) * 2} height={3} fill="oklch(0.5 0.03 75 / 0.85)" />

      {/* Tier 2 — octagonal middle */}
      <path
        d={`M ${baseX - t2HalfBottom} ${t2Bottom} L ${baseX - t2HalfTop} ${t2Top} L ${baseX + t2HalfTop} ${t2Top} L ${baseX + t2HalfBottom} ${t2Bottom} Z`}
        fill="url(#nc-stone)"
        stroke="oklch(0.32 0.025 75)"
        strokeWidth={0.7}
      />
      {/* Octagonal facet hints — vertical seams */}
      <line x1={baseX - 6.5} y1={t2Bottom - 2} x2={baseX - 5.5} y2={t2Top + 2} stroke="oklch(0.45 0.025 75 / 0.55)" strokeWidth={0.4} />
      <line x1={baseX + 6.5} y1={t2Bottom - 2} x2={baseX + 5.5} y2={t2Top + 2} stroke="oklch(0.45 0.025 75 / 0.55)" strokeWidth={0.4} />
      {/* Single window high on the facet */}
      <rect x={baseX - 1.4} y={t2Bottom - 16} width={2.8} height={5} fill="oklch(0.94 0.04 75 / 0.65)" rx={0.5} />
      {/* Cornice */}
      <rect x={baseX - t2HalfTop - 2.5} y={t2Top - 2.5} width={(t2HalfTop + 2.5) * 2} height={2.5} fill="oklch(0.5 0.03 75 / 0.82)" />

      {/* Tier 3 — cylindrical lantern with open colonnade */}
      <rect x={baseX - t3Half} y={t3Top} width={t3Half * 2} height={t3Bottom - t3Top} fill="oklch(0.2 0.025 60 / 0.55)" />
      {/* Columns suggesting open colonnade */}
      {[-9, -5, -1, 3, 7].map((dx, i) => (
        <rect
          key={`col-${i}`}
          x={baseX + dx}
          y={t3Top + 1.5}
          width={1.6}
          height={t3Bottom - t3Top - 3}
          fill="url(#nc-stone)"
          stroke="oklch(0.4 0.025 75 / 0.5)"
          strokeWidth={0.25}
        />
      ))}
      {/* Top cornice */}
      <rect x={baseX - t3Half - 1.5} y={t3Top} width={(t3Half + 1.5) * 2} height={2} fill="oklch(0.5 0.03 75 / 0.88)" />
      {/* Architrave under colonnade */}
      <rect x={baseX - t3Half - 1} y={t3Bottom - 1.5} width={(t3Half + 1) * 2} height={1.8} fill="oklch(0.5 0.03 75 / 0.78)" />

      {/* Brazier — open fire bowl */}
      <path
        d={`M ${baseX - 8} ${brazierBottom} Q ${baseX - 8} ${brazierBottom + 5} ${baseX - 4} ${brazierBottom + 5} L ${baseX + 4} ${brazierBottom + 5} Q ${baseX + 8} ${brazierBottom + 5} ${baseX + 8} ${brazierBottom} Z`}
        fill="oklch(0.18 0.022 50)"
        stroke="oklch(0.5 0.04 60 / 0.85)"
        strokeWidth={0.7}
      />
      <line x1={baseX - 9} y1={brazierBottom} x2={baseX + 9} y2={brazierBottom} stroke="oklch(0.6 0.05 60)" strokeWidth={1.1} />

      {/* Halo glow behind flames */}
      <circle cx={baseX} cy={brazierBottom - 7} r={26} fill="#f97316" opacity={dim ? 0.08 : 0.16} className="nc-lighthouse-pulse" />
      <circle cx={baseX} cy={brazierBottom - 7} r={14} fill="#fde68a" opacity={dim ? 0.22 : 0.4} />

      {/* Flames — three stacked layers, outer to core */}
      <path
        className="nc-flame-outer"
        d={`M ${baseX - 6} ${brazierBottom - 1} Q ${baseX - 5} ${brazierBottom - 9} ${baseX - 1.5} ${brazierBottom - 14} Q ${baseX} ${brazierBottom - 17} ${baseX + 1.5} ${brazierBottom - 14} Q ${baseX + 5} ${brazierBottom - 9} ${baseX + 6} ${brazierBottom - 1} Z`}
        fill="#f97316"
        opacity={flameOpacity * 0.85}
      />
      <path
        className="nc-flame-mid"
        d={`M ${baseX - 3.5} ${brazierBottom - 2} Q ${baseX - 3} ${brazierBottom - 8} ${baseX - 0.8} ${brazierBottom - 12} Q ${baseX} ${brazierBottom - 15} ${baseX + 0.8} ${brazierBottom - 12} Q ${baseX + 3} ${brazierBottom - 8} ${baseX + 3.5} ${brazierBottom - 2} Z`}
        fill="#fbbf24"
        opacity={flameOpacity * 0.95}
      />
      <path
        d={`M ${baseX - 1.6} ${brazierBottom - 3} Q ${baseX - 1.2} ${brazierBottom - 7} ${baseX} ${brazierBottom - 11} Q ${baseX + 1.2} ${brazierBottom - 7} ${baseX + 1.6} ${brazierBottom - 3} Z`}
        fill="#fef9c3"
        opacity={flameOpacity}
      />

      {/* Smoke wisp — only when not dim */}
      {!dim && (
        <path
          d={`M ${baseX} ${brazierBottom - 17} q -3 -5 1 -10 q 3 -4 -1 -9 q -2 -3 1 -8`}
          fill="none"
          stroke="oklch(0.55 0.012 250 / 0.32)"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

function Coastline() {
  const y = WATERLINE_Y;
  const path = `M -10 ${y} L 60 ${y - 5} L 110 ${y - 8} L 160 ${y - 6} L 220 ${y - 11} L 280 ${y - 7} L 340 ${y - 13} L 400 ${y - 9} L 460 ${y - 14} L 520 ${y - 8} L 580 ${y - 12} L 650 ${y - 6} L 720 ${y - 10} L 790 ${y - 7} L 860 ${y - 13} L 930 ${y - 8} L 1010 ${y - 11} L 1090 ${y - 6} L 1160 ${y - 9} L 1210 ${y} Z`;
  return (
    <g aria-hidden="true">
      <path d={path} fill="oklch(0.2 0.022 248)" opacity={0.55} />
      <path d={path} fill="none" stroke="oklch(0.36 0.025 248 / 0.5)" strokeWidth={0.6} />
    </g>
  );
}

function Stars() {
  const stars: Array<[number, number, number, number]> = [
    [120, 28, 0.8, 0.6],
    [240, 52, 1.1, 0.85],
    [310, 22, 0.6, 0.5],
    [430, 44, 0.9, 0.7],
    [560, 18, 1.2, 0.9],
    [680, 38, 0.7, 0.55],
    [820, 26, 0.9, 0.7],
    [950, 50, 1.0, 0.8],
    [1060, 30, 0.7, 0.6],
  ];
  return (
    <g aria-hidden="true">
      {stars.map(([x, y, r, o], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="#f8fafc" opacity={o} />
      ))}
      {/* Twin-star "eye" — Pharos watching */}
      <circle cx={245} cy={50} r={2.2} fill="#f8fafc" opacity={0.95} />
      <circle cx={245} cy={50} r={4} fill="none" stroke="#f8fafc" strokeWidth={0.4} opacity={0.4} />
    </g>
  );
}

function WaveRipples() {
  const ripples: Array<[number, number, string, number]> = [
    [PIER_X - 10, WATERLINE_Y + 6, "8 14 4 22 12 18", 0.22],
    [PIER_X + 40, WATERLINE_Y + 14, "12 16 6 24 10 20", 0.18],
    [PIER_X - 5, WATERLINE_Y + 22, "6 18 14 16 8 26", 0.15],
    [PIER_X + 20, WATERLINE_Y + 32, "10 22 6 18 14 20", 0.12],
    [PIER_X - 8, WATERLINE_Y + 44, "8 26 12 18 6 22", 0.09],
  ];
  return (
    <g aria-hidden="true">
      {ripples.map(([x, y, dash, opacity], i) => (
        <line
          key={i}
          x1={x}
          y1={y}
          x2={SCENE_WIDTH - 30}
          y2={y}
          stroke="#7dd3fc"
          strokeWidth={0.7}
          strokeDasharray={dash}
          strokeLinecap="round"
          opacity={opacity}
        />
      ))}
    </g>
  );
}

function Fog() {
  return (
    <g aria-hidden="true">
      {[36, 58, 80, 102].map((y, i) => (
        <line
          key={y}
          x1={SCENE_WIDTH - 320}
          y1={y}
          x2={SCENE_WIDTH - 20}
          y2={y}
          stroke="#cbd5e1"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeDasharray={i === 1 ? "32 10" : i === 2 ? "20 8" : "14 6"}
          opacity={0.45 - i * 0.07}
        />
      ))}
    </g>
  );
}

function ChartGrid({ laneWidth, lanes }: { laneWidth: number; lanes: number }) {
  const startX = PIER_X - 18;
  const endX = SCENE_WIDTH - 28;
  return (
    <g aria-hidden="true">
      {[36, 78, 120, 162, 200].map((y) => (
        <line
          key={`sky-${y}`}
          x1={startX}
          y1={y}
          x2={endX}
          y2={y}
          stroke="currentColor"
          strokeWidth={0.6}
          strokeDasharray="2 8"
          opacity={0.07}
        />
      ))}
      {[18, 42, 66, 90].map((offset, i) => {
        const y = WATERLINE_Y + offset;
        return (
          <line
            key={`depth-${y}`}
            x1={startX}
            y1={y}
            x2={endX}
            y2={y}
            stroke="#38bdf8"
            strokeWidth={0.7}
            strokeDasharray={i % 2 === 0 ? "7 9" : "2 10"}
            opacity={0.14}
          />
        );
      })}
      {Array.from({ length: lanes + 1 }).map((_, i) => {
        const x = PIER_X + i * laneWidth;
        return (
          <line
            key={`berth-${i}`}
            x1={x}
            y1={WATERLINE_Y - 38}
            x2={x}
            y2={SCENE_HEIGHT - 18}
            stroke="currentColor"
            strokeWidth={0.55}
            opacity={0.06}
          />
        );
      })}
      <text
        x={startX}
        y={SCENE_HEIGHT - 14}
        fontSize={8}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="currentColor"
        opacity={0.36}
      >
        DOMINANCE DRAFT
      </text>
    </g>
  );
}

function Ship({
  entry,
  geom,
  maxCargoUsd,
}: {
  entry: ChainHarborEntry;
  geom: ShipGeometry;
  maxCargoUsd: number;
}) {
  const healthColor = healthHex(entry.healthBand);
  const accentColor = chainAccentHex(entry.id);
  const layers = depthLayers(entry.sharePct / 100);
  const wake = wakeLength(entry.change7dPct);
  const {
    hullTop, hullBottom, hullMidY, keelY, deckLeft, deckRight, sternInset, bowRise,
    railY, mainMastX, foreMastX, aftMastX, mastTopY, foreTopY, aftTopY, rigScale,
    hullDepth, hullW, flagWidth, logoSize, sailSealY,
  } = geom;
  const portholeCount = Math.max(3, Math.min(6, Math.round(hullW / 18)));
  const portholeSpan = Math.max(12, hullW - sternInset - bowRise - 16);
  const portholeStart = deckLeft + (hullW - portholeSpan) / 2;
  const portholeGap = portholeCount > 1 ? portholeSpan / (portholeCount - 1) : 0;
  const portholeRadius = 1.9 + (rigScale - 0.62) * 1.2;
  const clipId = `nc-logo-${entry.id.replace(/[^a-z0-9-]/gi, "-")}`;
  const cargoManifest = entry.cargos.slice(0, cargoCapacityForHull(hullW));
  const cargoTrackInset = Math.max(5, Math.min(9, hullW * 0.1));
  const cargoTrackStart = deckLeft + cargoTrackInset;
  const cargoTrackEnd = deckRight - cargoTrackInset;
  const cargoTrackWidth = Math.max(1, cargoTrackEnd - cargoTrackStart);
  const cargoGap = cargoManifest.length > 1 ? cargoTrackWidth / (cargoManifest.length - 1) : 0;
  const cargoMarkY = hullTop + hullDepth * 0.36;
  const cargoMarks = cargoManifest.map((cargo, i) => {
    const cargoScale = maxCargoUsd > 0 ? Math.sqrt(cargo.cargoUsd / maxCargoUsd) : 0;
    const size = Math.max(5.5, Math.min(hullDepth * 0.42, 4.5 + cargoScale * 6));
    const x = cargoManifest.length > 1
      ? cargoTrackStart + i * cargoGap
      : deckLeft + hullW / 2;
    const safeId = `${entry.id}-${cargo.id}-${i}`.replace(/[^a-z0-9-]/gi, "-");
    return {
      ...cargo,
      x,
      y: cargoMarkY,
      size,
      clipId: `nc-cargo-${safeId}`,
      logoPath: logosById[cargo.id],
    };
  });
  const cargoTitle = cargoManifest
    .map((cargo) => `${cargo.symbol} ${cargo.sharePct.toFixed(0)}%`)
    .join(", ");

  return (
    <g>
      {wake !== 0 && (
        <path
          d={
            wake > 0
              ? `M ${deckRight + 3} ${hullBottom - 3} q ${wake * 26} -3 ${wake * 60} 1`
              : `M ${deckLeft - 3} ${hullBottom - 3} q ${wake * 26} -3 ${wake * 60} 1`
          }
          stroke={wake > 0 ? "#10b981" : "#ef4444"}
          strokeWidth={1.1}
          strokeDasharray="2 5"
          fill="none"
          opacity={0.55}
        />
      )}
      <path
        d={`M ${mainMastX} ${mastTopY} L ${deckLeft + sternInset + 4} ${railY} L ${deckRight - bowRise - 4} ${railY} Z`}
        fill="oklch(0.96 0.018 75 / 0.08)"
        stroke="oklch(1 0 0 / 0.14)"
        strokeWidth={0.5}
      />
      <line x1={mainMastX} y1={mastTopY} x2={mainMastX} y2={hullBottom - 3} stroke="oklch(0.82 0.05 72 / 0.78)" strokeWidth={1.8} />
      <line x1={foreMastX} y1={foreTopY} x2={foreMastX} y2={hullTop + 2} stroke="oklch(0.82 0.05 72 / 0.68)" strokeWidth={1.4} />
      <line x1={aftMastX} y1={aftTopY} x2={aftMastX} y2={hullTop + 3} stroke="oklch(0.82 0.05 72 / 0.6)" strokeWidth={1.2} />

      <path
        className="nc-sail"
        d={`M ${mainMastX + 2} ${mastTopY + 3 * rigScale} C ${mainMastX + hullW * 0.3} ${mastTopY + 14 * rigScale}, ${mainMastX + hullW * 0.36} ${railY - 16 * rigScale}, ${mainMastX + 3} ${railY - 2} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.95}
        opacity={0.98}
      />
      <path
        className="nc-sail"
        d={`M ${mainMastX - 2} ${mastTopY + 14 * rigScale} C ${mainMastX - hullW * 0.34} ${mastTopY + 21 * rigScale}, ${mainMastX - hullW * 0.38} ${railY - 12 * rigScale}, ${mainMastX - 2} ${railY - 1} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.8}
        opacity={0.92}
      />
      <path
        d={`M ${foreMastX + 1} ${foreTopY + 5 * rigScale} C ${foreMastX + hullW * 0.23} ${foreTopY + 11 * rigScale}, ${foreMastX + hullW * 0.26} ${railY - 10 * rigScale}, ${foreMastX + 1} ${railY - 1} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.7}
        opacity={0.82}
      />
      <path
        d={`M ${aftMastX - 1} ${aftTopY + 6 * rigScale} C ${aftMastX + hullW * 0.2} ${aftTopY + 13 * rigScale}, ${aftMastX + hullW * 0.16} ${railY - 8 * rigScale}, ${aftMastX - 1} ${railY - 1} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.7}
        opacity={0.74}
      />
      <path
        d={`M ${deckRight - bowRise + 2} ${railY} Q ${deckRight + 12} ${railY - 9} ${deckRight + 18} ${railY - 28} Q ${deckRight + 7} ${railY - 18} ${deckRight - bowRise - 4} ${railY}`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.65}
        opacity={0.76}
      />

      {/* Stays / rigging lines */}
      <path d={`M ${mainMastX} ${mastTopY + 4} Q ${deckLeft + sternInset + 2} ${railY - 2} ${deckLeft + sternInset} ${hullTop + 2}`} fill="none" stroke="oklch(0.97 0.008 75 / 0.32)" strokeWidth={0.55} />
      <path d={`M ${mainMastX} ${mastTopY + 4} Q ${deckRight - bowRise + 5} ${railY - 3} ${deckRight + 12} ${railY - 20}`} fill="none" stroke="oklch(0.97 0.008 75 / 0.32)" strokeWidth={0.55} />
      {[0.22, 0.5, 0.78].map((t) => (
        <path
          key={t}
          d={`M ${mainMastX + hullW * 0.02} ${mastTopY + (8 + t * 50) * rigScale} C ${mainMastX + hullW * 0.1} ${mastTopY + (12 + t * 50) * rigScale}, ${mainMastX + hullW * 0.16} ${mastTopY + (13 + t * 50) * rigScale}, ${mainMastX + hullW * 0.23} ${mastTopY + (10 + t * 50) * rigScale}`}
          fill="none"
          stroke={accentColor}
          strokeWidth={0.55}
          opacity={0.34}
        />
      ))}

      {/* Hull */}
      <path
        d={`M ${deckLeft + sternInset} ${railY} L ${deckRight - bowRise} ${railY} Q ${deckRight - 2} ${railY + 5} ${deckRight} ${hullMidY} Q ${deckRight - bowRise * 0.7} ${hullBottom + 3} ${deckLeft + sternInset + 9} ${hullBottom + 1} Q ${deckLeft - 3} ${hullBottom - 2} ${deckLeft} ${hullMidY} Q ${deckLeft + 3} ${hullTop + 3} ${deckLeft + sternInset} ${railY} Z`}
        fill="url(#nc-hull-wood)"
        stroke="oklch(0.08 0.018 55 / 0.85)"
        strokeWidth={1.3}
      />
      {/* Brand stripe along the rail */}
      <path
        d={`M ${deckLeft + sternInset + 2} ${hullTop + 5} L ${deckRight - bowRise - 3} ${hullTop + 4}`}
        stroke={accentColor}
        strokeWidth={2.4}
        strokeLinecap="round"
        opacity={0.92}
      />
      <path
        d={`M ${deckLeft + sternInset + 4} ${hullTop + 14} C ${deckLeft + hullW * 0.38} ${hullTop + 18}, ${deckLeft + hullW * 0.68} ${hullTop + 17}, ${deckRight - bowRise * 0.65} ${hullTop + 12}`}
        stroke="oklch(0.04 0.014 45 / 0.5)"
        strokeWidth={1.2}
        fill="none"
      />
      <path
        d={`M ${deckLeft + sternInset + 8} ${keelY} C ${deckLeft + hullW * 0.42} ${keelY + 3}, ${deckLeft + hullW * 0.7} ${keelY + 2}, ${deckRight - bowRise * 0.82} ${keelY - 2}`}
        stroke="oklch(0.04 0.014 45 / 0.45)"
        strokeWidth={1.3}
        fill="none"
      />

      {/* Portholes */}
      {Array.from({ length: portholeCount }).map((_, i) => (
        <circle
          key={i}
          cx={portholeStart + i * portholeGap}
          cy={hullTop + hullDepth * 0.72}
          r={portholeRadius}
          fill="oklch(0.08 0.012 45 / 0.7)"
          stroke={accentColor}
          strokeWidth={0.65}
          opacity={0.94}
        />
      ))}
      <g aria-hidden="true">
        <title>
          {entry.name} cargo manifest: {cargoTitle}
        </title>
        <defs>
          {cargoMarks.map((cargo) => (
            <clipPath key={cargo.clipId} id={cargo.clipId}>
              <circle cx={cargo.x} cy={cargo.y} r={cargo.size / 2 - 0.8} />
            </clipPath>
          ))}
        </defs>
        {cargoMarks.map((cargo) => (
          <g key={cargo.clipId}>
            <circle
              cx={cargo.x}
              cy={cargo.y}
              r={cargo.size / 2}
              fill="oklch(0.98 0.006 250 / 0.95)"
              stroke={accentColor}
              strokeWidth={0.7}
            />
            {cargo.logoPath ? (
              <image
                href={cargo.logoPath}
                x={cargo.x - cargo.size / 2 + 0.9}
                y={cargo.y - cargo.size / 2 + 0.9}
                width={cargo.size - 1.8}
                height={cargo.size - 1.8}
                clipPath={`url(#${cargo.clipId})`}
              />
            ) : (
              <text
                x={cargo.x}
                y={cargo.y + cargo.size * 0.22}
                textAnchor="middle"
                fontSize={Math.max(4.2, cargo.size * 0.46)}
                fontFamily="ui-monospace, Menlo, monospace"
                fontWeight={700}
                fill="oklch(0.18 0.025 250)"
              >
                {cargo.symbol.charAt(0)}
              </text>
            )}
          </g>
        ))}
      </g>

      {/* Crow's nest yard */}
      <line x1={mainMastX - 11} y1={mastTopY + 8} x2={mainMastX + 22} y2={mastTopY + 5} stroke={accentColor} strokeWidth={2.2} strokeLinecap="round" />

      {/* Pennant — proper triangular flag with notched tail */}
      <path
        className="nc-flag"
        d={`M ${mainMastX + 2} ${mastTopY - 6} h ${flagWidth} l -7 5 l 7 5 h -${flagWidth} Z`}
        fill={accentColor}
        opacity={0.94}
      />

      {/* Sail logo seal */}
      <defs>
        <clipPath id={clipId}>
          <circle cx={mainMastX} cy={sailSealY} r={logoSize / 2} />
        </clipPath>
      </defs>
      <circle cx={mainMastX} cy={sailSealY} r={logoSize / 2 + 1.6} fill="oklch(0.98 0.006 250 / 0.94)" stroke={accentColor} strokeWidth={1.1} />
      <circle cx={mainMastX} cy={sailSealY} r={logoSize / 2 + 4.5} fill="none" stroke={healthColor} strokeWidth={0.9} opacity={0.6} />
      <image
        href={entry.logoPath}
        x={mainMastX - logoSize / 2}
        y={sailSealY - logoSize / 2}
        width={logoSize}
        height={logoSize}
        clipPath={`url(#${clipId})`}
      />

      {/* Depth ticks below hull */}
      {Array.from({ length: layers }).map((_, i) => {
        const offset = 4 + i * 3;
        return (
          <line
            key={i}
            x1={deckLeft + 4 + i * 2}
            y1={hullBottom + offset}
            x2={deckRight - 4 - i * 2}
            y2={hullBottom + offset}
            stroke="#0284c7"
            strokeWidth={0.75}
            opacity={0.34 - i * 0.07}
          />
        );
      })}
    </g>
  );
}

function ShipReflection({ entry, geom }: { entry: ChainHarborEntry; geom: ShipGeometry }) {
  const accentColor = chainAccentHex(entry.id);
  const {
    hullTop, hullBottom, hullMidY, deckLeft, deckRight, sternInset, bowRise,
    railY, mainMastX, foreMastX, aftMastX, mastTopY, foreTopY, aftTopY, rigScale, hullW, sailSealY, logoSize,
  } = geom;
  return (
    <g transform={`translate(0, ${2 * WATERLINE_Y}) scale(1, -1)`}>
      {/* Mast silhouettes — faint */}
      <line x1={mainMastX} y1={mastTopY} x2={mainMastX} y2={hullBottom - 3} stroke="oklch(0.4 0.04 250 / 0.45)" strokeWidth={1.2} />
      <line x1={foreMastX} y1={foreTopY} x2={foreMastX} y2={hullTop + 2} stroke="oklch(0.4 0.04 250 / 0.4)" strokeWidth={1} />
      <line x1={aftMastX} y1={aftTopY} x2={aftMastX} y2={hullTop + 3} stroke="oklch(0.4 0.04 250 / 0.35)" strokeWidth={0.9} />

      {/* Sail silhouettes — outlines only */}
      <path
        d={`M ${mainMastX + 2} ${mastTopY + 3 * rigScale} C ${mainMastX + hullW * 0.3} ${mastTopY + 14 * rigScale}, ${mainMastX + hullW * 0.36} ${railY - 16 * rigScale}, ${mainMastX + 3} ${railY - 2} Z`}
        fill="oklch(0.5 0.02 248 / 0.22)"
        stroke="oklch(0.6 0.04 248 / 0.4)"
        strokeWidth={0.5}
      />
      <path
        d={`M ${mainMastX - 2} ${mastTopY + 14 * rigScale} C ${mainMastX - hullW * 0.34} ${mastTopY + 21 * rigScale}, ${mainMastX - hullW * 0.38} ${railY - 12 * rigScale}, ${mainMastX - 2} ${railY - 1} Z`}
        fill="oklch(0.5 0.02 248 / 0.18)"
        stroke="oklch(0.6 0.04 248 / 0.34)"
        strokeWidth={0.5}
      />

      {/* Hull silhouette — darker, no detail */}
      <path
        d={`M ${deckLeft + sternInset} ${railY} L ${deckRight - bowRise} ${railY} Q ${deckRight - 2} ${railY + 5} ${deckRight} ${hullMidY} Q ${deckRight - bowRise * 0.7} ${hullBottom + 3} ${deckLeft + sternInset + 9} ${hullBottom + 1} Q ${deckLeft - 3} ${hullBottom - 2} ${deckLeft} ${hullMidY} Q ${deckLeft + 3} ${hullTop + 3} ${deckLeft + sternInset} ${railY} Z`}
        fill="oklch(0.18 0.025 35 / 0.78)"
        stroke="oklch(0.06 0.018 250 / 0.5)"
        strokeWidth={0.8}
      />
      {/* Brand stripe ghost */}
      <path
        d={`M ${deckLeft + sternInset + 2} ${hullTop + 5} L ${deckRight - bowRise - 3} ${hullTop + 4}`}
        stroke={accentColor}
        strokeWidth={1.6}
        strokeLinecap="round"
        opacity={0.55}
      />
      {/* Sail seal ghost */}
      <circle cx={mainMastX} cy={sailSealY} r={logoSize / 2 + 1} fill="oklch(0.7 0.02 248 / 0.35)" stroke={accentColor} strokeWidth={0.5} opacity={0.5} />
    </g>
  );
}

function HorizonFleet({ remaining, y, maxX }: { remaining: readonly ChainSummary[]; y: number; maxX: number }) {
  if (remaining.length === 0) return null;
  const visible = remaining.slice(0, 8);
  const spacing = 18;
  const baseX = maxX - visible.length * spacing - 30;
  return (
    <g opacity={0.5}>
      {visible.map((c, i) => (
        <path key={c.id} d={`M ${baseX + i * spacing} ${y + 4} h 14 l -3 3 h -9 Z`} fill="#475569" opacity={0.7}>
          <title>{c.name}</title>
        </path>
      ))}
    </g>
  );
}

function CompassPlate({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="relative rounded-lg border border-border/70 bg-muted/20 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 break-words font-mono text-lg font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function NauticalChart({
  chains,
  globalTotalUsd,
  selectedChainId,
  onSelectChain,
}: {
  chains: ChainSummary[];
  globalTotalUsd: number;
  selectedChainId?: string | null;
  onSelectChain?: (chainId: string) => void;
}) {
  const model = buildChainHarborModel(chains, globalTotalUsd);
  if (model.entries.length === 0) return null;

  const activeChainId = selectedChainId ?? model.largestHarbor?.id ?? null;
  const sky = aggregateSkyBand(model.entries);
  const maxSupply = model.entries[0]?.totalUsd ?? 0;
  const topCount = model.entries.length;
  const chartLabel = `Nautical chart of ${topCount} largest stablecoin ${topCount === 1 ? "chain" : "chains"}`;
  const laneWidth = (SCENE_WIDTH - PIER_X - LIGHTHOUSE_ZONE) / Math.max(topCount, 1);

  const remaining = [...chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(topCount);
  const maxCargoUsd = Math.max(0, ...model.entries.flatMap((entry) => entry.cargos.map((cargo) => cargo.cargoUsd)));

  const geometries = model.entries.map((entry, i) => {
    const hullW = hullWidth(entry.totalUsd, maxSupply, laneWidth * 1.1);
    const x = PIER_X + i * laneWidth + (laneWidth - hullW) / 2;
    const supplyScale =
      maxSupply > 0 ? Math.max(0.1, Math.min(1, Math.sqrt(entry.totalUsd / maxSupply))) : 0.1;
    return { entry, geom: shipDimensions(entry, x, hullW, WATERLINE_Y - 18, supplyScale) };
  });
  const handleShipKeyDown = (event: KeyboardEvent<SVGGElement>, chainId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectChain?.(chainId);
  };

  return (
    <section className="pharos-card-shell overflow-hidden" aria-labelledby="chain-nautical-heading">
      <div className="pharos-panel-header flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Harbor Chart</p>
          <h2 id="chain-nautical-heading" className="text-lg font-semibold tracking-tight">
            Where stablecoin supply is docked
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Vessel length tracks supply; hull color is health band; pennant span is dominant-coin share; window rows
            scale with vessel size; hull cargo marks show top stablecoins sized by chain-local supply.
          </p>
        </div>
        <div className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          Top {topCount} chains hold {model.topSharePct.toFixed(1)}%
        </div>
      </div>

      <div
        className="nc-chart-viewport"
        role="group"
        aria-label={`Horizontally scrollable ${chartLabel.toLowerCase()}`}
        tabIndex={0}
      >
        <svg
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          role="img"
          aria-label={chartLabel}
          className="nc-chart-svg block text-slate-100"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id="nc-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.18 0.04 258)" stopOpacity="0.92" />
              <stop offset="55%" stopColor="oklch(0.32 0.05 252)" stopOpacity="0.7" />
              <stop offset="100%" stopColor="oklch(0.5 0.05 245)" stopOpacity="0.42" />
            </linearGradient>
            <linearGradient id="nc-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.28 0.06 245)" stopOpacity="0.6" />
              <stop offset="50%" stopColor="oklch(0.18 0.05 248)" stopOpacity="0.7" />
              <stop offset="100%" stopColor="oklch(0.1 0.04 250)" stopOpacity="0.85" />
            </linearGradient>
            <linearGradient id="nc-beam" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#fde68a" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="nc-stone" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="oklch(0.92 0.024 78)" stopOpacity="0.96" />
              <stop offset="50%" stopColor="oklch(0.84 0.028 78)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="oklch(0.66 0.03 75)" stopOpacity="0.94" />
            </linearGradient>
            <linearGradient id="nc-sail-cloth" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#fff7ed" stopOpacity="0.96" />
              <stop offset="58%" stopColor="#e5e7eb" stopOpacity="0.82" />
              <stop offset="100%" stopColor="#94a3b8" stopOpacity="0.58" />
            </linearGradient>
            <linearGradient id="nc-hull-wood" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#b7793d" stopOpacity="0.98" />
              <stop offset="58%" stopColor="#7c3f12" stopOpacity="0.96" />
              <stop offset="100%" stopColor="#3b1d0b" stopOpacity="0.98" />
            </linearGradient>
            <linearGradient id="nc-reflection-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
              <stop offset="35%" stopColor="#ffffff" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <mask id="nc-reflection-mask" maskUnits="userSpaceOnUse">
              <rect x="0" y={WATERLINE_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WATERLINE_Y} fill="url(#nc-reflection-fade)" />
            </mask>
          </defs>

          {/* Sky */}
          <rect x="0" y="0" width={SCENE_WIDTH} height={WATERLINE_Y} fill="url(#nc-sky)" />
          <Stars />

          {/* Lighthouse beam (drawn early so ships sit in front) */}
          <Lighthouse dim={sky === "fog"} />

          {/* Distant coastline silhouette */}
          <Coastline />

          {/* Background fleet on the horizon */}
          <HorizonFleet remaining={remaining} y={WATERLINE_Y - 8} maxX={SCENE_WIDTH - LIGHTHOUSE_ZONE} />

          {/* Water */}
          <rect x="0" y={WATERLINE_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WATERLINE_Y} fill="url(#nc-water)" />

          <ChartGrid laneWidth={laneWidth} lanes={topCount} />

          {/* Reflections — flipped silhouettes below water, faded with depth */}
          <g mask="url(#nc-reflection-mask)" aria-hidden="true">
            {geometries.map(({ entry, geom }) => (
              <ShipReflection key={`r-${entry.id}`} entry={entry} geom={geom} />
            ))}
          </g>

          {/* Wave ripples cut across reflections */}
          <WaveRipples />

          {/* Waterline */}
          <line
            className="nc-waterline"
            x1="0"
            y1={WATERLINE_Y}
            x2={SCENE_WIDTH}
            y2={WATERLINE_Y}
            stroke="#0ea5e9"
            strokeWidth={1}
            strokeDasharray="6 8"
            opacity={0.5}
          />

          {/* Ships */}
          {geometries.map(({ entry, geom }) => {
            const selected = entry.id === activeChainId;
            return (
              <g
                key={entry.id}
                role="button"
                tabIndex={0}
                aria-label={`Select ${entry.name} harbor`}
                className="cursor-pointer outline-none"
                onFocus={() => onSelectChain?.(entry.id)}
                onMouseEnter={() => onSelectChain?.(entry.id)}
                onClick={() => onSelectChain?.(entry.id)}
                onKeyDown={(event) => handleShipKeyDown(event, entry.id)}
              >
                <title>
                  {entry.name}: {formatCompactUsd(entry.totalUsd)} docked, {entry.sharePct.toFixed(1)}% of tracked supply
                </title>
                {selected ? (
                  <rect
                    x={geom.deckLeft - 12}
                    y={Math.max(6, geom.mastTopY - 12)}
                    width={geom.hullW + 24}
                    height={Math.min(SCENE_HEIGHT - 12, geom.hullBottom + 42) - Math.max(6, geom.mastTopY - 12)}
                    rx={12}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                    opacity={0.9}
                  />
                ) : null}
                <Ship entry={entry} geom={geom} maxCargoUsd={maxCargoUsd} />
              </g>
            );
          })}

          {/* Ship name labels */}
          {geometries.map(({ entry, geom }) => (
            <text
              key={`label-${entry.id}`}
              x={geom.deckLeft + geom.hullW / 2}
              y={geom.hullBottom + 22}
              textAnchor="middle"
              fontSize={9}
              fontFamily="ui-monospace, Menlo, monospace"
              fill="currentColor"
              opacity={0.62}
            >
              {entry.name}
            </text>
          ))}

          {/* Fog overlay when conditions are bad */}
          {sky === "fog" && <Fog />}
        </svg>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <CompassPlate
          icon={<Anchor className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
          label="Largest port"
          value={model.largestHarbor?.name ?? "n/a"}
          detail={`${model.largestHarbor?.dominantSymbol ?? "n/a"} dominant cargo`}
        />
        <CompassPlate
          icon={<ShipWheel className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
          label="Avg health"
          value={model.averageHealthScore ?? "NR"}
          detail={`${model.harborCount} active chain profiles`}
        />
        <CompassPlate
          icon={<Activity className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
          label="Fragile ports"
          value={model.fragileHarbors}
          detail="fragile or concentrated chains"
        />
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]">
          <p className="pharos-kicker">Health bands</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["robust", "healthy", "mixed", "fragile", "concentrated"] as const).map((band) => (
              <span
                key={band}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                  HEALTH_BADGE_CLASSES[band],
                )}
              >
                {band}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        Source: Chain health snapshot. Harbor size is supply distribution, not issuer redemption capacity.
      </p>
    </section>
  );
}
