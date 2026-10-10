import { logWorkerEventArgs } from "./structured-log";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { ActivePriceCoverageHealthSchema } from "@shared/types/status/core";
import { NominalPriceReferenceSchema, type NominalPriceReference } from "@shared/types/core";
import { STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC, getActivePriceGapMaterialityMarketCapUsd } from "@shared/lib/status-thresholds";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageGapAcknowledgement,
  ActivePriceCoverageHealth,
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
  priceObservedAtMode?: string | null;
  priceUpdatedAt?: number | null;
  nominalPriceReference?: NominalPriceReference | null;
  circulating?: Record<string, number> | null;
  supplyObservedAt?: number | null;
}

export type MissingActivePriceDetail = ActivePriceCoverageGap;

/** A dated, owned, expiring review that acknowledges one active stablecoin's
 * missing live price. The gap stays listed as missing in every coverage
 * payload; it stops being alert-eligible only while the review applies, before
 * `expiresAt`. Renewal requires a fresh review; expiry or leaving its weekly
 * window re-arms the alert. */
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
  /** UTC week seconds since Sunday 00:00; start inclusive, end exclusive. */
  weeklyUtcWindow?: { start: number; end: number };
}

/** The writer has measured current counts; only prior-generation continuity
 * can be unknown. The public reader also represents unavailable current data. */
export type StablecoinActivePriceCoverage = {
  [Key in Exclude<keyof ActivePriceCoverageHealth,
    "status" | "observedAt" | "unavailableReason" | "maxConsecutiveMissingGenerations" | "nominalReferenceMarketCapUsd" | "affectedMarketCapUsd">]-?: NonNullable<ActivePriceCoverageHealth[Key]>;
} & {
  complete: boolean;
  maxConsecutiveMissingGenerations: ActivePriceCoverageHealth["maxConsecutiveMissingGenerations"];
  nominalReferenceMarketCapUsd: number | null;
  affectedMarketCapUsd: number | null;
};

export interface PreviousStablecoinActivePriceCoverage {
  missingActiveIds: string[];
  missingActiveAssets: MissingActivePriceDetail[];
  observedAt?: number | null;
  unavailableReason?: "previous-coverage-read-failed" | "previous-coverage-malformed";
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
  consecutiveMissingGenerations: number | null,
  lastAcceptedPrice: number | null,
  lastAcceptedSource: string | null,
  lastAcceptedObservedAt: number | null,
  rejectionReason: string,
  streakUnavailableReason?: MissingActivePriceDetail["streakUnavailableReason"],
  lastKnownMarketCapUsd?: number | null,
  lastKnownMarketCapObservedAt?: number | null,
  lastKnownMarketCapSource?: MissingActivePriceDetail["lastKnownMarketCapSource"],
  marketCapUsd?: number | null,
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
    stablecoinId: "tryb-bilira",
    owner: "ops",
    reason:
      "Reviewed 2026-10-07 UTC: CoinGecko still reports its 2026-09-23 10:13:20 UTC TRYB observation, its ticker list is empty, and DefiLlama's coins quote is empty. Exact-token Base and Avalanche pools still trade, but hold at most $97.52 liquidity and $1.33 daily volume; reviewed Ethereum, BSC, Polygon and Solana DexScreener deployments have no pairs. BiLira continues to advertise 1:1 TRY conversion, which is not an observed USD market price. Renew for seven days to review upstream recovery or an identity-safe issuer/venue lane, without substituting FX parity or relaxing the existing admissibility floors.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=bilira&vs_currencies=usd&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/bilira/tickers?page=1&order=volume_desc",
      "https://coins.llama.fi/prices/current/coingecko:bilira",
      "https://api.dexscreener.com/token-pairs/v1/base/0xfb8718a69aed7726afb3f04d2bd4bfde1bdcb294",
      "https://api.dexscreener.com/token-pairs/v1/avalanche/0x564a341df6c126f90cf3ecb92120fd7190acb401",
      "https://www.bilira.co/en/product/tryb-stablecoin",
    ],
    reviewedAt: Date.UTC(2026, 9, 7, 14, 18, 5) / 1000,
    expiresAt: Date.UTC(2026, 9, 14, 14, 18, 5) / 1000,
  },
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
      "Reviewed 2026-10-07 UTC: CoinGecko still reports its 2026-09-07 observation and has no tickers; DexScreener returns no exact Hemi pairs. GeckoTerminal does show live exact-token SushiSwap VCRED/MAX trading ($16,151.78 liquidity, $59.65 daily volume), while every other returned pool holds under $100 and has zero daily volume. Those pools remain below the existing address-provider floors. The issuer site describes AI/perp vaults and portfolio access, not an exact-token NAV or redemption price; the catalog's unresolved stablecoin-mechanism warning remains independent. Renew for seven days to review an identity-safe source or listing disposition, without admitting these pool marks or relaxing floors.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=vcred&vs_currencies=usd&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/vcred/tickers",
      "https://api.dexscreener.com/token-pairs/v1/hemi/0x71881974e96152643c74a8e0214b877cfb2a0aa1",
      "https://api.geckoterminal.com/api/v2/networks/hemi/tokens/0x71881974e96152643c74a8e0214b877cfb2a0aa1/pools",
      "https://vcred.trade/",
    ],
    reviewedAt: Date.UTC(2026, 9, 7, 14, 18, 5) / 1000,
    expiresAt: Date.UTC(2026, 9, 14, 14, 18, 5) / 1000,
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
  {
    stablecoinId: "chfm-mento",
    weeklyUtcWindow: { start: 5 * 86_400 + 21 * 3600, end: 23 * 3600 },
    owner: "ops",
    reason:
      "Mento's v3 FX oracle gate closes the only executable CHFm venue every weekend: the CHFm/USDm FPMM 0xdc81135f…3e8b8 prices getAmountOut through OracleAdapter 0xa472fbbf…4383a getFXRateIfValid, which reverts FXMarketClosed (selector 0xa407143a) from Friday 21:00 UTC until Sunday 23:00 UTC (MarketHoursBreaker weekend rules), and the Chainlink-backed sortedOracles reports stop with the Friday close (last reports 2026-09-25 20:56-20:59 UTC, ~92ks stale by Saturday evening). The mento-fpmm lane therefore returns empty every weekend and re-prices automatically at the Sunday 23:00 UTC reopen (quote verified live again 2026-09-20 23:30 UTC). No admissible alternative lane exists: CoinGecko cchf is stale since 2026-07-29, DefiLlama publishes no list price, and DexScreener lists no CHFm pair. Renew while Mento keeps the weekly FX closure; a weekday gap is a different cause.",
    sources: [
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/breakers/MarketHoursBreaker.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/OracleAdapter.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/FPMM.sol",
      "https://docs.mento.org/mento-v3/build/deployments/addresses",
      "https://www.coingecko.com/en/coins/cchf",
    ],
    reviewedAt: Date.UTC(2026, 8, 27) / 1000,
    expiresAt: Date.UTC(2026, 9, 25) / 1000,
  },
  {
    stablecoinId: "copm-mento",
    weeklyUtcWindow: { start: 5 * 86_400 + 21 * 3600, end: 23 * 3600 },
    owner: "ops",
    reason:
      "Mento's weekend FX closure also empties the only executable COPm lane: Broker 0x777a8255…b4cad getAmountOut on the COPm/USDm BiPoolManager exchange reverts 'no valid median' because sortedOracles reports for feed 0x0196d1f4…39f1 stop at the Friday close (last report 2026-09-25 20:58 UTC, isOldestReportExpired true, median ~92ks stale by Saturday evening) and resume only at the Sunday 23:00 UTC reopen (fresh median verified 2026-09-20 23:30 UTC). The mento-broker lane re-prices COPm automatically after the reopen. No admissible alternative lane exists: CoinGecko ccop is stale since 2026-08-16 and DexScreener's COPm pools hold at most $373 liquidity against the $50K address-provider floor. Renew while Mento keeps the weekly FX closure; a weekday gap is a different cause.",
    sources: [
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/BiPoolManager.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/OracleAdapter.sol",
      "https://docs.mento.org/mento-v3/build/deployments/addresses",
      "https://www.coingecko.com/en/coins/ccop",
    ],
    reviewedAt: Date.UTC(2026, 8, 27) / 1000,
    expiresAt: Date.UTC(2026, 9, 25) / 1000,
  },
  {
    stablecoinId: "jpym-mento",
    weeklyUtcWindow: { start: 5 * 86_400 + 21 * 3600, end: 23 * 3600 },
    owner: "ops",
    reason:
      "Mento's weekend FX closure empties the only executable JPYm lane (pricing 6.39 moved JPYm off nominal par onto mento-fpmm): the JPYm/USDm FPMM 0x9861f6d2…2b2b41 getAmountOut reverts FXMarketClosed (selector 0xa407143a) through the same OracleAdapter gate as CHFm, verified at 2026-09-26 12:00 UTC (block 78523242) and 2026-09-27 12:00 UTC, and quotes again on weekdays (0.00635164772 USDm per JPYm at 2026-09-28 12:00 UTC). The mento-fpmm lane re-prices JPYm automatically after the Sunday 23:00 UTC reopen. No admissible alternative lane exists: CoinGecko celo-japanese-yen is stale since 2026-08-19 and has no other tracked venue. Renew while Mento keeps the weekly FX closure; a weekday gap is a real lane failure.",
    sources: [
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/breakers/MarketHoursBreaker.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/OracleAdapter.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/FPMM.sol",
      "https://docs.mento.org/mento-v3/build/deployments/addresses",
      "https://www.coingecko.com/en/coins/celo-japanese-yen",
    ],
    reviewedAt: Date.UTC(2026, 8, 28) / 1000,
    expiresAt: Date.UTC(2026, 9, 25) / 1000,
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
      || (review.weeklyUtcWindow != null && (!Number.isInteger(review.weeklyUtcWindow.start)
        || !Number.isInteger(review.weeklyUtcWindow.end)
        || review.weeklyUtcWindow.start < 0 || review.weeklyUtcWindow.start >= 7 * 86_400
        || review.weeklyUtcWindow.end < 0 || review.weeklyUtcWindow.end >= 7 * 86_400
        || review.weeklyUtcWindow.start === review.weeklyUtcWindow.end))
    ) {
      invalidGapReviewIds.add(review.stablecoinId);
      continue;
    }
    if (review.expiresAt <= nowSec) {
      expiredGapReviewIds.add(review.stablecoinId);
      continue;
    }
    if (review.weeklyUtcWindow) {
      const clock = new Date(nowSec * 1000);
      const weekSecond = clock.getUTCDay() * 86_400 + clock.getUTCHours() * 3600
        + clock.getUTCMinutes() * 60 + clock.getUTCSeconds();
      const { start, end } = review.weeklyUtcWindow;
      if (!(start < end ? weekSecond >= start && weekSecond < end : weekSecond >= start || weekSecond < end)) continue;
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
  if (!isObservedPrice(asset)) return "non-observed-price";
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
  if (!asset || !isObservedPrice(asset) || price == null) return null;
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
  const streak = finiteNumberOrNull(entry.consecutiveMissingGenerations);
  const consecutiveMissingGenerations = streak != null && Number.isInteger(streak) && streak >= 1 ? streak : null;
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
    lastKnownMarketCapUsd: finiteNumberOrNull(entry.lastKnownMarketCapUsd),
    lastKnownMarketCapObservedAt: dateSecondsOrNull(entry.lastKnownMarketCapObservedAt),
    lastKnownMarketCapSource: entry.lastKnownMarketCapSource === "publication" || entry.lastKnownMarketCapSource === "supply_history"
      ? entry.lastKnownMarketCapSource : null,
    currentPrice: finiteNumberOrNull(entry.currentPrice),
    currentSource: stringOrNull(entry.currentSource),
    currentObservedAt: dateSecondsOrNull(entry.currentObservedAt),
    currentConfidence: stringOrNull(entry.currentConfidence),
    consecutiveMissingGenerations,
    streakUnavailableReason: consecutiveMissingGenerations == null
      ? entry.streakUnavailableReason === "previous-coverage-read-failed"
        ? "previous-coverage-read-failed" : "previous-coverage-malformed"
      : null,
    lastAcceptedPrice: positiveFiniteNumberOrNull(entry.lastAcceptedPrice),
    lastAcceptedSource: stringOrNull(entry.lastAcceptedSource),
    lastAcceptedObservedAt: dateSecondsOrNull(entry.lastAcceptedObservedAt),
    rejectionReason: stringOrNull(entry.rejectionReason) ?? "no-accepted-price",
    alertEligible: review == null
      && (consecutiveMissingGenerations == null
        || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS),
    acknowledgedGap: review == null ? null : acknowledgementFromReview(review),
  };
}

export function parsePersistedMissingActivePriceState(
  value: unknown,
  options: { nowSec?: number; reviewsById?: ReadonlyMap<string, StablecoinPriceGapReview> } = {},
): MissingActivePriceDetail | null {
  if (!Array.isArray(value) || value.length < 6 || typeof value[0] !== "string") return null;
  const streak = finiteNumberOrNull(value[1]);
  const consecutiveMissingGenerations = streak != null && Number.isInteger(streak) && streak >= 1 ? streak : null;
  const review = options.reviewsById
    ? options.reviewsById.get(value[0]) ?? null
    : activePriceGapReviewForId(value[0], options.nowSec ?? Math.floor(Date.now() / 1000));
  return {
    stablecoinId: value[0],
    symbol: ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(value[0]) ?? value[0],
    marketCapUsd: finiteNumberOrNull(value[10]),
    lastKnownMarketCapUsd: finiteNumberOrNull(value[7]),
    lastKnownMarketCapObservedAt: dateSecondsOrNull(value[8]),
    lastKnownMarketCapSource: value[9] === "publication" ? "publication"
      : value[9] === "supply_history" ? "supply_history" : null,
    currentPrice: null,
    currentSource: null,
    currentObservedAt: null,
    currentConfidence: null,
    consecutiveMissingGenerations,
    streakUnavailableReason: consecutiveMissingGenerations == null
      ? value[6] === "previous-coverage-read-failed"
        ? "previous-coverage-read-failed" : "previous-coverage-malformed"
      : null,
    lastAcceptedPrice: positiveFiniteNumberOrNull(value[2]),
    lastAcceptedSource: stringOrNull(value[3]),
    lastAcceptedObservedAt: dateSecondsOrNull(value[4]),
    rejectionReason: stringOrNull(value[5]) ?? "no-accepted-price",
    alertEligible: review == null
      && (consecutiveMissingGenerations == null || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS),
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
    // Unknown source labels are unavailable provenance, not a malformed streak.
    // Normalize before the shared enum guard, matching the detail parser below.
    if (Array.isArray(coverage.missingActiveAssets)) {
      for (const value of coverage.missingActiveAssets) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (entry.lastKnownMarketCapSource != null
          && entry.lastKnownMarketCapSource !== "publication" && entry.lastKnownMarketCapSource !== "supply_history") {
          entry.lastKnownMarketCapSource = null;
        }
      }
    }
    if (!ActivePriceCoverageHealthSchema.safeParse({
      ...coverage, status: coverage.complete === true ? "complete" : "incomplete", observedAt: null,
    }).success) return null;
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
    if (missingActiveAssets.length !== missingActiveIds.length) return null;
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
      detail.streakUnavailableReason ?? null,
      detail.lastKnownMarketCapUsd ?? null,
      detail.lastKnownMarketCapObservedAt ?? null,
      detail.lastKnownMarketCapSource ?? null,
      detail.marketCapUsd,
    ]),
  };
}

/** Reads the latest earlier published generation that persisted active price
 * coverage. Rows without this report (for example, aborted/no-write attempts)
 * do not reset a real publication-gap streak. */
export async function loadPreviousStablecoinActivePriceCoverage(
  db: D1Database,
  beforeStartedAt: number,
): Promise<
  | { status: "ok"; coverage: PreviousStablecoinActivePriceCoverage }
  | { status: "missing" }
  | { status: "read-error"; reason: NonNullable<PreviousStablecoinActivePriceCoverage["unavailableReason"]> }
> {
  try {
    const row = await db.prepare(
      `SELECT metadata, started_at
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
          AND started_at < ?
          AND metadata IS NOT NULL
          AND metadata LIKE '%"activePriceCoverage"%'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ).bind(beforeStartedAt).first<{ metadata: string; started_at: number }>();
    if (!row) return { status: "missing" };
    const coverage = parsePreviousCoverageMetadata(row.metadata);
    return coverage ? { status: "ok", coverage: { ...coverage, observedAt: row.started_at } }
      : { status: "read-error", reason: "previous-coverage-malformed" };
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[sync-stablecoins] Failed to load previous active price coverage:", error);
    return { status: "read-error", reason: "previous-coverage-read-failed" };
  }
}

/** Producer-only bootstrap for already absent rows. One bounded existing-history read;
 * never a price replacement, new supply publication, or request-path dependency. */
export async function seedAbsentActivePriceCoverageMarketCaps(
  db: D1Database,
  coverage: StablecoinActivePriceCoverage,
  nowSec: number,
): Promise<void> {
  const gaps = coverage.missingActiveAssets.filter((gap) =>
    gap.rejectionReason === "active-row-missing" && getActivePriceGapMaterialityMarketCapUsd(gap, nowSec) == null,
  );
  if (gaps.length === 0) return;
  try {
    const rows = await db.prepare(`
      WITH absent AS (SELECT value AS stablecoin_id FROM json_each(?))
      SELECT h.stablecoin_id, h.snapshot_date, h.circulating_usd
      FROM absent
      JOIN supply_history h ON h.stablecoin_id = absent.stablecoin_id
        AND h.snapshot_date = (
          SELECT MAX(snapshot_date) FROM supply_history
          WHERE stablecoin_id = absent.stablecoin_id AND snapshot_date BETWEEN ? AND ?
        )
      LIMIT ?`).bind(
      JSON.stringify(gaps.map((gap) => gap.stablecoinId)),
      nowSec - STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC, nowSec, gaps.length,
    ).all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
    if (!rows.success) throw new Error("supply-history-cap-read-failed");
    const gapsById = new Map(gaps.map((gap) => [gap.stablecoinId, gap]));
    for (const row of rows.results ?? []) {
      const gap = gapsById.get(row.stablecoin_id);
      if (!gap || !Number.isFinite(row.circulating_usd) || row.circulating_usd < 0
        || !Number.isFinite(row.snapshot_date) || row.snapshot_date <= 0
        || row.snapshot_date > nowSec || nowSec - row.snapshot_date > STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC) continue;
      gap.lastKnownMarketCapUsd = row.circulating_usd;
      gap.lastKnownMarketCapObservedAt = row.snapshot_date;
      gap.lastKnownMarketCapSource = "supply_history";
    }
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[sync-stablecoins] Failed to seed absent-row market-cap evidence:", error);
  }
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
  const nominalReferenceIds: string[] = [];
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
  let affectedMarketCapUsd: number | null = 0;
  let nominalReferenceMarketCapUsd: number | null = 0;
  let maxConsecutiveMissingGenerations: number | null = 0;

  for (const stablecoinId of expectedActiveIds) {
    const asset = assetsById.get(stablecoinId);
    if (asset) presentActiveCount++;

    const currentPrice = asset && isObservedPrice(asset) ? finiteNumberOrNull(asset.price) : null;
    if (currentPrice != null && currentPrice > 0) {
      pricedActiveIds.push(stablecoinId);
      continue;
    }

    const marketCapUsd = getCirculatingRawOrNull(asset);
    if (NominalPriceReferenceSchema.safeParse(asset?.nominalPriceReference).success) {
      nominalReferenceIds.push(stablecoinId);
      nominalReferenceMarketCapUsd = nominalReferenceMarketCapUsd == null || marketCapUsd == null
        ? null : nominalReferenceMarketCapUsd + marketCapUsd;
      continue;
    }
    affectedMarketCapUsd = affectedMarketCapUsd == null || marketCapUsd == null
      ? null : affectedMarketCapUsd + marketCapUsd;
    const previousDetail = previousMissingDetailsById.get(stablecoinId);
    const previousStreak = options.previousCoverage?.unavailableReason
      ? null
      : previousMissingIds.has(stablecoinId)
        ? previousDetail?.consecutiveMissingGenerations ?? null
        : 0;
    const consecutiveMissingGenerations = previousStreak == null ? null : previousStreak + 1;
    const previousAccepted = acceptedObservation(options.previousAcceptedAssetsById?.get(stablecoinId));
    const previousAsset = options.previousAcceptedAssetsById?.get(stablecoinId);
    const previousCap = getCirculatingRawOrNull(previousAsset);
    const lastKnownMarketCapUsd = marketCapUsd ?? previousCap
      ?? previousDetail?.lastKnownMarketCapUsd ?? previousDetail?.marketCapUsd ?? null;
    const lastKnownMarketCapObservedAt = marketCapUsd != null
      ? dateSecondsOrNull(asset?.supplyObservedAt) ?? nowSec
      : previousCap != null
        ? dateSecondsOrNull(previousAsset?.supplyObservedAt)
        : previousDetail?.lastKnownMarketCapUsd != null
          ? previousDetail.lastKnownMarketCapObservedAt ?? null
          : options.previousCoverage?.observedAt ?? null;
    const lastKnownMarketCapSource = marketCapUsd != null || previousCap != null
      ? "publication" : previousDetail?.lastKnownMarketCapSource
        ?? (previousDetail?.marketCapUsd != null ? "publication" : null);
    const lastAcceptedPrice = previousAccepted?.price ?? previousDetail?.lastAcceptedPrice ?? null;
    const lastAcceptedSource = previousAccepted?.source ?? previousDetail?.lastAcceptedSource ?? null;
    const lastAcceptedObservedAt = previousAccepted?.observedAt ?? previousDetail?.lastAcceptedObservedAt ?? null;
    const acknowledgedReview = resolvedReviews.activeById.get(stablecoinId) ?? null;
    if (acknowledgedReview) acknowledgedGapIds.push(stablecoinId);
    const alertEligible = acknowledgedReview == null
      && (consecutiveMissingGenerations == null || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS);
    if (alertEligible) alertEligibleIds.push(stablecoinId);
    maxConsecutiveMissingGenerations = maxConsecutiveMissingGenerations == null || consecutiveMissingGenerations == null
      ? null : Math.max(maxConsecutiveMissingGenerations, consecutiveMissingGenerations);
    missingActiveIds.push(stablecoinId);
    missingActiveAssets.push({
      stablecoinId,
      symbol: stringOrNull(asset?.symbol)
        ?? ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(stablecoinId)
        ?? stablecoinId,
      marketCapUsd,
      lastKnownMarketCapUsd,
      lastKnownMarketCapObservedAt,
      lastKnownMarketCapSource,
      currentPrice,
      currentSource: typeof asset?.priceSource === "string" ? asset.priceSource : null,
      currentObservedAt: dateSecondsOrNull(asset?.priceObservedAt ?? asset?.priceUpdatedAt),
      currentConfidence: typeof asset?.priceConfidence === "string" ? asset.priceConfidence : null,
      consecutiveMissingGenerations,
      streakUnavailableReason: consecutiveMissingGenerations == null
        ? options.previousCoverage?.unavailableReason ?? previousDetail?.streakUnavailableReason ?? "previous-coverage-malformed"
        : null,
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
    nominalReferenceCount: nominalReferenceIds.length,
    nominalReferenceMarketCapUsd,
    nominalReferenceIds,
    nominalReferenceReason: "reviewed-nominal-reference",
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
