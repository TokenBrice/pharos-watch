import { describe, expect, it } from "vitest";
import type { StablecoinData } from "@shared/types/market";
import { buildDewsScoringResult } from "../scoring";
import type { DewsSourceState } from "../contracts";
import { emptyDewsDependencyDiagnostics } from "./source-state.test-support";

function createAsset(id: string, symbol = "USDA"): StablecoinData {
  return {
    id,
    name: id,
    symbol,
    pegType: "peggedUSD",
    price: 1,
    priceConfidence: "high",
    circulating: { peggedUSD: 10_000_000 },
    circulatingPrevDay: { peggedUSD: 10_000_000 },
    circulatingPrevWeek: { peggedUSD: 10_000_000 },
  } as unknown as StablecoinData;
}

function createSourceState(): DewsSourceState {
  return {
    dexLiqRows: { results: [] },
    dexLiqMap: new Map(),
    dexLiqAgeSecById: new Map(),
    dexLiqStaleIds: new Set(),
    dexPriceMap: new Map(),
    dexPriceAgeSecById: new Map(),
    dexPriceStaleIds: new Set(),
    liqHist7dMap: new Map(),
    liqHistRowsRead: 0,
    blacklistCounts: new Map([["xusd-straitsx", { count24h: 10, count7d: 10 }]]),
    blacklistSourceOk: true,
    prevSignals: new Map(),
    prevSignalStaleIds: new Set(),
    previousGenerationUnavailable: false,
    mintBurnMap: new Map(),
    mintBurnAgeSecById: new Map(),
    mintBurnStaleIds: new Set(),
    yieldWarnings: new Map(),
    yieldSourceRisk: new Map(),
    yieldRankChangeAttribution: new Map(),
    yieldRankingsAgeSec: null,
    yieldRankingsRetained: false,
    latestPsiScore: null,
    sourceCoverage: {},
    dependencyDiagnostics: emptyDewsDependencyDiagnostics(),
  };
}

describe("buildDewsScoringResult peg reference admission", () => {
  it("fails a missing peg type closed instead of scoring a non-USD coin against $1", () => {
    const eurc = {
      ...createAsset("eurc-circle"),
      pegType: undefined,
      price: 1.09,
      priceConfidence: "high",
      circulating: { peggedEUR: 50_000_000 },
      circulatingPrevDay: { peggedEUR: 50_000_000 },
      circulatingPrevWeek: { peggedEUR: 50_000_000 },
    } as unknown as StablecoinData;

    const result = buildDewsScoringResult({
      assetById: new Map([["eurc-circle", eurc]]),
      pegRates: { peggedEUR: 1.09 },
      pegRateSources: { peggedEUR: "fallback" },
      pegRateContributorCounts: { peggedEUR: 2 },
      sourceState: createSourceState(),
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
});

describe("buildDewsScoringResult blacklist attribution", () => {
  it.each([0, 1, 2])("Broker provenance: %s", (confirmed) => {
    const asset = { ...createAsset("usdt-tether"), price: 0.98, priceSource: "mento-broker", agreeSources: confirmed === 1 ? ["kraken"] : [], priceConfidence: "fallback" as const };
    const state = createSourceState();
    if (confirmed === 2) state.dexPriceMap.set(asset.id, { dexPriceUsd: 0.98, independentPrices: [0.98], sourceTotalTvl: 1e6, updatedAt: 1 });
    const row = buildDewsScoringResult({ assetById: new Map([[asset.id, asset]]), pegRates: {},
      sourceState: state, registerMalformedPersistedInput: () => {} }).results[0];
    expect(row.band).toBe(confirmed ? "ALERT" : "WATCH");
    expect(row.evidenceKinds.includes("market-price")).toBe(!!confirmed);
    expect(asset.price).toBe(0.98);
  });

  it("applies blacklist counts only to the tracker stablecoin id for same-symbol assets", () => {
    const result = buildDewsScoringResult({
      assetById: new Map([
        ["xusd-straitsx", createAsset("xusd-straitsx", "XUSD")],
        ["xusd-babelfish", createAsset("xusd-babelfish", "XUSD")],
      ]),
      pegRates: {},
      sourceState: createSourceState(),
      registerMalformedPersistedInput: () => {},
    });

    const straitsx = result.results.find((row) => row.stablecoinId === "xusd-straitsx");
    const babelfish = result.results.find((row) => row.stablecoinId === "xusd-babelfish");

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
    observedZeroState.blacklistCounts = new Map();
    const failedState = createSourceState();
    failedState.blacklistCounts = new Map();
    failedState.blacklistSourceOk = false;

    const assetById = new Map([["xusd-straitsx", createAsset("xusd-straitsx", "XUSD")]]);
    const observedZero = buildDewsScoringResult({
      assetById,
      pegRates: {},
      sourceState: observedZeroState,
      registerMalformedPersistedInput: () => {},
    }).results[0]!;
    const sourceFailed = buildDewsScoringResult({
      assetById,
      pegRates: {},
      sourceState: failedState,
      registerMalformedPersistedInput: () => {},
    }).results[0]!;
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
