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
import {
  DOCK_TILES,
  LIGHTHOUSE_TILE,
  PHAROSVILLE_MAP_HEIGHT,
  PHAROSVILLE_MAP_WIDTH,
  isWaterTileKind,
  terrainKindAt,
} from "./world-layout";
import type { DewsAreaBand, ShipRiskPlacement } from "./world-types";

const LIGHTHOUSE_CLEARANCE = { minX: 14, maxX: 24, minY: 23, maxY: 32 } as const;

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
      expect(area.motionZone).toBe(band.toLowerCase());
    }
  });

  it("arranges DEWS sea zones around the authored island composition", () => {
    const lighthouseIso = tileToIso(LIGHTHOUSE_TILE);
    const isoByBand = new Map<DewsAreaBand, { x: number; y: number }>();
    for (const band of DEWS_AREA_BANDS) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]];
      isoByBand.set(band, tileToIso(area.labelTile));
    }
    const calm = isoByBand.get("CALM")!;
    const watch = isoByBand.get("WATCH")!;
    const alert = isoByBand.get("ALERT")!;
    const warning = isoByBand.get("WARNING")!;
    const danger = isoByBand.get("DANGER")!;

    // CALM lives left of every eastern DEWS band; WATCH lives at the top.
    expect(calm.x).toBeLessThan(alert.x);
    expect(calm.x).toBeLessThan(warning.x);
    expect(calm.x).toBeLessThan(danger.x);
    expect(watch.y).toBeLessThan(calm.y);
    expect(watch.y).toBeLessThan(alert.y);
    expect(watch.y).toBeLessThan(warning.y);
    expect(watch.y).toBeLessThan(danger.y);

    // The eastern DEWS cluster sits well east of the lighthouse approach.
    expect(alert.x).toBeGreaterThan(lighthouseIso.x + 500);
    expect(warning.x).toBeGreaterThan(lighthouseIso.x + 500);
    expect(danger.x).toBeGreaterThan(lighthouseIso.x + 500);

    // Concentric east-corner rings: tile distance to (55, 0) increases
    // DANGER → WARNING → ALERT, anchored at the eastern tip of the iso diamond.
    const eastCorner = { x: 55, y: 0 };
    const tileDist = (band: DewsAreaBand): number => {
      const tile = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]].labelTile;
      return Math.hypot(tile.x - eastCorner.x, tile.y - eastCorner.y);
    };
    expect(tileDist("DANGER")).toBeLessThan(tileDist("WARNING"));
    expect(tileDist("WARNING")).toBeLessThan(tileDist("ALERT"));

    // In iso projection, deeper rings recede south-westward from the corner:
    // DANGER has the highest iso.x and lowest iso.y; ALERT the inverse.
    expect(alert.x).toBeLessThan(warning.x);
    expect(warning.x).toBeLessThan(danger.x);
    expect(danger.y).toBeLessThan(warning.y);
    expect(warning.y).toBeLessThan(alert.y);
  });

  it("keeps Ledger Mooring as the only bottom sea exception zone", () => {
    const ledger = RISK_WATER_AREAS["ledger-mooring"];

    expect(ledger.regionTile).toEqual({ x: 47, y: 52 });
    expect(ledger.labelTile).toEqual({ x: 47, y: 52 });
    expect(ledger.terrain).toBe("ledger-water");
    expect(ledger.validTerrains).toEqual(["ledger-water"]);
    expect(minDistance([ledger.regionTile, ...ledger.shipAnchors], DOCK_TILES)).toBeGreaterThanOrEqual(5);
    // Snapped to the south corner of the iso diamond.
    expect(ledger.shipAnchors.some(
      (anchor) => anchor.x === PHAROSVILLE_MAP_WIDTH - 1 && anchor.y === PHAROSVILLE_MAP_HEIGHT - 1,
    )).toBe(true);
  });

  it("keeps named risk water out of the lighthouse mountain clearance lane", () => {
    for (const area of Object.values(RISK_WATER_AREAS)) {
      for (const tile of [area.regionTile, area.labelTile, ...area.shipAnchors]) {
        expect(isInLighthouseClearance(tile), `${area.placement} ${tile.x}.${tile.y}`).toBe(false);
      }
    }
  });

  it("keeps semantic water out of the lighthouse clearance lane", () => {
    for (let x = LIGHTHOUSE_CLEARANCE.minX; x <= LIGHTHOUSE_CLEARANCE.maxX; x += 1) {
      for (let y = LIGHTHOUSE_CLEARANCE.minY; y <= LIGHTHOUSE_CLEARANCE.maxY; y += 1) {
        const terrain = terrainKindAt(x, y);
        if (!isWaterTileKind(terrain)) continue;
        expect(terrain, `${x}.${y}`).toBe("water");
      }
    }
  });

  it("matches the authored DEWS placement diagram", () => {
    const expectedSamples = [
      { band: "CALM", tile: { x: 6, y: 30 }, terrain: "calm-water" },
      { band: "WATCH", tile: { x: 28, y: 5 }, terrain: "watch-water" },
      { band: "ALERT", tile: { x: 47, y: 14 }, terrain: "alert-water" },
      { band: "WARNING", tile: { x: 50, y: 8 }, terrain: "warning-water" },
      { band: "DANGER", tile: { x: 54, y: 1 }, terrain: "storm-water" },
    ] as const;

    for (const sample of expectedSamples) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[sample.band]];
      expect(area.regionTile).toEqual(sample.tile);
      expect(terrainKindAt(sample.tile.x, sample.tile.y)).toBe(sample.terrain);
    }

    // CALM occupies the left edge, WATCH owns the top breakwater,
    // and ALERT/WARNING/DANGER form concentric rings anchored at the
    // east corner (55, 0) — DANGER snapped tightly to the corner, with
    // WARNING and ALERT extending progressively west.
    expect(terrainKindAt(0, 27)).toBe("calm-water");
    expect(terrainKindAt(14, 42)).toBe("calm-water");
    expect(terrainKindAt(14, 0)).toBe("watch-water");
    expect(terrainKindAt(34, 0)).toBe("watch-water");
    expect(terrainKindAt(55, 0)).toBe("storm-water");
    expect(terrainKindAt(54, 0)).toBe("storm-water");
    expect(terrainKindAt(55, 8)).toBe("warning-water");
    expect(terrainKindAt(45, 0)).toBe("warning-water");
    expect(terrainKindAt(40, 0)).toBe("alert-water");
    expect(terrainKindAt(47, 14)).toBe("alert-water");
    expect(RISK_WATER_AREAS["ledger-mooring"].regionTile.y).toBeGreaterThan(45);
  });

  it("keeps every named sea zone in the same water component with edge-snapped ship anchors where required", () => {
    const component = connectedWaterTileKeys(RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS.CALM].labelTile);
    const edgeSnappedPlacements = new Set<ShipRiskPlacement>([
      "safe-harbor",
      "breakwater-edge",
      "harbor-mouth-watch",
      "outer-rough-water",
      "storm-shelf",
      "ledger-mooring",
    ]);

    for (const area of Object.values(RISK_WATER_AREAS)) {
      const authoredTiles = [area.regionTile, area.labelTile, ...area.shipAnchors];

      expect(component.has(tileKey(area.labelTile))).toBe(true);
      expect(component.has(tileKey(area.regionTile))).toBe(true);
      if (edgeSnappedPlacements.has(area.placement)) {
        expect(authoredTiles.some((tile) => isExactEdgeTile(tile)), area.placement).toBe(true);
      } else {
        expect(authoredTiles.every((tile) => !isExactEdgeTile(tile)), area.placement).toBe(true);
      }
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

  it("anchors edge-snapped DEWS zones to their authored map edges", () => {
    const expectedEdge: Partial<Record<DewsAreaBand, "x0" | "x55" | "y0" | "y55">> = {
      CALM: "x0",
      WATCH: "y0",
      ALERT: "x55",
      WARNING: "x55",
      DANGER: "x55",
    };
    const MAX = PHAROSVILLE_MAP_WIDTH - 1;

    for (const band of DEWS_AREA_BANDS) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]];
      const edge = expectedEdge[band];
      if (!edge) {
        expect([area.regionTile, area.labelTile, ...area.shipAnchors].every((tile) => !isExactEdgeTile(tile)), band).toBe(true);
        continue;
      }
      const onEdge = (tile: { x: number; y: number }): boolean => {
        if (edge === "x0") return tile.x === 0;
        if (edge === "x55") return tile.x === MAX;
        if (edge === "y0") return tile.y === 0;
        return tile.y === MAX;
      };
      const hasEdgeTile = area.shipAnchors.some(onEdge);
      expect(hasEdgeTile, `${band} should have at least one anchor on its primary edge ${edge}`).toBe(true);
    }
  });

  it("keeps the direct island periphery out of every zone", () => {
    // Tiles inside the generated island periphery should be land or generic
    // water, not DEWS-colored zone water.
    const peripherySamples = [
      { x: 32, y: 27 }, // adjacent to bridge step
      { x: 27, y: 35 }, // south of green step
      { x: 17, y: 40 }, // west of left column
      { x: 27, y: 41 }, // east of left column mid-section
      { x: 35, y: 18 }, // west of right column
    ];
    for (const tile of peripherySamples) {
      const terrain = terrainKindAt(tile.x, tile.y);
      const isZoneTerrain = ["calm-water", "watch-water", "alert-water", "warning-water", "storm-water"].includes(terrain);
      expect(isZoneTerrain, `${tile.x}.${tile.y} should be generic water, got ${terrain}`).toBe(false);
    }
  });

  it("clears the immediate periphery around the lighthouse sprite", () => {
    const lighthouseClearanceSamples = [
      { x: 14, y: 24 },
      { x: 14, y: 30 },
      { x: 16, y: 32 },
      { x: 13, y: 31 },
    ];
    for (const tile of lighthouseClearanceSamples) {
      const terrain = terrainKindAt(tile.x, tile.y);
      const isZoneTerrain = ["calm-water", "watch-water", "alert-water", "warning-water", "storm-water"].includes(terrain);
      expect(isZoneTerrain, `${tile.x}.${tile.y} should be generic water (lighthouse clearance), got ${terrain}`).toBe(false);
    }
  });

  it("sizes each zone proportionally to ship count", () => {
    const counts: Record<string, number> = {};
    for (let y = 0; y < PHAROSVILLE_MAP_HEIGHT; y += 1) {
      for (let x = 0; x < PHAROSVILLE_MAP_WIDTH; x += 1) {
        const t = terrainKindAt(x, y);
        counts[t] = (counts[t] ?? 0) + 1;
      }
    }
    expect(counts["calm-water"]).toBeGreaterThan(counts["watch-water"]);
    expect(counts["watch-water"]).toBeGreaterThan(counts["alert-water"]);
    expect(counts["alert-water"]).toBeGreaterThan(counts["warning-water"] ?? 0);
    expect(counts["alert-water"]).toBeGreaterThan(counts["storm-water"] ?? 0);
    expect(counts["warning-water"] ?? 0).toBeGreaterThanOrEqual(30);
    expect(counts["warning-water"] ?? 0).toBeLessThanOrEqual(125);
    expect(counts["storm-water"] ?? 0).toBeGreaterThanOrEqual(30);
    expect(counts["storm-water"] ?? 0).toBeLessThanOrEqual(100);
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
    if (!isWaterTileKind(terrain)) continue;
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

function isInLighthouseClearance(tile: { x: number; y: number }): boolean {
  return tile.x >= LIGHTHOUSE_CLEARANCE.minX
    && tile.x <= LIGHTHOUSE_CLEARANCE.maxX
    && tile.y >= LIGHTHOUSE_CLEARANCE.minY
    && tile.y <= LIGHTHOUSE_CLEARANCE.maxY;
}

function isExactEdgeTile(tile: { x: number; y: number }): boolean {
  return tile.x === 0
    || tile.y === 0
    || tile.x === PHAROSVILLE_MAP_WIDTH - 1
    || tile.y === PHAROSVILLE_MAP_HEIGHT - 1;
}

function tileKey(tile: { x: number; y: number }): string {
  return `${tile.x}.${tile.y}`;
}

function minDistance(
  first: readonly { x: number; y: number }[],
  second: readonly { x: number; y: number }[],
): number {
  let result = Number.POSITIVE_INFINITY;
  for (const a of first) {
    for (const b of second) {
      result = Math.min(result, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return result;
}
