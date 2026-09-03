import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcomeDecision } from "../../lib/circuit-breaker";
import { savePriceCache, type PriceCacheWriteEntry } from "../../lib/db-cache";
import { hasPublishableCurrentPrice } from "../../lib/price-publication-state";
import { pricesAgreeWithinBps } from "../../lib/price-divergence";
import {
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  type AddressPriceProviderRuntimeConfig,
  type AddressPriceQuote,
} from "../../lib/address-price-providers";
import { enrichMissingPrices, type EnrichmentStats } from "./enrich-prices";
import type { PeggedAsset } from "./enrich-prices-shared";
import { clearPriceMetadata, loadPreviousStablecoinsById } from "./shared";

const PRICE_CORROBORATION_SOURCE_DEPTH = 3;

export function isPriceCorroborationSlot(scheduledAtSec: number): boolean {
  return scheduledAtSec % (60 * 60) === 0;
}

export interface PriceCorroborationResult {
  cohortSize: number;
  cacheEntriesWritten: number;
  fallbackStats: EnrichmentStats;
  addressProviderCount: number;
  providerDiagnosticCount: number;
}

function sourceList(asset: PeggedAsset): string[] {
  if (asset.consensusSources?.length) return [...new Set(asset.consensusSources)];
  return asset.priceSource ? splitCompositePriceSource(asset.priceSource) : [];
}

function isPriceCorroborationCandidate(asset: PeggedAsset): boolean {
  return !hasPublishableCurrentPrice(asset) || sourceList(asset).length < PRICE_CORROBORATION_SOURCE_DEPTH;
}

export function buildPriceCorroborationCohort(assets: Iterable<PeggedAsset>): PeggedAsset[] {
  return [...assets].filter(isPriceCorroborationCandidate);
}

function cloneAsFallbackProbe(asset: PeggedAsset): PeggedAsset {
  const probe: PeggedAsset = {
    ...asset,
    chains: asset.chains ? [...asset.chains] : asset.chains,
    contracts: asset.contracts ? asset.contracts.map((contract) => ({ ...contract })) : asset.contracts,
    circulating: asset.circulating ? { ...asset.circulating } : asset.circulating,
  };
  clearPriceMetadata(probe);
  return probe;
}

interface CorroborationObservation {
  source: string;
  price: number;
  observedAt: number | null;
  observedAtMode: PeggedAsset["priceObservedAtMode"];
}

function fallbackObservation(asset: PeggedAsset | undefined): CorroborationObservation | null {
  if (!asset || !hasPublishableCurrentPrice(asset) || !asset.priceSource) return null;
  return {
    source: asset.priceSource,
    price: asset.price as number,
    observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
    observedAtMode: asset.priceObservedAtMode ?? null,
  };
}

function addressObservations(quotes: readonly AddressPriceQuote[] | undefined): CorroborationObservation[] {
  return (quotes ?? []).map((quote) => ({
    source: quote.source,
    price: quote.priceUsd,
    observedAt: quote.observedAt,
    observedAtMode: quote.observedAtMode,
  }));
}

/**
 * Convert the hourly observations into price-cache provenance. Existing
 * published prices remain the reference value; a missing row may seed a
 * fallback reference that the next critical publication revalidates.
 */
export function buildPriceCorroborationCacheEntries(params: {
  publishedAssets: readonly PeggedAsset[];
  fallbackProbes: ReadonlyMap<string, PeggedAsset>;
  addressQuotes: ReadonlyMap<string, AddressPriceQuote[]>;
  syncedAt: number;
}): PriceCacheWriteEntry[] {
  const entries: PriceCacheWriteEntry[] = [];
  for (const published of params.publishedAssets) {
    const observations = [
      fallbackObservation(params.fallbackProbes.get(published.id)),
      ...addressObservations(params.addressQuotes.get(published.id)),
    ].filter((observation): observation is CorroborationObservation => observation != null);
    const reference = hasPublishableCurrentPrice(published)
      ? {
          source: published.priceSource ?? "unknown",
          price: published.price as number,
          observedAt: published.priceObservedAt ?? published.priceUpdatedAt ?? null,
          observedAtMode: published.priceObservedAtMode ?? null,
        }
      : observations[0];
    if (!reference) continue;

    const priorSources = sourceList(published);
    const agreeingObservations = observations.filter((observation) =>
      pricesAgreeWithinBps(reference.price, observation.price, DIVERGENCE_THRESHOLD_BPS),
    );
    const consensusSources = [...new Set([
      ...priorSources,
      ...observations.map((observation) => observation.source),
    ])];
    const agreeSources = [...new Set([
      ...(published.agreeSources ?? priorSources),
      reference.source,
      ...agreeingObservations.map((observation) => observation.source),
    ])];
    entries.push({
      id: published.id,
      price: reference.price,
      source: reference.source,
      confidence: hasPublishableCurrentPrice(published)
        ? (published.priceConfidence ?? "single-source")
        : "fallback",
      observedAt: reference.observedAt,
      observedAtMode: reference.observedAtMode,
      syncedAt: params.syncedAt,
      agreeSources,
      consensusSources,
    });
  }
  return entries;
}

export async function runPriceCorroboration(params: {
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  addressProvider?: AddressPriceProviderRuntimeConfig;
}): Promise<PriceCorroborationResult> {
  const { previousAssetsById } = await loadPreviousStablecoinsById(params.db);
  const cohort = buildPriceCorroborationCohort(previousAssetsById.values());
  const fallbackProbes = cohort.map(cloneAsFallbackProbe);
  const fallbackStats = await enrichMissingPrices(
    fallbackProbes,
    params.cmcApiKey,
    params.db,
    params.signal,
    params.jupiterApiKey,
    params.coingeckoApiKey,
  );

  const providers = resolveEnabledAddressPriceProviders(params.addressProvider);
  let addressQuotes = new Map<string, AddressPriceQuote[]>();
  let providerDiagnosticCount = 0;
  if (providers.length > 0 && params.addressProvider) {
    const targetsByProvider = buildAddressPriceTargetsByProvider({
      assets: cohort,
      previousAssetsById,
      providers,
      nowSec: params.syncStartSec,
    });
    const sourceAllowed = {
      "coingecko-onchain-address": await shouldAttemptFetch(params.db, CIRCUIT_SOURCE.CG_ONCHAIN),
    };
    const result = await collectAddressPriceProviderQuotes({
      targetsByProvider,
      providers,
      sourceAllowed,
      config: params.addressProvider,
      signal: params.signal,
      nowSec: params.syncStartSec,
    });
    addressQuotes = result.quotesByStablecoinId;
    providerDiagnosticCount = result.diagnostics.length;
    for (const [provider, outcome] of result.providerOutcomes) {
      if (provider === "coingecko-onchain-address") {
        await recordOutcomeDecision(params.db, CIRCUIT_SOURCE.CG_ONCHAIN, outcome);
      }
    }
  }

  const entries = buildPriceCorroborationCacheEntries({
    publishedAssets: cohort,
    fallbackProbes: new Map(fallbackProbes.map((asset) => [asset.id, asset])),
    addressQuotes,
    syncedAt: params.syncStartSec,
  });
  await savePriceCache(params.db, entries);
  return {
    cohortSize: cohort.length,
    cacheEntriesWritten: entries.length,
    fallbackStats,
    addressProviderCount: providers.length,
    providerDiagnosticCount,
  };
}
