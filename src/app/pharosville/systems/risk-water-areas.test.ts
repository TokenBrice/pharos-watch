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
  riskWaterAreaForPlacement,
  waterZoneForPlacement,
} from "./risk-water-areas";
import { isWaterTileKind, terrainKindAt } from "./world-layout";
import type { DewsAreaBand } from "./world-types";

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

    for (const band of DEWS_AREA_BANDS) {
      const placement = DEWS_AREA_PLACEMENTS[band];
      const area = RISK_WATER_AREAS[placement];

      expect(area.band).toBe(band);
      expect(DEWS_AREA_LABELS[band]).toBe(expectedLabels[band]);
      expect(AREA_LABEL_TILES[band]).toBe(area.labelTile);
      expect(DEWS_AREA_WATER_STYLE[band]).toBe(area.waterStyle);
      expect(isWaterTileKind(terrainKindAt(area.labelTile.x, area.labelTile.y))).toBe(true);
    }
  });

  it("keeps authored region tiles and anchors on matching water terrain", () => {
    for (const placement of SHIP_RISK_PLACEMENTS) {
      const area = RISK_WATER_AREAS[placement];

      expect(terrainKindAt(area.regionTile.x, area.regionTile.y)).toBe(area.terrain);
      for (const anchor of area.shipAnchors) {
        expect(
          isWaterTileKind(terrainKindAt(anchor.x, anchor.y)),
          `${placement} anchor ${anchor.x}.${anchor.y} should remain water`,
        ).toBe(true);
      }
    }
  });
});

