import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSyncYieldDataTest,
  fixtureGetCache,
  fixtureShouldAttemptFetch,
  makeDb,
  resetSyncYieldDataTest,
} from "./sync-yield-data.test-support";
import {
  cacheRow,
  installYieldCacheReader,
  supplementalFamilyCacheRow,
  type YieldCacheFixture,
} from "./yield-cache.test-support";
import {
  buildYieldSupplementalFamilyCache,
  buildYieldSupplementalRunOutcome,
  getYieldSupplementalFamilyCacheKey,
  getYieldSupplementalRunOutcomeCacheKey,
  parseYieldSupplementalSourcesCache,
  type SupplementalFamilyCacheResult,
} from "../yield-sync/cache/supplemental-cache-keys";
import { loadYieldSyncState } from "../yield-sync/state-loading";
import { SUPPLEMENTAL_SOURCE_FAMILY_KEYS } from "../yield-sync/supplemental-source-families";
import type { SupplementalSourceFamilyKey } from "../yield-sync/supplemental-source-family-keys";
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
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
  });

  afterEach(cleanupSyncYieldDataTest);

  it("accepts a family snapshot observed 5h59m ago and includes its candidates", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const morphoKey = getYieldSupplementalFamilyCacheKey("morpho");
    const familyAgeSec = 5 * HOUR_SEC + 59 * 60;

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
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

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
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
    const familyAgeSec = 6 * HOUR_SEC + 60;
    const staleRows = Object.fromEntries(
      SUPPLEMENTAL_SOURCE_FAMILY_KEYS
        .filter((family) => family !== "vaultsFyi")
        .map((family) => [
          getYieldSupplementalFamilyCacheKey(family),
          supplementalFamilyCacheRow([], nowSec - familyAgeSec),
        ]),
    );

    installYieldCacheReader(vi.mocked(fixtureGetCache), staleRows);

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

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
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

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
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

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      ...freshRequiredFamilyRows(nowSec),
      [getYieldSupplementalRunOutcomeCacheKey()]: cacheRow(
        JSON.stringify({ version: 2, checkedAt: nowSec, degradedFamilies: ["morpho"] }),
        nowSec,
      ),
    });

    const state = await loadYieldSyncState({ db, startSec: nowSec, chainRpcs: new Map() });

    expect(state.supplementalMeta.degradedFamilies).toEqual([]);
  });
});
