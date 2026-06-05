"use client";

/**
 * Chain Cohort Lattice — Tuftean small-multiple grid of 90d chain supply
 * trajectories on a shared log y-domain. Complements (does not replace) the
 * Nautical Harbor module above it: the harbor sells dominance, the lattice
 * rewards the scroll with side-by-side trajectory shape.
 *
 * Data follow-up: per-chain 90d series is not yet exposed by the client API.
 * `chain_supply_history` exists in D1 (worker/src/cron/snapshot-chain-supply.ts)
 * but is not served. Until an endpoint lands, the lattice renders a structured
 * placeholder that preserves the real cohort ordering and labels, so the layout
 * contract is verifiable today. Once data arrives, pass `seriesByChain` and the
 * placeholder collapses into the real sparklines.
 */

import { useMemo } from "react";
import Image from "next/image";
import type { ChainSummary } from "@shared/types/chains";
import { CHAIN_META } from "@shared/lib/chains";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { CHART_GREEN, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

export interface ChainSeriesPoint {
  /** Unix ms */
  ts: number;
  /** Total supply USD on this chain at this snapshot */
  totalUsd: number;
}

export interface ChainCohortLatticeProps {
  chains: ChainSummary[];
  /** Optional 90d daily series keyed by chain id. When provided, real sparklines render. */
  seriesByChain?: Map<string, ChainSeriesPoint[]>;
  /** Max number of tiles to render. Spec target is 16, capped at 24. */
  maxTiles?: number;
}

const DEFAULT_MAX_TILES = 16;
const TILE_VIEWBOX_W = 120;
const TILE_VIEWBOX_H = 56;
const SVG_PAD_X = 2;
const SVG_PAD_Y = 4;
const PLOT_W = TILE_VIEWBOX_W - SVG_PAD_X * 2;
const PLOT_H = TILE_VIEWBOX_H - SVG_PAD_Y * 2;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FLAT_DELTA_PCT_TOLERANCE = 0.5; // 0.5%

interface PreparedTile {
  chain: ChainSummary;
  /** Polyline points string in viewBox coords, or null when no series. */
  polyline: string | null;
  /** 7d-ago tick x in viewBox coords, or null. */
  sevenDayTickX: number | null;
  /** Last value y in viewBox coords, or null. */
  lastY: number | null;
  /** Sparkline stroke color hex. */
  stroke: string;
  /** Signed 7d percent change (pre-multiplied: 1.23 = 1.23%). */
  change7dPct: number;
}

function logScale(value: number, logMin: number, logMax: number): number {
  if (value <= 0) return 0;
  if (logMax <= logMin) return 0.5;
  const v = Math.log10(value);
  return (v - logMin) / (logMax - logMin);
}

function trendStroke(deltaPct: number): string {
  if (deltaPct > FLAT_DELTA_PCT_TOLERANCE) return CHART_GREEN;
  if (deltaPct < -FLAT_DELTA_PCT_TOLERANCE) return CHART_RED;
  return CHART_SLATE;
}

function toNoSeriesTile(chain: ChainSummary, stroke: string, change7dPct: number): PreparedTile {
  return {
    chain,
    polyline: null,
    sevenDayTickX: null,
    lastY: null,
    stroke,
    change7dPct,
  };
}

/**
 * Compute the shared log y-domain across all tiles' series. Returns
 * `[log10(min), log10(max)]`. When no series data is available, falls back to
 * deriving the domain from current totalUsd snapshots so the placeholder still
 * arranges by magnitude.
 */
function sharedLogDomain(
  chains: ChainSummary[],
  seriesByChain: Map<string, ChainSeriesPoint[]> | undefined,
): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  if (seriesByChain && seriesByChain.size > 0) {
    for (const chain of chains) {
      const series = seriesByChain.get(chain.id);
      if (!series) continue;
      for (const p of series) {
        if (!Number.isFinite(p.totalUsd) || p.totalUsd <= 0) continue;
        if (p.totalUsd < min) min = p.totalUsd;
        if (p.totalUsd > max) max = p.totalUsd;
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    for (const chain of chains) {
      if (chain.totalUsd <= 0) continue;
      if (chain.totalUsd < min) min = chain.totalUsd;
      if (chain.totalUsd > max) max = chain.totalUsd;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    return [0, 1];
  }
  // Small floor so the smallest tile doesn't sit exactly on the bottom edge.
  return [Math.log10(min) - 0.05, Math.log10(max) + 0.05];
}

function prepareTile(
  chain: ChainSummary,
  series: ChainSeriesPoint[] | undefined,
  logMin: number,
  logMax: number,
): PreparedTile {
  const change7dPct = chain.change7dPct * 100;
  const stroke = trendStroke(change7dPct);

  if (!series || series.length < 2) {
    return toNoSeriesTile(chain, stroke, change7dPct);
  }

  const sorted = [...series]
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.totalUsd) && p.totalUsd > 0)
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length < 2) {
    return toNoSeriesTile(chain, stroke, change7dPct);
  }

  const last = sorted[sorted.length - 1];
  const start = last.ts - NINETY_DAYS_MS;
  const inWindow = sorted.filter((p) => p.ts >= start);
  if (inWindow.length < 2) {
    return toNoSeriesTile(chain, stroke, change7dPct);
  }

  const tsSpan = Math.max(last.ts - inWindow[0].ts, 1);
  const polyline = inWindow
    .map((p) => {
      const x = SVG_PAD_X + ((p.ts - inWindow[0].ts) / tsSpan) * PLOT_W;
      const y = SVG_PAD_Y + (1 - logScale(p.totalUsd, logMin, logMax)) * PLOT_H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  // 7d-ago tick: x position 7 days back from the right edge.
  const sevenDaysBackTs = last.ts - SEVEN_DAYS_MS;
  const sevenDayTickX =
    sevenDaysBackTs >= inWindow[0].ts
      ? SVG_PAD_X + ((sevenDaysBackTs - inWindow[0].ts) / tsSpan) * PLOT_W
      : null;

  const lastY = SVG_PAD_Y + (1 - logScale(last.totalUsd, logMin, logMax)) * PLOT_H;

  return {
    chain,
    polyline,
    sevenDayTickX,
    lastY,
    stroke,
    change7dPct,
  };
}

export function ChainCohortLattice({
  chains,
  seriesByChain,
  maxTiles = DEFAULT_MAX_TILES,
}: ChainCohortLatticeProps) {
  const tiles = useMemo(() => {
    if (chains.length === 0) return [] as PreparedTile[];
    const limit = Math.min(chains.length, Math.max(maxTiles, 1), 24);
    const sorted = [...chains]
      .filter((c) => Number.isFinite(c.totalUsd) && c.totalUsd > 0)
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, limit);
    const [logMin, logMax] = sharedLogDomain(sorted, seriesByChain);
    return sorted.map((chain) => prepareTile(chain, seriesByChain?.get(chain.id), logMin, logMax));
  }, [chains, seriesByChain, maxTiles]);

  if (tiles.length === 0) return null;

  const hasAnySeries = tiles.some((t) => t.polyline !== null);

  return (
    <section
      aria-labelledby="chain-cohort-lattice-heading"
      className="pharos-subtle-band space-y-3 py-4"
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h2
            id="chain-cohort-lattice-heading"
            className="text-base font-semibold tracking-tight sm:text-lg"
          >
            Chain Cohort: 90d trajectories
          </h2>
          <p className="pharos-kicker mt-1">Compare shapes, not absolute size.</p>
        </div>
        {!hasAnySeries && (
          <p
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
            data-testid="chain-cohort-lattice-pending"
          >
            90d cohort coming soon
          </p>
        )}
      </header>

      {/* Horizontal scroll on very narrow viewports; grid above sm. */}
      <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:overflow-visible sm:px-0">
        <ul
          className={cn(
            "flex gap-3",
            "sm:grid sm:grid-cols-2 sm:gap-3",
            "md:grid-cols-3",
            "lg:grid-cols-4",
          )}
          role="list"
        >
          {tiles.map((tile) => (
            <li
              key={tile.chain.id}
              className="min-w-[180px] shrink-0 sm:min-w-0"
            >
              <LatticeTile tile={tile} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function LatticeTile({ tile }: { tile: PreparedTile }) {
  const { chain, polyline, sevenDayTickX, lastY, stroke, change7dPct } = tile;
  const deltaLabel = formatSignedPercent(change7dPct, 1);
  const ariaLabel = polyline
    ? `${chain.name}: ${formatCompactUsd(chain.totalUsd)} supply, ${deltaLabel} over 7 days, 90-day trajectory.`
    : `${chain.name}: ${formatCompactUsd(chain.totalUsd)} supply, ${deltaLabel} over 7 days. 90-day history pending.`;

  const deltaTone =
    change7dPct > FLAT_DELTA_PCT_TOLERANCE
      ? "text-emerald-600 dark:text-emerald-400"
      : change7dPct < -FLAT_DELTA_PCT_TOLERANCE
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";

  return (
    <figure
      className="group relative flex flex-col gap-1 rounded-md border border-border/40 bg-card/40 px-2 py-1.5"
      aria-label={ariaLabel}
    >
      {/* Header row: chain name + supply. */}
      <figcaption className="flex items-center gap-1.5 min-w-0">
        <Image
          src={chain.logoPath}
          alt=""
          width={12}
          height={12}
          className={cn("rounded-full shrink-0", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
          style={{ width: 12, height: 12 }}
        />
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {chain.name}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-foreground/80">
          {formatCompactUsd(chain.totalUsd)}
        </span>
      </figcaption>

      {/* Sparkline body. Pure SVG, preserveAspectRatio=none for fill-width. */}
      <svg
        viewBox={`0 0 ${TILE_VIEWBOX_W} ${TILE_VIEWBOX_H}`}
        preserveAspectRatio="none"
        width="100%"
        height={TILE_VIEWBOX_H}
        className="block"
        aria-hidden="true"
        role="presentation"
      >
        {/* Top/bottom hairline frame — Tuftean: just enough rule to anchor the eye. */}
        <line
          x1={SVG_PAD_X}
          x2={TILE_VIEWBOX_W - SVG_PAD_X}
          y1={SVG_PAD_Y}
          y2={SVG_PAD_Y}
          stroke="currentColor"
          strokeOpacity={0.08}
          strokeWidth={0.5}
        />
        <line
          x1={SVG_PAD_X}
          x2={TILE_VIEWBOX_W - SVG_PAD_X}
          y1={TILE_VIEWBOX_H - SVG_PAD_Y}
          y2={TILE_VIEWBOX_H - SVG_PAD_Y}
          stroke="currentColor"
          strokeOpacity={0.08}
          strokeWidth={0.5}
        />

        {polyline ? (
          <>
            {/* 7d-ago hairline tick: small vertical mark, low contrast. */}
            {sevenDayTickX != null && (
              <line
                x1={sevenDayTickX}
                x2={sevenDayTickX}
                y1={SVG_PAD_Y}
                y2={TILE_VIEWBOX_H - SVG_PAD_Y}
                stroke="currentColor"
                strokeOpacity={0.18}
                strokeWidth={0.75}
                strokeDasharray="1.5 1.5"
              />
            )}
            <polyline
              points={polyline}
              fill="none"
              stroke={stroke}
              strokeWidth={1.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {lastY != null && (
              <circle
                cx={TILE_VIEWBOX_W - SVG_PAD_X}
                cy={lastY}
                r={1.5}
                fill={stroke}
              />
            )}
          </>
        ) : (
          // Placeholder: faint diagonal dashed rule from baseline up at the
          // current 7d slope, so the tile reads as "shape pending" rather
          // than "broken". Direction follows the snapshot delta.
          <PlaceholderRule changePct={change7dPct} />
        )}
      </svg>

      {/* Inline delta in bottom-right corner, mono and low-contrast. */}
      <span
        className={cn(
          "pointer-events-none absolute bottom-1 right-2 font-mono text-[10px] tabular-nums",
          deltaTone,
        )}
      >
        {deltaLabel}
      </span>
    </figure>
  );
}

function PlaceholderRule({ changePct }: { changePct: number }) {
  // Map the 7d delta into a gentle slope inside the tile. Clamp to ±8% so
  // outliers don't blow the tile up.
  const clamped = Math.max(-8, Math.min(8, changePct));
  const slope = (clamped / 8) * (PLOT_H * 0.35);
  const midY = SVG_PAD_Y + PLOT_H * 0.55;
  const startY = midY + slope / 2;
  const endY = midY - slope / 2;
  return (
    <line
      x1={SVG_PAD_X}
      x2={TILE_VIEWBOX_W - SVG_PAD_X}
      y1={startY}
      y2={endY}
      stroke="currentColor"
      strokeOpacity={0.22}
      strokeWidth={0.75}
      strokeDasharray="2 2"
      vectorEffect="non-scaling-stroke"
    />
  );
}
