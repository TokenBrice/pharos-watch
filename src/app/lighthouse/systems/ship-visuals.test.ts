import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { makeAsset } from "../__fixtures__/pharosville-world";
import { resolveShipVisual } from "./ship-visuals";

describe("resolveShipVisual", () => {
  it("uses separate channels for backing, governance, peg, overlay, and scale", () => {
    const meta = ACTIVE_META_BY_ID.get("susde-ethena");
    expect(meta).toBeDefined();

    const visual = resolveShipVisual(makeAsset({
      id: "susde-ethena",
      symbol: "sUSDe",
      circulating: { peggedUSD: 11_000_000_000 },
    }), meta!, null);

    expect(visual.hull).toBe("crypto-caravel");
    expect(visual.rigging).toBe("dependent-rig");
    expect(visual.pennant).toBe("emerald");
    expect(visual.overlay).toBe("nav");
    expect(visual.scale).toBe(1.25);
  });
});
