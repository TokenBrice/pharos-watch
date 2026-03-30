import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { sumPegBuckets } from "@shared/lib/supply";
import { getCache } from "../../lib/db-cache";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
import { createEmptyGtProbeStats } from "../../lib/geckoterminal-price-probe";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { syncViaCoingeckoFallback } from "./fallback";
import { loadStablecoinsIntake } from "./intake";
import {
  applyGtProbeResults,
  applyPrimaryPriceResults,
  applyProtocolPriceOverrides,
  buildDlListPrices,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  prevalidatePrices,
} from "./pricing";
import {
  enrichMissingPrices,
  fetchPrimaryPrices,
  hasMissingPrice,
  runGtProbePass,
} from "./enrich-prices";
import {
  abortResult,
  reportStablecoinsStage,
  returnIfAborted,
} from "./runtime";
import {
  loadFreshFxRates,
  parseStablecoinsCachePayload,
  loadReplayPriceCacheForTrustedContinuity,
  stampPriceMetadata,
  type CronResult,
} from "./shared";
import {
  isAbortResult,
  runPostEnrichmentPricePipeline,
} from "./post-enrichment";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import type { PeggedAsset } from "./enrich-prices";

const CHAIN_CIRCULATING_KEYS = ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"];

/** Safely sum numeric values from a peg-bucket object (e.g., { peggedUSD: 123, peggedEUR: 45 }). */
function sumPegBucketValues(bucket: unknown): number {
  if (bucket == null || typeof bucket !== "object") return 0;
  return Object.values(bucket as Record<string, unknown>).reduce<number>(
    (sum, val) => sum + (typeof val === "number" && Number.isFinite(val) ? val : 0),
    0,
  );
}

const ADDRESS_OVERRIDES: Record<string, string> = {
  "m-m0": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b", // M by M0 — no address in DL stablecoins API
  "bean-beanstalk": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4", // BEAN — no address in DL stablecoins API
};

export interface StructuralValidationResult {
  validAssets: PeggedAsset[];
  droppedMalformedAssets: number;
}

function countFiniteBuckets(buckets: Record<string, number> | undefined): number {
  if (!buckets) return 0;
  return Object.values(buckets).filter((value) => typeof value === "number" && Number.isFinite(value)).length;
}

function countChainEntries(chainCirculating: unknown): number {
  if (!chainCirculating || typeof chainCirculating !== "object") return 0;
  return Object.keys(chainCirculating as Record<string, unknown>).length;
}

/** Keep only assets with required structural fields before deeper enrichment/validation stages. */
export function filterStructurallyValidAssets(assets: PeggedAsset[]): StructuralValidationResult {
  const validAssets = assets.filter(
    (asset) => asset.id != null && typeof asset.name === "string" && typeof asset.symbol === "string" && asset.circulating != null,
  );
  return {
    validAssets,
    droppedMalformedAssets: assets.length - validAssets.length,
  };
}

/** Flatten DefiLlama chainCirculating peg-bucket objects into plain numeric values. */
export function normalizeChainCirculating(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const chainCirculating = asset.chainCirculating as Record<string, Record<string, unknown>> | undefined;
    if (!chainCirculating || typeof chainCirculating !== "object") continue;

    for (const chain of Object.keys(chainCirculating)) {
      const entry = chainCirculating[chain];
      if (!entry || typeof entry !== "object") continue;

      for (const key of CHAIN_CIRCULATING_KEYS) {
        const value = entry[key];
        if (!value || typeof value !== "object") continue;

        entry[key] = sumPegBucketValues(value);
      }
    }
  }
}

/** Apply curated metadata overrides so downstream enrichment uses canonical IDs and missing address patches. */
export function applyTrackedAssetOverrides(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const meta = TRACKED_META_BY_ID.get(String(asset.id));

    if (meta?.geckoId) {
      asset.geckoId = meta.geckoId;
    }
    if (meta?.cmcSlug) {
      asset.cmcSlug = meta.cmcSlug;
    }
    if (meta?.flags?.navToken) {
      asset.navToken = true;
    }
    if (!asset.address && ADDRESS_OVERRIDES[asset.id]) {
      asset.address = ADDRESS_OVERRIDES[asset.id];
    }
  }
}

function compareCanonicalAssetQuality(left: PeggedAsset, right: PeggedAsset): number {
  const leftVector = [
    sumPegBuckets(left.circulating),
    countChainEntries(left.chainCirculating),
    Array.isArray(left.chains) ? left.chains.length : 0,
    countFiniteBuckets(left.circulatingPrevDay ?? undefined) +
      countFiniteBuckets(left.circulatingPrevWeek ?? undefined) +
      countFiniteBuckets(left.circulatingPrevMonth ?? undefined),
    left.price != null && typeof left.price === "number" && left.price > 0 ? 1 : 0,
    typeof left.priceUpdatedAt === "number" && Number.isFinite(left.priceUpdatedAt) ? left.priceUpdatedAt : 0,
    left.geckoId ? 1 : 0,
    left.cmcSlug ? 1 : 0,
    left.address ? 1 : 0,
  ];
  const rightVector = [
    sumPegBuckets(right.circulating),
    countChainEntries(right.chainCirculating),
    Array.isArray(right.chains) ? right.chains.length : 0,
    countFiniteBuckets(right.circulatingPrevDay ?? undefined) +
      countFiniteBuckets(right.circulatingPrevWeek ?? undefined) +
      countFiniteBuckets(right.circulatingPrevMonth ?? undefined),
    right.price != null && typeof right.price === "number" && right.price > 0 ? 1 : 0,
    typeof right.priceUpdatedAt === "number" && Number.isFinite(right.priceUpdatedAt) ? right.priceUpdatedAt : 0,
    right.geckoId ? 1 : 0,
    right.cmcSlug ? 1 : 0,
    right.address ? 1 : 0,
  ];

  for (let i = 0; i < leftVector.length; i++) {
    if (leftVector[i] === rightVector[i]) continue;
    return leftVector[i] - rightVector[i];
  }
  return 0;
}

export interface CanonicalDeduplicationResult {
  dedupedAssets: PeggedAsset[];
  duplicateRows: number;
  affectedIds: string[];
}

/** Collapse post-remap canonical ID collisions to a single preferred asset row. */
export function dedupeCanonicalAssets(assets: PeggedAsset[]): CanonicalDeduplicationResult {
  const deduped = new Map<string, PeggedAsset>();
  const affectedIds = new Set<string>();
  let duplicateRows = 0;

  for (const asset of assets) {
    const id = String(asset.id);
    const existing = deduped.get(id);
    if (!existing) {
      deduped.set(id, asset);
      continue;
    }

    duplicateRows++;
    affectedIds.add(id);
    if (compareCanonicalAssetQuality(asset, existing) > 0) {
      deduped.set(id, asset);
    }
  }

  return {
    dedupedAssets: [...deduped.values()],
    duplicateRows,
    affectedIds: [...affectedIds],
  };
}

interface SupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

/** Fill missing circulatingPrev* fields from daily supply_history snapshots when values are plausibly close to current supply. */
export async function fillMissingSupplyHistory(
  db: D1Database,
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const nowMs = Date.now();
  const utcMidnight = (daysAgo: number): number => {
    const date = new Date(nowMs);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
  };

  const date1d = utcMidnight(1);
  const date7d = utcMidnight(7);
  const date30d = utcMidnight(30);

  throwIfAborted(signal);
  const historyRows = await db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE snapshot_date IN (?, ?, ?)")
    .bind(date1d, date7d, date30d)
    .all<SupplyHistoryRow>();

  if ((historyRows.results ?? []).length === 0) {
    return 0;
  }

  const historyById = new Map<string, { day?: number; week?: number; month?: number }>();
  for (const row of historyRows.results ?? []) {
    const entry = historyById.get(row.stablecoin_id) ?? {};
    if (row.snapshot_date === date1d) entry.day = row.circulating_usd;
    else if (row.snapshot_date === date7d) entry.week = row.circulating_usd;
    else if (row.snapshot_date === date30d) entry.month = row.circulating_usd;
    historyById.set(row.stablecoin_id, entry);
  }

  let fillCount = 0;
  for (const asset of assets) {
    throwIfAborted(signal);
    const historical = historyById.get(String(asset.id));
    if (!historical) continue;

    const circulating = asset.circulating;
    if (!circulating) continue;

    const pegKey = Object.keys(circulating)[0];
    if (!pegKey) continue;

    const currentValue = circulating[pegKey] ?? 0;
    const isReasonable = (value: number) =>
      currentValue > 0 && Math.abs(value - currentValue) / currentValue <= 0.30;

    if (asset.circulatingPrevDay == null && historical.day != null && isReasonable(historical.day)) {
      asset.circulatingPrevDay = { [pegKey]: historical.day };
      fillCount++;
    }
    if (asset.circulatingPrevWeek == null && historical.week != null && isReasonable(historical.week)) {
      asset.circulatingPrevWeek = { [pegKey]: historical.week };
      fillCount++;
    }
    if (asset.circulatingPrevMonth == null && historical.month != null && isReasonable(historical.month)) {
      asset.circulatingPrevMonth = { [pegKey]: historical.month };
      fillCount++;
    }
  }

  return fillCount;
}

export interface PriceStalenessSummary {
  compared: number;
  identical: number;
  stale: boolean;
}

/** Compare current prices vs previous cache snapshot and detect likely upstream staleness. */
export function computePriceStalenessSummary(
  previousAssets: PeggedAsset[],
  currentAssets: PeggedAsset[],
): PriceStalenessSummary {
  const previousPrices = new Map(
    previousAssets
      .filter((asset) => asset.price != null && typeof asset.price === "number" && asset.price > 0)
      .map((asset) => [asset.id, asset.price as number]),
  );

  let compared = 0;
  let identical = 0;

  for (const asset of currentAssets) {
    const previousPrice = previousPrices.get(asset.id);
    if (previousPrice == null || asset.price == null || typeof asset.price !== "number" || asset.price <= 0) continue;

    compared++;
    if (Math.abs(asset.price - previousPrice) / previousPrice < 0.0001) {
      identical++;
    }
  }

  const stale = compared >= 50 && identical / compared > 0.95;
  return { compared, identical, stale };
}

/** Load previous stablecoins cache and compute staleness summary against current assets. */
export async function detectPriceStaleness(
  db: D1Database,
  currentAssets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<PriceStalenessSummary | null> {
  throwIfAborted(signal);
  const previousCache = await getCache(db, "stablecoins");
  if (!previousCache) return null;

  const previousData = parseStablecoinsCachePayload(previousCache.value);
  if (!previousData) {
    console.warn("[sync-stablecoins] Failed to parse previous stablecoins cache in staleness check");
    return null;
  }

  return computePriceStalenessSummary(previousData.peggedAssets, currentAssets);
}

interface StablecoinsIntakeStageOptions {
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  cmcApiKey?: string;
  alertWebhookUrl?: string | null;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  reportProgress?: CronProgressReporter;
}

export type StablecoinsIntakeStageResult =
  | {
      kind: "fallback";
      result: CronResult;
      errorMessage: string;
    }
  | {
      kind: "ok";
      fxFallbackRates: Awaited<ReturnType<typeof loadFreshFxRates>>["fxFallbackRates"];
      validationReferences: Awaited<ReturnType<typeof loadFreshFxRates>>["validationReferences"];
      assets: PeggedAsset[];
      rawAssetCount: number;
      droppedMalformedAssets: number;
      canonicalDeduplication: CanonicalDeduplicationResult;
      previousAssetsById: Map<string, PeggedAsset>;
      cgData: CoinGeckoMcapData;
    };

export async function runStablecoinsIntakeStage(
  options: StablecoinsIntakeStageOptions,
): Promise<StablecoinsIntakeStageResult | CronResult> {
  const { fxFallbackRates: freshFxFallbackRates, validationReferences } = await loadFreshFxRates(
    options.db,
    options.syncStartSec,
  );

  const preFetchAbort = returnIfAborted(options.signal, "fetch-stablecoins-and-supplementals");
  if (preFetchAbort) return preFetchAbort;
  await reportStablecoinsStage(options.reportProgress, "intake", "Loading DefiLlama stablecoin intake");
  const intake = await loadStablecoinsIntake({
    db: options.db,
    signal: options.signal,
    syncStartSec: options.syncStartSec,
    fxFallbackRates: freshFxFallbackRates,
    coingeckoApiKey: options.coingeckoApiKey,
    chainRpcs: options.chainRpcs,
    fallbackToCoingecko: (cgData) =>
      syncViaCoingeckoFallback(
        options.db,
        cgData,
        options.cmcApiKey,
        options.syncStartSec,
        options.signal,
        options.alertWebhookUrl,
        options.coingeckoApiKey,
        options.reportProgress,
      ),
  });

  if (intake.kind === "fallback") {
    return {
      kind: "fallback",
      result: intake.result,
      errorMessage: intake.errorMessage,
    };
  }

  const fxFallbackRates = freshFxFallbackRates ?? intake.fxFallbackRates;
  await reportStablecoinsStage(options.reportProgress, "intake", "Loaded DefiLlama stablecoin intake", {
    itemsDone: intake.assets.length,
    itemsTotal: intake.rawAssetCount,
    metadata: {
      rawAssetCount: intake.rawAssetCount,
      droppedMalformedAssets: intake.droppedMalformedAssets,
      canonicalDuplicateRows: intake.canonicalDeduplication.duplicateRows,
    },
  });

  return {
    kind: "ok",
    assets: intake.assets,
    rawAssetCount: intake.rawAssetCount,
    droppedMalformedAssets: intake.droppedMalformedAssets,
    canonicalDeduplication: intake.canonicalDeduplication,
    previousAssetsById: intake.previousAssetsById,
    cgData: intake.cgData,
    fxFallbackRates,
    validationReferences,
  };
}

interface StablecoinsPricingStageOptions {
  db: D1Database;
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  syncStartSec: number;
  fxFallbackRates: Awaited<ReturnType<typeof loadFreshFxRates>>["fxFallbackRates"];
  validationReferences: Awaited<ReturnType<typeof loadFreshFxRates>>["validationReferences"];
  cmcApiKey?: string;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  reportProgress?: CronProgressReporter;
}

export async function runStablecoinsPricingStage(
  options: StablecoinsPricingStageOptions,
): Promise<
  | CronResult
  | {
      enrichStats: Awaited<ReturnType<typeof enrichMissingPrices>>;
      priceValidationStats: Awaited<ReturnType<typeof fetchPrimaryPrices>>["stats"];
      gtProbe: Awaited<ReturnType<typeof runGtProbePass>> | { updatedCount: number; stats: ReturnType<typeof createEmptyGtProbeStats> };
      rejectedCount: number;
      cachedFallbackCount: number;
    }
> {
  const validationContexts = createValidationContextResolver();
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(options.db);
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(
    options.previousAssetsById,
    options.syncStartSec,
    replayPriceCache,
  );
  let gtProbe = { updatedCount: 0, stats: createEmptyGtProbeStats() };
  const dlListPrices = buildDlListPrices(options.assets);

  const primaryPricesAbort = returnIfAborted(options.signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  await reportStablecoinsStage(options.reportProgress, "price-enrichment", "Running primary pricing and enrichment", {
    itemsTotal: options.assets.length,
  });
  const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
    options.assets,
    options.db,
    options.signal,
    options.validationReferences,
    options.coingeckoApiKey,
    options.chainRpcs,
    dlListPrices,
  );
  const protocolPriceOverrides = await fetchAuthoritativeLivePriceOverrides(options.assets, options.signal);
  applyPrimaryPriceResults({
    assets: options.assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    syncStartSec: options.syncStartSec,
  });
  prevalidatePrices({
    assets: options.assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    logLabel: "Pre-rejected bad price",
  });
  const missingBefore = new Set(
    options.assets.filter(hasMissingPrice).map((asset) => asset.id),
  );
  const enrichAbort = returnIfAborted(options.signal, "enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(options.assets, options.cmcApiKey, options.db, options.signal);
  for (const asset of options.assets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", options.syncStartSec);
    }
  }

  const gtProbeAbort = returnIfAborted(options.signal, "gt-probe");
  if (gtProbeAbort) return gtProbeAbort;
  try {
    gtProbe = await runGtProbePass(
      options.assets,
      primaryPriceResults,
      options.db,
      options.signal,
      options.validationReferences,
      options.coingeckoApiKey,
    );
    if (gtProbe.updatedCount > 0) {
      applyGtProbeResults({
        assets: options.assets,
        primaryPriceResults,
        previousTrustedPrices,
        validationContexts,
        validationReferences: options.validationReferences,
        syncStartSec: options.syncStartSec,
      });
      console.log(`[sync-stablecoins] GT probe updated ${gtProbe.updatedCount} asset prices`);
    }
  } catch (err) {
    if (options.signal?.aborted) return abortResult(options.signal, "gt-probe");
    console.warn("[sync-stablecoins] GT probe failed (non-fatal):", err);
  }

  const protocolOverrideCount = applyProtocolPriceOverrides({
    assets: options.assets,
    overrides: protocolPriceOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    syncStartSec: options.syncStartSec,
  });
  if (protocolOverrideCount > 0) {
    console.log(
      `[sync-stablecoins] Applied ${protocolOverrideCount} protocol-backed price override${protocolOverrideCount === 1 ? "" : "s"}`,
    );
  }

  const priceResult = await runPostEnrichmentPricePipeline({
    assets: options.assets,
    missingBefore,
    db: options.db,
    syncStartSec: options.syncStartSec,
    signal: options.signal,
    fxFallbackRates: options.fxFallbackRates,
    validationReferences: options.validationReferences,
    validationContexts,
    previousTrustedPrices,
    returnIfAborted,
    abortResult,
  }, "");
  if (isAbortResult(priceResult)) return priceResult;
  const { rejectedCount, cachedFallbackCount } = priceResult;
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }
  if (cachedFallbackCount > 0) {
    console.log(`[sync-stablecoins] Applied ${cachedFallbackCount} cached fallback prices`);
  }
  await reportStablecoinsStage(options.reportProgress, "price-validation", "Validated stablecoin prices", {
    itemsDone: options.assets.length - options.assets.filter(hasMissingPrice).length,
    itemsTotal: options.assets.length,
    metadata: {
      rejectedPrices: rejectedCount,
      cachedFallbackPrices: cachedFallbackCount,
      gtProbeUpdates: gtProbe.updatedCount,
    },
  });

  return {
    enrichStats,
    priceValidationStats,
    gtProbe,
    rejectedCount,
    cachedFallbackCount,
  };
}
