import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { YieldPublicDecisionLedgerSchema, YieldRankingsResponseSchema } from "@shared/types/yield";
import { YieldRankingSummarySchema, YieldRankingsSummaryResponseSchema } from "@shared/types/yield-summary";
import { matchMarker, mockD1 } from "@shared/test-utils/mock-d1";
import type * as TrackedUtilsModule from "@shared/lib/tracked-stablecoin-utils";
import type * as StablecoinRegistryModule from "@shared/lib/stablecoins/registry";

vi.mock("@shared/lib/tracked-stablecoin-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof TrackedUtilsModule>();
  const registry = await vi.importActual<typeof StablecoinRegistryModule>("@shared/lib/stablecoins/registry");
  return {
    ...actual,
    // Exercise the wrapper configuration contract explicitly even when current
    // catalog parents are not in the production yield-bearing cohort.
    ACTIVE_YIELD_BEARING_STABLECOINS: ["ftusd-flying-tulip", "iusd-infinifi", "susde-ethena", "ybold-yearn", "gtusdc-gauntlet", "bbqusdc-steakhouse", "stusds-sky"]
      .map((id) => registry.TRACKED_META_BY_ID.get(id)!),
  };
});
vi.mock("../yield-sync/sources-optional", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/sources-optional")>();

  return {
    ...actual,
    TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID: new Map(),
    STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: [],
  };
});
vi.mock("../yield-sync/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/state")>();

  return {
    ...actual,
    getPriceDerivedApy: vi.fn(async () => null),
  };
});

import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import { resolveTrackedYieldSources } from "../yield-sync/resolve-observations";
import { baseEvaluationInput, resolvedYield } from "./yield-evaluation.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import type { DlPool } from "../yield-sync/types";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { evaluateYieldSourcesCooperative } from "../yield-sync/evaluation";
import { buildPreviewYieldRankingsArtifacts, publishYieldCoordinatorResults } from "../yield-sync/publication";
import { FIXED_NOW, makeBenchmarkMeta, makeBenchmarkRegistry, makeSafetySnapshotMeta, makeYieldSourceMeta } from "./yield-publication.test-support";
import { TRACKED_OPTIONAL_SOURCE_REGISTRY, TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID } from "../yield-sync/sources-optional";
import * as fetchRetry from "../../lib/fetch-retry";
import type { YieldOptionalSourceOutcome } from "../yield-sync/sources-rpc";
import { STALE_THRESHOLD_MS } from "../../lib/yield-ranking-helpers";
import { MORPHO_NET_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { buildYieldStorageRows } from "../yield-sync/publication-rows";
import { publishYieldRowsAtomically } from "../yield-sync/publication-storage";
import { loadYieldHistorySnapshots } from "../yield-sync/history-repository";
import { computeYieldCandidateStatistics } from "../yield-sync/candidate-statistics";
import { readYieldRankingsCoinCache } from "../../lib/yield-rankings-coin-cache";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import { buildSelectorRows } from "@shared/lib/selector/data-adapter";
import { selectYieldSource } from "@shared/lib/selector/yield-source";
import { makeInput } from "@shared/lib/selector/__tests__/fixture";
import { appendLinkedVariantParentYieldSources } from "../yield-sync/resolve-linked-variants";
import { buildYieldHistoryEvaluationInputsCooperative } from "../yield-sync/history-evidence";
import { computeApyFromRate } from "../yield-helpers";
import { getPriceDerivedApy } from "../yield-sync/state";
import { getPublishableNonOnchainCoverageIds } from "../yield-sync/health-policy";

const previousReasonCode = z.enum([
  "best-by-confidence-and-apy", "deterministic-preferred", "curated-over-discovered", "tier-preference",
  "tvl-floor", "freshness-tiebreaker", "fallback", "no-alternatives",
]);
const PreviousRankingsSchema = YieldRankingsResponseSchema.extend({
  rankings: z.array(YieldRankingsResponseSchema.shape.rankings.element.extend({
    decisionLedger: YieldPublicDecisionLedgerSchema.pick({
      selectedReasonCode: true, previousBestSourceKey: true, sourceSwitch: true,
      apy30dDeltaFromPrevious: true, rejectedCount: true, alternatives: true,
    }).extend({ selectedReasonCode: previousReasonCode }).nullable().optional(),
  })),
});
const PreviousSummarySchema = YieldRankingsSummaryResponseSchema.extend({
  rankings: z.array(YieldRankingSummarySchema.extend({ decisionReasonCode: previousReasonCode.optional() })),
});

async function resolvePools(dlPools: DlPool[], onOptionalSourceOutcome?: (outcome: YieldOptionalSourceOutcome) => void) {
  const { startSec, sevenDaysAgoSec, riskFreeRates } = baseEvaluationInput();
  return resolveTrackedYieldSources({
    db: mockD1(), startSec, sevenDaysAgoSec, riskFreeRates, dlPools,
    onChainRates: new Map(), safetyScores: new Map(), onOptionalSourceOutcome,
  });
}

describe("tracked holder source contracts", () => {
  it.each(Object.values(MORPHO_NET_YIELD_SOURCES))("selects clocked Morpho net APY for $stablecoinId", async (config) => {
    const { stablecoinId: id, sourceKey, vaultAddress, corroboratingPoolId } = config;
    const reader = TRACKED_OPTIONAL_SOURCE_REGISTRY.find((entry) => entry.sourceKey === sourceKey)!;
    const { startSec } = baseEvaluationInput();
    const observedAt = startSec - 60;
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const baseUrl = `https://api.morpho.org/v0/vaults-v1/1:${vaultAddress}`;
    const priceUrl = `https://api.morpho.org/v0/tokens/1:${usdc.toLowerCase()}/price`;
    const fetchSource = vi.spyOn(fetchRetry, "fetchJsonWithRetry");
    const mockRest = (overrides: { vault?: unknown; state?: unknown; history?: unknown; price?: unknown } = {}) => {
      const vault = overrides.vault ?? {
        data: { chain_id: 1, address: vaultAddress.toUpperCase().replace("0X", "0x"), fee_wad: "50000000000000000", asset: { address: usdc, decimals: 6 } },
      };
      const state = overrides.state ?? { data: { chain_id: 1, address: vaultAddress, total_assets: "16733458593643" } };
      const history = overrides.history ?? {
        params: { chain_id: "1", vault_address: vaultAddress },
        data: [{ timestamp: observedAt - 3600, apy: 0.025 }, { timestamp: observedAt, apy: 0.03 }],
      };
      const price = overrides.price ?? { data: { chain_id: 1, address: usdc, price: 0.99993280325, timestamp: String(observedAt) } };
      fetchSource.mockImplementation(async (url) => {
        if (url === baseUrl) return { response: new Response("{}"), body: vault };
        if (url === `${baseUrl}/state`) return { response: new Response("{}"), body: state };
        if (url === `${baseUrl}/apy/history?lookback=six_hours`) return { response: new Response("{}"), body: history };
        if (url === priceUrl) return { response: new Response("{}"), body: price };
        throw new Error(`Unexpected Morpho URL: ${url}`);
      });
    };
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const onOutcome = vi.fn();
      for (const timestamp of [null, startSec + 1, startSec - STALE_THRESHOLD_MS / 1000 - 1]) {
        mockRest({ history: { params: { chain_id: "1", vault_address: vaultAddress }, data: [{ timestamp, apy: 0.03 }] } });
        await expect(reader.run({ db, startSec, onOutcome })).resolves.toBeNull();
      }
      for (const overrides of [
        { state: { data: null } },
        { vault: { data: { chain_id: 1, address: vaultAddress, fee_wad: "0", asset: { address: usdc, decimals: 6 } } } },
        { history: { params: { chain_id: "1", vault_address: vaultAddress }, data: [] } },
        { history: { params: { chain_id: "1", vault_address: vaultAddress }, data: [{ timestamp: observedAt, apy: null }] } },
        { price: { data: { chain_id: 1, address: usdc, price: 1, timestamp: String(startSec - STALE_THRESHOLD_MS / 1000 - 1) } } },
        { price: { data: { chain_id: 1, address: usdc, price: 1, timestamp: String(startSec + 301) } } },
      ]) {
        mockRest(overrides);
        await expect(reader.run({ db, startSec, onOutcome })).resolves.toBeNull();
      }
      expect(onOutcome).not.toHaveBeenCalled();
      for (const overrides of [
        { vault: { data: { chain_id: 1, address: "0xwrong", fee_wad: "50000000000000000", asset: { address: usdc, decimals: 6 } } } },
        { vault: { data: { chain_id: 1, address: vaultAddress, fee_wad: "50000000000000000", asset: { address: "0xwrong", decimals: 6 } } } },
        { state: { data: [] } },
        { state: { data: { chain_id: 1, address: vaultAddress } } },
        { history: { params: { chain_id: "1", vault_address: "0xwrong" }, data: [{ timestamp: observedAt, apy: 0.03 }] } },
        { price: { data: { chain_id: 1, address: "0xwrong", price: 1, timestamp: String(observedAt) } } },
      ]) {
        onOutcome.mockClear();
        mockRest(overrides);
        await expect(reader.run({ db, startSec, onOutcome })).resolves.toBeNull();
        expect.soft(onOutcome.mock.calls).toEqual([[{ label: config.timeoutLabel, outcome: "failed" }]]);
      }
      mockRest();
      const quote = (await reader.run({ db, startSec }))!;
      expect(quote).toMatchObject({ currentApy: 3, apyBase: 3, apyReward: null, sourceKey, sourceObservedAt: observedAt });
      expect(quote.sourceTvlUsd).toBeCloseTo(16_732_334.16, 2);
      const row = { id, symbol: "USDC" };
      const dl = { ...row, yield: { ...quote, sourceKey: corroboratingPoolId, dataSource: "defillama" as const, currentApy: 4, sourceObservedAt: null } };
      const onchain = { ...row, yield: { ...quote, sourceKey: `onchain:${id}`, dataSource: "onchain" as const, currentApy: 5 } };
      const morpho = { ...row, yield: quote };
      const earlier = { ...row, yield: { ...quote, currentApy: 1, sourceObservedAt: observedAt - 60 } };
      const riskFreeRateMeta = makeBenchmarkMeta();
      for (const [i, [resolved, expected]] of ([
        [[earlier], sourceKey], [[dl, onchain, morpho], sourceKey],
        [[dl, onchain], onchain.yield.sourceKey], [[dl, onchain, morpho], sourceKey], [[dl], undefined],
      ] as const).entries()) {
        const publishedAt = startSec + i * 3600;
        const dlPoolsMeta = { ...makeYieldSourceMeta(), updatedAt: publishedAt };
        const evaluation = await evaluateYieldSourcesCooperative(baseEvaluationInput({ startSec: publishedAt, resolved: [...resolved], dlPoolsMeta }));
        expect(evaluation.bestSourceKeyByCoin.get(id)).toBe(expected);
        const { previewRankingsPayload, publicationViews, acceptedSources } = buildPreviewYieldRankingsArtifacts({
          ...evaluation, startSec: publishedAt, riskFreeRateMeta, riskFreeRate: riskFreeRateMeta.rate,
          riskFreeRates: makeBenchmarkRegistry(riskFreeRateMeta), dlPoolsMeta,
          safetySnapshot: makeSafetySnapshotMeta(), medianApy: null,
        });
        const generation = { startSec: publishedAt, generationId: `test-${i}` };
        const rows = buildYieldStorageRows({ ...generation, evaluatedSources: acceptedSources, publicationViews });
        const { rankings } = previewRankingsPayload;
        await publishYieldRowsAtomically(db, { ...generation, ...rows, rankingsPayload: { ...previewRankingsPayload, publication: generation } });
        expect(JSON.parse((await readYieldRankingsCoinCache(db, id))!.value).rankings).toEqual(JSON.parse(JSON.stringify(rankings)));
        if (i === 1) {
          const summary = projectYieldRankingsSummary(previewRankingsPayload);
          expect(summary.rankings[0]).toMatchObject({ currentApy: 3, dataSource: "protocol-api" });
          expect.soft(PreviousRankingsSchema.safeParse(previewRankingsPayload).error?.issues).toBeUndefined();
          expect.soft(PreviousSummarySchema.safeParse(summary).error?.issues).toBeUndefined();
          expect(rankings[0]?.altSources.map(({ currentApy }) => currentApy).sort()).toEqual([4, 5]);
          expect.soft(rankings[0]?.decisionLedger?.selectedReasonDetail).toBe("morpho-net-preferred");
          expect.soft(rankings[0]?.decisionLedger?.alternatives.find((alt) => alt.sourceKey === onchain.yield.sourceKey)?.selectionRank).toBe(2);
          expect.soft(rankings[0]?.altSources.find((alt) => alt.sourceKey === onchain.yield.sourceKey)?.selectionRank).toBe(2);
        }
      }
      expect(sqlite.prepare("SELECT recorded_at, is_best, apy FROM yield_history WHERE source_key = ? ORDER BY recorded_at DESC LIMIT 1")
        .get(corroboratingPoolId)).toEqual({ recorded_at: startSec + 4 * 3600, is_best: 0, apy: 4 });
      expect(sqlite.prepare("SELECT is_best FROM yield_data WHERE source_key = ?").get(corroboratingPoolId)).toEqual({ is_best: 0 });
      const next = baseEvaluationInput({ startSec: startSec + 5 * 3600 });
      const history = await loadYieldHistorySnapshots(db, [id], next.startSec, next.sevenDaysAgoSec, {
        sourceKeysByStablecoin: new Map([[id, new Set([sourceKey])]]),
      });
      expect(history.prevBestRows[0]).toMatchObject({ source_key: sourceKey, recorded_at: startSec + 3 * 3600 });
      const stats = computeYieldCandidateStatistics({ ...quote, currentApy: 6, sourceObservedAt: next.startSec },
        history.historyRows.filter((sample) => sample.source_key === sourceKey), false, next.startSec, next.sevenDaysAgoSec, "fresh");
      expect(stats).toMatchObject({ apy7d: 10 / 3, apy30d: 10 / 3 });
    } finally {
      fetchSource.mockRestore();
      sqlite.close();
    }
  });
  it.each(Object.values(MORPHO_NET_YIELD_SOURCES))("uses $stablecoinId share-price history during a Morpho outage", async (config) => {
    const { stablecoinId: id, sourceKey, corroboratingPoolId } = config;
    const parentId = "usdc-circle";
    const onchainKey = `onchain:${id}`;
    const linkedKey = `linked-variant:${id}:${onchainKey}`;
    const { startSec } = baseEvaluationInput();
    const anchorDays = 15;
    const anchorAt = startSec - anchorDays * 86400;
    const recoveryAt = startSec + 7 * 86400;
    const riskFreeRateMeta = makeBenchmarkMeta();
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      for (const observedAt of [anchorAt, startSec - 3600, startSec, recoveryAt]) {
        const healthy = observedAt === anchorAt;
        const flat = !healthy && observedAt < startSec;
        const outage = observedAt === startSec;
        const vault = { sourcePool: corroboratingPoolId, sourceObservedAt: observedAt };
        const input = baseEvaluationInput({
          startSec: observedAt, stablecoinSupplyById: new Map([[parentId, 10_000_000]]),
          tier1PrevRates: new Map([[id, 1.25]]),
        });
        if (observedAt >= startSec) {
          const { resolved, tier1PrevRates } = await resolveTrackedYieldSources({
            ...input, db, onChainRates: new Map([[id, { rate: outage ? 1.2525 : 1.255 }]]),
            dlPools: [makeDlYieldPool({ pool: corroboratingPoolId, project: "morpho-blue", tvlUsd: 1_000_000 })],
          });
          input.resolved = resolved;
          input.tier1PrevRates = tier1PrevRates;
        } else {
          input.resolved.push({ id, symbol: "VAULT", yield: resolvedYield({ ...vault, sourceKey: onchainKey,
            dataSource: "onchain", currentApy: flat ? 0 : 5, exchangeRate: 1.25 }) });
        }
        if (healthy) input.resolved.push({ id, symbol: "VAULT", yield: resolvedYield({ ...vault, sourceKey, dataSource: "protocol-api", currentApy: 3 }) });
        appendLinkedVariantParentYieldSources(input.resolved);
        const history = await loadYieldHistorySnapshots(db, [id, parentId], observedAt, input.sevenDaysAgoSec, {
          sourceKeysByStablecoin: new Map([[id, new Set([onchainKey])], [parentId, new Set([linkedKey])]]),
        });
        if (!healthy) expect(history.historyRows.filter((row) => row.data_source === "onchain")
          .map((row) => row.exchange_rate).sort((a, b) => (a ?? 0) - (b ?? 0)))
          .toEqual(observedAt === recoveryAt ? [1.25, 1.2525] : [1.25]);
        const evaluation = await evaluateYieldSourcesCooperative({ ...input, ...await buildYieldHistoryEvaluationInputsCooperative(history) });
        const { previewRankingsPayload, publicationViews, acceptedSources } = buildPreviewYieldRankingsArtifacts({
          ...evaluation, startSec: observedAt, riskFreeRateMeta, riskFreeRate: riskFreeRateMeta.rate,
          riskFreeRates: makeBenchmarkRegistry(riskFreeRateMeta), dlPoolsMeta: makeYieldSourceMeta(), safetySnapshot: makeSafetySnapshotMeta(),
        });
        const generation = { startSec: observedAt, generationId: `test-${observedAt}` };
        const rows = buildYieldStorageRows({
          ...generation, evaluatedSources: acceptedSources, publicationViews,
          anchorOnlySources: input.resolved.filter((entry) => entry.yield?.observationKind === "anchor-only"),
        });
        await publishYieldRowsAtomically(db, { ...generation, ...rows, rankingsPayload: { ...previewRankingsPayload, publication: generation } });
        const [published] = JSON.parse((await readYieldRankingsCoinCache(db, parentId))!.value).rankings;
        if (flat) {
          expect(previewRankingsPayload.rankings).toEqual([]);
          expect(published).toBeUndefined();
          continue;
        }
        if (outage) {
          // The expired anchor derives no return; the fresh share price must
          // persist as the next comparison anchor instead of being discarded.
          expect(previewRankingsPayload.rankings).toEqual([]);
          expect(published).toBeUndefined();
          expect(sqlite.prepare("SELECT exchange_rate, apy, apy_base FROM yield_history WHERE source_key = ? AND recorded_at = ?")
            .get(onchainKey, startSec)).toEqual({ exchange_rate: 1.2525, apy: 0, apy_base: null });
          continue;
        }
        // Recovery: the next seven-day comparison derives its return from the
        // outage run's persisted anchor; apy30d keeps the oldest window anchor.
        const expectedApy = computeApyFromRate(1.255, 1.2525, 7);
        const expectedApy30d = computeApyFromRate(1.255, 1.25, anchorDays + 7);
        expect(published).toMatchObject(healthy
          ? { currentApy: 3, provenance: { sourceKey: `linked-variant:${id}:${sourceKey}` } }
          : { currentApy: expectedApy, apy30d: expectedApy30d, sourceTvlUsd: 1_000_000,
            provenance: { sourceKey: linkedKey, apy30dAnchorObservedAt: anchorAt } });
        const priorRate = sqlite.prepare("SELECT exchange_rate_prev FROM yield_data WHERE stablecoin_id = ? AND source_key = ?");
        if (healthy) {
          expect.soft(priorRate.get(id, sourceKey)).toEqual({ exchange_rate_prev: null });
          expect.soft(priorRate.get(parentId, `linked-variant:${id}:${sourceKey}`)).toEqual({ exchange_rate_prev: null });
        } else {
          expect(priorRate.get(parentId, linkedKey)).toEqual({ exchange_rate_prev: 1.2525 });
          const { rows: selectorRows } = buildSelectorRows({
            yieldData: previewRankingsPayload, now: observedAt, stablecoinsData: null, pegData: null,
            reportData: null, stressData: null, dexData: null, bluechipData: null,
          });
          for (const [coinId, fallbackKey] of [[id, onchainKey], [parentId, linkedKey]]) {
            expect.soft(selectYieldSource(selectorRows.get(coinId)!, makeInput({ profile: "yield", minApy: 3 })))
              .toMatchObject({ sourceKey: fallbackKey, chain: "ethereum", apy30d: expectedApy30d });
          }
        }
      }
    } finally {
      sqlite.close();
    }
  });

  it.each(Object.values(MORPHO_NET_YIELD_SOURCES))("resolves $stablecoinId price fallback with a positive comparison pin and unusable RPC", async ({ stablecoinId: id, corroboratingPoolId }) => {
    const { startSec } = baseEvaluationInput();
    const input = baseEvaluationInput({
      stablecoinSupplyById: new Map([["usdc-circle", 10_000_000]]),
      dlPoolsMeta: { ...makeYieldSourceMeta(), updatedAt: startSec },
    });
    const price = { apy: 5.35, sourceObservedAt: input.startSec, comparisonAnchorObservedAt: input.sevenDaysAgoSec };
    for (const [apy, staleRpc] of [[4, false], [8, false], [8, true]] as const) {
      const pool = makeDlYieldPool({ pool: corroboratingPoolId, project: "morpho-blue", apy, apyBase: apy });
      await vi.mocked(getPriceDerivedApy).withImplementation(async (_db, coinId) => coinId === id ? price : null, async () => {
        const db = mockD1(staleRpc ? [matchMarker("yield-sync:tier1-previous-rate", [{
          stablecoin_id: id, exchange_rate: 1.25, recorded_at: input.startSec - 15 * 86400,
        }])] : []);
        const { resolved } = await resolveTrackedYieldSources({
          ...input, db, dlPools: [pool], onChainRates: new Map(staleRpc ? [[id, { rate: 1.2525 }]] : []),
        });
        const evaluation = await evaluateYieldSourcesCooperative({ ...input, resolved });
        const { bestSourceKeyByCoin, evaluatedSources } = evaluation;
        const comparisons = evaluatedSources.filter((row) => row.id === id && row.sourceKey === corroboratingPoolId);
        expect.soft(comparisons[0])
          .toMatchObject({ currentApy: apy, rejected: false });
        expect.soft(getPublishableNonOnchainCoverageIds(comparisons).has(id)).toBe(false);
        expect.soft(getPublishableNonOnchainCoverageIds(evaluatedSources).has(id)).toBe(true);
        expect.soft(bestSourceKeyByCoin.get(id), `comparison APY ${apy}, stale RPC ${staleRpc}`).toBe("price-derived");
        expect.soft(bestSourceKeyByCoin.get("usdc-circle"), `comparison APY ${apy}, stale RPC ${staleRpc}`).toBe(`linked-variant:${id}:price-derived`);
        const riskFreeRateMeta = makeBenchmarkMeta();
        const { previewRankingsPayload } = buildPreviewYieldRankingsArtifacts({
          ...evaluation, startSec: input.startSec, riskFreeRateMeta, riskFreeRate: riskFreeRateMeta.rate,
          riskFreeRates: input.riskFreeRates, dlPoolsMeta: input.dlPoolsMeta!, safetySnapshot: makeSafetySnapshotMeta(),
        });
        const { rows } = buildSelectorRows({
          yieldData: previewRankingsPayload, now: input.startSec, stablecoinsData: null, pegData: null,
          reportData: null, stressData: null, dexData: null, bluechipData: null,
        });
        for (const [coinId, sourceKey] of [[id, "price-derived"], ["usdc-circle", `linked-variant:${id}:price-derived`]]) {
          expect.soft(selectYieldSource(rows.get(coinId)!, makeInput({ profile: "yield", minApy: 3 })))
            .toMatchObject({ sourceKey, chain: "ethereum", apy30d: price.apy });
        }
      });
    }
  });

  it("preserves the prior venue evidence for the stUSDS on-chain return", async () => {
    const id = "stusds-sky";
    const input = baseEvaluationInput();
    const db = mockD1([matchMarker("yield-sync:tier1-previous-rate", [{
      stablecoin_id: id, exchange_rate: 1.25, recorded_at: input.sevenDaysAgoSec,
    }])], { assertMatchesUsed: true });
    const { resolved } = await resolveTrackedYieldSources({
      ...input, db, dlPools: [], onChainRates: new Map([[id, { rate: 1.2525, sourceTvlUsd: 1_000_000 }]]),
    });
    const onchain = resolved.find((entry) => entry.id === id && entry.yield?.dataSource === "onchain")?.yield;
    expect(onchain?.currentApy).toBeGreaterThan(3);
    expect(onchain?.chain).toBeUndefined();
  });

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

  it.each([["throw", false], ["null", false], ["null", true]] as const)("publishes a negative holder observation despite optional %s (stale: %s)", async (mode, stale) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const startSec = Math.floor(Date.now() / 1000);
      const publishedAt = startSec + (stale ? STALE_THRESHOLD_MS / 1000 + 1 : 0);
      const entry = TRACKED_OPTIONAL_SOURCE_REGISTRY.find((source) => source.stablecoinId === "ybold-yearn")!;
      TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.set(entry.stablecoinId, [entry]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchSource = vi.spyOn(fetchRetry, "fetchJsonWithRetry");
      if (mode === "throw") fetchSource.mockRejectedValueOnce(new Error("Yearn unavailable"));
      else fetchSource.mockResolvedValueOnce({ response: new Response("{}"), body: {} });
      const onOutcome = vi.fn();
      const native = makeDlYieldPool({
        pool: YIELD_POOL_MAP["susde-ethena"], symbol: "sUSDe", apy: -5, apyBase: -5,
      });
      const { resolved } = await resolvePools([native], onOutcome);
      expect(onOutcome.mock.calls).toEqual(mode === "throw" ? [[{ label: "Yearn yBOLD source", outcome: "failed" }]] : []);
      const failures = warn.mock.calls.map(([line]) => JSON.parse(line))
        .filter((record) => record.event === "optional_yield_source_failed");
      expect(failures).toHaveLength(mode === "throw" ? 1 : 0);
      if (mode === "throw") expect(failures[0]).toMatchObject({
        source: "Yearn yBOLD source", errorMessage: "Yearn unavailable",
      });
      expect(resolved.filter((source) => source.id === "ybold-yearn" && source.yield != null)).toEqual([]);
      const holder = resolved.find((entry) => entry.id === "susde-ethena");
      expect(holder?.yield).toMatchObject({ currentApy: -5 });
      const riskFreeRateMeta = makeBenchmarkMeta();
      const riskFreeRates = makeBenchmarkRegistry(riskFreeRateMeta);
      const evaluation = await evaluateYieldSourcesCooperative(baseEvaluationInput({
        startSec, riskFreeRates,
        resolved: [{ id: "susde-ethena", symbol: "sUSDe", yield: { ...holder!.yield!, sourceObservedAt: startSec } }],
        safetyScores: new Map([["susde-ethena", { score: 80, grade: "B+" }]]),
        stablecoinSupplyById: new Map([["susde-ethena", 10_000_000]]),
      }), { yieldToEventLoop: () => Promise.resolve() });
      expect(evaluation.evaluatedSources[0]).toMatchObject({
        currentApy: -5, pharosYieldScore: null, pysNullReason: "apy-non-positive", rejected: false,
      });
      const artifacts = buildPreviewYieldRankingsArtifacts({
        evaluatedSources: evaluation.evaluatedSources, bestSourceKeyByCoin: evaluation.bestSourceKeyByCoin,
        riskFreeRate: riskFreeRateMeta.rate, riskFreeRateMeta, riskFreeRates,
        dlPoolsMeta: makeYieldSourceMeta(), safetySnapshot: makeSafetySnapshotMeta(), medianApy: -5, startSec: publishedAt,
      });
      const result = await publishYieldCoordinatorResults({
        db, startSec: publishedAt, previewRankingsPayload: artifacts.previewRankingsPayload,
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
        currentApy: -5, pharosYieldScore: null, pysNullReason: stale ? "source-stale" : "apy-non-positive",
        provenance: { scoreQualified: !stale },
      });
    } finally {
      TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.clear();
      vi.restoreAllMocks();
      vi.useRealTimers();
      sqlite.close();
    }
  });

  it("isolates a D1 anchor-read failure in the Ondo USDY oracle entry", async () => {
    const db = mockD1(
      [matchMarker("yield-sync:nav-oracle-prior-anchor", [], { throwError: new Error("D1_ERROR: disk I/O error") })],
      { assertMatchesUsed: true },
    );
    const onOutcome = vi.fn();
    const entry = TRACKED_OPTIONAL_SOURCE_REGISTRY.find((candidate) => candidate.stablecoinId === "usdy-ondo-finance"
      && candidate.sourceKey === "protocol-api:ondo-usdy-continuous-oracle");
    expect(entry).toBeDefined();

    // A reader failure is one failed optional source, not a whole-run abort.
    await expect(entry!.run({ db, startSec: 1_771_000_000, onOutcome })).resolves.toBeNull();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({ label: "Ondo USDY oracle source", outcome: "failed" });
  });
});
