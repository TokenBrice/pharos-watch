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

});
