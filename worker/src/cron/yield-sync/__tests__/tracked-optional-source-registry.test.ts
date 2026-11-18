import { describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getUsycNavFreshness, OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import * as evmRpc from "../../../lib/evm-rpc";
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

  it("reads the USDY wrapper and isolates its anchors from the old oracle series", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const evmRead = vi.spyOn(evmRpc, "fetchEvmUint256AtBlock").mockResolvedValue(1_085_000_000_000_000_000n);
    try {
      const { stablecoinId, sourceKey, legacySourceKey } = OPTIONAL_YIELD_SOURCES.ondo;
      const reader = TRACKED_OPTIONAL_SOURCE_REGISTRY.find((source) => source.stablecoinId === stablecoinId)!;
      const startSec = Date.UTC(2026, 10, 18) / 1_000;
      const anchorAt = startSec - 7 * DAY_SECONDS;
      const insert = sqlite.prepare(`INSERT INTO yield_history
        (stablecoin_id, source_key, apy, data_source, exchange_rate, recorded_at)
        VALUES (?, ?, 0, 'protocol-api', ?, ?)`);
      insert.run(stablecoinId, legacySourceKey, 1.0835, anchorAt);
      await expect(reader.run({ db, startSec })).resolves.toMatchObject({ sourceKey, observationKind: "anchor-only" });
      expect(evmRead).toHaveBeenCalledWith("ethereum", "0x87b126e5518b6a1Bb8465779b4607C45C643DF90",
        "0x98d5fdca", "latest", expect.any(Object));

      insert.run(stablecoinId, sourceKey, 1.0835, anchorAt);
      const observation = await reader.run({ db, startSec });
      expect(observation).toMatchObject({ sourceKey, comparisonAnchorObservedAt: anchorAt });
      expect(observation?.currentApy).toBeCloseTo(7.4855, 4);
    } finally {
      evmRead.mockRestore();
      sqlite.close();
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
