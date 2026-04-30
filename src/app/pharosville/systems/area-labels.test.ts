import { describe, expect, it } from "vitest";
import { areaLabelPlacementForArea } from "./area-labels";
import { tileToIso } from "./projection";
import { DEWS_AREA_PLACEMENTS, RISK_WATER_AREAS } from "./risk-water-areas";
import { LIGHTHOUSE_TILE, terrainKindAt } from "./world-layout";
import type { AreaNode, DewsAreaBand, ShipRiskPlacement, TerrainKind } from "./world-types";

const NON_DEWS_RISK_PLACEMENTS = ["ledger-mooring"] as const satisfies readonly ShipRiskPlacement[];

describe("areaLabelPlacementForArea", () => {
  it("keeps rendered DEWS labels in the authored map zones around the lighthouse", () => {
    const isoByBand = new Map<DewsAreaBand, { x: number; y: number }>();
    const lighthouseIso = tileToIso(LIGHTHOUSE_TILE);

    for (const band of ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"] as const satisfies readonly DewsAreaBand[]) {
      const area = dewsAreaNode(band);
      const anchor = areaLabelPlacementForArea(area).anchorTile;
      const iso = tileToIso(anchor);
      isoByBand.set(band, iso);
    }

    expect(isoByBand.get("CALM")!.x).toBeLessThan(isoByBand.get("ALERT")!.x);
    expect(isoByBand.get("WATCH")!.y).toBeLessThan(isoByBand.get("CALM")!.y);
    expect(isoByBand.get("WATCH")!.y).toBeLessThan(isoByBand.get("ALERT")!.y);
    expect(isoByBand.get("ALERT")!.x).toBeGreaterThan(lighthouseIso.x + 500);
    expect(isoByBand.get("WARNING")!.x).toBeGreaterThan(lighthouseIso.x + 500);
    expect(isoByBand.get("DANGER")!.x).toBeGreaterThan(lighthouseIso.x + 500);
    // Concentric east-corner rings: outer rings sit south-west of the corner
    // in iso projection, so DANGER (anchored to the corner) has the highest
    // iso.x and lowest iso.y, ALERT the inverse.
    expect(isoByBand.get("ALERT")!.x).toBeLessThan(isoByBand.get("WARNING")!.x);
    expect(isoByBand.get("WARNING")!.x).toBeLessThan(isoByBand.get("DANGER")!.x);
    expect(isoByBand.get("DANGER")!.y).toBeLessThan(isoByBand.get("WARNING")!.y);
    expect(isoByBand.get("WARNING")!.y).toBeLessThan(isoByBand.get("ALERT")!.y);
  });

  it("keeps non-DEWS risk water labels on their semantic water", () => {
    const expectedTerrains = {
      "ledger-mooring": "ledger-water",
    } as const satisfies Record<(typeof NON_DEWS_RISK_PLACEMENTS)[number], TerrainKind>;

    for (const placement of NON_DEWS_RISK_PLACEMENTS) {
      const area = riskWaterAreaNode(placement);
      const labelPlacement = areaLabelPlacementForArea(area);

      expect(terrainKindAt(labelPlacement.semanticTile.x, labelPlacement.semanticTile.y)).toBe(expectedTerrains[placement]);
      expect(terrainKindAt(labelPlacement.anchorTile.x, labelPlacement.anchorTile.y)).toBe(expectedTerrains[placement]);
    }
  });
});

function dewsAreaNode(band: DewsAreaBand): AreaNode {
  const area = RISK_WATER_AREAS[DEWS_AREA_PLACEMENTS[band]];
  return {
    id: `area.dews.${band.toLowerCase()}`,
    kind: "area",
    label: area.label,
    tile: area.labelTile,
    band,
    detailId: `area.dews.${band.toLowerCase()}`,
  };
}

function riskWaterAreaNode(placement: ShipRiskPlacement): AreaNode {
  const area = RISK_WATER_AREAS[placement];
  return {
    id: `area.risk-water.${placement}`,
    kind: "area",
    label: area.label,
    tile: area.labelTile,
    detailId: `area.risk-water.${placement}`,
    riskPlacement: placement,
    riskZone: area.motionZone,
  };
}
