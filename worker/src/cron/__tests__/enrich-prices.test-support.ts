import { vi } from "vitest";
vi.mock("../../lib/abort", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/abort")>();
  return {
    ...actual,
    sleepWithSignal: vi.fn(async (_ms: number, signal?: AbortSignal) => {
      actual.throwIfAborted(signal);
    }),
  };
});

import {
  hasMissingPrice,
  enrichMissingPrices,
  fetchPrimaryPrices,
  applyResolvedPrice,
} from "../sync-stablecoins/enrich-prices";
import { PEG_HARDCODED_PRICE_BOUNDS } from "@shared/lib/peg-taxonomy";
import {
  applyListAggregatorDowngrade,
  applyPoolChallenge,
} from "../sync-stablecoins/enrich-prices-primary-hardening";
import type { PeggedAsset, PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import type { PriceValidationStats } from "../sync-stablecoins/enrich-prices-shared";
import { runCmcPass } from "../sync-stablecoins/enrich-prices-cmc-pass";
import { runDexScreenerPass } from "../sync-stablecoins/enrich-prices-dexscreener-pass";
import { runDlContractPasses } from "../sync-stablecoins/enrich-prices-defillama-pass";
import { runJupiterPass } from "../sync-stablecoins/enrich-prices-jupiter-pass";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { isReasonablePrice, type PriceValidationContext, type PriceValidationReferences } from "../../lib/price-validation";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";

const freshObservedAtSec = () => Math.floor(Date.now() / 1000) - 60;
const staleObservedAtSec = () => Math.floor(Date.now() / 1000) - 2 * 3600;
const freshIsoTimestamp = () => new Date(freshObservedAtSec() * 1000).toISOString();
const staleIsoTimestamp = () => new Date(staleObservedAtSec() * 1000).toISOString();
const maturePairCreatedAt = () => Date.now() - 2 * 24 * 60 * 60 * 1000;

function dlQuote(
  price: number,
  symbol: string,
  overrides: Partial<{ timestamp: number; confidence: number; symbol: string }> = {},
) {
  return {
    price,
    symbol,
    timestamp: freshObservedAtSec(),
    confidence: 0.99,
    ...overrides,
  };
}

function cmcUsdQuote(price: number, lastUpdated = freshIsoTimestamp()) {
  return { price, last_updated: lastUpdated };
}

function cmcCategory(coins: unknown[], numTokens = coins.length) {
  return {
    data: {
      num_tokens: numTokens,
      coins,
    },
  };
}

function solanaSlotResponse(slot: number) {
  return { jsonrpc: "2.0", result: slot, id: 1 };
}
function cleanupEnrichMissingPricesTest() {
  vi.unstubAllGlobals();
}

const fixtureIsReasonablePrice = isReasonablePrice;
const fixtureHasMissingPrice = hasMissingPrice;
const fixturePEG_HARDCODED_PRICE_BOUNDS = PEG_HARDCODED_PRICE_BOUNDS;
const fixtureEnrichMissingPrices = enrichMissingPrices;
const fixtureFetchPrimaryPrices = fetchPrimaryPrices;
const fixtureApplyResolvedPrice = applyResolvedPrice;
const fixtureApplyPoolChallenge = applyPoolChallenge;
const fixtureApplyListAggregatorDowngrade = applyListAggregatorDowngrade;
const fixtureRunCmcPass = runCmcPass;
const fixtureRunDexScreenerPass = runDexScreenerPass;
const fixtureRunDlContractPasses = runDlContractPasses;
const fixtureRunJupiterPass = runJupiterPass;
const fixtureMockD1 = mockD1;
const fixtureMockFetch = mockFetch;
const fixtureCIRCUIT_SOURCE = CIRCUIT_SOURCE;

function installFetch(implementation: (url: string) => Response | Promise<Response>) {
  return fixtureMockFetch([{ match: () => true, respond: (request) => implementation(request.url) }]);
}

function makeFixtureMockD1(
  tables: Parameters<typeof mockD1>[0] = [],
  options?: Parameters<typeof mockD1>[1],
) {
  return fixtureMockD1(
    [
      ...tables,
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ],
    options,
  );
}

type PoolObservation = {
  price: number;
  tvlUsd: number;
  protocol: string;
  chain: string;
  observedAt?: number;
};

function makePrimaryPriceResult(overrides: Partial<PrimaryPriceResult> = {}): PrimaryPriceResult {
  return {
    price: 1,
    source: "test-source",
    confidence: "high",
    dlPrice: null,
    cgPrice: null,
    candidateSources: ["test-source"],
    agreeSources: ["test-source"],
    ...overrides,
  };
}

function makePrimaryPriceResults(
  assetId: string,
  overrides: Partial<PrimaryPriceResult> = {},
): Map<string, PrimaryPriceResult> {
  return new Map([[assetId, makePrimaryPriceResult(overrides)]]);
}

function makePriceConsensusResult(overrides: Partial<PrimaryPriceResult> = {}): PrimaryPriceResult {
  return makePrimaryPriceResult({
    price: 1,
    source: "coingecko+defillama-list",
    confidence: "high",
    dlPrice: 1,
    cgPrice: 1,
    candidateSources: ["coingecko", "defillama-list"],
    agreeSources: ["coingecko", "defillama-list"],
    ...overrides,
  });
}

function makePoolObservation(overrides: Partial<PoolObservation> = {}): PoolObservation {
  return {
    price: 1,
    tvlUsd: 500_000,
    protocol: "curve",
    chain: "ethereum",
    ...overrides,
  };
}

function makePoolChallengeInputs({
  assetId,
  pegType = "peggedUSD",
  result = {},
  pools = [],
  stats = {},
}: {
  assetId: string;
  pegType?: string;
  result?: Partial<PrimaryPriceResult>;
  pools?: Array<Partial<PoolObservation>>;
  stats?: Partial<PriceValidationStats>;
}): {
  results: Map<string, PrimaryPriceResult>;
  pools: Map<string, PoolObservation[]>;
  pegTypes: Map<string, string | undefined>;
  stats: PriceValidationStats;
} {
  return {
    results: new Map([[assetId, makePrimaryPriceResult(result)]]),
    pools: new Map([[assetId, pools.map((pool) => makePoolObservation(pool))]]),
    pegTypes: new Map([[assetId, pegType]]),
    stats: {
      attempted: 1,
      high: 1,
      singleSource: 0,
      cgOnly: 0,
      low: 0,
      ...stats,
    },
  };
}

function makePriceValidationStats(overrides: Partial<PriceValidationStats> = {}): PriceValidationStats {
  return {
    attempted: 1,
    high: 1,
    singleSource: 0,
    cgOnly: 0,
    low: 0,
    ...overrides,
  };
}

type PrimaryPricingDbOptions = {
  dexRows?: MockTableConfig["rows"];
  poolSources?: MockTableConfig["rows"];
  reserveRows?: MockTableConfig["rows"];
  extraTables?: MockTableConfig[];
};

function makePrimaryPricingDb(options: PrimaryPricingDbOptions | MockTableConfig[] = {}) {
  const {
    dexRows,
    poolSources,
    reserveRows,
    extraTables = [],
  } = Array.isArray(options) ? { extraTables: options } : options;
  return fixtureMockD1([
    ...extraTables,
    { match: "circuit", rows: [] },
    ...(dexRows ? [{ match: "dex_price_usd", rows: dexRows }] : []),
    ...(poolSources ? [{ match: "price_sources_json", rows: poolSources }] : []),
    ...(reserveRows ? [{ match: "FROM reserve_composition c", rows: reserveRows }] : []),
    { match: "FROM dex_prices", rows: [] },
    { match: "FROM dex_price_challenger_snapshots", rows: [] },
    { match: "FROM dex_price_challengers", rows: [] },
    { match: "FROM dex_liquidity", rows: [] },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
  ]);
}

export type PrimaryPriceRouteValue =
  | Response
  | { body: unknown; status?: number; headers?: Record<string, string> }
  | ((url: string) => Response | { body: unknown; status?: number; headers?: Record<string, string> });

function installPrimaryPriceRoutes(
  routesOrImplementation:
    | ((url: string) => Response | Promise<Response>)
    | Readonly<Record<string, PrimaryPriceRouteValue>>,
) {
  if (typeof routesOrImplementation === "function") {
    return fixtureMockFetch([{ match: () => true, respond: (request) => routesOrImplementation(request.url) }]);
  }
  return fixtureMockFetch(Object.entries(routesOrImplementation).map(([match, value]) => ({
    match,
    ...(typeof value === "function"
      ? { respond: (request: Request) => value(request.url) }
      : value instanceof Response
        ? { respond: () => value.clone() }
        : value),
  })));
}

export {
  freshObservedAtSec,
  staleObservedAtSec,
  freshIsoTimestamp,
  staleIsoTimestamp,
  maturePairCreatedAt,
  dlQuote,
  cmcUsdQuote,
  cmcCategory,
  solanaSlotResponse,
  cleanupEnrichMissingPricesTest,
  type PeggedAsset,
  type PrimaryPriceResult,
  type PriceValidationStats,
  type PriceValidationContext,
  type PriceValidationReferences,
  fixtureIsReasonablePrice,
  fixtureHasMissingPrice,
  fixturePEG_HARDCODED_PRICE_BOUNDS,
  fixtureEnrichMissingPrices,
  fixtureFetchPrimaryPrices,
  fixtureApplyResolvedPrice,
  fixtureApplyPoolChallenge,
  fixtureApplyListAggregatorDowngrade,
  fixtureRunCmcPass,
  fixtureRunDexScreenerPass,
  fixtureRunDlContractPasses,
  fixtureRunJupiterPass,
  fixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  installFetch,
  makeFixtureMockD1,
  makePrimaryPriceResult,
  makePrimaryPriceResults,
  makePriceConsensusResult,
  makePoolObservation,
  makePoolChallengeInputs,
  makePriceValidationStats,
  makePrimaryPricingDb,
  installPrimaryPriceRoutes,
  type PoolObservation,
  type PrimaryPricingDbOptions,
};
