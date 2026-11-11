export interface StablecoinPublicationWaiver {
  stablecoinId: string;
  owner: string;
  reason: string;
  expiresAt: number;
}

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
    stablecoinId: "bd-basedollar",
    owner: "ops",
    reason:
      "Reviewed 2026-11-07 19:45 UTC: the existing aerodrome-exact adapter correctly rejects inventory. At Base block 54451146 (hash 0xf15f11a772be79e3f39e6e3f684c421b8e9f621e6c6771d7605f83eec680dcd8), reviewed Aero BD/USDC pool 0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f holds 11,990.64 BD and 9,204.12 USDC with balances matching reserves, below the unchanged 10,000 USDC output-inventory floor. GeckoTerminal reports $20,999.95 pool reserves and a $0.99493853 mark; DexScreener's legacy BD/USDC pool holds only $295.25. The larger BOARDED/BD pool has no trusted dollar quote leg and cannot replace the reviewed route. CoinGecko search returns no listing. The protocol's nominal collateral-redemption entitlement is not an observed dollar quote. Keep BD active and the price missing; all admission gates preserved. Owner ops rechecks inventory or an admissible alternate market by 2026-11-21 19:45 UTC.",
    sources: [
      "https://basescan.org/address/0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f#readContract",
      "https://api.coingecko.com/api/v3/search?query=base%20dollar",
      "https://api.dexscreener.com/token-pairs/v1/base/0x252d36f435582ecb01686448d21e8c9ea0b2ca65",
      "https://api.geckoterminal.com/api/v2/networks/base/tokens/0x252d36f435582ecb01686448d21e8c9ea0b2ca65/pools",
      "https://docs.basedollar.org/",
    ],
    reviewedAt: Date.UTC(2026, 10, 7, 19, 45) / 1000,
    expiresAt: Date.UTC(2026, 10, 21, 19, 45) / 1000,
  },
  {
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
    stablecoinId: "spusd-soulpeg",
    owner: "ops",
    reason:
      "Reviewed 2026-11-03 23:48 UTC with fresh GETs: DefiLlama detail 413 reports gecko_id soulpeg-usd but publishes no list price, and coins.llama.fi returns $1.0045316 (confidence 0.99) for both the BSC contract and coingecko:soulpeg-usd at 2026-11-03 18:24:25 UTC, about 5.4 hours old and beyond the 15-minute primary budget. CoinGecko soulpeg-usd reports $1.005 with $211.16 of 24h volume on the same clock. The only DEX market, PancakeSwap SPUSD pair 0x8e0a1c1a3b66a01dc49a0cf1c6d82c0455fe3250, holds $9,190.39 with $0.95 of 24h volume, below the $50K per-pool floor; DefiLlama reports no CMC id. No admissible live market was found and SPUSD is not in the reviewed seven-day lane. Keep SPUSD active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by this review's expiry, 2026-11-17 23:48 UTC.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/413",
      "https://coins.llama.fi/prices/current/bsc:0x40ff3dea2eec93a7b71879874dc4407918da77a6,coingecko:soulpeg-usd",
      "https://api.coingecko.com/api/v3/simple/price?ids=soulpeg-usd&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.dexscreener.com/token-pairs/v1/bsc/0x40ff3dea2eec93a7b71879874dc4407918da77a6",
    ],
    reviewedAt: Date.UTC(2026, 10, 3, 23, 48) / 1000,
    expiresAt: Date.UTC(2026, 10, 17, 23, 48) / 1000,
  },
  {
    stablecoinId: "hbd-hive",
    owner: "ops",
    reason:
      "Reviewed 2026-11-04 08:53 UTC: HBD's only admitted price path is the native Hive internal market (hive-native-cg), which requires a non-self trade within 900 seconds plus spread, depth, turnover and a fresh HIVE/USD parent. The book itself is healthy: both approved nodes (api.hive.blog and api.deathwing.me, head block 111364328 at 08:53:00 UTC) return the same newest trades (08:52:45, 08:51:57 and 08:44:48 UTC) and a best bid/ask of 0.044975/0.045027 HBD per HIVE with 3,000/560 HBD on top. But trading is sparse: at 08:23 UTC both nodes' newest non-self trade was 07:53:18 UTC, and a trade-freshness replay of 2026-11-03/04 found 40 of 96 quarter-hour boundaries without a trade inside 900 seconds, so publications intermittently and correctly withhold the price. CoinGecko hive_dollar ($1.63 from Upbit-family BTC/HBD tickers) stays outside the existing $1.19 bound and is correctly rejected; HBD has no reviewed contract deployment for DEX, contract or exact-address recovery. Keep HBD active and its missing runs missing; all admission gates preserved. Owner ops re-reviews the native-trade cadence or establishes another admitted market by this review's expiry, 2026-11-18 08:53 UTC.",
    sources: [
      "https://api.hive.blog",
      "https://api.deathwing.me",
      "https://api.coingecko.com/api/v3/coins/hive_dollar/tickers",
    ],
    reviewedAt: Date.UTC(2026, 10, 4, 8, 53) / 1000,
    expiresAt: Date.UTC(2026, 10, 18, 8, 53) / 1000,
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

