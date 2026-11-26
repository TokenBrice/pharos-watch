import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { projectFrozenSnapshotLiveSummary } from "@/lib/frozen-snapshot-live-summary";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { MintBurnFlowsResponse } from "@shared/types/mint-burn";
import type { PegSummaryCoin, PegSummaryResponse } from "@shared/types/peg";
import { StablecoinLiveSummarySchema, type StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { makePegSummaryCoin as makePegSummaryCoinBase } from "@/test-utils/peg-summary-fixtures";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { formatObservedPrice } from "../current-peg";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";
import { deriveIndicativeDeviationBps, deriveSupplyFromMarketCap } from "../stablecoin-detail-derive";
import { makeBuildStablecoinDetailViewModelParams, makeReadyDetailParams } from "./fixtures/stablecoin-detail-view-model";
import { buildDetailMarketSnapshot, buildDetailPegPriceSnapshot, buildDetailStaleQueries, buildDetailFeatureSnapshot, resolveDetailGradeRead } from "../stablecoin-detail-query-view-model";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { deriveDataHealth, isPublicWarning } from "../data-health";
import { DATA_HEALTH_PRESETS } from "../data-health-config";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-client-coin";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";

const coinOf = (id: string) => TRACKED_META_BY_ID.get(id)!;
const makePegSummaryCoin = (overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin =>
  makePegSummaryCoinBase({ id: "usdt-tether", symbol: "USDT", name: "Tether", ...overrides });

type ReadyVM = Extract<ReturnType<typeof buildStablecoinDetailViewModel>, { status: "ready" }>;
type ReadyOverrides = Omit<Parameters<typeof makeReadyDetailParams>[0], "id" | "coin"> & {
  id?: string;
  coin?: Parameters<typeof makeReadyDetailParams>[0]["coin"];
};

function readyModel({ id = "usdt-tether", coin = coinOf(id), ...rest }: ReadyOverrides = {}): ReadyVM {
  const vm = buildStablecoinDetailViewModel(makeReadyDetailParams({ id, coin, ...rest }));
  expect(vm.status).toBe("ready");
  if (vm.status !== "ready") throw new Error(`Expected ready view-model, got ${vm.status}`);
  return vm;
}

const reserveLane = (params: Parameters<typeof buildStablecoinDetailViewModel>[0], id = "usdt-tether") =>
  buildDetailStaleQueries(params.queries, params.supplemental, id).find((e) => e.label === "Live Reserves")!;

const reserveHealth = (query: ReturnType<typeof reserveLane>, now: number) =>
  deriveDataHealth({ ...query, label: "Live Reserves", staleTime: query.staleTime! }, now);

function makeLiveReserves(
  fetchedAt: number,
  freshnessOverrides: Record<string, unknown> = {},
  syncOverrides: Record<string, unknown> = {},
  topOverrides: Record<string, unknown> = {},
): ReserveResult {
  return {
    mode: "live", reserves: [], estimated: false, liveAt: fetchedAt, ...topOverrides,
    sync: {
      enabled: true, status: "ok", stale: false, bootstrap: false, ...syncOverrides,
      freshness: {
        stale: false, staleReasons: [], assessedAt: fetchedAt, fetchedAt, attemptId: "reserve-attempt",
        fetchAgeSec: 0, fetchBudgetSec: 48 * 3600, freshnessMode: "verified",
        sourceFreshnessInvalid: false, sourceTimestamp: null, sourceAgeSec: null,
        sourceAgeBudgetSec: null, sourceAgeBudgetCap: null, ...freshnessOverrides,
      },
    },
  } as ReserveResult;
}

describe("stablecoin detail view-model builder", () => {
  it.each([true, false])("preserves the unsettled-seed flag on both seeded lanes (%s)", (awaitingLiveRead) => {
    const params = makeBuildStablecoinDetailViewModelParams({ queries: { liveSummary: { awaitingLiveRead }, supplyHistory: { awaitingLiveRead } } });
    const queries = buildDetailStaleQueries(params.queries, params.supplemental, params.core.id);
    expect(queries.find((q) => q.label === "Detail snapshot")).toHaveProperty("awaitingLiveRead", awaitingLiveRead);
    expect(queries.find((q) => q.label === "Supply history")).toHaveProperty("awaitingLiveRead", awaitingLiveRead);
    expect(queries.filter((q) => !["Detail snapshot", "Supply history"].includes(q.label ?? "")).every((q) => q.awaitingLiveRead === undefined)).toBe(true);
  });

  it.each([[22, false], [80, true]] as const)("reads a %sh daily-history fallback as provenance, banner %s", (h, warns) => {
    const params = makeReadyDetailParams({ id: "usdt-tether", coin: coinOf("usdt-tether"), queries: { liveSummary: {
      meta: { updatedAt: 1e9 - h * 3600, ageSeconds: h * 3600, status: "stale", reason: "detail-history-fallback", freshBudgetSec: 259_200 },
    } } });
    const lane = buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether")[0];
    expect(lane.dailySnapshot).toBe(true);
    expect(isPublicWarning(deriveDataHealth({ ...DATA_HEALTH_PRESETS.stablecoins, ...lane }, 1e12))).toBe(warns);
  });

  it("keeps a cold summary read loading rather than classifying the tracked ID as absent", () => {
    expect(buildStablecoinDetailViewModel(makeBuildStablecoinDetailViewModelParams({ queries: { liveSummary: { isLoading: true } } })).status).toBe("loading");
  });

  it.each([["usdc-circle", "peggedUSD", 1], ["eurc-circle", "peggedEUR", 1.2], ["usnd-nerite", "peggedUSD", 0.42]] as const)(
    "keeps direct-summary quote and supply provenance for %s",
    (id, pegType, price) => {
      const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" as const };
      const model = readyModel({
        id,
        asset: { price, priceObservedAt: 1_700_000_001, priceUpdatedAt: 1_700_000_002, priceSyncedAt: 1_700_000_003, priceObservedAtMode: "upstream", supplyObservedAt: 1_700_000_000, supplyRestored: true, nominalPriceReference },
        nativeSupply: { current: 90, prevWeek: 80, prevMonth: 70 },
      });
      expect(model.coinData).toMatchObject({ price, pegType, nominalPriceReference, supplyRestored: true, supplyObservedAt: 1_700_000_000, priceObservedAt: 1_700_000_001, priceUpdatedAt: 1_700_000_002, priceSyncedAt: 1_700_000_003 });
      expect(model.hero.coinData).toBe(model.coinData);
      expect(model.nativeSupply).toEqual({ current: 90, prevWeek: 80, prevMonth: 70 });
      expect(model.supply).toBeCloseTo(pegType === "peggedUSD" ? 100 / price : 90);
    },
  );

  it("keeps explicit zero supply through the hero instead of reviving older positive checkpoints", () => {
    const model = readyModel({ id: "usdc-circle", asset: { circulating: { peggedUSD: 0 }, price: 1, priceSource: "coingecko" }, nativeSupply: { current: 0, prevWeek: 200, prevMonth: 300 } });
    expect(model.hero.market.supply).toBe(0);
    expect(model.hero.market.supplyTrend).toMatchObject({ current: 0, safePrevWeek: 200, safePrevMonth: 300 });
    for (const asset of [{ circulating: {}, price: 1 }, { circulating: { peggedUSD: 0 }, price: null }, { circulating: { peggedUSD: 0 }, price: 0 }] as Partial<StablecoinLiveSummary>[]) {
      const unavailable = readyModel({ id: "usdc-circle", asset: { ...asset, priceSource: "coingecko" }, nativeSupply: { current: 100, prevWeek: 200, prevMonth: 300 } });
      expect(unavailable.hero.market.supply).toBeNull();
      expect(unavailable.hero.market.supplyTrend.current).toBe(100);
    }
  });

  it.each([[100, 200_000], [0, 200_000], [null, 200_000], [null, 0]] as const)(
    "uses PAXG's native supply %s for the headline and trend at USD market cap %s",
    (current, mcap) => {
      const model = readyModel({ id: "paxg-paxos", asset: { price: 3_000, priceSource: "coingecko", circulating: { peggedGOLD: mcap } }, nativeSupply: { current, prevWeek: 90, prevMonth: 80 } });
      expect(model).toMatchObject({ status: "ready", mcap, supply: current });
      expect(model.hero.market).toMatchObject({ supply: current, supplyTrend: { current } });
    },
  );

  it("keeps legacy fallback and explicit PAXG quantity distinct across the compact Worker-to-Pages boundary", () => {
    const coin = coinOf("paxg-paxos");
    const now = 1_795_000_000;
    for (const [quantity, expected] of [[undefined, 200_000 / 3_000], [100, 100], [null, null]] as const) {
      const wire = projectStablecoinLiveSummary({ currentCirculatingUSD: { peggedGOLD: 200_000 }, currentSupplyObservedAt: now - 240, currentCirculatingNative: quantity, price: 3_000, priceSource: "coingecko", priceObservedAt: now - 60 }, coin.id);
      const summary = StablecoinLiveSummarySchema.parse(JSON.parse(JSON.stringify(wire)));
      expect(buildDetailMarketSnapshot(coin, summary, summary.nativeSupply, [], now * 1000)).toMatchObject({ mcap: 200_000, supply: expected });
    }
  });

  it.each([
    [undefined, 210_000], [{}, null], [{ day: null }, null],
    [{ day: { observedAt: 1_790_706_600, circulatingUsd: 200_000, circulatingNative: 100 } }, 200_000],
  ] as const)("uses the dated detail day baseline (%j) before legacy buckets", (supplyChangeBaselines, expected) => {
    const coin = coinOf("paxg-paxos");
    const params = makeReadyDetailParams({ id: coin.id, coin, asset: { circulating: { peggedGOLD: 210_000 }, circulatingPrevDay: { peggedGOLD: 210_000 }, supplyChangeBaselines, price: 2_100 } });
    expect(buildDetailMarketSnapshot(coin, params.queries.liveSummary.data!, null, [], 1_790_793_000_000).prevDay).toBe(expected);
  });

  it("keeps the retained dossier ready through a failed summary refresh and recovery", () => {
    const coin = coinOf("usdc-circle");
    const params = makeReadyDetailParams({ id: coin.id, coin });
    const failure = new Error("HTTP 502");
    params.queries.liveSummary.error = failure;
    const retained = buildStablecoinDetailViewModel(params);
    expect(retained.status).toBe("ready");
    if (retained.status !== "ready") return;
    const query = retained.staleQueries.find((e) => e.preset === "stablecoins")!;
    expect(query.label).toBe("Detail snapshot");
    expect(deriveDataHealth({ ...DATA_HEALTH_PRESETS.stablecoins, ...query }).degradationReason).toBe("refresh");
    params.queries.liveSummary.error = null;
    expect(buildStablecoinDetailViewModel(params).status).toBe("ready");
    params.queries.liveSummary.data = undefined;
    params.queries.liveSummary.error = failure;
    expect(buildStablecoinDetailViewModel(params)).toMatchObject({ status: "list-error", listError: failure });
  });

  it("keeps current listing supply independent of unavailable baselines and preserves absent supply as null", () => {
    const coin = coinOf("usdc-circle");
    const present = buildDetailMarketSnapshot(coin, { id: coin.id, circulating: { peggedUSD: 477_309_888.38 }, circulatingPrevDay: {}, price: 0.99985, priceSource: "coingecko", priceConfidence: "single-source" } as never, null, [], 1_790_793_000_000);
    expect(present.mcap).toBe(477_309_888.38);
    expect(present.supply).toBeCloseTo(477_309_888.38 / 0.99985);
    expect(present.prevDay).toBeNull();

    const absent = buildDetailMarketSnapshot(coin, { circulating: {}, circulatingPrevDay: {}, price: 1, priceSource: "coingecko" } as never, { current: 454_459_687.73, prevWeek: null, prevMonth: null }, [], 1_790_793_000_000);
    expect([absent.mcap, absent.supply]).toEqual([null, null]);
  });

  it("uses coin-scoped liquidity warnings without hiding stale producer data or legacy advisories", () => {
    const now = Date.now();
    const globalWarning = '199 - "Quality drift: major-tvl-cliff:crvusd-curve"';
    const params = makeBuildStablecoinDetailViewModelParams({ queries: { dexLiquidity: {
      data: { "xsgd-straitsx": makeDexLiquidityData({ warning: null }) }, dataUpdatedAt: now,
      meta: { updatedAt: now / 1000 - 60, ageSeconds: 60, status: "fresh", warning: globalWarning },
    } } });
    const health = () => deriveDataHealth({ ...DATA_HEALTH_PRESETS.dexLiquidity, ...buildDetailStaleQueries(params.queries, params.supplemental, "xsgd-straitsx").find((e) => e.preset === "dexLiquidity")! });
    expect(health().state).toBe("fresh");
    params.queries.dexLiquidity.data!["xsgd-straitsx"].warning = globalWarning;
    expect(health().state).toBe("degraded");
    delete params.queries.dexLiquidity.data!["xsgd-straitsx"].warning;
    expect(health().state).toBe("degraded");
    params.queries.dexLiquidity.data!["xsgd-straitsx"].warning = null;
    params.queries.dexLiquidity.meta!.updatedAt = now / 1000 - 13 * 4 * 3600;
    expect(health().state).toBe("stale");
  });

  it.each(["source-stale", "publication-held"])("scopes coin flow health away from optional market FTQ: %s", (reason) => {
    const now = Date.now();
    const classificationWarning = `Flight-to-quality classification unavailable: Safety Score dependency (${reason}); budget 1h.`;
    const transportWarning = `199 - "${classificationWarning}"`;
    const data: MintBurnFlowsResponse = {
      gauge: { score: 0, band: "NEUTRAL", intensitySemantics: "signed-v2", flightToQuality: null, flightIntensity: null, classificationSource: "unavailable", classificationReason: reason, safetyScoreIdentity: null, trackedCoins: 1, trackedMcapUsd: 100 },
      coins: [makeMintBurnFlowCoin({ stablecoinId: "usdt-tether", symbol: "USDT" })],
      hourly: [], updatedAt: now / 1000,
      sync: { lastSuccessfulSyncAt: now / 1000, freshnessStatus: "fresh", criticalLaneHealthy: true, warning: null, classificationWarning },
    };
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { flows: {
      data, enabled: true, dataUpdatedAt: now,
      meta: {
        updatedAt: now / 1000 - 60, ageSeconds: 60, status: "fresh", freshBudgetSec: 28800, degradedBudgetSec: 43200, warning: transportWarning,
        dependencies: { flightToQuality: { status: "unavailable", reason, updatedAt: now / 1000 - 4000, freshBudgetSec: 3600, generationId: "accepted-safety-publication" } },
      },
    } } });
    const query = () => buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether").find((e) => e.preset === "mintBurnFlows")!;
    const health = () => deriveDataHealth({ ...DATA_HEALTH_PRESETS.mintBurnFlows, ...query() }, now);
    expect(health().state).toBe("fresh");
    expect(query().hasData).toBe(true);
    expect(query().meta?.dependencies?.flightToQuality).toBeUndefined();
    expect(params.supplemental.flows.meta?.warning).toBe(transportWarning);
    expect(query().meta?.updatedAt).toBe(now / 1000 - 60);

    params.supplemental.flows.meta!.warning = `${transportWarning}, 199 - "Coin valuation needs review (a,b)"`;
    expect(health().state).toBe("degraded");
    expect(query().meta?.warning).toBe('199 - "Coin valuation needs review (a,b)"');
    params.supplemental.flows.meta!.warning = transportWarning;
    params.supplemental.flows.meta!.dependencies!.ingestion = { status: "degraded", reason: "incomplete-scan" };
    expect(health().degradationReason).toBe("source");
    delete params.supplemental.flows.meta!.dependencies!.ingestion;
    data.sync!.warning = "Critical flow lane is lagging";
    expect(health().state).toBe("degraded");
    expect(query().meta?.warning).toContain("Critical flow lane is lagging");
    data.sync!.warning = null;

    params.supplemental.flows.error = new Error("flow transport failed");
    expect(health().degradationReason).toBe("refresh");
    params.supplemental.flows.error = null;
    params.supplemental.flows.meta!.updatedAt = now / 1000 - 43201;
    expect(health().state).toBe("stale");
    params.supplemental.flows.meta!.updatedAt = now / 1000 - 60;
    delete params.supplemental.flows.meta!.dependencies!.flightToQuality;
    expect(health().state).toBe("degraded");
  });

  it("does not monitor a successful aggregate with no rendered coin flow lane", () => {
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { flows: {
      enabled: true, dataUpdatedAt: Date.now(),
      data: { gauge: { score: null, band: null, intensitySemantics: "signed-v2", flightToQuality: null, flightIntensity: null, classificationSource: "unavailable", trackedCoins: 0, trackedMcapUsd: 0 }, coins: [], hourly: [], updatedAt: Date.now() / 1000 },
      meta: { status: "degraded", warning: '199 - "Optional market classification unavailable"' },
    } } });
    const flowQuery = () => buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether").find((e) => e.preset === "mintBurnFlows");
    expect(flowQuery()).toBeUndefined();
    params.supplemental.flows.data = undefined;
    params.supplemental.flows.isLoading = true;
    expect(flowQuery()).toMatchObject({ hasData: false, isLoading: true });
    params.supplemental.flows.isLoading = false;
    params.supplemental.flows.error = new Error("flow read failed");
    expect(flowQuery()).toMatchObject({ hasData: false, error: params.supplemental.flows.error });
  });

  it("ages reserves from independent producer/source budgets, never a fresh request receipt", () => {
    const now = 1_790_000_000_000;
    const fetchedAt = now / 1000 - 3600;
    const sourceAt = now / 1000 - 3 * 86400;
    const live = makeLiveReserves(fetchedAt, { sourceTimestamp: sourceAt, sourceAgeSec: 0, sourceAgeBudgetSec: 2 * 86400, sourceAgeBudgetCap: "scoring" });
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: { live, enabled: true, dataUpdatedAt: now } } });
    const sourceQuery = reserveLane(params);
    expect(sourceQuery.dataUpdatedAt).toBe(sourceAt * 1000);
    expect(sourceQuery.meta).toMatchObject({ updatedAt: sourceAt, freshBudgetSec: 2 * 86400 });
    expect(reserveHealth(sourceQuery, now).state).toBe("degraded");
    expect(isPublicWarning(reserveHealth(sourceQuery, now))).toBe(false);
    expect(reserveHealth(sourceQuery, (sourceAt + 12 * 2 * 86400) * 1000).state).toBe("degraded");
    expect(reserveHealth(sourceQuery, (sourceAt + 12 * 2 * 86400) * 1000 + 1).state).toBe("stale");
    for (const mode of ["live-stale", "curated-fallback", "template-fallback", "unavailable"] as const) {
      params.supplemental.reserves.live = { ...live, mode, sync: { ...live.sync!, stale: true } };
      const q = reserveLane(params);
      expect(reserveHealth(q, now).state).not.toBe("fresh");
      expect(q.meta?.dependencies?.reserveEvidence.reason).toContain(mode);
      expect(q.dataUpdatedAt).not.toBe(now);
    }
    params.supplemental.reserves.live = { ...live, sync: undefined, liveAt: undefined };
    expect(reserveLane(params)).toMatchObject({ dataUpdatedAt: 0, meta: { updatedAt: null, status: "unknown" } });
    for (const missingSource of [{ sourceTimestamp: null }, { sourceAgeBudgetSec: null }]) {
      params.supplemental.reserves.live = { ...live, sync: { ...live.sync!, freshness: { ...live.sync!.freshness!, ...missingSource } } };
      expect(reserveLane(params)).toMatchObject({ dataUpdatedAt: 0, meta: { updatedAt: null, status: "unknown" } });
    }
  });

  it("ages unverified, public-expiry, and uncertain-write reserve feeds accurately", () => {
    const now = 1_790_000_000_000;
    const nowSec = now / 1000;
    const unverifiedParams = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
      enabled: true, dataUpdatedAt: now,
      live: makeLiveReserves(nowSec - 60, { attemptId: "cngn-attempt", freshnessMode: "unverified" }, {}, { reserves: [{ name: "Bank deposits", pct: 100, risk: "medium" }] }),
    } } });
    const unverifiedQ = reserveLane(unverifiedParams, "il-compliant-naira");
    expect(unverifiedQ).toMatchObject({ hasData: true, dataUpdatedAt: (nowSec - 60) * 1000, meta: { updatedAt: nowSec - 60 } });
    expect(reserveHealth(unverifiedQ, now).state).toBe("fresh");
    expect(isPublicWarning(reserveHealth(unverifiedQ, now))).toBe(false);

    const fetchedAt = nowSec - 25 * 86400;
    const expiryParams = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
      enabled: true, dataUpdatedAt: now,
      live: makeLiveReserves(fetchedAt, { stale: true, staleReasons: ["fetch-age"], assessedAt: nowSec, fetchAgeSec: 25 * 86400, fetchBudgetSec: 2 * 86400, sourceTimestamp: nowSec - 59 * 86400, sourceAgeSec: 59 * 86400, sourceAgeBudgetSec: 30 * 86400, sourceAgeBudgetCap: "scoring" }, { status: "degraded", stale: true }, { mode: "live-stale" }),
    } } });
    const expiryQ = reserveLane(expiryParams);
    expect(expiryQ.dataUpdatedAt).toBe(fetchedAt * 1000);
    expect(expiryQ.meta).toMatchObject({ updatedAt: fetchedAt, freshBudgetSec: 2 * 86400, degradedBudgetSec: 24 * 86400, status: "stale" });
    expect(expiryQ.meta?.dependencies?.reserveEvidence.reason).toContain(`fetch budget ${2 * 86400} seconds`);
    expect(expiryQ.meta?.dependencies?.reserveEvidence.reason).toContain(`source budget ${30 * 86400} seconds`);
    expect(reserveHealth(expiryQ, now).state).toBe("stale");
    expect(isPublicWarning(reserveHealth(expiryQ, now))).toBe(true);

    const uncertainParams = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
      enabled: true, dataUpdatedAt: now,
      live: makeLiveReserves(nowSec - 60, { attemptId: "saved-attempt", fetchBudgetSec: 172800, freshnessMode: "not-applicable" }, { status: "error", uncertainWrite: true, failureCategory: "write-uncertain" }),
    } } });
    const uncertainQ = reserveLane(uncertainParams);
    expect(uncertainQ.meta).toMatchObject({ updatedAt: nowSec - 60, status: "degraded" });
    expect(uncertainQ.meta?.warning).toContain("uncertain-write");
    expect(reserveHealth(uncertainQ, now).state).toBe("degraded");
  });

  it("ages a restored supply on its original observation clock, never receipt time", () => {
    const now = 1_790_000_000_000;
    const nowSec = now / 1000;
    const params = makeReadyDetailParams({ id: "usdt-tether", coin: coinOf("usdt-tether") });
    const supplyLane = () => buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether").find((e) => e.label === "Supply");
    expect(supplyLane()).toBeUndefined();
    const summary = params.queries.liveSummary.data!;
    params.queries.liveSummary = { ...params.queries.liveSummary, dataUpdatedAt: now, meta: { updatedAt: nowSec, ageSeconds: 0, status: "fresh" }, data: { ...summary, supplyRestored: true, supplyObservedAt: nowSec - 3600 } };
    const recent = supplyLane()!;
    expect(recent).toMatchObject({ dataUpdatedAt: (nowSec - 3600) * 1000, hasData: true, staleTime: 600_000, secondary: true });
    expect(isPublicWarning(deriveDataHealth({ ...recent, label: "Supply", staleTime: recent.staleTime! }, now))).toBe(false);
    params.queries.liveSummary.data = { ...summary, supplyRestored: true, supplyObservedAt: nowSec - 7201 };
    const old = supplyLane()!;
    expect(old.secondary).toBe(true);
    expect(deriveDataHealth({ ...old, label: "Supply", staleTime: old.staleTime! }, now).state).toBe("stale");
    params.queries.liveSummary.data = { ...summary, supplyRestored: true, supplyObservedAt: null };
    expect(supplyLane()).toMatchObject({ dataUpdatedAt: 0, secondary: true, meta: { updatedAt: null, status: "stale" } });
    params.queries.liveSummary.data = { ...summary, supplyRestored: true, supplyObservedAt: nowSec - 60, circulating: { peggedUSD: 0 } };
    expect(supplyLane()).toMatchObject({ hasData: true, secondary: true });
  });

  it.each([
    ["USD", "usdt-tether", "peggedUSD", 1, -200, false],
    ["non-USD", "eurc-circle", "peggedEUR", 1.2, -1000, false],
    ["commodity", "xaut-tether", "peggedGOLD", 3000, 100, false],
    ["unavailable reference", "eurc-circle", "peggedEUR", null, null, true],
    ["unavailable price", "usdc-circle", "peggedUSD", 1, null, false],
    ["NAV", "fpi-frax", "peggedVAR", null, null, false],
  ] as const)("pins the %s Worker peg projection", (_label, id, pegType, pegReference, currentDeviationBps, pegReferenceUnavailable) => {
    const coin = coinOf(id);
    const pegSummaryCoin = makePegSummaryCoin({
      id, name: coin.name, symbol: coin.symbol, pegType, pegCurrency: coin.flags.pegCurrency, currentDeviationBps,
      pegReference: pegReference == null ? null : { valueUsd: pegReference, source: "median", contributorCount: 2, asOf: 1_700_000_000 },
      ...(pegReferenceUnavailable ? { pegReferenceUnavailable: true } : {}),
    });
    expect(buildDetailPegPriceSnapshot(id, coin, { coins: [pegSummaryCoin], summary: null, methodology: {} } as PegSummaryResponse))
      .toMatchObject({ pegRef: pegReference, deviationBps: currentDeviationBps, pegReferenceUnavailable });
  });

  it("falls back to archived provenance when peg read has no row and keeps unread provenance null", () => {
    const summary = projectFrozenSnapshotLiveSummary(FROZEN_SNAPSHOTS_BY_ID.get("msusd-main-street")!)!;
    const snapshot = buildDetailPegPriceSnapshot("msusd-main-street", coinOf("msusd-main-street"), undefined, summary);
    expect(snapshot.pegScoreResult).toBeNull();
    expect(snapshot.consensusSources).toEqual(["coingecko", "coingecko-onchain-address", "alchemy-address", "moralis-address"]);
    expect(snapshot.agreeSources).toEqual(["coingecko", "alchemy-address"]);

    const unread = buildDetailPegPriceSnapshot("usdc-circle", coinOf("usdc-circle"), undefined, undefined);
    expect([unread.consensusSources, unread.agreeSources]).toEqual([null, null]);
  });

  it.each([["matching clock", FX_REOPEN_QUOTE_AT, 1.1, "€1.0200"], ["older NAV quote", FX_REOPEN_QUOTE_AT - 3600, null, "$1.1220"]] as const)(
    "formats the EUTBL detail price with %s",
    (_label, priceObservedAt, pegRef, price) => {
      const coin = coinOf("eutbl-spiko");
      const peer = { ...makePegSummaryCoin({ id: "eurc-circle", pegCurrency: "EUR", pegType: "peggedEUR", price: 1.1, priceObservedAt: FX_REOPEN_QUOTE_AT }), ...makeFxCurrentPeg("admitted", 0) };
      const view = readyModel({ id: coin.id, coin, asset: { price: 1.122, priceObservedAt, priceUpdatedAt: FX_REOPEN_QUOTE_AT }, queries: { pegSummary: { data: { coins: [peer], summary: null } as PegSummaryResponse } } });
      expect(view.pegRef).toBe(pegRef);
      expect(formatObservedPrice(view.coinData.price, coin.flags.pegCurrency, view.pegRef)).toBe(price);
    },
  );

  it("uses the archived USD cap and observed quote only when native supply was omitted", () => {
    const coin = coinOf("gyen-gyen");
    const archive = FROZEN_SNAPSHOTS_BY_ID.get(coin.id)!;
    const market = (overrides: Record<string, unknown> = {}) => {
      const summary = projectFrozenSnapshotLiveSummary({ ...archive, peggedAssetRow: { ...archive.peggedAssetRow, ...overrides } })!;
      return buildDetailMarketSnapshot(coin, summary, summary.nativeSupply, [], Date.parse(archive.capturedAt));
    };
    const legacy = market();
    expect(legacy.supply).toBeCloseTo(702_066_781.49, 2);
    expect(legacy.nativeSupply).toMatchObject({ prevWeek: null, prevMonth: null });
    expect(market({ circulatingNative: 1_000 }).supply).toBe(1_000);
    expect(market({ circulatingNative: null }).supply).toBeNull();
    expect(market({ circulating: {} }).supply).toBeNull();
    expect(market({ priceObservedAtMode: "nominal_reference" }).supply).toBeNull();
  });

  it("uses one row for deviation/agreement, expires DEX evidence and retains legacy fallback", () => {
    const now = Date.now();
    const coin = coinOf("usdc-circle");
    const dex = { dexPrice: 0.8, dexDeviationBps: -2000, agrees: true, sourcePools: 1, sourceTvl: 1 };
    const legacy = makePegSummaryCoin({ currentDeviationBps: 0, consensusSources: [], agreeSources: [], dexPriceCheck: { ...dex, agrees: false } });
    const summary = {
      price: 0.8, priceSource: "coingecko", priceConfidence: "fallback", consensusSources: ["coingecko"], agreeSources: ["coingecko"],
      currentPeg: { currentDeviationBps: -2000, pegReference: null, pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: dex, dexPriceCheckExpiresAt: now / 1000 + 1 },
    } as StablecoinLiveSummary;
    const read = (nowMs = now) => buildDetailPegPriceSnapshot(coin.id, coin, { coins: [{ ...legacy, id: coin.id }] } as PegSummaryResponse, summary, nowMs);
    expect(read()).toMatchObject({ deviationBps: -2000, consensusSources: ["coingecko"], agreeSources: ["coingecko"], dexPriceCheck: dex, priceUnusable: true });
    expect(read(now + 1000)).toMatchObject({ deviationBps: -2000, dexPriceCheck: null });
    expect(read(now + 540000).dexPriceCheck).toBeNull();
    delete summary.currentPeg!.dexPriceCheckExpiresAt;
    expect(read().dexPriceCheck).toBeNull();
    delete summary.currentPeg;
    expect(read()).toMatchObject({ deviationBps: 0, consensusSources: [], agreeSources: [], priceUnusable: false });
  });

  it("uses report-card snapshot freshness instead of browser fetch timestamp", () => {
    const vm = readyModel({ queries: { reportCards: { data: { cards: [], methodology: {}, dependencyGraph: { nodes: [], edges: [] }, updatedAt: 1_700_000_000 } as never, dataUpdatedAt: 1_800_000_000_000, meta: { updatedAt: 1_700_000_123, ageSeconds: 0, status: "fresh" } } } });
    expect(vm.reportCardUpdatedAt).toBe(1_700_000_123_000);
  });

  it("projects raw market/peg inputs into the ready hero and leaves Supply trends unavailable without native history", () => {
    const vm = readyModel({
      asset: { price: 0.98, circulating: { peggedUSD: 200 }, circulatingPrevDay: { peggedUSD: 250 }, circulatingPrevWeek: { peggedUSD: 100 }, circulatingPrevMonth: { peggedUSD: 0 } },
      nativeSupply: { current: 150, prevWeek: 160, prevMonth: 0 },
      queries: {
        pegSummary: { data: { coins: [makePegSummaryCoin({ pegScore: 45, eventCount: 2 })] } as PegSummaryResponse },
        reportCards: { data: { cards: [makeV9Card({ id: "usdt-tether", grade: "B+", score: 79 })] } as never },
      },
    });
    expect(vm.mcap).toBe(200);
    expect(vm.hero.market.supply).toBe(200 / 0.98);
    expect(vm.hero.market.prevDayTrendClass).toBe(DIRECTION_TONE_CLASSES.down);
    expect(vm.hero.market.supplyTrend).toMatchObject({ current: 150, safePrevWeek: 160, safePrevMonth: null, hasPrevMonth: false, prevWeekTrendClass: DIRECTION_TONE_CLASSES.down });
    expect(vm.hero.tertiaryMetrics.find((m) => m.key === "peg-score")?.display.value).toBe("45");
    expect(vm.hero.tertiaryMetrics.find((m) => m.key === "peg-score")?.display.sub ?? "").not.toContain("incident");
    expect(vm.hero.passportItems.find((i) => i.key === "record")?.value).toBe("2 incidents");
    expect(vm.hero.signalRailItems.find((i) => i.key === "safety")).toMatchObject({ primary: "B+", secondary: "79/100" });

    const usdOnly = readyModel({ asset: { circulatingPrevWeek: { peggedUSD: 90 }, circulatingPrevMonth: { peggedUSD: 80 } } });
    expect(usdOnly.hero.market.supplyTrend).toMatchObject({ current: null, safePrevWeek: null, safePrevMonth: null, hasPrevMonth: false });
  });

  it("builds a ready view model from fetched inputs", () => {
    const vm = readyModel({
      asset: { circulatingPrevDay: { peggedUSD: 90 }, circulatingPrevWeek: { peggedUSD: 80 }, circulatingPrevMonth: { peggedUSD: 70 } },
      queries: {
        supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }] },
        pegSummary: { data: { summary: {} as never, coins: [{ id: "usdt-tether", pegScore: 99 }] } as never, dataUpdatedAt: 1 },
        dexLiquidity: { data: { "usdt-tether": { liquidityScore: 88 } } as never, dataUpdatedAt: 1 },
        reportCards: { data: { cards: [makeV9Card({ id: "usdt-tether", score: 90, grade: "A" })], dependencyGraph: { nodes: [], edges: [] } } as never, dataUpdatedAt: 1 },
      },
      supplemental: { flows: { data: { gauge: { score: 0, band: "neutral" }, coins: [{ stablecoinId: "usdt-tether" }], hourly: [] } as never }, nowMs: 1_700_000_000_000 },
    });
    expect(vm).toMatchObject({ id: "usdt-tether", mcap: 100, prevDay: 90, performanceVsUsd1y: null, hasFlows: true, hasYieldSection: false });
    expect(vm.pegScoreResult?.pegScore).toBe(99);
  });

  it("keeps NAV tokens out of peg-distressed verdicts, keeps curated danger notices critical, and inherits variant archetypes", () => {
    const nav = readyModel({
      id: "susde-ethena", asset: { price: 1.1 },
      queries: {
        supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1.1 }] },
        pegSummary: { data: { summary: {} as never, coins: [{ id: "susde-ethena", symbol: "sUSDe", pegScore: 35, pegPct: 80, eventCount: 1, currentDeviationBps: 1000, activeDepeg: true, trackingSpanDays: 365 }] } as never, dataUpdatedAt: 1 },
        reportCards: { data: { cards: [makeV9Card({ id: "susde-ethena", grade: "F", score: 35 })], dependencyGraph: { nodes: [], edges: [] } } as never, dataUpdatedAt: 1 },
      },
    });
    expect(nav.isNavToken).toBe(true);
    expect(nav.verdict).toEqual({ archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" });
    expect(nav.coinStates.some((s) => s.kind === "depeg")).toBe(false);

    const noticed = { ...coinOf("usdt-tether"), notices: [{ type: "danger" as const, kind: "depeg" as const, title: "Curated depeg", message: "Not superseded." }] };
    const noticeParams = makeReadyDetailParams({ id: noticed.id, coin: noticed, queries: { pegSummary: { data: { summary: {} as never, coins: [{ id: noticed.id, pegScore: 20, activeDepeg: true, currentDeviationBps: -4500 }] } as never, dataUpdatedAt: 1 } } });
    noticeParams.supplemental.ddrVerdict = { tier: "at_risk", methodologyVersion: null };
    const noticeVm = buildStablecoinDetailViewModel(noticeParams);
    if (noticeVm.status !== "ready") throw new Error("expected ready");
    expect(noticeVm.coinStates).toMatchObject([{ kind: "critical", notice: { title: "Curated depeg" } }, { kind: "depeg", ddrTier: "at_risk" }]);
    expect(noticeVm.hero.state).toBe(noticeVm.coinStates[0]);

    const sourceVariant = coinOf("autousd-auto-finance");
    const variantCoin = { ...sourceVariant, flags: { ...sourceVariant.flags, governance: "centralized" as const, yieldBearing: false, navToken: false } };
    const variantVm = readyModel({
      id: variantCoin.id, coin: variantCoin,
      queries: { supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] }, reportCards: { data: { cards: [makeV9Card({ id: variantCoin.id, grade: "B", score: 80 })], dependencyGraph: { nodes: [], edges: [] } } as never, dataUpdatedAt: 1 } },
    });
    expect(variantCoin.mechanismArchetype).toBeUndefined();
    expect(variantVm.verdict).toEqual({ archetype: "institutional-default", label: "Institutional Default" });
  });

  it("wires selected redemption backstops, handles missing/errored backstops, and respects query gates", () => {
    const wired = readyModel({
      queries: { redemptionBackstops: {
        data: { coins: { "usdc-circle": { stablecoinId: "usdc-circle", score: 80, resolutionState: "resolved", routeFamily: "stablecoin-redeem" }, "usdt-tether": { stablecoinId: "usdt-tether", score: null, eventualRedeemabilityScore: 65, resolutionState: "resolved", routeFamily: "offchain-issuer" } }, updatedAt: 1_700_000_000 } as never,
        dataUpdatedAt: 12_345, meta: { updatedAt: 1_700_000_000, ageSeconds: 0, status: "fresh" },
      } },
    });
    expect(wired.redemptionBackstop?.stablecoinId).toBe("usdt-tether");
    expect(wired.staleQueries.find((q) => q.preset === "redemptionBackstops")).toMatchObject({ dataUpdatedAt: 12_345, hasData: true, meta: { updatedAt: 1_700_000_000, status: "fresh" } });

    const error = new Error("redemption API unavailable");
    const errored = readyModel({ queries: { redemptionBackstops: { data: undefined, error, dataUpdatedAt: 0 } } });
    expect(errored.redemptionBackstop).toBeUndefined();
    expect(errored.staleQueries.find((q) => q.preset === "redemptionBackstops")).toMatchObject({ error, hasData: false });

    const gated = readyModel({
      queries: { dexLiquidity: { enabled: false }, reportCards: { enabled: false }, redemptionBackstops: { enabled: false } },
      supplemental: { yieldRankings: { enabled: false }, stressSignals: { enabled: false }, flows: { enabled: false } },
    });
    const presets = gated.staleQueries.map((q) => q.preset);
    expect(presets).toContain("stablecoins");
    for (const disabled of ["dexLiquidity", "reportCards", "redemptionBackstops", "yieldRankings", "stressSignals", "mintBurnFlows"]) {
      expect(presets).not.toContain(disabled);
    }

    const optErr = new Error("optional feeds unavailable");
    const failed = readyModel({
      queries: { dexLiquidity: { data: undefined, error: optErr, dataUpdatedAt: 0 } },
      supplemental: { yieldRankings: { data: undefined, error: optErr, dataUpdatedAt: 0 }, stressSignals: { data: undefined, error: optErr, dataUpdatedAt: 0 }, flows: { data: undefined, error: optErr, dataUpdatedAt: 0, enabled: true }, blacklist: { summary: undefined, error: optErr, dataUpdatedAt: 0, enabled: true } },
    });
    expect(failed.hasFlows).toBe(true);
    expect(failed.hasBlacklist).toBe(true);
    expect(failed.staleQueries.map((q) => q.preset)).toEqual(expect.arrayContaining(["dexLiquidity", "yieldRankings", "stressSignals", "mintBurnFlows", "blacklist"]));

    const blSummary = { stats: { perCoinTotalEvents: { USDF: 3, USDA: 2, AEUR: 1 } } } as never;
    expect(["usdf-falcon", "usda-avalon", "aeur-anchored-coins", "usdf-astherus", "usdf-flipcash"].map((id) => {
      const vm = readyModel({ id, supplemental: { blacklist: { summary: blSummary, enabled: true } } });
      return [vm.hasBlacklist, vm.blacklistSymbol];
    })).toEqual([[true, "USDF"], [true, "USDA"], [true, "AEUR"], [false, null], [false, null]]);
  });

  it("exposes tracked variant relationships and commodity yield rankings", () => {
    const variantVm = readyModel({ id: "susds-sky", asset: { price: 1.02, circulatingPrevDay: { peggedUSD: 98 }, circulatingPrevWeek: { peggedUSD: 96 }, circulatingPrevMonth: { peggedUSD: 92 } } });
    expect(variantVm.variantParent?.id).toBe("usds-sky");
    expect(variantVm.isVariant).toBe(true);
    expect(variantVm.variantSiblings.map((c) => c.id)).toContain("stusds-sky");

    const parentVm = readyModel({ id: "usds-sky", asset: { circulatingPrevDay: { peggedUSD: 99 }, circulatingPrevWeek: { peggedUSD: 98 }, circulatingPrevMonth: { peggedUSD: 97 } } });
    expect(parentVm.hasVariants).toBe(true);
    expect(parentVm.childVariants.map((c) => c.id)).toEqual(["susds-sky", "stusds-sky", "skymoneyusdsflagship-sky"]);

    const goldVm = readyModel({
      id: "xaut-tether",
      asset: { price: 3_000, circulating: { peggedGOLD: 100 }, circulatingPrevDay: { peggedGOLD: 98 }, circulatingPrevWeek: { peggedGOLD: 96 }, circulatingPrevMonth: { peggedGOLD: 92 } },
      queries: { supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 3_000 }] } },
      supplemental: { yieldRankingsData: { rankings: [makeYieldRanking({ id: "xaut-tether", symbol: "XAUT", name: "Tether Gold" })] } as never },
    });
    expect(goldVm.yieldRanking?.id).toBe("xaut-tether");
    expect(goldVm.hasYieldSection).toBe(true);
  });

  it.each([
    { label: "inclusive tolerance", id: "zchf-frankencoin", points: [[14 * 86400, 2]], price: 3, expected: 50 },
    { label: "outside tolerance", id: "zchf-frankencoin", points: [[14 * 86400 + 1, 2]], price: 3, expected: null },
    { label: "closest valid anchor", id: "zchf-frankencoin", points: [[-10 * 86400, 1], [-86400, 2], [0, null], [1, 0]], price: 3, expected: 50 },
    { label: "missing current price", id: "zchf-frankencoin", points: [[0, 2]], price: null, expected: null },
    { label: "invalid current price", id: "zchf-frankencoin", points: [[0, 2]], price: 0, expected: null },
    { label: "non-USD eligible", id: "zchf-frankencoin", points: [[0, 0.98], [358 * 86400, 0.98 * 1.2]], price: 1.12, expected: (1.12 / 0.98 - 1) * 100 },
    { label: "NAV token excluded", id: "cetes-etherfuse", points: [[0, 0.05], [358 * 86400, 0.06]], price: 0.061, expected: null },
  ])("selects annual performance for $label", ({ id, points, price, expected }) => {
    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 86400;
    const vm = readyModel({
      id, asset: { price },
      queries: { supplyHistory: { data: points.map(([offset, historicPrice]) => ({ date: anchorSec + offset!, circulatingUsd: 100, price: historicPrice })) } },
      supplemental: { nowMs: nowSec * 1000 },
    });
    if (expected == null) expect(vm.performanceVsUsd1y).toBeNull();
    else expect(vm.performanceVsUsd1y).toBeCloseTo(expected, 6);
  });

  it("handles missing detail summary and reserve fetch errors with curated fallback", () => {
    const missing = buildStablecoinDetailViewModel(makeBuildStablecoinDetailViewModelParams({
      core: { id: "usdt-tether", coin: coinOf("usdt-tether") }, queries: { liveSummary: { data: undefined, dataUpdatedAt: 1 } },
    }));
    expect(missing).toMatchObject({ status: "list-error", listError: new Error("Stablecoin list data unavailable") });

    const fallback = readyModel({
      id: "iusd-infinifi",
      asset: { price: 1, circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 90 }, circulatingPrevWeek: { peggedUSD: 80 }, circulatingPrevMonth: { peggedUSD: 70 } },
      queries: { supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }] } },
      supplemental: { reserves: { error: new Error("reserve api failed") }, nowMs: 1_700_000_000_000 },
    });
    expect(fallback.reserves?.mode).toBe("curated-fallback");
    expect(fallback.reserveFetchError).toBeInstanceOf(Error);
  });
});

describe("detail published mint evidence integration", () => {
  it("passes publication availability through without confusing a missing component with a missing request result", () => {
    const coin = buildStablecoinDetailClientCoin(coinOf("usdc-circle"));
    const params = makeReadyDetailParams({ id: coin.id, coin });
    const unavailable = buildStablecoinDetailViewModel(params);
    if (unavailable.status !== "ready") throw new Error("Expected ready");
    expect(unavailable.mintAuthority.score?.compactLabel).toBe("Mint score unavailable");
    expect(unavailable.mintAuthority.verdict).not.toContain("Not rated");
    params.queries.reportCards.data = { cards: [] } as never;
    const settled = buildStablecoinDetailViewModel(params);
    if (settled.status !== "ready") throw new Error("Expected ready");
    expect(settled.mintAuthority.score?.compactLabel).toBe("NR");
    expect(settled.mintAuthority.verdict).toMatch(/^Not rated —/);
  });

  it("keeps process-level screen diagnostics in the ready page even when the mint component is NR", () => {
    const card = makeV9Card({ id: "usdt-tether" });
    card.breakdowns!.control.components = [{ ...card.breakdowns!.control.components[0]!, kind: "mint", score: null }];
    card.breakdowns!.control.issuanceSummary = { diagnostics: [makePublishedProcessDiagnostic({
      code: "operational-screen-failed", gate: "H3", controlRef: null, pathId: null, classId: null, memberRef: null, field: "operationalExposurePpm", evidenceRefIds: ["exposure-proof"],
    })] };
    const view = readyModel({ queries: { reportCards: { data: { cards: [card] } as never } } });
    expect(view.mintAuthority.score).toBeNull();
    expect(view.mintAuthority.processDiagnostics).toContainEqual(expect.objectContaining({ gate: "H3", field: "operationalExposurePpm", statusLabel: "Failed screen" }));
  });
});

describe("detail feature-status ladders & resolveDetailGradeRead", () => {
  const coin = coinOf("usdt-tether");
  const featureStates = (overrides: Parameters<typeof makeBuildStablecoinDetailViewModelParams>[0]) => {
    const params = makeBuildStablecoinDetailViewModelParams({ ...overrides, core: { coin, ...overrides.core } });
    return buildDetailFeatureSnapshot(coin.id, coin, params.queries, params.supplemental).states;
  };

  it("keeps deferred, failed, and stale-with-data reserve reads distinct", () => {
    expect(featureStates({ supplemental: { reserves: { enabled: false, isLoading: true } } }).reserves.status).toBe("deferred");
    expect(featureStates({ supplemental: { reserves: { enabled: true, error: new Error("offline") } } }).reserves.status).toBe("unavailable");
    expect(featureStates({ supplemental: { reserves: { live: { mode: "live", reserves: [], estimated: false }, isLoading: true, error: new Error("offline") } } }).reserves.status).toBe("stale-with-data");
  });

  it.each([
    [{ enabled: false, isLoading: true, error: new Error("offline") }, "deferred"],
    [{ isLoading: true }, "loading"],
    [{ isLoading: false }, "loading"],
    [{ error: new Error("offline") }, "unavailable"],
    [{ data: { coins: {} } }, "empty"],
    [{ data: { coins: {} }, error: new Error("offline") }, "unavailable"],
    [{ data: { coins: { "usdt-tether": {} } }, error: new Error("offline") }, "retained"],
    [{ data: { coins: { "usdt-tether": {} } } }, "ready"],
  ] as const)("distinguishes redemption evidence read %s as %s", (query, status) => {
    expect(featureStates({ queries: { redemptionBackstops: query as never } }).redemption.status).toBe(status);
  });

  it("classifies report-card read states into settled, pending, and failed", () => {
    expect(resolveDetailGradeRead({ grade: "A" }, { error: null, isLoading: true })).toBe("settled");
    expect(resolveDetailGradeRead(undefined, { error: null, isLoading: true })).toBe("pending");
    expect(resolveDetailGradeRead(undefined, { error: new Error("x"), isLoading: true })).toBe("failed");
    expect(resolveDetailGradeRead(undefined, { data: { cards: [{}] }, error: null })).toBe("settled");
    expect(resolveDetailGradeRead(undefined, { error: null, isLoading: false })).toBe("settled");
  });
});

describe("stablecoin detail derive helpers", () => {
  it("derives supply from market cap and preserves explicit zero", () => {
    expect(deriveSupplyFromMarketCap(250_000_000, 2.5)).toBe(100_000_000);
    expect(deriveSupplyFromMarketCap(0, 1)).toBe(0);
    expect(deriveSupplyFromMarketCap(0, 2.5)).toBe(0);
    expect(deriveSupplyFromMarketCap(0, 0)).toBeNull();
    expect(deriveSupplyFromMarketCap(100, 0)).toBeNull();
    for (const bad of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveSupplyFromMarketCap(100, bad)).toBeNull();
      expect(deriveSupplyFromMarketCap(bad, 1)).toBeNull();
    }
  });

  it("derives indicative deviation bps and rejects invalid price or reference", () => {
    for (const [price, expected] of [[1.0125, 125], [0.9975, -25], [1, 0]] as const) {
      expect(deriveIndicativeDeviationBps(price, 1)).toBe(expected);
    }
    for (const badPrice of [null, undefined, Number.NaN]) expect(deriveIndicativeDeviationBps(badPrice, 1)).toBeNull();
    for (const badRef of [null, 0, -1, Number.NaN]) expect(deriveIndicativeDeviationBps(1.01, badRef)).toBeNull();
  });
});
