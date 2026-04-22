import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { PriceObservedAtMode } from "@shared/types/core";
import { CIRCUIT_SOURCE, CURVE_ORACLE_MAX_STALENESS_SEC } from "../../lib/constants";
import { CG_TICKER_COINS, fetchCgTickerPricesDetailed } from "../../lib/cg-ticker";
import { fetchCoingeckoSimplePrices } from "../../lib/coingecko-simple-price";
import { shouldAttemptFetch, recordOutcome, recoverBreakerOnNoCandidate } from "../../lib/circuit-breaker";
import { throwIfAborted } from "../../lib/abort";
import { fetchPythPrices } from "../../lib/pyth";
import {
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePricesDetailed,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
} from "../../lib/cex-tickers";
import { isSuccessfulOutcome } from "../../lib/fetcher-result";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { fetchRedstonePrices, REDSTONE_TRACKED_SYMBOL_ALLOWLIST } from "../../lib/redstone";
import { loadDexPriceRows, loadDexPriceSources } from "../../lib/depeg-helpers";
import { fetchCurveOnchainPrices, fetchCurveOracleEma } from "../../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "../../lib/curve-pool-configs";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { DlListQuote } from "../../lib/primary-price-collector";
import type { PeggedAsset } from "./enrich-prices-shared";
import { isUsableGeckoId } from "./enrich-prices-primary-shared";

// crvUSD PriceAggregator contract. Consulted as a regular primary-consensus
// source by the Curve oracle fetch path; kept local because the caller is
// the only remaining consumer of these hex constants.
const CRVUSD_PRICE_AGGREGATOR = "0xe5Afcf332a5457E8FafCD668BcE3dF953762Dfe7";
const CRVUSD_PRICE_SELECTOR = "0xa035b1fe"; // price() — returns crvUSD price in USD scaled by 1e18

export type PrimaryDexRows = Awaited<ReturnType<typeof loadDexPriceRows>>;
export type PrimaryDexPriceSources = Awaited<ReturnType<typeof loadDexPriceSources>>;

export interface PrimaryPricePlan {
  candidates: PeggedAsset[];
  nowSec: number;
  dexRows: PrimaryDexRows;
  dexPriceSources: PrimaryDexPriceSources;
  geckoIds: string[];
  pythFeedIds: Map<string, string>;
  coinbaseSymbols: string[];
  krakenSymbols: string[];
  shouldFetchBitstamp: boolean;
  redstoneSymbols: string[];
  sourceAllowed: {
    cg: boolean;
    cgTicker: boolean;
    pyth: boolean;
    binance: boolean;
    kraken: boolean;
    bitstamp: boolean;
    coinbase: boolean;
    redstone: boolean;
    curve: boolean;
    curveOracle: boolean;
  };
}

export interface PrimaryConsensusQuoteMaps {
  cgPrices: Map<string, number>;
  cgObservedAtByGeckoId: Map<string, number>;
  cgObservedAtModeByGeckoId: Map<string, PriceObservedAtMode>;
  cgObservedAt: number | null;
  cgTickerPrices: Map<string, number>;
  cgTickerObservedAt: number | null;
  pythPrices: Map<string, { price: number; confidenceBps: number; publishTime: number }>;
  binancePrices: Map<string, number>;
  binanceObservedAt: number | null;
  krakenPrices: Map<string, number>;
  krakenObservedAt: number | null;
  bitstampPrices: Map<string, number>;
  bitstampObservedAtBySymbol: Map<string, number>;
  coinbasePrices: Map<string, number>;
  coinbaseObservedAtBySymbol: Map<string, number>;
  redstonePrices: Map<string, { price: number; venueCount: number; venueAgreementPct: number; timestamp: number }>;
  curvePrices: Map<string, number>;
  curveObservedAtByCoinId: Map<string, number>;
  curveOraclePrice: number | null;
  curveOracleObservedAt: number | null;
}

async function runPrimaryProviderFetch(
  db: D1Database,
  signal: AbortSignal | undefined,
  source: string,
  label: string,
  fetcher: () => Promise<boolean>,
): Promise<void> {
  try {
    await recordOutcome(db, source, await fetcher());
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn(`[primary-prices] ${label} failed:`, err);
    await recordOutcome(db, source, false);
  }
}

export async function buildPrimaryPricePlan(
  assets: PeggedAsset[],
  db: D1Database,
  dlListPrices?: Map<string, number | DlListQuote>,
): Promise<PrimaryPricePlan> {
  const metaById = new Map(ACTIVE_STABLECOINS.map((meta) => [meta.id, meta]));
  const nowSec = Math.floor(Date.now() / 1000);
  const dexRows = await loadDexPriceRows(db);
  const dexPriceSources = await loadDexPriceSources(db);

  const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
  const krakenKnownSet = new Set(KRAKEN_KNOWN_SYMBOLS);
  const bitstampKnownSet = new Set(BITSTAMP_KNOWN_SYMBOLS);
  const redstoneSymbolSet = new Set<string>(REDSTONE_TRACKED_SYMBOL_ALLOWLIST);
  const curveEligibleIds = new Set(CURVE_POOL_CONFIGS.map((config) => config.stablecoinId));
  curveEligibleIds.add("crvusd-curve");

  const candidates = assets.filter((asset) => {
    const meta = metaById.get(asset.id);
    const symbolUpper = asset.symbol.toUpperCase();
    const hasValidGeckoId = isUsableGeckoId(asset.geckoId);
    return hasValidGeckoId ||
      (dlListPrices?.has(asset.id) ?? false) ||
      !!meta?.pythFeedId ||
      coinbaseKnownSet.has(symbolUpper) ||
      krakenKnownSet.has(symbolUpper) ||
      bitstampKnownSet.has(symbolUpper) ||
      redstoneSymbolSet.has(asset.symbol) ||
      curveEligibleIds.has(asset.id) ||
      dexRows.has(asset.id) ||
      dexPriceSources.has(asset.id);
  });

  if (candidates.length === 0) {
    return {
      candidates,
      nowSec,
      dexRows,
      dexPriceSources,
      geckoIds: [],
      pythFeedIds: new Map(),
      coinbaseSymbols: [],
      krakenSymbols: [],
      shouldFetchBitstamp: false,
      redstoneSymbols: [],
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
      },
    };
  }

  const [
    cgAllowed,
    cgTickerAllowed,
    pythAllowed,
    binanceAllowed,
    krakenAllowed,
    bitstampAllowed,
    coinbaseAllowed,
    redstoneAllowed,
    curveAllowed,
    curveOracleAllowed,
  ] = await Promise.all([
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_TICKER),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.PYTH_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.KRAKEN_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BITSTAMP_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.REDSTONE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ORACLE),
  ]);

  if (
    !cgAllowed &&
    !pythAllowed &&
    !binanceAllowed &&
    !krakenAllowed &&
    !bitstampAllowed &&
    !coinbaseAllowed &&
    !redstoneAllowed &&
    !curveAllowed &&
    !curveOracleAllowed
  ) {
    console.warn("[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only");
  }

  const geckoIds = [...new Set(
    candidates
      .map((asset) => asset.geckoId)
      .filter(isUsableGeckoId),
  )];

  const pythFeedIds = new Map<string, string>();
  for (const asset of candidates) {
    const meta = metaById.get(asset.id);
    if (meta?.pythFeedId) {
      pythFeedIds.set(asset.id, meta.pythFeedId);
    }
  }

  const candidateSymbolsUpper = [...new Set(candidates.map((asset) => asset.symbol.toUpperCase()))];
  const coinbaseSymbols = candidateSymbolsUpper.filter((symbol) => coinbaseKnownSet.has(symbol));
  const krakenSymbols = candidateSymbolsUpper.filter((symbol) => krakenKnownSet.has(symbol));
  const shouldFetchBitstamp = candidateSymbolsUpper.some((symbol) => bitstampKnownSet.has(symbol));
  const redstoneSymbols = [...new Set(
    candidates.map((asset) => asset.symbol).filter((symbol) => redstoneSymbolSet.has(symbol)),
  )];

  return {
    candidates,
    nowSec,
    dexRows,
    dexPriceSources,
    geckoIds,
    pythFeedIds,
    coinbaseSymbols,
    krakenSymbols,
    shouldFetchBitstamp,
    redstoneSymbols,
    sourceAllowed: {
      cg: cgAllowed,
      cgTicker: cgTickerAllowed,
      pyth: pythAllowed,
      binance: binanceAllowed,
      kraken: krakenAllowed,
      bitstamp: bitstampAllowed,
      coinbase: coinbaseAllowed,
      redstone: redstoneAllowed,
      curve: curveAllowed,
      curveOracle: curveOracleAllowed,
    },
  };
}

export async function collectPrimaryProviderQuotes(params: {
  plan: PrimaryPricePlan;
  db: D1Database;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}): Promise<{
  quoteMaps: PrimaryConsensusQuoteMaps;
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}> {
  const { plan, db, signal, coingeckoApiKey, chainRpcs } = params;
  const {
    coinbaseSymbols,
    geckoIds,
    krakenSymbols,
    nowSec,
    pythFeedIds,
    redstoneSymbols,
    shouldFetchBitstamp,
    sourceAllowed,
  } = plan;

  const cgPrices = new Map<string, number>();
  const cgObservedAtByGeckoId = new Map<string, number>();
  const cgObservedAtModeByGeckoId = new Map<string, PriceObservedAtMode>();
  const pythPrices = new Map<string, { price: number; confidenceBps: number; publishTime: number }>();
  const binancePrices = new Map<string, number>();
  const krakenPrices = new Map<string, number>();
  const bitstampPrices = new Map<string, number>();
  const coinbasePrices = new Map<string, number>();
  const redstonePrices = new Map<string, { price: number; venueCount: number; venueAgreementPct: number; timestamp: number }>();
  const curvePrices = new Map<string, number>();
  const curveObservedAtByCoinId = new Map<string, number>();
  const cgTickerPrices = new Map<string, number>();
  const bitstampObservedAtBySymbol = new Map<string, number>();
  const coinbaseObservedAtBySymbol = new Map<string, number>();

  let curveOraclePrice: number | null = null;
  let curveOracleObservedAt: number | null = null;
  let cgTickerObservedAt: number | null = null;
  let cgObservedAt: number | null = null;
  let binanceObservedAt: number | null = null;
  let krakenObservedAt: number | null = null;

  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];
  const fetches: Promise<void>[] = [];

  if (sourceAllowed.cg) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CG_PRICES,
        "CG price API",
        async () => {
          const outcome = await fetchCoingeckoSimplePrices(
            geckoIds,
            coingeckoApiKey ?? null,
            signal,
            nowSec,
          );
          for (const [geckoId, entry] of outcome.value) {
            cgPrices.set(geckoId, entry.price);
            if (entry.observedAt != null && entry.observedAtMode != null) {
              cgObservedAtByGeckoId.set(geckoId, entry.observedAt);
              cgObservedAtModeByGeckoId.set(geckoId, entry.observedAtMode);
            }
          }
          if (outcome.value.size > 0) {
            cgObservedAt = Math.floor(Date.now() / 1000);
          }
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  }

  if (sourceAllowed.cgTicker && CG_TICKER_COINS.length > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CG_TICKER,
        "CG ticker API",
        async () => {
          const { prices, successfulResponses } = await fetchCgTickerPricesDetailed(
            CG_TICKER_COINS,
            coingeckoApiKey ?? null,
            signal,
          );
          for (const [coinId, price] of prices) {
            cgTickerPrices.set(coinId, price);
          }
          if (prices.size > 0) {
            cgTickerObservedAt = Math.floor(Date.now() / 1000);
          }
          return successfulResponses > 0;
        },
      ),
    );
  }

  if (sourceAllowed.pyth && pythFeedIds.size > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.PYTH_PRICES,
        "Pyth Hermes API",
        async () => {
          const outcome = await fetchPythPrices(pythFeedIds, signal);
          for (const [coinId, result] of outcome.value) {
            pythPrices.set(coinId, {
              price: result.price,
              confidenceBps: result.confidenceBps,
              publishTime: result.publishTime,
            });
          }
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  }

  if (sourceAllowed.binance || sourceAllowed.kraken || sourceAllowed.bitstamp || sourceAllowed.coinbase) {
    fetches.push(
      (async () => {
        if (sourceAllowed.binance) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BINANCE_PRICES, "Binance ticker", async () => {
            const outcome = await fetchBinancePricesDetailed(signal);
            const { prices, diagnostics } = outcome.value;
            providerDiagnostics.push(...diagnostics);
            for (const [symbol, price] of prices) {
              binancePrices.set(symbol, price);
            }
            if (prices.size > 0) {
              binanceObservedAt = Math.floor(Date.now() / 1000);
            }
            return isSuccessfulOutcome(outcome);
          });
        }

        if (sourceAllowed.kraken && krakenSymbols.length > 0) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.KRAKEN_PRICES, "Kraken ticker", async () => {
            const outcome = await fetchKrakenPrices(krakenSymbols, signal);
            for (const [symbol, price] of outcome.value) {
              krakenPrices.set(symbol, price);
            }
            if (outcome.value.size > 0) {
              krakenObservedAt = Math.floor(Date.now() / 1000);
            }
            return isSuccessfulOutcome(outcome);
          });
        }

        if (sourceAllowed.bitstamp && shouldFetchBitstamp) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BITSTAMP_PRICES, "Bitstamp ticker", async () => {
            const outcome = await fetchBitstampPrices(signal);
            for (const [symbol, price] of outcome.value.prices) {
              bitstampPrices.set(symbol, price);
            }
            for (const [symbol, observedAt] of outcome.value.observedAtBySymbol) {
              bitstampObservedAtBySymbol.set(symbol, observedAt);
            }
            return isSuccessfulOutcome(outcome);
          });
        }

        if (sourceAllowed.coinbase && coinbaseSymbols.length > 0) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.COINBASE_PRICES, "Coinbase ticker", async () => {
            const outcome = await fetchCoinbasePrices(coinbaseSymbols, signal);
            for (const [symbol, price] of outcome.value.prices) {
              coinbasePrices.set(symbol, price);
            }
            for (const [symbol, observedAt] of outcome.value.observedAtBySymbol) {
              coinbaseObservedAtBySymbol.set(symbol, observedAt);
            }
            return isSuccessfulOutcome(outcome);
          });
        }
      })(),
    );
  }

  // Breaker-recovery path: when a provider has zero tracked candidates
  // there is nothing to probe, so mirror the Jupiter pass and coax an
  // open/half-open breaker toward closed instead of leaving it stuck.
  if (krakenSymbols.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.KRAKEN_PRICES));
  }
  if (!shouldFetchBitstamp) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.BITSTAMP_PRICES));
  }
  if (coinbaseSymbols.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.COINBASE_PRICES));
  }

  if (sourceAllowed.redstone && redstoneSymbols.length > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.REDSTONE_PRICES,
        "RedStone API",
        async () => {
          const outcome = await fetchRedstonePrices(redstoneSymbols, signal);
          for (const [symbol, result] of outcome.value) {
            redstonePrices.set(symbol, {
              price: result.price,
              venueCount: result.venueCount,
              venueAgreementPct: result.venueAgreementPct,
              timestamp: result.timestamp,
            });
          }
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  } else if (redstoneSymbols.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.REDSTONE_PRICES));
  }

  if (sourceAllowed.curve && CURVE_POOL_CONFIGS.length > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CURVE_ONCHAIN,
        "Curve on-chain",
        async () => {
          const outcome = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, signal, chainRpcs);
          for (const [id, price] of outcome.value.prices) {
            curvePrices.set(id, price);
          }
          for (const [id, observedAt] of outcome.value.observedAtByCoinId) {
            curveObservedAtByCoinId.set(id, observedAt);
          }
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  } else if (CURVE_POOL_CONFIGS.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.CURVE_ONCHAIN));
  }

  if (sourceAllowed.curveOracle) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CURVE_ORACLE,
        "crvUSD oracle",
        async () => {
          const quote = await fetchCurveOracleEma(
            "ethereum",
            CRVUSD_PRICE_AGGREGATOR,
            CRVUSD_PRICE_SELECTOR,
            chainRpcs ?? new Map(),
            signal,
          );
          if (!quote) return false;
          const now = Math.floor(Date.now() / 1000);
          if (now - quote.blockTimestamp > CURVE_ORACLE_MAX_STALENESS_SEC) return false;
          curveOraclePrice = quote.price;
          curveOracleObservedAt = quote.blockTimestamp;
          return true;
        },
      ),
    );
  }

  await Promise.all(fetches);
  throwIfAborted(signal);

  return {
    quoteMaps: {
      cgPrices,
      cgObservedAtByGeckoId,
      cgObservedAtModeByGeckoId,
      cgObservedAt,
      cgTickerPrices,
      cgTickerObservedAt,
      pythPrices,
      binancePrices,
      binanceObservedAt,
      krakenPrices,
      krakenObservedAt,
      bitstampPrices,
      bitstampObservedAtBySymbol,
      coinbasePrices,
      coinbaseObservedAtBySymbol,
      redstonePrices,
      curvePrices,
      curveObservedAtByCoinId,
      curveOraclePrice,
      curveOracleObservedAt,
    },
    providerDiagnostics,
  };
}
