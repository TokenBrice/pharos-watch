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
  isReasonablePrice,
  hasMissingPrice,
  PRICE_BOUNDS,
  enrichMissingPrices,
  fetchPrimaryPrices,
  applyResolvedPrice,
  applyPoolChallenge,
} from "../sync-stablecoins/enrich-prices";
import { applyListAggregatorDowngrade } from "../sync-stablecoins/enrich-prices-primary";
import type { PeggedAsset, PrimaryPriceResult, PriceValidationStats } from "../sync-stablecoins/enrich-prices";
import {
  runCmcPass,
  runDexScreenerPass,
  runDlContractPasses,
  runJupiterPass,
} from "../sync-stablecoins/enrich-prices-passes";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import type { PriceValidationContext, PriceValidationReferences } from "../../lib/price-validation";

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
const fixturePRICE_BOUNDS = PRICE_BOUNDS;
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
  fixturePRICE_BOUNDS,
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
};
