import { describe, expect, it } from "vitest";
import type { StablecoinData } from "@shared/types/market";
import { buildDewsScoringResult } from "../../../lib/dews/scoring";
import type { DewsSourceState } from "../../../lib/dews/contracts";

function createAsset(id: string): StablecoinData {
  return {
    id,
    name: id,
    symbol: "USDA",
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
    blacklistCounts: new Map([["usda-avalon", { count24h: 10, count7d: 10 }]]),
    blacklistSourceOk: true,
    prevSignals: new Map(),
    prevSignalStaleIds: new Set(),
    mintBurnMap: new Map(),
    mintBurnAgeSecById: new Map(),
    mintBurnStaleIds: new Set(),
    yieldWarnings: new Map(),
    yieldSourceRisk: new Map(),
    yieldRankChangeAttribution: new Map(),
    latestPsiScore: null,
    sourceCoverage: {},
    dependencyDiagnostics: {
      dexLiquidity: {
        totalRows: 0,
        freshRows: 0,
        staleRows: 0,
        freshnessAgeSec: null,
        staleThresholdSec: 7200,
        latestGenerationId: null,
        latestGenerationState: null,
        latestGenerationStartedAt: null,
        latestGenerationPublishedAt: null,
        latestGenerationFailedAt: null,
        latestGenerationFailureReason: null,
        latestPublishedGenerationId: null,
        latestPublishedAt: null,
        latestPublishedAgeSec: null,
      },
    },
  };
}

describe("buildDewsScoringResult blacklist attribution", () => {
  it("applies blacklist counts only to the tracker stablecoin id for same-symbol assets", () => {
    const result = buildDewsScoringResult({
      assetById: new Map([
        ["usda-avalon", createAsset("usda-avalon")],
        ["usda-anzens", createAsset("usda-anzens")],
      ]),
      pegRates: {},
      sourceState: createSourceState(),
      registerMalformedPersistedInput: () => {},
    });

    const avalon = result.results.find((row) => row.stablecoinId === "usda-avalon");
    const anzens = result.results.find((row) => row.stablecoinId === "usda-anzens");

    expect(avalon?.signals.black).toMatchObject({
      available: true,
      events24h: 10,
      events7d: 10,
    });
    expect(anzens?.signals.black).toMatchObject({
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

    const assetById = new Map([["usda-avalon", createAsset("usda-avalon")]]);
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
