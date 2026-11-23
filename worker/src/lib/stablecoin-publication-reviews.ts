import { MENTO_CALENDAR_REVIEW_DEADLINE_SEC } from "@shared/lib/reference-market-hours";
export interface StablecoinPublicationWaiver {
  stablecoinId: string;
  owner: string;
  reason: string;
  expiresAt: number;
}

/** A dated, owned, expiring review that acknowledges one stablecoin's
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
export const STABLECOIN_PUBLICATION_WAIVERS: readonly StablecoinPublicationWaiver[] = [
  {
    stablecoinId: "wm-m0",
    owner: "ops",
    reason:
      "Renewed once 2026-11-23 12:54 UTC (owner decision D8 on issue #2259, origin #2145 Option A): CoinGecko wrappedm-by-m0 remains frozen at 2026-11-15T05:39:11Z ($70,354,848, 0 tickers), coins.llama.fi returns {}, and the 7-day carry-forward expired 2026-11-22T05:39:11Z; fresh 12-chain pinned totalSupply/getTokenSupply reads 70,643,641.75 wM (+0.41% vs stalled CG). Keep wM honestly withheld from /api/stablecoins until CoinGecko resumes or the reviewed 12-chain native supply plan (with M0 Portal zero-escrow proof) ships. Re-check by 2026-12-07 12:54 UTC.",
    expiresAt: Date.UTC(2026, 11, 7, 12, 54) / 1000,
  },
];

/** Census-only reviews for off-catalog PSI historical members; never active-price coverage. */
export const PSI_HISTORICAL_PRICE_GAP_REVIEWS: readonly StablecoinPriceGapReview[] = [
  {
    stablecoinId: "ust-terra",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC with fresh GETs: UST is an off-catalog PSI historical census member. CoinGecko terrausd reports $0.00382879 with $1,084,190.34 of 24h volume last updated 2026-11-22T12:36:27Z, while the severe-downside publication gate still lacks an admitted second price source. DefiLlama detail 3 still reports price 0 and dead since 2022-05-09, with final circulating supply zero on 2022-06-22. DexScreener Ethereum SushiSwap UST/WETH holds $8,433.43 ($0.003909) and BSC Biswap UST/BUSD holds $13,336.25 ($0.01236), while GeckoTerminal's PancakeSwap v2 BSC UST/BUSD pool holds $108,534.59 ($785.06 24h volume, $0.012564), still pricing a stranded Shuttle bridge wrapper whose bridge closed and whose exchangeability into native USTC remains unproven with no reviewed Pharos collection route. BUSD and depth are not the reasons it fails to corroborate. Other native-like quotes remain outside existing admission. Accept the census gap; preserve all gates. Reassess or remove this acknowledgement if native USTC gains an admitted corroborating source, the wrapper's exchangeability into native USTC is proven, or a reviewed collection route is added, by 2026-12-06 12:38 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=terrausd&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://stablecoins.llama.fi/stablecoin/3",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xa47c8bf37f92abed4a126bda807a7b7498661acd",
      "https://api.dexscreener.com/token-pairs/v1/bsc/0x23396cf899ca06c4472205fc903bdb4de249d6fc",
      "https://api.geckoterminal.com/api/v2/networks/bsc/pools/0x05faf555522fa3f93959f86b41a3808666093210",
      "https://raw.githubusercontent.com/terra-money/shuttle/main/TERRA_ASSET.md",
      "https://x.com/terra_money/status/1853823983369818246",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
];

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
      "Re-reviewed 2026-11-22 12:38 UTC with fresh GETs and RPC reads: CoinGecko worldwide-usd still reports $1.17 ($1.37 24h volume) frozen at 2026-08-21 22:51:40 UTC (~93 days old) and its tickers endpoint returns 404 (zero tickers), so the only published mark is not an observed market. DefiLlama detail 234 publishes no price (daily circulating $647,761.35 on 2026-11-22, minted 0) and coins.llama.fi returns no quote. Exact-contract totalSupply() reads confirm 589,715.75 WUSD on Ethereum (finalized block 26470611) and 58,045.60 WUSD on Polygon (block 97763730), summing to $647,761.35. Exact-contract DexScreener reads for 0x7cd017ca5ddb86861fa983a34b5f495c6f898c41 on Ethereum and Polygon remain empty. GeckoTerminal returns only sub-floor pools with zero 24h volume: the largest Ethereum pool holds $235.20, the largest Polygon pool $1,183.06, and the largest Viction pool $270.43, all below the unchanged $50K per-pool floor. The documented wallet.wspn.io still resolves only to an NXDOMAIN load-balancer CNAME (prd-public-498604239.ap-southeast-1.elb.amazonaws.com). Coins.ph ended convert-sell on 2026-08-04 while allowing withdrawals; a venue delisting is not an issuer termination. Issuer channels show no end-of-life signal: wspn.io/solutions and developer.wspn.io/5768563m0.md both return HTTP 200. Owner decision 2026-10-29: keep active pending a primary discontinuation source; freeze if one appears. Keep the price missing; all admission gates preserved. The predecessor's October 23 lifecycle/redemption-route decision stays open with owner ops and is neither satisfied nor extended by this source review, which expires 2026-12-06 12:38 UTC.",
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
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "bd-basedollar",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC: the existing aerodrome-exact adapter still correctly rejects inventory. At Base block 60803444 (hash 0xc13ec1308a0819d31c87a56ae256b4fbe25ad3eaead06a0cde832193300fe69a), reviewed Aero BD/USDC pool 0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f holds 7,674.23 BD and 6,068.04 USDC with balanceOf() matching getReserves(), both still below the unchanged 10,000-unit inventory floor. GeckoTerminal reports $13,819.44 liquidity ($204.58 24h volume) on BD/USDC and DexScreener reports only a $0.29 BD/VVV pair; CoinGecko search returns no listing and DefiLlama id 434 publishes no price (onCoinGecko false). The protocol's nominal collateral-redemption entitlement is not an observed dollar quote. Keep BD active and the price missing; all admission gates preserved. Owner ops rechecks inventory or an admissible alternate market by 2026-12-06 12:38 UTC.",
    sources: [
      "https://basescan.org/address/0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f#readContract",
      "https://api.coingecko.com/api/v3/search?query=base%20dollar",
      "https://api.dexscreener.com/token-pairs/v1/base/0x252d36f435582ecb01686448d21e8c9ea0b2ca65",
      "https://api.geckoterminal.com/api/v2/networks/base/tokens/0x252d36f435582ecb01686448d21e8c9ea0b2ca65/pools",
      "https://stablecoins.llama.fi/stablecoin/434",
      "https://docs.basedollar.org/",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "dllr-sovryn",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC: CoinGecko sovryn-dollar still reports $0.98964 with $256.78 of 24h volume frozen at 2026-11-06T23:11:07Z and an empty tickers array (0 tickers), so its only mark exceeds the seven-day low-volume budget. coins.llama.fi returns no quote for the gecko id or Rootstock contract 0xc1411567d2670e24d9c4daaa7cda95686e1250aa, and DefiLlama id 160 publishes no price (onCoinGecko false). Sovryn's mitigation and recovery manifest reports Mynt DLLR minting and redemption halted, so there is no protocol quote either. Keep DLLR active and the price missing; all admission gates preserved. Owner ops rechecks Sovryn recovery status and any admissible market by 2026-12-06 12:38 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=sovryn-dollar,monerium-gbp-emoney&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/sovryn-dollar/tickers",
      "https://coins.llama.fi/prices/current/coingecko:sovryn-dollar,rsk:0xc1411567d2670e24d9c4daaa7cda95686e1250aa",
      "https://stablecoins.llama.fi/stablecoin/160",
      "https://forum.sovryn.com/t/sovryn-mitigation-and-recovery-manifest/3611",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "gbpe-monerium",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC: CoinGecko monerium-gbp-emoney still reports $1.38 last updated 2026-11-18T18:16:06Z; its only ticker remains one Oku Trade (Gnosis) print flagged is_stale true, last traded 2026-11-18T10:15:05Z at 1.258 against its quote token ($11,478.84 reported volume, 4.17% spread). coins.llama.fi returns no quote for the gecko id or Gnosis contract 0x8e34bfec4f6eb781f9743d9b4af99cd23f9b7053. GeckoTerminal Gnosis pools hold $239.04 (GBPe/EURe, $1.80 24h volume) and $0.04 (GBPe/USDC.e, $0.04 24h volume), far below the unchanged $50K floor. Monerium states it offers no GBP IBANs, so there is no issuer quote lane. Keep GBPe active and the price missing; all admission gates preserved. Owner ops rechecks for an admissible market by 2026-12-06 12:38 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=sovryn-dollar,monerium-gbp-emoney&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/monerium-gbp-emoney/tickers",
      "https://coins.llama.fi/prices/current/coingecko:monerium-gbp-emoney,xdai:0x8e34bfec4f6eb781f9743d9b4af99cd23f9b7053",
      "https://api.geckoterminal.com/api/v2/networks/xdai/tokens/0x8e34bfec4f6eb781f9743d9b4af99cd23f9b7053/pools",
      "https://help.monerium.com/article/12-gbpe-ibans",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "aid-gaib",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC with fresh GETs: CoinGecko gaib-aid reports $0.997702 with $1.00 of 24h volume last updated 2026-11-19T15:02:33Z (outside the 15-minute primary budget) and an empty tickers array (0 tickers). DefiLlama coins still returns exactly 1.0 (confidence 0.9, ts 2026-11-22T12:21:32Z) for both coingecko:gaib-aid and the Ethereum contract, a fill rather than an observed market. Ethereum DexScreener returns no pairs; the largest observed GeckoTerminal Ethereum pools hold $1,402.52 and $1,378.62 (AID/USDC) with zero 24h volume, far below the unchanged $50K floor. No admissible market was found. The whitelisted USDC redemption entitlement is not a market quote. Keep AID active and the price missing; all admission gates preserved. Owner ops must decide any low-volume CoinGecko admission separately or re-review by 2026-12-06T12:38:00Z.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=gaib-aid,gaib-said&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/gaib-aid/tickers",
      "https://coins.llama.fi/prices/current/coingecko:gaib-aid,ethereum:0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x18f52b3fb465118731d9e0d276d4eb3599d57596/pools",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "deuro-deuro",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC with fresh GETs: CoinGecko decentralized-euro still reports $1.15 with $3.49 of 24h volume frozen at 2026-08-03T23:52:30Z (exceeding the seven-day low-volume budget) and its tickers endpoint returns 404. DefiLlama coins returns no quote for the gecko id or Ethereum contract. The protocol API (api.deuro.com) mirrors $1.15, not an independent market. DexScreener reports only one Ethereum UDS/dEURO pair with no admitted liquidity/price. Blockscout still reads only 528 raw units at six decimals (0.000528 EURC) in protocol-redeem bridge 0xb4ff7412f08c22d7381885e8bda9ee9825092fd1, insufficient for the existing 1,000 dEURO minimum minted depth and full EURC coverage. No admissible market was found. Keep dEURO active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market, restores admitted bridge capacity, or re-reviews by 2026-12-06T12:38:00Z; an alternative CMC lane remains a separate source decision.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=decentralized-euro&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/decentralized-euro/tickers",
      "https://coins.llama.fi/prices/current/coingecko:decentralized-euro,ethereum:0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea",
      "https://eth.blockscout.com/api/v2/addresses/0xb4ff7412f08c22d7381885e8bda9ee9825092fd1/token-balances",
      "https://api.deuro.com/ecosystem/stablecoin/info",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "fusd-finchain",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC with fresh GETs: DefiLlama detail 390 still resolves FUSD with no price and onCoinGecko false (circulating $2,403,370.71); coins.llama.fi returns no quote for its Ethereum, Avalanche, Sonic or Monad deployments. CoinGecko search for finchain returns no coins and exact-contract DexScreener reads on Ethereum and Avalanche are empty. FinChain API reports 1,727,585.70 FUSD (Ethereum 692,610.95), with only FUSDLP reserve_ratio 1.001068 dated 2026-04-21T01:51:35Z and no market price. Ethereum Blockscout reads 1,452,738.458876 FUSD (22 holders) versus the stale issuer API Ethereum row; this review does not endorse the issuer supply perimeter. No admissible market was found. Keep FUSD active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by 2026-12-06T12:38:00Z.",
    sources: [
      "https://stablecoins.llama.fi/stablecoin/390",
      "https://coins.llama.fi/prices/current/ethereum:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c,avalanche:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c,sonic:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c,monad:0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
      "https://api.coingecko.com/api/v3/search?query=finchain",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
      "https://api.dexscreener.com/token-pairs/v1/avalanche/0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
      "https://api.finchain.global/api/v0/fusd-data",
      "https://fusd.finchain.global/",
      "https://eth.blockscout.com/api/v2/tokens/0x9f6714c302ffe3c3bafaf2ccb44201ff64f6371c",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "xusd-babelfish",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC with fresh GETs: CoinGecko xusd-babelfish still reports $0.994825 frozen at 2026-10-31T13:14:42Z (exceeding the seven-day low-volume budget) and its tickers array remains empty (0 tickers). DefiLlama coins returns no gecko-id or Rootstock-contract quote and GeckoTerminal returns no Rootstock XUSD pools. Sovryn's 3 November incident report records 541,455.998472 XUSD paid to an attacker-controlled wallet in the 1 November AMM incident, the XUSD/WRBTC pool delisted on 2 November, lending and margin paused, users told not to interact with Sovryn contracts, and 66,134.07 XUSD still blocked in Perimeter withdrawal escrow. Its $0.995 valuation assumption is explicitly not a current quotation. Rootstock Blockscout still reads 761,359.496653 XUSD total supply and 1,147 holders, but that does not prove redemption works. No admissible market was found. Keep the price missing; all admission gates preserved. Owner ops must resolve the venue loss, escrow and lifecycle/redemption-impairment question separately; this source review neither establishes redemption health nor decides a freeze. Establish an admitted observed market or re-review by 2026-12-06T12:38:00Z.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=xusd-babelfish&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/xusd-babelfish/tickers",
      "https://coins.llama.fi/prices/current/coingecko:xusd-babelfish,rsk:0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://api.geckoterminal.com/api/v2/networks/rootstock/tokens/0xb5999795be0ebb5bab23144aa5fd6a02d080299f/pools",
      "https://rootstock.blockscout.com/api/v2/tokens/0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://forum.sovryn.com/t/sovryn-incident-report-31-october-1-november-2026/3609.json",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "hbd-hive",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-22 12:38 UTC: HBD's admitted price path remains the native Hive internal market (hive-native-cg), requiring a non-self trade within 900 seconds plus spread, depth, turnover and a fresh HIVE/USD parent; production /api/stablecoins currently publishes price missing. Fresh reads at 12:37 UTC from api.hive.blog and api.deathwing.me agree on bid/ask 0.0368/0.0369 HBD per HIVE (0.2717% spread), 126.041/427.613 HBD of depth within 2%, and 2,576.818 HBD of 24h volume; api.deathwing.me's newest trade is 12:29:30 UTC (247 rows over 24h) and a replay of the 97 quarter-hour boundaries over the prior 24 hours finds 32 without a trade inside 900 seconds, so intermittent missing runs remain justified. CoinGecko hive_dollar is $1.44 ($851,143 24h volume) at 12:36:27 UTC, far outside the existing $1.19 bound; its only two tickers are the duplicated Upbit-family HBD/BTC book (Upbit $1.44 / $426,354 and Upbit Indonesia $1.38 / $409,239). HBD has no reviewed contract deployment for DEX, contract or exact-address recovery. Keep HBD active and its missing runs missing; all admission gates preserved. Owner ops re-reviews the native-trade cadence or establishes another admitted market by this review's expiry, 2026-12-06 12:38 UTC.",
    sources: [
      "https://api.hive.blog",
      "https://api.deathwing.me",
      "https://api.coingecko.com/api/v3/coins/hive_dollar/tickers",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    stablecoinId: "wm-m0",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-23 12:54 UTC (owner decision D8 on issue #2259, origin #2145 Option A): CoinGecko wrappedm-by-m0 remains frozen at 2026-11-15T05:39:11Z ($0.999766, $70,354,848 cap, $13.69 24h vol) with 0 tickers, and coins.llama.fi returns {} for both coingecko:wrappedm-by-m0 and Ethereum 0x437cc33344a0b27a429f795ff6b469c72698b291. Ethereum DexScreener returns 0 pairs and GeckoTerminal's largest Ethereum pools hold $566.22 (wM/DYAD) and $419.92 (wM/USDC) with $0 24h volume, far below the $50K floor, so wM has no admitted live market price and its 7-day supply carry expired 2026-11-22T05:39:11Z. Fresh 12-chain pinned totalSupply/getTokenSupply reads 70,643,641.75 wM (+0.41% vs stalled CG), proving the token remains alive on-chain. Renewed once while the reviewed 12-chain native supply plan (with M0 Portal zero-escrow proof) is built; keep price missing and supply withheld under dated waiver; all admission gates preserved. Re-check by 2026-12-07 12:54 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=wrappedm-by-m0&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/wrappedm-by-m0/tickers",
      "https://coins.llama.fi/prices/current/coingecko:wrappedm-by-m0,ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x437cc33344a0b27a429f795ff6b469c72698b291",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x437cc33344a0b27a429f795ff6b469c72698b291/pools",
      "https://docs.m0.org/",
      "https://github.com/TokenBrice/pharos-watch/issues/2145",
      "https://github.com/TokenBrice/pharos-watch/issues/2259",
    ],
    reviewedAt: Date.UTC(2026, 10, 23, 12, 54) / 1000,
    expiresAt: Date.UTC(2026, 11, 7, 12, 54) / 1000,
  },
  {
    stablecoinId: "usdcx-movement",
    owner: "ops",
    reason:
      "Reviewed 2026-11-22 12:00 UTC (issue #2145 Sub-option A1): CoinGecko usdcx-movement remains frozen at 2026-11-14T00:41:51Z ($600,982) and DefiLlama returns {}, leaving every admitted live price lane empty. Movement pinned-ledger ConcurrentSupply (ledger_version 240627708) read 562,714.444846 USDCx reconciled against 568,408.465646 USDC in Ethereum Circle xReserve (+101.19 bps excess), so Pricing v6.91 restores on-chain supply with preferMcap: true while keeping price honestly null under R1. All admission gates preserved; owner ops re-checks CoinGecko or an admitted observed market by 2026-12-06 12:00 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=usdcx-movement&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true",
      "https://mainnet.movementnetwork.xyz/v1/accounts/0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e/resource/0x1::fungible_asset::ConcurrentSupply",
      "https://developers.circle.com/xreserve/concepts/how-xreserve-works",
      "https://github.com/TokenBrice/pharos-watch/issues/2145",
    ],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 0) / 1000,
    expiresAt: Date.UTC(2026, 11, 6, 12, 0) / 1000,
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
  reviewDeadline: MENTO_CALENDAR_REVIEW_DEADLINE_SEC,
  assets: [
    { stablecoinId: "cadm-mento", lane: "mento-broker" },
    { stablecoinId: "audm-mento", lane: "mento-broker" },
    { stablecoinId: "chfm-mento", lane: "mento-fpmm" },
    { stablecoinId: "copm-mento", lane: "mento-broker" },
    { stablecoinId: "jpym-mento", lane: "mento-fpmm" },
  ],
}] as const;
