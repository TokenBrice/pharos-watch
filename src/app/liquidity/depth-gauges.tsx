"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { DEX_GLOBAL_KEY, type DexLiquidityData } from "@shared/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { COVERAGE_TEXT_CLASSES } from "@/lib/liquidity-ui";
import { DepthGauge } from "./depth-gauge";
import type { LiquidityRow } from "@/components/liquidity-table";

export type GaugeSort = "depth" | "volume" | "clarity";

export function DepthGauges({
  rows,
  unratedRows,
  liquidityMap,
  logos,
  sort,
  onSortChange,
  onSelect,
}: {
  rows: LiquidityRow[];
  unratedRows: LiquidityRow[];
  liquidityMap: Record<string, DexLiquidityData>;
  logos: Record<string, string>;
  sort: GaugeSort;
  onSortChange: (s: GaugeSort) => void;
  onSelect: (id: string) => void;
}) {
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      if (sort === "depth") return (b.liq.liquidityScore ?? 0) - (a.liq.liquidityScore ?? 0);
      if (sort === "volume") return b.liq.totalVolume24hUsd - a.liq.totalVolume24hUsd;
      return (b.liq.organicFraction ?? 0) - (a.liq.organicFraction ?? 0);
    });
    return copy;
  }, [rows, sort]);

  const globalData = liquidityMap[DEX_GLOBAL_KEY];

  return (
    <section className="space-y-4" aria-labelledby="depth-gauges-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Depth Gauges</p>
          <h2 id="depth-gauges-heading" className="text-lg font-semibold tracking-tight">
            Exit liquidity, read off the cylinder wall
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Water level is the liquidity score. Color is coverage class. Murk is wash-traded volume. A dashed, empty gauge means the pipeline hasn&apos;t observed enough coverage.
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={sort}
          onValueChange={(v) => v && onSortChange(v as GaugeSort)}
          className="flex gap-1"
          aria-label="Sort gauges"
        >
          <ToggleGroupItem value="depth" variant="outline" size="sm" className="text-xs">Depth</ToggleGroupItem>
          <ToggleGroupItem value="volume" variant="outline" size="sm" className="text-xs">Volume</ToggleGroupItem>
          <ToggleGroupItem value="clarity" variant="outline" size="sm" className="text-xs">Clarity</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {globalData && (
        <div className="pharos-card-shell flex flex-col items-center gap-4 p-5 md:flex-row md:items-stretch">
          <div className="flex shrink-0 items-center justify-center">
            <DepthGauge
              size="lg"
              score={100}
              coverageClass="primary"
              volume24hUsd={globalData.totalVolume24hUsd}
              organicFraction={globalData.organicFraction}
              symbol="GLOBAL"
              patternId="gauge-global"
            />
          </div>
          <div className="flex flex-1 flex-col justify-center gap-2">
            <p className="pharos-kicker">Global Reservoir</p>
            <p className="font-mono text-3xl font-bold tabular-nums">{formatCompactUsd(globalData.totalTvlUsd)}</p>
            {globalData.tvlChange7d != null && (
              <p className={cn("font-mono text-sm tabular-nums", (globalData.tvlChange7d ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                {formatSignedPercent(globalData.tvlChange7d, 2)} 7d TVL
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              24h volume {formatCompactUsd(globalData.totalVolume24hUsd)}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {sorted.map((row) => {
          const cls = row.liq.coverageClass ?? null;
          const colorClass = cls ? COVERAGE_TEXT_CLASSES[cls] : "text-muted-foreground";
          return (
            <button
              key={row.meta.id}
              type="button"
              onClick={() => onSelect(row.meta.id)}
              className="pharos-focus-ring group flex flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-background/35 p-2 transition-colors hover:border-frost-blue/50"
            >
              <DepthGauge
                score={row.liq.liquidityScore}
                coverageClass={row.liq.coverageClass}
                volume24hUsd={row.liq.totalVolume24hUsd}
                organicFraction={row.liq.organicFraction}
                logoUrl={logos[row.meta.id]}
                symbol={row.meta.symbol}
                patternId={`gauge-${row.meta.id}`}
              />
              <div className="flex items-baseline gap-1">
                <span className="text-[11px] font-semibold">{row.meta.symbol}</span>
                <span className={cn("font-mono text-[11px] tabular-nums", colorClass)}>
                  {row.liq.liquidityScore?.toFixed(0) ?? "--"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {unratedRows.length > 0 && (
        <div className="space-y-2">
          <p className="pharos-kicker">Dry Docks</p>
          <p className="text-xs text-muted-foreground">
            No observed DEX coverage. Gauges stay dry until the pipeline has enough evidence.
          </p>
          <div className="grid grid-cols-3 gap-2 opacity-70 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
            {unratedRows.map((row) => (
              <div
                key={row.meta.id}
                className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border/50 p-1.5"
              >
                <DepthGauge
                  score={null}
                  coverageClass={null}
                  volume24hUsd={0}
                  organicFraction={null}
                  symbol={row.meta.symbol}
                  patternId={`gauge-dry-${row.meta.id}`}
                />
                <span className="text-[10px] text-muted-foreground">{row.meta.symbol}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
