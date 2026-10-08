import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY,
} from "../tracked-optional-source-registry";

/**
 * Cohort-gated optional sources must resolve to an active yield-bearing coin or
 * carry an explicit reviewed dormancy reason. Retired BIMA/CETES adapters must
 * not remain registered merely because catalog records still exist.
 */
describe("tracked optional source registry coverage", () => {
  const activeYieldBearingIds = new Set(ACTIVE_YIELD_BEARING_STABLECOINS.map((coin) => coin.id));

  it("does not register retired BIMA or CETES source work", () => {
    const ids = [
      ...TRACKED_OPTIONAL_SOURCE_REGISTRY,
      ...STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
    ].map((entry) => entry.stablecoinId);
    expect(ids).not.toContain("usbd-bima");
    expect(ids).not.toContain("cetes-etherfuse");
  });

  it("resolves every cohort-gated entry: active yield-bearing coin, or intended-dormant", () => {
    for (const entry of TRACKED_OPTIONAL_SOURCE_REGISTRY) {
      expect(
        TRACKED_META_BY_ID.has(entry.stablecoinId),
        `${entry.stablecoinId} is not a tracked stablecoin`,
      ).toBe(true);
      if (activeYieldBearingIds.has(entry.stablecoinId)) {
        expect(
          entry.intendedDormant,
          `${entry.stablecoinId} is in the active yield cohort but still marked dormant`,
        ).toBeUndefined();
      } else {
        expect(
          entry.intendedDormant,
          `${entry.stablecoinId} can never run: neither active-yield-bearing nor intendedDormant`,
        ).toBeTruthy();
      }
    }
  });

  it("keeps standalone entries reachable without a dormancy marker", () => {
    for (const entry of STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY) {
      expect(TRACKED_META_BY_ID.has(entry.stablecoinId)).toBe(true);
      expect(
        activeYieldBearingIds.has(entry.stablecoinId) || entry.intendedDormant === undefined,
      ).toBe(true);
    }
  });
});
