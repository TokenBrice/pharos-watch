import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { recoverBreakerOnNoCandidate, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import {
  buildPrimaryPricePlan,
  collectPrimaryProviderQuotes,
  type PrimaryPricePlan,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset } from "../enrich-prices-shared";

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => false),
  recordOutcome: vi.fn(async () => {}),
  recordOutcomeDecision: vi.fn(async () => {}),
  recoverBreakerOnNoCandidate: vi.fn(async () => {}),
}));

vi.mock("../../../lib/depeg-helpers", () => ({
  createDexPriceSourceLoadTelemetry: vi.fn(() => ({
    staleRows: [],
    malformedRows: [],
  })),
  loadDexPriceRows: vi.fn(async () => new Map()),
  loadDexPriceSources: vi.fn(async () => new Map()),
}));

const TEST_ASSET: PeggedAsset = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  geckoId: "test-usd",
  pegType: "peggedUSD",
};

describe("buildPrimaryPricePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log all primary circuits open while the CG ticker circuit can still fetch", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_TICKER);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plan = await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(plan.sourceAllowed.cgTicker).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only",
    );
  });

  it("logs all primary circuits open when every live provider circuit is blocked", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only"),
    );
  });
});

describe("collectPrimaryProviderQuotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers stale circuit breakers for every disabled address price provider", async () => {
    const plan: PrimaryPricePlan = {
      candidates: [TEST_ASSET],
      nowSec: 1_700_000_000,
      dexRows: new Map(),
      dexPriceSources: new Map(),
      dexPriceSourceTelemetry: {
        staleRows: [],
        malformedRows: [],
      },
      geckoIds: [],
      pythFeedIds: new Map(),
      coinbaseSymbols: [],
      krakenSymbols: [],
      shouldFetchBitstamp: false,
      redstoneSymbols: [],
      navPriceIds: [],
      addressProviders: [],
      addressProviderTargets: new Map(),
      sourceAllowed: {
        cg: false,
        cgTicker: false,
        pyth: false,
        binance: false,
        kraken: false,
        bitstamp: false,
        coinbase: false,
        redstone: false,
        curve: false,
        curveOracle: false,
        addressProviders: {
          "dexscreener-address": false,
          "dexpaprika-address": false,
          "coingecko-onchain-address": false,
          "alchemy-address": false,
          "moralis-address": false,
          "birdeye-address": false,
        },
      },
    };

    await collectPrimaryProviderQuotes({ plan, db: {} as D1Database });

    expect(recoverBreakerOnNoCandidate).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DEXSCREENER_ADDRESS_PRICES,
    );
    expect(recoverBreakerOnNoCandidate).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DEXPAPRIKA_PRICES,
    );
    expect(recoverBreakerOnNoCandidate).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.CG_ONCHAIN);
    expect(recoverBreakerOnNoCandidate).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.ALCHEMY_PRICES);
    expect(recoverBreakerOnNoCandidate).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.MORALIS_PRICES);
    expect(recoverBreakerOnNoCandidate).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.BIRDEYE_PRICES);
  });
});
