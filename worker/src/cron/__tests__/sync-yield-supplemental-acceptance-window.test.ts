import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSyncYieldDataTest,
  makeDb,
  resetSyncYieldDataTest,
} from "./sync-yield-data.test-support";
import { getCache } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  cacheRow,
  installYieldCacheReader,
  supplementalFamilyCacheRow,
  type YieldCacheFixture,
} from "./yield-cache.test-support";
import {
  buildYieldSupplementalFamilyCache,
  buildYieldSupplementalPendleBackoff,
  buildYieldSupplementalRunOutcome,
  getYieldSupplementalFamilyCacheKey,
  getYieldSupplementalPendleBackoffCacheKey,
  getYieldSupplementalRunOutcomeCacheKey,
  parseYieldSupplementalSourcesCache,
  type SupplementalFamilyCacheResult,
} from "../yield-sync/cache/supplemental-cache-keys";
import { loadYieldSyncState } from "../yield-sync/state-loading";
import { getSupplementalFamilyStaleThresholdSec } from "../yield-sync/supplemental-source-families";
import {
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalSourceFamilyKey,
} from "../yield-sync/supplemental-source-family-keys";
import type { ResolvedYieldCandidate } from "../yield-sync/types";

const HOUR_SEC = 3600;

function morphoCandidate(observedAt: number): ResolvedYieldCandidate {
  return {
    stablecoinId: "100",
    symbol: "sDAI",
    chain: "ethereum",
    address: null,
    yield: {
      currentApy: 6.1,
      apyBase: 6.1,
      apyReward: null,
      sourcePool: "vault-sdai-morpho",
      sourceTvlUsd: 50_000_000,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
      yieldSource: "Morpho: sDAI Vault",
      yieldType: "lending-vault",
      sourceObservedAt: observedAt,
      comparisonAnchorObservedAt: null,
    },
  };
}

function pendleCandidate(observedAt: number): ResolvedYieldCandidate {
  return {
    stablecoinId: "100",
    symbol: "USDG",
    chain: "ethereum",
    address: null,
    yield: {
      currentApy: 5.2,
      apyBase: 5.2,
      apyReward: null,
      sourcePool: "0xpt",
      sourceTvlUsd: 12_000_000,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey: "protocol-api:pendle:ethereum:0xpt",
      yieldSource: "Pendle fixed yield: Global Dollar USDG",
      yieldType: "fixed-yield",
      sourceObservedAt: observedAt,
      comparisonAnchorObservedAt: null,
    },
  };
}

/** Every required family present and fresh; the caller overrides the family under test. */
function freshRequiredFamilyRows(nowSec: number): Record<string, YieldCacheFixture> {
  return Object.fromEntries(
    SUPPLEMENTAL_SOURCE_FAMILY_KEYS
      .filter((family) => family !== "vaultsFyi")
      .map((family) => [getYieldSupplementalFamilyCacheKey(family), supplementalFamilyCacheRow([], nowSec)]),
  );
}

describe("supplemental family cache acceptance window", () => {
  beforeEach(() => {
    resetSyncYieldDataTest();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
  });

  afterEach(cleanupSyncYieldDataTest);

  it("accepts a family snapshot observed 5h59m ago and includes its candidates", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const morphoKey = getYieldSupplementalFamilyCacheKey("morpho");
    const familyAgeSec = 5 * HOUR_SEC + 59 * 60;

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [morphoKey]: supplementalFamilyCacheRow([morphoCandidate(nowSec - familyAgeSec)], nowSec - familyAgeSec),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalCandidates).toEqual([morphoCandidate(nowSec - familyAgeSec)]);
    expect(state.supplementalMeta).toMatchObject({
      mode: "cache",
      fallbackMode: null,
      sourceCount: 1,
      degradedFamilies: [],
    });
  });

  it.each([
    ["6h01m", 6 * HOUR_SEC + 60],
    ["12h01m", 12 * HOUR_SEC + 60],
  ])("excludes a family snapshot observed %s ago and reports it as a partial cache", async (_label, familyAgeSec) => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const morphoKey = getYieldSupplementalFamilyCacheKey("morpho");

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [morphoKey]: supplementalFamilyCacheRow([morphoCandidate(nowSec - familyAgeSec)], nowSec - familyAgeSec),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalCandidates).toEqual([]);
    expect(state.supplementalMeta).toMatchObject({
      mode: "cache",
      fallbackMode: "partial-family-cache",
      sourceCount: 0,
    });
  });

  it("reports a stale cache when every required family missed its refresh slot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const staleRows = Object.fromEntries(
      SUPPLEMENTAL_SOURCE_FAMILY_KEYS
        .filter((family) => family !== "vaultsFyi")
        .map((family) => {
          const staleAgeSec = getSupplementalFamilyStaleThresholdSec(family) + 60;
          return [
            getYieldSupplementalFamilyCacheKey(family),
            supplementalFamilyCacheRow([], nowSec - staleAgeSec),
          ];
        }),
    );

    installYieldCacheReader(vi.mocked(getCache), staleRows);

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalCandidates).toEqual([]);
    expect(state.supplementalMeta).toMatchObject({
      mode: "stale-cache",
      fallbackMode: "stale-cache",
      sourceCount: 0,
    });
  });

  it("rejects a cached family payload whose stored version does not match the key version", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const stored = buildYieldSupplementalFamilyCache([morphoCandidate(nowSec)], nowSec);
    const mismatched = JSON.stringify({ ...(JSON.parse(stored) as Record<string, unknown>), version: 2 });

    expect(parseYieldSupplementalSourcesCache(stored, nowSec, nowSec)?.candidates).toHaveLength(1);
    expect(parseYieldSupplementalSourcesCache(mismatched, nowSec, nowSec)).toBeNull();
    expect(getYieldSupplementalFamilyCacheKey("morpho")).toBe("yield:supplemental-sources:v1:morpho");
  });

  it("invalidates a version-mismatched family row instead of loading its candidates", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const morphoKey = getYieldSupplementalFamilyCacheKey("morpho");

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [morphoKey]: cacheRow(
        JSON.stringify({
          version: 2,
          updatedAt: nowSec,
          source: "sync-yield-supplemental",
          sourceCount: 1,
          data: [morphoCandidate(nowSec)],
        }),
        nowSec,
      ),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalCandidates).toEqual([]);
    expect(state.supplementalMeta).toMatchObject({
      mode: "cache",
      fallbackMode: "partial-family-cache",
      sourceCount: 0,
    });
  });

  it("surfaces the producer's retained families as supplementalMeta.degradedFamilies", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const familyCacheResults = Object.fromEntries(
      SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => [family, "published" as SupplementalFamilyCacheResult]),
    ) as Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>;
    familyCacheResults.morpho = "retained-previous";

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [getYieldSupplementalRunOutcomeCacheKey()]: cacheRow(
        buildYieldSupplementalRunOutcome(familyCacheResults, ["morpho"], nowSec),
        nowSec,
      ),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalMeta.degradedFamilies).toEqual(["morpho"]);
  });

  it("ignores a run-outcome row written by a different cache version", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [getYieldSupplementalRunOutcomeCacheKey()]: cacheRow(
        JSON.stringify({ version: 2, checkedAt: nowSec, degradedFamilies: ["morpho"] }),
        nowSec,
      ),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalMeta.degradedFamilies).toEqual([]);
  });

  it("accepts a pendle row inside its daily budget and does not degrade the lane", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const pendleAgeSec = 30 * HOUR_SEC;

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [getYieldSupplementalFamilyCacheKey("pendle")]:
        supplementalFamilyCacheRow([pendleCandidate(nowSec - pendleAgeSec)], nowSec - pendleAgeSec),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalCandidates).toEqual([pendleCandidate(nowSec - pendleAgeSec)]);
    expect(state.supplementalMeta).toMatchObject({
      mode: "cache",
      fallbackMode: null,
      degradedFamilies: [],
    });
  });

  it("excludes a pendle row past its 48h budget and reports it as a partial cache", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const pendleAgeSec = 49 * HOUR_SEC;

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [getYieldSupplementalFamilyCacheKey("pendle")]:
        supplementalFamilyCacheRow([pendleCandidate(nowSec - pendleAgeSec)], nowSec - pendleAgeSec),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalCandidates).toEqual([]);
    expect(state.supplementalMeta).toMatchObject({
      mode: "cache",
      fallbackMode: "partial-family-cache",
      sourceCount: 0,
    });
  });

  it.each([
    ["inside the pendle budget", 30 * HOUR_SEC, null],
    ["past the pendle budget", 49 * HOUR_SEC, "pendle-rate-limited-backoff"],
  ])("re-evaluates an active pendle quota backoff %s on the publication clock", async (_label, ageSec, expectedReason) => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    installYieldCacheReader(vi.mocked(getCache), {
      ...freshRequiredFamilyRows(nowSec),
      [getYieldSupplementalFamilyCacheKey("pendle")]:
        supplementalFamilyCacheRow([pendleCandidate(nowSec - ageSec)], nowSec - ageSec),
      [getYieldSupplementalPendleBackoffCacheKey()]: cacheRow(
        buildYieldSupplementalPendleBackoff({
          backoffUntilSec: nowSec + 3600,
          source: "x-ratelimit-weekly-reset",
          recordedAtSec: nowSec,
        }),
        nowSec,
      ),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    if (expectedReason == null) {
      expect(state.supplementalMeta).toMatchObject({ fallbackMode: null, degradedFamilies: [] });
      return;
    }
    expect(state.supplementalMeta.degradedFamilies).toEqual(["pendle"]);
    expect(state.supplementalMeta.degradedFamilyReasons).toEqual({ pendle: expectedReason });
  });
});
