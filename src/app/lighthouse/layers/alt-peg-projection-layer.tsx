import type { CSSProperties } from "react";
import type { LighthouseCinematicModel } from "../cinematic-model";

type AtlasIsland = LighthouseCinematicModel["stage"]["modules"]["atlas"];
type AtlasCluster = LighthouseCinematicModel["altPeg"]["clusters"][number];
type AtlasCohort = LighthouseCinematicModel["altPeg"]["skyCohorts"][number];

const TABLE_WIDTH = 632;
const TABLE_TOP_OFFSET = -126;
const TABLE_BOTTOM_OFFSET = 76;
const TABLE_INNER_WIDTH = 540;
const GRID_COLUMNS = [-0.4, -0.24, -0.08, 0.08, 0.24, 0.4];
const GRID_ROWS = [-0.48, -0.24, 0, 0.24, 0.48];

function cssVars(colorHex: string, delaySec = 0): CSSProperties {
  return {
    "--lh-atlas-color": colorHex,
    "--lh-atlas-delay": `${delaySec}s`,
  } as CSSProperties;
}

function projectionTablePath(island: AtlasIsland): string {
  const left = island.x - TABLE_WIDTH / 2;
  const right = island.x + TABLE_WIDTH / 2;
  const top = island.y + TABLE_TOP_OFFSET;
  const bottom = island.y + TABLE_BOTTOM_OFFSET;

  return [
    `M ${left + 26} ${top + 58}`,
    `C ${left + 120} ${top - 16} ${right - 132} ${top - 16} ${right - 28} ${top + 58}`,
    `L ${right - 56} ${bottom - 2}`,
    `C ${right - 176} ${bottom + 38} ${left + 168} ${bottom + 38} ${left + 54} ${bottom - 2}`,
    "Z",
  ].join(" ");
}

function projectionDeckPath(island: AtlasIsland): string {
  const left = island.x - TABLE_WIDTH / 2 + 54;
  const right = island.x + TABLE_WIDTH / 2 - 54;
  const top = island.y + TABLE_TOP_OFFSET + 34;
  const bottom = island.y + TABLE_BOTTOM_OFFSET - 20;

  return [
    `M ${left} ${top + 42}`,
    `C ${left + 100} ${top - 18} ${right - 106} ${top - 18} ${right} ${top + 42}`,
    `L ${right - 28} ${bottom}`,
    `C ${right - 130} ${bottom + 24} ${left + 124} ${bottom + 24} ${left + 28} ${bottom}`,
    "Z",
  ].join(" ");
}

function gridColumnPath(island: AtlasIsland, column: number): string {
  const topY = island.y + TABLE_TOP_OFFSET + 49;
  const bottomY = island.y + TABLE_BOTTOM_OFFSET - 15;
  const topX = island.x + column * (TABLE_INNER_WIDTH * 0.84);
  const bottomX = island.x + column * TABLE_INNER_WIDTH;

  return `M ${topX} ${topY} C ${topX + column * 22} ${island.y - 24} ${bottomX + column * 12} ${island.y + 22} ${bottomX} ${bottomY}`;
}

function gridRowPath(island: AtlasIsland, row: number): string {
  const y = island.y - 24 + row * 104;
  const left = island.x - TABLE_INNER_WIDTH / 2 + Math.abs(row) * 42;
  const right = island.x + TABLE_INNER_WIDTH / 2 - Math.abs(row) * 42;

  return `M ${left} ${y} C ${island.x - 168} ${y + row * 18} ${island.x + 168} ${y + row * 18} ${right} ${y}`;
}

function tablePort(island: AtlasIsland, index: number, count: number): { x: number; y: number } {
  const span = Math.max(1, count);
  return {
    x: Math.round(island.x - TABLE_INNER_WIDTH / 2 + (TABLE_INNER_WIDTH * (index + 0.5)) / span),
    y: island.y + TABLE_TOP_OFFSET + 58,
  };
}

function clusterExtent(cluster: AtlasCluster): number {
  return cluster.coins.reduce((extent, coin) => {
    const distance = Math.hypot(coin.x - cluster.anchor.x, coin.y - cluster.anchor.y) + coin.sizePx / 2;
    return Math.max(extent, distance);
  }, 24);
}

function clusterLandPath(cluster: AtlasCluster, index: number): string {
  const extent = clusterExtent(cluster);
  const rx = Math.min(92, Math.max(38, extent + 24 + (index % 3) * 5));
  const ry = Math.min(54, Math.max(24, extent * 0.52 + 10 + (index % 2) * 4));
  const { x, y } = cluster.anchor;

  return [
    `M ${x - rx} ${y - 2}`,
    `C ${x - rx * 0.72} ${y - ry * 0.82} ${x - rx * 0.2} ${y - ry * 1.04} ${x + rx * 0.08} ${y - ry * 0.72}`,
    `C ${x + rx * 0.46} ${y - ry * 1.08} ${x + rx * 0.92} ${y - ry * 0.44} ${x + rx} ${y - 1}`,
    `C ${x + rx * 0.78} ${y + ry * 0.62} ${x + rx * 0.22} ${y + ry * 0.86} ${x - rx * 0.14} ${y + ry * 0.68}`,
    `C ${x - rx * 0.48} ${y + ry * 0.96} ${x - rx * 0.86} ${y + ry * 0.54} ${x - rx} ${y - 2}`,
    "Z",
  ].join(" ");
}

function clusterProjectionPath(cluster: AtlasCluster, port: { x: number; y: number }): string {
  const controlY = Math.min(port.y, cluster.anchor.y) - 28;
  return `M ${port.x} ${port.y} C ${port.x} ${controlY} ${cluster.anchor.x} ${controlY} ${cluster.anchor.x} ${cluster.anchor.y}`;
}

function coinTetherPath(cluster: AtlasCluster, coin: AtlasCluster["coins"][number]): string {
  const midX = (cluster.anchor.x + coin.x) / 2;
  const midY = (cluster.anchor.y + coin.y) / 2 - 10;
  return `M ${cluster.anchor.x} ${cluster.anchor.y} Q ${midX} ${midY} ${coin.x} ${coin.y}`;
}

function cohortCenter(cohort: AtlasCohort): { x: number; y: number } | null {
  if (cohort.coins.length === 0) return null;
  const totals = cohort.coins.reduce(
    (sum, coin) => ({
      x: sum.x + coin.x,
      y: sum.y + coin.y,
    }),
    { x: 0, y: 0 },
  );
  return {
    x: Math.round(totals.x / cohort.coins.length),
    y: Math.round(totals.y / cohort.coins.length),
  };
}

function constellationPath(cohort: AtlasCohort): string | null {
  const [first, ...rest] = cohort.coins;
  if (!first) return null;
  if (rest.length === 0) {
    const r = first.sizePx / 2 + 18;
    return `M ${first.x - r} ${first.y} C ${first.x - r} ${first.y - r * 0.66} ${first.x + r} ${first.y - r * 0.66} ${first.x + r} ${first.y}`;
  }

  return rest.reduce((path, coin, index) => {
    const previous = index === 0 ? first : rest[index - 1];
    const controlX = (previous.x + coin.x) / 2;
    const controlY = Math.min(previous.y, coin.y) - 22 - (index % 2) * 10;
    return `${path} Q ${controlX} ${controlY} ${coin.x} ${coin.y}`;
  }, `M ${first.x} ${first.y}`);
}

function cohortProjectionPath(
  island: AtlasIsland,
  center: { x: number; y: number },
  index: number,
  count: number,
): string {
  const target = tablePort(island, index, Math.max(1, count));
  const controlY = Math.min(center.y + 96, target.y - 32);
  return `M ${center.x} ${center.y + 18} C ${center.x} ${controlY} ${target.x} ${target.y - 78} ${target.x} ${target.y}`;
}

export function AltPegProjectionLayer({ model }: { model: LighthouseCinematicModel }) {
  const island = model.stage.modules.atlas;
  const active = island.isActive;
  const visibleCohorts = model.altPeg.skyCohorts.filter((cohort) => cohort.coins.length > 0);

  return (
    <g
      className={active ? "lh-alt-peg-layer lh-alt-peg-layer--active" : "lh-alt-peg-layer"}
      style={cssVars(island.colorHex)}
      aria-hidden="true"
    >
      <path className="lh-atlas-hotzone" d={projectionTablePath(island)} />
      <ellipse className="lh-atlas-table-shadow" cx={island.x} cy={island.y + 96} rx={island.rx * 0.7} ry="34" />
      <path className="lh-atlas-table-slab" d={projectionTablePath(island)} />
      <path className="lh-atlas-table-deck" d={projectionDeckPath(island)} />
      <g className="lh-atlas-grid" aria-hidden="true">
        {GRID_COLUMNS.map((column) => (
          <path key={`column-${column}`} className="lh-atlas-grid-line" d={gridColumnPath(island, column)} />
        ))}
        {GRID_ROWS.map((row) => (
          <path
            key={`row-${row}`}
            className="lh-atlas-grid-line lh-atlas-grid-line--row"
            d={gridRowPath(island, row)}
          />
        ))}
      </g>
      <g className="lh-atlas-constellation-field">
        {visibleCohorts.map((cohort, index) => {
          const center = cohortCenter(cohort);
          const path = constellationPath(cohort);
          if (!center || !path) return null;
          return (
            <g
              key={cohort.kind}
              className={`lh-atlas-cohort lh-atlas-cohort--${cohort.kind}`}
              style={cssVars(cohort.coins[0]?.colorHex ?? island.colorHex, index * -0.8)}
            >
              <path
                className="lh-atlas-cohort-downlink"
                d={cohortProjectionPath(island, center, index, visibleCohorts.length)}
              />
              <path className="lh-atlas-constellation-arc" d={path} />
              {cohort.coins.map((coin) => (
                <g key={coin.id} className="lh-atlas-sky-node" transform={`translate(${coin.x} ${coin.y})`}>
                  <circle className="lh-atlas-sky-node-halo" r={coin.sizePx / 2 + (cohort.kind === "sun" ? 15 : 9)} />
                  <circle className="lh-atlas-sky-node-core" r={coin.sizePx / 2} />
                </g>
              ))}
            </g>
          );
        })}
      </g>
      <g className="lh-atlas-cluster-field">
        {model.altPeg.clusters.map((cluster, index) => {
          const port = tablePort(island, index, model.altPeg.clusters.length);
          return (
            <g key={cluster.peg} className="lh-atlas-cluster" style={cssVars(cluster.colorHex, index * -0.55)}>
              <path className="lh-atlas-cluster-projection" d={clusterProjectionPath(cluster, port)} />
              <path className="lh-atlas-landmass" d={clusterLandPath(cluster, index)} />
              <path className="lh-atlas-coastline" d={clusterLandPath(cluster, index)} />
              <circle className="lh-atlas-cluster-anchor" cx={cluster.anchor.x} cy={cluster.anchor.y} r="6" />
              {cluster.coins.map((coin) => (
                <path key={`${coin.id}-tether`} className="lh-atlas-coin-tether" d={coinTetherPath(cluster, coin)} />
              ))}
              {cluster.coins.map((coin) => (
                <g key={coin.id} className="lh-atlas-coin-node" transform={`translate(${coin.x} ${coin.y})`}>
                  <circle className="lh-atlas-coin-halo" r={coin.sizePx / 2 + 7} />
                  <circle className="lh-atlas-coin-core" r={coin.sizePx / 2} />
                </g>
              ))}
            </g>
          );
        })}
      </g>
      <g className="lh-atlas-port-row">
        {model.altPeg.clusters.map((cluster, index) => {
          const port = tablePort(island, index, model.altPeg.clusters.length);
          return (
            <g key={cluster.peg} style={cssVars(cluster.colorHex)}>
              <line className="lh-atlas-port-stem" x1={port.x} y1={port.y + 120} x2={port.x} y2={port.y + 134} />
              <circle className="lh-atlas-port-light" cx={port.x} cy={port.y + 137} r="4.5" />
            </g>
          );
        })}
      </g>
      <path
        className="lh-atlas-table-rim"
        d={`M ${island.x - 254} ${island.y - 76} C ${island.x - 124} ${island.y - 134} ${island.x + 132} ${island.y - 134} ${island.x + 256} ${island.y - 76}`}
      />
      <path
        className="lh-atlas-scanline"
        d={`M ${island.x - 248} ${island.y - 78} C ${island.x - 112} ${island.y - 116} ${island.x + 114} ${island.y - 116} ${island.x + 248} ${island.y - 78}`}
      />
    </g>
  );
}
