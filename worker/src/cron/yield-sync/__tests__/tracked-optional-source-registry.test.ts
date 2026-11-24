import { describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getUsycNavFreshness, OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY,
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

  it.each([
    ["2027-01-15T11:45:00Z", "2027-01-19T11:45:00Z"],
    ["2027-03-12T11:45:00Z", "2027-03-15T10:45:00Z"],
  ])("keeps the %s USYC report until its next report at %s plus grace", async (observedIso, dueIso) => {
    const observedAt = Date.parse(observedIso) / 1_000;
    const dueAt = Date.parse(dueIso) / 1_000;
    const { sourceKey } = OPTIONAL_YIELD_SOURCES.hashnote;
    const reader = TRACKED_OPTIONAL_SOURCE_REGISTRY.find((source) => source.sourceKey === sourceKey)!;
    const db = mockD1([]);
    mockFetch([{ match: "usyc.hashnote.com/api/price-reports", body: { data: [
      { timestamp: String(observedAt), price: "1.001" },
      { timestamp: String(observedAt - 7 * DAY_SECONDS), price: "1" },
    ] } }]);
    vi.useFakeTimers();
    try {
      for (const [startSec, tier] of [[dueAt - 1, "fresh"], [dueAt, "aging"], [dueAt + 7201, "stale"]] as const) {
        vi.setSystemTime(startSec * 1_000);
        expect(getUsycNavFreshness(observedAt, startSec)).toBe(tier);
        const result = await reader.run({ db, startSec });
        if (tier === "stale") expect(result).toBeNull();
        else expect(result).toMatchObject({ sourceObservedAt: observedAt, sourceKey });
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
