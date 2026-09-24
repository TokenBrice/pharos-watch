import { logWorkerEventArgs } from "./structured-log";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageGapAcknowledgement,
} from "@shared/types/status";
import { parseJsonObject } from "./json-parse";

export const ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS = 2;

const MAX_VALID_DATE_SECONDS = 8_640_000_000_000;

const ACTIVE_STABLECOIN_SYMBOL_BY_ID = new Map(
  WORKER_ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin.symbol] as const),
);

export interface StablecoinPublicationWaiver {
  stablecoinId: string;
  owner: string;
  reason: string;
  expiresAt: number;
}

export interface StablecoinPublicationCoverage {
  complete: boolean;
  expectedActiveCount: number;
  presentActiveCount: number;
  waivedActiveCount: number;
  missingActiveIds: string[];
  waivedActiveIds: string[];
  expiredWaiverIds: string[];
  invalidWaiverIds: string[];
}

export interface StablecoinPriceCoverageAsset {
  id: string;
  symbol?: string | null;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: string | null;
  priceObservedAt?: number | null;
  priceUpdatedAt?: number | null;
  circulating?: Record<string, number> | null;
}

export type MissingActivePriceDetail = ActivePriceCoverageGap;

/** A dated, owned, expiring review that acknowledges one active stablecoin's
 * missing live price. The gap stays listed as missing in every coverage
 * payload; it only stops being alert-eligible until `expiresAt`. Renewal
 * requires a fresh review — an expired entry re-arms the alert. */
export interface StablecoinPriceGapReview {
  stablecoinId: string;
  owner: string;
  reason: string;
  /** Dated public evidence for the review (https URLs only). */
  sources: string[];
  /** Unix seconds. */
  reviewedAt: number;
  /** Unix seconds; policy caps acknowledgement at roughly 30 days per review. */
  expiresAt: number;
}

export interface StablecoinActivePriceCoverage {
  complete: boolean;
  expectedActiveCount: number;
  presentActiveCount: number;
  pricedActiveCount: number;
  missingPriceCount: number;
  pricedActiveIds: string[];
  missingActiveIds: string[];
  affectedMarketCapUsd: number;
  missingActiveAssets: MissingActivePriceDetail[];
  alertEligibleCount: number;
  alertEligibleIds: string[];
  /** Missing IDs whose gaps are acknowledged by an active review. They stay
   * in `missingActiveIds` / `missingPriceCount` / `affectedMarketCapUsd` and
   * are never alert-eligible; the acknowledgement silently stops applying the
   * moment the asset is priced again. */
  acknowledgedGapIds: string[];
  acknowledgedGapCount: number;
  expiredGapReviewIds: string[];
  invalidGapReviewIds: string[];
  maxConsecutiveMissingGenerations: number;
}

export interface PreviousStablecoinActivePriceCoverage {
  missingActiveIds: string[];
  missingActiveAssets: MissingActivePriceDetail[];
}

export interface StablecoinActivePriceCoverageOptions {
  previousCoverage?: PreviousStablecoinActivePriceCoverage | null;
  previousAcceptedAssetsById?: ReadonlyMap<string, StablecoinPriceCoverageAsset>;
  /** Evaluation clock; defaults to now. Acknowledgement is always recomputed
   * from the registry at evaluation time, never trusted from persisted state. */
  nowSec?: number;
  priceGapReviews?: readonly StablecoinPriceGapReview[];
}

export type PersistedMissingActivePriceState = readonly [
  stablecoinId: string,
  consecutiveMissingGenerations: number,
  lastAcceptedPrice: number | null,
  lastAcceptedSource: string | null,
  lastAcceptedObservedAt: number | null,
  rejectionReason: string,
];

export interface CompactedStablecoinActivePriceCoverage extends StablecoinActivePriceCoverage {
  missingActiveAssetsTruncated: number;
  missingActiveState: PersistedMissingActivePriceState[];
}

export interface ResolvedStablecoinPublicationWaivers {
  activeById: ReadonlyMap<string, StablecoinPublicationWaiver>;
  expiredWaiverIds: string[];
  invalidWaiverIds: string[];
}

/** Active publication omissions are not silently waived. Depegs remain active
 * monitoring failures, and only a persistent inability to establish positive
 * supply may move a row to quarantine after an explicit review. A missing live
 * price is worked differently: the row keeps publishing supply and market cap
 * while every admissible price lane is empty, so a dated, owned, expiring
 * review (STABLECOIN_PRICE_GAP_REVIEWS below) may acknowledge the gap. The
 * asset stays listed as missing and re-alerts the moment the review expires;
 * acknowledgement never waives the row itself and never applies to a depeg or
 * to an asset that has a price. */
export const STABLECOIN_PUBLICATION_WAIVERS: readonly StablecoinPublicationWaiver[] = [];

const PRICE_GAP_REVIEWED_AT_SEC = Date.UTC(2026, 8, 23) / 1000;

/** Reviewed price-gap acknowledgements for active stablecoins whose every
 * admissible price lane is empty. Entries are registry edits reviewed like
 * code: each needs an owner, a reason, dated public sources, and an expiry
 * within ~30 days of the review. Expired or malformed entries are ignored
 * (and reported) so their gaps alert again until renewed or resolved. */
export const STABLECOIN_PRICE_GAP_REVIEWS: readonly StablecoinPriceGapReview[] = [
  {
    stablecoinId: "wusd-worldwide",
    owner: "ops",
    reason:
      "CMC volume is zero and all reviewed venues are empty after the WSPN contract swap: CoinGecko stale since 2026-08-21, DexScreener empty, MEXC WUSDUSDT invalid, Biconomy empty book. Issuer data requested to establish an admissible redemption or venue price; review listing disposition by expiry without relaxing price guards.",
    sources: [
      "https://www.mexc.com/en-GB/announcements/article/mexc-completes-the-wspn-wusd-contract-swap-17827791520755",
      "https://developer.wspn.io/5778215m0",
      "https://www.prnewswire.com/news-releases/wspn-increases-ease-of-accessing-wusd-with-new-on-ramp-options-302191813.html",
    ],
    reviewedAt: PRICE_GAP_REVIEWED_AT_SEC,
    expiresAt: Date.UTC(2026, 9, 23) / 1000,
  },
  {
    stablecoinId: "pht-pht",
    owner: "ops",
    reason:
      "No identity-safe venue exists: MEXC PHT/USDT is a delisted/invalid symbol, CoinGecko stale since 2026-08-14, DexScreener empty on eth/poly/tron, and Biconomy's PHT is a different token (Phoenix Token, BEP20 0x885c…8e04) that must never price APACX PHT. PHP peg means a ~0.016 USD price is the expected magnitude, not a depeg. Issuer questionnaire pending; freeze or re-source by the expiry.",
    sources: [
      "https://www.mexc.co/en-PH/announcements/article/initial-listing-pht-stablecoin-pht-listing-in-innovation-zone-with-2-834-000-pht-15-000-usdt-airdrop-rewards-17827791527925",
      "https://biconomy.zendesk.com/hc/en-us/articles/58704907240345-Biconomy-com-New-Listing-Phoenix-Token-PHT-for-Spot-Trading",
      "https://docs.apacx.io/what-is-pht/pht-overview",
    ],
    reviewedAt: PRICE_GAP_REVIEWED_AT_SEC,
    expiresAt: Date.UTC(2026, 9, 15) / 1000,
  },
  {
    stablecoinId: "usda-avalon",
    owner: "ops",
    reason:
      "DefiLlama publishes USDA supply but no list price (detail 220 price null), CoinGecko has been stale since 2026-08-14, and every venue sits below the admissibility floors: the only fresh-looking lane is DefiLlama's per-deployment quote (nibiru 0xf4e0…2003, ~$0.9998), which DefiLlama re-stamps only intermittently (last observation 2026-09-24 05:07 UTC) so it is stale beyond the lane's 15-minute budget in most runs; the PancakeSwap BSC USDA/USDT pair trades ~$5.59/day against the $50K address-provider floor; and Ethereum onchain marks have zero 24h volume while diverging ~9% from the contract quote. Issuer 1:1 USDT convertibility is not yet a machine-read route; re-source a reviewed redemption or venue lane by the expiry.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/220",
      "https://www.coingecko.com/en/coins/usda-2",
      "https://dexscreener.com/bsc/0x9a4d3d78aa3a0372335ee43e08575c65a027f653",
      "https://docs.avalonfinance.xyz",
    ],
    reviewedAt: Date.UTC(2026, 8, 24) / 1000,
    expiresAt: Date.UTC(2026, 9, 24) / 1000,
  },
  {
    stablecoinId: "vcred-vcred",
    owner: "ops",
    reason:
      "No market above the admissibility floors: Hemi pools total ~$16.6K liquidity (~$8/day volume) against the $50K address-provider floor, all other pools <$100, and the issuer API exposes no public NAV. Floors must not be lowered for one asset. Issuer (dashboard.vcred.trade operators) questionnaire pending; freeze or re-source by the expiry.",
    sources: [
      "https://vcred.trade",
      "https://dashboard.vcred.trade",
      "https://apis.vcred.trade",
    ],
    reviewedAt: PRICE_GAP_REVIEWED_AT_SEC,
    expiresAt: Date.UTC(2026, 9, 7) / 1000,
  },
  {
    stablecoinId: "bnusd-balanced",
    owner: "ops",
    reason:
      "During the v1-to-v2 migration, no reviewed market is admissible: DefiLlama removed the list price, CoinGecko is stale, and CMC is inactive. Pricing the live ICON sICX/bnUSD pool requires a separately reviewed sICX/USD source and adapter. The 1:1 Sodax migration deadline is 2026-12-01; review a migration-claim valuation path or freeze before that deadline.",
    sources: [
      "https://docs.balanced.network/migrate-assets",
      "https://github.com/icon-project/sodax-sdks/blob/main/packages/sdk/docs/MIGRATION.md",
    ],
    reviewedAt: PRICE_GAP_REVIEWED_AT_SEC,
    expiresAt: Date.UTC(2026, 9, 22) / 1000,
  },
  {
    stablecoinId: "usdn-smardex",
    owner: "ops",
    reason:
      "The only admissible lane is CMC's targeted quote, which CMC refreshes intermittently for this thin asset (missing in 83 of 99 publications over 2026-09-22). CoinGecko has been stale since 2026-08-26 (~$13/day volume), and the only exact DEX pair is a Curve USDN/fxUSD pool with ~$285 liquidity, far below the $50K floor. Priced whenever a fresh CMC quote is admitted; re-source via a guarded protocol-NAV adapter or review listing disposition by the expiry.",
    sources: [
      "https://coinmarketcap.com/currencies/smardex-usdn/",
      "https://www.coingecko.com/en/coins/smardex-usdn",
      "https://dexscreener.com/ethereum/0xde17a000ba631c5d7c2bd9fb692efea52d90dee2",
    ],
    reviewedAt: Date.UTC(2026, 8, 23, 5) / 1000,
    expiresAt: Date.UTC(2026, 9, 23) / 1000,
  },
];

export interface ResolvedStablecoinPriceGapReviews {
  activeById: ReadonlyMap<string, StablecoinPriceGapReview>;
  expiredGapReviewIds: string[];
  invalidGapReviewIds: string[];
}

function isHttpsSource(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/\S+$/.test(value.trim());
}

/** Reviews fail closed on invalid identity, provenance, or dates. Expiry is
 * evaluated against the current clock, never persisted acknowledgement state. */
function validReviewSeconds(value: number): boolean {
  return Number.isFinite(value)
    && value > 0
    && Math.abs(value) <= MAX_VALID_DATE_SECONDS;
}

export function resolveStablecoinPriceGapReviews(
  expectedActiveIds: readonly string[],
  nowSec: number,
  reviews: readonly StablecoinPriceGapReview[] = STABLECOIN_PRICE_GAP_REVIEWS,
): ResolvedStablecoinPriceGapReviews {
  const activeIds = new Set(expectedActiveIds);
  const activeById = new Map<string, StablecoinPriceGapReview>();
  const expiredGapReviewIds = new Set<string>();
  const invalidGapReviewIds = new Set<string>();

  for (const review of reviews) {
    if (
      !activeIds.has(review.stablecoinId)
      || !isNonEmpty(review.owner)
      || !isNonEmpty(review.reason)
      || !Array.isArray(review.sources)
      || review.sources.length < 1
      || !review.sources.every((source) => isHttpsSource(source))
      || !validReviewSeconds(review.reviewedAt)
      || !validReviewSeconds(review.expiresAt)
      || review.expiresAt <= review.reviewedAt
    ) {
      invalidGapReviewIds.add(review.stablecoinId);
      continue;
    }
    if (review.expiresAt <= nowSec) {
      expiredGapReviewIds.add(review.stablecoinId);
      continue;
    }
    activeById.set(review.stablecoinId, review);
  }

  return {
    activeById,
    expiredGapReviewIds: [...expiredGapReviewIds].sort(),
    invalidGapReviewIds: [...invalidGapReviewIds].sort(),
  };
}

function acknowledgementFromReview(
  review: StablecoinPriceGapReview,
): ActivePriceCoverageGapAcknowledgement {
  return {
    owner: review.owner,
    reason: review.reason,
    sources: review.sources,
    reviewedAt: review.reviewedAt,
    expiresAt: review.expiresAt,
  };
}

function activePriceGapReviewForId(
  stablecoinId: string,
  nowSec: number,
): StablecoinPriceGapReview | null {
  return resolveStablecoinPriceGapReviews(WORKER_ACTIVE_IDS, nowSec).activeById.get(stablecoinId) ?? null;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function resolveStablecoinPublicationWaivers(
  expectedActiveIds: readonly string[],
  nowSec: number,
  waivers: readonly StablecoinPublicationWaiver[],
): ResolvedStablecoinPublicationWaivers {
  const activeIds = new Set(expectedActiveIds);
  const activeById = new Map<string, StablecoinPublicationWaiver>();
  const expiredWaiverIds = new Set<string>();
  const invalidWaiverIds = new Set<string>();

  for (const waiver of waivers) {
    if (
      !activeIds.has(waiver.stablecoinId)
      || !isNonEmpty(waiver.owner)
      || !isNonEmpty(waiver.reason)
      || !Number.isFinite(waiver.expiresAt)
      || waiver.expiresAt <= 0
    ) {
      invalidWaiverIds.add(waiver.stablecoinId);
      continue;
    }
    if (waiver.expiresAt <= nowSec) {
      expiredWaiverIds.add(waiver.stablecoinId);
      continue;
    }
    activeById.set(waiver.stablecoinId, waiver);
  }

  return {
    activeById,
    expiredWaiverIds: [...expiredWaiverIds].sort(),
    invalidWaiverIds: [...invalidWaiverIds].sort(),
  };
}

export function selectAppliedStablecoinPublicationWaivers(
  waivedActiveIds: readonly string[],
  resolvedWaivers: ResolvedStablecoinPublicationWaivers,
): StablecoinPublicationWaiver[] {
  return waivedActiveIds.map((stablecoinId) => {
    const waiver = resolvedWaivers.activeById.get(stablecoinId);
    if (!waiver) {
      throw new Error(`Missing resolved publication waiver for ${stablecoinId}`);
    }
    return waiver;
  });
}

export function evaluateStablecoinPublicationCoverage(
  publishedIds: Iterable<string>,
  nowSec: number = Math.floor(Date.now() / 1000),
  waivers: readonly StablecoinPublicationWaiver[] = STABLECOIN_PUBLICATION_WAIVERS,
  expectedActiveIds: readonly string[] = WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
): StablecoinPublicationCoverage {
  const presentIds = new Set(publishedIds);
  const resolvedWaivers = resolveStablecoinPublicationWaivers(expectedActiveIds, nowSec, waivers);

  const missingActiveIds: string[] = [];
  const waivedActiveIds: string[] = [];
  let presentActiveCount = 0;
  for (const stablecoinId of expectedActiveIds) {
    if (presentIds.has(stablecoinId)) {
      presentActiveCount++;
    } else if (resolvedWaivers.activeById.has(stablecoinId)) {
      waivedActiveIds.push(stablecoinId);
    } else {
      missingActiveIds.push(stablecoinId);
    }
  }

  return {
    complete: missingActiveIds.length === 0,
    expectedActiveCount: expectedActiveIds.length,
    presentActiveCount,
    waivedActiveCount: waivedActiveIds.length,
    missingActiveIds,
    waivedActiveIds,
    expiredWaiverIds: resolvedWaivers.expiredWaiverIds,
    invalidWaiverIds: resolvedWaivers.invalidWaiverIds,
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveFiniteNumberOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function dateSecondsOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value);
  return parsed != null && Math.abs(parsed) <= MAX_VALID_DATE_SECONDS ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function priceRejectionReason(asset: StablecoinPriceCoverageAsset | undefined): string {
  if (!asset) return "active-row-missing";
  if (asset.price == null) return "no-accepted-price";
  if (typeof asset.price !== "number" || !Number.isFinite(asset.price)) return "invalid-price";
  if (asset.price <= 0) return "non-positive-price";
  return "price-not-accepted";
}

function acceptedObservation(asset: StablecoinPriceCoverageAsset | undefined): {
  price: number;
  source: string | null;
  observedAt: number | null;
} | null {
  const price = positiveFiniteNumberOrNull(asset?.price);
  if (price == null) return null;
  return {
    price,
    source: stringOrNull(asset?.priceSource),
    observedAt: dateSecondsOrNull(asset?.priceObservedAt ?? asset?.priceUpdatedAt),
  };
}

const WORKER_ACTIVE_IDS = WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id);

export function parseMissingActivePriceDetail(
  value: unknown,
  options: { nowSec?: number; reviewsById?: ReadonlyMap<string, StablecoinPriceGapReview> } = {},
): MissingActivePriceDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.stablecoinId !== "string") return null;
  const consecutiveMissingGenerations = Math.max(
    1,
    Math.floor(finiteNumberOrNull(entry.consecutiveMissingGenerations) ?? 1),
  );
  // Registry truth at read time: a persisted acknowledgement is never trusted,
  // so a registry edit or an expired review takes effect immediately.
  const review = positiveFiniteNumberOrNull(entry.currentPrice) != null
    ? null
    : options.reviewsById
      ? options.reviewsById.get(entry.stablecoinId) ?? null
      : activePriceGapReviewForId(entry.stablecoinId, options.nowSec ?? Math.floor(Date.now() / 1000));
  return {
    stablecoinId: entry.stablecoinId,
    symbol: stringOrNull(entry.symbol) ?? entry.stablecoinId,
    marketCapUsd: finiteNumberOrNull(entry.marketCapUsd),
    currentPrice: finiteNumberOrNull(entry.currentPrice),
    currentSource: stringOrNull(entry.currentSource),
    currentObservedAt: dateSecondsOrNull(entry.currentObservedAt),
    currentConfidence: stringOrNull(entry.currentConfidence),
    consecutiveMissingGenerations,
    lastAcceptedPrice: positiveFiniteNumberOrNull(entry.lastAcceptedPrice),
    lastAcceptedSource: stringOrNull(entry.lastAcceptedSource),
    lastAcceptedObservedAt: dateSecondsOrNull(entry.lastAcceptedObservedAt),
    rejectionReason: stringOrNull(entry.rejectionReason) ?? "no-accepted-price",
    alertEligible: review == null
      && (entry.alertEligible === true
        || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS),
    acknowledgedGap: review == null ? null : acknowledgementFromReview(review),
  };
}

export function parsePersistedMissingActivePriceState(
  value: unknown,
  options: { nowSec?: number; reviewsById?: ReadonlyMap<string, StablecoinPriceGapReview> } = {},
): MissingActivePriceDetail | null {
  if (!Array.isArray(value) || value.length < 6 || typeof value[0] !== "string") return null;
  const consecutiveMissingGenerations = Math.max(
    1,
    Math.floor(finiteNumberOrNull(value[1]) ?? 1),
  );
  const review = options.reviewsById
    ? options.reviewsById.get(value[0]) ?? null
    : activePriceGapReviewForId(value[0], options.nowSec ?? Math.floor(Date.now() / 1000));
  return {
    stablecoinId: value[0],
    symbol: ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(value[0]) ?? value[0],
    marketCapUsd: null,
    currentPrice: null,
    currentSource: null,
    currentObservedAt: null,
    currentConfidence: null,
    consecutiveMissingGenerations,
    lastAcceptedPrice: positiveFiniteNumberOrNull(value[2]),
    lastAcceptedSource: stringOrNull(value[3]),
    lastAcceptedObservedAt: dateSecondsOrNull(value[4]),
    rejectionReason: stringOrNull(value[5]) ?? "no-accepted-price",
    alertEligible: review == null
      && consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS,
    acknowledgedGap: review == null ? null : acknowledgementFromReview(review),
  };
}

function parsePreviousCoverageMetadata(metadataJson: string): PreviousStablecoinActivePriceCoverage | null {
  try {
    const metadata = parseJsonObject(metadataJson, { onFailure: () => undefined });
    if (!metadata) return null;
    const rawCoverage = metadata.activePriceCoverage;
    if (!rawCoverage || typeof rawCoverage !== "object" || Array.isArray(rawCoverage)) return null;
    const coverage = rawCoverage as Record<string, unknown>;
    const parseOptions = {
      reviewsById: resolveStablecoinPriceGapReviews(WORKER_ACTIVE_IDS, Math.floor(Date.now() / 1000)).activeById,
    };
    const missingActiveIds = Array.isArray(coverage.missingActiveIds)
      ? coverage.missingActiveIds
          .filter((id): id is string => typeof id === "string")
          .slice(0, WORKER_ACTIVE_STABLECOINS.length)
      : [];
    const verboseDetails = Array.isArray(coverage.missingActiveAssets)
      ? coverage.missingActiveAssets
          .map((value) => parseMissingActivePriceDetail(value, parseOptions))
          .filter((detail): detail is MissingActivePriceDetail => detail != null)
      : [];
    const compactedDetails = Array.isArray(coverage.missingActiveState)
      ? coverage.missingActiveState
          .slice(0, WORKER_ACTIVE_STABLECOINS.length)
          .map((value) => parsePersistedMissingActivePriceState(value, parseOptions))
          .filter((detail): detail is MissingActivePriceDetail => detail != null)
      : [];
    const detailsById = new Map(compactedDetails.map((detail) => [detail.stablecoinId, detail] as const));
    for (const detail of verboseDetails) detailsById.set(detail.stablecoinId, detail);
    const missingActiveAssets = missingActiveIds
      .map((stablecoinId) => detailsById.get(stablecoinId))
      .filter((detail): detail is MissingActivePriceDetail => detail != null);
    return { missingActiveIds, missingActiveAssets };
  } catch {
    return null;
  }
}

function boundedStateString(value: string | null): string | null {
  return value == null ? null : value.slice(0, 40);
}

export function compactStablecoinActivePriceCoverage(
  coverage: StablecoinActivePriceCoverage,
  retainedDetailCount: number,
): CompactedStablecoinActivePriceCoverage {
  return {
    ...coverage,
    missingActiveAssets: coverage.missingActiveAssets.slice(0, retainedDetailCount),
    missingActiveAssetsTruncated: Math.max(0, coverage.missingActiveAssets.length - retainedDetailCount),
    missingActiveState: coverage.missingActiveAssets.map((detail) => [
      detail.stablecoinId,
      detail.consecutiveMissingGenerations,
      detail.lastAcceptedPrice,
      boundedStateString(detail.lastAcceptedSource),
      detail.lastAcceptedObservedAt,
      boundedStateString(detail.rejectionReason) ?? "no-accepted-price",
    ]),
  };
}

/** Reads the latest earlier published generation that persisted active price
 * coverage. Rows without this report (for example, aborted/no-write attempts)
 * do not reset a real publication-gap streak. */
export async function loadPreviousStablecoinActivePriceCoverage(
  db: D1Database,
  beforeStartedAt: number,
): Promise<PreviousStablecoinActivePriceCoverage | null> {
  try {
    const row = await db.prepare(
      `SELECT metadata
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
          AND started_at < ?
          AND metadata IS NOT NULL
          AND metadata LIKE '%"activePriceCoverage"%'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ).bind(beforeStartedAt).first<{ metadata: string }>();
    return row?.metadata ? parsePreviousCoverageMetadata(row.metadata) : null;
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[sync-stablecoins] Failed to load previous active price coverage:", error);
    return null;
  }
}

function marketCapOrNull(asset: StablecoinPriceCoverageAsset | undefined): number | null {
  if (!asset?.circulating) return null;
  const hasFiniteBucket = Object.values(asset.circulating).some(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  return hasFiniteBucket ? getCirculatingRaw(asset) : null;
}

/** Price coverage is intentionally independent of row publication coverage.
 * A published active row with a null, zero, negative, or non-finite price is
 * still a public data-quality failure, but it must not block cache publication. */
export function evaluateStablecoinActivePriceCoverage(
  assets: Iterable<StablecoinPriceCoverageAsset>,
  expectedActiveIds: readonly string[] = WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
  options: StablecoinActivePriceCoverageOptions = {},
): StablecoinActivePriceCoverage {
  const assetsById = new Map<string, StablecoinPriceCoverageAsset>();
  for (const asset of assets) {
    assetsById.set(asset.id, asset);
  }

  const pricedActiveIds: string[] = [];
  const missingActiveIds: string[] = [];
  const missingActiveAssets: MissingActivePriceDetail[] = [];
  const alertEligibleIds: string[] = [];
  const acknowledgedGapIds: string[] = [];
  const previousMissingIds = new Set(options.previousCoverage?.missingActiveIds ?? []);
  const previousMissingDetailsById = new Map(
    (options.previousCoverage?.missingActiveAssets ?? []).map((detail) => [detail.stablecoinId, detail] as const),
  );
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const resolvedReviews = resolveStablecoinPriceGapReviews(
    expectedActiveIds,
    nowSec,
    options.priceGapReviews,
  );
  let presentActiveCount = 0;
  let affectedMarketCapUsd = 0;
  let maxConsecutiveMissingGenerations = 0;

  for (const stablecoinId of expectedActiveIds) {
    const asset = assetsById.get(stablecoinId);
    if (asset) presentActiveCount++;

    const currentPrice = finiteNumberOrNull(asset?.price);
    if (currentPrice != null && currentPrice > 0) {
      pricedActiveIds.push(stablecoinId);
      continue;
    }

    const marketCapUsd = marketCapOrNull(asset);
    if (marketCapUsd != null && marketCapUsd > 0) {
      affectedMarketCapUsd += marketCapUsd;
    }
    const previousDetail = previousMissingDetailsById.get(stablecoinId);
    const previousStreak = previousMissingIds.has(stablecoinId)
      ? Math.max(1, previousDetail?.consecutiveMissingGenerations ?? 1)
      : 0;
    const consecutiveMissingGenerations = previousStreak + 1;
    const previousAccepted = acceptedObservation(options.previousAcceptedAssetsById?.get(stablecoinId));
    const lastAcceptedPrice = previousAccepted?.price ?? previousDetail?.lastAcceptedPrice ?? null;
    const lastAcceptedSource = previousAccepted?.source ?? previousDetail?.lastAcceptedSource ?? null;
    const lastAcceptedObservedAt = previousAccepted?.observedAt ?? previousDetail?.lastAcceptedObservedAt ?? null;
    const acknowledgedReview = resolvedReviews.activeById.get(stablecoinId) ?? null;
    if (acknowledgedReview) acknowledgedGapIds.push(stablecoinId);
    const alertEligible = acknowledgedReview == null
      && consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS;
    if (alertEligible) alertEligibleIds.push(stablecoinId);
    maxConsecutiveMissingGenerations = Math.max(
      maxConsecutiveMissingGenerations,
      consecutiveMissingGenerations,
    );
    missingActiveIds.push(stablecoinId);
    missingActiveAssets.push({
      stablecoinId,
      symbol: stringOrNull(asset?.symbol)
        ?? ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(stablecoinId)
        ?? stablecoinId,
      marketCapUsd,
      currentPrice,
      currentSource: typeof asset?.priceSource === "string" ? asset.priceSource : null,
      currentObservedAt: dateSecondsOrNull(asset?.priceObservedAt ?? asset?.priceUpdatedAt),
      currentConfidence: typeof asset?.priceConfidence === "string" ? asset.priceConfidence : null,
      consecutiveMissingGenerations,
      lastAcceptedPrice,
      lastAcceptedSource,
      lastAcceptedObservedAt,
      rejectionReason: priceRejectionReason(asset),
      alertEligible,
      acknowledgedGap: acknowledgedReview == null ? null : acknowledgementFromReview(acknowledgedReview),
    });
  }

  return {
    complete: missingActiveIds.length === 0,
    expectedActiveCount: expectedActiveIds.length,
    presentActiveCount,
    pricedActiveCount: pricedActiveIds.length,
    missingPriceCount: missingActiveIds.length,
    pricedActiveIds,
    missingActiveIds,
    affectedMarketCapUsd,
    missingActiveAssets,
    alertEligibleCount: alertEligibleIds.length,
    alertEligibleIds,
    acknowledgedGapIds,
    acknowledgedGapCount: acknowledgedGapIds.length,
    expiredGapReviewIds: resolvedReviews.expiredGapReviewIds,
    invalidGapReviewIds: resolvedReviews.invalidGapReviewIds,
    maxConsecutiveMissingGenerations,
  };
}
