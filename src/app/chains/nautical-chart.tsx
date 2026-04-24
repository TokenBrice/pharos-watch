"use client";

import { Anchor, Activity, ShipWheel } from "lucide-react";
import type { ChainSummary } from "@shared/types/chains";
import { HEALTH_BADGE_CLASSES, HEALTH_HEX_FILL } from "@/lib/chain-ui";
import type { HealthBand } from "@shared/types/chains";
import { cn } from "@/lib/utils";
import { buildChainHarborModel, type ChainHarborEntry } from "./harbor-map";
import { hullWidth, cargoBuckets, depthLayers, wakeLength, aggregateSkyBand } from "./nautical-scene-math";
import { HarborList } from "./harbor-list";
import "./nautical-chart.css";

const SCENE_WIDTH = 1200;
const SCENE_HEIGHT = 260;
const WATERLINE_Y = 150;
const PIER_X = 58;

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

function RangeLight() {
  const cx = SCENE_WIDTH - 104;
  const cy = 54;
  return (
    <g className="nc-range-light" aria-hidden="true">
      <path
        d={`M ${cx - 12} ${cy} L ${cx - 132} ${cy - 30} L ${cx - 132} ${cy + 30} Z`}
        fill="url(#nc-range-beam)"
        opacity={0.72}
      />
      <circle cx={cx} cy={cy} r={13} fill="#fde68a" opacity={0.88} />
      <circle cx={cx} cy={cy} r={20} fill="none" stroke="#fde68a" strokeWidth={1} opacity={0.32} />
      <line x1={cx - 18} y1={cy} x2={cx + 18} y2={cy} stroke="#fde68a" strokeWidth={1} opacity={0.5} />
      <line x1={cx} y1={cy - 18} x2={cx} y2={cy + 18} stroke="#fde68a" strokeWidth={1} opacity={0.5} />
    </g>
  );
}

function Fog() {
  return (
    <g aria-hidden="true">
      {[30, 50, 70].map((y, i) => (
        <line
          key={y}
          x1={SCENE_WIDTH - 180}
          y1={y}
          x2={SCENE_WIDTH - 20}
          y2={y}
          stroke="#cbd5e1"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={i === 1 ? "24 8" : "12 6"}
          opacity={0.6 - i * 0.12}
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
      {[40, 80, 120].map((y) => (
        <line
          key={`sky-${y}`}
          x1={startX}
          y1={y}
          x2={endX}
          y2={y}
          stroke="currentColor"
          strokeWidth={0.65}
          strokeDasharray="2 8"
          opacity={0.09}
        />
      ))}
      {[172, 194, 216, 238].map((y, i) => (
        <line
          key={`depth-${y}`}
          x1={startX}
          y1={y}
          x2={endX}
          y2={y}
          stroke="#38bdf8"
          strokeWidth={0.75}
          strokeDasharray={i % 2 === 0 ? "7 9" : "2 10"}
          opacity={0.18}
        />
      ))}
      {Array.from({ length: lanes + 1 }).map((_, i) => {
        const x = PIER_X + i * laneWidth;
        return (
          <line
            key={`berth-${i}`}
            x1={x}
            y1={WATERLINE_Y - 34}
            x2={x}
            y2={SCENE_HEIGHT - 18}
            stroke="currentColor"
            strokeWidth={0.55}
            opacity={0.08}
          />
        );
      })}
      <text
        x={startX}
        y={SCENE_HEIGHT - 18}
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
  laneY,
  x,
  hullW,
  rank,
  supplyScale,
}: {
  entry: ChainHarborEntry;
  laneY: number;
  x: number;
  hullW: number;
  rank: number;
  supplyScale: number;
}) {
  const healthColor = healthHex(entry.healthBand);
  const accentColor = chainAccentHex(entry.id);
  const cargo = cargoBuckets(entry.stablecoinCount);
  const layers = depthLayers(entry.sharePct / 100);
  const wake = wakeLength(entry.change7dPct);
  const rigScale = 0.58 + supplyScale * 0.6;
  const hullDepth = 14 + supplyScale * 11;
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
  const mastTopY = hullTop - 68 * rigScale;
  const foreTopY = hullTop - 49 * rigScale;
  const aftTopY = hullTop - 43 * rigScale;
  const railY = hullTop - 3;
  const cargoStart = deckLeft + sternInset + 7;
  const cargoSpan = Math.max(10, hullW - sternInset - bowRise - 18);
  const cargoGap = cargo > 1 ? Math.min(12, cargoSpan / (cargo - 1)) : 0;
  const flagWidth = Math.max(12, Math.min(42, (entry.dominantSharePct / 100) * 42)) * (0.84 + supplyScale * 0.22);
  const logoSize = 12 + supplyScale * 6;
  const portholeRadius = 1.7 + supplyScale * 0.9;
  const sailSealY = hullTop - 14 - supplyScale * 5;
  const clipId = `nc-logo-${entry.id.replace(/[^a-z0-9-]/gi, "-")}`;

  return (
    <g>
      {wake !== 0 && (
        <path
          d={
            wake > 0
              ? `M ${deckRight + 3} ${hullBottom - 3} q ${wake * 24} -3 ${wake * 52} 1`
              : `M ${deckLeft - 3} ${hullBottom - 3} q ${wake * 24} -3 ${wake * 52} 1`
          }
          stroke={wake > 0 ? "#10b981" : "#ef4444"}
          strokeWidth={1}
          strokeDasharray="2 5"
          fill="none"
          opacity={0.5}
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
        d={`M ${mainMastX + 2} ${mastTopY + 3 * rigScale} C ${mainMastX + hullW * 0.28} ${mastTopY + 12 * rigScale}, ${mainMastX + hullW * 0.33} ${railY - 14 * rigScale}, ${mainMastX + 3} ${railY - 2} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.9}
        opacity={0.98}
      />
      <path
        className="nc-sail"
        d={`M ${mainMastX - 2} ${mastTopY + 12 * rigScale} C ${mainMastX - hullW * 0.32} ${mastTopY + 19 * rigScale}, ${mainMastX - hullW * 0.35} ${railY - 10 * rigScale}, ${mainMastX - 2} ${railY - 1} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.75}
        opacity={0.9}
      />
      <path
        d={`M ${foreMastX + 1} ${foreTopY + 5 * rigScale} C ${foreMastX + hullW * 0.21} ${foreTopY + 10 * rigScale}, ${foreMastX + hullW * 0.24} ${railY - 9 * rigScale}, ${foreMastX + 1} ${railY - 1} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.65}
        opacity={0.78}
      />
      <path
        d={`M ${aftMastX - 1} ${aftTopY + 6 * rigScale} C ${aftMastX + hullW * 0.18} ${aftTopY + 12 * rigScale}, ${aftMastX + hullW * 0.14} ${railY - 7 * rigScale}, ${aftMastX - 1} ${railY - 1} Z`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.65}
        opacity={0.7}
      />
      <path
        d={`M ${deckRight - bowRise + 2} ${railY} Q ${deckRight + 10} ${railY - 8} ${deckRight + 16} ${railY - 25} Q ${deckRight + 6} ${railY - 16} ${deckRight - bowRise - 4} ${railY}`}
        fill="url(#nc-sail-cloth)"
        stroke={accentColor}
        strokeWidth={0.6}
        opacity={0.72}
      />
      <path
        d={`M ${mainMastX} ${mastTopY + 4} Q ${deckLeft + sternInset + 2} ${railY - 2} ${deckLeft + sternInset} ${hullTop + 2}`}
        fill="none"
        stroke="oklch(0.97 0.008 75 / 0.32)"
        strokeWidth={0.55}
      />
      <path
        d={`M ${mainMastX} ${mastTopY + 4} Q ${deckRight - bowRise + 5} ${railY - 3} ${deckRight + 10} ${railY - 18}`}
        fill="none"
        stroke="oklch(0.97 0.008 75 / 0.32)"
        strokeWidth={0.55}
      />
      {[0.22, 0.5, 0.78].map((t) => (
        <path
          key={t}
          d={`M ${mainMastX + hullW * 0.02} ${mastTopY + (8 + t * 45) * rigScale} C ${mainMastX + hullW * 0.1} ${mastTopY + (12 + t * 45) * rigScale}, ${mainMastX + hullW * 0.16} ${mastTopY + (13 + t * 45) * rigScale}, ${mainMastX + hullW * 0.23} ${mastTopY + (10 + t * 45) * rigScale}`}
          fill="none"
          stroke={accentColor}
          strokeWidth={0.55}
          opacity={0.34}
        />
      ))}
      <path
        d={`M ${deckLeft + sternInset} ${railY} L ${deckRight - bowRise} ${railY} Q ${deckRight - 2} ${railY + 5} ${deckRight} ${hullMidY} Q ${deckRight - bowRise * 0.7} ${hullBottom + 3} ${deckLeft + sternInset + 9} ${hullBottom + 1} Q ${deckLeft - 3} ${hullBottom - 2} ${deckLeft} ${hullMidY} Q ${deckLeft + 3} ${hullTop + 3} ${deckLeft + sternInset} ${railY} Z`}
        fill="url(#nc-hull-wood)"
        stroke="oklch(0.08 0.018 55 / 0.82)"
        strokeWidth={1.2}
      />
      <path
        d={`M ${deckLeft + sternInset + 2} ${hullTop + 5} L ${deckRight - bowRise - 3} ${hullTop + 4}`}
        stroke={accentColor}
        strokeWidth={2.2}
        strokeLinecap="round"
        opacity={0.86}
      />
      <path
        d={`M ${deckLeft + sternInset + 4} ${hullTop + 13} C ${deckLeft + hullW * 0.38} ${hullTop + 17}, ${deckLeft + hullW * 0.68} ${hullTop + 16}, ${deckRight - bowRise * 0.65} ${hullTop + 11}`}
        stroke="oklch(0.04 0.014 45 / 0.45)"
        strokeWidth={1.1}
        fill="none"
      />
      <path
        d={`M ${deckLeft + sternInset + 8} ${keelY} C ${deckLeft + hullW * 0.42} ${keelY + 3}, ${deckLeft + hullW * 0.7} ${keelY + 2}, ${deckRight - bowRise * 0.82} ${keelY - 2}`}
        stroke="oklch(0.04 0.014 45 / 0.42)"
        strokeWidth={1.2}
        fill="none"
      />
      {Array.from({ length: cargo }).map((_, i) => (
        <circle
          key={i}
          cx={cargoStart + i * cargoGap}
          cy={hullTop + hullDepth * 0.58}
          r={portholeRadius}
          fill="oklch(0.08 0.012 45 / 0.68)"
          stroke={accentColor}
          strokeWidth={0.6}
          opacity={0.92}
        />
      ))}
      <text
        x={deckLeft + sternInset + 12}
        y={hullTop + hullDepth * 0.66}
        textAnchor="middle"
        fontSize={7}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="oklch(1 0 0 / 0.8)"
      >
        {rank}
      </text>
      <line
        x1={mainMastX - 10}
        y1={mastTopY + 8}
        x2={mainMastX + 20}
        y2={mastTopY + 5}
        stroke={accentColor}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        className="nc-flag"
        d={`M ${mainMastX + 2} ${mastTopY - 5} h ${flagWidth} l -5 4 l 5 4 h -${flagWidth} Z`}
        fill={accentColor}
        opacity={0.9}
      />
      <defs>
        <clipPath id={clipId}>
          <circle cx={mainMastX} cy={sailSealY} r={logoSize / 2} />
        </clipPath>
      </defs>
      <circle
        cx={mainMastX}
        cy={sailSealY}
        r={logoSize / 2 + 1.5}
        fill="oklch(0.98 0.006 250 / 0.9)"
        stroke={accentColor}
        strokeWidth={1}
      />
      <circle
        cx={mainMastX}
        cy={sailSealY}
        r={logoSize / 2 + 4}
        fill="none"
        stroke={healthColor}
        strokeWidth={0.8}
        opacity={0.55}
      />
      <image
        href={entry.logoPath}
        x={mainMastX - logoSize / 2}
        y={sailSealY - logoSize / 2}
        width={logoSize}
        height={logoSize}
        clipPath={`url(#${clipId})`}
        style={entry.darkInvert ? { filter: "invert(1)" } : undefined}
      />
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
            strokeWidth={0.7}
            opacity={0.34 - i * 0.07}
          />
        );
      })}
      <text
        x={deckLeft + hullW / 2}
        y={hullBottom + 20 + supplyScale * 5}
        textAnchor="middle"
        fontSize={9}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="currentColor"
        opacity={0.56}
      >
        #{rank} {entry.name}
      </text>
    </g>
  );
}

function HorizonFleet({ remaining, y }: { remaining: readonly ChainSummary[]; y: number }) {
  if (remaining.length === 0) return null;
  const baseX = SCENE_WIDTH - 220;
  return (
    <g opacity={0.44}>
      {remaining.slice(0, 10).map((c, i) => (
        <path key={c.id} d={`M ${baseX + i * 18} ${y + 4} h 14 l -3 3 h -9 Z`} fill="#475569" opacity={0.62}>
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

export function NauticalChart({ chains, globalTotalUsd }: { chains: ChainSummary[]; globalTotalUsd: number }) {
  const model = buildChainHarborModel(chains, globalTotalUsd);
  if (model.entries.length === 0) return null;

  const sky = aggregateSkyBand(model.entries);
  const maxSupply = model.entries[0]?.totalUsd ?? 0;
  const topCount = model.entries.length;
  const laneWidth = (SCENE_WIDTH - PIER_X - 40) / Math.max(topCount, 1);

  const remaining = [...chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(topCount);

  return (
    <section className="pharos-card-shell overflow-hidden" aria-labelledby="chain-nautical-heading">
      <div className="pharos-panel-header flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Harbor Chart</p>
          <h2 id="chain-nautical-heading" className="text-lg font-semibold tracking-tight">
            Where stablecoin supply is docked
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Vessel length tracks supply; hull color is health band; pennant span is dominant-coin share; deck ticks
            count listed stablecoins.
          </p>
        </div>
        <div className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          Top {topCount} chains hold {model.topSharePct.toFixed(1)}%
        </div>
      </div>

      <div className="hidden xl:block">
        <svg
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          role="img"
          aria-label={`Nautical chart of ${topCount} largest stablecoin chains`}
          className="h-[260px] w-full text-foreground"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id="nc-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#dbeafe" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#64748b" stopOpacity="0.08" />
            </linearGradient>
            <linearGradient id="nc-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#075985" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#082f49" stopOpacity="0.28" />
            </linearGradient>
            <linearGradient id="nc-range-beam" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#fde68a" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="nc-sail-cloth" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#fff7ed" stopOpacity="0.92" />
              <stop offset="58%" stopColor="#e5e7eb" stopOpacity="0.78" />
              <stop offset="100%" stopColor="#94a3b8" stopOpacity="0.54" />
            </linearGradient>
            <linearGradient id="nc-hull-wood" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#b7793d" stopOpacity="0.98" />
              <stop offset="58%" stopColor="#7c3f12" stopOpacity="0.96" />
              <stop offset="100%" stopColor="#3b1d0b" stopOpacity="0.98" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={SCENE_WIDTH} height={WATERLINE_Y} fill="url(#nc-sky)" />
          <rect x="0" y={WATERLINE_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WATERLINE_Y} fill="url(#nc-water)" />

          <ChartGrid laneWidth={laneWidth} lanes={topCount} />

          {sky === "sun" ? <RangeLight /> : <Fog />}

          <HorizonFleet remaining={remaining} y={WATERLINE_Y - 6} />

          <line
            className="nc-waterline"
            x1="0"
            y1={WATERLINE_Y}
            x2={SCENE_WIDTH}
            y2={WATERLINE_Y}
            stroke="#0284c7"
            strokeWidth={1}
            strokeDasharray="6 8"
            opacity={0.42}
          />

          {model.entries.map((entry, i) => {
            const hullW = hullWidth(entry.totalUsd, maxSupply, laneWidth * 1.1);
            const x = PIER_X + i * laneWidth + (laneWidth - hullW) / 2;
            const supplyScale =
              maxSupply > 0 ? Math.max(0.08, Math.min(1, Math.sqrt(entry.totalUsd / maxSupply))) : 0.08;
            return (
              <Ship
                key={entry.id}
                entry={entry}
                laneY={WATERLINE_Y - 18}
                x={x}
                hullW={hullW}
                rank={i + 1}
                supplyScale={supplyScale}
              />
            );
          })}
        </svg>
      </div>

      <div className="xl:hidden">
        <HarborList chains={chains} globalTotalUsd={globalTotalUsd} />
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
