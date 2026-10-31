import { describe, expect, it, vi } from "vitest";
import { matchMarker, mockD1 } from "@shared/test-utils/mock-d1";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID,
} from "../sources-optional";

/**
 * Cohort-gated optional sources must resolve to an active yield-bearing coin or
 * carry an explicit reviewed dormancy reason. Retired BIMA/CETES adapters must
 * not remain registered merely because catalog records still exist.
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

  it("isolates a D1 anchor-read failure in the Ondo USDY oracle entry", async () => {
    const db = mockD1(
      [matchMarker("yield-sync:nav-oracle-prior-anchor", [], { throwError: new Error("D1_ERROR: disk I/O error") })],
      { assertMatchesUsed: true },
    );
    const onOutcome = vi.fn();
    const entry = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID
      .get("usdy-ondo-finance")
      ?.find((candidate) => candidate.sourceKey === "protocol-api:ondo-usdy-oracle");
    expect(entry).toBeDefined();

    // A reader failure is one failed optional source, not a whole-run abort.
    await expect(entry!.run({ db, startSec: 1_771_000_000, onOutcome })).resolves.toBeNull();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({ label: "Ondo USDY oracle source", outcome: "failed" });
  });
});
