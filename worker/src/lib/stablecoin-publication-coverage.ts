import { logWorkerEventArgs } from "./structured-log";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { numberValue } from "@shared/lib/type-guards";
import { ActivePriceCoverageHealthSchema } from "@shared/types/status/core";
import { NominalPriceReferenceSchema, type NominalPriceReference } from "@shared/types/core";
import { STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC, hasActivePriceGapMarketCapEvidence } from "@shared/lib/status-thresholds";
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

/** Reviewed price-gap acknowledgements for active stablecoins whose every
 * admissible price lane is empty. Entries are registry edits reviewed like
 * code: each needs an owner, a reason, dated public sources, and an expiry
 * within ~30 days of the review. Expired or malformed entries are ignored
 * (and reported) so their gaps alert again until renewed or resolved. */
export const STABLECOIN_PRICE_GAP_REVIEWS: readonly StablecoinPriceGapReview[] = [
  {
    stablecoinId: "hbd-hive",
    owner: "ops",
    reason:
      "Reviewed 2026-10-21 14:13 UTC: CoinGecko's fresh HBD quote is $1.87 (2026-10-21 14:12:04 UTC), above the unchanged exclusive USD upper bound of $1.19; Upbit Indonesia and Upbit HBD/BTC tickers imply $1.92 and $1.83. DefiLlama repeats the out-of-range venue price ($1.9768). The native Hive HBD/HIVE book with separately observed HIVE/USD instead implies $0.99759-$0.99760, but remains an unadmitted cross-rate: no reviewed runtime HIVE/USD dependency or native order-book depth policy exists. The max-500-level read contains 215,190.014/16,267.135 HBD posted asks/bids, not executable USD depth or pool TVL. This is unresolved venue divergence, not a harmless premium or stale-only feed. Ops must resolve the rejected upstream quote and review an identity-safe source, depth policy and USD dependency by 2026-10-24 14:13 UTC; this short source-review acknowledgement preserves the missing gap, price bounds and conversion-peg exclusion.",
    sources: [
      "https://www.coingecko.com/en/coins/hive_dollar",
      "https://api.coingecko.com/api/v3/coins/hive_dollar/tickers",
      "https://api.coingecko.com/api/v3/simple/price?ids=hive,hive_dollar&vs_currencies=usd&include_last_updated_at=true",
      "https://coins.llama.fi/prices/current/coingecko:hive_dollar",
      "https://api.hive.blog",
      "https://developers.hive.io/apidefinitions/#condenser_api.get_order_book",
    ],
    reviewedAt: Date.UTC(2026, 9, 21, 14, 13) / 1000,
    expiresAt: Date.UTC(2026, 9, 24, 14, 13) / 1000,
  },
  {
    stablecoinId: "usdn-noble",
    owner: "ops",
    reason:
      "Reviewed 2026-10-19 02:35 UTC: USDN inherits M, which inherits Wrapped M. CoinGecko wrappedm-by-m0 remains at 2026-10-19 00:39:33 UTC ($97.71 daily volume), beyond the unchanged 15-minute primary budget; its DefiLlama proxies repeat that clock. DefiLlama list assets 213 and 282 have no price, Noble USDN's own CoinGecko quote is dated 2026-05-09, and exact-contract DexScreener reads for M and USDN return no pairs. GeckoTerminal's M Ethereum pools have at most $5,069.62 liquidity and zero daily volume. wM's Solana Raydium pool has $250K-$258K liquidity and about $98 daily volume: it passes the $50K pool floor, but a lone DEX family lacks the independent corroborator required for primary promotion and is below the $1M aggregate TVL floor. Low volume is not itself a DexScreener/GeckoTerminal rejection rule. Production's M contract quote and wM Jupiter/low-volume marks remain fallback evidence; inheritance rejects fallback-confidence parents. Keep USDN missing, preserve all source admission gates, and have ops establish an admissible independent observed market or re-review within seven days. M0 parity and reserve NAV are not observed prices.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=wrappedm-by-m0,noble-dollar-usdn&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/wrappedm-by-m0/tickers",
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      "https://coins.llama.fi/prices/current/coingecko:wrappedm-by-m0,coingecko:noble-dollar-usdn,ethereum:0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
      "https://api.dexscreener.com/token-pairs/v1/noble/uusdn",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b/pools",
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp/pools",
      "https://api.jup.ag/price/v3?ids=mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp,mzerokyEX9TNDoK4o2YZQBDmMzjokAeN6M2g2S3pLJo",
    ],
    reviewedAt: Date.UTC(2026, 9, 19, 2, 35, 17) / 1000,
    expiresAt: Date.UTC(2026, 9, 26, 2, 35, 17) / 1000,
  },
  {
    stablecoinId: "usdk-kast",
    owner: "ops",
    reason:
      "Reviewed 2026-10-19 02:35 UTC: USDK inherits Wrapped M, whose CoinGecko wrappedm-by-m0 observation remains at 2026-10-19 00:39:33 UTC ($97.71 daily volume), beyond the unchanged 15-minute primary budget; DefiLlama's wM proxies repeat that clock. Exact Solana USDK DexScreener returns no pairs, GeckoTerminal returns no exact-token market (404), and Jupiter returns no USDK quote. M/USDN DefiLlama list prices are null. The only substantial exact wM pool is Solana Raydium CsMzKUUJNoAoU7N4zh3hAS6qcByU81TcQMPJqCdmmcEF, with $250K-$258K liquidity and about $98 daily volume: it passes the $50K pool floor, but lacks another DEX family or hard-source corroborator for primary promotion and is below the $1M aggregate TVL floor. Low volume is not itself a DexScreener/GeckoTerminal rejection rule; reviewed EVM pools are below the liquidity floor. wM's Jupiter and low-volume CoinGecko marks are fallback evidence, and inheritance rejects fallback-confidence parents. Keep USDK missing, preserve all source admission gates, and have ops establish an admissible independent observed market or re-review within seven days. M0 parity and reserve NAV are not observed prices.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=wrappedm-by-m0&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/wrappedm-by-m0/tickers",
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      "https://coins.llama.fi/prices/current/coingecko:wrappedm-by-m0,ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291",
      "https://api.dexscreener.com/token-pairs/v1/solana/usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX",
      "https://api.dexscreener.com/token-pairs/v1/solana/mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp",
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX/pools",
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp/pools",
      "https://api.jup.ag/price/v3?ids=usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX,mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp",
    ],
    reviewedAt: Date.UTC(2026, 9, 19, 2, 35, 17) / 1000,
    expiresAt: Date.UTC(2026, 9, 26, 2, 35, 17) / 1000,
  },
  {
    stablecoinId: "wusd-worldwide",
    owner: "ops",
    reason:
      "Reviewed 2026-10-21 14:13 UTC: CoinGecko worldwide-usd remains dated 2026-08-21 22:51:40 UTC with zero tickers; DefiLlama list price is null and its coins API supplies no WUSD quote. Exact current-contract Ethereum/Polygon/Viction DexScreener reads are empty. GeckoTerminal's largest returned pools hold only $313.26/$1,132.36/$451.76 respectively, below the unchanged $50K per-pool floor. The documented wallet.wspn.io still resolves to an NXDOMAIN load-balancer target; no operational issuer quote or bank settlement was observed. WSPN's completed 2024 contract migration does not establish current redemption or termination. Ops retains the October 23 lifecycle/route decision deadline; this new five-day source review only acknowledges the unresolved price gap until October 26 14:13 UTC and does not extend or satisfy that lifecycle decision. Require an exact-token operational issuer route or qualifying market, retaining active missing-price monitoring and all admission gates.",
    sources: [
      "https://www.mexc.com/announcements/article/mexc-completes-the-wspn-wusd-contract-swap-17827791520755",
      "https://support.coins.ph/hc/en-us/articles/60655699647641-WUSD-Delisting-on-August-4-2026",
      "https://stablecoins.llama.fi/stablecoin/234",
      "https://api.coingecko.com/api/v3/simple/price?ids=worldwide-usd&vs_currencies=usd&include_last_updated_at=true",
      "https://coins.llama.fi/prices/current/coingecko:worldwide-usd",
      "https://api.coingecko.com/api/v3/coins/worldwide-usd/tickers",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
      "https://api.dexscreener.com/token-pairs/v1/polygon/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41/pools",
      "https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41/pools",
      "https://api.geckoterminal.com/api/v2/networks/tomochain/tokens/0xba73e59f11597c1c13b0d9114688efb6a6d430f6/pools",
      "https://developer.wspn.io/5768563m0.md",
      "https://developer.wspn.io/5778215m0.md",
      "https://developer.wspn.io/248520713e0.md",
      "https://developer.wspn.io/6223538m0.md",
      "https://dns.google/resolve?name=wallet.wspn.io&type=A",
    ],
    reviewedAt: Date.UTC(2026, 9, 21, 14, 13) / 1000,
    expiresAt: Date.UTC(2026, 9, 26, 14, 13) / 1000,
  },
  {
    stablecoinId: "pht-pht",
    owner: "ops",
    reason:
      "Re-reviewed 2026-10-19 07:21 UTC using the October 19 source captures: CoinGecko pht-stablecoin remains dated 2026-08-14 17:36:40 UTC with no tickers. Exact APACX Polygon DexScreener now returns QuickSwap V3 PHT/USDC 0xbfb7ac32af23b8b5d892ef4c6e366dd47484da08 ($46,409.29 liquidity, $5.63/24h) and Balancer PHT/USDC 0x9d4d778575160653e331f1597138a71c7c9a2595 ($9,753.36, $5.62/24h). Both fail the unchanged $50K per-pool liquidity floor; sparse turnover is not an extra DexScreener volume floor. Ethereum/Tron exact reads remain empty and the Ethereum GT pool holds only $25.15. APACX own-CDP repayment and MoneyBees OTC marketing establish no verified ordinary-holder PHP cash-out quote; an undated FX index is not a PHT price. Keep active, permit the existing exact-DEX lane to recover only on qualifying identity-safe evidence with PHP/FX context, and decide the remaining source/holder-exit questions by October 25 23:45 UTC without a deadline extension or nominal parity substitute.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=pht-stablecoin&vs_currencies=usd&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/pht-stablecoin/tickers",
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      "https://coins.llama.fi/prices/current/coingecko:pht-stablecoin",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xbe370ad45d44eb45174c4ec60b88839fef32c077",
      "https://api.dexscreener.com/token-pairs/v1/polygon/0xe75220cb014dfb2d354bb59be26d7458bb8d0706",
      "https://api.dexscreener.com/token-pairs/v1/tron/TXdN5fvFjCdqjWJRvWmBzSRLBN7JLYmmrs",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xbe370ad45d44eb45174c4ec60b88839fef32c077/pools",
      "https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/0xe75220cb014dfb2d354bb59be26d7458bb8d0706/pools",
      "https://api.mexc.com/api/v3/ticker/24hr?symbol=PHTUSDT",
      "https://docs.apacx.io/what-is-pht/pht-overview.md",
      "https://docs.apacx.io/technical-references/contract-addresses.md",
      "https://docs.apacx.io/user-guides/mint-redeem-and-bridge-pht.md",
      "https://docs.apacx.io/user-guides/pht-onramp-and-offramp.md",
      "https://www.moneybees.ph/terms/",
    ],
    reviewedAt: Date.UTC(2026, 9, 19, 7, 21, 45) / 1000,
    expiresAt: Date.UTC(2026, 9, 25, 23, 45) / 1000,
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
    stablecoinId: "bnusd-balanced",
    owner: "ops",
    reason:
      "Reviewed 2026-10-21 14:13 UTC: this identity tracks ICON Balanced v1 bnUSD(old), not the distinct Sonic successor. DefiLlama list/detail 204 price is null and the coins API has no balanced-dollars quote. CoinGecko remains dated 2026-06-26 20:26:20 UTC ($0.96769) with zero tickers; exact ICON/Base/Arbitrum/BSC DexScreener reads return no pairs. Official Balanced migration instructions still describe 1:1 old/new migration on ICON, Stellar and Sui, with other legacy chains requiring bridging first. That advertised migration is not an observed market price or an executed claim valuation. No independently reviewed sICX/USD dependency and native pool adapter exists. Ops must review an identity-safe observed market or executable migration-claim route, or make a freeze decision by October 28 14:13 UTC; preserve the missing price and all source admission guards. Do not apply the successor's price to bnUSD(old) or infer an unsupported migration termination date.",
    sources: [
      "https://docs.balanced.network/migrate-assets",
      "https://github.com/icon-project/sodax-sdks/blob/main/packages/sdk/docs/MIGRATION.md",
      "https://stablecoins.llama.fi/stablecoin/204",
      "https://coins.llama.fi/prices/current/coingecko:balanced-dollars",
      "https://api.coingecko.com/api/v3/simple/price?ids=balanced-dollars&vs_currencies=usd&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/balanced-dollars/tickers",
      "https://api.dexscreener.com/token-pairs/v1/icon/cx88fd7df7ddff82f7cc735c871dc519838cb235bb",
      "https://api.dexscreener.com/token-pairs/v1/base/0x78b7cd9308287deb724527d8703c889e2d6c3708",
      "https://api.dexscreener.com/token-pairs/v1/arbitrum/0xa67f4b09eed22f8201ee0637cbe9d654e63f946e",
      "https://api.dexscreener.com/token-pairs/v1/bsc/0xc65132325bd4fcf2ec5f3a9375487163b6999206",
    ],
    reviewedAt: Date.UTC(2026, 9, 21, 14, 13) / 1000,
    expiresAt: Date.UTC(2026, 9, 28, 14, 13) / 1000,
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
    stablecoinId: "cadm-mento",
    weeklyUtcWindow: { start: 5 * 86_400 + 21 * 3600, end: 23 * 3600 },
    owner: "ops",
    reason:
      "Reviewed 2026-10-18 23:45 UTC: Mento's recurring weekend FX closure empties the CADm Broker route for Celo token 0xff4ab19391af240c311c54200a492233052b6325 and sortedOracles feed 0x20869cf54ead821c45dfb2ab0c23d2e10fbb65a4. At canonical block 80462413 (2026-10-18 22:39:31 UTC), Broker 0x777a8255ca72412f0d706dc03c9d1987306b4cad through manager 0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901 reverted 'no valid median'; the median stopped Friday 2026-10-16 20:57:15 UTC and isOldestReportExpired was true. Rechecked after Sunday reopen at canonical block 80466200 (23:42:38 UTC, matching opening/closing hash): median 23:41:09 UTC, expired false, executable quote 0.70685260828 USDm per CADm. CoinGecko celo-canadian-dollar remains dated 2026-09-30 20:37:20 UTC with no tickers, so no alternate weekend market is assumed. Acknowledge only Friday 21:00 to Sunday 23:00 UTC; weekday failures and expiry must alert, with no oracle freshness or price-floor changes.",
    sources: [
      "https://forno.celo.org",
      "https://celoscan.io/block/80462413",
      "https://celoscan.io/block/80466200",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/BiPoolManager.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/OracleAdapter.sol",
      "https://docs.mento.org/mento-v3/build/deployments/addresses",
      "https://www.coingecko.com/en/coins/celo-canadian-dollar",
    ],
    reviewedAt: Date.UTC(2026, 9, 18, 23, 45) / 1000,
    expiresAt: Date.UTC(2026, 10, 1, 22) / 1000,
  },
  {
    stablecoinId: "audm-mento",
    weeklyUtcWindow: { start: 5 * 86_400 + 21 * 3600, end: 23 * 3600 },
    owner: "ops",
    reason:
      "Reviewed 2026-10-18 23:45 UTC: Mento's recurring weekend FX closure empties the AUDm Broker route for Celo token 0x7175504c455076f15c04a2f90a8e352281f492f9 and sortedOracles feed 0x646bd504c3864ea5b8a6b6d25743721f61864a07. At canonical block 80462413 (2026-10-18 22:39:31 UTC), Broker 0x777a8255ca72412f0d706dc03c9d1987306b4cad through manager 0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901 reverted 'no valid median'; the median stopped Friday 2026-10-16 20:58:15 UTC and isOldestReportExpired was true. Rechecked after Sunday reopen at canonical block 80466200 (23:42:38 UTC, matching opening/closing hash): median 23:42:07 UTC, expired false, executable quote 0.6957548 USDm per AUDm. CoinGecko celo-australian-dollar remains dated 2026-09-25 18:54:50 UTC with no tickers, so no alternate weekend market is assumed. Acknowledge only Friday 21:00 to Sunday 23:00 UTC; weekday failures and expiry must alert, with no oracle freshness or price-floor changes.",
    sources: [
      "https://forno.celo.org",
      "https://celoscan.io/block/80462413",
      "https://celoscan.io/block/80466200",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/BiPoolManager.sol",
      "https://github.com/mento-protocol/mento-core/blob/main/contracts/oracles/OracleAdapter.sol",
      "https://docs.mento.org/mento-v3/build/deployments/addresses",
      "https://www.coingecko.com/en/coins/celo-australian-dollar",
    ],
    reviewedAt: Date.UTC(2026, 9, 18, 23, 45) / 1000,
    expiresAt: Date.UTC(2026, 10, 1, 22) / 1000,
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
  {
    stablecoinId: "usdfc-secured-finance",
    owner: "ops",
    reason:
      "Reviewed 2026-10-23 06:36 UTC: CoinGecko usdfc remains dated 2026-10-14 18:27:04 UTC ($0.950358, $4,568 daily volume) with zero tickers, beyond the unchanged freshness budget. DefiLlama list asset 248 has a null price and the coins API returns no quote for filecoin:0x80b98d3aa09ffff255c3ba4a241111ff1262f045. Exact-contract DexScreener returns no pairs. GeckoTerminal/CoinGecko Onchain report $105,709 total reserves but a null token price, so the address lane rejects it as missing-quote. The SushiSwap v3 USDFC/WFIL pool ($180,520 reserves) passes the $50K pool floor but shows zero 24h volume, and pricing it needs an exact-pool adapter plus a reviewed FIL/USD dependency that do not exist. Keep USDFC missing, preserve all admission gates, and have ops establish an admissible observed market or re-review within seven days. Trove redemption at $1 of oracle-valued FIL is not an observed price.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=usdfc&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/usdfc/tickers",
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      "https://coins.llama.fi/prices/current/filecoin:0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://api.dexscreener.com/token-pairs/v1/filecoin/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://api.geckoterminal.com/api/v2/networks/filecoin/tokens/0x80b98d3aa09ffff255c3ba4a241111ff1262f045/pools",
      "https://api.geckoterminal.com/api/v2/networks/filecoin/tokens/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
    ],
    reviewedAt: Date.UTC(2026, 9, 23, 6, 36) / 1000,
    expiresAt: Date.UTC(2026, 9, 30, 6, 36) / 1000,
  },
  {
    stablecoinId: "idrt-rupiah-token",
    owner: "ops",
    reason:
      "Reviewed 2026-10-23 13:57 UTC: CoinGecko rupiah-token ($0.00005421) is dated 2026-10-16 13:09:29 UTC, so it crossed the seven-day freshness budget at about 13:50 UTC today; no live quote has been published since. DefiLlama coins API returns nothing for the Ethereum, BSC or Polygon contracts or coingecko:rupiah-token. Every IDRT DEX pool is thin: GeckoTerminal/DexScreener show the largest Ethereum pool (IDRT/USDC) at about $731 reserves, BSC under $900 and Polygon under $1,900, all far below the $50K per-pool floor, with prices scattered between $0.00003 and $0.00007. Keep IDRT missing, preserve all admission gates, and have ops re-review within seven days or once CoinGecko refreshes.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=rupiah-token&vs_currencies=usd&include_last_updated_at=true",
      "https://coins.llama.fi/prices/current/coingecko:rupiah-token,ethereum:0x998ffe1e43facffb941dc337dd0468d52ba5b48a,bsc:0x66207e39bb77e6b99aab56795c7c340c08520d83,polygon:0x554cd6bdd03214b10aafa3e0d4d42de0c5d2937b",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x998ffe1e43facffb941dc337dd0468d52ba5b48a/pools",
      "https://api.geckoterminal.com/api/v2/networks/bsc/tokens/0x66207e39bb77e6b99aab56795c7c340c08520d83/pools",
      "https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/0x554cd6bdd03214b10aafa3e0d4d42de0c5d2937b/pools",
      "https://api.dexscreener.com/latest/dex/search?q=IDRT",
    ],
    reviewedAt: Date.UTC(2026, 9, 23, 13, 57) / 1000,
    expiresAt: Date.UTC(2026, 9, 30, 13, 57) / 1000,
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

/** Reviews fail closed on invalid identity, provenance, or dates; a review
 * dated after the evaluation clock is invalid evidence. Expiry is evaluated
 * against the current clock, never persisted acknowledgement state. */
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
      || review.reviewedAt > nowSec
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

/** Absent active assets are unavailable, never zero, and every downstream job
 * handles them per asset. A gap under 1% of the expected active set is routine
 * upstream churn; up to 10% jobs still run but report the gap; above 10% it is a
 * systemic upstream failure and downstream jobs fail closed. */
export const STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE = 0.01;
export const STABLECOIN_PUBLICATION_GAP_TOLERATED_MAX_SHARE = 0.1;

export type StablecoinPublicationGapBand = "none" | "routine" | "elevated" | "systemic";

export function classifyStablecoinPublicationGap(
  coverage: Pick<StablecoinPublicationCoverage, "expectedActiveCount" | "missingActiveIds">,
): StablecoinPublicationGapBand {
  const missingCount = coverage.missingActiveIds.length;
  if (missingCount === 0) return "none";
  if (coverage.expectedActiveCount <= 0) return "systemic";
  const missingShare = missingCount / coverage.expectedActiveCount;
  if (missingShare > STABLECOIN_PUBLICATION_GAP_TOLERATED_MAX_SHARE) return "systemic";
  return missingShare < STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE ? "routine" : "elevated";
}

function positiveFiniteNumberOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function dateSecondsOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
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
  const streak = numberValue(entry.consecutiveMissingGenerations);
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
    marketCapUsd: numberValue(entry.marketCapUsd),
    lastKnownMarketCapUsd: numberValue(entry.lastKnownMarketCapUsd),
    lastKnownMarketCapObservedAt: dateSecondsOrNull(entry.lastKnownMarketCapObservedAt),
    lastKnownMarketCapSource: entry.lastKnownMarketCapSource === "publication" || entry.lastKnownMarketCapSource === "supply_history"
      ? entry.lastKnownMarketCapSource : null,
    currentPrice: numberValue(entry.currentPrice),
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
  if (!Array.isArray(value)) return null;
  const fields: readonly unknown[] = value;
  if (fields.length < 6 || typeof fields[0] !== "string") return null;
  return parseMissingActivePriceDetail({
    stablecoinId: fields[0],
    symbol: ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(fields[0]) ?? fields[0],
    consecutiveMissingGenerations: fields[1],
    lastAcceptedPrice: fields[2],
    lastAcceptedSource: fields[3],
    lastAcceptedObservedAt: fields[4],
    rejectionReason: fields[5],
    streakUnavailableReason: fields[6],
    lastKnownMarketCapUsd: fields[7],
    lastKnownMarketCapObservedAt: fields[8],
    lastKnownMarketCapSource: fields[9],
    marketCapUsd: fields[10],
    currentPrice: null,
  }, options);
}

/** Compact continuity fills absent details; the last verbose entry wins. */
export function parseMissingActivePriceDetailsById(
  coverage: Record<string, unknown>,
  options: Parameters<typeof parseMissingActivePriceDetail>[1] = {},
): Map<string, MissingActivePriceDetail> {
  const detailsById = new Map<string, MissingActivePriceDetail>();
  if (Array.isArray(coverage.missingActiveState)) {
    for (const value of coverage.missingActiveState.slice(0, WORKER_ACTIVE_IDS.length)) {
      const detail = parsePersistedMissingActivePriceState(value, options);
      if (detail) detailsById.set(detail.stablecoinId, detail);
    }
  }
  if (Array.isArray(coverage.missingActiveAssets)) {
    for (const value of coverage.missingActiveAssets) {
      const detail = parseMissingActivePriceDetail(value, options);
      if (detail) detailsById.set(detail.stablecoinId, detail);
    }
  }
  return detailsById;
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
    const detailsById = parseMissingActivePriceDetailsById(coverage, parseOptions);
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
    gap.rejectionReason === "active-row-missing" && !hasActivePriceGapMarketCapEvidence(gap, nowSec),
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

    const currentPrice = asset && isObservedPrice(asset) ? numberValue(asset.price) : null;
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
