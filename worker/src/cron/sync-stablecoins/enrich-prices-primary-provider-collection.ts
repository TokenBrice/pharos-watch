import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { PriceObservedAtMode } from "@shared/types/core";
import { CIRCUIT_SOURCE, CURVE_ORACLE_MAX_STALENESS_SEC } from "../../lib/constants";
import { CG_TICKER_COINS, fetchCgTickerPricesDetailed } from "../../lib/cg-ticker";
import { fetchCoingeckoSimplePrices } from "../../lib/coingecko-simple-price";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { shouldAttemptFetch, recordOutcome, recordOutcomeDecision, recoverBreakerOnNoCandidate } from "../../lib/circuit-breaker";
import { mapWithConcurrency } from "../../lib/concurrency";
import { throwIfAborted } from "../../lib/abort";
import {
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePricesForRun,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
  type BinanceFetchSession,
} from "../../lib/cex-tickers";
import { isSuccessfulOutcome } from "../../lib/fetcher-result";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import {
  fetchRedstonePrices,
  getRedstoneMetaSymbolForStablecoinId,
  REDSTONE_TRACKED_STABLECOIN_IDS,
} from "../../lib/redstone";
import {
  ADDRESS_PROVIDER_CIRCUIT_SOURCE,
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  type AddressPriceProviderKey,
  type AddressPriceProviderRuntimeConfig,
  type AddressPriceQuote,
  type AddressPriceTarget,
} from "../../lib/address-price-providers";
import {
  createDexPriceSourceLoadTelemetry,
  loadDexPriceRows,
  loadDexPriceSources,
  type DexPriceSourceLoadTelemetry,
} from "../../lib/depeg-helpers";
import { fetchCurveOnchainPrices, fetchCurveOracleEma } from "../../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "../../lib/curve-pool-configs";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import type { DlListQuote, NavTelemetryQuote } from "../../lib/primary-price-collector";
import type { PeggedAsset } from "./enrich-prices-shared";
import { isUsableGeckoId } from "./enrich-prices-primary-shared";
import { toErrorMessage } from "@shared/lib/error-utils";

// crvUSD PriceAggregator contract. Consulted as a regular primary-consensus
// source by the Curve oracle fetch path; kept local because the caller is
// the only remaining consumer of these hex constants.
const CRVUSD_PRICE_AGGREGATOR = "0xe5Afcf332a5457E8FafCD668BcE3dF953762Dfe7";
const CRVUSD_PRICE_SELECTOR = "0xa035b1fe"; // price() — returns crvUSD price in USD scaled by 1e18

export type PrimaryDexRows = Awaited<ReturnType<typeof loadDexPriceRows>>;
export type PrimaryDexPriceSources = Awaited<ReturnType<typeof loadDexPriceSources>>;

type NavTelemetryPriceSource = NavTelemetryQuote["source"];

interface ReserveNavRow {
  stablecoin_id: string;
  fetched_at: number;
  source: string;
  metadata: string;
  last_success_at: number | null;
}

const NAV_TELEMETRY_PRICE_SOURCES = new Set<NavTelemetryPriceSource>(["chainlink-nav", "superstate-liquidity"]);

export interface PrimaryPricePlan {
  candidates: PeggedAsset[];
  nowSec: number;
  dexRows: PrimaryDexRows;
  dexPriceSources: PrimaryDexPriceSources;
  dexPriceSourceTelemetry: DexPriceSourceLoadTelemetry;
  geckoIds: string[];
  coinbaseSymbols: string[];
  krakenSymbols: string[];
  shouldFetchBitstamp: boolean;
  redstoneSymbols: string[];
  navPriceIds: string[];
  addressProviders: AddressPriceProviderKey[];
  addressProviderTargets: Map<AddressPriceProviderKey, AddressPriceTarget[]>;
  addressProviderConfig?: AddressPriceProviderRuntimeConfig;
  sourceAllowed: {
    cg: boolean;
    cgTicker: boolean;
    binance: boolean;
    kraken: boolean;
    bitstamp: boolean;
    coinbase: boolean;
    redstone: boolean;
    curve: boolean;
    curveOracle: boolean;
    addressProviders: Record<AddressPriceProviderKey, boolean>;
  };
}

export interface PrimaryConsensusQuoteMaps {
  cgPrices: Map<string, number>;
  cgObservedAtByGeckoId: Map<string, number>;
  cgObservedAtModeByGeckoId: Map<string, PriceObservedAtMode>;
  cgObservedAt: number | null;
  cgTickerPrices: Map<string, number>;
  cgTickerObservedAt: number | null;
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
  navPrices: Map<string, NavTelemetryQuote>;
  addressProviderQuotes: Map<string, AddressPriceQuote[]>;
}

function isNavTelemetryPriceSource(value: string | null | undefined): value is NavTelemetryPriceSource {
  return value != null && NAV_TELEMETRY_PRICE_SOURCES.has(value as NavTelemetryPriceSource);
}

function isNavTelemetryPriceEligible(
  assetId: string,
  metaById: Map<string, (typeof ACTIVE_STABLECOINS)[number]>,
): boolean {
  const adapter = metaById.get(assetId)?.liveReservesConfig?.adapter;
  return isNavTelemetryPriceSource(adapter);
}

function parsePositiveFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getMetadataRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed != null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveNavUsdRate(params: {
  asset: PeggedAsset;
  references?: PriceValidationReferences;
  metaById: Map<string, (typeof ACTIVE_STABLECOINS)[number]>;
}): number | null {
  const meta = params.metaById.get(params.asset.id);
  const pegType = pegTypeFromCurrency(meta?.flags?.pegCurrency) ?? params.asset.pegType;
  if (!pegType || pegType.includes("USD")) return 1;

  const referenceType = params.references?.typeByPeg?.[pegType] ?? params.references?.type;
  if (referenceType !== "fresh" && referenceType !== "static") return null;

  const rate = params.references?.rates[pegType];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

async function loadReserveNavPriceQuotes(params: {
  db: D1Database;
  candidates: PeggedAsset[];
  references?: PriceValidationReferences;
  metaById?: Map<string, (typeof ACTIVE_STABLECOINS)[number]>;
}): Promise<Map<string, NavTelemetryQuote>> {
  const metaById = params.metaById ?? new Map(ACTIVE_STABLECOINS.map((meta) => [meta.id, meta]));
  const eligibleIds = new Set(
    params.candidates.filter((asset) => isNavTelemetryPriceEligible(asset.id, metaById)).map((asset) => asset.id),
  );
  if (eligibleIds.size === 0) return new Map();

  try {
    const rows = await runWithOverloadRetry(() => params.db
      .prepare(
        `SELECT c.stablecoin_id, c.fetched_at, c.source, c.metadata, s.last_success_at
           FROM reserve_composition c
           JOIN reserve_sync_state s
             ON s.stablecoin_id = c.stablecoin_id
          WHERE c.source IN ('chainlink-nav', 'superstate-liquidity')
            AND s.last_success_at = c.fetched_at`,
      )
      .all<ReserveNavRow>());

    const assetById = new Map(params.candidates.map((asset) => [asset.id, asset]));
    const quotes = new Map<string, NavTelemetryQuote>();
    for (const row of rows.results ?? []) {
      if (!eligibleIds.has(row.stablecoin_id)) continue;
      if (row.last_success_at !== row.fetched_at) continue;
      if (!isNavTelemetryPriceSource(row.source)) continue;

      const asset = assetById.get(row.stablecoin_id);
      if (!asset) continue;

      const metadata = getMetadataRecord(row.metadata);
      if (!metadata) continue;

      const navPerToken = parsePositiveFiniteNumber(metadata.navPerToken);
      const sourceTimestamp =
        parsePositiveFiniteNumber(metadata.sourceTimestamp) ?? parsePositiveFiniteNumber(metadata.oracleUpdatedAt);
      if (navPerToken == null || sourceTimestamp == null) continue;

      const usdRate = resolveNavUsdRate({
        asset,
        references: params.references,
        metaById,
      });
      if (usdRate == null) continue;

      const price = navPerToken * usdRate;
      if (!Number.isFinite(price) || price <= 0) continue;

      quotes.set(row.stablecoin_id, {
        source: row.source,
        price,
        observedAt: Math.floor(sourceTimestamp),
        observedAtMode: "upstream",
        metadata: {
          reserveFetchedAt: row.fetched_at,
          navPerToken,
          navUsdRate: usdRate,
        },
      });
    }
    return quotes;
  } catch (err) {
    const msg = toErrorMessage(err);
    logWorkerEventArgs("handler", "warn", `[primary-prices] Failed to load reserve NAV telemetry: ${msg}`);
    return new Map();
  }
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
    logWorkerEventArgs("handler", "warn", `[primary-prices] ${label} failed:`, err);
    await recordOutcome(db, source, false);
  }
}

export async function buildPrimaryPricePlan(
  assets: PeggedAsset[],
  db: D1Database,
  dlListPrices?: Map<string, number | DlListQuote>,
  options?: {
    previousAssetsById?: Map<string, PeggedAsset>;
    previousMissingGenerationsById?: ReadonlyMap<string, number>;
    addressProvider?: AddressPriceProviderRuntimeConfig;
  },
): Promise<PrimaryPricePlan> {
  const metaById = new Map(ACTIVE_STABLECOINS.map((meta) => [meta.id, meta]));
  const nowSec = Math.floor(Date.now() / 1000);
  const dexPriceSourceTelemetry = createDexPriceSourceLoadTelemetry();
  const dexRows = await loadDexPriceRows(db);
  const dexPriceSources = await loadDexPriceSources(db, undefined, dexPriceSourceTelemetry);
  const addressProviders = resolveEnabledAddressPriceProviders(options?.addressProvider);
  const addressProviderTargets = buildAddressPriceTargetsByProvider({
    assets,
    previousAssetsById: options?.previousAssetsById,
    previousMissingGenerationsById: options?.previousMissingGenerationsById,
    providers: addressProviders,
  });
  const addressProviderCandidateIds = new Set<string>();
  for (const targets of addressProviderTargets.values()) {
    for (const target of targets) {
      addressProviderCandidateIds.add(target.stablecoinId);
    }
  }

  const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
  const krakenKnownSet = new Set(KRAKEN_KNOWN_SYMBOLS);
  const bitstampKnownSet = new Set(BITSTAMP_KNOWN_SYMBOLS);
  const redstoneStablecoinIdSet = new Set<string>(REDSTONE_TRACKED_STABLECOIN_IDS);
  const curveEligibleIds = new Set(CURVE_POOL_CONFIGS.map((config) => config.stablecoinId));
  curveEligibleIds.add("crvusd-curve");

  const candidates = assets.filter((asset) => {
    const symbolUpper = asset.symbol.toUpperCase();
    const hasValidGeckoId = isUsableGeckoId(asset.geckoId);
    return (
      hasValidGeckoId ||
      (dlListPrices?.has(asset.id) ?? false) ||
      coinbaseKnownSet.has(symbolUpper) ||
      krakenKnownSet.has(symbolUpper) ||
      bitstampKnownSet.has(symbolUpper) ||
      redstoneStablecoinIdSet.has(asset.id) ||
      curveEligibleIds.has(asset.id) ||
      isNavTelemetryPriceEligible(asset.id, metaById) ||
      dexRows.has(asset.id) ||
      dexPriceSources.has(asset.id) ||
      addressProviderCandidateIds.has(asset.id)
    );
  });

  if (candidates.length === 0) {
    return {
      candidates,
      nowSec,
      dexRows,
      dexPriceSources,
      dexPriceSourceTelemetry,
      geckoIds: [],
      coinbaseSymbols: [],
      krakenSymbols: [],
      shouldFetchBitstamp: false,
      redstoneSymbols: [],
      navPriceIds: [],
      addressProviders,
      addressProviderTargets,
      addressProviderConfig: options?.addressProvider,
      sourceAllowed: {
        cg: false,
        cgTicker: false,
        binance: false,
        kraken: false,
        bitstamp: false,
        coinbase: false,
        redstone: false,
        curve: false,
        curveOracle: false,
        addressProviders: Object.fromEntries(addressProviders.map((provider) => [provider, false])) as Record<AddressPriceProviderKey, boolean>,
      },
    };
  }

  const [
    cgAllowed,
    cgTickerAllowed,
    binanceAllowed,
    krakenAllowed,
    bitstampAllowed,
    coinbaseAllowed,
    redstoneAllowed,
    curveAllowed,
    curveOracleAllowed,
    ...addressProviderAllowedValues
  ] = await Promise.all([
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_TICKER),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.KRAKEN_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BITSTAMP_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.REDSTONE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ORACLE),
    ...addressProviders.map((provider) => shouldAttemptFetch(db, ADDRESS_PROVIDER_CIRCUIT_SOURCE[provider])),
  ]);
  const addressProvidersAllowed = Object.fromEntries(
    addressProviders.map((provider, index) => [provider, addressProviderAllowedValues[index] ?? false]),
  ) as Record<AddressPriceProviderKey, boolean>;

  if (
    !cgAllowed &&
    !cgTickerAllowed &&
    !binanceAllowed &&
    !krakenAllowed &&
    !bitstampAllowed &&
    !coinbaseAllowed &&
    !redstoneAllowed &&
    !curveAllowed &&
    !curveOracleAllowed &&
    !Object.values(addressProvidersAllowed).some(Boolean)
  ) {
    logWorkerEventArgs("handler", "warn", "[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only");
  }

  const geckoIds = [...new Set(candidates.map((asset) => asset.geckoId).filter(isUsableGeckoId))];

  const candidateSymbolsUpper = [...new Set(candidates.map((asset) => asset.symbol.toUpperCase()))];
  const coinbaseSymbols = candidateSymbolsUpper.filter((symbol) => coinbaseKnownSet.has(symbol));
  const krakenSymbols = candidateSymbolsUpper.filter((symbol) => krakenKnownSet.has(symbol));
  const shouldFetchBitstamp = candidateSymbolsUpper.some((symbol) => bitstampKnownSet.has(symbol));
  const redstoneSymbols = [
    ...new Set(
      candidates
        .map((asset) => getRedstoneMetaSymbolForStablecoinId(asset.id))
        .filter((symbol): symbol is string => symbol != null),
    ),
  ];

  return {
    candidates,
    nowSec,
    dexRows,
    dexPriceSources,
    dexPriceSourceTelemetry,
    geckoIds,
    coinbaseSymbols,
    krakenSymbols,
    shouldFetchBitstamp,
    redstoneSymbols,
    navPriceIds: candidates.filter((asset) => isNavTelemetryPriceEligible(asset.id, metaById)).map((asset) => asset.id),
    addressProviders,
    addressProviderTargets,
    addressProviderConfig: options?.addressProvider,
    sourceAllowed: {
      cg: cgAllowed,
      cgTicker: cgTickerAllowed,
      binance: binanceAllowed,
      kraken: krakenAllowed,
      bitstamp: bitstampAllowed,
      coinbase: coinbaseAllowed,
      redstone: redstoneAllowed,
      curve: curveAllowed,
      curveOracle: curveOracleAllowed,
      addressProviders: addressProvidersAllowed,
    },
  };
}

export async function collectPrimaryProviderQuotes(params: {
  plan: PrimaryPricePlan;
  db: D1Database;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  references?: PriceValidationReferences;
  binanceSession?: BinanceFetchSession;
}): Promise<{
  quoteMaps: PrimaryConsensusQuoteMaps;
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}> {
  const { plan, db, signal, coingeckoApiKey, chainRpcs, references, binanceSession } = params;
  const {
    coinbaseSymbols,
    geckoIds,
    krakenSymbols,
    nowSec,
    redstoneSymbols,
    navPriceIds,
    shouldFetchBitstamp,
    sourceAllowed,
  } = plan;

  const cgPrices = new Map<string, number>();
  const cgObservedAtByGeckoId = new Map<string, number>();
  const cgObservedAtModeByGeckoId = new Map<string, PriceObservedAtMode>();
  const binancePrices = new Map<string, number>();
  const krakenPrices = new Map<string, number>();
  const bitstampPrices = new Map<string, number>();
  const coinbasePrices = new Map<string, number>();
  const redstonePrices = new Map<
    string,
    { price: number; venueCount: number; venueAgreementPct: number; timestamp: number }
  >();
  const curvePrices = new Map<string, number>();
  const curveObservedAtByCoinId = new Map<string, number>();
  const cgTickerPrices = new Map<string, number>();
  const bitstampObservedAtBySymbol = new Map<string, number>();
  const coinbaseObservedAtBySymbol = new Map<string, number>();
  const navPrices = new Map<string, NavTelemetryQuote>();
  const addressProviderQuotes = new Map<string, AddressPriceQuote[]>();

  let curveOraclePrice: number | null = null;
  let curveOracleObservedAt: number | null = null;
  let cgTickerObservedAt: number | null = null;
  let cgObservedAt: number | null = null;
  let binanceObservedAt: number | null = null;
  let krakenObservedAt: number | null = null;

  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];
  // Push thunks (not started promises) so the bounded `mapWithConcurrency`
  // run below actually caps in-flight outbound requests against the
  // repo's conservative six-request trigger budget.
  const fetches: Array<() => Promise<void>> = [];

  if (navPriceIds.length > 0) {
    fetches.push(async () => {
      const quotes = await loadReserveNavPriceQuotes({
        db,
        candidates: plan.candidates,
        references,
      });
      for (const [coinId, quote] of quotes) {
        navPrices.set(coinId, quote);
      }
    });
  }

  if (sourceAllowed.cg) {
    fetches.push(() =>
      runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.CG_PRICES, "CG price API", async () => {
        const outcome = await fetchCoingeckoSimplePrices(geckoIds, coingeckoApiKey ?? null, signal, nowSec);
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
      }),
    );
  }

  if (sourceAllowed.cgTicker && CG_TICKER_COINS.length > 0) {
    fetches.push(() =>
      runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.CG_TICKER, "CG ticker API", async () => {
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
      }),
    );
  }

  if (sourceAllowed.binance || sourceAllowed.kraken || sourceAllowed.bitstamp || sourceAllowed.coinbase) {
    fetches.push(async () => {
      if (sourceAllowed.binance) {
        await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BINANCE_PRICES, "Binance ticker", async () => {
          const outcome = await fetchBinancePricesForRun(db, binanceSession ?? {}, signal, nowSec);
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
    });
  }

  // Breaker-recovery path: when a provider has zero tracked candidates
  // there is nothing to probe, so mirror the Jupiter pass and coax an
  // open/half-open breaker toward closed instead of leaving it stuck.
  if (krakenSymbols.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.KRAKEN_PRICES));
  }
  if (!shouldFetchBitstamp) {
    fetches.push(() => recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.BITSTAMP_PRICES));
  }
  if (coinbaseSymbols.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.COINBASE_PRICES));
  }

  if (sourceAllowed.redstone && redstoneSymbols.length > 0) {
    fetches.push(() =>
      runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.REDSTONE_PRICES, "RedStone API", async () => {
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
      }),
    );
  } else if (redstoneSymbols.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.REDSTONE_PRICES));
  }

  if (sourceAllowed.curve && CURVE_POOL_CONFIGS.length > 0) {
    fetches.push(() =>
      runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.CURVE_ONCHAIN, "Curve on-chain", async () => {
        const outcome = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, signal, chainRpcs);
        for (const [id, price] of outcome.value.prices) {
          curvePrices.set(id, price);
        }
        for (const [id, observedAt] of outcome.value.observedAtByCoinId) {
          curveObservedAtByCoinId.set(id, observedAt);
        }
        return isSuccessfulOutcome(outcome);
      }),
    );
  } else if (CURVE_POOL_CONFIGS.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.CURVE_ONCHAIN));
  }

  if (sourceAllowed.curveOracle) {
    fetches.push(() =>
      runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.CURVE_ORACLE, "crvUSD oracle", async () => {
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
      }),
    );
  }

  // Keep primary-provider fetches below the repo's six-request trigger budget
  // and reserve heap headroom for consensus assembly and fallback passes.
  await mapWithConcurrency(fetches, 2, (run) => run());
  throwIfAborted(signal);

  if (plan.addressProviders.length > 0 && plan.addressProviderConfig) {
    const addressProviderResult = await collectAddressPriceProviderQuotes({
      targetsByProvider: plan.addressProviderTargets,
      providers: plan.addressProviders,
      sourceAllowed: sourceAllowed.addressProviders,
      config: plan.addressProviderConfig,
      signal,
      nowSec,
      db,
    });
    for (const [coinId, quotes] of addressProviderResult.quotesByStablecoinId) {
      addressProviderQuotes.set(coinId, quotes);
    }
    providerDiagnostics.push(...addressProviderResult.diagnostics);
    for (const [provider, outcome] of addressProviderResult.providerOutcomes) {
      await recordOutcomeDecision(db, ADDRESS_PROVIDER_CIRCUIT_SOURCE[provider], outcome);
    }
  }
  for (const [provider, source] of Object.entries(ADDRESS_PROVIDER_CIRCUIT_SOURCE) as Array<[
    AddressPriceProviderKey,
    string,
  ]>) {
    if (!plan.addressProviders.includes(provider)) {
      await recoverBreakerOnNoCandidate(db, source);
    }
  }

  return {
    quoteMaps: {
      cgPrices,
      cgObservedAtByGeckoId,
      cgObservedAtModeByGeckoId,
      cgObservedAt,
      cgTickerPrices,
      cgTickerObservedAt,
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
      navPrices,
      addressProviderQuotes,
    },
    providerDiagnostics,
  };
}
