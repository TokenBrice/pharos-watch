import type {
  PegSummaryCoin,
  PegSummaryResponse,
  ReportCard,
  ReportCardsResponse,
  StablecoinData,
  StablecoinListResponse,
  StablecoinMeta,
  StabilityIndexResponse,
  StressSignalsAllResponse,
} from "@shared/types";
import type { ChainsResponse, ChainSummary } from "@shared/types/chains";
import { CHAIN_META } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

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

const DENSE_CHAIN_IDS = [
  "ethereum",
  "base",
  "arbitrum",
  "polygon",
  "bsc",
  "tron",
  "solana",
  "aptos",
  "avalanche",
  "optimism",
] as const;

const DENSE_FIXTURE_ASSET_COUNT = 132;

function firstActiveMetaFor(description: string, predicate: (meta: StablecoinMeta) => boolean): StablecoinMeta {
  const meta = ACTIVE_STABLECOINS.find(predicate);
  if (!meta) throw new Error(`Dense PharosVille fixture missing ${description}`);
  return meta;
}

function uniqueMetas(metas: readonly StablecoinMeta[]): StablecoinMeta[] {
  const seen = new Set<string>();
  return metas.filter((meta) => {
    if (seen.has(meta.id)) return false;
    seen.add(meta.id);
    return true;
  });
}

const denseFixtureMetas = uniqueMetas([
  firstActiveMetaFor("centralized issuer", (meta) => meta.flags.governance === "centralized"),
  firstActiveMetaFor("centralized-dependent issuer", (meta) => meta.flags.governance === "centralized-dependent"),
  firstActiveMetaFor("decentralized issuer", (meta) => meta.flags.governance === "decentralized"),
  firstActiveMetaFor("crypto-backed centralized issuer", (meta) => (
    meta.flags.governance === "centralized" && meta.flags.backing === "crypto-backed"
  )),
  firstActiveMetaFor("yield or NAV overlay", (meta) => meta.flags.yieldBearing || meta.flags.navToken),
  ...ACTIVE_STABLECOINS,
]).slice(0, DENSE_FIXTURE_ASSET_COUNT);

function denseSupplyUsd(index: number): number {
  if (index === 0) return 18_000_000_000;
  if (index === 1) return 12_000_000_000;
  if (index < 10) return 4_000_000_000 - index * 120_000_000;
  if (index < 34) return 950_000_000 - index * 18_000_000;
  if (index < 88) return 140_000_000 - index * 900_000;
  return Math.max(1_200_000, 18_000_000 - (index - 88) * 360_000);
}

function denseChainShare(index: number, position: number): number {
  if (position === 0) return 0.68;
  if (position === 1) return index % 4 === 0 ? 0.22 : 0.2;
  return index % 5 === 0 ? 0.12 : 0;
}

function denseChainCirculating(index: number, supplyUsd: number): StablecoinData["chainCirculating"] {
  const chainCount = index % 5 === 0 ? 3 : index % 2 === 0 ? 2 : 1;
  const entries = DENSE_CHAIN_IDS.slice(0, chainCount).map((_, position) => {
    const chainId = DENSE_CHAIN_IDS[(index + position * 3) % DENSE_CHAIN_IDS.length] ?? "ethereum";
    const current = Math.round(supplyUsd * denseChainShare(index, position));
    return [chainId, {
      current,
      circulatingPrevDay: Math.round(current * (0.997 + (index % 7) * 0.001)),
      circulatingPrevWeek: Math.round(current * (0.986 + (index % 5) * 0.002)),
      circulatingPrevMonth: Math.round(current * (0.964 + (index % 9) * 0.002)),
    }];
  }).filter(([, point]) => (point as { current: number }).current > 0);

  return Object.fromEntries(entries) as StablecoinData["chainCirculating"];
}

function denseBandForIndex(index: number): "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER" {
  if (index % 29 === 0) return "DANGER";
  if (index % 19 === 0) return "WARNING";
  if (index % 13 === 0) return "ALERT";
  if (index % 5 === 0) return "WATCH";
  return "CALM";
}

function denseAsset(meta: StablecoinMeta, index: number): StablecoinData {
  const supply = denseSupplyUsd(index);
  const chainCirculating = denseChainCirculating(index, supply);
  const chainIds = Object.keys(chainCirculating ?? {});
  return makeAsset({
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    pegMechanism: meta.pegMechanism ?? (meta.flags.backing === "rwa-backed" ? "fiat-backed" : "crypto-backed"),
    circulating: { peggedUSD: supply },
    circulatingPrevDay: { peggedUSD: Math.round(supply * 0.998) },
    circulatingPrevWeek: { peggedUSD: Math.round(supply * 0.982) },
    circulatingPrevMonth: { peggedUSD: Math.round(supply * 0.955) },
    chainCirculating,
    chains: chainIds.map((chainId) => CHAIN_META[chainId]?.name ?? chainId),
  });
}

const denseFixtureAssets = denseFixtureMetas.map(denseAsset);

function denseChainTotal(chainId: string): number {
  return denseFixtureAssets.reduce((sum, asset) => {
    const point = asset.chainCirculating?.[chainId];
    return sum + (point?.current ?? 0);
  }, 0);
}

function denseChainTopStablecoins(chainId: string): NonNullable<ChainSummary["topStablecoins"]> {
  const totalUsd = denseChainTotal(chainId);
  return denseFixtureAssets
    .map((asset) => ({
      id: asset.id,
      symbol: asset.symbol,
      supplyUsd: asset.chainCirculating?.[chainId]?.current ?? 0,
    }))
    .filter((entry) => entry.supplyUsd > 0)
    .sort((first, second) => second.supplyUsd - first.supplyUsd)
    .slice(0, 5)
    .map((entry) => ({
      ...entry,
      share: totalUsd > 0 ? entry.supplyUsd / totalUsd : 0,
    }));
}

function denseChain(chainId: string, index: number, globalTotalUsd: number): ChainSummary {
  const totalUsd = denseChainTotal(chainId);
  const topStablecoins = denseChainTopStablecoins(chainId);
  const dominant = topStablecoins[0] ?? { id: "usdc-circle", symbol: "USDC", share: 1, supplyUsd: totalUsd };
  const meta = CHAIN_META[chainId];
  const healthBands: Array<NonNullable<ChainSummary["healthBand"]>> = ["robust", "healthy", "mixed", "fragile", "concentrated"];
  return makeChain({
    id: chainId,
    name: meta?.name ?? chainId,
    logoPath: meta?.logoPath ?? "",
    type: meta?.type ?? "other",
    totalUsd,
    stablecoinCount: topStablecoins.length,
    dominantStablecoin: { id: dominant.id, symbol: dominant.symbol, share: dominant.share },
    dominanceShare: dominant.share,
    topStablecoins,
    healthScore: Math.max(38, 94 - index * 5),
    healthBand: healthBands[index % healthBands.length],
    healthFactors: {
      concentration: globalTotalUsd > 0 ? Math.min(0.95, totalUsd / globalTotalUsd + 0.08) : 0.4,
      quality: 0.9 - index * 0.035,
      pegStability: 0.88 - index * 0.02,
      backingDiversity: 0.78 - index * 0.025,
      chainEnvironment: 0.86 - index * 0.03,
    },
  });
}

const denseGlobalTotalUsd = DENSE_CHAIN_IDS.reduce((sum, chainId) => sum + denseChainTotal(chainId), 0);

export const denseFixtureStablecoins: StablecoinListResponse = {
  peggedAssets: denseFixtureAssets,
};

export const denseFixtureChains: ChainsResponse = {
  chains: DENSE_CHAIN_IDS.map((chainId, index) => denseChain(chainId, index, denseGlobalTotalUsd)),
  globalTotalUsd: denseGlobalTotalUsd,
  chainAttributedTotalUsd: denseGlobalTotalUsd,
  unattributedTotalUsd: 0,
  globalChange24hPct: -0.7,
  globalChange7dPct: 1.8,
  globalChange30dPct: 4.2,
  updatedAt: 1_700_000_000,
  healthMethodologyVersion: "fixture",
};

export const denseFixturePegSummary = {
  ...fixturePegSummary,
  coins: denseFixtureMetas.map((meta, index) => {
    const band = denseBandForIndex(index);
    const deviation = band === "DANGER" ? 780 : band === "WARNING" ? 320 : band === "ALERT" ? 115 : band === "WATCH" ? 38 : 0;
    return makePegCoin({
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      governance: meta.flags.governance,
      currentDeviationBps: deviation,
      pegScore: Math.max(8, 100 - deviation / 8),
      severityScore: Math.min(100, Math.round(deviation / 8)),
      activeDepeg: band === "DANGER" || band === "WARNING",
      eventCount: band === "CALM" ? 0 : 1 + (index % 3),
      worstDeviationBps: deviation,
      lastEventAt: band === "CALM" ? null : 1_700_000_000 - index * 60,
    });
  }),
} satisfies PegSummaryResponse;

export const denseFixtureStress = {
  ...fixtureStress,
  signals: Object.fromEntries(denseFixtureMetas.map((meta, index) => {
    const band = denseBandForIndex(index);
    const score = band === "DANGER" ? 96 : band === "WARNING" ? 78 : band === "ALERT" ? 58 : band === "WATCH" ? 31 : 8;
    return [meta.id, {
      band,
      score,
      signals: {
        peg: { available: true, value: score },
      },
      computedAt: 1_700_000_000,
      methodologyVersion: "fixture",
    }];
  })),
  updatedAt: 1_700_000_000,
} satisfies StressSignalsAllResponse;

export const denseFixtureReportCards: ReportCardsResponse = {
  ...fixtureReportCards,
  cards: denseFixtureMetas.map((meta, index) => {
    const band = denseBandForIndex(index);
    const grade = band === "DANGER" ? "D" : band === "WARNING" ? "C" : band === "ALERT" ? "B" : "A";
    return makeReportCard({
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      overallGrade: grade,
      overallScore: grade === "D" ? 48 : grade === "C" ? 66 : grade === "B" ? 78 : 91,
      rawInputs: {
        ...makeReportCard({ id: meta.id, symbol: meta.symbol }).rawInputs,
        activeDepeg: band === "DANGER" || band === "WARNING",
        activeDepegBps: band === "DANGER" ? 780 : band === "WARNING" ? 320 : null,
        pegScore: band === "DANGER" ? 18 : band === "WARNING" ? 48 : band === "ALERT" ? 74 : 98,
        depegEventCount: band === "CALM" ? 0 : 1,
        chainTier: index % 3 === 0 ? "stage1-l2" : "ethereum",
        deploymentModel: index % 4 === 0 ? "third-party-bridge" : "native-multichain",
        collateralQuality: meta.flags.backing === "rwa-backed" ? "rwa" : "native",
        custodyModel: meta.flags.governance === "centralized" ? "institutional-regulated" : "onchain",
        governanceTier: meta.flags.governance,
        governanceQuality: meta.governanceQuality ?? (meta.flags.governance === "decentralized" ? "dao-governance" : "single-entity"),
        navToken: meta.flags.navToken,
      },
    });
  }),
  updatedAt: 1_700_000_000,
} as ReportCardsResponse;
