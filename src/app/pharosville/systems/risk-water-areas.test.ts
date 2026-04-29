import { describe, expect, it } from "vitest";
import {
  AREA_LABEL_TILES,
  DEWS_AREA_BANDS,
  DEWS_AREA_LABELS,
  DEWS_AREA_PLACEMENTS,
  DEWS_AREA_WATER_STYLE,
  RISK_WATER_AREAS,
  RISK_WATER_REGION_TILES,
  SHIP_RISK_PLACEMENTS,
  SHIP_SCATTER_RADIUS,
  SHIP_WATER_ANCHORS,
  dewsAreaPlacementForBand,
  riskWaterAreaForPlacement,
  waterZoneForPlacement,
} from "./risk-water-areas";
import { tileToIso } from "./projection";
import { PHAROSVILLE_MAP_HEIGHT, PHAROSVILLE_MAP_WIDTH, isWaterTileKind, terrainKindAt } from "./world-layout";
import type { DewsAreaBand } from "./world-types";

const WEST_TO_EAST_DEWS_BANDS: DewsAreaBand[] = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];

describe("risk water areas", () => {
  it("defines one source of truth for every ship risk placement", () => {
    expect(Object.keys(RISK_WATER_AREAS).sort()).toEqual([...SHIP_RISK_PLACEMENTS].sort());

    for (const placement of SHIP_RISK_PLACEMENTS) {
      const area = riskWaterAreaForPlacement(placement);

      expect(area.placement).toBe(placement);
      expect(area.label.length).toBeGreaterThan(0);
      expect(area.waterStyle.length).toBeGreaterThan(0);
      expect(area.shipAnchors.length).toBeGreaterThan(0);
      expect(area.scatterRadius.x).toBeGreaterThan(0);
      expect(area.scatterRadius.y).toBeGreaterThan(0);
      expect(RISK_WATER_REGION_TILES[placement]).toBe(area.regionTile);
      expect(SHIP_WATER_ANCHORS[placement]).toBe(area.shipAnchors);
      expect(SHIP_SCATTER_RADIUS[placement]).toBe(area.scatterRadius);
      expect(waterZoneForPlacement(placement)).toBe(area.motionZone);
    }
  });

  it("keeps DEWS band labels, tiles, styles, and placements in sync", () => {
    const expectedLabels: Record<DewsAreaBand, string> = {
      DANGER: "Danger Strait",
      WARNING: "Warning Shoals",
      ALERT: "Alert Channel",
      WATCH: "Watch Breakwater",
      CALM: "Calm Anchorage",
    };

    expect(Object.keys(DEWS_AREA_PLACEMENTS)).toEqual([...DEWS_AREA_BANDS]);
    for (const band of DEWS_AREA_BANDS) {
      const placement = DEWS_AREA_PLACEMENTS[band];
      const area = RISK_WATER_AREAS[placement];

      expect(area.band).toBe(band);
      expect(dewsAreaPlacementForBand(band.toLowerCase())).toBe(placement);
      expect(DEWS_AREA_LABELS[band]).toBe(expectedLabels[band]);
      expect(AREA_LABEL_TILES[band]).toBe(area.labelTile);
      expect(DEWS_AREA_WATER_STYLE[band]).toBe(area.waterStyle);
      expect(terrainKindAt(area.labelTile.x, area.labelTile.y)).toBe(area.terrain);
    }
  });

  it("orders DEWS sea zones left-to-right and upward in the northern water block", () => {
    let previousIso: { x: number; y: number } | null = null;
    for (const band of WEST_TO_EAST_DEWS_BANDS) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]];
      const iso = tileToIso(area.labelTile);

      expect(area.labelTile.x + area.labelTile.y).toBeLessThanOrEqual(50);
      if (previousIso) {
        expect(iso.x).toBeGreaterThan(previousIso.x);
        expect(iso.y).toBeLessThan(previousIso.y);
      }
      previousIso = iso;
    }
  });

  it("keeps every DEWS zone in the same continuous northern sea component", () => {
    const component = connectedWaterTileKeys(RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS.CALM].labelTile);

    for (const band of WEST_TO_EAST_DEWS_BANDS) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]];

      expect(component.has(tileKey(area.labelTile))).toBe(true);
      expect(component.has(tileKey(area.regionTile))).toBe(true);
    }
  });

  it("keeps authored region tiles and anchors on matching water terrain", () => {
    for (const placement of SHIP_RISK_PLACEMENTS) {
      const area = RISK_WATER_AREAS[placement];

      expect(terrainKindAt(area.regionTile.x, area.regionTile.y)).toBe(area.terrain);
      if (area.validTerrains !== "any-water") {
        expect(area.validTerrains).toContain(area.terrain);
      }
      for (const anchor of area.shipAnchors) {
        const terrain = terrainKindAt(anchor.x, anchor.y);
        if (area.validTerrains === "any-water") {
          expect(
            isWaterTileKind(terrain),
            `${placement} anchor ${anchor.x}.${anchor.y} should remain water`,
          ).toBe(true);
        } else {
          expect(
            area.validTerrains,
            `${placement} anchor ${anchor.x}.${anchor.y} should stay in ${area.validTerrains.join(", ")}`,
          ).toContain(terrain);
        }
      }
    }
  });
});

function connectedWaterTileKeys(start: { x: number; y: number }): Set<string> {
  const visited = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    const tile = queue.shift();
    if (!tile) continue;
    if (tile.x < 0 || tile.x >= PHAROSVILLE_MAP_WIDTH || tile.y < 0 || tile.y >= PHAROSVILLE_MAP_HEIGHT) continue;
    const terrain = terrainKindAt(tile.x, tile.y);
    if (terrain === "frozen-water" || !isWaterTileKind(terrain)) continue;
    const key = tileKey(tile);
    if (visited.has(key)) continue;

    visited.add(key);
    queue.push(
      { x: tile.x + 1, y: tile.y },
      { x: tile.x - 1, y: tile.y },
      { x: tile.x, y: tile.y + 1 },
      { x: tile.x, y: tile.y - 1 },
    );
  }

  return visited;
}

function tileKey(tile: { x: number; y: number }): string {
  return `${tile.x}.${tile.y}`;
}
