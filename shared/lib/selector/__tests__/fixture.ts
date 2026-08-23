/**
 * Synthetic fixture loader. Hand-written `MergedRow` array used by every
 * engine test. The shape is kept deliberately small (~20 coins) so tests
 * stay fast and the fixture diff is human-readable.
 */
import fixtureJson from "../__fixtures__/active-universe.json";
import type {
  DatasetMetadata,
  MergedRow,
  SelectorData,
  SelectorInput,
} from "../types";
import { SELECTOR_VERSION } from "../version";

export const FIXTURE_ROWS = fixtureJson as unknown as MergedRow[];

export function buildFixtureData(): SelectorData {
  const rows = new Map<string, MergedRow>();
  for (const row of FIXTURE_ROWS) {
    rows.set(row.id, row);
  }
  return { rows };
}

export const FIXTURE_DATASET: DatasetMetadata = {
  timestamp: 1_700_000_000_000,
  datasetHash: "test-dataset-hash",
  methodologyVersions: {
    safetyScore: "safety-v1.0",
    pegScoreAndDews: "peg-dews-v1.0",
    yieldIntelligence: "yield-v1.0",
    bluechipAlignment: "bluechip-v1.0",
    exclusionFilters: SELECTOR_VERSION,
  },
};

export function makeInput(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    profile: "treasury",
    pegCurrency: "USD",
    horizon: "1to6m",
    depegTolerance: "tight",
    composability: "moderate",
    exitSpeed: "any",
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any",
    custodyOk: "any",
    ...overrides,
  };
}

export function makeMergedRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return {
    id: "selector-row",
    symbol: "ROW",
    name: "Selector Row",
    protocolSlug: null,
    variantOf: null,
    isYieldBearing: false,
    pegCurrency: "USD",
    lifecycle: "active",
    governance: "decentralized",
    canBeBlacklisted: false,
    mechanismArchetype: null,
    supplyUsd: 1_000_000_000,
    pegScore: 90,
    activeDepeg: false,
    currentDeviationBps: 10,
    depegEventCount: 0,
    lastEventAt: null,
    dewsScore: 20,
    safetyGrade: "A",
    safetyScore: 80,
    safetyProvenance: "safety-score-v9",
    safetyResilienceScore: 80,
    safetyDecentralizationScore: 80,
    safetyLiquidityScore: 80,
    custodyModel: "onchain",
    bluechipGrade: "A",
    liquidityScore: 80,
    effectiveTvlUsd: 50_000_000,
    concentrationHhi: 0.2,
    chainTvl: { ethereum: 100_000_000 },
    pharosYieldScore: 80,
    apy30d: 5,
    apyVariance30d: 0.5,
    benchmarkRate: 4.5,
    sourceRiskScore: 20,
    venueRiskTier: "low",
    warningSignals: [],
    deploymentPlace: "native-wrapper",
    sourceSwitch: false,
    yieldProtocolSlug: null,
    yieldVenueChain: null,
    yieldHistoryDays: 365,
    yieldFreshness: null,
    trackingSpanDays: 365,
    isRecentListing: false,
    pegSummaryAgeSec: null,
    dexTvlAgeSec: null,
    dewsAgeSec: null,
    ...overrides,
  };
}
