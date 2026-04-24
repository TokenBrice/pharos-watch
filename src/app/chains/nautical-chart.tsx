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

function healthHex(band: HealthBand | null): string {
  return band ? HEALTH_HEX_FILL[band] : "#94a3b8";
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
}: {
  entry: ChainHarborEntry;
  laneY: number;
  x: number;
  hullW: number;
  rank: number;
}) {
  const color = healthHex(entry.healthBand);
  const cargo = cargoBuckets(entry.stablecoinCount);
  const layers = depthLayers(entry.sharePct / 100);
  const wake = wakeLength(entry.change7dPct);
  const hullTop = laneY - 4;
  const hullBottom = laneY + 20;
  const deckLeft = x;
  const deckRight = x + hullW;
  const bowInset = Math.min(22, Math.max(10, hullW * 0.16));
  const sternInset = Math.min(10, Math.max(5, hullW * 0.07));
  const midY = hullTop + (hullBottom - hullTop) / 2;
  const keelY = hullBottom - 5;
  const cabinW = Math.min(30, Math.max(18, hullW * 0.24));
  const cabinH = 12;
  const cabinX = Math.min(
    deckRight - bowInset - cabinW - 5,
    Math.max(deckLeft + sternInset + 8, deckLeft + hullW * 0.52 - cabinW / 2),
  );
  const cabinY = hullTop - 8;
  const cargoStart = deckLeft + sternInset + 8;
  const cargoSpan = Math.max(8, cabinX - cargoStart - 6);
  const cargoGap = cargo > 1 ? Math.min(8, cargoSpan / (cargo - 1)) : 0;

  const mastX = Math.min(deckRight - bowInset - 6, cabinX + cabinW + 6);
  const flagWidth = Math.max(14, Math.min(42, (entry.dominantSharePct / 100) * 42));
  const logoSize = 16;
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
        d={`M ${deckLeft + sternInset} ${hullTop + 4} L ${deckRight - bowInset} ${hullTop + 2} L ${deckRight} ${midY} L ${deckRight - bowInset} ${hullBottom - 1} L ${deckLeft + sternInset} ${hullBottom} L ${deckLeft} ${midY} Z`}
        fill={color}
        opacity={0.88}
        stroke="oklch(1 0 0 / 0.4)"
        strokeWidth={0.8}
      />
      <path
        d={`M ${deckLeft + sternInset + 3} ${keelY} L ${deckRight - bowInset + 2} ${keelY - 1} L ${deckRight - bowInset - 3} ${hullBottom - 2} L ${deckLeft + sternInset + 5} ${hullBottom - 1} Z`}
        fill="oklch(0.12 0.018 250 / 0.58)"
      />
      <path
        d={`M ${deckLeft + sternInset + 7} ${hullTop + 7} L ${deckRight - bowInset - 7} ${hullTop + 6} L ${deckRight - bowInset - 12} ${midY} L ${deckLeft + sternInset + 8} ${midY + 1} Z`}
        fill="oklch(0.97 0.006 250 / 0.22)"
      />
      <path
        d={`M ${deckLeft + sternInset + 7} ${midY + 4} L ${deckRight - bowInset - 9} ${midY + 3} L ${deckRight - bowInset - 13} ${keelY - 1} L ${deckLeft + sternInset + 8} ${keelY} Z`}
        fill="oklch(0.05 0.012 250 / 0.2)"
      />
      <line
        x1={deckLeft + sternInset + 5}
        y1={midY}
        x2={deckRight - bowInset - 4}
        y2={midY}
        stroke="oklch(1 0 0 / 0.5)"
        strokeWidth={0.7}
        opacity={0.48}
      />
      {Array.from({ length: cargo }).map((_, i) => (
        <rect
          key={i}
          x={cargoStart + i * cargoGap}
          y={hullTop + 1}
          width={5}
          height={6}
          rx={0.7}
          fill="oklch(0.86 0.018 82 / 0.78)"
          stroke="oklch(0.18 0.012 250 / 0.28)"
          strokeWidth={0.45}
        />
      ))}
      <path
        d={`M ${cabinX + 3} ${cabinY} H ${cabinX + cabinW - 5} L ${cabinX + cabinW} ${cabinY + cabinH} H ${cabinX} Z`}
        fill="oklch(0.2 0.018 250 / 0.92)"
        stroke="oklch(1 0 0 / 0.32)"
        strokeWidth={0.65}
      />
      <line
        x1={cabinX + 5}
        y1={cabinY + 5}
        x2={cabinX + cabinW - 7}
        y2={cabinY + 5}
        stroke="#38bdf8"
        strokeWidth={1.2}
        opacity={0.62}
      />
      <rect
        x={deckLeft + sternInset + 8}
        y={midY - 4}
        width={20}
        height={8}
        rx={2}
        fill="oklch(0.08 0.012 250 / 0.45)"
        stroke="oklch(1 0 0 / 0.22)"
        strokeWidth={0.5}
      />
      <text
        x={deckLeft + sternInset + 18}
        y={midY + 2.8}
        textAnchor="middle"
        fontSize={7}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="oklch(1 0 0 / 0.8)"
      >
        {rank}
      </text>
      <line
        x1={mastX}
        y1={hullTop + 2}
        x2={mastX}
        y2={hullTop - 22}
        stroke="currentColor"
        strokeWidth={0.9}
        opacity={0.36}
      />
      <path
        className="nc-flag"
        d={`M ${mastX} ${hullTop - 21} h ${flagWidth} l -5 5 l 5 5 h -${flagWidth} Z`}
        fill={color}
        opacity={0.82}
      />
      <defs>
        <clipPath id={clipId}>
          <circle cx={cabinX + cabinW / 2} cy={cabinY + cabinH + 2} r={logoSize / 2} />
        </clipPath>
      </defs>
      <circle
        cx={cabinX + cabinW / 2}
        cy={cabinY + cabinH + 2}
        r={logoSize / 2 + 1.5}
        fill="oklch(0.98 0.006 250 / 0.9)"
        stroke="oklch(0.18 0.012 250 / 0.36)"
        strokeWidth={0.8}
      />
      <image
        href={entry.logoPath}
        x={cabinX + cabinW / 2 - logoSize / 2}
        y={cabinY + cabinH + 2 - logoSize / 2}
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
        y={hullBottom + 22}
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
            return <Ship key={entry.id} entry={entry} laneY={WATERLINE_Y - 18} x={x} hullW={hullW} rank={i + 1} />;
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
