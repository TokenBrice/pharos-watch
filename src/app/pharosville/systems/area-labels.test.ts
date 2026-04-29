import { describe, expect, it } from "vitest";
import { areaLabelPlacementForArea } from "./area-labels";
import { tileToIso } from "./projection";
import { DEWS_AREA_PLACEMENTS, RISK_WATER_AREAS } from "./risk-water-areas";
import { LIGHTHOUSE_TILE, terrainKindAt } from "./world-layout";
import type { AreaNode, DewsAreaBand, ShipRiskPlacement, TerrainKind } from "./world-types";

const WEST_TO_EAST_DEWS_BANDS: DewsAreaBand[] = ["CALM", "WATCH", "ALERT", "DANGER", "WARNING"];
const NON_DEWS_RISK_PLACEMENTS = ["ledger-mooring"] as const satisfies readonly ShipRiskPlacement[];

describe("areaLabelPlacementForArea", () => {
  it("keeps rendered DEWS labels ordered left-to-right around the lighthouse", () => {
    let previousIso: { x: number; y: number } | null = null;
    const isoByBand = new Map<DewsAreaBand, { x: number; y: number }>();
    const lighthouseIso = tileToIso(LIGHTHOUSE_TILE);

    for (const band of WEST_TO_EAST_DEWS_BANDS) {
      const area = dewsAreaNode(band);
      const anchor = areaLabelPlacementForArea(area).anchorTile;
      const iso = tileToIso(anchor);
      isoByBand.set(band, iso);

      if (previousIso) {
        expect(iso.x).toBeGreaterThan(previousIso.x);
      }
      previousIso = iso;
    }
    expect(isoByBand.get("WARNING")!.y).toBeLessThan(lighthouseIso.y);
    expect(isoByBand.get("WARNING")!.x).toBeGreaterThan(isoByBand.get("DANGER")!.x + 16);
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
