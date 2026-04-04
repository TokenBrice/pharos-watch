import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleTreasuryStableExposure } from "../treasury-stable-exposure";

function makeCacheDb(value: unknown, updatedAt: number) {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "treasury-stable-exposure", value: jsonValue, updated_at: updatedAt }],
      first: { key: "treasury-stable-exposure", value: jsonValue, updated_at: updatedAt },
    },
  ]);
}

function makeValidPayload(updatedAt: number) {
  return {
    entities: [
      {
        protocolId: "alpha",
        slug: "alpha",
        name: "Alpha Treasury",
        category: "Protocol treasury",
        source: "defillama-github",
        adapterFile: "alpha.js",
        chains: ["ethereum"],
        directWalletUsd: 1_000,
        treasuryUsd: 1_000,
        stablecoinSleeveUsd: 100,
        trackedStableUsd: 100,
        decentralizedStableUsd: 10,
        decentralizedStablePctOfTreasury: 1,
        decentralizedStablePctOfStableSleeve: 10,
        weightedSafetyScore: 82,
        weightedSafetyGrade: "A-",
        governanceBuckets: {
          centralizedUsd: 90,
          centralizedDependentUsd: 0,
          decentralizedUsd: 10,
        },
        holdings: [
          {
            stablecoinId: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            governance: "centralized",
            usdValue: 100,
            pctOfTreasury: 10,
            pctOfStableSleeve: 100,
            safetyScore: 82,
            safetyGrade: "A-",
          },
        ],
        coverage: {
          extractionMode: "static-seeded",
          ownerCount: 1,
          ownerChainCount: 1,
          denominatorStatus: "direct-only",
          directWalletUsd: 1_000,
          defiPositionUsd: 0,
          consumedDirectBalanceUsd: 0,
          trackedStableUsd: 100,
          stablecoinSleeveUsd: 100,
          untrackedStableUsd: 0,
          derivedUntrackedStableUsd: 0,
          ratedTrackedStableUsd: 100,
          trackedStablePctOfTreasury: 10,
          trackedStablePctOfStableSleeve: 100,
          ratedTrackedStablePct: 100,
          untrackedStableCount: 0,
          derivedUntrackedStableCount: 0,
          skippedDerivedPositionCount: 0,
          notes: [],
        },
      },
    ],
    updatedAt,
    coverage: {
      entityCount: 1,
      registryCount: 1,
      launchEligibleCount: 1,
      ownerChainTuples: 2,
      launchOwnerChainTuples: 2,
      comparableEntityCount: 1,
      partialEntityCount: 0,
      invalidEntityCount: 0,
      supplementedEntityCount: 0,
      evmOnly: true,
      extractionModes: {
        staticSeeded: 1,
        customReviewed: 0,
        dynamicUnresolved: 0,
        missing: 0,
      },
    },
  };
}

function makeLegacyPayload(updatedAt: number) {
  return {
    entities: [
      {
        protocolId: "alpha",
        slug: "alpha",
        name: "Alpha Treasury",
        category: "Protocol treasury",
        source: "defillama-github",
        adapterFile: "alpha.js",
        chains: ["ethereum"],
        treasuryUsd: 1_000,
        stablecoinSleeveUsd: 100,
        trackedStableUsd: 100,
        decentralizedStableUsd: 10,
        decentralizedStablePctOfTreasury: 1,
        decentralizedStablePctOfStableSleeve: 10,
        weightedSafetyScore: 82,
        weightedSafetyGrade: "A-",
        governanceBuckets: {
          centralizedUsd: 90,
          centralizedDependentUsd: 0,
          decentralizedUsd: 10,
        },
        holdings: [
          {
            stablecoinId: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            governance: "centralized",
            usdValue: 100,
            pctOfTreasury: 10,
            pctOfStableSleeve: 100,
            safetyScore: 82,
            safetyGrade: "A-",
          },
        ],
        coverage: {
          extractionMode: "static-seeded",
          ownerCount: 1,
          ownerChainCount: 1,
          trackedStableUsd: 100,
          stablecoinSleeveUsd: 100,
          untrackedStableUsd: 0,
          ratedTrackedStableUsd: 100,
          trackedStablePctOfTreasury: 10,
          trackedStablePctOfStableSleeve: 100,
          ratedTrackedStablePct: 100,
          untrackedStableCount: 0,
          notes: [],
        },
      },
    ],
    updatedAt,
    coverage: {
      entityCount: 1,
      registryCount: 1,
      launchEligibleCount: 1,
      ownerChainTuples: 2,
      launchOwnerChainTuples: 2,
      evmOnly: true,
      extractionModes: {
        staticSeeded: 1,
        customReviewed: 0,
        dynamicUnresolved: 0,
        missing: 0,
      },
    },
  };
}

describe("handleTreasuryStableExposure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty 200 payload when cache is empty", async () => {
    const res = await handleTreasuryStableExposure(mockD1());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      entities: unknown[];
      updatedAt: number;
      _meta: { status: string };
      coverage: { entityCount: number; registryCount: number; comparableEntityCount: number };
    };
    expect(body.entities).toEqual([]);
    expect(body.updatedAt).toBe(0);
    expect(body.coverage.entityCount).toBe(0);
    expect(body.coverage.registryCount).toBeGreaterThan(0);
    expect(body.coverage.comparableEntityCount).toBe(0);
    expect(body._meta.status).toBe("stale");
  });

  it("returns 200 with freshness metadata for a valid cached payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const updatedAt = nowSec - 120;
    const res = await handleTreasuryStableExposure(makeCacheDb(makeValidPayload(updatedAt), updatedAt));

    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: { ageSeconds: number; status: string } };
    expect(body._meta.ageSeconds).toBe(120);
    expect(body._meta.status).toBe("fresh");
  });

  it("returns 503 when the cached payload is structurally malformed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await handleTreasuryStableExposure(makeCacheDb({
      entities: [],
      updatedAt: nowSec,
    }, nowSec));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached treasury-stable-exposure payload is malformed",
    });
  });

  it("returns 503 when the cached payload violates treasury invariants", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const invalid = makeValidPayload(nowSec);
    invalid.entities[0]!.treasuryUsd = 100;
    invalid.entities[0]!.stablecoinSleeveUsd = 200;
    invalid.entities[0]!.coverage.stablecoinSleeveUsd = 200;

    const res = await handleTreasuryStableExposure(makeCacheDb(invalid, nowSec));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached treasury-stable-exposure payload is malformed",
    });
  });

  it("returns 200 for a legacy cached payload by normalizing it to the new schema", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const updatedAt = nowSec - 120;
    const res = await handleTreasuryStableExposure(makeCacheDb(makeLegacyPayload(updatedAt), updatedAt));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      entities: Array<{
        directWalletUsd: number;
        treasuryUsd: number | null;
        coverage: {
          denominatorStatus: string;
          directWalletUsd: number;
          notes: string[];
        };
      }>;
    };
    expect(body.entities[0]?.directWalletUsd).toBe(1_000);
    expect(body.entities[0]?.treasuryUsd).toBe(1_000);
    expect(body.entities[0]?.coverage.denominatorStatus).toBe("direct-only");
    expect(body.entities[0]?.coverage.directWalletUsd).toBe(1_000);
    expect(body.entities[0]?.coverage.notes).toContain(
      "Legacy treasury cache normalized during worker rollout; denominator diagnostics refresh after the next treasury sync.",
    );
  });

  it("returns 200 for a legacy cached payload with an impossible treasury denominator by downgrading it to invalid", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const updatedAt = nowSec - 120;
    const legacyInvalid = makeLegacyPayload(updatedAt);
    legacyInvalid.entities[0]!.stablecoinSleeveUsd = 1_200;
    legacyInvalid.entities[0]!.decentralizedStablePctOfTreasury = 120;
    legacyInvalid.entities[0]!.holdings[0]!.pctOfTreasury = 120;
    legacyInvalid.entities[0]!.coverage.stablecoinSleeveUsd = 1_200;
    legacyInvalid.entities[0]!.coverage.trackedStablePctOfTreasury = 120;

    const res = await handleTreasuryStableExposure(makeCacheDb(legacyInvalid, updatedAt));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      entities: Array<{
        treasuryUsd: number | null;
        decentralizedStablePctOfTreasury: number | null;
        holdings: Array<{ pctOfTreasury: number | null }>;
        coverage: {
          denominatorStatus: string;
          trackedStablePctOfTreasury: number | null;
          notes: string[];
        };
      }>;
    };
    expect(body.entities[0]?.treasuryUsd).toBeNull();
    expect(body.entities[0]?.decentralizedStablePctOfTreasury).toBeNull();
    expect(body.entities[0]?.holdings[0]?.pctOfTreasury).toBeNull();
    expect(body.entities[0]?.coverage.denominatorStatus).toBe("invalid");
    expect(body.entities[0]?.coverage.trackedStablePctOfTreasury).toBeNull();
    expect(body.entities[0]?.coverage.notes).toContain(
      "Treasury-relative metrics are suppressed until the next treasury sync republishes this row with the new denominator model.",
    );
  });
});
