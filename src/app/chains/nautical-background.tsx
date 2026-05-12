import type { CSSProperties } from "react";
import type { ChainSummary } from "@shared/types/chains";
import { NAUTICAL_PALETTE, PIER_X, SCENE_HEIGHT, SCENE_WIDTH, WATERLINE_Y } from "./nautical-constants";

export function Lighthouse({ dim, targetX, targetY }: { dim: boolean; targetX: number; targetY: number }) {
  // Pharos of Alexandria: square base → octagonal middle → cylindrical top, crowned with a fire brazier.
  // Built of pale limestone, ~140 m tall in antiquity. Here, three tapering tiers in stone, no candy stripes.
  const baseX = SCENE_WIDTH - 110;
  const waterline = WATERLINE_Y;
  const rockTop = waterline - 18;

  // Tier 1: square base
  const t1Bottom = rockTop + 4;
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
  const beamAngle = Math.atan2(targetY - beamY, targetX - baseX) * (180 / Math.PI) - 180;
  const beamStyle = {
    "--nc-beam-origin-x": `${baseX}px`,
    "--nc-beam-origin-y": `${beamY}px`,
    "--nc-beam-angle": `${beamAngle}deg`,
  } as CSSProperties;

  return (
    <g aria-hidden="true">
      {/* Beam — sweeping left across the harbor from the brazier */}
      <g className="nc-lighthouse-beam" style={beamStyle} data-testid="nc-lighthouse-beam">
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
        d={`M ${baseX - 58} ${waterline + 13} Q ${baseX - 42} ${rockTop + 8} ${baseX - 29} ${rockTop + 6} Q ${baseX - 15} ${rockTop - 7} ${baseX - 1} ${rockTop - 4} Q ${baseX + 15} ${rockTop - 1} ${baseX + 31} ${rockTop + 5} Q ${baseX + 47} ${rockTop + 9} ${baseX + 63} ${waterline + 13} Z`}
        fill="oklch(0.11 0.026 248)"
        opacity={0.92}
      />
      <path
        d={`M ${baseX - 50} ${waterline + 2} Q ${baseX - 38} ${rockTop + 1} ${baseX - 28} ${rockTop + 4} Q ${baseX - 14} ${rockTop - 6} ${baseX - 2} ${rockTop - 2} Q ${baseX + 12} ${rockTop + 4} ${baseX + 28} ${rockTop} Q ${baseX + 40} ${waterline} ${baseX + 52} ${waterline + 2} Z`}
        fill="oklch(0.16 0.022 250)"
        stroke="oklch(0.06 0.018 250)"
        strokeWidth={0.7}
      />
      <path
        d={`M ${baseX - 31} ${t1Bottom + 1} Q ${baseX - 12} ${t1Bottom - 7} ${baseX + 7} ${t1Bottom - 4} Q ${baseX + 25} ${t1Bottom - 2} ${baseX + 39} ${t1Bottom + 4} L ${baseX + 42} ${waterline + 1} L ${baseX - 37} ${waterline + 1} Z`}
        fill="oklch(0.09 0.022 248)"
        opacity={0.78}
      />
      <path
        d={`M ${baseX - 32} ${rockTop + 2} Q ${baseX - 20} ${rockTop - 1} ${baseX - 8} ${rockTop + 1}`}
        fill="none"
        stroke="oklch(0.34 0.018 250 / 0.7)"
        strokeWidth={0.6}
      />
      <path
        d={`M ${baseX + 6} ${rockTop} Q ${baseX + 20} ${rockTop - 2} ${baseX + 30} ${rockTop + 2}`}
        fill="none"
        stroke="oklch(0.34 0.018 250 / 0.6)"
        strokeWidth={0.6}
      />
      <path
        d={`M ${baseX - 55} ${waterline} C ${baseX - 36} ${waterline + 2} ${baseX - 13} ${waterline + 2} ${baseX + 4} ${waterline - 1} S ${baseX + 38} ${waterline - 2} ${baseX + 60} ${waterline + 1}`}
        fill="none"
        stroke="oklch(0.66 0.08 205 / 0.32)"
        strokeWidth={1.1}
        strokeLinecap="round"
      />

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
      <line
        x1={baseX - 8}
        y1={t1Bottom - 4}
        x2={baseX - 7.4}
        y2={t1Top + 4}
        stroke="oklch(0.45 0.025 75 / 0.45)"
        strokeWidth={0.35}
      />
      <line
        x1={baseX + 8}
        y1={t1Bottom - 4}
        x2={baseX + 7.4}
        y2={t1Top + 4}
        stroke="oklch(0.45 0.025 75 / 0.45)"
        strokeWidth={0.35}
      />
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
      <rect
        x={baseX - t1HalfTop - 3}
        y={t1Top - 3}
        width={(t1HalfTop + 3) * 2}
        height={3}
        fill="oklch(0.5 0.03 75 / 0.85)"
      />

      {/* Tier 2 — octagonal middle */}
      <path
        d={`M ${baseX - t2HalfBottom} ${t2Bottom} L ${baseX - t2HalfTop} ${t2Top} L ${baseX + t2HalfTop} ${t2Top} L ${baseX + t2HalfBottom} ${t2Bottom} Z`}
        fill="url(#nc-stone)"
        stroke="oklch(0.32 0.025 75)"
        strokeWidth={0.7}
      />
      {/* Octagonal facet hints — vertical seams */}
      <line
        x1={baseX - 6.5}
        y1={t2Bottom - 2}
        x2={baseX - 5.5}
        y2={t2Top + 2}
        stroke="oklch(0.45 0.025 75 / 0.55)"
        strokeWidth={0.4}
      />
      <line
        x1={baseX + 6.5}
        y1={t2Bottom - 2}
        x2={baseX + 5.5}
        y2={t2Top + 2}
        stroke="oklch(0.45 0.025 75 / 0.55)"
        strokeWidth={0.4}
      />
      {/* Single window high on the facet */}
      <rect x={baseX - 1.4} y={t2Bottom - 16} width={2.8} height={5} fill="oklch(0.94 0.04 75 / 0.65)" rx={0.5} />
      {/* Cornice */}
      <rect
        x={baseX - t2HalfTop - 2.5}
        y={t2Top - 2.5}
        width={(t2HalfTop + 2.5) * 2}
        height={2.5}
        fill="oklch(0.5 0.03 75 / 0.82)"
      />

      {/* Tier 3 — cylindrical lantern with open colonnade */}
      <rect
        x={baseX - t3Half}
        y={t3Top}
        width={t3Half * 2}
        height={t3Bottom - t3Top}
        fill="oklch(0.2 0.025 60 / 0.55)"
      />
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
      <rect
        x={baseX - t3Half - 1}
        y={t3Bottom - 1.5}
        width={(t3Half + 1) * 2}
        height={1.8}
        fill="oklch(0.5 0.03 75 / 0.78)"
      />

      {/* Brazier — open fire bowl */}
      <path
        d={`M ${baseX - 8} ${brazierBottom} Q ${baseX - 8} ${brazierBottom + 5} ${baseX - 4} ${brazierBottom + 5} L ${baseX + 4} ${brazierBottom + 5} Q ${baseX + 8} ${brazierBottom + 5} ${baseX + 8} ${brazierBottom} Z`}
        fill="oklch(0.18 0.022 50)"
        stroke="oklch(0.5 0.04 60 / 0.85)"
        strokeWidth={0.7}
      />
      <line
        x1={baseX - 9}
        y1={brazierBottom}
        x2={baseX + 9}
        y2={brazierBottom}
        stroke="oklch(0.6 0.05 60)"
        strokeWidth={1.1}
      />

      {/* Halo glow behind flames */}
      <circle
        cx={baseX}
        cy={brazierBottom - 7}
        r={26}
        fill={NAUTICAL_PALETTE.flameOuter}
        opacity={dim ? 0.08 : 0.16}
        className="nc-lighthouse-pulse"
      />
      <circle cx={baseX} cy={brazierBottom - 7} r={14} fill={NAUTICAL_PALETTE.beam} opacity={dim ? 0.22 : 0.4} />

      {/* Flames — three stacked layers, outer to core */}
      <path
        className="nc-flame-outer"
        d={`M ${baseX - 6} ${brazierBottom - 1} Q ${baseX - 5} ${brazierBottom - 9} ${baseX - 1.5} ${brazierBottom - 14} Q ${baseX} ${brazierBottom - 17} ${baseX + 1.5} ${brazierBottom - 14} Q ${baseX + 5} ${brazierBottom - 9} ${baseX + 6} ${brazierBottom - 1} Z`}
        fill={NAUTICAL_PALETTE.flameOuter}
        opacity={flameOpacity * 0.85}
      />
      <path
        className="nc-flame-mid"
        d={`M ${baseX - 3.5} ${brazierBottom - 2} Q ${baseX - 3} ${brazierBottom - 8} ${baseX - 0.8} ${brazierBottom - 12} Q ${baseX} ${brazierBottom - 15} ${baseX + 0.8} ${brazierBottom - 12} Q ${baseX + 3} ${brazierBottom - 8} ${baseX + 3.5} ${brazierBottom - 2} Z`}
        fill={NAUTICAL_PALETTE.flameMid}
        opacity={flameOpacity * 0.95}
      />
      <path
        d={`M ${baseX - 1.6} ${brazierBottom - 3} Q ${baseX - 1.2} ${brazierBottom - 7} ${baseX} ${brazierBottom - 11} Q ${baseX + 1.2} ${brazierBottom - 7} ${baseX + 1.6} ${brazierBottom - 3} Z`}
        fill={NAUTICAL_PALETTE.flameCore}
        opacity={flameOpacity}
      />

      {/* Foreground rock lip seats the tower into the promontory. */}
      <path
        d={`M ${baseX - 34} ${t1Bottom - 1} Q ${baseX - 17} ${t1Bottom - 7} ${baseX - 1} ${t1Bottom - 5} Q ${baseX + 16} ${t1Bottom - 7} ${baseX + 34} ${t1Bottom - 1} L ${baseX + 42} ${waterline + 1} Q ${baseX + 16} ${waterline - 5} ${baseX - 39} ${waterline + 1} Z`}
        fill="oklch(0.07 0.022 248)"
        opacity={0.95}
      />
      <path
        d={`M ${baseX - 38} ${t1Bottom + 1} C ${baseX - 18} ${t1Bottom - 3} ${baseX + 9} ${t1Bottom - 4} ${baseX + 36} ${t1Bottom + 2}`}
        fill="none"
        stroke="oklch(0.32 0.026 210 / 0.36)"
        strokeWidth={0.65}
        strokeLinecap="round"
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

export function Coastline() {
  const y = WATERLINE_Y;
  const path = `M -10 ${y} L 60 ${y - 5} L 110 ${y - 8} L 160 ${y - 6} L 220 ${y - 11} L 280 ${y - 7} L 340 ${y - 13} L 400 ${y - 9} L 460 ${y - 14} L 520 ${y - 8} L 580 ${y - 12} L 650 ${y - 6} L 720 ${y - 10} L 790 ${y - 7} L 860 ${y - 13} L 930 ${y - 8} L 1010 ${y - 11} L 1090 ${y - 6} L 1160 ${y - 9} L 1210 ${y} Z`;
  return (
    <g aria-hidden="true">
      <path d={path} fill="oklch(0.2 0.022 248)" opacity={0.55} />
      <path d={path} fill="none" stroke="oklch(0.36 0.025 248 / 0.5)" strokeWidth={0.6} />
    </g>
  );
}

export function Stars() {
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
        <circle key={i} cx={x} cy={y} r={r} fill={NAUTICAL_PALETTE.star} opacity={o} />
      ))}
      {/* Twin-star "eye" — Pharos watching */}
      <circle cx={245} cy={50} r={2.2} fill={NAUTICAL_PALETTE.star} opacity={0.95} />
      <circle cx={245} cy={50} r={4} fill="none" stroke={NAUTICAL_PALETTE.star} strokeWidth={0.4} opacity={0.4} />
    </g>
  );
}

export function WaveRipples() {
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
          stroke={NAUTICAL_PALETTE.ripple}
          strokeWidth={0.7}
          strokeDasharray={dash}
          strokeLinecap="round"
          opacity={opacity}
        />
      ))}
    </g>
  );
}

export function Fog() {
  return (
    <g aria-hidden="true">
      {[36, 58, 80, 102].map((y, i) => (
        <line
          key={y}
          x1={SCENE_WIDTH - 320}
          y1={y}
          x2={SCENE_WIDTH - 20}
          y2={y}
          stroke={NAUTICAL_PALETTE.fog}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeDasharray={i === 1 ? "32 10" : i === 2 ? "20 8" : "14 6"}
          opacity={0.45 - i * 0.07}
        />
      ))}
    </g>
  );
}

export function ChartGrid({ laneWidth, lanes }: { laneWidth: number; lanes: number }) {
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
            stroke={NAUTICAL_PALETTE.depthLine}
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

export function HorizonFleet({
  remaining,
  y,
  maxX,
  totalUsd,
}: {
  remaining: readonly ChainSummary[];
  y: number;
  maxX: number;
  totalUsd: number;
}) {
  if (remaining.length === 0) return null;
  const visible = remaining.slice(0, 8);
  const spacing = 18;
  const baseX = maxX - visible.length * spacing - 30;
  const remainingSupplyUsd = remaining.reduce((sum, chain) => sum + chain.totalUsd, 0);
  const remainingSharePct = totalUsd > 0 ? (remainingSupplyUsd / totalUsd) * 100 : 0;
  return (
    <g opacity={0.5}>
      {visible.map((c, i) => (
        <path
          key={c.id}
          d={`M ${baseX + i * spacing} ${y + 4} h 14 l -3 3 h -9 Z`}
          fill={NAUTICAL_PALETTE.distantFleet}
          opacity={0.7}
        >
          <title>{c.name}</title>
        </path>
      ))}
      <text
        x={baseX + visible.length * spacing + 8}
        y={y + 9}
        fontSize={7.5}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="currentColor"
        opacity={0.5}
      >
        {remaining.length} more · {remainingSharePct.toFixed(1)}%
      </text>
    </g>
  );
}

export function NauticalDefs() {
  return (
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
        <stop offset="0%" stopColor={NAUTICAL_PALETTE.beam} stopOpacity="0.55" />
        <stop offset="100%" stopColor={NAUTICAL_PALETTE.beam} stopOpacity="0" />
      </linearGradient>
      <linearGradient id="nc-stone" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="oklch(0.92 0.024 78)" stopOpacity="0.96" />
        <stop offset="50%" stopColor="oklch(0.84 0.028 78)" stopOpacity="0.95" />
        <stop offset="100%" stopColor="oklch(0.66 0.03 75)" stopOpacity="0.94" />
      </linearGradient>
      <linearGradient id="nc-sail-cloth" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={NAUTICAL_PALETTE.sailStart} stopOpacity="0.96" />
        <stop offset="58%" stopColor={NAUTICAL_PALETTE.sailMid} stopOpacity="0.82" />
        <stop offset="100%" stopColor={NAUTICAL_PALETTE.sailEnd} stopOpacity="0.58" />
      </linearGradient>
      <linearGradient id="nc-hull-wood" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={NAUTICAL_PALETTE.hullTop} stopOpacity="0.98" />
        <stop offset="58%" stopColor={NAUTICAL_PALETTE.hullMid} stopOpacity="0.96" />
        <stop offset="100%" stopColor={NAUTICAL_PALETTE.hullBottom} stopOpacity="0.98" />
      </linearGradient>
      <linearGradient id="nc-reflection-fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={NAUTICAL_PALETTE.reflectionMask} stopOpacity="0.5" />
        <stop offset="35%" stopColor={NAUTICAL_PALETTE.reflectionMask} stopOpacity="0.3" />
        <stop offset="100%" stopColor={NAUTICAL_PALETTE.reflectionMask} stopOpacity="0" />
      </linearGradient>
      <mask id="nc-reflection-mask" maskUnits="userSpaceOnUse">
        <rect
          x="0"
          y={WATERLINE_Y}
          width={SCENE_WIDTH}
          height={SCENE_HEIGHT - WATERLINE_Y}
          fill="url(#nc-reflection-fade)"
        />
      </mask>
    </defs>
  );
}

export function Waterline() {
  return (
    <line
      className="nc-waterline"
      x1="0"
      y1={WATERLINE_Y}
      x2={SCENE_WIDTH}
      y2={WATERLINE_Y}
      stroke={NAUTICAL_PALETTE.waterline}
      strokeWidth={1}
      strokeDasharray="6 8"
      opacity={0.5}
    />
  );
}
