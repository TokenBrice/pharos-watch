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
    regionTile: { x: 30, y: 42 },
    labelTile: { x: 30, y: 42 },
    terrain: "harbor-water",
    validTerrains: "any-water",
    waterStyle: "calm harbor water",
    motionZone: "safe",
    shipAnchors: [
      { x: 16, y: 27 },
      { x: 22, y: 20 },
      { x: 31, y: 19 },
      { x: 47, y: 17 },
      { x: 49, y: 31 },
      { x: 47, y: 36 },
      { x: 40, y: 43 },
      { x: 31, y: 44 },
      { x: 22, y: 43 },
      { x: 18, y: 35 },
    ],
    scatterRadius: { x: 5, y: 4 },
  },
  "breakwater-edge": {
    placement: "breakwater-edge",
    label: "Watch Breakwater",
    band: "WATCH",
    regionTile: { x: 27, y: 44 },
    labelTile: { x: 27, y: 44 },
    terrain: "water",
    validTerrains: "any-water",
    waterStyle: "breakwater watch water",
    motionZone: "safe",
    shipAnchors: [
      { x: 21, y: 22 },
      { x: 27, y: 20 },
      { x: 38, y: 18 },
      { x: 47, y: 25 },
      { x: 49, y: 38 },
      { x: 40, y: 43 },
      { x: 27, y: 44 },
    ],
    scatterRadius: { x: 4, y: 3 },
  },
  "harbor-mouth-watch": {
    placement: "harbor-mouth-watch",
    label: "Alert Channel",
    band: "ALERT",
    regionTile: { x: 40, y: 44 },
    labelTile: { x: 40, y: 44 },
    terrain: "alert-water",
    validTerrains: ["alert-water"],
    waterStyle: "alert channel current",
    motionZone: "muddy",
    shipAnchors: [
      { x: 39, y: 43 },
      { x: 40, y: 43 },
      { x: 41, y: 43 },
      { x: 39, y: 44 },
      { x: 40, y: 44 },
      { x: 42, y: 45 },
      { x: 38, y: 45 },
      { x: 37, y: 46 },
    ],
    scatterRadius: { x: 4, y: 3 },
  },
  "outer-rough-water": {
    placement: "outer-rough-water",
    label: "Warning Shoals",
    band: "WARNING",
    regionTile: { x: 48, y: 45 },
    labelTile: { x: 49, y: 46 },
    terrain: "warning-water",
    validTerrains: ["warning-water"],
    waterStyle: "warning shoals",
    motionZone: "muddy",
    shipAnchors: [
      { x: 45, y: 44 },
      { x: 46, y: 45 },
      { x: 47, y: 43 },
      { x: 49, y: 46 },
      { x: 50, y: 48 },
      { x: 48, y: 49 },
      { x: 53, y: 44 },
      { x: 54, y: 46 },
    ],
    scatterRadius: { x: 5, y: 5 },
  },
  "storm-shelf": {
    placement: "storm-shelf",
    label: "Danger Strait",
    band: "DANGER",
    regionTile: { x: 52, y: 52 },
    labelTile: { x: 55, y: 53 },
    terrain: "storm-water",
    validTerrains: ["storm-water"],
    waterStyle: "storm strait",
    motionZone: "storm",
    shipAnchors: [
      { x: 51, y: 52 },
      { x: 52, y: 53 },
      { x: 53, y: 53 },
      { x: 54, y: 49 },
      { x: 49, y: 54 },
      { x: 54, y: 54 },
    ],
    scatterRadius: { x: 5, y: 5 },
  },
  "data-fog": {
    placement: "data-fog",
    label: "Data Fog",
    band: null,
    regionTile: { x: 10, y: 16 },
    labelTile: { x: 10, y: 16 },
    terrain: "brackish-water",
    validTerrains: ["brackish-water", "fog-water"],
    waterStyle: "stale data fog",
    motionZone: "fog",
    shipAnchors: [
      { x: 10, y: 16 },
      { x: 8, y: 24 },
      { x: 14, y: 20 },
      { x: 7, y: 12 },
      { x: 18, y: 18 },
    ],
    scatterRadius: { x: 5, y: 4 },
  },
  "ledger-mooring": {
    placement: "ledger-mooring",
    label: "Ledger Mooring",
    band: null,
    regionTile: { x: 34, y: 43 },
    labelTile: { x: 34, y: 43 },
    terrain: "harbor-water",
    validTerrains: "any-water",
    waterStyle: "NAV ledger mooring",
    motionZone: "ledger",
    shipAnchors: [
      { x: 35, y: 43 },
      { x: 34, y: 43 },
      { x: 40, y: 43 },
      { x: 29, y: 44 },
    ],
    scatterRadius: { x: 4, y: 3 },
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
