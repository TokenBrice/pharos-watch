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
    regionTile: { x: 6, y: 30 },
    labelTile: { x: 6, y: 30 },
    terrain: "calm-water",
    validTerrains: ["calm-water"],
    waterStyle: "left-edge calm anchorage",
    motionZone: "calm",
    shipAnchors: [
      { x: 0, y: 15 },
      { x: 0, y: 27 },
      { x: 0, y: 39 },
      { x: 0, y: 45 },
      { x: 6, y: 20 },
      { x: 8, y: 32 },
      { x: 14, y: 42 },
    ],
    scatterRadius: { x: 7, y: 15 },
  },
  "breakwater-edge": {
    placement: "breakwater-edge",
    label: "Watch Breakwater",
    band: "WATCH",
    regionTile: { x: 28, y: 5 },
    labelTile: { x: 28, y: 5 },
    terrain: "watch-water",
    validTerrains: ["watch-water"],
    waterStyle: "top-edge watch breakwater",
    motionZone: "watch",
    shipAnchors: [
      { x: 6, y: 0 },
      { x: 16, y: 0 },
      { x: 28, y: 0 },
      { x: 34, y: 0 },
      { x: 35, y: 0 },
      { x: 8, y: 6 },
      { x: 24, y: 10 },
      { x: 35, y: 9 },
    ],
    scatterRadius: { x: 20, y: 5 },
  },
  "harbor-mouth-watch": {
    placement: "harbor-mouth-watch",
    label: "Alert Channel",
    band: "ALERT",
    regionTile: { x: 47, y: 14 },
    labelTile: { x: 47, y: 14 },
    terrain: "alert-water",
    validTerrains: ["alert-water"],
    waterStyle: "east-corner alert ring",
    motionZone: "alert",
    shipAnchors: [
      { x: 55, y: 12 },
      { x: 55, y: 14 },
      { x: 55, y: 17 },
      { x: 47, y: 14 },
      { x: 45, y: 12 },
      { x: 40, y: 0 },
      { x: 43, y: 0 },
    ],
    scatterRadius: { x: 8, y: 7 },
  },
  "outer-rough-water": {
    placement: "outer-rough-water",
    label: "Warning Shoals",
    band: "WARNING",
    regionTile: { x: 50, y: 8 },
    labelTile: { x: 50, y: 8 },
    terrain: "warning-water",
    validTerrains: ["warning-water"],
    waterStyle: "east-corner warning ring",
    motionZone: "warning",
    shipAnchors: [
      { x: 55, y: 8 },
      { x: 55, y: 11 },
      { x: 50, y: 8 },
      { x: 47, y: 0 },
      { x: 45, y: 0 },
      { x: 51, y: 9 },
      { x: 53, y: 9 },
    ],
    scatterRadius: { x: 5, y: 5 },
  },
  "storm-shelf": {
    placement: "storm-shelf",
    label: "Danger Strait",
    band: "DANGER",
    regionTile: { x: 54, y: 1 },
    labelTile: { x: 54, y: 1 },
    terrain: "storm-water",
    validTerrains: ["storm-water"],
    waterStyle: "east-corner danger core",
    motionZone: "danger",
    shipAnchors: [
      { x: 55, y: 0 },
      { x: 55, y: 3 },
      { x: 55, y: 5 },
      { x: 54, y: 1 },
      { x: 53, y: 2 },
      { x: 54, y: 4 },
      { x: 52, y: 0 },
    ],
    scatterRadius: { x: 4, y: 4 },
  },
  "ledger-mooring": {
    placement: "ledger-mooring",
    label: "Ledger Mooring",
    band: null,
    regionTile: { x: 47, y: 52 },
    labelTile: { x: 47, y: 52 },
    terrain: "ledger-water",
    validTerrains: ["ledger-water"],
    waterStyle: "south-corner NAV ledger mooring",
    motionZone: "ledger",
    shipAnchors: [
      { x: 55, y: 55 },
      { x: 55, y: 50 },
      { x: 50, y: 55 },
      { x: 45, y: 55 },
      { x: 50, y: 52 },
      { x: 45, y: 53 },
      { x: 43, y: 54 },
    ],
    scatterRadius: { x: 8, y: 5 },
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
