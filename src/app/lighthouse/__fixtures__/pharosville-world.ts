import type {
  PegSummaryCoin,
  PegSummaryResponse,
  ReportCard,
  ReportCardsResponse,
  StablecoinData,
  StablecoinListResponse,
  StabilityIndexResponse,
  StressSignalsAllResponse,
} from "@shared/types";
import type { ChainsResponse, ChainSummary } from "@shared/types/chains";

const methodology = {
  version: "fixture",
  versionLabel: "Fixture",
  currentVersion: "fixture",
  currentVersionLabel: "Fixture",
  changelogPath: "/methodology/",
  asOf: 1_700_000_000,
  isCurrent: true,
};

export function makeAsset(overrides: Partial<StablecoinData> & { id: string; symbol: string; name?: string }): StablecoinData {
  const { id, symbol, name, ...rest } = overrides;
  const current = overrides.circulating ?? { peggedUSD: 1_000_000_000 };
  return {
    id,
    name: name ?? symbol,
    symbol,
    gecko_id: null,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    priceSource: "fixture",
    price: 1,
    priceConfidence: "high",
    priceUpdatedAt: 1_700_000_000,
    priceObservedAt: 1_700_000_000,
    priceObservedAtMode: "upstream",
    priceSyncedAt: 1_700_000_000,
    consensusSources: [],
    agreeSources: [],
    supplySource: "defillama",
    circulating: current,
    circulatingPrevDay: current,
    circulatingPrevWeek: current,
    circulatingPrevMonth: current,
    chainCirculating: {
      Ethereum: {
        current: 1_000_000_000,
        circulatingPrevDay: 1_000_000_000,
        circulatingPrevWeek: 1_000_000_000,
        circulatingPrevMonth: 1_000_000_000,
      },
    },
    chains: ["Ethereum"],
    ...rest,
  } as StablecoinData;
}

export function makePegCoin(overrides: Partial<PegSummaryCoin> & { id: string; symbol: string }): PegSummaryCoin {
  const { id, symbol, ...rest } = overrides;
  return {
    id,
    symbol,
    name: symbol,
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 100,
    priceConfidence: "high",
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: 0,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 365,
    methodologyVersion: "fixture",
    ...rest,
  } as PegSummaryCoin;
}

export function makeChain(overrides: Partial<ChainSummary> & { id: string; name?: string }): ChainSummary {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name: name ?? id,
    logoPath: "",
    type: "evm",
    totalUsd: 1_000_000_000,
    change24h: 0,
    change24hPct: 0,
    change7d: 0,
    change7dPct: 0,
    change30d: 0,
    change30dPct: 0,
    stablecoinCount: 1,
    dominantStablecoin: { id: "usdc-circle", symbol: "USDC", share: 1 },
    dominanceShare: 0.5,
    healthScore: 90,
    healthBand: "healthy",
    healthFactors: {
      concentration: 0.4,
      quality: 0.9,
      pegStability: 0.9,
      backingDiversity: 0.7,
      chainEnvironment: 0.8,
    },
    ...rest,
  };
}

export function makeReportCard(overrides: Partial<ReportCard> & { id: string; symbol: string }): ReportCard {
  const { id, symbol, ...rest } = overrides;
  return {
    id,
    name: symbol,
    symbol,
    overallGrade: "A",
    overallScore: 90,
    baseScore: 90,
    dimensions: {
      pegStability: { grade: "A", score: 95, detail: "fixture" },
      liquidity: { grade: "A", score: 90, detail: "fixture" },
      resilience: { grade: "A", score: 90, detail: "fixture" },
      decentralization: { grade: "B", score: 80, detail: "fixture" },
      dependencyRisk: { grade: "A", score: 90, detail: "fixture" },
    },
    ratedDimensions: 5,
    rawInputs: {
      pegScore: 100,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 90,
      effectiveExitScore: 90,
      redemptionBackstopScore: 90,
      redemptionRouteFamily: "offchain-issuer",
      redemptionModelConfidence: "high",
      redemptionUsedForLiquidity: true,
      redemptionImmediateCapacityUsd: 1_000_000_000,
      redemptionImmediateCapacityRatio: 1,
      concentrationHhi: 0.2,
      bluechipGrade: "A",
      canBeBlacklisted: false,
      chainTier: "ethereum",
      deploymentModel: "native-multichain",
      collateralQuality: "rwa",
      custodyModel: "institutional-regulated",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      variantParentId: null,
      variantKind: null,
      navToken: false,
    },
    isDefunct: false,
    ...rest,
  } as ReportCard;
}

export const fixtureStablecoins: StablecoinListResponse = {
  peggedAssets: [
    makeAsset({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }),
    makeAsset({ id: "usdt-tether", symbol: "USDT", name: "Tether", circulating: { peggedUSD: 10_000_000_000 } }),
  ],
};

export const fixtureChains: ChainsResponse = {
  chains: [
    makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 8_000_000_000, stablecoinCount: 2 }),
    makeChain({ id: "tron", name: "TRON", totalUsd: 3_000_000_000, stablecoinCount: 1 }),
  ],
  globalTotalUsd: 11_000_000_000,
  chainAttributedTotalUsd: 11_000_000_000,
  unattributedTotalUsd: 0,
  globalChange24hPct: 0,
  globalChange7dPct: 0,
  globalChange30dPct: 0,
  updatedAt: 1_700_000_000,
  healthMethodologyVersion: "fixture",
};

export const fixtureStability = {
  current: {
    score: 12,
    band: "STEADY",
    components: { severity: 0, breadth: 0, trend: 0 },
    computedAt: 1_700_000_000,
    methodologyVersion: "fixture",
  },
  history: [],
  methodology,
} satisfies StabilityIndexResponse;

export const fixturePegSummary = {
  coins: [
    makePegCoin({ id: "usdc-circle", symbol: "USDC" }),
    makePegCoin({ id: "usdt-tether", symbol: "USDT" }),
  ],
  summary: null,
  methodology,
} satisfies PegSummaryResponse;

export const fixtureStress = {
  signals: {},
  updatedAt: 1_700_000_000,
  methodology,
} satisfies StressSignalsAllResponse;

export const fixtureReportCards: ReportCardsResponse = {
  cards: [
    makeReportCard({ id: "usdc-circle", symbol: "USDC" }),
    makeReportCard({ id: "usdt-tether", symbol: "USDT" }),
  ],
  methodology: {
    version: "fixture",
    weights: { pegStability: 1, liquidity: 1, resilience: 1, decentralization: 1, dependencyRisk: 1 },
    pegMultiplierExponent: 1,
    thresholds: [],
  },
  dependencyGraph: { edges: [] },
  updatedAt: 1_700_000_000,
} as ReportCardsResponse;
