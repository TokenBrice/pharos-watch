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
  ActivePriceCoverageScheduledClosure,
  ActivePriceCoverageHealth,
} from "@shared/types/status";
import { parseJsonObject } from "./json-parse";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

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
 * `expiresAt`. Renewal requires a fresh review; expiry re-arms the alert. */
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
    stablecoinId: "wusd-worldwide",
    owner: "ops",
    reason:
      "Re-reviewed 2026-10-29 11:00 UTC with fresh GETs: CoinGecko worldwide-usd still reports $1.17 dated 2026-08-21 22:51:40 UTC with zero tickers, so the only published mark is about 69 days old and not an observed market. DefiLlama detail 234 publishes no price; its daily circulating value has been $599,283.6509 since 2026-09-30 and the latest point reports minted 0. The exact current contracts on Etherscan (max total supply 541,238.05, 653 holders) and PolygonScan (58,045.60, 101,749 holders) sum to that DefiLlama figure. Exact-contract DexScreener reads for 0x7cd017ca5ddb86861fa983a34b5f495c6f898c41 on Ethereum and Polygon are empty. GeckoTerminal returns only sub-floor pools with zero 24h volume: the largest Ethereum pool holds $235.20, the largest Polygon pool $1,135.07 and the largest Viction pool $399.12, with scattered $0.06-$1.53 marks, all below the unchanged $50K per-pool floor. The documented wallet.wspn.io still resolves only to an NXDOMAIN load-balancer CNAME. Coins.ph ended convert-sell on 2026-08-04 while allowing withdrawals; a venue delisting is not an issuer termination. Issuer channels show no end-of-life signal: wspn.io/solutions still markets WUSD's 1:1 corporate conversion and multi-chain presence, and the reviewed developer docs still describe the 1:1 reserve model. Owner decision 2026-10-29: keep active pending a primary discontinuation source; freeze if one appears. Keep the price missing; all admission gates preserved. The predecessor's October 23 lifecycle/redemption-route decision stays open with owner ops and is neither satisfied nor extended by this source review, which expires 2026-11-27 11:00 UTC.",
    sources: [
      "https://support.coins.ph/hc/en-us/articles/60655699647641-WUSD-Delisting-on-August-4-2026",
      "https://stablecoins.llama.fi/stablecoin/234",
      "https://api.coingecko.com/api/v3/simple/price?ids=worldwide-usd&vs_currencies=usd&include_last_updated_at=true",
      "https://coins.llama.fi/prices/current/coingecko:worldwide-usd,ethereum:0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
      "https://api.coingecko.com/api/v3/coins/worldwide-usd/tickers",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
      "https://api.dexscreener.com/token-pairs/v1/polygon/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41/pools",
      "https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41/pools",
      "https://api.geckoterminal.com/api/v2/networks/tomochain/tokens/0xba73e59f11597c1c13b0d9114688efb6a6d430f6/pools",
      "https://etherscan.io/token/0x7Cd017ca5ddb86861FA983a34b5F495C6F898c41",
      "https://polygonscan.com/token/0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
      "https://developer.wspn.io/5768563m0.md",
      "https://wspn.io/solutions/",
      "https://dns.google/resolve?name=wallet.wspn.io&type=A",
    ],
    reviewedAt: Date.UTC(2026, 9, 29, 11) / 1000,
    expiresAt: Date.UTC(2026, 10, 27, 11) / 1000,
  },
  {
    stablecoinId: "pht-pht",
    owner: "ops",
    reason:
      "Re-reviewed 2026-10-29 11:01 UTC: CoinGecko pht-stablecoin remains $0.01607427 dated 2026-08-14 17:36:40 UTC with zero tickers, 76 days beyond the unchanged seven-day budget. Exact Polygon DexScreener is de-indexed (empty). GeckoTerminal's Polygon read returns only QuickSwap V3 PHT/USDC 0xbfb7ac32af23b8b5d892ef4c6e366dd47484da08 ($45,272.89 reserves, $0.0156482 mark, zero 24h trades and volume) and an empty PHT/WPOL pool; $45,272.89 stays below the unchanged $50K per-pool liquidity floor, and Balancer PHT/USDC 0x9d4d778575160653e331f1597138a71c7c9a2595 now answers HTTP 404. Ethereum and Tron exact DexScreener reads are empty; the only Ethereum GeckoTerminal pool holds $25.15. MEXC PHTUSDT has no 24h ticker (HTTP 404). APACX's on-ramp/off-ramp page still advertises redeeming PHT through MoneyBees OTC for PHP, but documents no observed acceptance, rate, depth or limit, and that advertised route is not an observed PHT market. Open holder-exit question: whether an ordinary holder can in fact convert PHT to PHP at a verifiable rate and depth; owner ops must resolve it by 2026-11-10 11:01 UTC, this review's expiry. Keep PHT active and the price missing; all admission gates preserved; sparse turnover is not an extra volume floor and an undated FX index is not a PHT price.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=pht-stablecoin&vs_currencies=usd&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/pht-stablecoin/tickers",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xbe370ad45d44eb45174c4ec60b88839fef32c077",
      "https://api.dexscreener.com/token-pairs/v1/polygon/0xe75220cb014dfb2d354bb59be26d7458bb8d0706",
      "https://api.dexscreener.com/token-pairs/v1/tron/TXdN5fvFjCdqjWJRvWmBzSRLBN7JLYmmrs",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xbe370ad45d44eb45174c4ec60b88839fef32c077/pools",
      "https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/0xe75220cb014dfb2d354bb59be26d7458bb8d0706/pools",
      "https://api.geckoterminal.com/api/v2/networks/polygon_pos/pools/0x9d4d778575160653e331f1597138a71c7c9a2595",
      "https://api.mexc.com/api/v3/ticker/24hr?symbol=PHTUSDT",
      "https://docs.apacx.io/user-guides/pht-onramp-and-offramp.md",
    ],
    reviewedAt: Date.UTC(2026, 9, 29, 11, 1) / 1000,
    expiresAt: Date.UTC(2026, 10, 10, 11, 1) / 1000,
  },
  {
    stablecoinId: "usdfc-secured-finance",
    owner: "ops",
    reason:
      "Continuing-gap review from fresh GETs on 2026-10-28 09:51 UTC: CoinGecko usdfc is still $0.950358 with $4,568.26 reported 24h volume, dated 2026-10-14 18:27:04 UTC and beyond the seven-day budget; tickers are empty. DefiLlama list asset 248 has a null price and its exact Filecoin coins query returns no quote. Exact-contract DexScreener returns no pairs. GeckoTerminal and CoinGecko Onchain token/price reads return null; tokens/multi reports $105,709.42 reserves and zero 24h volume, so the address lane rejects missing-quote. Both pool lists show SushiSwap v3 USDFC/WFIL at $1.0064191704 with $180,519.60 reserves and zero 24h trades/volume, but no upstream quote clock; no exact-pool adapter or reviewed FIL/USD dependency admits that mark. The largest axlUSDC pool has only $19,097.74 reserves, below the $50K floor. No admissible market was found. Keep USDFC missing and have ops establish an admitted observed market or re-review within seven days; preserve every admission gate. Trove redemption at $1 of oracle-valued FIL is not an observed price.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=usdfc&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/usdfc/tickers",
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      "https://coins.llama.fi/prices/current/filecoin:0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://api.dexscreener.com/token-pairs/v1/filecoin/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://api.geckoterminal.com/api/v2/networks/filecoin/tokens/0x80b98d3aa09ffff255c3ba4a241111ff1262f045/pools",
      "https://api.geckoterminal.com/api/v2/networks/filecoin/tokens/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://api.geckoterminal.com/api/v2/simple/networks/filecoin/token_price/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://pro-api.coingecko.com/api/v3/onchain/networks/filecoin/tokens/multi/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://pro-api.coingecko.com/api/v3/onchain/simple/networks/filecoin/token_price/0x80b98d3aa09ffff255c3ba4a241111ff1262f045",
      "https://pro-api.coingecko.com/api/v3/onchain/networks/filecoin/tokens/0x80b98d3aa09ffff255c3ba4a241111ff1262f045/pools",
    ],
    reviewedAt: Date.UTC(2026, 9, 28, 9, 52) / 1000,
    expiresAt: Date.UTC(2026, 10, 4, 9, 52) / 1000,
  },  {
    stablecoinId: "aid-gaib",
    owner: "ops",
    reason:
      "Reviewed 2026-10-31 12:37 UTC with fresh GETs after Pricing v6.64 rejected AID's only admitted quote, a DefiLlama list price of exactly 1. DefiLlama coins also returns a flat 1 for both coingecko:gaib-aid and the Ethereum contract. CoinGecko gaib-aid reports $0.995393 with $90.47 of 24h volume, dated 2026-10-28 19:20:30 UTC (about 65 hours old), and its tickers are empty. Exact-contract DexScreener reads on Ethereum, Arbitrum, Base and BSC return no pairs. GeckoTerminal lists 20 Ethereum pools; the largest, Curve AID/USDC 0xbe739fe57b9862e9cf17835687e8c008cf8e121c, holds $1,423.29 with zero 24h volume, far below the unchanged $50K per-pool floor. No admissible market was found. Keep AID active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by this review's expiry, 2026-11-14 12:37 UTC.",
    sources: [
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      "https://coins.llama.fi/prices/current/coingecko:gaib-aid,ethereum:0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.coingecko.com/api/v3/simple/price?ids=gaib-aid&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/gaib-aid/tickers",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.dexscreener.com/token-pairs/v1/arbitrum/0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.dexscreener.com/token-pairs/v1/base/0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.dexscreener.com/token-pairs/v1/bsc/0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x18f52b3fb465118731d9e0d276d4eb3599d57596/pools",
    ],
    reviewedAt: Date.UTC(2026, 9, 31, 12, 37) / 1000,
    expiresAt: Date.UTC(2026, 10, 14, 12, 37) / 1000,
  },
  {
    stablecoinId: "deuro-deuro",
    owner: "ops",
    reason:
      "Reviewed 2026-11-01 17:21 UTC with fresh GETs: CoinGecko decentralized-euro still reports $1.15 with $3.49 of 24h volume dated 2026-08-03 23:52:30 UTC, about 90 days old, and its tickers are empty. DefiLlama coins returns no quote for coingecko:decentralized-euro, while DefiLlama detail 423 still resolves the coin and the protocol's own API mirrors the same $1.15 mark, so neither is an independent market. DexScreener's only Ethereum pair, Uniswap v4 dEURO/ETH 0x0b3bbdabfba873f51d464b7d6ab4d53c11a4a300b9a7fe765dcefae4c2f4f9d4, holds $2,421 of liquidity, and GeckoTerminal's largest pool holds $2,407.94; both stay below the unchanged $50K per-pool floor. The protocol-redeem EURC bridge 0xb4ff7412f08c22d7381885e8bda9ee9825092fd1 holds 0.000528 EURC, so the adapter's 1,000 dEURO minimum minted depth and full EURC coverage cannot pass. No admissible market was found. Keep dEURO active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by this review's expiry, 2026-11-15 17:21 UTC.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/423",
      "https://coins.llama.fi/prices/current/coingecko:decentralized-euro",
      "https://api.coingecko.com/api/v3/simple/price?ids=decentralized-euro&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/decentralized-euro/tickers",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea/pools",
      "https://eth.blockscout.com/api/v2/addresses/0xb4ff7412f08c22d7381885e8bda9ee9825092fd1/token-balances",
      "https://api.deuro.com/ecosystem/stablecoin/info",
    ],
    reviewedAt: Date.UTC(2026, 10, 1, 17, 21) / 1000,
    expiresAt: Date.UTC(2026, 10, 15, 17, 21) / 1000,
  },
  {
    stablecoinId: "fusd-finchain",
    owner: "ops",
    reason:
      "Reviewed 2026-11-01 17:21 UTC with fresh GETs: DefiLlama detail 390 still resolves FUSD but reports onCoinGecko false, and coins.llama.fi returns no quote for the Ethereum, Avalanche, Sonic or Monad deployments. CoinGecko's search for finchain returns no coins, and exact-contract DexScreener reads on Ethereum and Avalanche are empty. FinChain's own API and site still report 1,225,760.62 FUSD in circulation, so the asset is live, but the API's only ratio is the FUSDLP reserve ratio, its data clock is 2026-04-21, and it publishes no FUSD market price. No admissible market was found. Keep FUSD active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by this review's expiry, 2026-11-15 17:21 UTC.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/390",
      "https://coins.llama.fi/prices/current/ethereum:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c,avalanche:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c,sonic:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c,monad:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
      "https://api.coingecko.com/api/v3/search?query=finchain",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
      "https://api.dexscreener.com/token-pairs/v1/avalanche/0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
      "https://api.finchain.global/api/v0/fusd-data",
      "https://fusd.finchain.global/",
    ],
    reviewedAt: Date.UTC(2026, 10, 1, 17, 21) / 1000,
    expiresAt: Date.UTC(2026, 10, 15, 17, 21) / 1000,
  },
  {
    stablecoinId: "usdp-parallel",
    owner: "ops",
    reason:
      "Reviewed 2026-11-01 17:21 UTC with fresh GETs: DefiLlama coins returns no quote for coingecko:parallel-usdp or the Ethereum contract, while DefiLlama detail 291 still resolves the coin. CoinGecko parallel-usdp reports $1.001 with $997.61 of 24h volume dated 2026-10-31 07:55:26 UTC, about 33 hours old, and its only ticker, Project X USDp/USDT0, last traded 2026-10-30 23:54:16 UTC and is marked stale. Exact Ethereum DexScreener and GeckoTerminal reads are empty; the largest HyperEVM pool holds $36,177.70 with zero 24h trades and volume, and Base's USDp/frxUSD pool holds $151.85. No admissible live market was found: the CoinGecko quote is beyond the 15-minute primary budget and the asset is not in the reviewed seven-day lane. Keep USDp active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by this review's expiry, 2026-11-15 17:21 UTC.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/291",
      "https://coins.llama.fi/prices/current/coingecko:parallel-usdp,ethereum:0x9b3a8f7cec208e247d97dee13313690977e24459",
      "https://api.coingecko.com/api/v3/simple/price?ids=parallel-usdp&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/parallel-usdp/tickers",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x9b3a8f7cec208e247d97dee13313690977e24459",
      "https://api.dexscreener.com/token-pairs/v1/hyperliquid/0xbe65f0f410a72bec163dc65d46c83699e957d588",
      "https://api.dexscreener.com/token-pairs/v1/base/0x76a9a0062ec6712b99b4f63bd2b4270185759dd5",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x9b3a8f7cec208e247d97dee13313690977e24459/pools",
      "https://api.geckoterminal.com/api/v2/networks/hyperevm/tokens/0xbe65f0f410a72bec163dc65d46c83699e957d588/pools",
      "https://api.geckoterminal.com/api/v2/networks/base/tokens/0x76a9a0062ec6712b99b4f63bd2b4270185759dd5/pools",
    ],
    reviewedAt: Date.UTC(2026, 10, 1, 17, 21) / 1000,
    expiresAt: Date.UTC(2026, 10, 15, 17, 21) / 1000,
  },
  {
    stablecoinId: "xusd-babelfish",
    owner: "ops",
    reason:
      "Reviewed 2026-11-01 17:21 UTC with fresh GETs: DefiLlama coins returns no quote for coingecko:xusd-babelfish or the Rootstock contract, and DefiLlama detail 162 now reports onCoinGecko false. CoinGecko xusd-babelfish reports $0.994825 with $1,976.63 of 24h volume dated 2026-10-31 13:14:42 UTC, about 28 hours old, while its only ticker, Sovryn DEX XUSD/rBTC, last traded 2026-10-31 05:13:38 UTC and is marked stale. Exact Rootstock DexScreener and GeckoTerminal reads are empty. No admissible live market was found: the CoinGecko quote is beyond the 15-minute primary budget and the asset is not in the reviewed seven-day lane. Keep XUSD active and the price missing; all admission gates preserved. BabelFish still documents the protocol, so freezing is not indicated. Owner ops establishes an admitted observed market or re-reviews by this review's expiry, 2026-11-15 17:21 UTC.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/162",
      "https://coins.llama.fi/prices/current/rsk:0xb5999795be0ebb5bab23144aa5fd6a02d080299f,coingecko:xusd-babelfish",
      "https://api.coingecko.com/api/v3/simple/price?ids=xusd-babelfish&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/xusd-babelfish/tickers",
      "https://api.dexscreener.com/token-pairs/v1/rootstock/0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://api.geckoterminal.com/api/v2/networks/rootstock/tokens/0xb5999795be0ebb5bab23144aa5fd6a02d080299f/pools",
      "https://babelfish.money/",
    ],
    reviewedAt: Date.UTC(2026, 10, 1, 17, 21) / 1000,
    expiresAt: Date.UTC(2026, 10, 15, 17, 21) / 1000,
  },
  {
    stablecoinId: "sbold-k3-capital",
    owner: "ops",
    reason:
      "Reviewed 2026-11-01 17:21 UTC with fresh GETs: CoinGecko sbold-by-k3-capital returns no price, DefiLlama coins returns no quote for coingecko:sbold-by-k3-capital or the Ethereum contract, and exact Ethereum DexScreener and GeckoTerminal reads are empty, so no market exists. The only admitted lane is the protocol-redeem NAV route, which reads convertToAssets(1e18) and multiplies by a trusted BOLD price. BOLD is fresh: CoinGecko liquity-bold-2 reports $0.996864 at 17:14 UTC and DefiLlama's Ethereum BOLD contract reports $0.99675 at 16:53 UTC. The NAV lane last published sBOLD at 16:15:48 UTC and has now missed two generations, so it is failing intermittently while its parent stays fresh; the vault's three-pool totalAssets() read runs under the shared 2.5-second candidate timeout. Keep sBOLD active and the price missing; all admission gates preserved. Owner ops confirms a reliable NAV read or re-reviews by this review's expiry, 2026-11-15 17:21 UTC.",
    sources: [
      "https://api.pharos.watch/api/health",
      "https://api.coingecko.com/api/v3/simple/price?ids=sbold-by-k3-capital&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/sbold-by-k3-capital",
      "https://coins.llama.fi/prices/current/ethereum:0x50bd66d59911f5e086ec87ae43c811e0d059dd11,coingecko:sbold-by-k3-capital",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x50bd66d59911f5e086ec87ae43c811e0d059dd11/pools",
      "https://api.coingecko.com/api/v3/simple/price?ids=liquity-bold-2&vs_currencies=usd&include_last_updated_at=true",
      "https://coins.llama.fi/prices/current/ethereum:0x6440f144b7e50d6a8439336510312d2f54beb01d",
      "https://www.liquity.org/blog/sbold---the-on-chain-defi-savings-account",
    ],
    reviewedAt: Date.UTC(2026, 10, 1, 17, 21) / 1000,
    expiresAt: Date.UTC(2026, 10, 15, 17, 21) / 1000,
  },
];

/** Standing source-calendar review, separate from temporary gap acknowledgements.
 * The calendar suppresses operator escalation only; missing counts and streaks remain. */
export const STABLECOIN_MARKET_HOURS_CALENDARS = [{
  calendarId: "mento-fx",
  owner: "ops",
  reviewReason: "Owner-reviewed 2026-10-29: Mento FX oracle market hours close the only admitted routes for these five assets. Keep missing prices unavailable during scheduled closures; off-calendar gaps alert normally.",
  sources: [
    "https://github.com/mento-protocol/mento-core/blob/4048a6c392790527d7ab3133af6f3336efc0cc97/contracts/oracles/breakers/MarketHoursBreaker.sol",
    "https://github.com/mento-protocol/mento-core/blob/4048a6c392790527d7ab3133af6f3336efc0cc97/contracts/oracles/OracleAdapter.sol",
    "https://github.com/mento-protocol/mento-core/blob/4048a6c392790527d7ab3133af6f3336efc0cc97/contracts/oracles/BreakerBox.sol",
    "https://github.com/mento-protocol/mento-core/blob/4048a6c392790527d7ab3133af6f3336efc0cc97/contracts/swap/BiPoolManager.sol",
    "https://github.com/mento-protocol/mento-core/blob/4048a6c392790527d7ab3133af6f3336efc0cc97/contracts/swap/FPMM.sol",
  ],
  reviewedAt: Date.UTC(2026, 9, 29, 10, 35) / 1000,
  reviewDeadline: Date.UTC(2027, 9, 29, 10, 35) / 1000,
  assets: [
    { stablecoinId: "cadm-mento", lane: "mento-broker" },
    { stablecoinId: "audm-mento", lane: "mento-broker" },
    { stablecoinId: "chfm-mento", lane: "mento-fpmm" },
    { stablecoinId: "copm-mento", lane: "mento-broker" },
    { stablecoinId: "jpym-mento", lane: "mento-fpmm" },
  ],
}] as const;

/** Exact UTC rules verified at the registry's pinned MarketHoursBreaker commit. */
function isMentoMarketClosed(nowSec: number): boolean {
  const clock = new Date(nowSec * 1000);
  const day = clock.getUTCDay();
  const hour = clock.getUTCHours();
  const month = clock.getUTCMonth();
  const date = clock.getUTCDate();
  return (day === 5 && hour >= 21) || day === 6 || (day === 0 && hour < 23)
    || (month === 11 && ((date === 24 || date === 31) && hour >= 22 || date === 25))
    || (month === 0 && date === 1);
}

/** End of the reviewed MarketHoursBreaker closure containing `nowSec`, or null while open.
 *  The checked calendar is the standing Mento FX source review above; callers defer
 *  settlement to this instant rather than treating the scheduled closure as impairment. */
export function resolveMentoFxMarketReopen(nowSec: number): number | null {
  if (!Number.isFinite(nowSec) || nowSec < 0 || !isMentoMarketClosed(nowSec)) return null;
  // Reviewed closure edges fall on UTC hour marks; walk to the first open hour.
  let candidate = Math.floor(nowSec / 3_600) * 3_600 + 3_600;
  for (let hours = 0; hours < 24 * 8; hours += 1, candidate += 3_600) {
    if (!isMentoMarketClosed(candidate)) return candidate;
  }
  return null;
}

function mostRecentMentoClosureEnd(nowSec: number): number {
  const clock = new Date(nowSec * 1000);
  const year = clock.getUTCFullYear();
  const midnight = Date.UTC(year, clock.getUTCMonth(), clock.getUTCDate()) / 1000;
  let sundayReopen = midnight - clock.getUTCDay() * 86_400 + 23 * 3600;
  if (sundayReopen > nowSec) sundayReopen -= 7 * 86_400;
  // Reject nominal ends still inside another closure (for example Christmas on Sunday).
  return Math.max(...[
    sundayReopen,
    Date.UTC(year, 11, 26) / 1000,
    Date.UTC(year, 0, 2) / 1000,
    Date.UTC(year - 1, 11, 26) / 1000,
  ].filter((end) => end <= nowSec && isMentoMarketClosed(end - 1) && !isMentoMarketClosed(end)));
}

type StablecoinMarketHoursCalendar = {
  calendarId: string;
  owner: string;
  reviewReason: string;
  sources: readonly string[];
  reviewedAt: number;
  reviewDeadline: number;
  assets: readonly { stablecoinId: string; lane: string }[];
};

export function resolveStablecoinMarketHours(
  expectedActiveIds: readonly string[],
  nowSec: number,
  calendars: readonly StablecoinMarketHoursCalendar[] = STABLECOIN_MARKET_HOURS_CALENDARS,
): {
  closedById: ReadonlyMap<string, ActivePriceCoverageScheduledClosure>;
  alertSuppressedIds: ReadonlySet<string>;
  expiredCalendarIds: string[];
  invalidCalendarIds: string[];
} {
  const closedById = new Map<string, ActivePriceCoverageScheduledClosure>();
  const alertSuppressedIds = new Set<string>();
  const expiredCalendarIds = new Set<string>();
  const invalidCalendarIds = new Set<string>();
  const activeIds = new Set(expectedActiveIds);
  const closed = validReviewSeconds(nowSec) && isMentoMarketClosed(nowSec);
  // Compact history has no per-generation clocks. Require the equivalent number
  // of open-market cadence periods without changing the measured missing streak.
  const reopeningGate = validReviewSeconds(nowSec)
    && nowSec - mostRecentMentoClosureEnd(nowSec)
      < ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS * CRON_INTERVALS["sync-stablecoins"];
  for (const calendar of calendars) {
    if (!calendar.assets.some((asset) => activeIds.has(asset.stablecoinId))) continue;
    if (!validReviewSeconds(nowSec) || calendar.calendarId !== "mento-fx"
      || !isNonEmpty(calendar.owner) || !isNonEmpty(calendar.reviewReason)
      || !calendar.sources.length || !calendar.sources.every(isHttpsSource)
      || !validReviewSeconds(calendar.reviewedAt) || !validReviewSeconds(calendar.reviewDeadline)
      || calendar.reviewedAt > nowSec || calendar.reviewDeadline <= calendar.reviewedAt
      || calendar.assets.some((asset) => !isNonEmpty(asset.lane))) {
      invalidCalendarIds.add(calendar.calendarId);
      continue;
    }
    if (calendar.reviewDeadline <= nowSec) {
      expiredCalendarIds.add(calendar.calendarId);
      continue;
    }
    for (const asset of calendar.assets) {
      if (!activeIds.has(asset.stablecoinId)) continue;
      if (closed || reopeningGate) alertSuppressedIds.add(asset.stablecoinId);
      if (!closed) continue;
      closedById.set(asset.stablecoinId, {
        calendarId: calendar.calendarId,
        reason: "market-closed",
        lane: asset.lane,
        owner: calendar.owner,
        reviewReason: calendar.reviewReason,
        sources: [...calendar.sources],
        reviewedAt: calendar.reviewedAt,
        reviewDeadline: calendar.reviewDeadline,
      });
    }
  }
  return { closedById, alertSuppressedIds,
    expiredCalendarIds: [...expiredCalendarIds].sort(), invalidCalendarIds: [...invalidCalendarIds].sort() };
}

export function resolveStablecoinScheduledPriceClosures(
  expectedActiveIds: readonly string[],
  nowSec: number,
  calendars: readonly StablecoinMarketHoursCalendar[] = STABLECOIN_MARKET_HOURS_CALENDARS,
): ReadonlyMap<string, ActivePriceCoverageScheduledClosure> {
  return resolveStablecoinMarketHours(expectedActiveIds, nowSec, calendars).closedById;
}

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
  const marketHours = resolveStablecoinMarketHours([entry.stablecoinId], options.nowSec ?? Math.floor(Date.now() / 1000));
  const scheduledClosure = positiveFiniteNumberOrNull(entry.currentPrice) != null ? null
    : marketHours.closedById.get(entry.stablecoinId) ?? null;
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
    scheduledClosure,
    alertEligible: review == null && !marketHours.alertSuppressedIds.has(entry.stablecoinId)
      && (consecutiveMissingGenerations == null
        || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS),
    acknowledgedGap: review == null || scheduledClosure != null ? null : acknowledgementFromReview(review),
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
  const scheduledClosureGapIds: string[] = [];
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
  const marketHours = resolveStablecoinMarketHours(expectedActiveIds, nowSec);
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
    const scheduledClosure = marketHours.closedById.get(stablecoinId) ?? null;
    if (scheduledClosure) scheduledClosureGapIds.push(stablecoinId);
    const acknowledgedReview = scheduledClosure ? null : resolvedReviews.activeById.get(stablecoinId) ?? null;
    if (acknowledgedReview) acknowledgedGapIds.push(stablecoinId);
    const alertEligible = acknowledgedReview == null && !marketHours.alertSuppressedIds.has(stablecoinId)
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
      scheduledClosure,
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
    scheduledClosureGapIds,
    acknowledgedGapIds,
    acknowledgedGapCount: acknowledgedGapIds.length,
    expiredMarketHoursCalendarIds: marketHours.expiredCalendarIds,
    invalidMarketHoursCalendarIds: marketHours.invalidCalendarIds,
    expiredGapReviewIds: resolvedReviews.expiredGapReviewIds,
    invalidGapReviewIds: resolvedReviews.invalidGapReviewIds,
    maxConsecutiveMissingGenerations,
  };
}
