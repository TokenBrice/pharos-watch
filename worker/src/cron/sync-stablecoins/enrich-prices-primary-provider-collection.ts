import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { CURVE_ORACLE_MAX_STALENESS_SEC } from "../../lib/curve-onchain";
import { fetchCoingeckoSimplePrices, type CoingeckoSimplePriceEntry } from "../../lib/coingecko-simple-price";
import { fetchHiveNativeHbdPrice } from "../../lib/hive-market-price";
import type { HiveNativePriceQuote } from "@shared/types/hive-market-price";
import { createPricingAssetAttempt, endpointLabel, type PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { shouldAttemptFetch, recordOutcomeSafe, recoverBreakerOnNoCandidateSafe } from "../../lib/circuit-breaker";
import { mapWithConcurrency } from "../../lib/concurrency";
import { decodeCurrentReserveNavPrice, isReserveNavPriceSource, RESERVE_NAV_PRICE_SOURCES, type ReserveNavSnapshotRow } from "../../lib/reserve-nav-price";
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
import { validatePricingSourceFreshness } from "../../lib/pricing-source-freshness";
import {
  createDexPriceSourceLoadTelemetry,
  loadDexPrices,
  type DexPriceSourceLoadTelemetry,
  type LoadedDexPrices,
} from "../../lib/depeg-helpers";
import { fetchCurveOnchainPrices, fetchCurveOracleEma } from "../../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "@shared/lib/curve-pool-configs";
import { CEX_PROVIDER_AUDIT_CONFIG, COINBASE_PRODUCTS } from "@shared/lib/pricing-provider-config";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import type { DlListQuote, NavTelemetryQuote } from "../../lib/primary-price-collector";
import { isUsableGeckoId, type PeggedAsset } from "./enrich-prices-shared";
import { toErrorMessage } from "@shared/lib/error-utils";

// crvUSD PriceAggregator contract. Consulted as a regular primary-consensus
// source by the Curve oracle fetch path; kept local because the caller is
// the only remaining consumer of these hex constants.
const CRVUSD_PRICE_AGGREGATOR = "0xe5Afcf332a5457E8FafCD668BcE3dF953762Dfe7";
const CRVUSD_PRICE_SELECTOR = "0xa035b1fe"; // price() — returns crvUSD price in USD scaled by 1e18

export type PrimaryDexRows = LoadedDexPrices["dexPriceRows"];
export type PrimaryDexPriceSources = LoadedDexPrices["dexPriceSources"];


interface ReserveNavRow extends ReserveNavSnapshotRow {
  stablecoin_id: string;
}


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
  navPriceIds: string[];
  sourceAllowed: {
    cg: boolean;
    binance: boolean;
    kraken: boolean;
    bitstamp: boolean;
    coinbase: boolean;
    curve: boolean;
    curveOracle: boolean;
    hiveMarket: boolean;
  };
}

export interface PrimaryConsensusQuoteMaps {
  cgQuotes: Map<string, CoingeckoSimplePriceEntry>;
  binancePrices: Map<string, number>;
  binanceObservedAt: number | null;
  krakenPrices: Map<string, number>;
  krakenObservedAt: number | null;
  krakenObservedAtBySymbol: Map<string, number>;
  krakenQuoteBasisBySymbol: Map<string, NonNullable<PeggedAsset["priceQuoteBasis"]>>;
  bitstampPrices: Map<string, number>;
  bitstampObservedAtBySymbol: Map<string, number>;
  coinbasePrices: Map<string, number>;
  coinbaseObservedAtBySymbol: Map<string, number>;
  curvePrices: Map<string, number>;
  curveObservedAtByCoinId: Map<string, number>;
  curvePricePoolKeysByCoinId: Map<string, readonly string[]>;
  curveOraclePrice: number | null;
  curveOracleObservedAt: number | null;
  navPrices: Map<string, NavTelemetryQuote>;
  hiveNativeQuote: HiveNativePriceQuote | null;
}

export function createEmptyPrimaryConsensusQuoteMaps(): PrimaryConsensusQuoteMaps {
  return {
    cgQuotes: new Map(),
    binancePrices: new Map(),
    binanceObservedAt: null,
    krakenPrices: new Map(),
    krakenObservedAt: null,
    krakenObservedAtBySymbol: new Map(),
    krakenQuoteBasisBySymbol: new Map(),
    bitstampPrices: new Map(),
    bitstampObservedAtBySymbol: new Map(),
    coinbasePrices: new Map(),
    coinbaseObservedAtBySymbol: new Map(),
    curvePrices: new Map(),
    curveObservedAtByCoinId: new Map(),
    curvePricePoolKeysByCoinId: new Map(),
    curveOraclePrice: null,
    curveOracleObservedAt: null,
    navPrices: new Map(),
    hiveNativeQuote: null,
  };
}


function isNavTelemetryPriceEligible(
  assetId: string,
  metaById: Map<string, (typeof ACTIVE_STABLECOINS)[number]>,
): boolean {
  const adapter = metaById.get(assetId)?.liveReservesConfig?.adapter;
  return isReserveNavPriceSource(adapter);
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
  navPriceIds: string[];
  references?: PriceValidationReferences;
  metaById?: Map<string, (typeof ACTIVE_STABLECOINS)[number]>;
}): Promise<Map<string, NavTelemetryQuote>> {
  const metaById = params.metaById ?? new Map(ACTIVE_STABLECOINS.map((meta) => [meta.id, meta]));
  // NAV-eligible IDs were collected during the plan's candidate pass; every
  // eligible asset is a candidate by construction, so no re-filtering here.
  const eligibleIds = new Set(params.navPriceIds);
  if (eligibleIds.size === 0) return new Map();

  try {
    const rows = await runWithOverloadRetry(() => params.db
      .prepare(
        `SELECT c.stablecoin_id, c.fetched_at, c.source, c.metadata, c.config_fingerprint, c.attempt_id,
                s.last_success_at, s.last_success_attempt_id,
                s.config_fingerprint AS state_config_fingerprint, s.last_attempt_id, s.pending_attempt_id
           FROM reserve_composition c
           JOIN reserve_sync_state s
             ON s.stablecoin_id = c.stablecoin_id
          WHERE c.source IN (${RESERVE_NAV_PRICE_SOURCES.map(() => "?").join(", ")})
            AND s.last_success_at = c.fetched_at`,
      )
      .bind(...RESERVE_NAV_PRICE_SOURCES)
      .all<ReserveNavRow>());

    const assetById = new Map(params.candidates.map((asset) => [asset.id, asset]));
    const quotes = new Map<string, NavTelemetryQuote>();
    for (const row of rows.results ?? []) {
      if (!eligibleIds.has(row.stablecoin_id)) continue;
      const meta = metaById.get(row.stablecoin_id);
      if (!meta) continue;

      const asset = assetById.get(row.stablecoin_id);
      if (!asset) continue;

      const navQuote = decodeCurrentReserveNavPrice(row, meta);
      if (!navQuote) continue;

      const usdRate = resolveNavUsdRate({
        asset,
        references: params.references,
        metaById,
      });
      if (usdRate == null) continue;

      const price = navQuote.price * usdRate;
      if (!Number.isFinite(price) || price <= 0) continue;

      quotes.set(row.stablecoin_id, {
        ...navQuote,
        price,
        metadata: {
          reserveFetchedAt: row.fetched_at,
          navPerToken: navQuote.price,
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
  let success: boolean;
  try {
    success = await fetcher();
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "warn", `[primary-prices] ${label} failed:`, err);
    success = false;
  }
  await recordOutcomeSafe(db, source, success);
}

export async function buildPrimaryPricePlan(
  assets: PeggedAsset[],
  db: D1Database,
  dlListPrices?: Map<string, DlListQuote>,
): Promise<PrimaryPricePlan> {
  const metaById = new Map(ACTIVE_STABLECOINS.map((meta) => [meta.id, meta]));
  const nowSec = Math.floor(Date.now() / 1000);
  const dexPriceSourceTelemetry = createDexPriceSourceLoadTelemetry();
  const { dexPriceRows: dexRows, dexPriceSources } = await loadDexPrices(db, nowSec, undefined, dexPriceSourceTelemetry);
  const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
  const krakenKnownSet = new Set(KRAKEN_KNOWN_SYMBOLS);
  const bitstampKnownSet = new Set(BITSTAMP_KNOWN_SYMBOLS);
  const curveEligibleIds = new Set(CURVE_POOL_CONFIGS.map((config) => config.stablecoinId));
  curveEligibleIds.add("crvusd-curve");

  const candidates: PeggedAsset[] = [];
  const navPriceIds: string[] = [];
  for (const asset of assets) {
    const symbolUpper = asset.symbol.toUpperCase();
    const hasValidGeckoId = isUsableGeckoId(asset.geckoId);
    // NAV telemetry eligibility implies candidacy (a disjunct below), so the
    // eligible ID list is collected in this same pass instead of re-filtering.
    const navEligible = isNavTelemetryPriceEligible(asset.id, metaById);
    if (navEligible) navPriceIds.push(asset.id);
    if (
      hasValidGeckoId ||
      (dlListPrices?.has(asset.id) ?? false) ||
      coinbaseKnownSet.has(symbolUpper) ||
      krakenKnownSet.has(symbolUpper) ||
      bitstampKnownSet.has(symbolUpper) ||
      curveEligibleIds.has(asset.id) ||
      navEligible ||
      dexRows.has(asset.id) ||
      dexPriceSources.has(asset.id)
    ) {
      candidates.push(asset);
    }
  }

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
      navPriceIds,
      sourceAllowed: {
        cg: false,
        binance: false,
        kraken: false,
        bitstamp: false,
        coinbase: false,
        curve: false,
        curveOracle: false,
        hiveMarket: false,
      },
    };
  }

  const [
    cgAllowed,
    binanceAllowed,
    krakenAllowed,
    bitstampAllowed,
    coinbaseAllowed,
    curveAllowed,
    curveOracleAllowed,
    hiveMarketAllowed,
  ] = await Promise.all([
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.KRAKEN_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BITSTAMP_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ORACLE),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.HIVE_MARKET),
  ]);

  if (
    !cgAllowed &&
    !binanceAllowed &&
    !krakenAllowed &&
    !bitstampAllowed &&
    !coinbaseAllowed &&
    !curveAllowed &&
    !curveOracleAllowed
  ) {
    logWorkerEventArgs("handler", "warn", "[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only");
  }

  const geckoIds = [...new Set(candidates.map((asset) => asset.geckoId).filter(isUsableGeckoId))];
  if (candidates.some((asset) => asset.id === "hbd-hive") && !geckoIds.includes("hive")) geckoIds.push("hive");

  const candidateSymbolsUpper = [...new Set(candidates.map((asset) => asset.symbol.toUpperCase()))];
  const coinbaseSymbols = candidateSymbolsUpper.filter((symbol) => coinbaseKnownSet.has(symbol));
  const krakenSymbols = candidateSymbolsUpper.filter((symbol) => krakenKnownSet.has(symbol));
  const curveRequested = candidates.some((asset) => curveEligibleIds.has(asset.id));
  const shouldFetchBitstamp = candidateSymbolsUpper.some((symbol) => bitstampKnownSet.has(symbol)) ||
    (curveAllowed && curveRequested) ||
    (coinbaseAllowed && coinbaseSymbols.some((symbol) => COINBASE_PRODUCTS.some((product) =>
      product.symbol === symbol && product.quoteAsset === "USDC")));

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
    navPriceIds,
    sourceAllowed: {
      cg: cgAllowed,
      binance: binanceAllowed,
      kraken: krakenAllowed,
      bitstamp: bitstampAllowed,
      coinbase: coinbaseAllowed,
      curve: curveAllowed && curveRequested,
      curveOracle: curveOracleAllowed,
      hiveMarket: hiveMarketAllowed,
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
    navPriceIds,
    shouldFetchBitstamp,
    sourceAllowed,
  } = plan;

  const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();

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
        navPriceIds,
        references,
      });
      for (const [coinId, quote] of quotes) {
        quoteMaps.navPrices.set(coinId, quote);
      }
    });
  }

  if (sourceAllowed.cg) {
    fetches.push(() =>
      runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.CG_PRICES, "CG price API", async () => {
        const outcome = await fetchCoingeckoSimplePrices(geckoIds, coingeckoApiKey ?? null, signal, nowSec);
        for (const [geckoId, entry] of outcome.value) {
          quoteMaps.cgQuotes.set(geckoId, entry);
        }
        return isSuccessfulOutcome(outcome);
      }),
    );
  }

  if (sourceAllowed.binance || sourceAllowed.kraken || sourceAllowed.bitstamp || sourceAllowed.coinbase || sourceAllowed.curve) {
    fetches.push(async () => {
      if (sourceAllowed.binance) {
        await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BINANCE_PRICES, "Binance ticker", async () => {
          const outcome = await fetchBinancePricesForRun(db, binanceSession ?? {}, signal, nowSec);
          const { prices, diagnostics } = outcome.value;
          providerDiagnostics.push(...diagnostics);
          for (const [symbol, price] of prices) {
            quoteMaps.binancePrices.set(symbol, price);
          }
          if (prices.size > 0) {
            quoteMaps.binanceObservedAt = Math.floor(Date.now() / 1000);
          }
          return isSuccessfulOutcome(outcome);
        });
      }

      if (sourceAllowed.kraken && krakenSymbols.length > 0) {
        await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.KRAKEN_PRICES, "Kraken ticker", async () => {
          const outcome = await fetchKrakenPrices(krakenSymbols, signal);
          providerDiagnostics.push(...outcome.value.diagnostics);
          for (const [symbol, price] of outcome.value.prices) {
            quoteMaps.krakenPrices.set(symbol, price);
          }
          quoteMaps.krakenObservedAtBySymbol = outcome.value.observedAtBySymbol;
          if (outcome.value.quoteBasisBySymbol) quoteMaps.krakenQuoteBasisBySymbol = outcome.value.quoteBasisBySymbol;
          if (outcome.value.prices.size > 0) {
            quoteMaps.krakenObservedAt = Math.floor(Date.now() / 1000);
          }
          return isSuccessfulOutcome(outcome);
        });
      }

      if (sourceAllowed.bitstamp && shouldFetchBitstamp) {
        await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BITSTAMP_PRICES, "Bitstamp ticker", async () => {
          const outcome = await fetchBitstampPrices(signal);
          providerDiagnostics.push(...outcome.value.diagnostics);
          for (const [symbol, price] of outcome.value.prices) {
            quoteMaps.bitstampPrices.set(symbol, price);
          }
          for (const [symbol, observedAt] of outcome.value.observedAtBySymbol) {
            quoteMaps.bitstampObservedAtBySymbol.set(symbol, observedAt);
          }
          return isSuccessfulOutcome(outcome);
        });
      }

      const usdcPrice = quoteMaps.bitstampPrices.get("USDC");
      const usdcObservedAt = quoteMaps.bitstampObservedAtBySymbol.get("USDC");
      const usdcUsd = usdcPrice != null && Number.isFinite(usdcPrice) && usdcPrice > 0 && usdcObservedAt != null &&
        validatePricingSourceFreshness({ source: "bitstamp", observedAt: usdcObservedAt, maxFutureSkewSec: 0 }).accepted
        ? { price: usdcPrice, observedAt: usdcObservedAt }
        : null;

      if (sourceAllowed.coinbase && coinbaseSymbols.length > 0) {
        await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.COINBASE_PRICES, "Coinbase ticker", async () => {
          const outcome = await fetchCoinbasePrices(coinbaseSymbols, signal);
          providerDiagnostics.push(...outcome.value.diagnostics);
          for (const { symbol, productId } of COINBASE_PRODUCTS) {
            const price = outcome.value.prices.get(symbol);
            const quoteAsset = outcome.value.quoteAssetBySymbol.get(symbol);
            const observedAt = outcome.value.observedAtBySymbol.get(symbol);
            const clock = outcome.value.clockBySymbol.get(symbol);
            if (price == null || !quoteAsset || observedAt == null || !clock) continue;
            const parent = quoteAsset === "USDC" ? usdcUsd : null;
            const resolved = quoteAsset === "USD" || parent != null;
            const diagnostic = {
              source: "coinbase",
              stage: "primary",
              endpoint: endpointLabel(`${CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl}/${productId}/${clock === "book" ? "book" : "ticker"}`),
              status: null,
              ok: true,
              success: true,
              candidateCount: 1,
              resolvedCount: resolved ? 1 : 0,
              quoteClock: clock,
              quoteObservedAt: observedAt,
            } satisfies PricingProviderAttemptDiagnostic & { quoteClock: typeof clock; quoteObservedAt: number };
            providerDiagnostics.push(diagnostic);
            if (!resolved) {
              logWorkerEventArgs("handler", "warn", `[primary-prices] Coinbase ${symbol}: USDC/USD dependency unavailable`);
              continue;
            }
            quoteMaps.coinbasePrices.set(symbol, parent ? price * parent.price : price);
            quoteMaps.coinbaseObservedAtBySymbol.set(symbol, parent ? Math.min(observedAt, parent.observedAt) : observedAt);
          }
          return isSuccessfulOutcome(outcome);
        });
      }

      if (sourceAllowed.curve && CURVE_POOL_CONFIGS.length > 0) {
        if (!usdcUsd) {
          logWorkerEventArgs("handler", "warn", "[primary-prices] Curve on-chain: USDC/USD dependency unavailable");
        } else {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.CURVE_ONCHAIN, "Curve on-chain", async () => {
            const outcome = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, usdcUsd, signal, chainRpcs);
            for (const [id, price] of outcome.value.prices) {
              quoteMaps.curvePrices.set(id, price);
            }
            for (const [id, observedAt] of outcome.value.observedAtByCoinId) {
              quoteMaps.curveObservedAtByCoinId.set(id, observedAt);
            }
            quoteMaps.curvePricePoolKeysByCoinId = outcome.value.pricePoolKeysByCoinId;
            return isSuccessfulOutcome(outcome);
          });
        }
      }
    });
  }

  // Breaker-recovery path: when a provider has zero tracked candidates
  // there is nothing to probe, so mirror the Jupiter pass and coax an
  // open/half-open breaker toward closed instead of leaving it stuck.
  if (krakenSymbols.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidateSafe(db, CIRCUIT_SOURCE.KRAKEN_PRICES));
  }
  if (!shouldFetchBitstamp) {
    fetches.push(() => recoverBreakerOnNoCandidateSafe(db, CIRCUIT_SOURCE.BITSTAMP_PRICES));
  }
  if (coinbaseSymbols.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidateSafe(db, CIRCUIT_SOURCE.COINBASE_PRICES));
  }

  if (CURVE_POOL_CONFIGS.length === 0) {
    fetches.push(() => recoverBreakerOnNoCandidateSafe(db, CIRCUIT_SOURCE.CURVE_ONCHAIN));
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
        quoteMaps.curveOraclePrice = quote.price;
        quoteMaps.curveOracleObservedAt = quote.blockTimestamp;
        return true;
      }),
    );
  }

  // Keep primary-provider fetches below the repo's six-request trigger budget
  // and reserve heap headroom for consensus assembly.
  await mapWithConcurrency(fetches, 2, (run) => run());
  throwIfAborted(signal);

  // The native observer starts only after every earlier provider/body drains.
  // Its CG parent is dependency-only and never becomes a stablecoin candidate.
  if (plan.candidates.some((asset) => asset.id === "hbd-hive") && sourceAllowed.hiveMarket) {
    const parent = sourceAllowed.cg ? quoteMaps.cgQuotes.get("hive") : undefined;
    const result = await fetchHiveNativeHbdPrice(parent ? { id: "hive", ...parent } : undefined, { signal, generation: nowSec });
    quoteMaps.hiveNativeQuote = result.quote;
    const reason = result.diagnostic.rejectionReason;
    providerDiagnostics.push({
      source: "hive-native-cg", stage: "primary", endpoint: result.diagnostic.node ?? "hive-market",
      status: null, ok: result.transportHealthy, success: result.quote != null,
      candidateCount: 1, resolvedCount: result.quote ? 1 : 0,
      ...(reason ? { rejectionReasonCounts: { [result.transportHealthy ? "price-rejected" : "upstream-error"]: 1 } } : {}),
      nativeMarket: result.diagnostic,
      assetAttempts: [createPricingAssetAttempt({
        assetId: "hbd-hive", adapter: "hive-native-cg", state: "attempted",
        result: result.quote ? "resolved" : result.transportHealthy ? "rejected" : "failed",
        ...(reason ? { rejectionClass: reason } : {}),
        candidateAt: nowSec, observedAt: result.quote?.observedAt ?? null,
      })],
    });
    // Parent absence is not a Hive outage, and each native sample has one
    // aggregate circuit outcome, never one D1 write per physical RPC.
    if (result.diagnostic.rpcCount > 0 && reason !== "aborted" && reason !== "deadline_exceeded") {
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.HIVE_MARKET, result.transportHealthy);
    }
    throwIfAborted(signal);
  }

  return { quoteMaps, providerDiagnostics };
}
