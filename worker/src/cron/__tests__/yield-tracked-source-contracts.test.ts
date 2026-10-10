import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type * as TrackedUtilsModule from "@shared/lib/tracked-stablecoin-utils";
import type * as StablecoinRegistryModule from "@shared/lib/stablecoins/registry";

vi.mock("@shared/lib/tracked-stablecoin-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof TrackedUtilsModule>();
  const registry = await vi.importActual<typeof StablecoinRegistryModule>("@shared/lib/stablecoins/registry");
  return {
    ...actual,
    // Exercise the wrapper configuration contract explicitly even when current
    // catalog parents are not in the production yield-bearing cohort.
    ACTIVE_YIELD_BEARING_STABLECOINS: ["ftusd-flying-tulip", "iusd-infinifi", "susde-ethena"]
      .map((id) => registry.TRACKED_META_BY_ID.get(id)!),
  };
});
vi.mock("../yield-sync/tracked-optional-source-registry", () => ({
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID: new Map(),
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: [],
}));
vi.mock("../yield-sync/sources", () => ({ getPriceDerivedApy: vi.fn(async () => null) }));

import { YIELD_POOL_MAP, YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config";
import { resolveTrackedYieldSources } from "../yield-sync/resolve-tracked-sources";
import { baseEvaluationInput } from "./yield-evaluation.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import type { DlPool } from "../yield-sync/types";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { evaluateYieldSources } from "../yield-sync/evaluation";
import { buildPreviewYieldRankingsArtifacts, publishYieldCoordinatorResults } from "../yield-sync/coordinator-persist";
import { FIXED_NOW, makeBenchmarkMeta, makeBenchmarkRegistry, makeSafetySnapshotMeta, makeYieldSourceMeta } from "./yield-publication.test-support";

async function resolvePools(dlPools: DlPool[]) {
  const { startSec, sevenDaysAgoSec, riskFreeRates } = baseEvaluationInput();
  return resolveTrackedYieldSources({
    db: mockD1(), startSec, sevenDaysAgoSec, riskFreeRates, dlPools,
    onChainRates: new Map(), safetyScores: new Map(),
  });
}

describe("tracked holder source contracts", () => {
  it.each(["ftusd-flying-tulip", "iusd-infinifi"])("does not assign %s wrapper labels or types to a tokenization market", async (id) => {
    const variant = YIELD_VARIANT_MAP[id];
    for (const project of ["pendle-v2", "spectra-v2"]) {
      const rejected = makeDlYieldPool({
        pool: "tokenization", symbol: variant.variantSymbol, project,
        underlyingTokens: [variant.variantAddress!],
      });
      const { resolved } = await resolvePools([rejected]);
      expect(resolved.filter((entry) => entry.yield?.sourceKey === rejected.pool)).toEqual([]);
      expect(resolved.filter((entry) => entry.id === id && entry.yield != null)).toEqual([]);
    }
    const native = makeDlYieldPool({
      pool: "wrapper", symbol: variant.variantSymbol, project: "native-wrapper", stablecoin: false,
      underlyingTokens: [variant.variantAddress!], apy: -5, apyBase: -5,
    });
    const { resolved } = await resolvePools([native]);
    expect(resolved.find((entry) => entry.id === id)?.yield).toMatchObject({
      currentApy: -5, apyBase: -5, sourceKey: native.pool,
      yieldSource: variant.yieldSource, yieldType: variant.yieldType,
    });
  });

  it("retains a finite negative exact native DeFiLlama observation", async () => {
    const native = makeDlYieldPool({
      pool: YIELD_POOL_MAP["susde-ethena"], symbol: "sUSDe", apy: -5, apyBase: -5,
    });
    const { resolved } = await resolvePools([native]);
    expect(resolved.find((entry) => entry.id === "susde-ethena")?.yield).toMatchObject({
      sourceKey: native.pool, currentApy: -5, apyBase: -5, dataSource: "defillama",
    });
  });

  it("publishes a negative holder observation to current rows and history with apy-non-positive PYS", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const startSec = Math.floor(Date.now() / 1000);
      const native = makeDlYieldPool({
        pool: YIELD_POOL_MAP["susde-ethena"], symbol: "sUSDe", apy: -5, apyBase: -5,
      });
      const { resolved } = await resolvePools([native]);
      const holder = resolved.find((entry) => entry.id === "susde-ethena");
      expect(holder?.yield).toMatchObject({ currentApy: -5 });
      const riskFreeRateMeta = makeBenchmarkMeta();
      const riskFreeRates = makeBenchmarkRegistry(riskFreeRateMeta);
      const evaluation = evaluateYieldSources(baseEvaluationInput({
        startSec, riskFreeRates,
        resolved: [{ id: "susde-ethena", symbol: "sUSDe", yield: { ...holder!.yield!, sourceObservedAt: startSec } }],
        safetyScores: new Map([["susde-ethena", { score: 80, grade: "B+" }]]),
        stablecoinSupplyById: new Map([["susde-ethena", 10_000_000]]),
      }));
      expect(evaluation.evaluatedSources[0]).toMatchObject({
        currentApy: -5, pharosYieldScore: null, pysNullReason: "apy-non-positive", rejected: false,
      });
      const artifacts = buildPreviewYieldRankingsArtifacts({
        evaluatedSources: evaluation.evaluatedSources, bestSourceKeyByCoin: evaluation.bestSourceKeyByCoin,
        riskFreeRate: riskFreeRateMeta.rate, riskFreeRateMeta, riskFreeRates,
        dlPoolsMeta: makeYieldSourceMeta(), safetySnapshot: makeSafetySnapshotMeta(), medianApy: -5, startSec,
      });
      const result = await publishYieldCoordinatorResults({
        db, startSec, previewRankingsPayload: artifacts.previewRankingsPayload,
        publicationViews: artifacts.publicationViews, evaluatedSources: artifacts.acceptedSources,
        degradationReasons: [], resolvedCount: 1, rowsRejected: 0, divergenceFlags: 0, sourceSwitches: 0,
        safetySnapshotHeld: false,
        previousYieldPublicationSnapshot: { status: "missing", rankings: [], malformed: false },
      });
      expect(result.ok).toBe(true);
      expect(sqlite.prepare("SELECT current_apy FROM yield_data").all()).toEqual([{ current_apy: -5 }]);
      expect(sqlite.prepare("SELECT apy FROM yield_history").all()).toEqual([{ apy: -5 }]);
      const cache = sqlite.prepare("SELECT value FROM cache WHERE key = 'yield-rankings'").get() as { value: string };
      expect(JSON.parse(cache.value).rankings[0]).toMatchObject({
        currentApy: -5, pharosYieldScore: null, pysNullReason: "apy-non-positive",
      });
    } finally {
      vi.useRealTimers();
      sqlite.close();
    }
  });
});
