import type { DewsAreaBand, ShipRiskPlacement, ShipWaterZone, TerrainKind } from "./world-types";

type TileCoordinate = { x: number; y: number };

export interface RiskWaterAreaDefinition {
  placement: ShipRiskPlacement;
  label: string;
  band: DewsAreaBand | null;
  regionTile: TileCoordinate;
  labelTile: TileCoordinate;
  terrain: TerrainKind;
  validTerrains: readonly TerrainKind[] | "any-water";
  waterStyle: string;
  motionZone: ShipWaterZone;
  shipAnchors: readonly TileCoordinate[];
  scatterRadius: TileCoordinate;
}

export const SHIP_RISK_PLACEMENTS = [
  "safe-harbor",
  "breakwater-edge",
  "harbor-mouth-watch",
  "outer-rough-water",
  "storm-shelf",
  "data-fog",
  "ledger-mooring",
] as const satisfies readonly ShipRiskPlacement[];

export const DEWS_AREA_BANDS = [
  "DANGER",
  "WARNING",
  "ALERT",
  "WATCH",
  "CALM",
] as const satisfies readonly DewsAreaBand[];

export const DEWS_AREA_PLACEMENTS: Record<DewsAreaBand, ShipRiskPlacement> = {
  DANGER: "storm-shelf",
  WARNING: "outer-rough-water",
  ALERT: "harbor-mouth-watch",
  WATCH: "breakwater-edge",
  CALM: "safe-harbor",
};

export const RISK_WATER_AREAS: Record<ShipRiskPlacement, RiskWaterAreaDefinition> = {
  "safe-harbor": {
    placement: "safe-harbor",
    label: "Calm Anchorage",
    band: "CALM",
    regionTile: { x: 15, y: 31 },
    labelTile: { x: 10, y: 34 },
    terrain: "calm-water",
    validTerrains: ["calm-water"],
    waterStyle: "calm dew anchorage",
    motionZone: "calm",
    shipAnchors: [
      { x: 5, y: 30 },
      { x: 7, y: 35 },
      { x: 8, y: 31 },
      { x: 9, y: 25 },
      { x: 11, y: 27 },
      { x: 5, y: 24 },
      { x: 13, y: 35 },
      { x: 16, y: 31 },
      { x: 17, y: 25 },
      { x: 6, y: 38 },
      { x: 20, y: 33 },
      { x: 22, y: 28 },
      { x: 21, y: 38 },
      { x: 11, y: 39 },
      { x: 12, y: 33 },
      { x: 18, y: 36 },
      { x: 14, y: 24 },
    ],
    scatterRadius: { x: 10, y: 7 },
  },
  "breakwater-edge": {
    placement: "breakwater-edge",
    label: "Watch Breakwater",
    band: "WATCH",
    regionTile: { x: 24, y: 22 },
    labelTile: { x: 23, y: 22 },
    terrain: "watch-water",
    validTerrains: ["watch-water"],
    waterStyle: "breakwater watch water",
    motionZone: "watch",
    shipAnchors: [
      { x: 21, y: 22 },
      { x: 23, y: 19 },
      { x: 23, y: 25 },
      { x: 24, y: 22 },
      { x: 26, y: 24 },
      { x: 27, y: 23 },
      { x: 29, y: 22 },
    ],
    scatterRadius: { x: 4, y: 3 },
  },
  "harbor-mouth-watch": {
    placement: "harbor-mouth-watch",
    label: "Alert Channel",
    band: "ALERT",
    regionTile: { x: 30, y: 16 },
    labelTile: { x: 30, y: 16 },
    terrain: "alert-water",
    validTerrains: ["alert-water"],
    waterStyle: "alert channel current",
    motionZone: "alert",
    shipAnchors: [
      { x: 27, y: 16 },
      { x: 28, y: 13 },
      { x: 29, y: 19 },
      { x: 30, y: 16 },
      { x: 31, y: 13 },
      { x: 33, y: 17 },
      { x: 34, y: 15 },
    ],
    scatterRadius: { x: 3, y: 3 },
  },
  "outer-rough-water": {
    placement: "outer-rough-water",
    label: "Warning Shoals",
    band: "WARNING",
    regionTile: { x: 31, y: 9 },
    labelTile: { x: 31, y: 9 },
    terrain: "warning-water",
    validTerrains: ["warning-water"],
    waterStyle: "warning shoals",
    motionZone: "warning",
    shipAnchors: [
      { x: 28, y: 9 },
      { x: 29, y: 6 },
      { x: 30, y: 12 },
      { x: 31, y: 9 },
      { x: 33, y: 11 },
      { x: 34, y: 10 },
    ],
    scatterRadius: { x: 3, y: 3 },
  },
  "storm-shelf": {
    placement: "storm-shelf",
    label: "Danger Strait",
    band: "DANGER",
    regionTile: { x: 34, y: 4 },
    labelTile: { x: 34, y: 4 },
    terrain: "storm-water",
    validTerrains: ["storm-water"],
    waterStyle: "storm strait",
    motionZone: "danger",
    shipAnchors: [
      { x: 31, y: 4 },
      { x: 33, y: 2 },
      { x: 34, y: 4 },
      { x: 35, y: 6 },
      { x: 36, y: 3 },
      { x: 38, y: 5 },
    ],
    scatterRadius: { x: 2, y: 2 },
  },
  "data-fog": {
    placement: "data-fog",
    label: "Data Fog",
    band: null,
    regionTile: { x: 8, y: 17 },
    labelTile: { x: 8, y: 17 },
    terrain: "brackish-water",
    validTerrains: ["brackish-water", "fog-water"],
    waterStyle: "stale data fog",
    motionZone: "fog",
    shipAnchors: [
      { x: 5, y: 17 },
      { x: 7, y: 21 },
      { x: 8, y: 15 },
      { x: 10, y: 18 },
      { x: 12, y: 16 },
    ],
    scatterRadius: { x: 3, y: 3 },
  },
  "ledger-mooring": {
    placement: "ledger-mooring",
    label: "Ledger Mooring",
    band: null,
    regionTile: { x: 20, y: 29 },
    labelTile: { x: 20, y: 29 },
    terrain: "calm-water",
    validTerrains: ["calm-water"],
    waterStyle: "NAV ledger mooring",
    motionZone: "ledger",
    shipAnchors: [
      { x: 18, y: 29 },
      { x: 20, y: 28 },
      { x: 21, y: 31 },
      { x: 19, y: 30 },
    ],
    scatterRadius: { x: 3, y: 2 },
  },
};

function mapRiskWaterAreas<T>(select: (area: RiskWaterAreaDefinition) => T): Record<ShipRiskPlacement, T> {
  return Object.fromEntries(
    SHIP_RISK_PLACEMENTS.map((placement) => [placement, select(RISK_WATER_AREAS[placement])]),
  ) as Record<ShipRiskPlacement, T>;
}

function mapDewsAreas<T>(select: (area: RiskWaterAreaDefinition, band: DewsAreaBand) => T): Record<DewsAreaBand, T> {
  return Object.fromEntries(
    DEWS_AREA_BANDS.map((band) => {
      const placement = DEWS_AREA_PLACEMENTS[band];
      return [band, select(RISK_WATER_AREAS[placement], band)];
    }),
  ) as Record<DewsAreaBand, T>;
}

export const RISK_WATER_REGION_TILES = mapRiskWaterAreas((area) => area.regionTile);
export const SHIP_WATER_ANCHORS = mapRiskWaterAreas((area) => area.shipAnchors);
export const SHIP_SCATTER_RADIUS = mapRiskWaterAreas((area) => area.scatterRadius);
export const AREA_LABEL_TILES = mapDewsAreas((area) => area.labelTile);
export const DEWS_AREA_LABELS = mapDewsAreas((area) => area.label);
export const DEWS_AREA_WATER_STYLE = mapDewsAreas((area) => area.waterStyle);

export function riskWaterAreaForPlacement(placement: ShipRiskPlacement): RiskWaterAreaDefinition {
  return RISK_WATER_AREAS[placement];
}

export function dewsAreaPlacementForBand(band: string | null | undefined): ShipRiskPlacement | null {
  const normalized = band?.toUpperCase();
  if (!normalized || !(normalized in DEWS_AREA_PLACEMENTS)) return null;
  return DEWS_AREA_PLACEMENTS[normalized as DewsAreaBand];
}

export function waterZoneForPlacement(placement: ShipRiskPlacement): ShipWaterZone {
  return RISK_WATER_AREAS[placement].motionZone;
}
