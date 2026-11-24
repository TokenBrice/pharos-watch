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
      "Re-reviewed 2026-11-22 12:38 UTC (reason corrected 2026-11-24 14:37 UTC; expiry unchanged): HBD's admitted native price path (hive-native-cg) requires at least 500 HBD of order-book depth on each side within 2% of mid, plus spread, 900-second trade recency, 1,000 HBD 24h turnover and a fresh HIVE/USD parent. Production rejects the native lane for insufficient_depth (2026-11-24 13:30 UTC: 443.541 HBD bid / 588.857 HBD ask against the 500 HBD per-side floor; 2026-11-22 12:37 UTC reads from api.hive.blog and api.deathwing.me measured 126.041/427.613 HBD at 0.2717% spread, and fresh 2026-11-24 14:37 UTC reads measure 125.662/519.938 HBD at 0.7995% spread), not the 900-second trade cadence. When CoinGecko hive_dollar rises above the existing $1.19 USD bound ($1.44 at 2026-11-22 12:36:27 UTC from duplicated Upbit-family HBD/BTC tickers; above $1.19 across 2026-11-21..23 and 2026-11-24 02:15..02:45 UTC), direct CoinGecko is also rejected, leaving HBD missing. HBD has no reviewed contract deployment for DEX, contract or exact-address recovery. Keep HBD active and its missing runs missing; all admission gates preserved. Owner ops re-reviews native book depth or establishes another admitted market by this review's expiry, 2026-12-06 12:38 UTC.",
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
  {
    stablecoinId: "spusd-soulpeg",
    owner: "ops",
    reason:
      "Reviewed 2026-11-24 14:37 UTC with fresh GETs (owner decision #12): CoinGecko soulpeg-usd remains frozen at $0.991029 ($6,660,966.28 cap, $49.65 24h vol) last updated 2026-11-21T01:25:49Z (outside the 15-minute primary budget); both tickers — PancakeSwap (v2) ($0.996934, last traded 2026-11-20T15:25:50Z) and Uniswap V3 (BSC) ($0.991029, last traded 2026-11-20T17:24:55Z) — are flagged is_stale true. DefiLlama detail 413 publishes price null (circulating $54,693,539.91) and coins.llama.fi returns {} for coingecko:soulpeg-usd and BSC 0x40ff3dea2eec93a7b71879874dc4407918da77a6. Exact-contract BSC DexScreener returns []. GeckoTerminal BSC pools hold only sub-floor liquidity with zero 24h volume and zero 24h trades: PancakeSwap V2 SPUSD/USDC holds $8,564.42 and Uniswap V3 SPUSD/USDC holds $3,631.65, far below the unchanged $50K floor. No protocol-redemption USD quote exists because ordinary unwrap returns the SoulPeg sUSDC receipt rather than USDC. Keep spUSD active and the price missing without admitting a stale mark; all admission gates preserved. Owner ops rechecks for an admitted observed market by 2026-12-08 14:37 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=soulpeg-usd&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/soulpeg-usd/tickers",
      "https://stablecoins.llama.fi/stablecoin/413",
      "https://coins.llama.fi/prices/current/coingecko:soulpeg-usd,bsc:0x40ff3dea2eec93a7b71879874dc4407918da77a6",
      "https://api.dexscreener.com/token-pairs/v1/bsc/0x40ff3dea2eec93a7b71879874dc4407918da77a6",
      "https://api.geckoterminal.com/api/v2/networks/bsc/tokens/0x40ff3dea2eec93a7b71879874dc4407918da77a6/pools",
    ],
    reviewedAt: Date.UTC(2026, 10, 24, 14, 37) / 1000,
    expiresAt: Date.UTC(2026, 11, 8, 14, 37) / 1000,
  },
  {
    stablecoinId: "usdplus-streamflow",
    owner: "ops",
    reason:
      "Reviewed 2026-11-24 14:37 UTC with fresh GETs (owner decision #12): CoinGecko usd-2 remains frozen at $0.999019 ($1,678,918.05 cap, $8,461.79 24h vol) last updated 2026-11-19T09:05:24Z (outside the 15-minute primary budget); its sole Meteora ticker ($0.999019, last traded 2026-11-19T01:04:29Z) is flagged is_stale true. DefiLlama detail 426 publishes price null (circulating $1,681,176.71) and coins.llama.fi returns {} for coingecko:usd-2 and Solana mint usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia. Exact-contract Solana DexScreener returns []. GeckoTerminal's Meteora USD+/USDC pool (HgHXbwA6yeVzP69VQZFSjYNgKnUFPPwi8Ns3PSpu162p) holds $189,907.98 at $1.0207 spot with zero 24h volume and zero 24h trades (USD+/SOL holds $671.11, zero volume). Jupiter Price v3 reports $0.999465 (block 470669300) with $14.59 liquidity, rejected below the unchanged $50K floor. No M0-extension inherited or protocol-par route is admitted while the fixed-unit M claim remains unproven and wM is unpriced. Keep USD+ active and the price missing without admitting a stale mark; all admission gates preserved. Owner ops rechecks for an admitted observed market by 2026-12-08 14:37 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=usd-2&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/usd-2/tickers",
      "https://stablecoins.llama.fi/stablecoin/426",
      "https://coins.llama.fi/prices/current/coingecko:usd-2,solana:usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia",
      "https://api.dexscreener.com/token-pairs/v1/solana/usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia",
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia/pools",
      "https://lite-api.jup.ag/price/v3?ids=usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia",
    ],
    reviewedAt: Date.UTC(2026, 10, 24, 14, 37) / 1000,
    expiresAt: Date.UTC(2026, 11, 8, 14, 37) / 1000,
  },
  {
    stablecoinId: "sbold-k3-capital",
    owner: "ops",
    reason:
      "Reviewed 2026-11-24 14:37 UTC with fresh GETs and pinned Ethereum RPC reads (owner decision #12, tied to exploit supply hold and issue #2106): K3 Capital's sBOLD ERC-4626 vault (0x50bd66d59911f5e086ec87ae43c811e0d059dd11) was exploited on 2026-11-18 and remains paused. At finalized Ethereum block 26485580 (2026-11-24T14:21:11Z, hash 0xbbb630a7cb02fa746e26acfa6954159edfa8ddab6b058a5115c18b5473ba9465), paused() is true, totalAssets() reads 4.571961 BOLD (Blockscout shows 1.000000 BOLD in the vault wallet), totalSupply() reads 4.372e19 sBOLD, and convertToAssets(1e18) returns 0, so Pricing v6.84 tombstones the cached-rate rescue (protocol-redeem-cached-rate) rather than republishing a pre-exploit rate. CoinGecko sbold-by-k3-capital returns {} with 0 tickers, coins.llama.fi returns {}, Ethereum DexScreener returns [], and GeckoTerminal's largest Ethereum pool holds $49.36 with zero 24h volume. Tied to the existing REVIEWED_ONCHAIN_SUPPLY_HOLDS economic-float-unreconciled hold and issue #2106 (owner decision 2026-11-23: wait for K3 recovery outcome with no fixed deadline before choosing restore or cemetery; #2106 follow-up re-check due 2026-11-26). Keep price missing and supply withheld; all admission gates preserved. This source review neither satisfies nor alters the lifecycle decision under #2106; owner ops re-reviews by 2026-12-08 14:37 UTC.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=sbold-by-k3-capital&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/sbold-by-k3-capital/tickers",
      "https://coins.llama.fi/prices/current/coingecko:sbold-by-k3-capital,ethereum:0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x50bd66d59911f5e086ec87ae43c811e0d059dd11/pools",
      "https://eth.blockscout.com/api/v2/tokens/0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
      "https://eth.blockscout.com/api/v2/addresses/0x50bd66d59911f5e086ec87ae43c811e0d059dd11/token-balances",
      "https://x.com/k3_capital/status/2123395654214967426",
      "https://github.com/TokenBrice/pharos-watch/issues/2106",
    ],
    reviewedAt: Date.UTC(2026, 10, 24, 14, 37) / 1000,
    expiresAt: Date.UTC(2026, 11, 8, 14, 37) / 1000,
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
