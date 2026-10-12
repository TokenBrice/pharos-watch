import { describe, expect, it } from "vitest";
import { HealthBandSchema } from "../../../types/chains";
import {
  CHAIN_HEALTH_BADGE_CLASSES,
  CHAIN_HEALTH_BAND_ORDER,
  CHAIN_HEALTH_FILL_CLASSES,
  CHAIN_HEALTH_HEX,
  CHAIN_HEALTH_LABELS,
  CHAIN_HEALTH_PENNANTS,
  CHAIN_HEALTH_TEXT_CLASSES,
} from "../chain-health";

describe("chain health band descriptors", () => {
  it("covers every HealthBandSchema value exactly once, in order", () => {
    expect([...CHAIN_HEALTH_BAND_ORDER].sort()).toEqual([...HealthBandSchema.options].sort());
    for (const map of [CHAIN_HEALTH_LABELS, CHAIN_HEALTH_HEX, CHAIN_HEALTH_PENNANTS, CHAIN_HEALTH_BADGE_CLASSES, CHAIN_HEALTH_TEXT_CLASSES, CHAIN_HEALTH_FILL_CLASSES]) {
      expect(Object.keys(map).sort()).toEqual([...HealthBandSchema.options].sort());
    }
  });

  it("repeats the band ordinally as pennants and keeps hexes distinct", () => {
    expect(CHAIN_HEALTH_BAND_ORDER.map((band) => CHAIN_HEALTH_PENNANTS[band])).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(Object.values(CHAIN_HEALTH_HEX)).size).toBe(CHAIN_HEALTH_BAND_ORDER.length);
    expect(CHAIN_HEALTH_HEX.robust).toBe("#059669");
  });
});
