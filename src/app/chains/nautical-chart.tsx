"use client";

import { Anchor, Activity, ShipWheel } from "lucide-react";
import type { ChainSummary } from "@shared/types/chains";
import { HEALTH_BADGE_CLASSES } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import { buildChainHarborModel, type ChainHarborEntry } from "./harbor-map";
import {
  hullWidth,
  cargoBuckets,
  depthLayers,
  wakeLength,
  aggregateSkyBand,
} from "./nautical-scene-math";
import { HarborList } from "./harbor-list";
import "./nautical-chart.css";

const SCENE_WIDTH = 900;
const SCENE_HEIGHT = 260;
const WATERLINE_Y = 150;
const PIER_X = 40;

const HEALTH_HEX: Record<string, string> = {
  robust: "#10b981",
  healthy: "#0ea5e9",
  mixed: "#f59e0b",
  fragile: "#f97316",
  concentrated: "#ef4444",
};

function healthHex(band: string | null): string {
  return band ? HEALTH_HEX[band] ?? "#94a3b8" : "#94a3b8";
}

function Sun() {
  const cx = SCENE_WIDTH - 80;
  const cy = 50;
  return (
    <g className="nc-sun" aria-hidden="true">
      <circle cx={cx} cy={cy} r={22} fill="#fde68a" opacity={0.9} />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        const r1 = 26;
        const r2 = 38;
        return (
          <line
            key={deg}
            x1={cx + Math.cos(rad) * r1}
            y1={cy + Math.sin(rad) * r1}
            x2={cx + Math.cos(rad) * r2}
            y2={cy + Math.sin(rad) * r2}
            stroke="#fde68a"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.7}
          />
        );
      })}
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

function Ship({
  entry,
  laneY,
  x,
  hullW,
}: {
  entry: ChainHarborEntry;
  laneY: number;
  x: number;
  hullW: number;
}) {
  const color = healthHex(entry.healthBand);
  const cargo = cargoBuckets(entry.stablecoinCount);
  const layers = depthLayers(entry.sharePct / 100);
  const wake = wakeLength(entry.change7dPct);
  const hullTop = laneY;
  const hullBottom = laneY + 18;
  const deckLeft = x;
  const deckRight = x + hullW;
  const bowInset = 6;

  const mastX = x + hullW * 0.6;
  const flagWidth = Math.max(10, Math.min(32, (entry.dominantSharePct / 100) * 32));

  return (
    <g>
      {wake !== 0 && (
        <path
          d={
            wake > 0
              ? `M ${deckRight} ${hullBottom - 2} q ${wake * 28} -4 ${wake * 56} 0`
              : `M ${deckLeft} ${hullBottom - 2} q ${wake * 28} -4 ${wake * 56} 0`
          }
          stroke={wake > 0 ? "#10b981" : "#ef4444"}
          strokeWidth={1.5}
          strokeDasharray="3 3"
          fill="none"
          opacity={0.7}
        />
      )}
      <path
        d={`M ${deckLeft} ${hullTop} L ${deckRight} ${hullTop} L ${deckRight - bowInset} ${hullBottom} L ${deckLeft + bowInset} ${hullBottom} Z`}
        fill={color}
        opacity={0.85}
      />
      <line x1={deckLeft} y1={hullTop} x2={deckRight} y2={hullTop} stroke="#475569" strokeWidth={0.75} opacity={0.4} />
      {Array.from({ length: cargo }).map((_, i) => (
        <rect
          key={i}
          x={deckLeft + 4 + i * 7}
          y={hullTop - 6}
          width={6}
          height={6}
          fill="#64748b"
          opacity={0.65}
        />
      ))}
      <line x1={mastX} y1={hullTop} x2={mastX} y2={hullTop - 28} stroke="#475569" strokeWidth={1.2} />
      <rect
        className="nc-flag"
        x={mastX}
        y={hullTop - 28}
        width={flagWidth}
        height={10}
        fill={color}
        opacity={0.9}
      />
      <image
        href={entry.logoPath}
        x={mastX + flagWidth / 2 - 7}
        y={hullTop - 27}
        width={14}
        height={14}
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
            strokeWidth={0.75}
            opacity={0.45 - i * 0.08}
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
        opacity={0.6}
      >
        {entry.name}
      </text>
    </g>
  );
}

function HorizonFleet({
  remaining,
  y,
}: {
  remaining: readonly ChainSummary[];
  y: number;
}) {
  if (remaining.length === 0) return null;
  const baseX = SCENE_WIDTH - 220;
  return (
    <g opacity={0.55}>
      {remaining.slice(0, 10).map((c, i) => (
        <rect
          key={c.id}
          x={baseX + i * 18}
          y={y}
          width={14}
          height={4}
          fill="#475569"
          opacity={0.5}
        >
          <title>{c.name}</title>
        </rect>
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
    <div className="relative rounded-xl border border-amber-700/20 bg-gradient-to-br from-amber-50/40 to-amber-100/10 p-3 dark:border-amber-300/15 dark:from-amber-950/30 dark:to-amber-900/10">
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
}: {
  chains: ChainSummary[];
  globalTotalUsd: number;
}) {
  const model = buildChainHarborModel(chains, globalTotalUsd);
  if (model.entries.length === 0) return null;

  const sky = aggregateSkyBand(model.entries);
  const maxSupply = model.entries[0]?.totalUsd ?? 0;
  const topCount = model.entries.length;
  const laneWidth = (SCENE_WIDTH - PIER_X - 40) / Math.max(topCount, 1);

  const remaining = [...chains]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(topCount);

  return (
    <section className="pharos-card-shell overflow-hidden" aria-labelledby="chain-nautical-heading">
      <div className="pharos-panel-header flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Harbor Chart</p>
          <h2 id="chain-nautical-heading" className="text-lg font-semibold tracking-tight">
            Where stablecoin supply is docked
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Ship length tracks supply. Hull color is health band; flag width is dominant-coin share; cargo is stablecoin count; depth lines mark dominance draft.
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
              <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#bae6fd" stopOpacity="0.1" />
            </linearGradient>
            <linearGradient id="nc-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0284c7" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#0c4a6e" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={SCENE_WIDTH} height={WATERLINE_Y} fill="url(#nc-sky)" />
          <rect x="0" y={WATERLINE_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WATERLINE_Y} fill="url(#nc-water)" />

          {sky === "sun" ? <Sun /> : <Fog />}

          <HorizonFleet remaining={remaining} y={WATERLINE_Y - 6} />

          <line
            className="nc-waterline"
            x1="0"
            y1={WATERLINE_Y}
            x2={SCENE_WIDTH}
            y2={WATERLINE_Y}
            stroke="#0284c7"
            strokeWidth={1}
            strokeDasharray="4 6"
            opacity={0.5}
          />

          {model.entries.map((entry, i) => {
            const hullW = hullWidth(entry.totalUsd, maxSupply, laneWidth * 1.1);
            const x = PIER_X + i * laneWidth + (laneWidth - hullW) / 2;
            return (
              <Ship
                key={entry.id}
                entry={entry}
                laneY={WATERLINE_Y - 18}
                x={x}
                hullW={hullW}
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
        <div className="rounded-xl border border-amber-700/20 bg-gradient-to-br from-amber-50/40 to-amber-100/10 p-3 dark:border-amber-300/15 dark:from-amber-950/30 dark:to-amber-900/10">
          <p className="pharos-kicker">Health bands</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["robust", "healthy", "mixed", "fragile", "concentrated"] as const).map((band) => (
              <span key={band} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", HEALTH_BADGE_CLASSES[band])}>
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
