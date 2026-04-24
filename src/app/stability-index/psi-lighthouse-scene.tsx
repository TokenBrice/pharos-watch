"use client";

import { useId } from "react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { PSI_HEX_COLORS, PSI_PULSE_DURATION, type ConditionBand } from "@shared/lib/psi-colors";
import "./psi-lighthouse-scene.css";

const WIDTH = 280;
const HEIGHT = 220;
const WATERLINE_Y = 180;
const LH_X = 180;
const ROCK_TOP = WATERLINE_Y - 14; // 166
const T1_BOTTOM = ROCK_TOP - 4; // 162
const T1_TOP = T1_BOTTOM - 64; // 98
const T1_HALF_BOTTOM = 26;
const T1_HALF_TOP = 22;
const T2_BOTTOM = T1_TOP - 1; // 97
const T2_TOP = T2_BOTTOM - 36; // 61
const T2_HALF_BOTTOM = 17;
const T2_HALF_TOP = 14;
const T3_BOTTOM = T2_TOP - 1; // 60
const T3_TOP = T3_BOTTOM - 22; // 38
const T3_HALF = 11;
const BRAZIER_BOTTOM = T3_TOP - 1; // 37
const BEAM_Y = BRAZIER_BOTTOM - 4; // 33
const HALO_CY = BRAZIER_BOTTOM - 7; // 30

function scoreDynamics(score: number) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const t = clamped / 100;
  return {
    reach: 0.4 + 0.6 * t,
    beamOpacity: 0.25 + 0.47 * t,
    flameScale: 0.55 + 0.45 * t,
  };
}

function Stars() {
  // Fixed positions, upper half of the 280x220 frame. Some in the upper-left to lift the
  // quadrant when the beam is dim at low scores; rest scattered around.
  const stars: Array<[number, number, number, number]> = [
    [34, 16, 0.8, 0.65],
    [72, 46, 0.7, 0.6],
    [108, 8, 0.9, 0.75],
    [128, 30, 0.6, 0.5],
    [216, 14, 1.0, 0.85],
    [242, 38, 0.7, 0.6],
    [262, 20, 0.8, 0.7],
  ];
  return (
    <g aria-hidden="true">
      {stars.map(([x, y, r, o], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="#f8fafc" opacity={o} />
      ))}
    </g>
  );
}

function Rocks() {
  return (
    <g aria-hidden="true">
      <path
        d={`M ${LH_X - 48} ${WATERLINE_Y + 2} Q ${LH_X - 36} ${ROCK_TOP + 1} ${LH_X - 26} ${ROCK_TOP + 4} Q ${LH_X - 12} ${ROCK_TOP - 6} ${LH_X} ${ROCK_TOP - 2} Q ${LH_X + 14} ${ROCK_TOP + 4} ${LH_X + 30} ${ROCK_TOP} Q ${LH_X + 42} ${WATERLINE_Y} ${LH_X + 54} ${WATERLINE_Y + 2} Z`}
        fill="oklch(0.16 0.022 250)"
        stroke="oklch(0.06 0.018 250)"
        strokeWidth={0.7}
      />
      <path
        d={`M ${LH_X - 30} ${ROCK_TOP + 2} Q ${LH_X - 18} ${ROCK_TOP - 1} ${LH_X - 6} ${ROCK_TOP + 1}`}
        fill="none"
        stroke="oklch(0.34 0.018 250 / 0.7)"
        strokeWidth={0.6}
      />
      <path
        d={`M ${LH_X + 8} ${ROCK_TOP} Q ${LH_X + 22} ${ROCK_TOP - 2} ${LH_X + 32} ${ROCK_TOP + 2}`}
        fill="none"
        stroke="oklch(0.34 0.018 250 / 0.6)"
        strokeWidth={0.6}
      />
    </g>
  );
}

function LighthouseTiers({ stoneFill }: { stoneFill: string }) {
  return (
    <g aria-hidden="true">
      {/* Tier 1 — square base */}
      <path
        d={`M ${LH_X - T1_HALF_BOTTOM} ${T1_BOTTOM} L ${LH_X - T1_HALF_TOP} ${T1_TOP} L ${LH_X + T1_HALF_TOP} ${T1_TOP} L ${LH_X + T1_HALF_BOTTOM} ${T1_BOTTOM} Z`}
        fill={stoneFill}
        stroke="oklch(0.32 0.025 75)"
        strokeWidth={0.7}
      />
      {[14, 28, 42, 56].map((dy) => (
        <line
          key={`t1-${dy}`}
          x1={LH_X - T1_HALF_BOTTOM + (dy / 64) * (T1_HALF_BOTTOM - T1_HALF_TOP) + 1}
          y1={T1_BOTTOM - dy}
          x2={LH_X + T1_HALF_BOTTOM - (dy / 64) * (T1_HALF_BOTTOM - T1_HALF_TOP) - 1}
          y2={T1_BOTTOM - dy}
          stroke="oklch(0.45 0.025 75 / 0.4)"
          strokeWidth={0.35}
        />
      ))}
      <line x1={LH_X - 8} y1={T1_BOTTOM - 4} x2={LH_X - 7.4} y2={T1_TOP + 4} stroke="oklch(0.45 0.025 75 / 0.45)" strokeWidth={0.35} />
      <line x1={LH_X + 8} y1={T1_BOTTOM - 4} x2={LH_X + 7.4} y2={T1_TOP + 4} stroke="oklch(0.45 0.025 75 / 0.45)" strokeWidth={0.35} />
      {/* Door */}
      <path
        d={`M ${LH_X - 4} ${T1_BOTTOM} L ${LH_X - 4} ${T1_BOTTOM - 11} Q ${LH_X - 4} ${T1_BOTTOM - 14} ${LH_X} ${T1_BOTTOM - 14} Q ${LH_X + 4} ${T1_BOTTOM - 14} ${LH_X + 4} ${T1_BOTTOM - 11} L ${LH_X + 4} ${T1_BOTTOM} Z`}
        fill="oklch(0.16 0.022 60)"
        stroke="oklch(0.32 0.025 75 / 0.7)"
        strokeWidth={0.4}
      />
      {[24, 40].map((dy) => (
        <rect
          key={`t1-win-${dy}`}
          x={LH_X - 1.4}
          y={T1_BOTTOM - dy}
          width={2.8}
          height={5}
          fill="oklch(0.94 0.04 75 / 0.7)"
          rx={0.6}
        />
      ))}
      <rect x={LH_X - T1_HALF_TOP - 3} y={T1_TOP - 3} width={(T1_HALF_TOP + 3) * 2} height={3} fill="oklch(0.5 0.03 75 / 0.85)" />

      {/* Tier 2 — octagonal middle */}
      <path
        d={`M ${LH_X - T2_HALF_BOTTOM} ${T2_BOTTOM} L ${LH_X - T2_HALF_TOP} ${T2_TOP} L ${LH_X + T2_HALF_TOP} ${T2_TOP} L ${LH_X + T2_HALF_BOTTOM} ${T2_BOTTOM} Z`}
        fill={stoneFill}
        stroke="oklch(0.32 0.025 75)"
        strokeWidth={0.7}
      />
      <line x1={LH_X - 6.5} y1={T2_BOTTOM - 2} x2={LH_X - 5.5} y2={T2_TOP + 2} stroke="oklch(0.45 0.025 75 / 0.55)" strokeWidth={0.4} />
      <line x1={LH_X + 6.5} y1={T2_BOTTOM - 2} x2={LH_X + 5.5} y2={T2_TOP + 2} stroke="oklch(0.45 0.025 75 / 0.55)" strokeWidth={0.4} />
      <rect x={LH_X - 1.4} y={T2_BOTTOM - 16} width={2.8} height={5} fill="oklch(0.94 0.04 75 / 0.65)" rx={0.5} />
      <rect x={LH_X - T2_HALF_TOP - 2.5} y={T2_TOP - 2.5} width={(T2_HALF_TOP + 2.5) * 2} height={2.5} fill="oklch(0.5 0.03 75 / 0.82)" />

      {/* Tier 3 — cylindrical colonnade */}
      <rect x={LH_X - T3_HALF} y={T3_TOP} width={T3_HALF * 2} height={T3_BOTTOM - T3_TOP} fill="oklch(0.2 0.025 60 / 0.55)" />
      {[-9, -5, -1, 3, 7].map((dx, i) => (
        <rect
          key={`col-${i}`}
          x={LH_X + dx}
          y={T3_TOP + 1.5}
          width={1.6}
          height={T3_BOTTOM - T3_TOP - 3}
          fill={stoneFill}
          stroke="oklch(0.4 0.025 75 / 0.5)"
          strokeWidth={0.25}
        />
      ))}
      <rect x={LH_X - T3_HALF - 1.5} y={T3_TOP} width={(T3_HALF + 1.5) * 2} height={2} fill="oklch(0.5 0.03 75 / 0.88)" />
      <rect x={LH_X - T3_HALF - 1} y={T3_BOTTOM - 1.5} width={(T3_HALF + 1) * 2} height={1.8} fill="oklch(0.5 0.03 75 / 0.78)" />

      {/* Brazier bowl */}
      <path
        d={`M ${LH_X - 8} ${BRAZIER_BOTTOM} Q ${LH_X - 8} ${BRAZIER_BOTTOM + 5} ${LH_X - 4} ${BRAZIER_BOTTOM + 5} L ${LH_X + 4} ${BRAZIER_BOTTOM + 5} Q ${LH_X + 8} ${BRAZIER_BOTTOM + 5} ${LH_X + 8} ${BRAZIER_BOTTOM} Z`}
        fill="oklch(0.18 0.022 50)"
        stroke="oklch(0.5 0.04 60 / 0.85)"
        strokeWidth={0.7}
      />
      <line x1={LH_X - 9} y1={BRAZIER_BOTTOM} x2={LH_X + 9} y2={BRAZIER_BOTTOM} stroke="oklch(0.6 0.05 60)" strokeWidth={1.1} />
    </g>
  );
}

export function PsiLighthouseScene({
  band,
  score,
  className,
}: {
  band: string;
  score: number;
  className?: string;
}) {
  const uid = useId();
  const bandKey = band as ConditionBand;
  const bandColor = PSI_HEX_COLORS[bandKey] ?? "#888";
  const pulseDur = PSI_PULSE_DURATION[bandKey] ?? 3;
  const { reach, beamOpacity, flameScale } = scoreDynamics(score);

  const skyId = `psi-scene-sky-${uid}`;
  const waterId = `psi-scene-water-${uid}`;
  const beamId = `psi-scene-beam-${uid}`;
  const stoneId = `psi-scene-stone-${uid}`;

  // Beam geometry — two wedges sweeping up-and-left from the brazier
  const pFarTopX = LH_X - 260 * reach;
  const pFarTopY = BEAM_Y - 85 * reach;
  const pFarBotX = LH_X - 240 * reach;
  const pFarBotY = BEAM_Y - 15 * reach;
  const sFarTopX = LH_X - 280 * reach;
  const sFarTopY = BEAM_Y - 40 * reach;
  const sFarBotX = LH_X - 200 * reach;
  const sFarBotY = BEAM_Y + 40 * reach;

  const flameGroupTransform = `translate(${LH_X} ${BRAZIER_BOTTOM}) scale(${flameScale}) translate(${-LH_X} ${-BRAZIER_BOTTOM})`;

  const cssVars = {
    "--psi-pulse-dur": `${pulseDur}s`,
  } as CSSProperties;
  const transitionStyle: CSSProperties = { transition: "fill 500ms ease-out, opacity 500ms ease-out" };

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Pharos lighthouse — ${band} ${Math.round(score)}`}
      className={cn("psi-scene block h-auto w-full", className)}
      preserveAspectRatio="xMidYMid meet"
      style={cssVars}
      data-testid="psi-lighthouse-scene"
      data-band={band}
      data-score={Math.round(score)}
    >
      <defs>
        <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.18 0.04 258)" stopOpacity="0.96" />
          <stop offset="55%" stopColor="oklch(0.32 0.05 252)" stopOpacity="0.85" />
          <stop offset="100%" stopColor="oklch(0.5 0.05 245)" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={waterId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.28 0.06 245)" stopOpacity="0.7" />
          <stop offset="50%" stopColor="oklch(0.18 0.05 248)" stopOpacity="0.82" />
          <stop offset="100%" stopColor="oklch(0.1 0.04 250)" stopOpacity="0.92" />
        </linearGradient>
        <linearGradient id={beamId} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor={bandColor} stopOpacity="0.85" />
          <stop offset="100%" stopColor={bandColor} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={stoneId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="oklch(0.92 0.024 78)" stopOpacity="0.96" />
          <stop offset="50%" stopColor="oklch(0.84 0.028 78)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="oklch(0.66 0.03 75)" stopOpacity="0.94" />
        </linearGradient>
      </defs>

      {/* Sky */}
      <rect x="0" y="0" width={WIDTH} height={WATERLINE_Y} fill={`url(#${skyId})`} />
      <rect
        x="0"
        y="0"
        width={WIDTH}
        height={WATERLINE_Y}
        fill={bandColor}
        opacity={0.12}
        style={transitionStyle}
        data-testid="psi-scene-sky-wash"
      />

      <Stars />

      {/* Beam — behind the lighthouse */}
      <g data-testid="psi-scene-beam">
        <path
          d={`M ${LH_X} ${BEAM_Y} L ${sFarTopX} ${sFarTopY} L ${sFarBotX} ${sFarBotY} Z`}
          fill={`url(#${beamId})`}
          opacity={beamOpacity * 0.5}
          data-testid="psi-scene-beam-secondary"
          style={transitionStyle}
        />
        <path
          d={`M ${LH_X} ${BEAM_Y} L ${pFarTopX} ${pFarTopY} L ${pFarBotX} ${pFarBotY} Z`}
          fill={`url(#${beamId})`}
          opacity={beamOpacity}
          data-testid="psi-scene-beam-primary"
          style={transitionStyle}
        />
      </g>

      {/* Water */}
      <rect x="0" y={WATERLINE_Y} width={WIDTH} height={HEIGHT - WATERLINE_Y} fill={`url(#${waterId})`} />
      <rect
        x="0"
        y={WATERLINE_Y}
        width={WIDTH}
        height={HEIGHT - WATERLINE_Y}
        fill={bandColor}
        opacity={0.08}
        style={transitionStyle}
      />

      {/* Waterline */}
      <line
        x1="0"
        y1={WATERLINE_Y}
        x2={WIDTH}
        y2={WATERLINE_Y}
        stroke="#0ea5e9"
        strokeWidth={1}
        strokeDasharray="6 8"
        opacity={0.5}
      />

      <Rocks />
      <LighthouseTiers stoneFill={`url(#${stoneId})`} />

      {/* Halo — breathing pulse + score-driven scale via radius */}
      <g opacity={0.35 * flameScale} style={transitionStyle}>
        <circle
          cx={LH_X}
          cy={HALO_CY}
          r={26 * flameScale}
          fill={bandColor}
          className="psi-scene-halo"
          data-testid="psi-scene-halo"
          style={transitionStyle}
        />
      </g>
      <circle
        cx={LH_X}
        cy={HALO_CY}
        r={14 * flameScale}
        fill={bandColor}
        opacity={0.4 * flameScale}
        style={transitionStyle}
      />

      {/* Flames — scaled by score, flickering via CSS */}
      <g transform={flameGroupTransform} data-testid="psi-scene-flames">
        <path
          className="psi-scene-flame-outer"
          d={`M ${LH_X - 6} ${BRAZIER_BOTTOM - 1} Q ${LH_X - 5} ${BRAZIER_BOTTOM - 9} ${LH_X - 1.5} ${BRAZIER_BOTTOM - 14} Q ${LH_X} ${BRAZIER_BOTTOM - 17} ${LH_X + 1.5} ${BRAZIER_BOTTOM - 14} Q ${LH_X + 5} ${BRAZIER_BOTTOM - 9} ${LH_X + 6} ${BRAZIER_BOTTOM - 1} Z`}
          fill={bandColor}
          opacity={0.75}
          style={transitionStyle}
        />
        <path
          className="psi-scene-flame-mid"
          d={`M ${LH_X - 3.5} ${BRAZIER_BOTTOM - 2} Q ${LH_X - 3} ${BRAZIER_BOTTOM - 8} ${LH_X - 0.8} ${BRAZIER_BOTTOM - 12} Q ${LH_X} ${BRAZIER_BOTTOM - 15} ${LH_X + 0.8} ${BRAZIER_BOTTOM - 12} Q ${LH_X + 3} ${BRAZIER_BOTTOM - 8} ${LH_X + 3.5} ${BRAZIER_BOTTOM - 2} Z`}
          fill={bandColor}
          opacity={0.92}
          style={transitionStyle}
        />
        <path
          d={`M ${LH_X - 1.6} ${BRAZIER_BOTTOM - 3} Q ${LH_X - 1.2} ${BRAZIER_BOTTOM - 7} ${LH_X} ${BRAZIER_BOTTOM - 11} Q ${LH_X + 1.2} ${BRAZIER_BOTTOM - 7} ${LH_X + 1.6} ${BRAZIER_BOTTOM - 3} Z`}
          fill={bandColor}
          style={transitionStyle}
        />
      </g>
    </svg>
  );
}
