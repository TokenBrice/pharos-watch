import { describe, expect, it } from "vitest";
import { areaLabelPlacementForArea } from "./area-labels";
import { tileToIso } from "./projection";
import { DEWS_AREA_PLACEMENTS, RISK_WATER_AREAS } from "./risk-water-areas";
import { terrainKindAt } from "./world-layout";
import type { AreaNode, DewsAreaBand, ShipRiskPlacement } from "./world-types";

const WEST_TO_EAST_DEWS_BANDS: DewsAreaBand[] = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];
const NON_DEWS_RISK_PLACEMENTS = ["data-fog", "ledger-mooring"] as const satisfies readonly ShipRiskPlacement[];

describe("areaLabelPlacementForArea", () => {
  it("keeps rendered DEWS labels ordered left-to-right with warning and danger northward", () => {
    let previousIso: { x: number; y: number } | null = null;
    const isoByBand = new Map<DewsAreaBand, { x: number; y: number }>();

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
    expect(isoByBand.get("WARNING")!.y).toBeLessThan(isoByBand.get("ALERT")!.y);
    expect(isoByBand.get("DANGER")!.y).toBeLessThanOrEqual(isoByBand.get("WARNING")!.y);
  });

  it("keeps the North Froze Pole rendered label on frozen water", () => {
    const placement = areaLabelPlacementForArea({
      id: "area.north-froze-pole",
      kind: "area",
      label: "North Froze Pole",
      tile: { x: 0, y: 0 },
      dataAreaType: "north-froze-pole",
      detailId: "area.north-froze-pole",
    });

    expect(terrainKindAt(placement.semanticTile.x, placement.semanticTile.y)).toBe("frozen-water");
    expect(terrainKindAt(placement.anchorTile.x, placement.anchorTile.y)).toBe("frozen-water");
  });

  it("keeps non-DEWS risk water labels on their semantic water", () => {
    const expectedTerrains: Record<ShipRiskPlacement, string> = {
      "breakwater-edge": "watch-water",
      "data-fog": "brackish-water",
      "harbor-mouth-watch": "alert-water",
      "ledger-mooring": "calm-water",
      "outer-rough-water": "warning-water",
      "safe-harbor": "calm-water",
      "storm-shelf": "storm-water",
    };

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
