import { logWorkerEventArgs } from "../structured-log";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { PriceConfidence, PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { binarySearchNearest } from "../binary-search";
import { fetchEvmCallHexAtBlock, resolveClosestBlockAtOrBeforeTimestamp, type EvmBlockSearchCache } from "../evm-rpc";
import { encodeUint256 } from "../evm-selectors";
export { encodeAddress, encodeUint256 } from "../evm-selectors";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { validateCompositePricingSourceFreshness } from "../pricing-source-freshness";
import type { PriceValidationReferences } from "../price-validation";

export const ETHEREUM_CHAIN = "ethereum";

export const PROTOCOL_REDEEM_SOURCE = "protocol-redeem";

export const CACHED_VAULT_RATE_SOURCE = "protocol-redeem-cached-rate";

/**
 * Vault share rates accrue a few bps per day, so a day-old rate misprices by
 * roughly a basis point — categorically better than a missing active price
 * while staying honest through the dedicated low-confidence source key.
 */
export const CACHED_VAULT_RATE_MAX_AGE_SEC = 24 * 60 * 60;

export const USDC_CIRCLE_ID = "usdc-circle";

const ERC4626_NAV_MIN_RATIO = 0.5;
const ERC4626_NAV_MAX_RATIO = 10;

export interface CachedVaultRate {
  rate: number;
  observedAt: number;
}

export interface Erc4626NavVaultConfig {
  id: string;
  parentId: string;
  chain: string;
  vault: string;
  vaultDecimals: number;
  assetDecimals: number;
  rpcUrls?: readonly string[];
  allowFreshNonReplaySafeParent?: boolean;
  allowFreshReplaySafeSingleSourceParent?: boolean;
}

export function defineRegistryErc4626NavVault(input: {
  id: string;
  parentId: string;
  chain: string;
  allowFreshNonReplaySafeParent?: boolean;
  allowFreshReplaySafeSingleSourceParent?: boolean;
}): Erc4626NavVaultConfig {
  const vaultDeployment = TRACKED_META_BY_ID.get(input.id)?.contracts?.find(
    (deployment) => deployment.chain === input.chain,
  );
  const assetDeployment = TRACKED_META_BY_ID.get(input.parentId)?.contracts?.find(
    (deployment) => deployment.chain === input.chain,
  );
  if (!vaultDeployment || !assetDeployment) {
    throw new Error(
      `[authoritative-price-sources] ${input.id}: missing ${input.chain} vault or parent deployment in the stablecoin registry`,
    );
  }

  return {
    id: input.id,
    parentId: input.parentId,
    chain: input.chain,
    vault: vaultDeployment.address,
    vaultDecimals: vaultDeployment.decimals,
    assetDecimals: assetDeployment.decimals,
    ...(input.allowFreshNonReplaySafeParent === true ? { allowFreshNonReplaySafeParent: true } : {}),
    ...(input.allowFreshReplaySafeSingleSourceParent === true ? { allowFreshReplaySafeSingleSourceParent: true } : {}),
  };
}

interface BoundedVaultQuoteConfig {
  id: string;
  chain: string;
  target: string;
  rpcUrls?: readonly string[];
}

export async function fetchBoundedVaultQuote(
  config: BoundedVaultQuoteConfig,
  calldata: string,
  label: string,
  blockNumberOrTag: number | "latest",
  decodeAssetsPerShare: (outputAmount: bigint) => number,
  signal?: AbortSignal,
  options?: { throwOnNullQuote?: boolean },
): Promise<number | null> {
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.target, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: [...(config.rpcUrls ?? getPublicFallbackRpcUrls(config.chain))],
  });
  if (!quoteHex) {
    const message = `[authoritative-price-sources] ${config.id}: ${label}() returned null`;
    logWorkerEventArgs("lib", "warn", message);
    if (options?.throwOnNullQuote) {
      throw new Error(message);
    }
    return null;
  }

  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] ${config.id}: ${label}() returned zero or invalid output`);
    return null;
  }

  const assetsPerShare = decodeAssetsPerShare(outputAmount);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    logWorkerEventArgs("lib", "warn",
      `[authoritative-price-sources] ${config.id}: ${label}() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }

  return assetsPerShare;
}

export async function fetchVaultAssetsPerShareViaSelector(
  config: Erc4626NavVaultConfig,
  selector: string,
  label: string,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
  options?: { throwOnNullQuote?: boolean },
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${selector}${encodeUint256(oneShareRaw)}`;
  return fetchBoundedVaultQuote(
    { id: config.id, chain: config.chain, target: config.vault, rpcUrls: config.rpcUrls },
    calldata,
    label,
    blockNumberOrTag,
    (outputAmount) => ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals),
    signal,
    options,
  );
}

const INHERITED_PARENT_SYNC_MAX_AGE_SEC = 30 * 60;

const CAP_HISTORICAL_MIN_COVERAGE = 0.8;

export interface CurrentPriceOverride {
  price: number;
  source: string;
  confidence: PriceConfidence;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  metadata?: {
    inheritedFrom?: string;
    parentSource?: string | null;
    parentConfidence?: PriceConfidence | null;
    parentObservedAt?: number | null;
    parentObservedAtMode?: PriceObservedAtMode | null;
    parentReplaySafe?: boolean;
    cachedVaultRate?: {
      rate: number;
      rateObservedAt: number;
    };
    kavaPricefeed?: {
      marketId: string;
      blockHeight: number;
      activeOracleCount: number;
      newestExpiry: number;
      dispersionBps: number;
    };
    juiceDollarBridge?: {
      chain: "citrea";
      bridge: string;
      quoteToken: string;
      quoteParentId: string;
      blockNumber: number;
      redeemableJusd: number;
      simulatedJusd: number;
    };
  };
}

export interface HistoricalPricePoint {
  timestamp: number;
  price: number;
}

export interface HistoricalSupplySnapshot {
  ts: number;
  supply: number;
}

export interface HistoricalPriceContext {
  candidateTimestamps: number[];
  supplySnapshots?: HistoricalSupplySnapshot[];
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
}

export interface HistoricalPriceResolution {
  matched: boolean;
  source: string | null;
  prices: HistoricalPricePoint[] | null;
}

export interface LivePriceContext {
  assetsById: Map<string, PeggedAsset>;
  validationReferences?: PriceValidationReferences;
  /**
   * Transient per-candidate diagnostic slot: set by parent-trust resolution when
   * a parent is rejected, cleared by the override scheduler before each
   * candidate, and read after a null result so the attempt ledger can name the
   * rejected parent instead of reporting an opaque missing quote.
   */
  lastUntrustedParent?: { parentId: string; reason: string } | null;
  /** Durable last-good vault rates loaded once per stage; read-only for providers. */
  vaultRateCache?: ReadonlyMap<string, CachedVaultRate>;
  /** Fresh live vault rates collected during the stage for one durable post-loop write. */
  vaultRateWrites?: Map<string, CachedVaultRate>;
}

export interface LivePriceDiagnosticTarget {
  chain: string;
  target: string;
}

export function getRegistryLivePriceDiagnosticTarget(stablecoinId: string): LivePriceDiagnosticTarget | null {
  const deployment = TRACKED_META_BY_ID.get(stablecoinId)?.contracts?.[0];
  if (!deployment) return null;
  return { chain: deployment.chain, target: deployment.address };
}

export interface PriceSourceProvider {
  source: string;
  /**
   * Lower values run earlier in the live override budget. Use this for local
   * or cache-only providers so slow RPC probes cannot starve cheap repairs.
   */
  livePriority?: number;
  /**
   * Optional per-candidate wall-clock cap inside the shared live override
   * budget. Use this for heavier audited routes that need more than the
   * default fairness slice.
   */
  liveTimeoutMs?: number;
  /** Run this fallback only when the asset entered the authoritative stage without a usable price. */
  liveMissingOnly?: boolean;
  liveCircuitSource?: string;
  recordNullLiveResultAsCircuitFailure?: boolean;
  /** Do not let optional refresh failures poison a recovery circuit while the input price remains usable. */
  recordLiveCircuitFailuresOnlyWhenMissing?: boolean;
  matches(stablecoinId: string): boolean;
  matchesHistoricalPrices?(stablecoinId: string): boolean;
  fetchLivePrice?(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null>;
  fetchHistoricalPrices?(meta: StablecoinMeta, context: HistoricalPriceContext): Promise<HistoricalPricePoint[] | null>;
}

export type HistoricalBlockPriceResolver = (
  blockNumber: number,
  timestamp: number,
  signal?: AbortSignal,
) => Promise<number | null>;

export function decodeUint256WordBigInt(result: `0x${string}`, wordIndex = 0): bigint | null {
  const start = 2 + wordIndex * 64;
  const end = start + 64;
  if (result.length < end) return null;

  try {
    return BigInt(`0x${result.slice(start, end)}`);
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[price-sources] hex parse ignored:", err);
    return null;
  }
}

export function ratioToNumber(
  outputAmount: bigint,
  outputDecimals: number,
  inputAmount: bigint,
  inputDecimals: number,
  precision = 8,
): number {
  if (inputAmount <= 0n) return Number.NaN;

  const scale = 10n ** BigInt(precision);
  const numerator = outputAmount * 10n ** BigInt(inputDecimals) * scale;
  const denominator = inputAmount * 10n ** BigInt(outputDecimals);
  if (denominator <= 0n) return Number.NaN;

  return Number(numerator / denominator) / 10 ** precision;
}

function getFinitePositivePrice(asset: Pick<PeggedAsset, "price"> | undefined): number | null {
  const price = asset?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

function isExplicitAuthoritativeParent(asset: PeggedAsset): boolean {
  return (
    asset.priceSource === PROTOCOL_REDEEM_SOURCE &&
    asset.priceConfidence !== "fallback" &&
    asset.priceConfidence !== "low" &&
    asset.priceConfidence != null
  );
}

function normalizeFreshSyncedAt(value: number | null | undefined, nowSec: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const syncedAt = Math.floor(value);
  if (syncedAt > nowSec + 60) return null;
  return nowSec - syncedAt <= INHERITED_PARENT_SYNC_MAX_AGE_SEC ? syncedAt : null;
}

interface LiveParentTrustOptions {
  allowFreshNonReplaySafeParent?: boolean;
  allowFreshReplaySafeSingleSourceParent?: boolean;
}

interface TrustedInheritedParentResult {
  parent: {
    price: number;
    observedAt: number;
    observedAtMode: PriceObservedAtMode | null;
    replaySafe: boolean;
    source: string;
    confidence: PriceConfidence;
  } | null;
  untrustedReason: string | null;
}

function resolveTrustedInheritedParent(
  asset: PeggedAsset,
  nowSec: number,
  options?: LiveParentTrustOptions,
): TrustedInheritedParentResult {
  const price = getFinitePositivePrice(asset);
  if (price == null) return { parent: null, untrustedReason: "parent-price-missing" };

  const parentSource = asset.priceSource ?? null;
  const parentConfidence = asset.priceConfidence ?? null;
  if (!parentSource) return { parent: null, untrustedReason: "parent-source-missing" };

  const sourceParts = splitCompositePriceSource(parentSource);
  // Trust monotonicity: replay-safety is judged on the composite's replay-safe
  // core, as if agreeing soft corroborators (e.g. exact-address augmentation
  // lanes) were absent. A weight-1 non-replay-safe member joining the winning
  // cluster must never downgrade a parent the core trusts on its own — and the
  // padded cluster must never upgrade a core the gate would otherwise reject.
  const replaySafeCoreParts = sourceParts.filter((part) => isReplaySafePriceSource(part));
  const cachedSource = sourceParts.includes("cached");

  let trustedConfidence: PriceConfidence | null = null;
  let replaySafe = false;
  if (isExplicitAuthoritativeParent(asset) && parentConfidence != null) {
    trustedConfidence = parentConfidence;
    replaySafe = isReplaySafePriceSource(parentSource);
  } else if (parentConfidence === "high" && replaySafeCoreParts.length >= 2 && !cachedSource) {
    trustedConfidence = parentConfidence;
    replaySafe = true;
  } else if (
    options?.allowFreshNonReplaySafeParent === true &&
    parentConfidence === "high" &&
    !cachedSource
  ) {
    trustedConfidence = parentConfidence;
    replaySafe = false;
  } else if (
    options?.allowFreshReplaySafeSingleSourceParent === true &&
    replaySafeCoreParts.length === 1 &&
    (parentConfidence === "single-source" || parentConfidence === "high") &&
    !cachedSource
  ) {
    // A single replay-safe core member is admitted under single-source
    // semantics even when soft corroborators padded the cluster to "high".
    trustedConfidence = "single-source";
    replaySafe = true;
  }
  if (trustedConfidence == null) {
    const untrustedReason =
      parentConfidence !== "high" && parentConfidence !== "single-source"
        ? `confidence-${parentConfidence ?? "none"}`
        : cachedSource
          ? "cached-source"
          : replaySafeCoreParts.length === 0
            ? "non-replay-safe-source"
            : "thin-replay-safe-core";
    return { parent: null, untrustedReason };
  }

  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  const observedAtMode = asset.priceObservedAtMode ?? null;
  const freshness = validateCompositePricingSourceFreshness({
    source: parentSource,
    observedAt,
    observedAtMode,
    nowSec,
    requireObservedAt: true,
  });
  if (!freshness.accepted || freshness.observedAt == null) {
    const syncedAt = normalizeFreshSyncedAt(asset.priceSyncedAt, nowSec);
    if (
      freshness.accepted === false &&
      freshness.reason === "stale_observed_at" &&
      replaySafe &&
      syncedAt != null &&
      splitCompositePriceSource(parentSource).length > 1
    ) {
      return {
        parent: {
          price,
          observedAt: syncedAt,
          observedAtMode: "local_fetch",
          replaySafe,
          source: parentSource,
          confidence: trustedConfidence,
        },
        untrustedReason: null,
      };
    }
    return {
      parent: null,
      untrustedReason: `freshness-${freshness.accepted === false ? freshness.reason : "missing-observed-at"}`,
    };
  }

  return {
    parent: {
      price,
      observedAt: freshness.observedAt,
      observedAtMode: freshness.observedAtMode,
      replaySafe,
      source: parentSource,
      confidence: trustedConfidence,
    },
    untrustedReason: null,
  };
}

export interface TrustedOverrideParent {
  parentId: string;
  parentAsset: PeggedAsset;
  trustedParent: {
    price: number;
    observedAt: number;
    observedAtMode: PriceObservedAtMode | null;
    replaySafe: boolean;
    source: string;
    confidence: PriceConfidence;
  };
}

export function resolveTrustedOverrideParent(
  context: LivePriceContext,
  parentId: string,
  untrustedParentMessage: () => string,
  options?: LiveParentTrustOptions,
): TrustedOverrideParent | null {
  const parentAsset = context.assetsById.get(parentId);
  if (!parentAsset) {
    context.lastUntrustedParent = { parentId, reason: "parent-asset-missing" };
    return null;
  }

  const { parent: trustedParent, untrustedReason } = resolveTrustedInheritedParent(
    parentAsset,
    Math.floor(Date.now() / 1000),
    options,
  );
  if (!trustedParent) {
    context.lastUntrustedParent = { parentId, reason: untrustedReason ?? "untrusted" };
    logWorkerEventArgs("lib", "warn", untrustedParentMessage());
    return null;
  }

  return {
    parentId,
    parentAsset,
    trustedParent,
  };
}

export function buildParentDerivedLiveOverride(
  parent: TrustedOverrideParent,
  parentPriceMultiplier: number,
): CurrentPriceOverride | null {
  const price = parent.trustedParent.price * parentPriceMultiplier;
  if (!Number.isFinite(price) || price <= 0) return null;

  const parentObservedAt = parent.parentAsset.priceObservedAt ?? parent.parentAsset.priceUpdatedAt ?? null;
  const inheritsSingleSourceSoftParent =
    parent.trustedParent.confidence === "single-source" && parent.trustedParent.source !== PROTOCOL_REDEEM_SOURCE;

  return {
    price,
    source: inheritsSingleSourceSoftParent ? parent.trustedParent.source : PROTOCOL_REDEEM_SOURCE,
    confidence: inheritsSingleSourceSoftParent ? "single-source" : "high",
    observedAt: parent.trustedParent.observedAt,
    observedAtMode: parent.trustedParent.observedAtMode,
    metadata: {
      inheritedFrom: parent.parentId,
      parentSource: parent.parentAsset.priceSource ?? null,
      parentConfidence: parent.parentAsset.priceConfidence ?? null,
      parentObservedAt,
      parentObservedAtMode: parent.parentAsset.priceObservedAtMode ?? null,
      parentReplaySafe: parent.trustedParent.replaySafe,
    },
  };
}

function isTrustedCachedVaultRate(entry: CachedVaultRate | undefined, nowSec: number): entry is CachedVaultRate {
  if (!entry) return false;
  if (!Number.isFinite(entry.rate) || entry.rate < ERC4626_NAV_MIN_RATIO || entry.rate > ERC4626_NAV_MAX_RATIO) {
    return false;
  }
  if (!Number.isFinite(entry.observedAt) || entry.observedAt <= 0 || entry.observedAt > nowSec + 60) return false;
  return nowSec - entry.observedAt <= CACHED_VAULT_RATE_MAX_AGE_SEC;
}

/**
 * Resolve a vault assets-per-share rate live, falling back to the durable
 * last-good rate when the live read fails. A fresh live rate is recorded for
 * the post-loop durable write. The cached lane is missing-only: it never
 * replaces a publishable incumbent price, and callers still require a trusted
 * parent before consulting it.
 */
export async function resolveVaultAssetsPerShareWithCache(
  asset: Pick<PeggedAsset, "id" | "price" | "priceSource" | "priceObservedAt" | "priceUpdatedAt" | "priceSyncedAt">,
  context: LivePriceContext,
  fetchLiveRate: () => Promise<number | null>,
): Promise<{ rate: number; cachedObservedAt: number | null } | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  let liveRate: number | null = null;
  let liveError: unknown = null;
  try {
    liveRate = await fetchLiveRate();
  } catch (error) {
    // Timeout/RPC failures fall through to the cached rate: the lookup is
    // synchronous, so serving it under an aborted candidate budget costs
    // nothing and rescues the asset from a missing generation.
    liveError = error;
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] ${asset.id}: live vault rate failed; consulting cached rate:`, error);
  }
  if (liveRate != null) {
    context.vaultRateWrites?.set(asset.id, { rate: liveRate, observedAt: nowSec });
    return { rate: liveRate, cachedObservedAt: null };
  }

  if (!hasPublishableCurrentPrice(asset)) {
    const cached = context.vaultRateCache?.get(asset.id);
    if (isTrustedCachedVaultRate(cached, nowSec)) {
      return { rate: cached.rate, cachedObservedAt: cached.observedAt };
    }
  }

  // No rescue happened: preserve the pre-cache failure contract so aborts
  // propagate and RPC failures still count against the grouped circuit.
  if (liveError != null) throw liveError;
  return null;
}

/** Publish a cached-rate degradation price: explicit low-confidence provenance, never depeg-authoritative. */
export function buildCachedRateLiveOverride(
  parent: TrustedOverrideParent,
  rate: number,
  rateObservedAt: number,
): CurrentPriceOverride | null {
  const price = parent.trustedParent.price * rate;
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    source: CACHED_VAULT_RATE_SOURCE,
    confidence: "low",
    observedAt: Math.min(rateObservedAt, parent.trustedParent.observedAt),
    observedAtMode: "local_fetch",
    metadata: {
      inheritedFrom: parent.parentId,
      parentSource: parent.parentAsset.priceSource ?? null,
      parentConfidence: parent.parentAsset.priceConfidence ?? null,
      parentObservedAt: parent.parentAsset.priceObservedAt ?? parent.parentAsset.priceUpdatedAt ?? null,
      parentObservedAtMode: parent.parentAsset.priceObservedAtMode ?? null,
      parentReplaySafe: parent.trustedParent.replaySafe,
      cachedVaultRate: { rate, rateObservedAt },
    },
  };
}

export function findNearestSupply(snapshots: HistoricalSupplySnapshot[] | undefined, timestamp: number): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}

/**
 * Resolve the Ethereum contract/decimals for a stablecoin together with the
 * quote-token contract/decimals used to interpret a protocol-redeem output.
 *
 * The redeem output is assumed to settle in USDC: the quote contract/decimals
 * are always resolved from {@link USDC_CIRCLE_ID}. Callers feed `quoteDecimals`
 * straight into `ratioToNumber`, so a non-USDC settlement asset would be
 * silently mis-scaled. The `quoteDecimals === 6` guard makes a future
 * USDC-metadata change fail loudly (returns null) instead of producing a wrong
 * price.
 */
export function getUsdcQuotedRedeemConfig(stablecoinId: string): {
  contract: string;
  contractDecimals: number;
  quoteContract: string;
  quoteDecimals: number;
} | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const quoteMeta = TRACKED_META_BY_ID.get(USDC_CIRCLE_ID);
  if (!meta || !quoteMeta) return null;

  const contract = meta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN);
  const quoteContract = quoteMeta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN);
  if (!contract || !quoteContract) return null;

  if (quoteContract.decimals !== 6) {
    logWorkerEventArgs("lib", "warn",
      `[authoritative-price-sources] getUsdcQuotedRedeemConfig: expected 6-decimal USDC quote, got ${quoteContract.decimals}`,
    );
    return null;
  }

  return {
    contract: contract.address,
    contractDecimals: contract.decimals,
    quoteContract: quoteContract.address,
    quoteDecimals: quoteContract.decimals,
  };
}

export function normalizeHistoricalTimestamps(candidateTimestamps: number[]): number[] {
  return Array.from(
    new Set(candidateTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)),
  ).sort((a, b) => a - b);
}

export async function collectHistoricalBlockPrices(
  context: HistoricalPriceContext,
  resolvePrice: HistoricalBlockPriceResolver,
): Promise<HistoricalPricePoint[] | null> {
  const requestedTimestamps = normalizeHistoricalTimestamps(context.candidateTimestamps);
  if (requestedTimestamps.length === 0) return null;

  const blockSearchCache: EvmBlockSearchCache = {
    blockTimestampByNumber: new Map(),
  };
  const quoteByBlock = new Map<number, number>();
  const prices: HistoricalPricePoint[] = [];

  for (const timestamp of requestedTimestamps) {
    throwIfAborted(context.signal);
    const blockNumber = await resolveClosestBlockAtOrBeforeTimestamp(ETHEREUM_CHAIN, timestamp, blockSearchCache, {
      signal: context.signal,
      extraRpcUrls: getPublicFallbackRpcUrls(ETHEREUM_CHAIN),
      timeoutMs: 15_000,
    });
    if (blockNumber == null) continue;

    let price = quoteByBlock.get(blockNumber) ?? null;
    if (price == null) {
      price = await resolvePrice(blockNumber, timestamp, context.signal);
      if (price == null) continue;
      quoteByBlock.set(blockNumber, price);
    }

    prices.push({ timestamp, price });
  }

  if (prices.length === 0) return null;
  if (prices.length / requestedTimestamps.length < CAP_HISTORICAL_MIN_COVERAGE) {
    return null;
  }

  return prices;
}
