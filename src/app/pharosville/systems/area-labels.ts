import type { TilePoint } from "./projection";
import type { AreaNode, DewsAreaBand } from "./world-types";

export type AreaLabelAlign = "center" | "left" | "right";

export interface AreaLabelPlacement {
  align: AreaLabelAlign;
  dx: number;
  dy: number;
  hitboxHeight: number;
  maxWidth: number;
  rotation: number;
}

export interface ResolvedAreaLabelPlacement extends AreaLabelPlacement {
  anchorTile: TilePoint;
  semanticTile: TilePoint;
}

const DEFAULT_AREA_LABEL_PLACEMENT: AreaLabelPlacement = {
  align: "center",
  dx: 0,
  dy: 0,
  hitboxHeight: 28,
  maxWidth: 112,
  rotation: 0,
};

const AREA_LABEL_PLACEMENTS_BY_BAND: Partial<Record<DewsAreaBand, AreaLabelPlacement>> = {
  CALM: {
    align: "center",
    dx: 0.2,
    dy: -1.05,
    hitboxHeight: 30,
    maxWidth: 108,
    rotation: 0.04,
  },
  WATCH: {
    align: "center",
    dx: -2.25,
    dy: 0.15,
    hitboxHeight: 30,
    maxWidth: 116,
    rotation: -0.08,
  },
  ALERT: {
    align: "center",
    dx: -0.6,
    dy: -1.2,
    hitboxHeight: 30,
    maxWidth: 108,
    rotation: 0.08,
  },
  WARNING: {
    align: "center",
    dx: 3.8,
    dy: -3,
    hitboxHeight: 30,
    maxWidth: 124,
    rotation: -0.12,
  },
  DANGER: {
    align: "center",
    dx: 0,
    dy: 0,
    hitboxHeight: 32,
    maxWidth: 116,
    rotation: -0.18,
  },
};

const AREA_LABEL_PLACEMENTS_BY_DETAIL_ID: Record<string, AreaLabelPlacement> = {
  "area.risk-water.data-fog": {
    align: "center",
    dx: -0.25,
    dy: -0.85,
    hitboxHeight: 28,
    maxWidth: 92,
    rotation: -0.1,
  },
  "area.risk-water.ledger-mooring": {
    align: "center",
    dx: -0.4,
    dy: -0.9,
    hitboxHeight: 28,
    maxWidth: 118,
    rotation: 0.04,
  },
};

export function areaLabelPlacementForArea(area: AreaNode): ResolvedAreaLabelPlacement {
  const placement = AREA_LABEL_PLACEMENTS_BY_DETAIL_ID[area.detailId]
    ?? (area.band ? AREA_LABEL_PLACEMENTS_BY_BAND[area.band] : undefined)
    ?? DEFAULT_AREA_LABEL_PLACEMENT;

  return {
    ...placement,
    anchorTile: {
      x: area.tile.x + placement.dx,
      y: area.tile.y + placement.dy,
    },
    semanticTile: area.tile,
  };
}
