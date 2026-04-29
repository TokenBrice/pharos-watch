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
    regionTile: { x: 12, y: 32 },
    labelTile: { x: 8, y: 35 },
    terrain: "calm-water",
    validTerrains: ["calm-water"],
    waterStyle: "calm dew anchorage",
    motionZone: "calm",
    shipAnchors: [
      { x: 5, y: 30 },
      { x: 7, y: 35 },
      { x: 12, y: 33 },
      { x: 16, y: 31 },
      { x: 18, y: 36 },
      { x: 21, y: 38 },
      { x: 7, y: 43 },
      { x: 15, y: 44 },
    ],
    scatterRadius: { x: 10, y: 7 },
  },
  "breakwater-edge": {
    placement: "breakwater-edge",
    label: "Watch Breakwater",
    band: "WATCH",
    regionTile: { x: 14, y: 17 },
    labelTile: { x: 12, y: 14 },
    terrain: "watch-water",
    validTerrains: ["watch-water"],
    waterStyle: "breakwater watch water",
    motionZone: "watch",
    shipAnchors: [
      { x: 6, y: 10 },
      { x: 9, y: 14 },
      { x: 12, y: 18 },
      { x: 16, y: 16 },
      { x: 20, y: 20 },
      { x: 24, y: 18 },
    ],
    scatterRadius: { x: 4, y: 3 },
  },
  "harbor-mouth-watch": {
    placement: "harbor-mouth-watch",
    label: "Alert Channel",
    band: "ALERT",
    regionTile: { x: 25, y: 12 },
    labelTile: { x: 25, y: 12 },
    terrain: "alert-water",
    validTerrains: ["alert-water"],
    waterStyle: "alert channel current",
    motionZone: "alert",
    shipAnchors: [
      { x: 23, y: 11 },
      { x: 26, y: 9 },
      { x: 25, y: 12 },
      { x: 28, y: 13 },
      { x: 31, y: 11 },
      { x: 32, y: 14 },
    ],
    scatterRadius: { x: 3, y: 3 },
  },
  "outer-rough-water": {
    placement: "outer-rough-water",
    label: "Warning Shoals",
    band: "WARNING",
    regionTile: { x: 38, y: 6 },
    labelTile: { x: 38, y: 6 },
    terrain: "warning-water",
    validTerrains: ["warning-water"],
    waterStyle: "warning shoals",
    motionZone: "warning",
    shipAnchors: [
      { x: 35, y: 6 },
      { x: 37, y: 4 },
      { x: 38, y: 8 },
      { x: 41, y: 6 },
      { x: 43, y: 9 },
    ],
    scatterRadius: { x: 3, y: 3 },
  },
  "storm-shelf": {
    placement: "storm-shelf",
    label: "Danger Strait",
    band: "DANGER",
    regionTile: { x: 50, y: 4 },
    labelTile: { x: 50, y: 4 },
    terrain: "storm-water",
    validTerrains: ["storm-water"],
    waterStyle: "storm strait",
    motionZone: "danger",
    shipAnchors: [
      { x: 46, y: 4 },
      { x: 48, y: 2 },
      { x: 48, y: 5 },
      { x: 50, y: 4 },
      { x: 51, y: 2 },
      { x: 52, y: 5 },
    ],
    scatterRadius: { x: 2, y: 2 },
  },
  "data-fog": {
    placement: "data-fog",
    label: "Data Fog",
    band: null,
    regionTile: { x: 50, y: 49 },
    labelTile: { x: 50, y: 49 },
    terrain: "brackish-water",
    validTerrains: ["brackish-water"],
    waterStyle: "stale data fog",
    motionZone: "fog",
    shipAnchors: [
      { x: 47, y: 48 },
      { x: 49, y: 50 },
      { x: 50, y: 49 },
      { x: 52, y: 51 },
      { x: 53, y: 49 },
    ],
    scatterRadius: { x: 3, y: 2 },
  },
  "ledger-mooring": {
    placement: "ledger-mooring",
    label: "Ledger Mooring",
    band: null,
    regionTile: { x: 43, y: 49 },
    labelTile: { x: 43, y: 49 },
    terrain: "ledger-water",
    validTerrains: ["ledger-water"],
    waterStyle: "NAV ledger mooring",
    motionZone: "ledger",
    shipAnchors: [
      { x: 40, y: 48 },
      { x: 42, y: 50 },
      { x: 43, y: 49 },
      { x: 45, y: 48 },
      { x: 46, y: 50 },
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
