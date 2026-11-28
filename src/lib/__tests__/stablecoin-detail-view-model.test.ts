import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { projectFrozenSnapshotLiveSummary } from "@/lib/frozen-snapshot-live-summary";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { MintBurnFlowsResponse } from "@shared/types/mint-burn";
import type { PegSummaryCoin, PegSummaryResponse } from "@shared/types/peg";
import { StablecoinLiveSummarySchema, type StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { makePegSummaryCoin as makePegBase } from "@/test-utils/peg-summary-fixtures";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { formatObservedPrice } from "../current-peg";
import { makeV9Card as v9 } from "@/test/fixtures/safety-score-v9";
import { makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { buildStablecoinDetailViewModel as buildVM } from "../stablecoin-detail-view-model";
import { deriveIndicativeDeviationBps as devBps, deriveSupplyFromMarketCap as supplyFromCap } from "../stablecoin-detail-derive";
import { makeBuildStablecoinDetailViewModelParams as vmParams, makeReadyDetailParams as readyParams } from "./fixtures/stablecoin-detail-view-model";
import { buildDetailMarketSnapshot as mktSnap, buildDetailPegPriceSnapshot as pegSnap, buildDetailStaleQueries as staleQs, buildDetailFeatureSnapshot as featSnap, resolveDetailGradeRead as gradeRead } from "../stablecoin-detail-query-view-model";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { deriveDataHealth as healthOf, isPublicWarning as warns } from "../data-health";
import { DATA_HEALTH_PRESETS as PRESETS } from "../data-health-config";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-client-coin";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";

const T0 = 1_700_000_000, NOW = 1_790_000_000_000, NOW_SEC = NOW / 1000, T_SNAP = 1_790_793_000_000, DAY = 86_400;
const USDT = "usdt-tether", USDC = "usdc-circle", PAXG = "paxg-paxos", ZCHF = "zchf-frankencoin", USD = "peggedUSD", GOLD = "peggedGOLD", CG = "coingecko";
const coinOf = (id: string) => TRACKED_META_BY_ID.get(id)!;
const pegCoin = (ov: Partial<PegSummaryCoin> = {}): PegSummaryCoin => makePegBase({ id: USDT, symbol: "USDT", name: "Tether", ...ov });
const offline = () => new Error("offline");

type Params = Parameters<typeof buildVM>[0];
type ReadyVM = Extract<ReturnType<typeof buildVM>, { status: "ready" }>;
type ReadyOv = Omit<Parameters<typeof readyParams>[0], "id" | "coin"> & { id?: string; coin?: Parameters<typeof readyParams>[0]["coin"] };

const asReady = (vm: ReturnType<typeof buildVM>): ReadyVM => {
  expect(vm.status).toBe("ready");
  if (vm.status !== "ready") throw new Error(`Expected ready view-model, got ${vm.status}`);
  return vm;
};
const ready = ({ id = USDT, coin = coinOf(id), ...rest }: ReadyOv = {}): ReadyVM => asReady(buildVM(readyParams({ id, coin, ...rest })));

const staleOf = (p: Params, id = USDT) => staleQs(p.queries, p.supplemental, id);
const laneBy = (p: Params, preset: string, id = USDT) => staleOf(p, id).find((e) => e.preset === preset);
const resLane = (p: Params, id = USDT) => staleOf(p, id).find((e) => e.label === "Live Reserves")!;
const resHealth = (q: ReturnType<typeof resLane>, now = NOW) => healthOf({ ...q, label: "Live Reserves", staleTime: q.staleTime! }, now);
const resParams = (live: ReserveResult, now = NOW) => vmParams({ supplemental: { reserves: { live, enabled: true, dataUpdatedAt: now } } });
const ns = (current: number | null, prevWeek: number | null, prevMonth: number | null) => ({ current, prevWeek, prevMonth });
const usd = (n: number) => ({ [USD]: n });
const caps = (peg: string, cur?: number, day?: number, week?: number, month?: number) => ({
  ...(cur !== undefined ? { circulating: { [peg]: cur } } : {}),
  ...(day !== undefined ? { circulatingPrevDay: { [peg]: day } } : {}),
  ...(week !== undefined ? { circulatingPrevWeek: { [peg]: week } } : {}),
  ...(month !== undefined ? { circulatingPrevMonth: { [peg]: month } } : {}),
});
const hist = (price: number | null) => ({ data: [{ date: T0, circulatingUsd: 100, price }] });
const cardsQ = (cards: unknown[]) => ({ data: { cards, dependencyGraph: { nodes: [], edges: [] } } as never, dataUpdatedAt: 1 });
const pegQ = (coins: unknown[]) => ({ data: { summary: {} as never, coins } as never, dataUpdatedAt: 1 });
const failedQ = (error: Error) => ({ data: undefined, error, dataUpdatedAt: 0 });
const presetQ = (vm: ReadyVM, preset: string) => vm.staleQueries.find((q) => q.preset === preset);
const flowData = (now: number, ov: Partial<MintBurnFlowsResponse> = {}): MintBurnFlowsResponse => ({
  gauge: { score: null, band: null, intensitySemantics: "signed-v2", flightToQuality: null, flightIntensity: null, classificationSource: "unavailable", trackedCoins: 0, trackedMcapUsd: 0 },
  coins: [], hourly: [], updatedAt: now / 1000, ...ov,
});

const match = (a: unknown, b: object) => expect(a).toMatchObject(b);
const liveRes = (fetchedAt: number, fOv: Record<string, unknown> = {}, sOv: Record<string, unknown> = {}, tOv: Record<string, unknown> = {}): ReserveResult => ({
  mode: "live", reserves: [], estimated: false, liveAt: fetchedAt, ...tOv,
  sync: {
    enabled: true, status: "ok", stale: false, bootstrap: false, ...sOv,
    freshness: { stale: false, staleReasons: [], assessedAt: fetchedAt, fetchedAt, attemptId: "reserve-attempt", fetchAgeSec: 0, fetchBudgetSec: 2 * DAY, freshnessMode: "verified", sourceFreshnessInvalid: false, sourceTimestamp: null, sourceAgeSec: null, sourceAgeBudgetSec: null, sourceAgeBudgetCap: null, ...fOv },
  },
} as ReserveResult);

describe("stablecoin detail view-model builder", () => {
  it.each([true, false])("preserves the unsettled-seed flag on both seeded lanes (%s)", (awaitingLiveRead) => {
    const p = vmParams({ queries: { liveSummary: { awaitingLiveRead }, supplyHistory: { awaitingLiveRead } } }), qs = staleOf(p, p.core.id);
    expect([qs.find((q) => q.label === "Detail snapshot")?.awaitingLiveRead, qs.find((q) => q.label === "Supply history")?.awaitingLiveRead, qs.filter((q) => !["Detail snapshot", "Supply history"].includes(q.label ?? "")).every((q) => q.awaitingLiveRead === undefined)])
      .toEqual([awaitingLiveRead, awaitingLiveRead, true]);
  });

  it.each([[22, false], [80, true]] as const)("reads a %sh daily-history fallback as provenance, banner %s", (h, isWarn) => {
    const p = readyParams({ id: USDT, coin: coinOf(USDT), queries: { liveSummary: { meta: { updatedAt: 1e9 - h * 3600, ageSeconds: h * 3600, status: "stale", reason: "detail-history-fallback", freshBudgetSec: 259_200 } } } });
    const lane = staleOf(p)[0];
    expect([lane.dailySnapshot, warns(healthOf({ ...PRESETS.stablecoins, ...lane }, 1e12))]).toEqual([true, isWarn]);
  });

  it("keeps a cold summary read loading rather than classifying the tracked ID as absent", () => {
    expect(buildVM(vmParams({ queries: { liveSummary: { isLoading: true } } })).status).toBe("loading");
  });

  it.each([[USDC, USD, 1], ["eurc-circle", "peggedEUR", 1.2], ["usnd-nerite", USD, 0.42]] as const)(
    "keeps direct-summary quote and supply provenance for %s",
    (id, pegType, price) => {
      const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" as const };
      const m = ready({ id, asset: { price, priceObservedAt: T0 + 1, priceUpdatedAt: T0 + 2, priceSyncedAt: T0 + 3, priceObservedAtMode: "upstream", supplyObservedAt: T0, supplyRestored: true, nominalPriceReference }, nativeSupply: ns(90, 80, 70) });
      expect(m.coinData).toMatchObject({ price, pegType, nominalPriceReference, supplyRestored: true, supplyObservedAt: T0, priceObservedAt: T0 + 1, priceUpdatedAt: T0 + 2, priceSyncedAt: T0 + 3 });
      expect([m.hero.coinData === m.coinData, m.nativeSupply]).toEqual([true, ns(90, 80, 70)]);
      expect(m.supply).toBeCloseTo(pegType === USD ? 100 / price : 90);
    },
  );

  it("keeps explicit zero supply through the hero instead of reviving older positive checkpoints", () => {
    const m = ready({ id: USDC, asset: { circulating: usd(0), price: 1, priceSource: CG }, nativeSupply: ns(0, 200, 300) });
    expect(m.hero.market.supply).toBe(0);
    expect(m.hero.market.supplyTrend).toMatchObject({ current: 0, safePrevWeek: 200, safePrevMonth: 300 });
    for (const asset of [{ circulating: {}, price: 1 }, { circulating: usd(0), price: null }, { circulating: usd(0), price: 0 }] as Partial<StablecoinLiveSummary>[]) {
      const u = ready({ id: USDC, asset: { ...asset, priceSource: CG }, nativeSupply: ns(100, 200, 300) });
      expect([u.hero.market.supply, u.hero.market.supplyTrend.current]).toEqual([null, 100]);
    }
  });

  it.each([[100, 200_000], [0, 200_000], [null, 200_000], [null, 0]] as const)(
    "uses PAXG's native supply %s for the headline and trend at USD market cap %s",
    (current, mcap) => {
      const m = ready({ id: PAXG, asset: { price: 3_000, priceSource: CG, circulating: { [GOLD]: mcap } }, nativeSupply: ns(current, 90, 80) });
      expect(m).toMatchObject({ status: "ready", mcap, supply: current });
      expect(m.hero.market).toMatchObject({ supply: current, supplyTrend: { current } });
    },
  );

  it("keeps legacy fallback and explicit PAXG quantity distinct across the compact Worker-to-Pages boundary", () => {
    const coin = coinOf(PAXG), now = 1_795_000_000;
    for (const [qty, expected] of [[undefined, 200_000 / 3_000], [100, 100], [null, null]] as const) {
      const wire = projectStablecoinLiveSummary({ currentCirculatingUSD: { [GOLD]: 200_000 }, currentSupplyObservedAt: now - 240, currentCirculatingNative: qty, price: 3_000, priceSource: CG, priceObservedAt: now - 60 }, coin.id);
      const s = StablecoinLiveSummarySchema.parse(JSON.parse(JSON.stringify(wire)));
      expect(mktSnap(coin, s, s.nativeSupply, [], now * 1000)).toMatchObject({ mcap: 200_000, supply: expected });
    }
  });

  it.each([
    [undefined, 210_000], [{}, null], [{ day: null }, null],
    [{ day: { observedAt: 1_790_706_600, circulatingUsd: 200_000, circulatingNative: 100 } }, 200_000],
  ] as const)("uses the dated detail day baseline (%j) before legacy buckets", (supplyChangeBaselines, expected) => {
    const coin = coinOf(PAXG), p = readyParams({ id: coin.id, coin, asset: { ...caps(GOLD, 210_000, 210_000), supplyChangeBaselines, price: 2_100 } });
    expect(mktSnap(coin, p.queries.liveSummary.data!, null, [], T_SNAP).prevDay).toBe(expected);
  });

  it("keeps the retained dossier ready through a failed summary refresh and recovery", () => {
    const coin = coinOf(USDC), p = readyParams({ id: coin.id, coin }), err = new Error("HTTP 502");
    p.queries.liveSummary.error = err;
    const q = presetQ(asReady(buildVM(p)), "stablecoins")!;
    expect([q.label, healthOf({ ...PRESETS.stablecoins, ...q }).degradationReason]).toEqual(["Detail snapshot", "refresh"]);
    p.queries.liveSummary.error = null;
    expect(buildVM(p).status).toBe("ready");
    p.queries.liveSummary.data = undefined;
    p.queries.liveSummary.error = err;
    expect(buildVM(p)).toMatchObject({ status: "list-error", listError: err });
  });

  it("keeps current listing supply independent of unavailable baselines and preserves absent supply as null", () => {
    const coin = coinOf(USDC);
    const present = mktSnap(coin, { id: coin.id, circulating: usd(477_309_888.38), circulatingPrevDay: {}, price: 0.99985, priceSource: CG, priceConfidence: "single-source" } as never, null, [], T_SNAP);
    expect([present.mcap, present.prevDay]).toEqual([477_309_888.38, null]);
    expect(present.supply).toBeCloseTo(477_309_888.38 / 0.99985);
    const absent = mktSnap(coin, { circulating: {}, circulatingPrevDay: {}, price: 1, priceSource: CG } as never, ns(454_459_687.73, null, null), [], T_SNAP);
    expect([absent.mcap, absent.supply]).toEqual([null, null]);
  });

  it("uses coin-scoped liquidity warnings without hiding stale producer data or legacy advisories", () => {
    const now = Date.now(), gw = '199 - "Quality drift: major-tvl-cliff:crvusd-curve"';
    const p = vmParams({ queries: { dexLiquidity: { data: { "xsgd-straitsx": makeDexLiquidityData({ warning: null }) }, dataUpdatedAt: now, meta: { updatedAt: now / 1000 - 60, ageSeconds: 60, status: "fresh", warning: gw } } } });
    const row = p.queries.dexLiquidity.data!["xsgd-straitsx"];
    const state = () => healthOf({ ...PRESETS.dexLiquidity, ...laneBy(p, "dexLiquidity", "xsgd-straitsx")! }).state;
    expect(state()).toBe("fresh");
    row.warning = gw;
    expect(state()).toBe("degraded");
    delete row.warning;
    expect(state()).toBe("degraded");
    row.warning = null;
    p.queries.dexLiquidity.meta!.updatedAt = now / 1000 - 13 * 4 * 3600;
    expect(state()).toBe("stale");
  });

  it.each(["source-stale", "publication-held"])("scopes coin flow health away from optional market FTQ: %s", (reason) => {
    const now = Date.now(), clsWarn = `Flight-to-quality classification unavailable: Safety Score dependency (${reason}); budget 1h.`, txWarn = `199 - "${clsWarn}"`;
    const data = flowData(now, {
      gauge: { ...flowData(now).gauge, score: 0, band: "NEUTRAL", classificationReason: reason, safetyScoreIdentity: null, trackedCoins: 1, trackedMcapUsd: 100 },
      coins: [makeMintBurnFlowCoin({ stablecoinId: USDT, symbol: "USDT" })],
      sync: { lastSuccessfulSyncAt: now / 1000, freshnessStatus: "fresh", criticalLaneHealthy: true, warning: null, classificationWarning: clsWarn },
    });
    const p = vmParams({ supplemental: { flows: { data, enabled: true, dataUpdatedAt: now, meta: { updatedAt: now / 1000 - 60, ageSeconds: 60, status: "fresh", freshBudgetSec: 28800, degradedBudgetSec: 43200, warning: txWarn, dependencies: { flightToQuality: { status: "unavailable", reason, updatedAt: now / 1000 - 4000, freshBudgetSec: 3600, generationId: "accepted-safety-publication" } } } } } });
    const flows = p.supplemental.flows, meta = flows.meta!, q = () => laneBy(p, "mintBurnFlows")!, h = () => healthOf({ ...PRESETS.mintBurnFlows, ...q() }, now);
    expect([h().state, q().hasData, q().meta?.dependencies?.flightToQuality, meta.warning, q().meta?.updatedAt]).toEqual(["fresh", true, undefined, txWarn, now / 1000 - 60]);

    meta.warning = `${txWarn}, 199 - "Coin valuation needs review (a,b)"`;
    expect([h().state, q().meta?.warning]).toEqual(["degraded", '199 - "Coin valuation needs review (a,b)"']);
    meta.warning = txWarn;
    meta.dependencies!.ingestion = { status: "degraded", reason: "incomplete-scan" };
    expect(h().degradationReason).toBe("source");
    delete meta.dependencies!.ingestion;
    data.sync!.warning = "Critical flow lane is lagging";
    expect([h().state, q().meta?.warning?.includes("Critical flow lane is lagging")]).toEqual(["degraded", true]);
    data.sync!.warning = null;

    flows.error = new Error("flow transport failed");
    expect(h().degradationReason).toBe("refresh");
    flows.error = null;
    meta.updatedAt = now / 1000 - 43201;
    expect(h().state).toBe("stale");
    meta.updatedAt = now / 1000 - 60;
    delete meta.dependencies!.flightToQuality;
    expect(h().state).toBe("degraded");
  });

  it("does not monitor a successful aggregate with no rendered coin flow lane", () => {
    const now = Date.now(), p = vmParams({ supplemental: { flows: { enabled: true, dataUpdatedAt: now, data: flowData(now), meta: { status: "degraded", warning: '199 - "Optional market classification unavailable"' } } } });
    const flows = p.supplemental.flows, flowQ = () => laneBy(p, "mintBurnFlows");
    expect(flowQ()).toBeUndefined();
    flows.data = undefined;
    flows.isLoading = true;
    expect(flowQ()).toMatchObject({ hasData: false, isLoading: true });
    flows.isLoading = false;
    flows.error = new Error("flow read failed");
    expect(flowQ()).toMatchObject({ hasData: false, error: flows.error });
  });

  it("ages reserves from independent producer/source budgets, never a fresh request receipt", () => {
    const fetchedAt = NOW_SEC - 3600, sourceAt = NOW_SEC - 3 * DAY;
    const live = liveRes(fetchedAt, { sourceTimestamp: sourceAt, sourceAgeSec: 0, sourceAgeBudgetSec: 2 * DAY, sourceAgeBudgetCap: "scoring" });
    const p = resParams(live), sq = resLane(p), setLive = (next: ReserveResult) => { p.supplemental.reserves.live = next; return resLane(p); };
    expect(sq.dataUpdatedAt).toBe(sourceAt * 1000);
    match(sq.meta, { updatedAt: sourceAt, freshBudgetSec: 2 * DAY });
    expect([resHealth(sq).state, warns(resHealth(sq)), resHealth(sq, (sourceAt + 24 * DAY) * 1000).state, resHealth(sq, (sourceAt + 24 * DAY) * 1000 + 1).state]).toEqual(["degraded", false, "degraded", "stale"]);
    for (const mode of ["live-stale", "curated-fallback", "template-fallback", "unavailable"] as const) {
      const q = setLive({ ...live, mode, sync: { ...live.sync!, stale: true } });
      expect([resHealth(q).state !== "fresh", q.meta?.dependencies?.reserveEvidence.reason?.includes(mode), q.dataUpdatedAt !== NOW]).toEqual([true, true, true]);
    }
    const unk = { dataUpdatedAt: 0, meta: { updatedAt: null, status: "unknown" } };
    match(setLive({ ...live, sync: undefined, liveAt: undefined }), unk);
    for (const ms of [{ sourceTimestamp: null }, { sourceAgeBudgetSec: null }]) match(setLive({ ...live, sync: { ...live.sync!, freshness: { ...live.sync!.freshness!, ...ms } } }), unk);
  });

  it("ages unverified, public-expiry, and uncertain-write reserve feeds accurately", () => {
    const unvQ = resLane(resParams(liveRes(NOW_SEC - 60, { attemptId: "cngn-attempt", freshnessMode: "unverified" }, {}, { reserves: [{ name: "Bank deposits", pct: 100, risk: "medium" }] })), "il-compliant-naira");
    match(unvQ, { hasData: true, dataUpdatedAt: (NOW_SEC - 60) * 1000, meta: { updatedAt: NOW_SEC - 60 } });
    expect([resHealth(unvQ).state, warns(resHealth(unvQ))]).toEqual(["fresh", false]);

    const fetchedAt = NOW_SEC - 25 * DAY;
    const expQ = resLane(resParams(liveRes(fetchedAt, { stale: true, staleReasons: ["fetch-age"], assessedAt: NOW_SEC, fetchAgeSec: 25 * DAY, fetchBudgetSec: 2 * DAY, sourceTimestamp: NOW_SEC - 59 * DAY, sourceAgeSec: 59 * DAY, sourceAgeBudgetSec: 30 * DAY, sourceAgeBudgetCap: "scoring" }, { status: "degraded", stale: true }, { mode: "live-stale" })));
    expect(expQ.dataUpdatedAt).toBe(fetchedAt * 1000);
    match(expQ.meta, { updatedAt: fetchedAt, freshBudgetSec: 2 * DAY, degradedBudgetSec: 24 * DAY, status: "stale" });
    const evReason = expQ.meta?.dependencies?.reserveEvidence.reason ?? "";
    expect([evReason.includes(`fetch budget ${2 * DAY} seconds`), evReason.includes(`source budget ${30 * DAY} seconds`), resHealth(expQ).state, warns(resHealth(expQ))]).toEqual([true, true, "stale", true]);

    const uncQ = resLane(resParams(liveRes(NOW_SEC - 60, { attemptId: "saved-attempt", fetchBudgetSec: 2 * DAY, freshnessMode: "not-applicable" }, { status: "error", uncertainWrite: true, failureCategory: "write-uncertain" })));
    match(uncQ.meta, { updatedAt: NOW_SEC - 60, status: "degraded" });
    expect([uncQ.meta?.warning?.includes("uncertain-write"), resHealth(uncQ).state]).toEqual([true, "degraded"]);
  });

  it("ages a restored supply on its original observation clock, never receipt time", () => {
    const p = readyParams({ id: USDT, coin: coinOf(USDT) }), lane = () => staleOf(p).find((e) => e.label === "Supply");
    expect(lane()).toBeUndefined();
    const s = p.queries.liveSummary.data!;
    const setSup = (ov: Partial<StablecoinLiveSummary>) => { p.queries.liveSummary.data = { ...s, supplyRestored: true, ...ov }; return lane()!; };
    p.queries.liveSummary = { ...p.queries.liveSummary, dataUpdatedAt: NOW, meta: { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" } };
    const recent = setSup({ supplyObservedAt: NOW_SEC - 3600 });
    match(recent, { dataUpdatedAt: (NOW_SEC - 3600) * 1000, hasData: true, staleTime: 600_000, secondary: true });
    expect(warns(healthOf({ ...recent, label: "Supply", staleTime: recent.staleTime! }, NOW))).toBe(false);
    const old = setSup({ supplyObservedAt: NOW_SEC - 7201 });
    expect([old.secondary, healthOf({ ...old, label: "Supply", staleTime: old.staleTime! }, NOW).state]).toEqual([true, "stale"]);
    match(setSup({ supplyObservedAt: null }), { dataUpdatedAt: 0, secondary: true, meta: { updatedAt: null, status: "stale" } });
    match(setSup({ supplyObservedAt: NOW_SEC - 60, circulating: usd(0) }), { hasData: true, secondary: true });
  });

  it.each([
    ["USD", USDT, USD, 1, -200, false], ["non-USD", "eurc-circle", "peggedEUR", 1.2, -1000, false],
    ["commodity", "xaut-tether", GOLD, 3000, 100, false], ["unavailable reference", "eurc-circle", "peggedEUR", null, null, true],
    ["unavailable price", USDC, USD, 1, null, false], ["NAV", "fpi-frax", "peggedVAR", null, null, false],
  ] as const)("pins the %s Worker peg projection", (_l, id, pegType, pegRef, currentDeviationBps, pegReferenceUnavailable) => {
    const coin = coinOf(id);
    const row = pegCoin({ id, name: coin.name, symbol: coin.symbol, pegType, pegCurrency: coin.flags.pegCurrency, currentDeviationBps, pegReference: pegRef == null ? null : { valueUsd: pegRef, source: "median", contributorCount: 2, asOf: T0 }, ...(pegReferenceUnavailable ? { pegReferenceUnavailable: true } : {}) });
    expect(pegSnap(id, coin, { coins: [row], summary: null, methodology: {} } as PegSummaryResponse)).toMatchObject({ pegRef, deviationBps: currentDeviationBps, pegReferenceUnavailable });
  });

  it("falls back to archived provenance when peg read has no row and keeps unread provenance null", () => {
    const summary = projectFrozenSnapshotLiveSummary(FROZEN_SNAPSHOTS_BY_ID.get("msusd-main-street")!)!;
    const s = pegSnap("msusd-main-street", coinOf("msusd-main-street"), undefined, summary);
    expect([s.pegScoreResult, s.consensusSources, s.agreeSources]).toEqual([null, [CG, "coingecko-onchain-address", "alchemy-address", "moralis-address"], [CG, "alchemy-address"]]);
    const u = pegSnap(USDC, coinOf(USDC), undefined, undefined);
    expect([u.consensusSources, u.agreeSources]).toEqual([null, null]);
  });

  it.each([["matching clock", FX_REOPEN_QUOTE_AT, 1.1, "€1.0200"], ["older NAV quote", FX_REOPEN_QUOTE_AT - 3600, null, "$1.1220"]] as const)(
    "formats the EUTBL detail price with %s",
    (_l, priceObservedAt, pegRef, price) => {
      const coin = coinOf("eutbl-spiko");
      const peer = { ...pegCoin({ id: "eurc-circle", pegCurrency: "EUR", pegType: "peggedEUR", price: 1.1, priceObservedAt: FX_REOPEN_QUOTE_AT }), ...makeFxCurrentPeg("admitted", 0) };
      const view = ready({ id: coin.id, coin, asset: { price: 1.122, priceObservedAt, priceUpdatedAt: FX_REOPEN_QUOTE_AT }, queries: { pegSummary: { data: { coins: [peer], summary: null } as PegSummaryResponse } } });
      expect([view.pegRef, formatObservedPrice(view.coinData.price, coin.flags.pegCurrency, view.pegRef)]).toEqual([pegRef, price]);
    },
  );

  it("uses the archived USD cap and observed quote only when native supply was omitted", () => {
    const coin = coinOf("gyen-gyen"), archive = FROZEN_SNAPSHOTS_BY_ID.get(coin.id)!;
    const market = (ov: Record<string, unknown> = {}) => { const s = projectFrozenSnapshotLiveSummary({ ...archive, peggedAssetRow: { ...archive.peggedAssetRow, ...ov } })!; return mktSnap(coin, s, s.nativeSupply, [], Date.parse(archive.capturedAt)); };
    const legacy = market();
    expect(legacy.supply).toBeCloseTo(702_066_781.49, 2);
    expect(legacy.nativeSupply).toMatchObject({ prevWeek: null, prevMonth: null });
    expect(market({ circulatingNative: 1_000 }).supply).toBe(1_000);
    for (const ov of [{ circulatingNative: null }, { circulating: {} }, { priceObservedAtMode: "nominal_reference" }]) expect(market(ov).supply).toBeNull();
  });

  it("uses one row for deviation/agreement, expires DEX evidence and retains legacy fallback", () => {
    const now = Date.now(), coin = coinOf(USDC), dex = { dexPrice: 0.8, dexDeviationBps: -2000, agrees: true, sourcePools: 1, sourceTvl: 1 };
    const legacy = pegCoin({ currentDeviationBps: 0, consensusSources: [], agreeSources: [], dexPriceCheck: { ...dex, agrees: false } });
    const summary = { price: 0.8, priceSource: CG, priceConfidence: "fallback", consensusSources: [CG], agreeSources: [CG], currentPeg: { currentDeviationBps: -2000, pegReference: null, pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: dex, dexPriceCheckExpiresAt: now / 1000 + 1 } } as StablecoinLiveSummary;
    const read = (ms = now) => pegSnap(coin.id, coin, { coins: [{ ...legacy, id: coin.id }] } as PegSummaryResponse, summary, ms);
    expect(read()).toMatchObject({ deviationBps: -2000, consensusSources: [CG], agreeSources: [CG], dexPriceCheck: dex, priceUnusable: true });
    expect(read(now + 1000)).toMatchObject({ deviationBps: -2000, dexPriceCheck: null });
    expect(read(now + 540000).dexPriceCheck).toBeNull();
    delete summary.currentPeg!.dexPriceCheckExpiresAt;
    expect(read().dexPriceCheck).toBeNull();
    delete summary.currentPeg;
    expect(read()).toMatchObject({ deviationBps: 0, consensusSources: [], agreeSources: [], priceUnusable: false });
  });

  it("uses report-card snapshot freshness instead of browser fetch timestamp", () => {
    const vm = ready({ queries: { reportCards: { data: { cards: [], methodology: {}, dependencyGraph: { nodes: [], edges: [] }, updatedAt: T0 } as never, dataUpdatedAt: 1_800_000_000_000, meta: { updatedAt: T0 + 123, ageSeconds: 0, status: "fresh" } } } });
    expect(vm.reportCardUpdatedAt).toBe((T0 + 123) * 1000);
  });

  it("projects raw market/peg inputs into the ready hero and leaves Supply trends unavailable without native history", () => {
    const vm = ready({ asset: { price: 0.98, ...caps(USD, 200, 250, 100, 0) }, nativeSupply: ns(150, 160, 0), queries: { pegSummary: { data: { coins: [pegCoin({ pegScore: 45, eventCount: 2 })] } as PegSummaryResponse }, reportCards: { data: { cards: [v9({ id: USDT, grade: "B+", score: 79 })] } as never } } });
    expect([vm.mcap, vm.hero.market.supply, vm.hero.market.prevDayTrendClass, vm.hero.passportItems.find((i) => i.key === "record")?.value]).toEqual([200, 200 / 0.98, DIRECTION_TONE_CLASSES.down, "2 incidents"]);
    expect(vm.hero.market.supplyTrend).toMatchObject({ current: 150, safePrevWeek: 160, safePrevMonth: null, hasPrevMonth: false, prevWeekTrendClass: DIRECTION_TONE_CLASSES.down });
    const pegM = vm.hero.tertiaryMetrics.find((m) => m.key === "peg-score")?.display;
    expect(pegM?.value).toBe("45");
    expect(pegM?.sub ?? "").not.toContain("incident");
    expect(vm.hero.signalRailItems.find((i) => i.key === "safety")).toMatchObject({ primary: "B+", secondary: "79/100" });
    expect(ready({ asset: caps(USD, undefined, undefined, 90, 80) }).hero.market.supplyTrend).toMatchObject({ current: null, safePrevWeek: null, safePrevMonth: null, hasPrevMonth: false });
  });

  it("builds a ready view model from fetched inputs", () => {
    const vm = ready({
      asset: caps(USD, undefined, 90, 80, 70),
      queries: { supplyHistory: hist(null), pegSummary: pegQ([{ id: USDT, pegScore: 99 }]), dexLiquidity: { data: { [USDT]: { liquidityScore: 88 } } as never, dataUpdatedAt: 1 }, reportCards: cardsQ([v9({ id: USDT, score: 90, grade: "A" })]) },
      supplemental: { flows: { data: { gauge: { score: 0, band: "neutral" }, coins: [{ stablecoinId: USDT }], hourly: [] } as never }, nowMs: T0 * 1000 },
    });
    expect(vm).toMatchObject({ id: USDT, mcap: 100, prevDay: 90, performanceVsUsd1y: null, hasFlows: true, hasYieldSection: false });
    expect(vm.pegScoreResult?.pegScore).toBe(99);
  });

  it("keeps NAV tokens out of peg-distressed verdicts, keeps curated danger notices critical, and inherits variant archetypes", () => {
    const nav = ready({ id: "susde-ethena", asset: { price: 1.1 }, queries: { supplyHistory: hist(1.1), pegSummary: pegQ([{ id: "susde-ethena", symbol: "sUSDe", pegScore: 35, pegPct: 80, eventCount: 1, currentDeviationBps: 1000, activeDepeg: true, trackingSpanDays: 365 }]), reportCards: cardsQ([v9({ id: "susde-ethena", grade: "F", score: 35 })]) } });
    expect([nav.isNavToken, nav.verdict, nav.coinStates.some((s) => s.kind === "depeg")]).toEqual([true, { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" }, false]);

    const noticed = { ...coinOf(USDT), notices: [{ type: "danger" as const, kind: "depeg" as const, title: "Curated depeg", message: "Not superseded." }] };
    const np = readyParams({ id: noticed.id, coin: noticed, queries: { pegSummary: pegQ([{ id: noticed.id, pegScore: 20, activeDepeg: true, currentDeviationBps: -4500 }]) } });
    np.supplemental.ddrVerdict = { tier: "at_risk", methodologyVersion: null };
    const nVm = asReady(buildVM(np));
    expect(nVm.coinStates).toMatchObject([{ kind: "critical", notice: { title: "Curated depeg" } }, { kind: "depeg", ddrTier: "at_risk" }]);
    expect(nVm.hero.state).toBe(nVm.coinStates[0]);

    const srcVar = coinOf("autousd-auto-finance"), varCoin = { ...srcVar, flags: { ...srcVar.flags, governance: "centralized" as const, yieldBearing: false, navToken: false } };
    const varVm = ready({ id: varCoin.id, coin: varCoin, queries: { supplyHistory: hist(1), reportCards: cardsQ([v9({ id: varCoin.id, grade: "B", score: 80 })]) } });
    expect([varCoin.mechanismArchetype, varVm.verdict]).toEqual([undefined, { archetype: "institutional-default", label: "Institutional Default" }]);
  });

  it("wires selected redemption backstops, handles missing/errored backstops, and respects query gates", () => {
    const wired = ready({ queries: { redemptionBackstops: { data: { coins: { [USDC]: { stablecoinId: USDC, score: 80, resolutionState: "resolved", routeFamily: "stablecoin-redeem" }, [USDT]: { stablecoinId: USDT, score: null, eventualRedeemabilityScore: 65, resolutionState: "resolved", routeFamily: "offchain-issuer" } }, updatedAt: T0 } as never, dataUpdatedAt: 12_345, meta: { updatedAt: T0, ageSeconds: 0, status: "fresh" } } } });
    expect(wired.redemptionBackstop?.stablecoinId).toBe(USDT);
    expect(presetQ(wired, "redemptionBackstops")).toMatchObject({ dataUpdatedAt: 12_345, hasData: true, meta: { updatedAt: T0, status: "fresh" } });

    const err = new Error("redemption API unavailable"), errored = ready({ queries: { redemptionBackstops: failedQ(err) } });
    expect(errored.redemptionBackstop).toBeUndefined();
    expect(presetQ(errored, "redemptionBackstops")).toMatchObject({ error: err, hasData: false });

    const off = { enabled: false };
    const gated = ready({ queries: { dexLiquidity: off, reportCards: off, redemptionBackstops: off }, supplemental: { yieldRankings: off, stressSignals: off, flows: off } });
    const presets = gated.staleQueries.map((q) => q.preset);
    expect(presets).toContain("stablecoins");
    for (const d of ["dexLiquidity", "reportCards", "redemptionBackstops", "yieldRankings", "stressSignals", "mintBurnFlows"]) expect(presets).not.toContain(d);

    const optErr = new Error("optional feeds unavailable");
    const failed = ready({ queries: { dexLiquidity: failedQ(optErr) }, supplemental: { yieldRankings: failedQ(optErr), stressSignals: failedQ(optErr), flows: { ...failedQ(optErr), enabled: true }, blacklist: { summary: undefined, error: optErr, dataUpdatedAt: 0, enabled: true } } });
    expect([failed.hasFlows, failed.hasBlacklist]).toEqual([true, true]);
    expect(failed.staleQueries.map((q) => q.preset)).toEqual(expect.arrayContaining(["dexLiquidity", "yieldRankings", "stressSignals", "mintBurnFlows", "blacklist"]));

    const blSummary = { stats: { perCoinTotalEvents: { USDF: 3, USDA: 2, AEUR: 1 } } } as never;
    expect(["usdf-falcon", "usda-avalon", "aeur-anchored-coins", "usdf-astherus", "usdf-flipcash"].map((id) => { const vm = ready({ id, supplemental: { blacklist: { summary: blSummary, enabled: true } } }); return [vm.hasBlacklist, vm.blacklistSymbol]; }))
      .toEqual([[true, "USDF"], [true, "USDA"], [true, "AEUR"], [false, null], [false, null]]);
  });

  it("exposes tracked variant relationships and commodity yield rankings", () => {
    const varVm = ready({ id: "susds-sky", asset: { price: 1.02, ...caps(USD, undefined, 98, 96, 92) } });
    expect([varVm.variantParent?.id, varVm.isVariant, varVm.variantSiblings.map((c) => c.id).includes("stusds-sky")]).toEqual(["usds-sky", true, true]);
    const parentVm = ready({ id: "usds-sky", asset: caps(USD, undefined, 99, 98, 97) });
    expect([parentVm.hasVariants, parentVm.childVariants.map((c) => c.id)]).toEqual([true, ["susds-sky", "stusds-sky", "skymoneyusdsflagship-sky"]]);
    const goldVm = ready({ id: "xaut-tether", asset: { price: 3_000, ...caps(GOLD, 100, 98, 96, 92) }, queries: { supplyHistory: hist(3_000) }, supplemental: { yieldRankingsData: { rankings: [makeYieldRanking({ id: "xaut-tether", symbol: "XAUT", name: "Tether Gold" })] } as never } });
    expect([goldVm.yieldRanking?.id, goldVm.hasYieldSection]).toEqual(["xaut-tether", true]);
  });

  it.each([
    ["inclusive tolerance", ZCHF, [[14 * DAY, 2]], 3, 50],
    ["outside tolerance", ZCHF, [[14 * DAY + 1, 2]], 3, null],
    ["closest valid anchor", ZCHF, [[-10 * DAY, 1], [-DAY, 2], [0, null], [1, 0]], 3, 50],
    ["missing current price", ZCHF, [[0, 2]], null, null],
    ["invalid current price", ZCHF, [[0, 2]], 0, null],
    ["non-USD eligible", ZCHF, [[0, 0.98], [358 * DAY, 0.98 * 1.2]], 1.12, (1.12 / 0.98 - 1) * 100],
    ["NAV token excluded", "cetes-etherfuse", [[0, 0.05], [358 * DAY, 0.06]], 0.061, null],
  ] as const)("selects annual performance for %s", (_l, id, points, price, expected) => {
    const nowSec = 1_720_000_000, anchorSec = nowSec - 365 * DAY;
    const vm = ready({ id, asset: { price }, queries: { supplyHistory: { data: points.map(([o, p]) => ({ date: anchorSec + o, circulatingUsd: 100, price: p })) } }, supplemental: { nowMs: nowSec * 1000 } });
    if (expected == null) expect(vm.performanceVsUsd1y).toBeNull();
    else expect(vm.performanceVsUsd1y).toBeCloseTo(expected, 6);
  });

  it("handles missing detail summary and reserve fetch errors with curated fallback", () => {
    expect(buildVM(vmParams({ core: { id: USDT, coin: coinOf(USDT) }, queries: { liveSummary: { data: undefined, dataUpdatedAt: 1 } } }))).toMatchObject({ status: "list-error", listError: new Error("Stablecoin list data unavailable") });
    const fb = ready({ id: "iusd-infinifi", asset: { price: 1, ...caps(USD, 100, 90, 80, 70) }, queries: { supplyHistory: hist(null) }, supplemental: { reserves: { error: new Error("reserve api failed") }, nowMs: T0 * 1000 } });
    expect([fb.reserves?.mode, fb.reserveFetchError instanceof Error]).toEqual(["curated-fallback", true]);
  });
});

describe("detail published mint evidence integration", () => {
  it("passes publication availability through without confusing a missing component with a missing request result", () => {
    const coin = buildStablecoinDetailClientCoin(coinOf(USDC)), p = readyParams({ id: coin.id, coin });
    const u = asReady(buildVM(p));
    expect([u.mintAuthority.score?.compactLabel, u.mintAuthority.verdict?.includes("Not rated")]).toEqual(["Mint score unavailable", false]);
    p.queries.reportCards.data = { cards: [] } as never;
    const s = asReady(buildVM(p));
    expect(s.mintAuthority.score?.compactLabel).toBe("NR");
    expect(s.mintAuthority.verdict).toMatch(/^Not rated —/);
  });

  it("keeps process-level screen diagnostics in the ready page even when the mint component is NR", () => {
    const card = v9({ id: USDT });
    card.breakdowns!.control.components = [{ ...card.breakdowns!.control.components[0]!, kind: "mint", score: null }];
    card.breakdowns!.control.issuanceSummary = { diagnostics: [makePublishedProcessDiagnostic({ code: "operational-screen-failed", gate: "H3", controlRef: null, pathId: null, classId: null, memberRef: null, field: "operationalExposurePpm", evidenceRefIds: ["exposure-proof"] })] };
    const view = ready({ queries: { reportCards: { data: { cards: [card] } as never } } });
    expect(view.mintAuthority.score).toBeNull();
    expect(view.mintAuthority.processDiagnostics).toContainEqual(expect.objectContaining({ gate: "H3", field: "operationalExposurePpm", statusLabel: "Failed screen" }));
  });
});

describe("detail feature-status ladders & resolveDetailGradeRead", () => {
  const coin = coinOf(USDT);
  const fStates = (ov: Parameters<typeof vmParams>[0]) => { const p = vmParams({ ...ov, core: { coin, ...ov.core } }); return featSnap(coin.id, coin, p.queries, p.supplemental).states; };

  it("keeps deferred, failed, and stale-with-data reserve reads distinct", () => {
    const resSt = (reserves: NonNullable<NonNullable<Parameters<typeof vmParams>[0]>["supplemental"]>["reserves"]) => fStates({ supplemental: { reserves } }).reserves.status;
    expect([resSt({ enabled: false, isLoading: true }), resSt({ enabled: true, error: offline() }), resSt({ live: { mode: "live", reserves: [], estimated: false }, isLoading: true, error: offline() })])
      .toEqual(["deferred", "unavailable", "stale-with-data"]);
  });

  it.each([
    [{ enabled: false, isLoading: true, error: offline() }, "deferred"], [{ isLoading: true }, "loading"],
    [{ isLoading: false }, "loading"], [{ error: offline() }, "unavailable"], [{ data: { coins: {} } }, "empty"],
    [{ data: { coins: {} }, error: offline() }, "unavailable"], [{ data: { coins: { [USDT]: {} } }, error: offline() }, "retained"],
    [{ data: { coins: { [USDT]: {} } } }, "ready"],
  ] as const)("distinguishes redemption evidence read %s as %s", (q, status) => {
    expect(fStates({ queries: { redemptionBackstops: q as never } }).redemption.status).toBe(status);
  });

  it("classifies report-card read states into settled, pending, and failed", () => {
    expect([gradeRead({ grade: "A" }, { error: null, isLoading: true }), gradeRead(undefined, { error: null, isLoading: true }), gradeRead(undefined, { error: new Error("x"), isLoading: true }), gradeRead(undefined, { data: { cards: [{}] }, error: null }), gradeRead(undefined, { error: null, isLoading: false })])
      .toEqual(["settled", "pending", "failed", "settled", "settled"]);
  });
});

describe("stablecoin detail derive helpers", () => {
  it("derives supply from market cap and preserves explicit zero", () => {
    for (const [m, p, e] of [[250e6, 2.5, 100e6], [0, 1, 0], [0, 2.5, 0], [0, 0, null], [100, 0, null]] as const) expect(supplyFromCap(m, p)).toBe(e);
    for (const bad of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect([supplyFromCap(100, bad), supplyFromCap(bad, 1)]).toEqual([null, null]);
  });

  it("derives indicative deviation bps and rejects invalid price or reference", () => {
    for (const [p, e] of [[1.0125, 125], [0.9975, -25], [1, 0]] as const) expect(devBps(p, 1)).toBe(e);
    for (const bad of [null, undefined, Number.NaN]) expect(devBps(bad, 1)).toBeNull();
    for (const bad of [null, 0, -1, Number.NaN]) expect(devBps(1.01, bad)).toBeNull();
  });
});
