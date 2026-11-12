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
export const STABLECOIN_PUBLICATION_WAIVERS: readonly StablecoinPublicationWaiver[] = [];

/** Census-only reviews for off-catalog PSI historical members; never active-price coverage. */
export const PSI_HISTORICAL_PRICE_GAP_REVIEWS: readonly StablecoinPriceGapReview[] = [
  {
    stablecoinId: "ust-terra",
    owner: "ops",
    reason:
      "Reviewed 2026-11-12 23:02 UTC from saved source reads: UST is an off-catalog PSI historical census member. CoinGecko USTC was $0.00411637 with $1,070,254.44 of 24h volume at 21:21 UTC; R10's later 22:08 UTC read was $0.00412039. The severe-downside publication gate still lacks an admitted second price source. DefiLlama reports dead since 2022-05-09, with final supply zero on 2022-06-22. At 21:21 UTC SushiSwap UST/WETH held $9,398.40 and Biswap UST/BUSD $13,446.31, but one PancakeSwap v2 BSC UST/BUSD pool exceeds the unchanged $50,000 floor ($112,101.16), pricing a stranded Shuttle bridge wrapper at $0.01351; R10 confirmed this pool at 22:08 UTC and its real reserves at 22:09 UTC. Its bridge closed and exchangeability into native USTC is unproven; Pharos has no reviewed collection route. BUSD and depth are not the reasons it fails to corroborate. Other native-like quotes remain outside existing admission. Accept the census gap; preserve all gates. Reassess or remove this acknowledgement if native USTC gains an admitted corroborating source, the wrapper's exchangeability into native USTC is proven, or a reviewed collection route is added.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=terrausd&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true",
      "https://stablecoins.llama.fi/stablecoin/3",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xa47c8bf37f92abed4a126bda807a7b7498661acd",
      "https://api.dexscreener.com/token-pairs/v1/bsc/0x23396cf899ca06c4472205fc903bdb4de249d6fc",
      "https://api.geckoterminal.com/api/v2/networks/bsc/pools/0x05faf555522fa3f93959f86b41a3808666093210",
      "https://raw.githubusercontent.com/terra-money/shuttle/main/TERRA_ASSET.md",
      "https://x.com/terra_money/status/1853823983369818246",
    ],
    reviewedAt: Date.UTC(2026, 10, 12, 23, 2) / 1000,
    expiresAt: Date.UTC(2026, 10, 26, 23, 2) / 1000,
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
    stablecoinId: "idrt-rupiah-token",
    owner: "ops",
    reason:
      "Reviewed 2026-11-11 23:19:58 UTC: the successful 23:17:26 UTC CoinGecko batch GET still reports rupiah-token $0.0000518 with $51.40 of 24h volume frozen at 2026-11-03T01:58:27Z, and its tickers array is empty. The later single-asset retry was rate-limited. IDRT has no DefiLlama list identity; coins.llama.fi returns no quote for its gecko id or Ethereum, BSC and Polygon contracts. DexScreener reports one Ethereum pair with $6.91 liquidity and $0.05 of 24h volume; GeckoTerminal's largest observed pool holds $403.68 with zero volume, below the unchanged $50K floor. Ethereum totalSupply is 48,426,295,176 IDRT with transfers on 2026-11-11T12:11-12:55Z, so the asset is alive on-chain. Indodax still exposes an IDRT/IDR book: last 0.978 IDR, buy 0.955, sell 0.978, but only 100,211 IDR of 24h volume; that unsupported thin venue is not an admitted quote. No admissible market was found. Keep IDRT active and the price missing; all admission gates preserved. Owner ops decides on an Indodax venue adapter with explicit thin-market admission, or a lifecycle decision if a primary discontinuation source appears, or a fresh review by 2026-11-25T23:19:58Z; this acknowledgement prejudges neither source admission nor lifecycle.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=rupiah-token,decentralized-euro,parallel-usdp,xusd-babelfish,gaib-aid,gaib-said,wrapped-itry&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/rupiah-token/tickers",
      "https://coins.llama.fi/prices/current/ethereum:0x998ffe1e43facffb941dc337dd0468d52ba5b48a,bsc:0x66207e39bb77e6b99aab56795c7c340c08520d83,polygon:0x554cd6bdd03214b10aafa3e0d4d42de0c5d2937b,coingecko:rupiah-token",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x998ffe1e43facffb941dc337dd0468d52ba5b48a",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x998ffe1e43facffb941dc337dd0468d52ba5b48a/pools",
      "https://eth.blockscout.com/api/v2/tokens/0x998ffe1e43facffb941dc337dd0468d52ba5b48a",
      "https://eth.blockscout.com/api/v2/tokens/0x998ffe1e43facffb941dc337dd0468d52ba5b48a/transfers",
      "https://indodax.com/api/ticker/idtidr",
    ],
    reviewedAt: Date.UTC(2026, 10, 11, 23, 19, 58) / 1000,
    expiresAt: Date.UTC(2026, 10, 25, 23, 19, 58) / 1000,
  },
  {
    stablecoinId: "aid-gaib",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-11 23:19:58 UTC: the successful 23:17:26 UTC CoinGecko batch GET reports gaib-aid $1.004, $1,431.14 of 24h volume, last_updated_at 2026-11-11T08:26:53Z; its tickers array is empty. The later single-asset retry was rate-limited; the batch value is beyond the 15-minute primary budget. DefiLlama coins still returns exactly 1 for both coingecko:gaib-aid and the Ethereum contract, a fill rather than an observed market. Ethereum DexScreener returns no pairs; the largest observed GeckoTerminal Ethereum pool, Curve AID/USDC, holds $1,474.55 with zero 24h volume, below the unchanged $50K floor. No admissible market was found. The whitelisted USDC redemption entitlement is not a market quote. Keep AID active and the price missing; all admission gates preserved. Owner ops must decide any low-volume CoinGecko admission separately or re-review by 2026-11-25T23:19:58Z.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=rupiah-token,decentralized-euro,parallel-usdp,xusd-babelfish,gaib-aid,gaib-said,wrapped-itry&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/gaib-aid/tickers",
      "https://coins.llama.fi/prices/current/coingecko:gaib-aid,ethereum:0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0x18f52b3fb465118731d9e0d276d4eb3599d57596",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x18f52b3fb465118731d9e0d276d4eb3599d57596/pools",
    ],
    reviewedAt: Date.UTC(2026, 10, 11, 23, 19, 58) / 1000,
    expiresAt: Date.UTC(2026, 10, 25, 23, 19, 58) / 1000,
  },
  {
    stablecoinId: "deuro-deuro",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-11 23:19:58 UTC: the successful 23:17:26 UTC CoinGecko batch GET still reports decentralized-euro $1.15 with $3.49 of 24h volume dated 2026-08-03T23:52:30Z and its tickers array is empty. The later single-asset retry was rate-limited; the observed batch mark cannot pass the seven-day low-volume budget. DefiLlama coins returns no quote for the gecko id or Ethereum contract. The protocol API mirrors $1.15, not an independent market. DexScreener reports one Ethereum dEURO/ETH pool with $2,093.05 liquidity and $406.03 of 24h volume, below the unchanged $50K floor. Blockscout reads only 528 raw units at six decimals (0.000528 EURC) in the protocol-redeem bridge, insufficient for the existing 1,000 dEURO minimum minted depth and full EURC coverage. No admissible market was found. Keep dEURO active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market, restores admitted bridge capacity, or re-reviews by 2026-11-25T23:19:58Z; an alternative CMC lane remains a separate source decision.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=rupiah-token,decentralized-euro,parallel-usdp,xusd-babelfish,gaib-aid,gaib-said,wrapped-itry&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/decentralized-euro/tickers",
      "https://coins.llama.fi/prices/current/coingecko:decentralized-euro,ethereum:0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea,coingecko:parallel-usdp,ethereum:0x9b3a8f7cec208e247d97dee13313690977e24459,coingecko:xusd-babelfish,rsk:0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://api.dexscreener.com/token-pairs/v1/ethereum/0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea",
      "https://eth.blockscout.com/api/v2/addresses/0xb4ff7412f08c22d7381885e8bda9ee9825092fd1/token-balances",
      "https://api.deuro.com/ecosystem/stablecoin/info",
    ],
    reviewedAt: Date.UTC(2026, 10, 11, 23, 19, 58) / 1000,
    expiresAt: Date.UTC(2026, 10, 25, 23, 19, 58) / 1000,
  },
  {
    stablecoinId: "fusd-finchain",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-11 23:19:58 UTC with fresh GETs: DefiLlama detail 390 still resolves FUSD with no price and onCoinGecko false; coins.llama.fi returns no quote for its Ethereum, Avalanche, Sonic or Monad deployments. CoinGecko search for finchain returns no coins and exact-contract DexScreener reads on Ethereum and Avalanche are empty. FinChain API reports 1,226,658.38 FUSD, but its only ratio is FUSDLP reserve_ratio 1.001503 with updated_at 2026-04-21T01:51:35Z and no market price. Ethereum Blockscout reads 950,038.036920 FUSD while the stale issuer API assigns Ethereum 192,803.83; this review does not endorse the issuer supply perimeter. No admissible market was found. Keep FUSD active and the price missing; all admission gates preserved. Owner ops establishes an admitted observed market or re-reviews by 2026-11-25T23:19:58Z.",
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
    reviewedAt: Date.UTC(2026, 10, 11, 23, 19, 58) / 1000,
    expiresAt: Date.UTC(2026, 10, 25, 23, 19, 58) / 1000,
  },
  {
    stablecoinId: "usdp-parallel",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-11 23:19:58 UTC: the successful 23:17:26 UTC CoinGecko batch GET reports parallel-usdp $0.999336 dated 2026-11-11T02:02:58Z; its only ticker is Project X USD0/USDp, last traded 2026-11-10T18:01:58Z, $1.95 of 24h volume and is_stale true. The later single-asset retry was rate-limited; the batch mark is outside the 15-minute primary budget. DefiLlama coins returns no quote for the gecko id or Ethereum contract. The largest observed HyperEVM pool, Project X USD0/USDp, holds $42,465.68 with zero 24h trades and volume; the next pools hold $36,177.70 and $33,320.00, all below the unchanged $50K floor. PIP-71 describes sunsetting ten unused chain deployments while retaining fourteen; it is not a whole-asset wind-down. No admissible market was found. Keep USDp active and the price missing; all admission gates preserved. Low-volume admission remains an owner source decision. Owner ops establishes an admitted observed market or re-reviews by 2026-11-25T23:19:58Z.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=rupiah-token,decentralized-euro,parallel-usdp,xusd-babelfish,gaib-aid,gaib-said,wrapped-itry&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/parallel-usdp/tickers",
      "https://coins.llama.fi/prices/current/coingecko:decentralized-euro,ethereum:0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea,coingecko:parallel-usdp,ethereum:0x9b3a8f7cec208e247d97dee13313690977e24459,coingecko:xusd-babelfish,rsk:0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://api.geckoterminal.com/api/v2/networks/hyperevm/tokens/0xbe65f0f410a72bec163dc65d46c83699e957d588/pools",
      "https://gov.parallel.best/t/pip-71-sunset-usdp-and-the-bridging-module-on-10-chains/553.json",
    ],
    reviewedAt: Date.UTC(2026, 10, 11, 23, 19, 58) / 1000,
    expiresAt: Date.UTC(2026, 10, 25, 23, 19, 58) / 1000,
  },
  {
    stablecoinId: "xusd-babelfish",
    owner: "ops",
    reason:
      "Re-reviewed 2026-11-11 23:19:58 UTC: the successful 23:17:26 UTC CoinGecko batch GET still reports xusd-babelfish $0.994825 dated 2026-10-31T13:14:42Z and its tickers array is now empty. The later single-asset retry was rate-limited; the batch mark exceeds the seven-day low-volume budget. DefiLlama coins returns no gecko-id or Rootstock-contract quote and GeckoTerminal returns no XUSD pools. Sovryn's 3 November incident report records 541,455.998472 XUSD paid to an attacker-controlled wallet in the 1 November AMM incident, the XUSD/WRBTC pool delisted on 2 November, lending and margin paused, users told not to interact with Sovryn contracts, and 66,134.07 XUSD still blocked in Perimeter withdrawal escrow. Its $0.995 valuation assumption is explicitly not a current quotation. Rootstock Blockscout still reads 761,359.496653 XUSD total supply and 1,147 holders, but that does not prove redemption works. No admissible market was found. Keep the price missing; all admission gates preserved. Owner ops must resolve the venue loss, escrow and lifecycle/redemption-impairment question separately; this source review neither establishes redemption health nor decides a freeze. Establish an admitted observed market or re-review by 2026-11-25T23:19:58Z.",
    sources: [
      "https://api.coingecko.com/api/v3/simple/price?ids=rupiah-token,decentralized-euro,parallel-usdp,xusd-babelfish,gaib-aid,gaib-said,wrapped-itry&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true",
      "https://api.coingecko.com/api/v3/coins/xusd-babelfish/tickers",
      "https://coins.llama.fi/prices/current/coingecko:decentralized-euro,ethereum:0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea,coingecko:parallel-usdp,ethereum:0x9b3a8f7cec208e247d97dee13313690977e24459,coingecko:xusd-babelfish,rsk:0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://api.geckoterminal.com/api/v2/networks/rootstock/tokens/0xb5999795be0ebb5bab23144aa5fd6a02d080299f/pools",
      "https://rootstock.blockscout.com/api/v2/tokens/0xb5999795be0ebb5bab23144aa5fd6a02d080299f",
      "https://forum.sovryn.com/t/sovryn-incident-report-31-october-1-november-2026/3609.json",
    ],
    reviewedAt: Date.UTC(2026, 10, 11, 23, 19, 58) / 1000,
    expiresAt: Date.UTC(2026, 10, 25, 23, 19, 58) / 1000,
  },
  {
    stablecoinId: "hbd-hive",
    owner: "ops",
    reason:
      "Reviewed 2026-11-12 19:32 UTC: HBD's admitted price path remains the native Hive internal market (hive-native-cg), requiring a non-self trade within 900 seconds plus spread, depth, turnover and a fresh HIVE/USD parent. Today's 19:03 production generation admitted $0.993366682 with observation clock 19:00:56 UTC. Fresh reads at 19:31:53 UTC from api.hive.blog and api.deathwing.me agree on bid/ask 0.042739524883/0.04283 HBD per HIVE (0.2115% spread) and 5,391.966/1,468.08 HBD of depth within 2%; deathwing's newest non-self trade is 19:26:36 UTC and its 1,000-row trade history proves 2,566.53 HBD of non-self 24h turnover. A replay of the 97 quarter-hour boundaries from 2026-11-11 19:30 through 2026-11-12 19:30 UTC finds 34 without a non-self trade inside 900 seconds, so intermittent missing runs remain justified. CoinGecko hive_dollar is $1.24 at 19:31:46 UTC, outside the existing $1.19 bound; both tickers are the duplicated Upbit-family BTC/HBD book ($31,179 reported volume each), with Upbit's 3.875969% spread and latest trade 18:45:31 UTC. HBD has no reviewed contract deployment for DEX, contract or exact-address recovery. Keep HBD active and its missing runs missing; all admission gates preserved. Owner ops re-reviews the native-trade cadence or establishes another admitted market by this review's expiry, 2026-11-26 19:32 UTC.",
    sources: [
      "https://api.hive.blog",
      "https://api.deathwing.me",
      "https://api.coingecko.com/api/v3/coins/hive_dollar/tickers",
    ],
    reviewedAt: Date.UTC(2026, 10, 12, 19, 32) / 1000,
    expiresAt: Date.UTC(2026, 10, 26, 19, 32) / 1000,
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
