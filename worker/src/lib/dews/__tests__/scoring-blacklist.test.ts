import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { StablecoinData } from "@shared/types/supply";
import { buildDewsScoringResult } from "../scoring";
import { hydrateDexPrices } from "../source-state/hydration";
import type { DewsSourceState } from "../contracts";
import { emptyDewsDependencyDiagnostics } from "./source-state.test-support";

function createAsset(id: string, symbol = "USDA"): StablecoinData {
  return {
    id, name: id, symbol, pegType: "peggedUSD", price: 1, priceConfidence: "high",
    circulatingNative: 10_000_000, supplyObservedAt: 1,
    circulating: { peggedUSD: 10_000_000 },
    circulatingPrevDay: { peggedUSD: 10_000_000 },
    circulatingPrevWeek: { peggedUSD: 10_000_000 },
  } as unknown as StablecoinData;
}

const scoreRows = (assetById: Map<string, StablecoinData>, sourceState: DewsSourceState) =>
  buildDewsScoringResult({ assetById, pegRates: {}, sourceState, registerMalformedPersistedInput: () => {} }).results;

function createSourceState(): DewsSourceState {
  const dependencyDiagnostics = emptyDewsDependencyDiagnostics();
  return {
    dexLiquidity: {
      dexLiqRows: { results: [] }, dexLiqMap: new Map(), dexLiqAgeSecById: new Map(), dexLiqStaleIds: new Set(),
      freshCount: 0, staleCount: 0, totalRows: 0, freshnessAgeSec: null,
      dependencyDiagnostics: dependencyDiagnostics.dexLiquidity,
    },
    dexPrices: { dexPriceMap: new Map(), dexPriceAgeSecById: new Map(), dexPriceStaleIds: new Set(), trustedCount: 0, staleCount: 0 },
    liquidityHistory: { liqHist7dMap: new Map(), liqHistRowsRead: 0 },
    blacklist: { blacklistCounts: new Map([["xusd-straitsx", { count24h: 10, count7d: 10 }]]), blacklistSourceOk: true, rowsRead: 0 },
    previousSignals: { prevSignals: new Map(), prevSignalStaleIds: new Set(), generationUnavailable: false, rowsRead: 0 },
    mintBurn: {
      mintBurnMap: new Map(), mintBurnAgeSecById: new Map(), mintBurnStaleIds: new Set(),
      freshCount: 0, staleCount: 0, freshnessAgeSec: null, rowsRead: 0,
    },
    yieldWarnings: { yieldWarnings: new Map(), rowsRead: 0 },
    yieldRankings: {
      yieldSourceRisk: new Map(), yieldRankChangeAttribution: new Map(), yieldRankingsAgeSec: null, yieldRankingsRetained: false,
      dependencyDiagnostics: dependencyDiagnostics.yieldRankings,
    },
    psi: { latestPsiScore: null, dependencyDiagnostics: dependencyDiagnostics.psi },
    sourceCoverage: {},
    dependencyDiagnostics,
  };
}

function silverAsset(now: number, withEntitlement = true): StablecoinData {
  const ozPerToken = 0.998380822;
  return { ...createAsset("xagm-matrixdock"), pegType: "peggedSILVER", price: 30 * ozPerToken,
    priceSource: "coingecko", priceObservedAt: now, priceObservedAtMode: "upstream",
    commodityEntitlement: withEntitlement ? { source: "matrixdock-frs", generation: "ethereum:123",
      quoteObservedAtSec: now, ozPerToken, observedAtSec: now - 60 } : undefined };
}

function hydrateDexSpread(id: string, price: number, nowSec: number, family: string | null) {
  const clock = nowSec - 60;
  const sources = [{ protocol: "curve", price, tvl: 2e6, observedAt: clock, aggregateObservedAt: clock }];
  const lineage = family == null ? sources : { aggregateObservedAt: clock, sources,
    aggregateContributors: [{ venueFamily: "dex:curve", providerFamily: family }] };
  return hydrateDexPrices({ nowSec, registerSourceFailure: () => {}, registerMalformedPersistedInput: () => {},
    db: mockD1([{ match: "FROM dex_prices", rows: [{ stablecoin_id: id, dex_price_usd: price,
      source_total_tvl: 2e6, updated_at: nowSec - 20, source_pool_count: family === "incomplete" ? 2 : 1,
      price_sources_json: JSON.stringify(lineage) }] }]) });
}

describe("buildDewsScoringResult peg reference admission", () => {
  it.each([undefined, "raw-token"] as const)("uses Solayer's observed price for confidence and checks its published unit (%s)", (parityQuoteUnit) => {
    const asset = { ...createAsset("susd-solayer"), parityQuoteUnit, priceSource: "coingecko", priceObservedAt: 1_795_000_000 };
    const state = createSourceState();
    state.dexPrices.dexPriceMap.set(asset.id, { dexPriceUsd: 1.0001, updatedAt: asset.priceObservedAt, sourceTotalTvl: 5e6 });
    const [row] = scoreRows(new Map([[asset.id, asset]]), state);
    expect(row.band).toBe("CALM");
    expect(row.signals.price).toMatchObject({ value: 0, available: true, confidence: "high" });
    expect(row.signals.diverg).toMatchObject({ primaryDevBps: undefined, dexDevBps: 1 });
  });

  it("quarantines EURC relabelled as USD before applying the fixed denominator", () => {
    const eurc = { ...createAsset("eurc-circle"), price: 1.1 };
    const usd = createAsset("usdt-tether");
    const state = createSourceState();
    state.nativeHistory = new Map([[usd.id, { day: 10_000_000, week: 10_000_000 }]]);
    const malformed: string[] = [];
    const { results } = buildDewsScoringResult({
      assetById: new Map([[eurc.id, eurc], [usd.id, usd]]), pegRates: {}, sourceState: state,
      registerMalformedPersistedInput: (failure) => { if (failure.degradesRun) malformed.push(failure.stablecoinId); },
    });
    expect(malformed).toEqual([eurc.id]);
    expect(results.map((row) => row.stablecoinId)).toEqual([usd.id]);
  });

  it("applies the silver entitlement only to the DEWS leg bearing its quote clock", () => {
    const now = Date.parse("2026-11-17T16:00:00Z") / 1000;
    const asset = silverAsset(now);
    const state = createSourceState();
    state.references = new Map([["peggedSILVER", { kind: "fallback", usdPerUnit: 30, preCloseUsdPerUnit: 29,
      observation: { pegKey: "peggedSILVER", usdPerUnit: 30, source: "gold-api.com", cadence: "intraday", observedAtSec: now - 60 } }]]);
    state.nativeHistory = new Map([[asset.id, { day: 10_000_000, week: 10_000_000 }]]);
    state.dexPrices.dexPriceMap.set(asset.id, { dexPriceUsd: 29, updatedAt: now - 30, sourceTotalTvl: 10e6 });
    const [row] = buildDewsScoringResult({ assetById: new Map([[asset.id, asset]]), nowSec: now, pegRates: {},
      sourceState: state, registerMalformedPersistedInput: () => {} }).results;
    expect(row.signals.diverg).toMatchObject({ available: true, primaryDevBps: 0, dexDevBps: undefined,
      referenceAdmission: { primary: { status: "admitted" }, dex: { status: "unavailable" } } });
  });

  it("checks both XAGm quote clocks with FX evidence off before scoring or releasing a closure hold", () => {
    const open = Date.parse("2026-11-17T16:00:00Z") / 1000;
    const closed = Date.parse("2026-11-21T00:01:00Z") / 1000;
    const state = createSourceState();
    const score = (nowSec: number, dexPriceUsd: number, dexAgeSec: number, withEntitlement = true) => {
      const asset = silverAsset(nowSec, withEntitlement);
      state.dexPrices.dexPriceMap.set(asset.id, { dexPriceUsd, updatedAt: nowSec - dexAgeSec, sourceTotalTvl: 10e6,
        aggregateFamilies: ["coingecko"] });
      return buildDewsScoringResult({ assetById: new Map([[asset.id, asset]]), nowSec, pegRates: { peggedSILVER: 30 },
        pegRateSources: { peggedSILVER: "fallback" }, sourceState: state, registerMalformedPersistedInput: () => {} }).results[0]!;
    };

    expect(score(open, 24, 30, false).signals.diverg).toMatchObject({ primaryDevBps: 16, dexDevBps: 2_000 });
    const corrected = score(open, 24, 30);
    expect(corrected).toMatchObject({ score: 0, band: "CALM", evidenceKinds: [] });
    expect(corrected.signals.diverg).toMatchObject({ primaryDevBps: 0, dexDevBps: undefined, spreadBps: 0 });
    const overlapping = score(open, 24, 0).signals.diverg;
    expect(overlapping).toMatchObject({ primaryDevBps: 0, dexDevBps: 1_987 });
    expect(overlapping.venueSpreadBps).toBeUndefined();
    expect(score(closed, 21, 30).signals.diverg).toMatchObject({ available: false, unavailableReason: "reference-market-closed" });
    expect(score(closed, 24, 0).signals.diverg).toMatchObject({ available: false, unavailableReason: "reference-market-closed" });
    expect(score(closed, 21, 0).signals.diverg).toMatchObject({ available: true, dexDevBps: 2_989 });
  });

  it("retains peer contagion across an isolated-flow WARNING crossing", () => {
    const sourceState = createSourceState();
    const assets = ["usdt-tether", "usdc-circle"].map<StablecoinData>((id, i) => ({ ...createAsset(id),
      priceConfidence: i ? "low" : "fallback", circulating: { peggedUSD: 1e10 }, circulatingNative: 1e10 }));
    sourceState.nativeHistory = new Map(assets.map((asset, i) => {
      const anchor = i ? 1.08e10 : 1e11;
      return [asset.id, { day: anchor, week: anchor }];
    }));
    assets.forEach((a, i) => sourceState.dexPrices.dexPriceMap.set(a.id, { dexPriceUsd: i ? 0.99 : 0.9, sourceTotalTvl: 2e6, updatedAt: 1 }));
    const score = () => scoreRows(new Map(assets.map((a) => [a.id, a])), sourceState).find((r) => r.stablecoinId === "usdc-circle")!;
    const base = score();
    sourceState.mintBurn.mintBurnAgeSecById.set("usdc-circle", 0);
    sourceState.mintBurn.mintBurnMap.set("usdc-circle", { isolated: true, epochIssue: null, burn24h: 3e6, mint24h: 5e5,
      burnBaseline: 7e5, mintBaseline: 0, baselineDays: 30, valuation24h: "complete", burnBaselineValuation: "complete" });
    expect(base.score).toBe(63);
    const raised = score();
    expect(raised.score).toBe(65);
    expect(raised.signals.flow.flowScope).toBe("isolated-canonical-leg");
    assets.shift();
    expect(score().amplifiers.contagion).toBe(1);
  });
  it("applies only other coins' bumps across an ordinary WARNING crossing", () => {
    const state = createSourceState();
    const recipient = { ...createAsset("usdc-circle"), priceConfidence: "low" as const,
      circulating: { peggedUSD: 1e10 }, circulatingNative: 1e10 };
    const peer = { ...recipient, id: "usdt-tether", priceConfidence: "fallback" as const };
    state.dexPrices.dexPriceMap.set(recipient.id, { dexPriceUsd: 0.99, sourceTotalTvl: 2e6, updatedAt: 1 });
    state.dexPrices.dexPriceMap.set(peer.id, { dexPriceUsd: 0.9, sourceTotalTvl: 2e6, updatedAt: 1 });
    const results = [1.08e10, 1.09e10].map((anchor) => {
      state.nativeHistory = new Map([[peer.id, { day: 1e11, week: 1e11 }], [recipient.id, { day: anchor, week: anchor }]]);
      const firstPass = scoreRows(new Map([[recipient.id, recipient]]), state)[0]!;
      const final = scoreRows(new Map<string, StablecoinData>([[peer.id, peer], [recipient.id, recipient]]), state)
        .find((row) => row.stablecoinId === recipient.id)!;
      expect(final.amplifiers.contagion).toBe(1.15);
      return { firstPass, final };
    });
    expect(results.map(({ firstPass }) => firstPass.band)).toEqual(["ALERT", "WARNING"]);
    expect(results[1].final.score).toBeGreaterThanOrEqual(results[0].final.score);
  });

  it("fails a missing peg type closed instead of scoring a non-USD coin against $1", () => {
    const eurc = {
      ...createAsset("eurc-circle"), pegType: undefined, price: 1.09, priceConfidence: "high",
      circulating: { peggedEUR: 50_000_000 }, circulatingPrevDay: { peggedEUR: 50_000_000 },
      circulatingPrevWeek: { peggedEUR: 50_000_000 },
    } as unknown as StablecoinData;

    const state = createSourceState();
    state.nativeHistory = new Map([[eurc.id, { day: 10_000_000, week: 10_000_000 }]]);
    const result = buildDewsScoringResult({
      assetById: new Map([["eurc-circle", eurc]]),
      pegRates: { peggedEUR: 1.09 },
      pegRateSources: { peggedEUR: "fallback" },
      pegRateContributorCounts: { peggedEUR: 2 },
      sourceState: state,
      registerMalformedPersistedInput: () => {},
    });

    const row = result.results.find((entry) => entry.stablecoinId === "eurc-circle");
    expect(row).toBeDefined();
    // R1: a missing peg type is unreadable evidence, not a $1 reference. The
    // 1.09 EUR price must not score as a 900 bps depeg or grant market-price
    // evidence for a coin trading at par.
    expect(row!.signals.diverg).toMatchObject({
      available: false,
      value: 0,
      unavailableReason: "peg-type-unavailable",
    });
    expect(row!.evidenceKinds).not.toContain("market-price");
    expect(row!.score).toBe(0);
  });

  it("keeps the USD identity spread with a live clock and a legacy DEX row", async () => {
    const nowSec = Date.parse("2026-11-21T00:00:00Z") / 1000;
    const asset = { ...createAsset("usdc-circle"), price: 1.0015, priceSource: "coinbase", priceObservedAt: nowSec - 60 };
    const state = createSourceState();
    state.dexPrices = await hydrateDexSpread(asset.id, 0.9985, nowSec, null);
    const [row] = buildDewsScoringResult({ assetById: new Map([[asset.id, asset]]), nowSec, pegRates: {},
      sourceState: state, registerMalformedPersistedInput: () => {} }).results;
    expect(row.signals.diverg).toMatchObject({ available: true, primaryDevBps: 15, dexDevBps: 15, venueSpreadBps: 30, value: 13 });
    expect(row.evidenceKinds).toContain("market-price");
  });

  it.each<[string, {
    price?: number | null; dex?: number | null; age?: number; priceSource?: string; family?: string | null;
    priceObservedAtMode?: "local_fetch" | "upstream"; value?: number; evidence?: boolean;
  }]>([
    ["fresh spread", { value: 35, evidence: true }],
    ["carry only", { price: null, dex: null }],
    ["carry with calm spread", { dex: 4_000 }],
    ["fetch timestamp only", { priceObservedAtMode: "local_fetch" }],
    ["stale primary", { age: 3_600 }],
    ["shared provider", { family: "market:coinbase" }],
    ["successive Curve aggregates", { age: 900, priceSource: "dex-promoted" }],
    ["hourly publisher's protocol lane", { age: 900, priceSource: "aerodrome-dex" }],
    ["display-only lineage", { family: null }],
    ["unknown aggregate provider", { family: "unknown" }],
    ["incomplete aggregate lineage", { family: "incomplete" }],
  ])("scores closure evidence (%s)", async (_label, {
    price = 4_000, dex = 3_800, age = 60, priceSource = "coinbase", family = "dex:curve",
    priceObservedAtMode = "upstream", value = 70, evidence = false,
  }) => {
    const nowSec = Date.parse("2026-11-21T00:00:00Z") / 1000;
    const friday = nowSec - 2 * 3600 - 60;
    const xaut = { ...createAsset("xaut-tether", "XAUT"), pegType: "peggedGOLD", price, priceSource,
      priceObservedAt: nowSec - age, priceObservedAtMode };
    const state = createSourceState();
    state.nativeHistory = new Map([[xaut.id, { day: 10_000_000, week: 10_000_000 }]]);
    state.references = new Map([["peggedGOLD", { kind: "fallback", usdPerUnit: 4_000,
      observation: { pegKey: "peggedGOLD", usdPerUnit: 4_000, source: "gold-api.com", cadence: "intraday", observedAtSec: friday } }]]);
    if (dex != null) state.dexPrices = await hydrateDexSpread(xaut.id, dex, nowSec, family);
    if (evidence) {
      const prior = { value: 0, available: true, currentDivergenceValue: 0 };
      state.previousSignals.prevSignals.set(xaut.id, { signals: { diverg: prior }, computedAt: nowSec - 900, ageSec: 900 });
    } else state.previousSignals.referenceDivergenceById = new Map([[xaut.id, { value: 70, observedAtSec: friday }]]);
    const row = buildDewsScoringResult({ assetById: new Map([[xaut.id, xaut]]), nowSec, pegRates: { peggedGOLD: 4_000 },
      pegRateSources: { peggedGOLD: "fallback" }, sourceState: state, registerMalformedPersistedInput: () => {} }).results[0]!;
    expect(row.signals.diverg.value).toBe(value);
    expect(row.evidenceKinds.includes("market-price")).toBe(evidence);
    if (evidence) expect(row.signals.diverg.venueSpreadBps).toBe(526);
    else expect(row.signals.diverg).toMatchObject({ referenceCarried: true, referenceDivergence: { value: 70, observedAtSec: friday } });
    if (price == null) expect(row).toMatchObject({ score: 35, band: "WATCH" });
  });

  it("withholds undated EUR dollar caps and uses the open-market reference without new evidence", () => {
    const asset = { ...createAsset("eurc-circle"), pegType: "peggedEUR", price: 1.089, priceConfidence: "high" as const,
      circulating: { peggedEUR: 173.9e9 }, circulatingPrevDay: { peggedEUR: 176e9 },
      circulatingPrevWeek: { peggedEUR: 185e9 }, supplyObservedAt: undefined };
    const state = createSourceState();
    const score = (when: string) => buildDewsScoringResult({ assetById: new Map([[asset.id, asset]]),
      nowSec: Date.parse(when) / 1000, pegRates: { peggedEUR: 1.1 }, pegRateSources: { peggedEUR: "fallback" },
      sourceState: state, registerMalformedPersistedInput: () => {} }).results[0]!;
    const open = score("2026-11-17T16:00:00Z");
    expect(open.signals.supply).toMatchObject({ available: false, unavailableReason: "supply-history-anchors-missing" });
    expect(open.signals.diverg).toMatchObject({ available: true, primaryDevBps: 100 });
    state.previousSignals.prevSignals.set(asset.id, { signals: { diverg: { value: 18, available: true } }, computedAt: 1, ageSec: 60 });
    expect(score("2026-11-21T16:00:00Z").signals.diverg).toMatchObject({ available: true, value: 18 });
    state.references = new Map();
    expect(score("2026-11-17T16:00:00Z")).toBeUndefined();
  });

  it("compares each lookback in its own unit during a native-history rollout", () => {
    const asset = { ...createAsset("usdc-circle"), circulatingNative: 100e6,
      circulating: { peggedUSD: 98e6 }, circulatingPrevWeek: { peggedUSD: 100e6 } };
    const state = createSourceState();
    state.nativeHistory = new Map([[asset.id, { day: 100e6 }]]);
    const score = () => scoreRows(new Map([[asset.id, asset]]), state)[0]!.signals.supply;
    expect(score()).toMatchObject({ delta1d: 0, delta7d: -2, componentCoverage: 1 });
    state.nativeHistory = new Map([[asset.id, { day: 100e6, week: null }]]);
    expect(score()).toMatchObject({ delta1d: 0, delta7d: null, componentCoverage: 0.6 });
  });

  it.each([809_363, null])("compares metal native units under USD revaluation (%s)", (quantity) => {
    const xaut = { ...createAsset("xaut-tether", "XAUT"), pegType: "peggedGOLD",
      circulating: { peggedGOLD: 3.154e9 }, circulatingPrevDay: { peggedGOLD: 3.154e9 },
      circulatingPrevWeek: { peggedGOLD: 3.234e9 }, circulatingNative: quantity };
    const state = createSourceState();
    state.nativeHistory = new Map([[xaut.id, { day: 809_363, week: 809_381 }]]);
    state.dexPrices.dexPriceMap.set(xaut.id, { dexPriceUsd: 1, sourceTotalTvl: 2e6, updatedAt: 1 });
    const row = buildDewsScoringResult({ assetById: new Map([[xaut.id, xaut]]), pegRates: { peggedGOLD: 1 },
      pegRateSources: { peggedGOLD: "fallback" }, sourceState: state, registerMalformedPersistedInput: () => {} }).results[0]!;
    expect(row.signals.supply).toMatchObject(quantity == null
      ? { available: false, unavailableReason: "supply-native-quantity-unavailable", delta7d: null }
      : { available: true, delta1d: 0, value: expect.closeTo(0, 1) });
  });
});

describe("buildDewsScoringResult blacklist attribution", () => {
  it.each([0, 1, 2])("Broker provenance: %s", (confirmed) => {
    const asset = { ...createAsset("usdt-tether"), price: 0.98, priceSource: "mento-broker", agreeSources: confirmed === 1 ? ["kraken"] : [], priceConfidence: "fallback" as const };
    const state = createSourceState();
    state.nativeHistory = new Map([[asset.id, { day: 10_000_000, week: 10_000_000 }]]);
    if (confirmed === 2) state.dexPrices.dexPriceMap.set(asset.id, { dexPriceUsd: 0.98, independentPrices: [0.98], sourceTotalTvl: 1e6, updatedAt: 1 });
    const row = scoreRows(new Map([[asset.id, asset]]), state)[0];
    expect(row.band).toBe(confirmed ? "ALERT" : "WATCH");
    expect(row.evidenceKinds.includes("market-price")).toBe(!!confirmed);
    expect(asset.price).toBe(0.98);
  });

  it("applies blacklist counts only to the tracker stablecoin id for same-symbol assets", () => {
    const result = scoreRows(new Map([
      ["xusd-straitsx", createAsset("xusd-straitsx", "XUSD")],
      ["xusd-babelfish", createAsset("xusd-babelfish", "XUSD")],
    ]), createSourceState());

    const straitsx = result.find((row) => row.stablecoinId === "xusd-straitsx");
    const babelfish = result.find((row) => row.stablecoinId === "xusd-babelfish");

    expect(straitsx?.signals.black).toMatchObject({
      available: true,
      events24h: 10,
      events7d: 10,
    });
    expect(babelfish?.signals.black).toMatchObject({
      available: false,
      value: 0,
    });
  });

  it("marks tracked blacklist evidence unavailable when the source load failed", () => {
    const observedZeroState = createSourceState();
    observedZeroState.blacklist.blacklistCounts = new Map();
    const failedState = createSourceState();
    failedState.blacklist.blacklistCounts = new Map();
    failedState.blacklist.blacklistSourceOk = false;

    const assetById = new Map([["xusd-straitsx", createAsset("xusd-straitsx", "XUSD")]]);
    const observedZero = scoreRows(assetById, observedZeroState)[0]!;
    const sourceFailed = scoreRows(assetById, failedState)[0]!;
    expect(observedZero.signals.black).toMatchObject({ value: 0, available: true });
    expect(sourceFailed.signals.black).toMatchObject({
      value: 0,
      available: false,
      unavailableReason: "blacklist-source-failed",
    });
    expect(sourceFailed.availableWeight).toBeCloseTo(observedZero.availableWeight - 0.1);
    expect(sourceFailed.effectiveWeights.black).toBeUndefined();
  });
});
