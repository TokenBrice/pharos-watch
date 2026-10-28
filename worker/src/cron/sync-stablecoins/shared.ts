import { logWorkerEvent, logWorkerEventArgs } from "../../lib/structured-log";
import { ChainPartitionProvenanceSchema, PriceDerivationSchema, StablecoinListResponseSchema, SupplyChainGuardProvenanceSchema } from "@shared/types/market";
import type { PriceSourceHealth } from "@shared/types/status";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CHAIN_META } from "@shared/types/chain-identity";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { CURATED_AGGREGATE_ESCROW_RESIDUALS, getOnchainSupplyHoldReason, isOnchainSupplyPartitionExcluded, prefersOnChainSupplyMcap, selectCuratedAggregateOnchainSupplyProbeContracts, selectSupplementalOnchainSupplyProbeContract, SFRAX_STOCK_PERIMETER, isSfraxStockContractRoster } from "@shared/lib/onchain-supply-probe";
import { deriveSfraxStockPerimeter } from "@shared/lib/sfrax-supply";
import { SFRAX_STOCK_MAX_AGE_SEC } from "@shared/types/sfrax-supply";
import {
  getCirculatingRawOrNull,
  SUPPLEMENTAL_RESTORE_MAX_AGE_SEC,
  SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC,
} from "@shared/lib/supply";
import { setCacheIfNewer, getCache, getPriceCache, type PriceCacheEntry } from "../../lib/db-cache";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { CronResult } from "../../lib/cron-logger";
import type { PeggedAsset } from "./enrich-prices-shared";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { loadFxRateState, getFxReferenceTypeFromState } from "../../lib/fx-rate-state";
import { validateCompositePricingSourceFreshness } from "../../lib/pricing-source-freshness";

const INVALID_STABLECOINS_CACHE_KEY = "stablecoins:invalid-last";
const VALIDATION_ISSUES_MAX_CHARS = 400;
const FX_REFERENCE_MAX_AGE_SEC = 6 * 3600;
const MISSING_PRICE_SOURCE = "missing";
const CURATED_AGGREGATE_SUPPLY_CHAIN_LABELS_BY_ID = new Map(
  ACTIVE_STABLECOINS.flatMap((meta) => {
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    if (selected === null) return [];
    return [[
      meta.id,
      [...new Set(selected.map(({ contract }) => CHAIN_META[contract.chain]?.name ?? contract.chain))].sort(),
    ] as const];
  }),
);
const SEVERE_STALENESS_REPRESENTATIVE_COMPARED = 50;
const SEVERE_STALENESS_REPRESENTATIVE_COVERAGE = 0.5;

/**
 * Severe price staleness blocks publication when nearly every compared price is
 * identical to the previous cache. The ratio alone is meaningless on a tiny
 * overlap, so the block also needs a representative comparison: fifty compared
 * rows stand on their own, and below that the overlap must still cover at least
 * half of the current payload. Without the coverage floor a payload that
 * collapsed to a handful of assets would fail open and publish frozen prices.
 */
export const SEVERE_PRICE_STALENESS_RATIO = 0.98;

export function isSevereStalenessOverlapRepresentative(compared: number, currentAssetCount: number): boolean {
  if (compared >= SEVERE_STALENESS_REPRESENTATIVE_COMPARED) return true;
  return compared > 0 && compared >= Math.ceil(currentAssetCount * SEVERE_STALENESS_REPRESENTATIVE_COVERAGE);
}

export type StablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

export type SyncCacheWriteMode = "published" | "skipped-newer" | "blocked-invalid-payload" | "no-write";

interface SyncCapabilities {
  stablecoinsCache: boolean;
  depegPipeline: boolean;
}

function parseStablecoinsCachePayload(value: string): StablecoinsPayload | null {
  try {
    const parsed = JSON.parse(value) as { peggedAssets?: PeggedAsset[]; fxFallbackRates?: Record<string, number> };
    if (!Array.isArray(parsed.peggedAssets)) return null;
    return {
      peggedAssets: parsed.peggedAssets,
      fxFallbackRates: parsed.fxFallbackRates,
    };
  } catch {
    return null;
  }
}

function resolveGeckoId(asset: PeggedAsset): string | undefined {
  if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) {
    return asset.geckoId;
  }
  const snakeCase = asset["gecko_id"];
  if (typeof snakeCase === "string" && snakeCase.length > 0) {
    return snakeCase;
  }
  return undefined;
}

function toPegBuckets(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

function normalizeOptionalTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Same refusal applies to fresh, provider and restored rows at final publication. */
export function reviewedOnchainSupplyHoldFields(asset: Pick<PeggedAsset,
  "id" | "supplySource" | "supplyObservedAt" | "supplyRestored" | "supplyUnavailableReason" | "supplyPerimeter" | "circulating" | "chainCirculating" | "chainPartition"
>, runStartedAt?: number): Pick<PeggedAsset,
  "supplySource" | "supplyUnavailableReason" | "supplyObservedAt" | "supplyRestored" | "supplyGapFill" | "supplyChainGuard"
  | "circulating" | "circulatingPrevDay" | "circulatingPrevWeek" | "circulatingPrevMonth" | "chainCirculating" | "chains" | "supplyPerimeter" | "chainPartition"
> | null {
  const assetId = String(asset.id);
  const reason = getOnchainSupplyHoldReason(assetId);
  if (!reason && !(prefersOnChainSupplyMcap(asset) && asset.supplySource === "onchain-supply-withheld")) return null;
  const meta = ACTIVE_META_BY_ID.get(assetId);
  if (meta && runStartedAt != null && asset.supplyPerimeter && !asset.supplyRestored && !asset.supplyUnavailableReason
    && asset.supplySource === "onchain-circulating-supply" && isSfraxStockContractRoster(meta)) {
    const derived = deriveSfraxStockPerimeter(asset.supplyPerimeter);
    const now = Math.floor(Date.now() / 1000);
    if (derived && derived.observation.readStartedAt >= runStartedAt && derived.observation.readCompletedAt <= now
      && now - derived.observedAt <= SFRAX_STOCK_MAX_AGE_SEC && asset.supplyObservedAt === derived.observedAt
      && Object.keys(asset.circulating ?? {}).length === 1 && asset.circulating?.peggedUSD === derived.mcap
      && Object.keys(asset.chainCirculating ?? {}).length === SFRAX_STOCK_PERIMETER.contracts.length
      && Object.entries(derived.chainCirculating).every(([label, row]) => {
        const actual = asset.chainCirculating?.[label];
        return actual?.chainId === row.chainId && actual.current === row.current;
      })) return null;
  }
  const chainCirculating = Object.fromEntries((meta?.contracts ?? []).map(({ chain }) => [
    CHAIN_META[chain]?.name ?? chain, { chainId: chain, current: null },
  ]));
  return {
    supplySource: "onchain-supply-withheld",
    supplyUnavailableReason: reason ?? undefined,
    supplyObservedAt: undefined,
    supplyRestored: undefined,
    supplyGapFill: undefined,
    supplyChainGuard: undefined,
    supplyPerimeter: undefined,
    chainPartition: undefined,
    circulating: {},
    circulatingPrevDay: null,
    circulatingPrevWeek: null,
    circulatingPrevMonth: null,
    chainCirculating,
    chains: Object.keys(chainCirculating),
  };
}

export function normalizeStablecoinsPayload(payload: StablecoinsPayload, runStartedAt?: number): StablecoinsPayload {
  return {
    ...payload,
    peggedAssets: payload.peggedAssets.map((asset) => {
      const {
        gecko_id: _ignoredSnakeCase,
        supplyObservedAt: _ignoredSupplyObservedAt,
        supplyRestored: _ignoredSupplyRestored,
        supplyUnavailableReason: _ignoredSupplyUnavailableReason,
        supplyPerimeter: _ignoredSupplyPerimeter,
        supplyChainGuard: _ignoredSupplyChainGuard,
        priceDerivation: _ignoredPriceDerivation,
        ...rest
      } = asset as PeggedAsset & { gecko_id?: unknown };
      const hasUsablePrice = typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
      const confidence = asset.priceConfidence;
      const priceUpdatedAt =
        typeof asset.priceUpdatedAt === "number" && Number.isFinite(asset.priceUpdatedAt) ? asset.priceUpdatedAt : null;
      const priceObservedAt =
        typeof asset.priceObservedAt === "number" && Number.isFinite(asset.priceObservedAt)
          ? asset.priceObservedAt
          : priceUpdatedAt;
      const priceObservedAtMode =
        asset.priceObservedAtMode === "upstream" ||
        asset.priceObservedAtMode === "local_fetch" ||
        asset.priceObservedAtMode === "unknown" ||
        asset.priceObservedAtMode === "nominal_reference"
          ? asset.priceObservedAtMode
          : null;
      const priceSyncedAt =
        typeof asset.priceSyncedAt === "number" && Number.isFinite(asset.priceSyncedAt) ? asset.priceSyncedAt : null;
      const priceSelectedSource = !hasUsablePrice
        ? null
        : typeof asset.priceSelectedSource === "string" && asset.priceSelectedSource.length > 0
          ? asset.priceSelectedSource
          : (asset.priceSource ?? MISSING_PRICE_SOURCE);
      const normalizedConfidence =
        confidence === "high" || confidence === "single-source" || confidence === "low" || confidence === "fallback"
          ? confidence
          : null;
      const supplyObservedAt = normalizeOptionalTimestamp(asset.supplyObservedAt);
      const supplyChainGuard = SupplyChainGuardProvenanceSchema.safeParse(asset.supplyChainGuard);
      const priceDerivation = PriceDerivationSchema.safeParse(asset.priceDerivation);
      const hold = reviewedOnchainSupplyHoldFields(asset, runStartedAt);

      return {
        ...rest,
        geckoId: resolveGeckoId(asset),
        price: hasUsablePrice ? asset.price : null,
        priceSource: hasUsablePrice ? (asset.priceSource ?? MISSING_PRICE_SOURCE) : MISSING_PRICE_SOURCE,
        priceConfidence: hasUsablePrice ? normalizedConfidence : null,
        priceUpdatedAt: hasUsablePrice ? (priceObservedAt ?? priceUpdatedAt) : null,
        priceObservedAt: hasUsablePrice ? priceObservedAt : null,
        priceObservedAtMode: hasUsablePrice ? priceObservedAtMode : null,
        priceSyncedAt: hasUsablePrice ? priceSyncedAt : null,
        priceSelectedSource,
        consensusSources: hasUsablePrice ? (asset.consensusSources ?? []) : [],
        agreeSources: hasUsablePrice ? (asset.agreeSources ?? []) : [],
        priceSourceConfidenceProfile: hasUsablePrice ? (asset.priceSourceConfidenceProfile ?? null) : null,
        ...(hasUsablePrice && priceDerivation.success ? { priceDerivation: priceDerivation.data } : {}),
        ...(supplyObservedAt != null ? { supplyObservedAt } : {}),
        ...(asset.supplyRestored === true ? { supplyRestored: true } : {}),
        ...(asset.id === SFRAX_STOCK_PERIMETER.assetId && !hold && asset.supplyPerimeter ? { supplyPerimeter: asset.supplyPerimeter } : {}),
        ...(supplyChainGuard.success ? { supplyChainGuard: supplyChainGuard.data } : {}),
        circulatingPrevDay: toPegBuckets(asset.circulatingPrevDay),
        circulatingPrevWeek: toPegBuckets(asset.circulatingPrevWeek),
        circulatingPrevMonth: toPegBuckets(asset.circulatingPrevMonth),
        ...hold,
      };
    }),
  };
}

export function summarizeValidationIssues(issues: string): string {
  if (issues.length <= VALIDATION_ISSUES_MAX_CHARS) return issues;
  return `${issues.slice(0, VALIDATION_ISSUES_MAX_CHARS)}...`;
}

export function buildSyncMetadata(
  metadata: Record<string, unknown>,
  options?: {
    cacheWriteMode?: SyncCacheWriteMode;
    casSkipped?: boolean;
    downstreamSafe?: boolean;
    capabilities?: Partial<SyncCapabilities>;
  },
): string {
  const capabilities: SyncCapabilities = {
    stablecoinsCache: options?.capabilities?.stablecoinsCache ?? options?.downstreamSafe ?? false,
    depegPipeline: options?.capabilities?.depegPipeline ?? false,
  };
  return JSON.stringify({
    ...metadata,
    cacheWriteMode: options?.cacheWriteMode ?? "no-write",
    casSkipped: options?.casSkipped ?? options?.cacheWriteMode === "skipped-newer",
    downstreamSafe: capabilities.stablecoinsCache,
    capabilities,
  });
}

export async function getStablecoinsCacheAgeSec(db: D1Database): Promise<number | null> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - stablecoinsCache.updatedAt);
}

export async function writeInvalidStablecoinsDiagnostic(
  db: D1Database,
  syncStartSec: number,
  context: "main" | "fallback",
  payload: StablecoinsPayload,
  validationIssues: string,
  stablecoinsCacheAgeSec: number | null,
): Promise<void> {
  await setCacheIfNewer(
    db,
    INVALID_STABLECOINS_CACHE_KEY,
    JSON.stringify({
      context,
      detectedAt: syncStartSec,
      stablecoinsCacheAgeSec,
      validationIssues: summarizeValidationIssues(validationIssues),
      payload,
    }),
    syncStartSec,
  );
}

export function hydrateGeckoIdAliases(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) continue;
    const geckoId = resolveGeckoId(asset);
    if (geckoId) asset.geckoId = geckoId;
  }
}

export function stampPriceMetadata(
  asset: PeggedAsset,
  source: string,
  confidence: PeggedAsset["priceConfidence"],
  observedAt: number | null,
  observedAtMode?: PeggedAsset["priceObservedAtMode"],
  consensusSources?: string[],
  agreeSources?: string[],
  syncedAt?: number | null,
  selectedSource?: string | null,
  sourceConfidenceProfile?: PeggedAsset["priceSourceConfidenceProfile"],
): void {
  asset.priceSource = source;
  delete asset.priceDerivation;
  asset.priceSelectedSource = selectedSource ?? source;
  asset.priceConfidence = confidence ?? null;
  asset.priceObservedAt = observedAt;
  asset.priceObservedAtMode = observedAtMode ?? null;
  asset.priceSyncedAt = syncedAt ?? observedAt ?? null;
  asset.priceUpdatedAt = observedAt ?? syncedAt ?? null;
  if (consensusSources !== undefined) {
    asset.consensusSources = consensusSources;
  }
  if (agreeSources !== undefined) {
    asset.agreeSources = agreeSources;
  }
  if (sourceConfidenceProfile !== undefined) {
    asset.priceSourceConfidenceProfile = sourceConfidenceProfile;
  }
}

export function clearPriceMetadata(asset: PeggedAsset): void {
  asset.price = null;
  delete asset.priceDerivation;
  asset.priceSource = undefined;
  asset.priceSelectedSource = null;
  asset.priceConfidence = null;
  asset.priceUpdatedAt = null;
  asset.priceObservedAt = null;
  asset.priceObservedAtMode = null;
  asset.priceSyncedAt = null;
  asset.consensusSources = [];
  asset.agreeSources = [];
  asset.priceSourceConfidenceProfile = null;
}

function cloneCachedAsset(asset: PeggedAsset): PeggedAsset {
  return {
    ...asset,
    chains: Array.isArray(asset.chains) ? [...asset.chains] : asset.chains,
  };
}

function stampPreviousSupplyObservedAt(asset: PeggedAsset, cacheUpdatedAt: number | null): PeggedAsset {
  const cloned = cloneCachedAsset(asset);
  const supply = getCirculatingRawOrNull(cloned);
  if (supply === null || supply <= 0) {
    return cloned;
  }
  cloned.supplyObservedAt = normalizeOptionalTimestamp(asset.supplyObservedAt) ?? cacheUpdatedAt;
  return cloned;
}

function markRestoredSupply(asset: PeggedAsset, nowSec: number): PeggedAsset {
  const restored = cloneCachedAsset(asset);
  restored.supplyRestored = true;
  restored.supplyObservedAt = normalizeOptionalTimestamp(asset.supplyObservedAt);
  if (asset.chainPartition || (asset.supplySource === "coingecko-fallback" && isOnchainSupplyPartitionExcluded(String(asset.id)))) {
    const partition = restoreCuratedAggregateChainPartition({ ...restored, chainCirculating: {} }, asset, nowSec, true);
    restored.chainCirculating = partition && !partition.expired ? partition.asset.chainCirculating : {};
    if (partition && !partition.expired) restored.chainPartition = partition.asset.chainPartition;
    else delete restored.chainPartition;
  }
  if (!validateCompositePricingSourceFreshness({
    source: restored.priceSource ?? "",
    observedAt: restored.priceObservedAt ?? restored.priceUpdatedAt,
    observedAtMode: restored.priceObservedAtMode,
    nowSec,
    requireObservedAt: true,
  }).accepted) {
    clearPriceMetadata(restored);
  }
  return restored;
}

/**
 * Why the previous stablecoins map is (or is not) populated. The price
 * staleness check derives its missing/malformed/error outcomes from this
 * instead of re-reading and re-parsing the whole cache a second time per run.
 */
export type PreviousStablecoinsCacheState =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "malformed" }
  | { state: "error"; message: string };

export interface PreviousStablecoinsLoadResult {
  previousAssetsById: Map<string, PeggedAsset>;
  cacheState: PreviousStablecoinsCacheState;
}

export async function loadPreviousStablecoinsById(db: D1Database): Promise<PreviousStablecoinsLoadResult> {
  try {
    const prevCache = await getCache(db, "stablecoins");
    if (!prevCache) return { previousAssetsById: new Map(), cacheState: { state: "missing" } };
    const prevData = parseStablecoinsCachePayload(prevCache.value);
    if (!prevData) return { previousAssetsById: new Map(), cacheState: { state: "malformed" } };
    const cacheUpdatedAt = normalizeOptionalTimestamp(prevCache.updatedAt);
    return {
      previousAssetsById: new Map(
        prevData.peggedAssets.map((asset) => {
          // Older current-only packets serialized unknown history as zero. Never
          // carry that synthetic history into a fresh or restored publication.
          if (asset.supplySource === "onchain-total-supply" || asset.supplySource === "onchain-circulating-supply") {
            for (const row of Object.values(asset.chainCirculating ?? {})) {
              delete row.circulatingPrevDay;
              delete row.circulatingPrevWeek;
              delete row.circulatingPrevMonth;
            }
          }
          return [String(asset.id), stampPreviousSupplyObservedAt(asset, cacheUpdatedAt)];
        }),
      ),
      cacheState: { state: "ok" },
    };
  } catch (err) {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to parse previous stablecoins cache:", err);
    return { previousAssetsById: new Map(), cacheState: { state: "error", message: toErrorMessage(err) } };
  }
}

export async function loadReplayPriceCacheForTrustedContinuity(db: D1Database): Promise<Map<string, PriceCacheEntry>> {
  try {
    return await getPriceCache(db);
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to load replay price cache for trusted-price continuity:", error);
    return new Map<string, PriceCacheEntry>();
  }
}

export function isSupplyObservationWithinRestoreCeiling(observedAt: number, nowSec: number): boolean {
  return (
    Number.isSafeInteger(observedAt) &&
    observedAt >= 0 &&
    observedAt <= nowSec + SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC &&
    nowSec - observedAt <= SUPPLEMENTAL_RESTORE_MAX_AGE_SEC
  );
}

function isWithinRestoreCeiling(previous: PeggedAsset, nowSec: number): boolean {
  if (previous.supplySource === "coingecko-fallback" && prefersOnChainSupplyMcap(previous)) return false;
  // Cached on-chain totals must still satisfy today's deployment roster. A
  // removed or expanded aggregate cannot re-enter through generic carry-forward.
  if (previous.supplySource === "onchain-total-supply") {
    const meta = ACTIVE_STABLECOINS.find((entry) => entry.id === String(previous.id));
    if (!meta) return false;
    const labels = CURATED_AGGREGATE_SUPPLY_CHAIN_LABELS_BY_ID.get(meta.id);
    if (labels) {
      const bucket = getSinglePositiveCirculatingBucket(previous);
      if (!bucket || !hasReconciledCuratedAggregateSupplyPacket(previous, labels, bucket)) return false;
    } else if (!selectSupplementalOnchainSupplyProbeContract(meta)) {
      return false;
    }
  }
  const observedAt = normalizeOptionalTimestamp(previous.supplyObservedAt);
  // Rows without provenance get one restore; the cache read path stamps
  // supplyObservedAt from the cache row, so age accrues from there.
  if (observedAt == null) return true;
  return isSupplyObservationWithinRestoreCeiling(observedAt, nowSec);
}

/** Preserve current price/identity while carrying only an eligible native supply packet. */
export function restorePreferredNativeSupply(
  asset: PeggedAsset,
  previous: PeggedAsset | undefined,
  nowSec: number,
): PeggedAsset {
  const restored = previous?.supplySource === "onchain-total-supply" && !previous.supplyUnavailableReason
    && getCirculatingRawOrNull(previous) !== null && isWithinRestoreCeiling(previous, nowSec)
    ? markRestoredSupply(previous, nowSec) : null;
  const unavailable = reviewedOnchainSupplyHoldFields({
    id: asset.id, supplySource: "onchain-supply-withheld",
  })!;
  logWorkerEvent({
    scope: "handler", level: "warn", job: "sync-stablecoins", event: "preferred-native-supply-unavailable",
    message: "Preferred native supply read unavailable; retaining the asset and independent price",
    metadata: { stablecoinId: String(asset.id), reason: "preferred-native-supply-unavailable",
      resolution: restored ? "restored" : "unavailable", supplyObservedAt: restored?.supplyObservedAt ?? null },
  });
  return {
    ...asset,
    ...unavailable,
    ...(restored ? {
      circulating: restored.circulating,
      circulatingPrevDay: restored.circulatingPrevDay,
      circulatingPrevWeek: restored.circulatingPrevWeek,
      circulatingPrevMonth: restored.circulatingPrevMonth,
      chainCirculating: restored.chainCirculating,
      chains: restored.chains,
      supplySource: restored.supplySource,
      supplyObservedAt: restored.supplyObservedAt,
      supplyRestored: true,
      supplyUnavailableReason: undefined,
    } : {}),
  };
}

function getSinglePositiveCirculatingBucket(asset: PeggedAsset): string | null {
  const buckets = Object.entries(asset.circulating ?? {});
  if (buckets.length !== 1) return null;
  const [label, value] = buckets[0];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? label : null;
}

function hasReconciledCuratedAggregateSupplyPacket(
  asset: PeggedAsset,
  expectedChainLabels: readonly string[],
  expectedCirculatingBucket: string,
  freshAggregateSupply?: number | null,
): boolean {
  if (asset.supplySource !== "onchain-total-supply" && !(asset.supplySource === "coingecko-fallback" && asset.chainPartition)) return false;
  const aggregateSupply = getCirculatingRawOrNull(asset);
  const chainCirculating = asset.chainCirculating;
  const observedChainLabels = Object.keys(chainCirculating ?? {}).sort();
  const residualLabel = CURATED_AGGREGATE_ESCROW_RESIDUALS[String(asset.id)]?.unattributedChainLabel;
  if (residualLabel && observedChainLabels.includes(residualLabel)) {
    expectedChainLabels = [...expectedChainLabels, residualLabel].sort();
  }
  if (
    aggregateSupply === null ||
    aggregateSupply <= 0 ||
    getSinglePositiveCirculatingBucket(asset) !== expectedCirculatingBucket ||
    !chainCirculating ||
    expectedChainLabels.length === 0 ||
    observedChainLabels.length !== expectedChainLabels.length ||
    expectedChainLabels.some((chain, index) => observedChainLabels[index] !== chain)
  ) {
    return false;
  }

  let chainSupply = 0;
  for (const row of Object.values(chainCirculating)) {
    // On-chain packets observe current supply only; historical baselines are optional.
    const requiredValues = [
      row?.current,
      ...[row?.circulatingPrevDay, row?.circulatingPrevWeek, row?.circulatingPrevMonth]
        .filter((value) => value !== undefined),
    ];
    if (
      requiredValues.some(
        (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
      )
    ) {
      return false;
    }
    const current = row.current as number;
    chainSupply += current;
  }
  if (!Number.isFinite(chainSupply) || chainSupply <= 0) return false;
  if (!chainSupplyReconciles(chainSupply, aggregateSupply)) return false;
  // A partition carried onto a fresh aggregate must still add up to that
  // aggregate, otherwise the published breakdown contradicts the published total.
  return (
    freshAggregateSupply === undefined ||
    (freshAggregateSupply !== null && chainSupplyReconciles(chainSupply, freshAggregateSupply))
  );
}

function chainSupplyReconciles(chainSupply: number, total: number): boolean {
  return Math.abs(chainSupply - total) <= Math.max(0.01, total * 1e-9);
}

/** Scale complete shares only; preserve unattributed residuals and omit unobserved chain history. */
export function rescaleChainPartition(
  rows: PeggedAsset["chainCirculating"],
  observedTotal: number,
  currentTotal: number,
): PeggedAsset["chainCirculating"] | null {
  const entries = Object.entries(rows ?? {});
  if (!Number.isFinite(observedTotal) || observedTotal <= 0 || !Number.isFinite(currentTotal) || currentTotal <= 0 || entries.length === 0) return null;
  let sum = 0;
  for (const [, row] of entries) {
    if (typeof row.current !== "number" || !Number.isFinite(row.current) || row.current < 0) return null;
    sum += row.current;
  }
  if (!Number.isFinite(sum) || !chainSupplyReconciles(sum, observedTotal)) return null;
  const scaled: NonNullable<PeggedAsset["chainCirculating"]> = {};
  let largestLabel = entries[0][0];
  let scaledSum = 0;
  for (const [label, row] of entries) {
    const current = (row.current as number) / sum * currentTotal;
    if (!Number.isFinite(current)) return null;
    scaled[label] = { ...(row.chainId ? { chainId: row.chainId } : {}), current };
    scaledSum += current;
    if (current > (scaled[largestLabel].current as number)) largestLabel = label;
  }
  if (!Number.isFinite(scaledSum)) return null;
  // Put floating-point dust on the largest row so a tiny residual cannot turn negative.
  scaled[largestLabel].current = (scaled[largestLabel].current as number) + (currentTotal - scaledSum);
  return scaled;
}

/** Restore complete current-roster packets; explicit share carry preserves its original evidence clock. */
export function restoreCuratedAggregateChainPartition(
  current: PeggedAsset,
  previous: PeggedAsset | undefined,
  nowSec: number,
  rescaleShares = false,
): { asset: PeggedAsset; expired: boolean } | null {
  if (isOnchainSupplyPartitionExcluded(String(current.id))) return null;
  let expectedChainLabels = CURATED_AGGREGATE_SUPPLY_CHAIN_LABELS_BY_ID.get(String(current.id));
  if (rescaleShares && !expectedChainLabels) {
    const meta = ACTIVE_META_BY_ID.get(String(current.id));
    const single = meta && selectSupplementalOnchainSupplyProbeContract(meta);
    if (single) expectedChainLabels = [CHAIN_META[single.chain]?.name ?? single.chain];
  }
  const provenance = ChainPartitionProvenanceSchema.safeParse(previous?.chainPartition);
  const expectedCirculatingBucket = getSinglePositiveCirculatingBucket(current);
  if (
    !expectedChainLabels ||
    expectedCirculatingBucket === null ||
    current.supplySource !== "coingecko-fallback" ||
    Object.keys(current.chainCirculating ?? {}).length > 0 ||
    !previous ||
    (rescaleShares ? !provenance.success || previous.supplySource !== "coingecko-fallback" :
      previous.supplySource !== "onchain-total-supply" || normalizeOptionalTimestamp(previous.supplyObservedAt) === null) ||
    !hasReconciledCuratedAggregateSupplyPacket(
      previous,
      expectedChainLabels,
      expectedCirculatingBucket,
      rescaleShares ? undefined : getCirculatingRawOrNull(current),
    )
  ) {
    return null;
  }
  if (!isWithinRestoreCeiling(previous, nowSec) || (rescaleShares && provenance.success
    && !isSupplyObservationWithinRestoreCeiling(provenance.data.observedAt, nowSec))) {
    if (rescaleShares && provenance.success) logWorkerEvent({
      scope: "handler", level: "warn", job: "sync-stablecoins", event: "onchain-partition-divergence",
      message: "[fiat-cg] On-chain partition carry expired",
      metadata: { stablecoinId: String(current.id), reason: "carry-expired", ratio: provenance.data.ratio },
    });
    return { asset: current, expired: true };
  }

  if (rescaleShares && provenance.success) {
    const chainCirculating = rescaleChainPartition(previous.chainCirculating, getCirculatingRawOrNull(previous)!, getCirculatingRawOrNull(current)!);
    if (!chainCirculating) return null;
    return {
      asset: { ...current, chainCirculating, chainPartition: { ...provenance.data, admission: "carried" } },
      expired: false,
    };
  }

  return {
    asset: {
      ...current,
      chainCirculating: Object.fromEntries(
        Object.entries(previous.chainCirculating ?? {}).map(([chain, row]) => [chain, { ...row }]),
      ),
    },
    expired: false,
  };
}

export function mergeSupplementalLastKnownGood(
  supplementalAssets: PeggedAsset[],
  previousAssetsById: Map<string, PeggedAsset>,
  primaryAssetIds: Set<string>,
  nowSec: number = Math.floor(Date.now() / 1000),
): { assets: PeggedAsset[]; restoredCount: number; skippedDuplicates: number; expiredRestoreIds: string[] } {
  const resolved = new Map<string, PeggedAsset>();
  const expiredRestoreIds: string[] = [];
  let restoredCount = 0;
  let skippedDuplicates = 0;

  for (const asset of supplementalAssets) {
    const id = String(asset.id);
    if (primaryAssetIds.has(id)) {
      skippedDuplicates++;
      continue;
    }

    const hold = reviewedOnchainSupplyHoldFields(asset, nowSec);
    if (hold) {
      resolved.set(id, { ...asset, ...hold });
      continue;
    }

    const previous = previousAssetsById.get(id);
    // CG-detail partitions now restore only after this run attempted an unreadable leg.
    const curatedPartitionRestore = ACTIVE_META_BY_ID.get(id)?.detailProvider === "coingecko" ? null
      : restoreCuratedAggregateChainPartition(asset, previous, nowSec);
    if (curatedPartitionRestore) {
      if (curatedPartitionRestore.expired) expiredRestoreIds.push(id);
      else restoredCount++;
      resolved.set(id, curatedPartitionRestore.asset);
      continue;
    }

    // An admitted zero is a current observation (ADR-28); only unavailable supply restores.
    const supply = getCirculatingRawOrNull(asset);
    if (supply !== null) {
      resolved.set(id, asset);
      continue;
    }

    const previousSupply = getCirculatingRawOrNull(previous);
    if (previous && previousSupply !== null && previousSupply > 0) {
      if (!isWithinRestoreCeiling(previous, nowSec)) {
        expiredRestoreIds.push(id);
        resolved.set(id, asset);
        continue;
      }
      const merged = markRestoredSupply(previous, nowSec);
      if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        merged.price = asset.price;
        merged.priceSource = asset.priceSource;
        merged.priceSelectedSource = asset.priceSelectedSource ?? null;
        merged.priceConfidence = asset.priceConfidence ?? null;
        merged.priceUpdatedAt = asset.priceUpdatedAt ?? null;
        merged.priceObservedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
        merged.priceObservedAtMode = asset.priceObservedAtMode ?? null;
        merged.priceSyncedAt = asset.priceSyncedAt ?? null;
        merged.consensusSources = asset.consensusSources;
        merged.agreeSources = asset.agreeSources;
      }
      resolved.set(id, merged);
      restoredCount++;
      continue;
    }

    resolved.set(id, asset);
  }


  return {
    assets: [...resolved.values()],
    restoredCount,
    skippedDuplicates,
    expiredRestoreIds,
  };
}

const ACTIVE_TRACKED_IDS = new Set(ACTIVE_STABLECOINS.map((meta) => meta.id));

export interface TrackedCoverageRestoreResult {
  assets: PeggedAsset[];
  restoredIds: string[];
  droppedIds: string[];
}

/**
 * Restore-or-degrade for tracked-id coverage regressions: when the DefiLlama
 * list omits an active tracked coin that was published last cycle, re-publish
 * the previous row (marked supplyRestored, same 7-day ceiling as supplemental
 * carry-forward) instead of silently dropping the coin for a cycle. Preferred
 * native assets without eligible supply remain published as unavailable; other
 * unrestorable rows are reported as dropped. droppedIds is derived from the active
 * tracked universe (not the previous payload), so an already-dropped coin
 * keeps reporting every cycle instead of going silent after one run.
 */
export function restoreMissingTrackedAssets(
  currentAssets: PeggedAsset[],
  previousAssetsById: Map<string, PeggedAsset>,
  nowSec: number = Math.floor(Date.now() / 1000),
): TrackedCoverageRestoreResult {
  const presentIds = new Set(currentAssets.map((asset) => String(asset.id)));
  const restoredAssets: PeggedAsset[] = [];
  const restoredIds: string[] = [];
  const droppedIds: string[] = [];

  for (const id of ACTIVE_TRACKED_IDS) {
    if (presentIds.has(id)) continue;
    const previous = previousAssetsById.get(id);
    const meta = ACTIVE_META_BY_ID.get(id)!;
    if (prefersOnChainSupplyMcap(meta) && !getOnchainSupplyHoldReason(id)) {
      const current = previous ? markRestoredSupply(previous, nowSec) : {
        id, name: meta.name, symbol: meta.symbol, geckoId: meta.geckoId,
        pegType: pegTypeFromCurrency(meta.flags.pegCurrency), pegMechanism: meta.flags.backing, price: null,
      };
      const retained = restorePreferredNativeSupply(current, previous, nowSec);
      restoredAssets.push(retained);
      if (retained.supplyRestored) restoredIds.push(id);
      continue;
    }
    const previousSupply = getCirculatingRawOrNull(previous);
    if (!previous || previousSupply === null || previousSupply <= 0 || !isWithinRestoreCeiling(previous, nowSec)) {
      droppedIds.push(id);
      continue;
    }
    restoredAssets.push(markRestoredSupply(previous, nowSec));
    restoredIds.push(id);
  }

  return { assets: restoredAssets, restoredIds, droppedIds };
}

export async function loadFreshFxRates(
  db: D1Database,
  logPrefix = "[sync-stablecoins]",
): Promise<{
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
}> {
  const fxState = await loadFxRateState(db);
  if (!fxState) {
    return {};
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const typeByPeg: Record<string, PriceValidationReferences["type"]> = {};
  const updatedAtByPeg: Record<string, number | null> = {};
  const freshOrStaticRates: Record<string, number> = {};
  let hasStalePeg = false;
  let globalType: PriceValidationReferences["type"] = "none";
  let globalUpdatedAt: number | null = null;

  for (const pegKey of Object.keys(fxState.rates)) {
    const type = getFxReferenceTypeFromState(fxState, pegKey, FX_REFERENCE_MAX_AGE_SEC, nowSec);
    typeByPeg[pegKey] = type;
    updatedAtByPeg[pegKey] = fxState.sourceUpdatedAtByPeg[pegKey] ?? null;
    if (type === "fresh") {
      freshOrStaticRates[pegKey] = fxState.rates[pegKey];
      globalType = "fresh";
      if (updatedAtByPeg[pegKey] != null) {
        globalUpdatedAt =
          globalUpdatedAt == null
            ? updatedAtByPeg[pegKey]
            : Math.min(globalUpdatedAt, updatedAtByPeg[pegKey] as number);
      }
    } else if (type === "stale") {
      hasStalePeg = true;
      globalType = "stale";
    }
  }

  if (Object.keys(freshOrStaticRates).length === 0) {
    const ageDescriptor =
      fxState.mode === "cached-fallback"
        ? `${fxState.usableAgeSec}s usable age`
        : `${Math.max(0, nowSec - fxState.usableSyncAt)}s usable age`;
    logWorkerEventArgs("handler", "warn", `${logPrefix} Ignoring FX references with no fresh source data (${ageDescriptor})`);
    return {};
  }

  if (hasStalePeg) {
    logWorkerEventArgs("handler", "warn", `${logPrefix} Excluding stale FX source entries while keeping fresh/static references`);
  }

  return {
    fxFallbackRates: freshOrStaticRates,
    validationReferences: {
      rates: fxState.rates,
      type: globalType,
      updatedAt: globalUpdatedAt,
      updatedAtByPeg,
      typeByPeg,
    },
  };
}

export { StablecoinListResponseSchema };
export type { PriceSourceHealth, CronResult };
