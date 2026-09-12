import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY,
} from "../tracked-optional-source-registry";

/**
 * B15 — a registered optional source that hangs off a coin the sync never iterates
 * is silent dead code: `usbd-bima` (no `flags.yieldBearing`) and `cetes-etherfuse`
 * (quarantined) each stranded an adapter with no log line and no metadata. Every
 * cohort-gated entry must therefore resolve to an active yield-bearing coin or carry
 * an explicit dormancy reason, and the reason must be cleared once the coin returns.
 */
describe("tracked optional source registry coverage", () => {
  const activeYieldBearingIds = new Set(ACTIVE_YIELD_BEARING_STABLECOINS.map((coin) => coin.id));

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
