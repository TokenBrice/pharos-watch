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
    dx: -0.4,
    dy: 0.3,
    hitboxHeight: 30,
    maxWidth: 126,
    rotation: 0.02,
  },
  WATCH: {
    align: "center",
    dx: 0,
    dy: -0.4,
    hitboxHeight: 30,
    maxWidth: 132,
    rotation: -0.04,
  },
  ALERT: {
    align: "center",
    dx: 0,
    dy: 0,
    hitboxHeight: 24,
    maxWidth: 112,
    rotation: 0.02,
  },
  WARNING: {
    align: "center",
    dx: 0,
    dy: 0,
    hitboxHeight: 28,
    maxWidth: 110,
    rotation: -0.04,
  },
  DANGER: {
    align: "center",
    dx: 0,
    dy: 0,
    hitboxHeight: 28,
    maxWidth: 110,
    rotation: -0.06,
  },
};

const AREA_LABEL_PLACEMENTS_BY_DETAIL_ID: Record<string, AreaLabelPlacement> = {
  "area.risk-water.ledger-mooring": {
    align: "center",
    dx: 0,
    dy: -0.6,
    hitboxHeight: 28,
    maxWidth: 132,
    rotation: 0.02,
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
