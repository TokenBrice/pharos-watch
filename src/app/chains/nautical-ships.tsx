import type { CSSProperties } from "react";
import { HEALTH_HEX_FILL, chainAccentHex } from "@/lib/chain-ui";
import { logosById } from "@/lib/logos";
import type { HealthBand } from "@shared/types/chains";
import { cargoCapacityForHull, depthLayers, wakeLength } from "./nautical-scene-math";
import type { ChainHarborEntry } from "./harbor-map";
import { NAUTICAL_PALETTE, WATERLINE_Y } from "./nautical-constants";
import type { ShipGeometry } from "./nautical-geometry";

type ShipCargoMark = ChainHarborEntry["cargos"][number] & {
  x: number;
  y: number;
  size: number;
  clipId: string;
  logoPath: string | undefined;
};

function healthHex(band: HealthBand | null): string {
  return band ? HEALTH_HEX_FILL[band] : NAUTICAL_PALETTE.unrated;
}

function ShipCargoMarks({
  entryName,
  cargoTitle,
  cargoMarks,
  accentColor,
}: {
  entryName: string;
  cargoTitle: string;
  cargoMarks: ShipCargoMark[];
  accentColor: string;
}) {
  return (
    <g className="nc-ship-secondary-detail" aria-hidden="true">
      <title>
        {entryName} cargo manifest: {cargoTitle}
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
  );
}

function ShipSeal({
  clipId,
  accentColor,
  healthColor,
  logoPath,
  x,
  y,
  size,
}: {
  clipId: string;
  accentColor: string;
  healthColor: string;
  logoPath: string;
  x: number;
  y: number;
  size: number;
}) {
  return (
    <g>
      <defs>
        <clipPath id={clipId}>
          <circle cx={x} cy={y} r={size / 2} />
        </clipPath>
      </defs>
      <circle
        cx={x}
        cy={y}
        r={size / 2 + 1.6}
        fill="oklch(0.98 0.006 250 / 0.94)"
        stroke={accentColor}
        strokeWidth={1.1}
      />
      <circle cx={x} cy={y} r={size / 2 + 4.5} fill="none" stroke={healthColor} strokeWidth={0.9} opacity={0.6} />
      <image
        href={logoPath}
        x={x - size / 2}
        y={y - size / 2}
        width={size}
        height={size}
        clipPath={`url(#${clipId})`}
      />
    </g>
  );
}

export function Ship({
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
    hullTop,
    hullBottom,
    hullMidY,
    keelY,
    deckLeft,
    deckRight,
    sternInset,
    bowRise,
    railY,
    mainMastX,
    foreMastX,
    aftMastX,
    mastTopY,
    foreTopY,
    aftTopY,
    rigScale,
    hullDepth,
    hullW,
    flagWidth,
    logoSize,
    sailSealY,
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
    const x = cargoManifest.length > 1 ? cargoTrackStart + i * cargoGap : deckLeft + hullW / 2;
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
  const cargoTitle = cargoManifest.map((cargo) => `${cargo.symbol} ${cargo.sharePct.toFixed(0)}%`).join(", ");

  return (
    <g>
      {wake !== 0 && (
        <path
          d={
            wake > 0
              ? `M ${deckRight + 3} ${hullBottom - 3} q ${wake * 26} -3 ${wake * 60} 1`
              : `M ${deckLeft - 3} ${hullBottom - 3} q ${wake * 26} -3 ${wake * 60} 1`
          }
          stroke={wake > 0 ? NAUTICAL_PALETTE.wakePositive : NAUTICAL_PALETTE.wakeNegative}
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
      <line
        x1={mainMastX}
        y1={mastTopY}
        x2={mainMastX}
        y2={hullBottom - 3}
        stroke="oklch(0.82 0.05 72 / 0.78)"
        strokeWidth={1.8}
      />
      <line
        x1={foreMastX}
        y1={foreTopY}
        x2={foreMastX}
        y2={hullTop + 2}
        stroke="oklch(0.82 0.05 72 / 0.68)"
        strokeWidth={1.4}
      />
      <line
        x1={aftMastX}
        y1={aftTopY}
        x2={aftMastX}
        y2={hullTop + 3}
        stroke="oklch(0.82 0.05 72 / 0.6)"
        strokeWidth={1.2}
      />

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
      <path
        d={`M ${mainMastX} ${mastTopY + 4} Q ${deckLeft + sternInset + 2} ${railY - 2} ${deckLeft + sternInset} ${hullTop + 2}`}
        fill="none"
        stroke="oklch(0.97 0.008 75 / 0.32)"
        strokeWidth={0.55}
      />
      <path
        d={`M ${mainMastX} ${mastTopY + 4} Q ${deckRight - bowRise + 5} ${railY - 3} ${deckRight + 12} ${railY - 20}`}
        fill="none"
        stroke="oklch(0.97 0.008 75 / 0.32)"
        strokeWidth={0.55}
      />
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
      <ShipCargoMarks
        entryName={entry.name}
        cargoTitle={cargoTitle}
        cargoMarks={cargoMarks}
        accentColor={accentColor}
      />

      {/* Crow's nest yard */}
      <line
        x1={mainMastX - 11}
        y1={mastTopY + 8}
        x2={mainMastX + 22}
        y2={mastTopY + 5}
        stroke={accentColor}
        strokeWidth={2.2}
        strokeLinecap="round"
      />

      {/* Pennant — proper triangular flag with notched tail */}
      <path
        className="nc-flag"
        d={`M ${mainMastX + 2} ${mastTopY - 6} h ${flagWidth} l -7 5 l 7 5 h -${flagWidth} Z`}
        fill={accentColor}
        opacity={0.94}
      />

      <ShipSeal
        clipId={clipId}
        accentColor={accentColor}
        healthColor={healthColor}
        logoPath={entry.logoPath}
        x={mainMastX}
        y={sailSealY}
        size={logoSize}
      />

      {/* Depth ticks below hull */}
      <g className="nc-ship-secondary-detail">
        {Array.from({ length: layers }).map((_, i) => {
          const offset = 4 + i * 3;
          return (
            <line
              key={i}
              x1={deckLeft + 4 + i * 2}
              y1={hullBottom + offset}
              x2={deckRight - 4 - i * 2}
              y2={hullBottom + offset}
              stroke={NAUTICAL_PALETTE.depthTick}
              strokeWidth={0.75}
              opacity={0.34 - i * 0.07}
            />
          );
        })}
      </g>
    </g>
  );
}

export function ShipReflection({ entry, geom, index }: { entry: ChainHarborEntry; geom: ShipGeometry; index: number }) {
  const accentColor = chainAccentHex(entry.id);
  const {
    hullTop,
    hullBottom,
    hullMidY,
    deckLeft,
    deckRight,
    sternInset,
    bowRise,
    railY,
    mainMastX,
    foreMastX,
    aftMastX,
    mastTopY,
    foreTopY,
    aftTopY,
    rigScale,
    hullW,
    sailSealY,
    logoSize,
  } = geom;
  return (
    <g transform={`translate(0, ${2 * WATERLINE_Y}) scale(1, -1)`}>
      <g className="nc-reflection-drift" style={{ "--nc-reflection-delay": `${index * -0.55}s` } as CSSProperties}>
        {/* Mast silhouettes — faint */}
        <line
          x1={mainMastX}
          y1={mastTopY}
          x2={mainMastX}
          y2={hullBottom - 3}
          stroke="oklch(0.4 0.04 250 / 0.45)"
          strokeWidth={1.2}
        />
        <line
          x1={foreMastX}
          y1={foreTopY}
          x2={foreMastX}
          y2={hullTop + 2}
          stroke="oklch(0.4 0.04 250 / 0.4)"
          strokeWidth={1}
        />
        <line
          x1={aftMastX}
          y1={aftTopY}
          x2={aftMastX}
          y2={hullTop + 3}
          stroke="oklch(0.4 0.04 250 / 0.35)"
          strokeWidth={0.9}
        />

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
        <circle
          cx={mainMastX}
          cy={sailSealY}
          r={logoSize / 2 + 1}
          fill="oklch(0.7 0.02 248 / 0.35)"
          stroke={accentColor}
          strokeWidth={0.5}
          opacity={0.5}
        />
      </g>
    </g>
  );
}

export function HarborLight({ geom }: { geom: ShipGeometry }) {
  const centerX = geom.deckLeft + geom.hullW / 2;
  const sailTopY = Math.max(8, geom.mastTopY - 10);
  const lightStartX = centerX + geom.hullW * 0.38;
  const lightEndX = centerX - geom.hullW * 0.5;
  const lightStartY = geom.mastTopY + 18;
  const lightEndY = geom.hullBottom + 2;
  const rippleWidth = Math.max(36, geom.hullW * 0.54);

  return (
    <g className="nc-harbor-light" data-testid="nc-harbor-light" aria-hidden="true">
      <path
        className="nc-harbor-light-ray"
        d={`M ${lightStartX} ${lightStartY} C ${centerX + geom.hullW * 0.12} ${lightStartY + 22}, ${centerX - geom.hullW * 0.2} ${lightEndY - 24}, ${lightEndX} ${lightEndY}`}
        fill="none"
        stroke={NAUTICAL_PALETTE.beam}
        strokeWidth={2.1}
        strokeLinecap="round"
        opacity={0.54}
      />
      <path
        className="nc-harbor-light-ray nc-harbor-light-ray-soft"
        d={`M ${lightStartX + 7} ${lightStartY + 10} C ${centerX + geom.hullW * 0.15} ${lightStartY + 30}, ${centerX - geom.hullW * 0.1} ${lightEndY - 16}, ${lightEndX + 18} ${lightEndY + 4}`}
        fill="none"
        stroke={NAUTICAL_PALETTE.beam}
        strokeWidth={1.2}
        strokeLinecap="round"
        opacity={0.28}
      />
      <ellipse
        className="nc-harbor-light-water"
        cx={centerX}
        cy={WATERLINE_Y + 5}
        rx={rippleWidth}
        ry={4.4}
        fill={NAUTICAL_PALETTE.beam}
        opacity={0.2}
      />
      <path
        className="nc-harbor-light-water-line"
        d={`M ${centerX - rippleWidth * 0.58} ${WATERLINE_Y + 12} Q ${centerX} ${WATERLINE_Y + 7} ${centerX + rippleWidth * 0.58} ${WATERLINE_Y + 12}`}
        fill="none"
        stroke={NAUTICAL_PALETTE.beam}
        strokeWidth={0.9}
        strokeLinecap="round"
        opacity={0.32}
      />
      <circle
        className="nc-harbor-light-glint"
        cx={centerX}
        cy={sailTopY}
        r={2.4}
        fill={NAUTICAL_PALETTE.glint}
        opacity={0.9}
      />
    </g>
  );
}
