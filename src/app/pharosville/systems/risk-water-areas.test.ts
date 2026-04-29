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
import type { DewsAreaBand } from "./world-types";

const WEST_TO_EAST_DEWS_BANDS: DewsAreaBand[] = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];
const LIGHTHOUSE_CLEARANCE = { minX: 30, maxX: 45, minY: 26, maxY: 34 } as const;

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

  it("orders DEWS sea zones left-to-right while routing severe zones around the lighthouse", () => {
    let previousIso: { x: number; y: number } | null = null;
    const isoByBand = new Map<DewsAreaBand, { x: number; y: number }>();
    const lighthouseIso = tileToIso(LIGHTHOUSE_TILE);
    for (const band of WEST_TO_EAST_DEWS_BANDS) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]];
      const iso = tileToIso(area.labelTile);
      isoByBand.set(band, iso);

      if (previousIso) {
        expect(iso.x).toBeGreaterThan(previousIso.x);
      }
      previousIso = iso;
    }
    expect(isoByBand.get("WARNING")!.x).toBeGreaterThanOrEqual(lighthouseIso.x + 96);
    expect(isoByBand.get("DANGER")!.x).toBeGreaterThan(isoByBand.get("WARNING")!.x + 96);
  });

  it("keeps Ledger Mooring as the only bottom sea exception zone", () => {
    const ledger = RISK_WATER_AREAS["ledger-mooring"];

    expect(ledger.regionTile).toEqual({ x: 43, y: 49 });
    expect(ledger.labelTile).toEqual({ x: 43, y: 49 });
    expect(ledger.terrain).toBe("ledger-water");
    expect(ledger.validTerrains).toEqual(["ledger-water"]);
    expect(minDistance([ledger.regionTile, ...ledger.shipAnchors], DOCK_TILES)).toBeGreaterThanOrEqual(5);
    expect(ledger.shipAnchors.some((anchor) => anchor.y === PHAROSVILLE_MAP_HEIGHT - 1)).toBe(true);
  });

  it("keeps named risk water out of the lighthouse west/south clearance lane", () => {
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
      { band: "CALM", tile: { x: 8, y: 29 }, terrain: "calm-water" },
      { band: "WATCH", tile: { x: 23, y: 14 }, terrain: "watch-water" },
      { band: "ALERT", tile: { x: 35, y: 10 }, terrain: "alert-water" },
      { band: "WARNING", tile: { x: 47, y: 16 }, terrain: "warning-water" },
      { band: "DANGER", tile: { x: 54, y: 18 }, terrain: "storm-water" },
    ] as const;

    for (const sample of expectedSamples) {
      const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[sample.band]];
      expect(area.regionTile).toEqual(sample.tile);
      expect(terrainKindAt(sample.tile.x, sample.tile.y)).toBe(sample.terrain);
    }

    expect(terrainKindAt(0, 28)).toBe("calm-water");
    expect(terrainKindAt(24, 0)).toBe("watch-water");
    expect(terrainKindAt(35, 0)).toBe("alert-water");
    expect(terrainKindAt(54, 10)).toBe("warning-water");
    expect(terrainKindAt(55, 14)).toBe("storm-water");
    expect(RISK_WATER_AREAS["ledger-mooring"].regionTile.y).toBeGreaterThan(45);
  });

  it("keeps every named sea zone attached to the map edge and in the same water component", () => {
    const component = connectedWaterTileKeys(RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS.CALM].labelTile);

    for (const area of Object.values(RISK_WATER_AREAS)) {
      const authoredTiles = [area.regionTile, area.labelTile, ...area.shipAnchors];

      expect(component.has(tileKey(area.labelTile))).toBe(true);
      expect(component.has(tileKey(area.regionTile))).toBe(true);
      expect(authoredTiles.some((tile) => isEdgeAdjacent(tile)), area.placement).toBe(true);
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

function isEdgeAdjacent(tile: { x: number; y: number }): boolean {
  return tile.x <= 1
    || tile.y <= 1
    || tile.x >= PHAROSVILLE_MAP_WIDTH - 2
    || tile.y >= PHAROSVILLE_MAP_HEIGHT - 2;
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
