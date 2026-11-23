import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import * as backstops from "@shared/lib/redemption-backstops";
import { getRedemptionBackstopConfig as getCfg, type RedemptionBackstopConfig as Cfg, type RedemptionCostModel as CostModel } from "@shared/lib/redemption-backstops";
import * as capacity from "../redemption-backstop/capacity";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC as SC_MAX_AGE } from "@shared/lib/api-freshness";
import { REDEMPTION_FIAT_REFERENCE_MAX_AGE_SEC as FIAT_MAX_AGE } from "@shared/lib/redemption-fiat-reference";
import { TRACKED_META_BY_ID as META } from "@shared/lib/stablecoins/registry";
import { REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS as DISPS } from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import type { StablecoinData } from "@shared/types/supply";
import type { applyOutputDependencyResolution as ApplyOut, buildRedemptionBackstopEntry as BuildEnt, buildFailedRedemptionBackstopEntry as BuildFail, resolveRedemptionBackstopEntry as ResolveEnt } from "../redemption-backstop/sources";
import type { ExecutableRedemptionObservation as ExecObs } from "../../cron/reserve-adapters/executable-redemption-read-client";
import { buildEntryFixture, dusdOpenQueueMetadata, fpiControllerState, route, severeMarketEvidence as mktEv, liveSnapshot as liveSnap } from "./redemption-backstop-sources.test-support";
import { readRedemptionBackstopLiveMetadata as readLive } from "../redemption-backstop/live-metadata";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { buildChainRpcs } from "../chain-registry";
import { assessReserveFetchFreshness as assessFresh } from "../live-reserves/store-snapshot-state";
import { computeLiveReserveConfigFingerprint as cfgFp } from "@shared/lib/live-reserve-adapters";
import type * as ExecObsMod from "../../cron/reserve-adapters/executable-redemption-observers";
import type { ExitExecutionModelReview } from "@shared/types/exit-route";
import { loadV9CandidateMethodologyPolicy as loadPolicy } from "@shared/lib/safety-score-v9/policy";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { buildRedemptionBackstopsSnapshot as buildSnap, loadRedemptionBackstopSnapshot as loadSnap, upsertRedemptionBackstopSnapshots as upsertSnaps } from "../redemption-backstops-store";
import { buildRedemptionBackstopEntry as buildMerged } from "../redemption-backstop/sources";
import { mergeRedemptionRouteStatus as mergeStatus } from "../redemption-backstop/route-status";
import { resolveBoundedFeeScore as feeScore, resolveCostScenarioScores as costScores, resolveRedemptionStaticFields as staticFields } from "../redemption-backstop/cost";

const { mSync, mLatest, mObs } = vi.hoisted(() => ({ mSync: vi.fn(), mLatest: vi.fn(), mObs: vi.fn() }));
vi.mock("../../cron/reserve-adapters/executable-redemption-observers", async (orig) => ({ ...await orig<typeof ExecObsMod>(), observeExecutableRedemptionRoute: mObs }));
vi.mock("../live-reserves/store", async (orig) => ({ ...await orig<typeof import("../live-reserves/store")>(), getReserveSyncState: mSync, getLatestSuccessfulReserveSnapshotMetadata: mLatest }));
vi.mock("../live-reserve-policy", () => ({ LIVE_RESERVE_FRESHNESS_SEC: 3600 }));

const EMPTY_PROF = { immediateUsd: null, scoringUsd: null, eventualUsd: null, scoringHorizon: "unknown" } as const;
const MISS_CAP = { resolutionState: "missing-capacity", immediateCapacityUsd: null, immediateCapacityRatio: null, capacityScore: null, score: null, eventualRedeemabilityScore: null } as const;
const FULL = { accessScore: 100, settlementScore: 100, executionCertaintyScore: 100, outputAssetQualityScore: 100 };
const USDC = "usdc-circle", USDT = "usdt-tether", USDR = "usdr-rise", USDFR = "usdfr-forest-road", LUSD = "lusd-liquity", ZCHF = "zchf-frankencoin", TEST = "test-coin";
const d1 = () => mockD1Strict([]);
const cfg = (id: string) => getCfg(id)!;
const iso = (s: string) => Date.parse(s) / 1e3;
const utc = (...a: Parameters<typeof Date.UTC>) => Date.UTC(...a) / 1e3;
const snapNA = (id: string, redemption: Record<string, unknown>, ov?: Parameters<typeof liveSnap>[2], extra?: Record<string, unknown>) =>
  liveSnap(id, { freshnessMode: "not-applicable", ...extra, redemption }, ov);
const resSyncCap = { kind: "reserve-sync-metadata" } as const;
const freeFee = { kind: "fee-bps", feeBps: 0 } as const;

describe("buildRedemptionBackstopEntry", () => {
  let buildEnt: typeof BuildEnt, buildFail: typeof BuildFail, resolveEnt: typeof ResolveEnt, applyOut: typeof ApplyOut;
  const now = 1.7e9;
  type Opts = Parameters<typeof buildEnt>[6];
  const build = (id: string, c: Parameters<typeof buildEnt>[2], sup: number | null = 1e8, dex: number | null = null, options?: Opts) =>
    buildEntryFixture(buildEnt, { db: d1(), stablecoinId: id, route: c, supplyUsd: sup, dexScore: dex, nowSec: now, options: { exitExecutionReviews: [], ...options } });
  const runCfg = (id: string, sup: number | null = 1e8, options?: Opts) => build(id, cfg(id), sup, null, options);
  const directObs = (ov: Partial<ExecObs> = {}): ExecObs => ({
    capacityRaw: 500_000_000n, capacitySource: "forest-road-controller", capacityState: "measured", outputAssetKeys: [USDC],
    underlyingDecimals: 6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
    routeStatusReason: "Pinned controller", holderEligibility: "any-holder", feeBps: 0, allInFeeBps: 1, settlementDelaySec: 0,
    blockNumber: 26_143_056, sourceTimestamp: now, sourceUrls: ["https://www.usdfr.com/"], diagnostics: {}, ...ov,
  });
  const liveDirectCases = [
    { d: "LUSD Liquity v1 system debt", id: LUSD, sup: 1e8, dex: null,
      md: { freshnessMode: "not-applicable", redemption: { capacityUsd: 84e6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", feeBps: 50 } },
      ov: { fetchedAt: now - 120, source: "liquity-v1", sourceModel: "single-bucket" },
      exp: { sourceMode: "dynamic", capacitySemantics: "immediate-bounded", immediateCapacityUsd: 84e6, immediateCapacityRatio: 0.84, capacityBasis: "live-direct-telemetry", feeBps: 50 } },
    { d: "fxSAVE ERC-4626 idle fxSP", id: "fxsave-f-x-protocol", sup: 1e7, dex: 20,
      md: { freshnessMode: "not-applicable", assetAddress: "0x65c9a641afceb9c0e6034e558a319488fa0fa3be", redemption: { capacityUsd: 2e6, capacityRatioOfSupply: 0.2, capacityKind: "live-direct", freshnessKind: "same-run-onchain", routeStatus: "unknown", routeStatusSource: "onchain" } },
      ov: { fetchedAt: now - 120, source: "erc4626-single-asset", sourceModel: "single-bucket" },
      exp: { sourceMode: "dynamic", capacityBasis: "live-direct-telemetry", capacitySemantics: "immediate-bounded", immediateCapacityUsd: 2e6, immediateCapacityRatio: 0.2 } },
    { d: "BOLD Liquity v2 branch debt", id: "bold-liquity", sup: 4e7, dex: null,
      md: { freshnessMode: "not-applicable", redemption: { capacityUsd: 32e6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain", feeBps: 52 } },
      ov: { fetchedAt: now - 120, source: "liquity-v2-branches" },
      exp: { sourceMode: "dynamic", capacitySemantics: "immediate-bounded", immediateCapacityUsd: 32e6, immediateCapacityRatio: 0.8, capacityBasis: "live-direct-telemetry", feeBps: 52 } },
    { d: "ZCHF CHFAU StablecoinBridge route", id: ZCHF, sup: 27_682_881.200551473, dex: 35,
      md: { redemption: { capacityUsd: 362_655.25 }, freshnessMode: "unverified" }, ov: { fetchedAt: now - 300, source: "collateral-positions-api" },
      exp: { routeFamily: "stablecoin-redeem", immediateCapacityUsd: 235_304.49020468752, feeBps: 0, feeConfidence: "fixed", provider: "reserve-sync-fallback", capacityConfidence: "heuristic", modelConfidence: "low" } },
  ] as const;

  beforeAll(async () => {
    const m = await import("../redemption-backstop/sources");
    buildEnt = m.buildRedemptionBackstopEntry; buildFail = m.buildFailedRedemptionBackstopEntry;
    resolveEnt = m.resolveRedemptionBackstopEntry; applyOut = m.applyOutputDependencyResolution;
  });
  beforeEach(() => { mSync.mockReset().mockResolvedValue(null); mLatest.mockReset().mockResolvedValue(null); mObs.mockReset(); });

  it.each([
    ["paused", 0, undefined, 0, "impaired"], ["paused", 1e7, undefined, 0, "impaired"],
    ["open", 1e7, 0, 1e7, "resolved"], ["open", 1e7, undefined, 1e7, "resolved"],
  ] as const)("publishes InfiniFi %s inventory %s as executable capacity %s only with open gates", async (routeStatus, capacityUsd, settlementDelaySec, execUsd, resolutionState) => {
    const id = "iusd-infinifi";
    const reserveSnapshotMetadata = liveSnap(id, { freshnessMode: "verified", sourceTimestamp: now, redemption: { capacityUsd, capacityKind: "live-queue", freshnessKind: "verified-source-timestamp", sourceTimestamp: now, settlementDelaySec, queueDepthUsd: 0, routeStatus, routeStatusSource: "onchain" } }, { fetchedAt: now, source: "infinifi" });
    expect(await runCfg(id, 2e7, { reserveSnapshotMetadata })).toMatchObject({ routeStatus, resolutionState, immediateCapacityUsd: execUsd, immediateCapacityRatio: execUsd / 2e7, capacityProfile: { immediateUsd: execUsd, scoringUsd: execUsd } });
  });

  it.each([
    ["closed", "2026-11-14T12:00:00Z", 126_000, "documented-bound", "days", 35, "eventual", null],
    ["reopened", "2026-11-15T23:00:00Z", 0, "live-direct-bounded", "atomic", 100, "immediate", 1e4],
  ] as const)("publishes CHFm's %s-generation settlement model and score", async (_s, date, delay, capacityKind, settlementModel, settlementScore, scoringHorizon, immediateCapacityUsd) => {
    const id = "chfm-mento", clk = iso(date);
    const reserveSnapshotMetadata = snapNA(id, { capacityUsd: 1e4, capacityKind, freshnessKind: "same-run-onchain", sourceTimestamp: clk, settlementDelaySec: delay, routeStatus: "open", routeStatusSource: "onchain" }, { fetchedAt: clk, source: "mento" });
    expect(await buildEnt(d1(), id, cfg(id), 1e5, null, clk, { reserveSnapshotMetadata, exitExecutionReviews: [] })).toMatchObject({
      settlementModel, settlementScore, settlementDelaySec: delay, immediateCapacityUsd, capacityProfile: { scoringHorizon, scoringUsd: 1e4 },
    });
  });

  it.each([
    { n: "Friday quote after closure", obs: "2026-11-13T20:59:00Z", ass: "2026-11-13T21:10:00Z", od: 0, ed: undefined, rs: "unknown", imm: null },
    { n: "Sunday inventory before reopening", obs: "2026-11-15T22:30:00Z", ass: "2026-11-15T22:50:00Z", od: 1800, ed: 600, rs: "open", imm: null },
    { n: "Sunday inventory after reopening", obs: "2026-11-15T22:30:00Z", ass: "2026-11-15T23:00:00Z", od: 1800, ed: undefined, rs: "unknown", imm: null },
    { n: "independent Friday pause after closure", obs: "2026-11-13T20:59:00Z", ass: "2026-11-13T21:10:00Z", od: 0, ed: 0, rs: "paused", imm: 0 },
    { n: "closure past the owner review deadline", obs: "2027-11-06T12:00:00Z", ass: "2027-11-06T12:10:00Z", od: 126_000, ed: undefined, rs: "unknown", imm: null },
  ] as const)("binds CHFm's retained $n to the assessment phase", async (r) => {
    const id = "chfm-mento", sourceTimestamp = iso(r.obs);
    const reserveSnapshotMetadata = snapNA(id, { capacityUsd: r.rs === "paused" ? 0 : 1e4, capacityKind: r.od > 0 ? "documented-bound" : "live-direct-bounded", freshnessKind: "same-run-onchain", sourceTimestamp, settlementDelaySec: r.od, routeStatus: r.rs === "paused" ? "paused" : "open", routeStatusSource: "onchain" }, { fetchedAt: sourceTimestamp, source: "mento" });
    const e = await buildEnt(d1(), id, cfg(id), 1e5, null, iso(r.ass), { reserveSnapshotMetadata, exitExecutionReviews: [] });
    expect(e).toMatchObject({ routeStatus: r.rs, immediateCapacityUsd: r.imm });
    expect(e.settlementDelaySec).toBe(r.ed);
    if (r.rs === "unknown") expect(e).toMatchObject({ score: null, resolutionState: "missing-capacity", capacityRejectionReason: "redeemable-capacity-unobserved" });
    if (r.ed === 600) expect(e).toMatchObject({ sourceTimestamp, capacityProfile: { eventualUsd: 1e4, scoringHorizon: "eventual" } });
  });

  it("persists a withheld stale execution price leg and exposes its exit coverage reason", async () => {
    const id = USDC, c = route(), env = loadPolicy(now), pol = env.policy.semantic.exit.executionModels["erc4626-instant"]!;
    const capturePriceMaxAgeSec = pol.priceMaxAgeSec - (pol.evaluationLagSec ?? 0), observedAtSec = now - capturePriceMaxAgeSec - 1;
    const review: ExitExecutionModelReview = {
      modelId: "erc4626-instant", holder: "any-holder", reviewedAt: "2023-11-01T00:00:00.000Z", expiresAt: "2023-12-01T00:00:00.000Z",
      identity: { assetId: id, deployment: "ethereum:0x0000000000000000000000000000000000000001", endpoint: "ethereum:0x0000000000000000000000000000000000000001", outputAssetKeys: [USDT], implementationIdentity: `sha256:${"1".repeat(64)}` },
      evidenceIds: ["fixture-review"], sourceUrls: ["https://example.com/vault"],
      producer: { kind: "erc4626-instant", chain: "ethereum", chainId: 1, contract: "0x0000000000000000000000000000000000000001", outputToken: "0x0000000000000000000000000000000000000002", inputDecimals: 6, outputDecimals: 6, codeSha256: "1".repeat(64), multicallCodeSha256: "1".repeat(64), balanceStorage: { slot: `0x${"0".repeat(64)}`, keyOrder: "account-slot" }, maxFunctions: "binding", unrestrictedGateSelectors: [] },
    };
    const stablecoinsCache = { kind: "ok" as const, updatedAt: now - 60, payload: { peggedAssets: [makeAsset({ id, price: 1, priceSource: "coingecko", priceObservedAt: now }), makeAsset({ id: USDT, price: 1, priceSource: "coingecko", priceObservedAt: observedAtSec })] } };
    const base = await build(id, c, 2e7, null, { stablecoinsCache });
    const ent = await build(id, c, 2e7, null, { stablecoinsCache, exitExecutionEnvelope: env, exitExecutionReviews: [review] });
    expect(ent.score).toBe(base.score);
    expect(ent.capacityProfile).toEqual(base.capacityProfile);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await upsertSnaps(db, [ent], { runId: "redemption:withheld-price" });
      const expFail = [{ modelId: "erc4626-instant", reason: "execution-price-leg-stale:output", responsibility: "producer-failed", priceLeg: { leg: "output", observedAtSec, capturePriceMaxAgeSec, sourceId: "coingecko", sourceGenerationId: `stablecoins:${now - 60}` } }];
      for (const tbl of ["redemption_backstop_run_rows", "redemption_backstop_history"]) {
        const row = sqlite.prepare(`SELECT details_json FROM ${tbl} WHERE stablecoin_id = ?`).get(id) as { details_json: string };
        expect(JSON.parse(row.details_json).executionRouteFailures).toEqual(expFail);
      }
      for (const proj of [(await loadSnap(db)).map[id], (await buildSnap(db, id)).coins[id]]) {
        expect(proj.executionRouteFailures).toEqual(expFail);
        expect(proj.exitRouteObservationCoverage?.unsupportedReasons).toEqual({ "execution-price-leg-stale:output": 1 });
        expect(proj.score).toBe(base.score);
        expect(proj.capacityProfile).toEqual(base.capacityProfile);
      }
    } finally { sqlite.close(); }
  });

  it("keeps legacy CHF fee conversion and issuer output admission on rate-only generations", async () => {
    const c = route({ routeFamily: "offchain-issuer", reviewedAt: "2023-11-01", capacityModel: { kind: "supply-full", confidence: "documented-bound", basis: "issuer-term-redemption" }, costModel: { ...freeFee, feeComponents: [{ currency: "CHF", terms: { flatAmount: 30 } }] } });
    const sc = { kind: "ok" as const, updatedAt: now - 60, payload: { peggedAssets: [makeAsset({ id: "vchf-vnx", symbol: "VCHF", pegType: "peggedCHF", price: 1.25, priceSource: "coingecko", priceObservedAt: now - 120 })], fxFallbackRates: { peggedCHF: 1.25 } } };
    const adm = await build("vchf-vnx", c, 1e6, null, { stablecoinsCache: sc });
    expect(adm).toMatchObject({ feeBps: null, costScenarioScores: { retail: 40, activeUser: 80, institutional: 100 } });
    const obs = adm.capacityProfile!.exitRouteObservations![0]!;
    expect(obs).toMatchObject({ output: { kind: "fiat", currency: "CHF" }, scoreEligible: true });
    expect(obs.feeEvidence).toBeUndefined();
    expect(obs.capacityCurve?.some((p) => p.executionCostBps !== undefined)).toBe(true);
    const miss = await build("vchf-vnx", c, 1e6);
    expect(miss.costScenarioScores).toBeUndefined();
    expect(miss.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({ feeEvidence: "disclosed-unquantified", scoreEligible: false });
    expect((await build("vchf-vnx", c, 1e6, null, { stablecoinsCache: { ...sc, updatedAt: now - SC_MAX_AGE - 1 } })).costScenarioScores).toBeUndefined();
    const bnd = { pegKey: "peggedCHF", source: "openExchangeRates" as const, cadence: "intraday" as const, usdPerUnit: 1.25, observedAtSec: now - FIAT_MAX_AGE };
    const sel = { kind: "fx" as const, generation: `stablecoins:${sc.updatedAt}`, observation: bnd };
    for (const [fxReferenceObservations, selectedPegReferences, ok] of [
      [{ peggedCHF: bnd }, undefined, true], [{ peggedCHF: bnd }, { peggedCHF: sel }, true],
      [{ peggedCHF: bnd }, { peggedCHF: { ...sel, generation: "other" } }, false],
      [{ peggedCHF: { ...bnd, observedAtSec: bnd.observedAtSec - 1 } }, undefined, false],
      [{ peggedCHF: { ...bnd, source: "peer-median" } }, undefined, false], [{}, undefined, false],
    ] as const) {
      const e = await build("vchf-vnx", c, 1e6, null, { stablecoinsCache: { ...sc, payload: { ...sc.payload, fxReferenceObservations, selectedPegReferences } } });
      expect(e.costScenarioScores).toEqual(ok ? adm.costScenarioScores : undefined);
      expect(e.capacityProfile?.exitRouteObservations?.[0].scoreEligible).toBe(ok);
    }
  });

  it("binds only selected live capacity or fee evidence, not unused static telemetry", async () => {
    const reserveInput = { generationId: "reserve:1700000000:test", contentSha256: "a".repeat(64), stablecoinId: LUSD, attemptId: "success", configFingerprint: cfgFp(META.get(LUSD)!.liveReservesConfig!), freshness: assessFresh({ fetchedAt: now - 120, attemptId: "success", metadata: { freshnessMode: "not-applicable" } }, now, 172800) };
    const s = snapNA(LUSD, { capacityUsd: 1e5, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", feeBps: 50 }, { source: "liquity-v1", sourceModel: "single-bucket" });
    expect((await build(LUSD, route({ capacityModel: resSyncCap }), 1e6, null, { reserveSnapshotMetadata: s, reserveInput })).reserveInput).toEqual(reserveInput);
    expect((await build(LUSD, route({ costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" } }), 1e6, null, { reserveSnapshotMetadata: s, reserveInput })).reserveInput).toBeUndefined();
    expect((await build(LUSD, route(), 1e6, null, { reserveSnapshotMetadata: s, reserveInput })).reserveInput).toEqual(reserveInput);
    expect((await build(LUSD, route({ capacityModel: { ...resSyncCap, fallbackRatio: 1 }, costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" } }), 1e6, null, { reserveInput, reserveSnapshotMetadata: snapNA(LUSD, { routeStatus: "unknown" }) })).reserveInput).toEqual(reserveInput);
  });

  it("publishes unrestricted-holder access for native sUSDf unwrap without inheriting parent issuer KYC", async () => {
    expect(await runCfg("susdf-falcon", 1e7, { reserveSnapshotMetadata: snapNA("susdf-falcon", { capacityUsd: 5e6, capacityKind: "live-direct", freshnessKind: "same-run-onchain" }, { source: "erc4626-single-asset" }) }))
      .toMatchObject({ accessModel: "permissionless-onchain", holderEligibility: "any-holder", outputAssetType: "stable-single" });
  });

  it.each(["usdso-somnia", "usdfc-secured-finance", "sparkusdtbc-spark", "sparkusdc-spark", USDR, "susdx-axis", "xgld-unitas"])(
    "publishes missing capacity rather than a measured zero for unmeasured %s liquidity",
    async (id) => {
      const c = getCfg(id);
      expect(c).not.toBeNull();
      const e = await build(id, c!);
      expect(e).toMatchObject(MISS_CAP);
      expect(e.capacityProfile?.scoringUsd ?? null).toBeNull();
    },
  );

  it.each([null, 0, 1e8])("publishes earnUSD fee/status diagnostics without inventing capacity from supply %s", async (sup) => {
    mObs.mockResolvedValue({
      capacityRaw: 129641670774n, capacitySource: "lido-earnusd-unquantified-queue", capacityState: "unquantified", outputAssetKeys: [USDC],
      settlementBoundUnproven: true, underlyingDecimals: 6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
      routeStatusSource: "onchain", routeStatus: "open", routeStatusReason: "Exact async requests open, no guaranteed completion maximum",
      feeBps: 27, holderEligibility: "any-holder", blockNumber: 26122344, sourceTimestamp: now,
      sourceUrls: ["https://docs.lido.fi/earn/deployment-contracts"], diagnostics: { syncLiquidAssetsRaw: "129641670774", capacityQuantified: false },
    } satisfies ExecObs);
    const reserveInput = { generationId: "reserve:1700000000:test", contentSha256: "a".repeat(64), stablecoinId: "earnusd-lido", attemptId: null, configFingerprint: "b".repeat(64), freshness: assessFresh({ fetchedAt: now - 120, attemptId: null, metadata: { freshnessMode: "not-applicable" } }, now, 172800) };
    const e = await runCfg("earnusd-lido", sup, { rpcOptions: { chainRpcs: buildChainRpcs(), beforeRequest: vi.fn(() => true) }, signal: new AbortController().signal, reserveInput });
    expect(e.reserveInput).toBeUndefined();
    expect(e).toMatchObject({ ...MISS_CAP, feeBps: 27, feeConfidence: "formula", routeStatus: "open", routeStatusSource: "onchain", provider: "executable-observer", sourceMode: "dynamic", capacityConfidence: "heuristic", capacitySemantics: "eventual-only", sourceTimestamp: now, capacityProfile: { ...EMPTY_PROF, settlementBoundUnproven: true } });
    if (sup != null && sup > 0) {
      expect(e.capacityProfile?.exitRouteObservations).toHaveLength(1);
      expect(e.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({ routeId: "redemption:earnusd-lido:queue-redeem", scoreEligible: false, settlementBoundUnproven: true, output: { kind: "tracked-stablecoin", trackedAssetIds: [USDC] } });
    }
    expect(e.settlementDelaySec).toBeUndefined();
    expect(e.notes).toContain("redemption-capacity-unquantified");
    expect(mLatest).not.toHaveBeenCalled();
  });

  it("fails earnUSD closed when its exact queue observation is unavailable", async () => {
    mObs.mockResolvedValue(null);
    await expect(runCfg("earnusd-lido")).rejects.toThrow("earnusd-lido executable observer unavailable");
  });

  it("does not retain the historical open/zero-fee snapshot after a read rejection", async () => {
    mObs.mockRejectedValue(new Error("queue identity drift"));
    await expect(runCfg("earnusd-lido")).rejects.toThrow("queue identity drift");
  });

  it.each([
    [undefined, false], [null, false], ["wm-m0", false], [[], false], [["m-m0"], false], [["wm-m0", "m-m0"], false], [["wm-m0", "wm-m0"], false], [["wm-m0"], true],
  ])("admits only exact USDR holder-output capacity, fee and favorable terms (%j)", async (keys, ok) => {
    const s = snapNA(USDR, { capacityUsd: 2e6, capacityRatioOfSupply: 0.2, capacityKind: "live-direct", freshnessKind: "same-run-onchain", blockNumber: 26_143_056, sourceTimestamp: now, feeBps: 0, outputAssetKeys: keys, routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "any-holder", settlementDelaySec: 60 });
    const e = await runCfg(USDR, 1e7, { reserveSnapshotMetadata: s, redemptionLiveMetadata: readLive(USDR, s, now) });
    expect(e).toMatchObject({ immediateCapacityUsd: null, immediateCapacityRatio: null, feeBps: ok ? 0 : null, costScore: ok ? 100 : 60, resolutionState: ok ? "resolved" : "missing-capacity" });
    if (ok) expect(e).toMatchObject({ capacityProfile: { scoringHorizon: "eventual", eventualUsd: 2e6 }, routeStatus: "open", routeStatusSource: "onchain", liveHolderEligibility: "any-holder", settlementDelaySec: 60 });
    else {
      expect(e).toMatchObject({ routeStatus: "unknown", routeStatusSource: "static-config" });
      expect(e.liveHolderEligibility).toBeUndefined(); expect(e.settlementDelaySec).toBeUndefined();
      expect(e.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
    }
  });

  it("withholds USDR favorable status-only telemetry without the configured wM payout", async () => {
    const e = await runCfg(USDR, 1e6, { reserveSnapshotMetadata: snapNA(USDR, { routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "whitelisted-primary" }) });
    expect(e).toMatchObject({ routeStatus: "unknown", routeStatusSource: "static-config", feeBps: null, immediateCapacityUsd: null, capacityRejectionReason: "route-output-identity-unobserved" });
    expect(e.liveHolderEligibility).toBeUndefined();
  });

  it.each([[undefined, "unknown"], [["m-m0"], "unknown"], [["wm-m0"], "cohort-limited"]] as const)("binds USDR cohort restrictions to the configured payout (%j)", async (keys, exp) => {
    const e = await runCfg(USDR, 1e6, { reserveSnapshotMetadata: snapNA(USDR, { outputAssetKeys: keys, routeStatus: "cohort-limited", routeStatusSource: "onchain", routeStatusReason: "Configured swapper cannot access this output path", holderEligibility: "whitelisted-primary" }) });
    expect(e).toMatchObject({ routeStatus: exp, immediateCapacityUsd: null, routeStatusSource: exp === "unknown" ? "static-config" : "onchain" });
    if (exp === "unknown") { expect(e.capacityRejectionReason).toBe("route-output-identity-unobserved"); expect(e.liveHolderEligibility).toBeUndefined(); }
  });

  it.each([
    [undefined, false], [null, false], [USDC, false], [[], false], [[USDT], false], [[USDC, USDT], false], [[USDC, USDC], false], [[USDC], true],
  ])("applies exact-output admission to observer favorable terms (%j)", async (keys, ok) => {
    const direct = Object.assign(directObs({ feeBps: 10, allInFeeBps: 10 }), { outputAssetKeys: keys });
    const e = await runCfg(USDFR, 1e6, { executableRedemptionObservation: direct, executableObserverValuation: { outputAssetKey: USDC, priceUsd: 1, observedAt: now } });
    expect(e.feeBps).toBe(ok ? 10 : 0);
    if (ok) expect(e).toMatchObject({ immediateCapacityUsd: 500, routeStatus: "open", routeStatusSource: "onchain", liveHolderEligibility: "any-holder", settlementDelaySec: 0 });
    else {
      expect(e).toMatchObject({ immediateCapacityUsd: null, routeStatus: "unknown", routeStatusSource: "static-config", capacityRejectionReason: "route-output-identity-unobserved" });
      expect(e.liveHolderEligibility).toBeUndefined(); expect(e.settlementDelaySec).toBeUndefined();
      expect(e.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
    }
  });

  it("retains independently source-owned adverse USDR status while rejecting payout terms", async () => {
    const e = await runCfg(USDR, 1e6, { reserveSnapshotMetadata: snapNA(USDR, { outputAssetKeys: ["m-m0"], feeBps: 0, routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "Same wrapper's redemption pause observed onchain" }) });
    expect(e).toMatchObject({ routeStatus: "paused", routeStatusSource: "onchain", resolutionState: "impaired", score: null, feeBps: null, immediateCapacityUsd: null, routeStatusReason: "Same wrapper's redemption pause observed onchain" });
    expect(e.capsApplied).toContain("live-route-status-impairment");
  });

  it("retains the exact observer's independently observed pause when payout terms are rejected", async () => {
    const e = await runCfg(USDFR, 1e6, { executableRedemptionObservation: directObs({ capacityRaw: 0n, capacityState: "closed", outputAssetKeys: [USDT], routeStatus: "paused", routeStatusReason: "Pinned controller pause", feeBps: 10, allInFeeBps: 10 }) });
    expect(e).toMatchObject({ routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "Pinned controller pause", immediateCapacityUsd: null, capacityRejectionReason: "route-output-identity-unobserved", feeBps: 0 });
    expect(e.liveHolderEligibility).toBeUndefined(); expect(e.settlementDelaySec).toBeUndefined();
  });

  it.each(["stale", "wrong-output", "unvalued", "unknown-all-in"] as const)("keeps registered USDfr %s observation unavailable without borrowing reserve or supply capacity", async (r) => {
    const e = await runCfg(USDFR, 1e6, {
      executableRedemptionObservation: directObs({ outputAssetKeys: r === "wrong-output" ? [USDT] : [USDC], allInFeeBps: r === "unknown-all-in" ? null : 1, sourceTimestamp: r === "stale" ? now - 601 : now }),
      executableObserverValuation: r === "unvalued" ? null : { outputAssetKey: USDC, priceUsd: 1, observedAt: now },
      reserveSnapshotMetadata: snapNA(USDFR, { capacityUsd: 9e6, feeBps: 0 }),
    });
    expect(e).toMatchObject({ immediateCapacityUsd: null, capacityProfile: { scoringUsd: null, eventualUsd: null }, capacityRejectionReason: { stale: "stale-source-timestamp", "wrong-output": "route-output-identity-unobserved", unvalued: "output-valuation-unobserved", "unknown-all-in": "all-in-cost-unobserved" }[r] });
    expect(e.reserveInput).toBeUndefined();
  });

  it.each([
    [now - 1, now - 60, true], [now - SC_MAX_AGE, now - 60, true], [now - SC_MAX_AGE - 1, now - 60, false], [now + 1, now - 60, false],
    [0, now - 60, false], [now - 0.5, now - 60, false], [now - 1, now - 1_801, false], [now - 1, now + 1, false],
  ] as const)("preserves the original quote clock and rejects stale/future quotes or cache generations (%s/%s)", async (updatedAt, quoteAt, ok) => {
    const spy = vi.spyOn(capacity, "resolveRedemptionCapacity");
    try {
      const e = await runCfg(USDFR, 1e6, {
        executableRedemptionObservation: directObs(),
        stablecoinsCache: { kind: "ok", updatedAt, payload: { peggedAssets: [makeAsset({ id: USDC, price: 0.98, priceSource: "coingecko+defillama", priceObservedAt: quoteAt, priceUpdatedAt: now - 1, priceConfidence: "high", agreeSources: ["coingecko", "defillama", "coingecko-onchain-address"] })] } },
      });
      expect(spy.mock.lastCall?.[5]?.executableObserverValuation).toEqual(ok ? { outputAssetKey: USDC, priceUsd: 0.98, observedAt: quoteAt } : null);
      expect(e.immediateCapacityUsd).toBe(ok ? 490 : null);
      expect(e.capacityRejectionReason).toBe(ok ? undefined : "output-valuation-unobserved");
      expect(e.reserveInput).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it("fails closed when the registered USDfr direct observation is unavailable", async () => {
    mObs.mockResolvedValue(null);
    await expect(runCfg(USDFR, 1e6, { reserveSnapshotMetadata: liveSnap(USDFR, { redemption: { capacityUsd: 9e6 } }) })).rejects.toThrow("usdfr-forest-road executable observer unavailable");
  });

  it.each(["usdx-axis"])("withholds the %s entry when no honest exact-route capacity model exists", async (id) => {
    expect(await resolveEnt(d1(), { id } as StablecoinData, null, now)).toBeNull();
    expect(DISPS.find((r) => r.id === id)).toMatchObject({ disposition: "defer", reasonCode: "capacity-unpublished" });
  });

  it.each([["usdv-solomon-v2", "defer", "issuer-terms-missing"], ["iusd-initia", "needs-research", "documentation-insufficient"]])(
    "withholds %s's opaque composite path even with positive supply",
    async (id, disposition, reasonCode) => {
      expect(await resolveEnt(d1(), makeAsset({ id, circulating: { peggedUSD: 1e8 } }), null, utc(2026, 9, 12))).toBeNull();
      expect(DISPS.find((r) => r.id === id)).toMatchObject({ disposition, reasonCode });
    },
  );

  it("publishes mantraUSD's documented institutional USDC branch without executable capacity or fees", async () => {
    const id = "mantrausd-mantra", e = await resolveEnt(d1(), makeAsset({ id, circulating: { peggedUSD: 1e8 } }), null, utc(2026, 9, 12));
    expect(e).toMatchObject({ ...MISS_CAP, routeFamily: "offchain-issuer", accessModel: "issuer-api", holderEligibility: "whitelisted-primary", outputAssetType: "stable-single", feeBps: null, capacityProfile: EMPTY_PROF });
    expect(e?.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
    expect(getCfg(id)?.outputAssets).toEqual([USDC]);
    expect(DISPS.find((r) => r.id === id)).toBeUndefined();
  });

  it.each(["gbpa-agant", "mxnt-tether"])("keeps %s capacity unquantified instead of inheriting full circulating supply", async (id) => {
    const c = cfg(id);
    expect(c.capacityModel).toEqual({ kind: "unquantified" });
    expect(await build(id, c)).toMatchObject({ ...MISS_CAP, capacityProfile: EMPTY_PROF });
    expect(c.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
  });

  it.each(["usdfc-secured-finance", "meusd-mezo"])("keeps %s native-pool fee/status telemetry without admitting gross debt as capacity", async (id) => {
    const c = cfg(id);
    expect(c.capacityModel).toEqual({ kind: "unquantified" });
    expect(await build(id, c, 1e8, null, { reserveSnapshotMetadata: snapNA(id, { capacityUsd: 9e7, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", sourceTimestamp: now, blockNumber: 123, feeBps: 64, routeStatus: "open", routeStatusSource: "onchain" }) }))
      .toMatchObject({ ...MISS_CAP, feeBps: 64, routeStatus: "open", routeStatusSource: "onchain", capacityProfile: EMPTY_PROF });
  });

  it.each([false, true])("binds unquantified status-only evidence to a fresh reserve generation (stale=%s)", async (stale) => {
    const id = "usdfc-secured-finance", s = snapNA(id, { routeStatus: "open", routeStatusSource: "onchain", routeStatusReason: "Current oracle and TCR permit redemption requests" });
    if (stale) s.fetchedAt = now - 72 * 3600;
    const reserveInput = { generationId: "reserve:1700000000:native-status", contentSha256: "a".repeat(64), stablecoinId: id, attemptId: null, configFingerprint: "b".repeat(64), freshness: assessFresh(s, now, 172800) };
    const e = await runCfg(id, 1e8, { reserveSnapshotMetadata: s, reserveInput });
    expect(e).toMatchObject({ routeStatus: stale ? "unknown" : "open", routeStatusSource: stale ? "static-config" : "onchain", immediateCapacityUsd: null, score: null });
    expect(e.reserveInput).toEqual(stale ? undefined : reserveInput);
  });

  it.each(["filqa-fidelity-international", "fiusd-sygnum"])("models %s USD cash output separately from its NAV-priced share input", async (id) => {
    const c = cfg(id);
    expect(c.outputAssets).toBeUndefined();
    expect(c.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(await build(id, c)).toMatchObject({ routeFamily: "offchain-issuer", executionModel: "rules-based-nav", outputAssetType: "stable-single", outputAssetQualityScore: 100, immediateCapacityUsd: null, capacityScore: null, score: null, feeBps: null });
  });

  it("labels JLTXX NAV pricing without asserting a non-cash payout", () => {
    const c = cfg("jltxx-jpmorgan");
    expect(c).toMatchObject({ routeFamily: "offchain-issuer", outputAssetType: "nav", executionModel: "rules-based-nav" });
    expect(c.v9RouteReviewTerms?.minRedeemUsd).toBeUndefined();
    expect(c.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
  });

  it("separates strUSD public contract execution from discretionary holder eligibility", async () => {
    const c = cfg("strusd-tori");
    expect(c).toMatchObject({ outputAssets: ["trusd-tori"], capacityModel: resSyncCap });
    expect(await build("strusd-tori", c)).toMatchObject({ routeFamily: "queue-redeem", accessModel: "permissionless-onchain", holderEligibility: "issuer-discretionary", settlementModel: "days", immediateCapacityUsd: null, capacityScore: null, score: null, feeBps: 0, feeConfidence: "fixed" });
  });

  it("publishes the reviewed legacy Spark USDC route with unquantified capacity when no execution receipt exists", async () => {
    const e = await resolveEnt(d1(), makeAsset({ id: "susdc-spark-v1", circulating: { peggedUSD: 1e8 } }), null, now, { exitExecutionReviews: [] });
    expect(e).toMatchObject({ ...MISS_CAP, routeFamily: "stablecoin-redeem", outputAssetType: "stable-single", capacityProfile: EMPTY_PROF });
    expect(e?.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
  });

  const offchain = route({ routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "same-day", executionModel: "rules-based-nav" });

  it("resolves supply-full capacity with valid supply", async () => {
    const e = await build(TEST, offchain, 1e8, 50);
    expect(e).toMatchObject({ resolutionState: "resolved", sourceMode: "estimated", capacitySemantics: "eventual-only", immediateCapacityUsd: null, immediateCapacityRatio: null, score: null, capacityScore: null, capacityProfile: { eventualUsd: 1e8, scoringUsd: null, scoringHorizon: "eventual" } });
    expect(e.eventualRedeemabilityScore).toBeLessThanOrEqual(65);
  });

  it("floors zero eventual supply at a zero eventual redemption score", async () => {
    expect(await build(TEST, offchain, 0)).toMatchObject({ eventualRedeemabilityScore: 0, capacityProfile: { eventualUsd: 0 } });
  });

  it("returns missing-cache when supply is null for supply-full model", async () => {
    expect(await build(TEST, route(), null, 50)).toMatchObject({ resolutionState: "missing-cache", score: null, immediateCapacityUsd: null });
  });

  describe("absence-preserving asset wrapper", () => {
    const models = [{ kind: "fixed-usd", amountUsd: 1e6 }, { kind: "supply-ratio", ratio: 0.5 }, { kind: "supply-full" }, resSyncCap] as const;
    const cases: { label: string; circulating: StablecoinData["circulating"] | undefined }[] = [
      { label: "missing", circulating: undefined }, { label: "empty", circulating: {} }, { label: "NaN", circulating: { peggedUSD: NaN } },
      { label: "infinite", circulating: { peggedUSD: Infinity } }, { label: "observed zero", circulating: { peggedUSD: 0 } },
    ];
    for (const capacityModel of models) {
      it.each(cases)(`preserves $label supply through ${capacityModel.kind}`, async ({ circulating }) => {
        const spy = vi.spyOn(backstops, "getRedemptionBackstopConfig").mockReturnValue(route({ capacityModel }));
        try {
          const e = await resolveEnt(d1(), makeAsset({ id: LUSD, circulating }), null, now, {
            exitExecutionReviews: [], reserveSnapshotMetadata: snapNA(LUSD, { capacityUsd: 1e6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" }, { source: "liquity-v1", sourceModel: "single-bucket" }),
          });
          expect(e).not.toBeNull(); expect(e!.immediateCapacityRatio).toBeNull();
          if (capacityModel.kind === "supply-full") {
            if (circulating?.peggedUSD === 0) expect(e).toMatchObject({ capacityProfile: { eventualUsd: 0 }, eventualRedeemabilityScore: 0 });
            else { expect(e!.resolutionState).toBe("missing-cache"); expect(e!.capacityProfile?.eventualUsd ?? null).toBeNull(); expect(e!.eventualRedeemabilityScore).toBeNull(); }
          } else if (capacityModel.kind === "supply-ratio") {
            expect(e).toMatchObject({ resolutionState: circulating?.peggedUSD === 0 ? "missing-capacity" : "missing-cache", immediateCapacityUsd: null });
          } else expect(e!.immediateCapacityUsd).toBe(circulating?.peggedUSD === 0 ? 0 : 1e6);
        } finally { spy.mockRestore(); }
      });
    }
  });

  it("resolves supply-ratio capacity correctly", async () => {
    const e = await build(TEST, route({ routeFamily: "psm-swap", capacityModel: { kind: "supply-ratio", ratio: 0.33 } }), 1e9, 80);
    expect(e).toMatchObject({ resolutionState: "resolved", immediateCapacityUsd: 33e7, immediateCapacityRatio: 0.33 });
    expect(e.score).not.toBeNull();
  });

  it.each([false, true])("joins unresolved outputs without build-order dependence (%s)", async (rev) => {
    const c = route({ routeFamily: "psm-swap", capacityModel: { kind: "supply-ratio", ratio: 0.5 }, outputAssets: ["asset:usd", "missing-output", "test-unresolved-output"] });
    const up = () => build("test-upstream", c), dn = () => build("test-unresolved-output", route(), null);
    const list = rev ? [await dn(), await up()] : [await up(), await dn()];
    const u = list.find((e) => e.stablecoinId === "test-upstream")!;
    Object.freeze(u);
    expect(u).not.toHaveProperty("outputDependencyResolution");
    const m = new Map([["test-upstream", c]]), done = applyOut(list, m);
    expect(done.find((e) => e.stablecoinId === "test-upstream")).toEqual({ ...u, outputDependencyResolution: { stablecoinId: "test-unresolved-output", resolutionState: "missing-cache" } });
    expect(u).not.toHaveProperty("outputDependencyResolution");
    expect(applyOut(done, m)).toEqual(done);
  });

  it("keeps concurrent same-clock snapshots isolated and returned builders unmutated", async () => {
    const c = route({ capacityModel: { kind: "supply-ratio", ratio: 0.5 }, outputAssets: ["test-output"] }), m = new Map([["test-upstream", c]]);
    const [[uA, fOut], [uB, okOut]] = await Promise.all([
      Promise.all([build("test-upstream", c), Promise.resolve(buildFail("test-output", route(), now))]),
      Promise.all([build("test-upstream", c), build("test-output", route())]),
    ]);
    const first = applyOut([uA, fOut], m), second = applyOut([uB, okOut], m);
    expect(first[0].outputDependencyResolution).toEqual({ stablecoinId: "test-output", resolutionState: "failed" });
    expect(second[0]).not.toHaveProperty("outputDependencyResolution");
    await build("test-output", route(), null);
    expect(first[0].outputDependencyResolution).toEqual({ stablecoinId: "test-output", resolutionState: "failed" });
    for (const e of [uA, uB, applyOut([first[0]], m)[0], applyOut([first[0], okOut], m)[0]]) expect(e).not.toHaveProperty("outputDependencyResolution");
  });

  it("discloses only the first observed unresolved output across self and cyclic edges", async () => {
    const cA = route({ outputAssets: ["asset:usd", "missing", "test-b", "test-a"] }), cB = route({ outputAssets: ["test-a"] });
    const a = buildFail("test-a", cA, now), b = buildFail("test-b", cB, now), done = applyOut([a, b], new Map([["test-a", cA], ["test-b", cB]]));
    expect(done[0].outputDependencyResolution).toEqual({ stablecoinId: "test-b", resolutionState: "failed" });
    expect(done[1].outputDependencyResolution).toEqual({ stablecoinId: "test-a", resolutionState: "failed" });
    expect(applyOut([a], new Map([["test-a", route({ outputAssets: ["test-a"] })]]))[0].outputDependencyResolution).toEqual({ stablecoinId: "test-a", resolutionState: "failed" });
  });

  it("uses capacity profile scoring capacity to reduce effective exit score", async () => {
    const e = await build(TEST, route({ capacityModel: { kind: "supply-ratio", ratio: 1, dailyLimitUsd: 1e5, confidence: "documented-bound" } }));
    const u = await build(TEST, route({ capacityModel: { kind: "supply-ratio", ratio: 1, confidence: "documented-bound" } }));
    expect(e).toMatchObject({ resolutionState: "resolved", capacityProfile: { immediateUsd: 1e8, dailyLimitUsd: 1e5, scoringUsd: 1e5, modeledExitSizeUsd: 5e6, scoringHorizon: "daily" } });
    expect(u.score).toBeTypeOf("number"); expect(e.score).toBeLessThan(u.score!);
  });

  it("applies explicit total score caps after component scoring", async () => {
    const e = await build(TEST, route({ capacityModel: { kind: "supply-ratio", ratio: 1, confidence: "documented-bound" }, totalScoreCap: 42 }));
    expect(e).toMatchObject({ resolutionState: "resolved", score: 42 });
    expect(e.capsApplied).toContain("config-cap");
  });

  it("keeps eventual-only queue routes out of current-exit scoring", async () => {
    const e = await build(TEST, route({ routeFamily: "queue-redeem", settlementModel: "queued", executionModel: "rules-based-nav" }), 5e8);
    expect(e).toMatchObject({ score: null, capacityScore: null, capacityProfile: { scoringHorizon: "eventual" } });
    expect(e.eventualRedeemabilityScore).toBeLessThanOrEqual(70);
  });

  it.each([[0, 100], [25, 80]] as const)("scores fixed %s bps fee as %s", async (feeBps, costScore) => {
    expect(await build(TEST, route({ costModel: { kind: "fee-bps", feeBps } }))).toMatchObject({ costScore, feeBps, feeConfidence: "fixed" });
  });

  it("scores formula-confidence dynamic fees as 60", async () => {
    expect(await build("bold-liquity", route({ routeFamily: "collateral-redeem", outputAssetType: "bluechip-collateral", costModel: { kind: "dynamic-or-unclear", feeDescription: "Minimum 50 bps + baseRate", confidence: "formula" } }))).toMatchObject({ costScore: 60, feeConfidence: "formula" });
  });

  it("uses live fee metadata for formula routes when reserve sync exposes a current fee", async () => {
    expect(await build(TEST, route({ routeFamily: "collateral-redeem", outputAssetType: "bluechip-collateral", capacityModel: { kind: "supply-full", confidence: "documented-bound" }, costModel: { kind: "dynamic-or-unclear", feeDescription: "Minimum 50 bps + baseRate", confidence: "formula" } }), 1e8, null, {
      reserveSnapshotMetadata: snapNA("bold-liquity", { feeBps: 50 }, { fetchedAt: now - 300, source: "single-asset", sourceModel: "single-bucket" }),
    })).toMatchObject({ costScore: 80, feeBps: 50, feeConfidence: "formula", feeModelKind: "formula" });
  });

  it("scores undisclosed-reviewed dynamic fees as 40", async () => {
    expect(await build(TEST, route({ ...offchain, costModel: { kind: "dynamic-or-unclear", feeDescription: "Public docs reviewed do not publish a numeric redemption fee.", confidence: "undisclosed-reviewed" } }))).toMatchObject({ costScore: 40, feeConfidence: "undisclosed-reviewed" });
  });

  const qSync = (fallbackRatio?: number) => route({ routeFamily: "queue-redeem", settlementModel: "queued", executionModel: "rules-based-nav", capacityModel: { ...resSyncCap, ...(fallbackRatio === undefined ? {} : { fallbackRatio }) }, costModel: { kind: "dynamic-or-unclear" } });

  it("resolves reserve-sync-metadata capacity with fresh data", async () => {
    const e = await build(LUSD, qSync(0.15), 5e7, null, { reserveSnapshotMetadata: liveSnap(LUSD, { redemption: { capacityUsd: 7.5e6, capacityRatioOfSupply: 0.15 }, sourceTimestamp: now - 1800, freshnessMode: "verified" }, { fetchedAt: now - 1800 }) });
    expect(e).toMatchObject({ sourceMode: "dynamic", resolutionState: "resolved", immediateCapacityUsd: 7.5e6, immediateCapacityRatio: 0.15, capacityConfidence: "live-direct", capacitySemantics: "immediate-bounded", eventualRedeemabilityScore: null });
    expect(e.capacityProfile?.eventualUsd).toBeUndefined();
  });

  it.each([
    { n: "publishes reviewed queued settlement and a zero headline for eEARN-style measured incapacity", red: {}, exp: { resolutionState: "resolved", score: 0, capacityScore: 0, settlementModel: "queued", settlementScore: 20, queueEnabled: true }, cap: "zero-executable-capacity" },
    { n: "leaves eEARN-style unproven settlement capacity unrated while retaining the queued trace", red: { settlementBoundUnproven: true, routeStatus: "open", routeStatusSource: "onchain" }, exp: { resolutionState: "missing-capacity", score: null, capacityScore: null }, cap: null },
    { n: "keeps a paused flagged queue on the measured-zero path instead of the bounded gap", red: { settlementBoundUnproven: true, routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "Withdrawals are paused onchain" }, exp: { routeStatus: "paused", score: null }, cap: "live-route-status-impairment" },
  ])("$n", async ({ red, exp, cap }) => {
    const e = await build(LUSD, route({ settlementModel: "atomic", executionModel: "rules-based-nav", capacityModel: resSyncCap, v9RouteReviewTerms: { settlementModel: "queued" } }), 2e7, null, {
      reserveSnapshotMetadata: snapNA(LUSD, { capacityUsd: 0, capacityKind: "live-queue", freshnessKind: "same-run-onchain", settlementDelaySec: 2_592_000, ...red }),
    });
    expect(e).toMatchObject(exp);
    if (cap) expect(e.capsApplied).toContain(cap);
    if (red.settlementBoundUnproven) expect(e.capacityProfile?.settlementBoundUnproven).toBe(true);
    if (red.routeStatus !== "paused") { expect(e.eventualRedeemabilityScore).toBeNull(); expect(e.capacityProfile?.exitRouteObservations?.[0]?.settlementHorizonSec).toBe(2_592_000); }
    if (cap === null) {
      expect(e.capsApplied).not.toContain("zero-executable-capacity");
      expect(e.capacityProfile).toMatchObject({ scoringUsd: null, settlementBoundUnproven: true, exitRouteObservations: [{ settlementBoundUnproven: true, scoreEligible: false, settlementHorizonSec: 2_592_000 }] });
      expect(e.capacityProfile?.exitRouteObservations?.[0]).not.toHaveProperty("capacityCurve");
    }
  });

  it("reuses pre-parsed live redemption metadata for capacity and fees", async () => {
    expect(await build("usdo-openeden", route({ capacityModel: resSyncCap, costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeDescription: "Live fee formula" } }), 5e7, null, {
      reserveSnapshotMetadata: liveSnap("usdo-openeden", { redemption: { capacityUsd: 1, feeBps: 99 } }, { fetchedAt: now - 120 }),
      redemptionLiveMetadata: {
        updatedAt: now - 120, isFresh: true, hasScoringEligibleFreshness: true, hasBlockingWarnings: false, capacityNotes: [],
        capacityConfidence: "live-direct", settlementBoundUnproven: false, canUseCapacity: true, canUseFee: true, capacityReason: null, feeReason: null,
        immediateRedeemableUsd: 12.5e6, immediateRedeemableRatio: null, capacityKind: "live-direct", freshnessKind: "verified-source-timestamp",
        sourceTimestamp: now - 120, evidenceObservedAt: now - 120, sourceUrls: ["https://example.com/redemption.json"],
        settlementDelaySec: null, queueDepthUsd: null, dailyLimitUsd: null, minRedeemUsd: null, liveHolderEligibility: null,
        redemptionFeeBps: 4, buyFeeBpsMin: null, buyFeeBpsMax: null, routeStatus: "open", routeStatusSource: "protocol-api",
        routeStatusReason: null, routeStatusReviewedAt: null, v9FpiControllerRouteState: null, v9SfrxusdCrosschainRouteState: null,
      },
    })).toMatchObject({ provider: "reserve-sync-metadata", immediateCapacityUsd: 12.5e6, feeBps: 4, sourceTimestamp: now - 120, sourceUrls: ["https://example.com/redemption.json"] });
  });

  it("publishes delayed reserve-sync capacity with its measured daily limit, queue and clock", async () => {
    const urls = ["https://example.com/redemption.json", "https://example.com/redemption.json"], keep = [...urls];
    const e = await build("usde-ethena", route({ accessModel: "whitelisted-onchain", settlementModel: "immediate", capacityModel: resSyncCap, costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" }, reviewedAt: "2026-04-15", docs: [{ label: "Ethena collateral API", url: "https://app.ethena.fi/api/positions/current/collateral" }] }), 1e8, null, {
      reserveSnapshotMetadata: liveSnap("usde-ethena", { freshnessMode: "verified", sourceTimestamp: now - 120, redemption: { capacityUsd: 5e7, capacityKind: "live-proxy-validated", freshnessKind: "verified-source-timestamp", sourceTimestamp: now - 120, sourceUrls: urls, settlementDelaySec: 3600, queueDepthUsd: 12e6, dailyLimitUsd: 5e6, minRedeemUsd: 1e5, holderEligibility: "whitelisted-primary", routeStatus: "open", routeStatusSource: "protocol-api" } }, { fetchedAt: now - 120, source: "ethena" }),
    });
    expect(e).toMatchObject({ immediateCapacityUsd: null, immediateCapacityRatio: null, capacityProfile: { scoringHorizon: "eventual", eventualUsd: 5e7, scoringUsd: 5e6 }, capacityKind: "live-proxy-validated", freshnessKind: "verified-source-timestamp", sourceTimestamp: now - 120, sourceUrls: ["https://example.com/redemption.json"], settlementDelaySec: 3600, queueDepthUsd: 12e6, dailyLimitUsd: 5e6, minRedeemUsd: 1e5, liveHolderEligibility: "whitelisted-primary" });
    expect(urls).toEqual(keep);
  });

  it("treats DUSD's open operator-batched queue as an unproven settlement bound", async () => {
    const c = getCfg("dusd-dialectic"); expect(c).not.toBeNull();
    const e = await build("dusd-dialectic", c!, 5.8e6, null, { reserveSnapshotMetadata: liveSnap("dusd-dialectic", dusdOpenQueueMetadata(now), { fetchedAt: now - 120, source: "makina-strategy" }) });
    expect(e).toMatchObject({ provider: "reserve-sync-metadata", sourceMode: "dynamic", resolutionState: "missing-capacity", routeStatus: "open", routeStatusSource: "onchain", liveHolderEligibility: "any-holder", capacityConfidence: "heuristic", capacityBasis: "live-proxy-buffer", capacityKind: "live-queue", immediateCapacityUsd: null, score: null, queueDepthUsd: 3_104.889979, capacityProfile: { immediateUsd: null, scoringUsd: null, scoringHorizon: "unknown", settlementBoundUnproven: true } });
    expect(e.settlementDelaySec).toBeUndefined();
    expect(e.notes).toContain("Live redemption settlement completion bound is unproven; capacity is not established");
  });

  it("fails DUSD closed when the live queue proof omits usable capacity", async () => {
    const c = getCfg("dusd-dialectic"); expect(c).not.toBeNull();
    const e = await build("dusd-dialectic", c!, 5.8e6, null, { reserveSnapshotMetadata: liveSnap("dusd-dialectic", { freshnessMode: "verified", sourceTimestamp: now - 120, redemption: { capacityKind: "live-queue", freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain" } }, { fetchedAt: now - 120, source: "makina-strategy" }) });
    expect(e).toMatchObject({ resolutionState: "missing-capacity", provider: "reserve-sync-metadata", immediateCapacityUsd: null, score: null });
    expect(e.notes).toContain("Live reserve metadata lacks redeemable-capacity amount");
  });

  it.each([
    { n: "propagates live route status from reserve metadata", id: "cusd-cap", red: { routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "All vault assets are paused", routeStatusReviewedAt: "2026-04-15" }, exp: { routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "All vault assets are paused", routeStatusReviewedAt: "2026-04-15", resolutionState: "impaired", score: null, modelConfidence: "low" }, imp: true },
    { n: "treats cohort-limited live route status as an impaired route", id: "cusd-cap", red: { routeStatus: "cohort-limited", routeStatusSource: "protocol-api", routeStatusReason: "Redemptions are limited to a reviewed cohort" }, exp: { routeStatus: "cohort-limited", routeStatusSource: "protocol-api", resolutionState: "impaired", score: null }, imp: true },
    { n: "ignores live route status without source attribution", id: "cusd-cap", red: { routeStatus: "paused", routeStatusReason: "All vault assets are paused" }, exp: { resolutionState: "resolved", routeStatus: "open", routeStatusSource: "static-config" }, imp: false },
    { n: "uses unsourced unknown live route status to suppress optimistic static open status", id: TEST, red: { routeStatus: "unknown" }, exp: { resolutionState: "resolved", routeStatus: "unknown", routeStatusSource: "static-config", modelConfidence: "low" }, imp: false },
  ])("$n", async ({ id, red, exp, imp }) => {
    const unk = red.routeStatus === "unknown";
    const e = await build(id, route({
      ...(unk ? {} : { routeFamily: "basket-redeem", executionModel: "deterministic-basket", outputAssetType: "stable-basket" } as const),
      capacityModel: resSyncCap, costModel: red.routeStatus === "cohort-limited" ? freeFee : { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
      ...(red.routeStatus === "cohort-limited" ? {} : { reviewedAt: "2026-04-15", docs: [{ label: unk ? "Fixture route" : "Cap vault", url: unk ? "https://example.com/redemption" : "https://docs.cap.app/concepts/vault" }] }),
    }), 1e8, null, { reserveSnapshotMetadata: snapNA(id, { capacityUsd: 1e7, capacityKind: unk ? "live-proxy-validated" : "live-direct-bounded", freshnessKind: unk ? "same-run-api" : "same-run-onchain", ...red }, { source: unk ? "fixture" : "cap-vault" }) });
    expect(e).toMatchObject(exp);
    if (imp) expect(e.capsApplied).toContain("live-route-status-impairment");
    else if (unk) {
      expect(e.confidenceDetails?.reasons).toContain("Route status is unknown without direct live telemetry or a documented capacity bound");
      expect(e.notes).toContain("Live redemption route status is unknown without source attribution");
    } else {
      expect(e.notes).toContain("Live redemption route status omitted source attribution and was ignored");
      expect(e.capsApplied).not.toContain("live-route-status-impairment");
    }
  });

  it.each(liveDirectCases)("uses $d as live direct redemption capacity", async ({ id, sup, dex, md, ov, exp }) => {
    const c = getCfg(id); expect(c).not.toBeNull();
    expect(await build(id, c!, sup, dex, { reserveSnapshotMetadata: liveSnap(id, md, ov) }))
      .toMatchObject({ provider: "reserve-sync-metadata", resolutionState: "resolved", capacityConfidence: "live-direct", modelConfidence: "high", ...exp });
  });

  it("falls back to ratio when reserve-sync has no immediate capacity data", async () => {
    expect(await build(TEST, qSync(0.15), 5e7, null, { reserveSnapshotMetadata: null })).toMatchObject({ sourceMode: "estimated", resolutionState: "resolved", immediateCapacityUsd: 7.5e6, provider: "reserve-sync-fallback", capacityConfidence: "heuristic", capacityBasis: "strategy-buffer" });
  });

  it("uses reviewed fallback confidence and basis for reserve-sync fallback ratios", async () => {
    expect(await build(TEST, route({ capacityModel: { ...resSyncCap, fallbackRatio: 0.0025, confidence: "documented-bound", basis: "hot-buffer" }, costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" }, reviewedAt: "2026-04-04", docs: [{ label: "Reviewed source", url: "https://example.com" }] }), 1e8, null, { reserveSnapshotMetadata: null })).toMatchObject({ provider: "reserve-sync-fallback", sourceMode: "estimated", capacityConfidence: "documented-bound", capacityBasis: "hot-buffer", immediateCapacityUsd: 25e4 });
  });

  it("returns missing-capacity when reserve-sync has no data and no fallback", async () => {
    expect(await build(TEST, qSync(), 5e7, null, { reserveSnapshotMetadata: null })).toMatchObject({ resolutionState: "missing-capacity", score: null });
  });

  it("explains missing capacity when a capable live adapter omits capacity amounts", async () => {
    expect(await build(ZCHF, route({ capacityModel: resSyncCap, costModel: freeFee }), 5e7, null, {
      reserveSnapshotMetadata: liveSnap(ZCHF, { freshnessMode: "unverified", details: { freshnessSource: "position-and-price-apis", freshnessReason: "Collateral positions and price payloads do not expose a trustworthy source timestamp" } }, { fetchedAt: now - 120, source: "collateral-positions-api" }),
    })).toMatchObject({ resolutionState: "missing-capacity", capacityRejectionReason: "invalid-freshness" });
  });

  it("preserves reviewed fee and docs metadata on failed reserve-sync routes", () => {
    const e = buildFail(TEST, route({ routeFamily: "queue-redeem", settlementModel: "queued", executionModel: "rules-based-nav", capacityModel: { ...resSyncCap, confidence: "documented-bound" }, costModel: { kind: "fee-bps", feeBps: 25, feeDescription: "Reviewed fallback fee is 25 bps" }, docs: [{ label: "Reviewed route docs", url: "https://example.com/route", supports: ["route", "fees"] }] }), now);
    expect(e).toMatchObject({ resolutionState: "failed", score: null, capacityConfidence: "heuristic", feeConfidence: "fixed", feeBps: 25, feeDescription: "Reviewed fallback fee is 25 bps", docs: { label: "Reviewed route docs", url: "https://example.com/route", provenance: "config-reviewed" } });
    expect(e.docs?.sources?.[0]?.supports).toEqual(["route", "fees"]);
  });

  it("does not add current-exit uplift for eventual-only redemption", async () => {
    const e = await build(TEST, route({ capacityModel: { kind: "supply-full" }, costModel: freeFee }), 5e8, 40);
    expect(e.score).toBeNull(); expect(e.eventualRedeemabilityScore).not.toBeNull();
  });

  it("marks static redemption routes impaired during severe active depegs", async () => {
    const reason = "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.";
    const e = await build(TEST, route({ capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" }, costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" } }), 1e8, 33, {
      routeAvailability: mktEv({ routeStatusReason: reason, routeStatusReviewedAt: "2026-04-14", activeDepegBps: 8332, activeDepegStartedAt: 1_774_145_097 }),
    });
    expect(e).toMatchObject({ resolutionState: "impaired", score: null, routeStatus: "degraded", routeStatusSource: "market-implied", routeStatusReviewedAt: "2026-04-14", modelConfidence: "low" });
    expect(e.capsApplied).toContain("market-implied-depeg-impairment");
    expect(e.notes).toContain(reason);
  });

  it("withholds the score when an open incident lacks current authoritative evidence", async () => {
    const e = await build(TEST, route({ capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" }, costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" } }), 1e8, 33, {
      routeAvailability: mktEv({ routeStatus: "unknown", routeStatusReason: "Open downside incident, but no authoritative current deviation within 1800 seconds establishes present route availability; redemption score withheld.", activeDepegBps: undefined }),
    });
    expect(e).toMatchObject({ resolutionState: "impaired", score: null, routeStatus: "unknown", routeStatusSource: "market-implied", modelConfidence: "low" });
    expect(e.capsApplied).toContain("market-implied-depeg-evidence-uncertain");
  });

  it("does not let live-direct capacity bypass uncertainty without explicit live-open status", async () => {
    expect(await build(ZCHF, route({ capacityModel: resSyncCap, costModel: freeFee }), 5e7, 33, {
      reserveSnapshotMetadata: liveSnap(ZCHF, { sourceTimestamp: now - 120, redemption: { capacityUsd: 5e6, capacityRatioOfSupply: 0.1, capacityKind: "live-direct", freshnessKind: "same-run-onchain", sourceTimestamp: now - 120 } }, { fetchedAt: now - 120 }),
      routeAvailability: mktEv({ routeStatus: "unknown", activeDepegBps: undefined }),
    })).toMatchObject({ resolutionState: "impaired", routeStatus: "unknown", score: null });
  });

  it.each([false, true])("evaluates the severe-depeg exemption against final capacity (stale=%s)", async (stale) => {
    const obsAt = now - (stale ? 7200 : 120);
    const e = await build(ZCHF, route({ capacityModel: { ...resSyncCap, fallbackRatio: 0.1 }, costModel: freeFee }), 5e7, 33, {
      reserveSnapshotMetadata: liveSnap(ZCHF, { sourceTimestamp: obsAt, redemption: { capacityUsd: 5e6, capacityRatioOfSupply: 0.1, capacityKind: "live-direct", freshnessKind: "same-run-onchain", sourceTimestamp: obsAt, routeStatus: "open", routeStatusSource: "onchain" } }, { fetchedAt: obsAt }),
      routeAvailability: mktEv({ routeStatusReason: "Active severe depeg of 3000 bps started 2026-04-14; static redemption route requires current live-open evidence before it can score.", routeStatusReviewedAt: "2026-04-14", activeDepegStartedAt: now }),
    });
    expect(e).toMatchObject({ resolutionState: stale ? "impaired" : "resolved", routeStatus: stale ? "degraded" : "open", routeStatusSource: stale ? "market-implied" : "onchain", modelConfidence: stale ? "low" : "high" });
    if (stale) { expect(e).toMatchObject({ provider: "reserve-sync-fallback", sourceMode: "estimated", capacityConfidence: "heuristic", score: null }); expect(e.capsApplied).toContain("market-implied-depeg-impairment"); }
    else { expect(e.score).not.toBeNull(); expect(e.capsApplied).not.toContain("market-implied-depeg-impairment"); }
  });

  it("derives modelConfidence correctly for resolved entries", async () => {
    expect((await build(LUSD, route({ ...qSync(0.15), costModel: freeFee }), 5e7, null, { reserveSnapshotMetadata: liveSnap(LUSD, { redemption: { capacityUsd: 5e6, capacityRatioOfSupply: 0.1 }, sourceTimestamp: now - 100, freshnessMode: "verified" }, { fetchedAt: now - 100 }) })).modelConfidence).toBe("high");
    expect(await build(TEST, route({ routeFamily: "collateral-redeem", outputAssetType: "bluechip-collateral", capacityModel: { kind: "supply-full", confidence: "documented-bound" }, costModel: { kind: "dynamic-or-unclear", feeDescription: "Minimum 50 bps + baseRate", confidence: "formula" } }))).toMatchObject({ modelConfidence: "medium", capacitySemantics: "eventual-only" });
    expect((await build(TEST, route({ ...offchain, capacityModel: { kind: "supply-full" }, costModel: { kind: "dynamic-or-unclear" } }))).modelConfidence).toBe("low");
  });

  it("stops using stale reserve capacity metadata when no safe fallback exists", async () => {
    expect(await build("gho-aave", route({ routeFamily: "psm-swap", capacityModel: resSyncCap, costModel: { kind: "fee-bps", feeBps: 10 } }), 5e7, null, {
      reserveSnapshotMetadata: liveSnap(TEST, { redemption: { capacityUsd: 1e7, capacityRatioOfSupply: 0.2 } }, { fetchedAt: now - 7200 }),
    })).toMatchObject({ resolutionState: "missing-capacity", score: null, capacityRejectionReason: "stale" });
  });

  it.each([false, true])("admits only the GHO residual-issuance warning (blocking=%s)", async (blk) => {
    const e = await build("gho-aave", route({ routeFamily: "psm-swap", capacityModel: resSyncCap, costModel: { kind: "fee-bps", feeBps: 10 } }), 584e6, null, {
      reserveSnapshotMetadata: snapNA("gho-aave", { capacityUsd: 212_370_000, capacityRatioOfSupply: 212_370_000 / 584e6, ...(blk ? {} : { feeBps: 10 }) }, {
        source: "gho", warningCount: blk ? 2 : 1, syncStatus: "degraded",
        warnings: [
          { code: "aggregated-residual-issuance", message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)", severity: "warning", effect: "degraded" },
          ...(blk ? [{ code: "tracked-gsm-read-failed", message: "Tracked GSM module could not be read", severity: "warning", effect: "degraded" } as const] : []),
        ],
      }),
    });
    expect(e.resolutionState).toBe(blk ? "missing-capacity" : "resolved");
    expect(e.notes).toContain(blk ? "Live reserve metadata degraded; latest snapshot not in ok state" : "Using tracked live GSM backing as a lower-bound redemption capacity despite aggregated residual issuance outside configured GSM modules");
    if (!blk) expect(e).toMatchObject({ provider: "reserve-sync-metadata", capacityConfidence: "live-direct", immediateCapacityUsd: 212_370_000 });
  });

  it("uses fresh live redemption fee telemetry for fixed-fee routes", async () => {
    const e = await build(TEST, route({ routeFamily: "psm-swap", capacityModel: { kind: "supply-full", confidence: "documented-bound" }, costModel: { kind: "fee-bps", feeBps: 10, feeDescription: "Reviewed fallback bound is 10 bps" } }), 5e7, null, {
      reserveSnapshotMetadata: liveSnap("gho-aave", { redemption: { feeBps: 7 }, sourceTimestamp: now - 120 }, { fetchedAt: now - 120 }),
    });
    expect(e).toMatchObject({ feeBps: 7, costScore: 100, feeDescription: "Fresh live redemption fee telemetry: 7 bps." });
    expect(e.notes).toContain("Using fresh live redemption fee telemetry in place of the reviewed fallback bound");
  });

  it("populates docs from proofOfReserves when available", async () => {
    const m = META.get(USDT); expect(m?.proofOfReserves?.url).toBeTruthy();
    const e = await build(USDT, route({ ...offchain, capacityModel: { kind: "supply-full" }, costModel: freeFee, docs: [] }));
    expect(e.docs).toMatchObject({ url: m!.proofOfReserves!.url, provenance: "proof-of-reserves" });
    expect(e.docs!.label).toContain("feed");
  });

  it("falls back to preferred link labels when no proofOfReserves", async () => {
    const m = META.get("usds-sky"), pref = ["Docs", "Proof of Reserve", "Transparency", "Website"];
    expect(m?.proofOfReserves?.url).toBeFalsy(); expect(m?.links?.some((l) => pref.includes(l.label))).toBe(true);
    const e = await build("usds-sky", route({ routeFamily: "psm-swap", capacityModel: { kind: "supply-full" }, costModel: freeFee, docs: [] }), 1e9);
    expect(e.docs?.provenance).toBe("preferred-link"); expect(pref).toContain(e.docs!.label);
  });

  it("rejects docs resolution for unknown coins", async () => {
    await expect(build(TEST, route({ capacityModel: { kind: "supply-full" }, costModel: freeFee, docs: [] }))).rejects.toThrow(/Unknown tracked stablecoin id "test-coin"/);
  });

  it("adds the accepted FPI controller route without changing legacy entry fields", async () => {
    const c = getCfg("fpi-frax"); expect(c).toBeDefined();
    const st = fpiControllerState(now, 20);
    const fpiSnap = (v9RouteAttempt?: Record<string, unknown>) => ({
      stablecoinId: "fpi-frax", fetchedAt: now - 30, source: "frax-fpi-collateral",
      metadata: { freshnessMode: "verified" as const, sourceTimestamp: now - 30, redemption: { capacityUsd: 2e6, capacityKind: "live-proxy-validated" as const, freshnessKind: "verified-source-timestamp" as const, sourceTimestamp: now - 30, routeStatus: "open" as const, routeStatusSource: "protocol-api" as const, sourceUrls: ["https://frax.com/transparency"], ...(v9RouteAttempt ? { v9RouteAttempt } : {}) } },
      warningCount: 0, warnings: [], sourceModel: "dynamic-mix" as const, evidenceClass: "independent" as const, syncStatus: "ok" as const,
    });
    const base = await build("fpi-frax", c!, 1e7, null, { reserveSnapshotMetadata: fpiSnap() });
    const acc = await build("fpi-frax", c!, 1e7, null, { reserveSnapshotMetadata: fpiSnap({ status: "accepted", attemptedAtSec: now, state: st }) });
    const rej = await build("fpi-frax", c!, 1e7, null, { reserveSnapshotMetadata: fpiSnap({ status: "rejected", attemptedAtSec: now, rejectionCode: "calculation-mismatch", blockNumber: 25_600_682 }) });
    expect(acc.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({ routeId: "redemption:fpi-frax:fpi-controller:ethereum", scope: { kind: "chain-contract", contractOrPoolId: st.controllerAddress }, output: { kind: "tracked-stablecoin", trackedAssetIds: ["frax-frax"] }, evidenceKind: "onchain-contract-state", scoreEligible: true, executableUsd: 5e5, completionRatio: 1 });
    expect(rej.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({ routeId: "redemption:fpi-frax:collateral-redeem", scoreEligible: false });
    const [aL, bL] = [structuredClone(acc), structuredClone(base)];
    delete aL.capacityProfile?.exitRouteObservations; delete bL.capacityProfile?.exitRouteObservations;
    expect(aL).toEqual(bL);
  });
});

const staticOpen = { routeStatus: "open" as const, routeStatusSource: "static-config" as const };

describe("mergeRedemptionRouteStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("constructs the merged entry from supplied metadata without external I/O", async () => {
    const fetchMock = vi.fn(() => { throw new Error("Unexpected fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    const db = d1(), now = 1.7e9;
    expect(await buildMerged(db, ZCHF, route({ capacityModel: resSyncCap }), 5e7, null, now, {
      reserveSnapshotMetadata: liveSnap(ZCHF, { redemption: { capacityUsd: 5e6, capacityKind: "live-direct", freshnessKind: "same-run-onchain", sourceTimestamp: now - 120, routeStatus: "paused", routeStatusSource: "onchain" } }, { fetchedAt: now - 120 }),
    })).toMatchObject({ routeStatus: "paused", routeStatusSource: "onchain", resolutionState: "impaired", score: null });
    expect(fetchMock).not.toHaveBeenCalled(); expect(db.getHistory()).toEqual([]);
  });

  it("falls back to static status when no live route status is present", () => {
    expect(mergeStatus({ staticEvidence: { routeStatus: "unknown", routeStatusSource: "static-config" }, allowSevereMarketOpenException: false })).toMatchObject({ routeStatus: "unknown", routeStatusSource: "static-config", impaired: false, notes: [] });
  });

  it.each([
    ["yusd-yieldfi", 12, "2026-10-11", null, "unknown"], ["yusd-yieldfi", 12, "2026-10-11", 1e8, "unknown"],
    ["eurr-stablr", 8, "2026-10-07", null, "unknown"], ["eurr-stablr", 8, "2026-10-07", 1e6, "degraded"],
  ] as const)("withholds %s suspended channel (day=%s, rev=%s, supply=%s, market=%s)", async (id, day, rev, sup, mkt) => {
    const db = d1(), e = await buildMerged(db, id, cfg(id), sup, null, utc(2026, 9, day), { reserveSnapshotMetadata: null, routeAvailability: mktEv({ routeStatus: mkt }) });
    expect(e).toMatchObject({ routeStatus: "suspended", routeStatusSource: "operator-notice", routeStatusReviewedAt: rev, resolutionState: "impaired", score: null, capacityScore: null, immediateCapacityUsd: null, capsApplied: ["reviewed-route-suspension"] });
    if (sup == null) expect(e.capacityProfile).toBeUndefined();
    else expect(e.capacityProfile).toMatchObject({ immediateUsd: null, eventualUsd: null, scoringUsd: null });
    expect(db.getHistory()).toEqual([]);
  });

  it("impairs live-open evidence during severe market impairment when the route is not strong live-direct", () => {
    expect(mergeStatus({ staticEvidence: staticOpen, liveEvidence: { routeStatus: "open", routeStatusSource: "onchain" }, severeMarketImplied: mktEv(), allowSevereMarketOpenException: false })).toMatchObject({ routeStatus: "degraded", routeStatusSource: "market-implied", impaired: true, capsApplied: ["market-implied-depeg-impairment"] });
  });

  it("honors a producer-approved strong live-direct exception", () => {
    expect(mergeStatus({ staticEvidence: staticOpen, severeMarketImplied: mktEv(), allowSevereMarketOpenException: true })).toMatchObject({ routeStatus: "open", routeStatusSource: "static-config", impaired: false, capsApplied: [] });
  });

  it.each([1, undefined])("does not exempt strong live-direct routes from output dependency impairment (share %s)", (share) => {
    expect(mergeStatus({ staticEvidence: staticOpen, liveEvidence: { routeStatus: "open", routeStatusSource: "onchain" }, severeMarketImplied: mktEv({ routeStatusReason: "Output asset impairment", outputImpairedDependencyId: USDC, ...(share === undefined ? {} : { outputImpairedShare: share }) }), allowSevereMarketOpenException: true }))
      .toMatchObject({ routeStatus: "degraded", routeStatusSource: "market-implied", impaired: true, capsApplied: ["market-implied-depeg-impairment"] });
  });
});

describe("resolveBoundedFeeScore", () => {
  it.each([[0, 100], [10, 100], [11, 80], [50, 80], [51, 60], [100, 60], [101, 40], [500, 40]])("scores %s bps as %s", (bps, sc) => {
    expect(feeScore(bps)).toBe(sc);
  });
});

describe("resolveCostScenarioScores", () => {
  it("makes high fixed network costs expensive for retail users", () => {
    expect(costScores({ ...freeFee, gasOrBridgeCostUsd: 25 }, 0)).toMatchObject({ retail: 40, activeUser: 80, institutional: 100 });
  });
  it("uses documented fee ranges for scenario scoring", () => {
    expect(costScores({ kind: "dynamic-or-unclear", confidence: "formula", feeBpsMin: 5, feeBpsMax: 75, feeDescription: "5-75 bps depending on utilization" }, null)).toMatchObject({ activeUser: 60, institutional: 60 });
  });
});

describe("fractional live fee precision", () => {
  const c = cfg("rusd-reservoir");
  describe.each([{ kind: "dynamic-or-unclear", confidence: "formula" }, freeFee] satisfies CostModel[])("$kind", (costModel) => {
    it.each([0.4, 10, 10.49, 50.49, 100.49])("preserves admitted %s bps in component and scenario scores", (bps) => {
      const now = 1_797_120_000, sc = feeScore(bps);
      expect(staticFields("rusd-reservoir", { ...c, costModel }, FULL, null, now, { ...readLive("rusd-reservoir", null, now), canUseFee: true, redemptionFeeBps: bps }))
        .toMatchObject({ selectedLiveFee: true, feeBps: bps, costScore: sc, costScenarioScores: { retail: sc, activeUser: sc, institutional: sc } });
    });
  });
});

describe("component cost unavailable reasons", () => {
  const now = utc(2026, 6, 13);
  const fx = { clockSec: now, pegDataById: { captured: { pegCurrency: "EUR", pegReference: { valueUsd: 1.25, source: "fx" as const, contributorCount: 0, asOf: now } } } };
  const base: Cfg = { routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "atomic", executionModel: "rules-based-nav", outputAssetType: "stable-single", capacityModel: { kind: "fixed-usd", amountUsd: 1e7, confidence: "documented-bound" }, costModel: freeFee, docs: [{ label: "Synthetic terms", url: "https://example.com/terms", supports: ["fees"] }], reviewedAt: "2026-07-01" };
  it.each([
    ["USD", false, false, "redemption-cost-percentage-ceiling-absent"], ["EUR", false, true, "redemption-cost-percentage-ceiling-absent"],
    ["EUR", false, false, "redemption-cost-percentage-ceiling-absent"], ["EUR", true, false, "redemption-cost-fiat-reference-unavailable"],
    ["EUR", true, true, null], ["USD", true, false, null],
  ] as const)("names the cause for %s, bounded=%s, withFx=%s", (currency, bnd, withFx, reason) => {
    const costModel: CostModel = { kind: "dynamic-or-unclear", confidence: "formula", feeBpsMin: 5, ...(bnd ? { feeBpsMax: 10 } : {}), feeComponents: [{ currency, terms: { flatAmount: 1 } }] };
    const f = staticFields("synthetic-fiat-issuer", { ...base, costModel }, FULL, null, now, undefined, withFx ? fx : undefined);
    expect(f).toMatchObject({ feeBps: null, notes: reason ? [reason] : [], costScore: reason ? 40 : 80 });
    if (reason) expect(f.costScenarioScores).toBeUndefined();
    else expect(f.costScenarioScores).toEqual({ retail: 80, activeUser: 80, institutional: 80 });
  });
});

describe("USSD BrandedCustodian fee", () => {
  it("publishes the owner-settable redeemFee() as an unquantified formula cost", () => {
    const f = staticFields("ussd-sonic-labs", cfg("ussd-sonic-labs"), FULL);
    expect(f).toMatchObject({ feeBps: null, feeConfidence: "formula", feeModelKind: "formula", costScore: 60 });
    expect(f.costScenarioScores).toBeUndefined();
  });
});

describe("V8 compatibility", () => {
  it("does not apply V9-only USDT route terms to legacy cost scenarios", () => {
    const c = cfg(USDT);
    expect(c.costModel).not.toHaveProperty("minFeeUsd");
    expect(staticFields(USDT, c, FULL)).toMatchObject({ costScore: 100, feeBps: null, costScenarioScores: { retail: 100, activeUser: 100, institutional: 100 } });
  });
});
