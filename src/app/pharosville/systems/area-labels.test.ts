import { describe, expect, it } from "vitest";
import { areaLabelPlacementForArea } from "./area-labels";
import { tileToIso } from "./projection";
import { DEWS_AREA_PLACEMENTS, RISK_WATER_AREAS } from "./risk-water-areas";
import { terrainKindAt } from "./world-layout";
import type { AreaNode, DewsAreaBand } from "./world-types";

const WEST_TO_EAST_DEWS_BANDS: DewsAreaBand[] = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];

describe("areaLabelPlacementForArea", () => {
  it("keeps rendered DEWS labels ordered left-to-right and upward", () => {
    let previousIso: { x: number; y: number } | null = null;

    for (const band of WEST_TO_EAST_DEWS_BANDS) {
      const area = dewsAreaNode(band);
      const anchor = areaLabelPlacementForArea(area).anchorTile;
      const iso = tileToIso(anchor);

      if (previousIso) {
        expect(iso.x).toBeGreaterThan(previousIso.x);
        expect(iso.y).toBeLessThan(previousIso.y);
      }
      previousIso = iso;
    }
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

