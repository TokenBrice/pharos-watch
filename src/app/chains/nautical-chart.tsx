"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import { Anchor, Activity, ShipWheel } from "lucide-react";
import type { ChainSummary } from "@shared/types/chains";
import { cn } from "@/lib/utils";
import { formatCompactUsd } from "@shared/lib/format";
import { buildChainHarborModel } from "./harbor-map";
import { aggregateSkyBand, hullWidth } from "./nautical-scene-math";
import {
  LIGHTHOUSE_ZONE,
  NAUTICAL_PALETTE,
  PIER_X,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  WATERLINE_Y,
} from "./nautical-constants";
import { shipDimensions } from "./nautical-geometry";
import {
  ChartGrid,
  Coastline,
  Fog,
  HorizonFleet,
  Lighthouse,
  NauticalDefs,
  Stars,
  Waterline,
  WaveRipples,
} from "./nautical-background";
import { HarborLight, Ship, ShipReflection } from "./nautical-ships";
import { CompassPlate, HealthBandLegend, ShipNameLabels } from "./nautical-labels";
import "./nautical-chart.css";

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
    const supplyScale = maxSupply > 0 ? Math.max(0.1, Math.min(1, Math.sqrt(entry.totalUsd / maxSupply))) : 0.1;
    return { entry, geom: shipDimensions(entry, x, hullW, WATERLINE_Y - 18, supplyScale) };
  });
  const activeGeometry = geometries.find(({ entry }) => entry.id === activeChainId) ?? geometries[0];
  const beamTargetX = activeGeometry ? activeGeometry.geom.deckLeft + activeGeometry.geom.hullW / 2 : PIER_X;
  const beamTargetY = activeGeometry ? activeGeometry.geom.hullTop - 42 : WATERLINE_Y - 96;
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
          <p className="max-w-5xl text-sm text-muted-foreground">
            Vessel length = supply · hull color = health · pennant = dominant-coin share · cargo marks = top stablecoins
            by chain-local supply.
          </p>
        </div>
        <div className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          Top {topCount} chains hold {model.topSharePct.toFixed(1)}%
        </div>
      </div>

      <div className="grid gap-3 border-b border-border/60 p-4 sm:grid-cols-2 xl:grid-cols-4">
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
        <HealthBandLegend />
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
          <NauticalDefs />

          {/* Sky */}
          <rect x="0" y="0" width={SCENE_WIDTH} height={WATERLINE_Y} fill="url(#nc-sky)" />
          <Stars />

          {/* Lighthouse beam (drawn early so ships sit in front) */}
          <Lighthouse dim={sky === "fog"} targetX={beamTargetX} targetY={beamTargetY} />

          {/* Distant coastline silhouette */}
          <Coastline />

          {/* Background fleet on the horizon */}
          <HorizonFleet
            remaining={remaining}
            y={WATERLINE_Y - 8}
            maxX={SCENE_WIDTH - LIGHTHOUSE_ZONE}
            totalUsd={globalTotalUsd}
          />

          {/* Water */}
          <rect x="0" y={WATERLINE_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WATERLINE_Y} fill="url(#nc-water)" />

          <ChartGrid laneWidth={laneWidth} lanes={topCount} />

          {/* Reflections — flipped silhouettes below water, faded with depth */}
          <g mask="url(#nc-reflection-mask)" aria-hidden="true">
            {geometries.map(({ entry, geom }, index) => (
              <ShipReflection key={`r-${entry.id}`} entry={entry} geom={geom} index={index} />
            ))}
          </g>

          {/* Wave ripples cut across reflections */}
          <WaveRipples />

          {/* Waterline */}
          <Waterline />

          {/* Ships */}
          {geometries.map(({ entry, geom }) => {
            const selected = entry.id === activeChainId;
            return (
              <g
                key={entry.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`Select ${entry.name} harbor`}
                className={cn(
                  "nc-ship-target cursor-pointer outline-none",
                  selected && "nc-ship-lit nc-ship-target-selected",
                )}
                style={
                  {
                    "--nc-ship-origin-x": `${geom.deckLeft + geom.hullW / 2}px`,
                    "--nc-ship-origin-y": `${geom.hullBottom}px`,
                  } as CSSProperties
                }
                onFocus={() => onSelectChain?.(entry.id)}
                onMouseEnter={() => onSelectChain?.(entry.id)}
                onClick={() => onSelectChain?.(entry.id)}
                onKeyDown={(event) => handleShipKeyDown(event, entry.id)}
              >
                <title>
                  {entry.name}: {formatCompactUsd(entry.totalUsd)} docked, {entry.sharePct.toFixed(1)}% of tracked
                  supply
                </title>
                <ellipse
                  className="nc-ship-focus-ring"
                  cx={geom.deckLeft + geom.hullW / 2}
                  cy={geom.hullBottom + 10}
                  rx={Math.max(30, geom.hullW * 0.58)}
                  ry={8}
                  fill="none"
                  stroke={NAUTICAL_PALETTE.beam}
                  strokeWidth={1.2}
                  strokeDasharray="4 5"
                />
                {selected ? <HarborLight geom={geom} /> : null}
                <Ship entry={entry} geom={geom} maxCargoUsd={maxCargoUsd} />
              </g>
            );
          })}

          {/* Ship name labels */}
          <ShipNameLabels geometries={geometries} />

          {/* Fog overlay when conditions are bad */}
          {sky === "fog" && <Fog />}
        </svg>
      </div>
    </section>
  );
}
