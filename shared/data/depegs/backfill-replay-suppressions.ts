/**
 * Reviewed depeg backfill replay-suppression registry (ADR-32 guarded).
 *
 * An entry records an operator verdict that a recomputed backfill episode is a
 * price-feed artifact, not a market depeg: backfill replay (the
 * buildBackfillPlan -> executeBackfillForCoin -> applyBackfillEvents pipeline)
 * must never persist episodes whose window overlaps a matching entry. This is
 * what keeps reviewed artifact deletions durable against future admin replays,
 * which otherwise delete + recompute every `source='backfill'` row.
 *
 * Entries are reviewed data: each one cites the primary evidence behind the
 * verdict. The corpus is validated at module initialization (fail closed, the
 * `shared/data/annotations/curated-annotations.ts` precedent) and the
 * registry-integrity vitest suite in `__tests__/` guards coin ids and
 * cross-entry overlap against the stablecoin catalog.
 */
import canonicalOrderAsset from "../stablecoins/canonical-order.json";
import { DepegDirectionSchema } from "@shared/types/market";
import type { DepegDirection } from "@shared/types/market";

export interface BackfillReplaySuppression {
  /** Tracked stablecoin id whose recomputed backfill episodes are suppressed. */
  readonly coinId: string;
  /** Depeg side the verdict applies to (existing DepegDirection vocabulary). */
  readonly direction: DepegDirection;
  /** Inclusive UTC window bounds, Unix seconds. */
  readonly windowStart: number;
  /** Inclusive UTC window bounds, Unix seconds. */
  readonly windowEnd: number;
  /** Reviewed verdict, stated as the artifact conclusion. */
  readonly reason: string;
  /** Primary evidence (on-chain forensics + price-feed pages) behind the verdict. */
  readonly evidenceUrls: readonly string[];
  /** Date the evidence was reviewed (YYYY-MM-DD, UTC). */
  readonly reviewedAt: string;
}

const REVIEWED_AT = "2026-09-22";
const REASON =
  "CoinGecko last-trade print artifact: no economic-size on-chain USN trade executed above 1.0011 in the window; pool mids stayed ~$1.000.";

/**
 * Reviewed suppression windows for Noon USN upside and DOLA two-sided artifacts. Windows span
 * the union of the stored episode, its dust/recovery transactions, and a ±2h
 * margin: CoinGecko's current history has already moved episode edges and peaks
 * by up to ~1h versus the captured samples (see evidence), and hourly sample
 * granularity means one revised sample shifts an episode edge by 3600s.
 */
export const BACKFILL_REPLAY_SUPPRESSIONS: readonly BackfillReplaySuppression[] = [
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_759_849_487, // 2025-10-07T15:04:47Z
    windowEnd: 1_759_878_119, // 2025-10-07T23:01:59Z
    reason: REASON,
    evidenceUrls: [
      "https://etherscan.io/tx/0xb7de18d338721b6d57f429239ed8b0a1f4b9347aff114823db559206f932d2c1",
      "https://etherscan.io/tx/0x4d6f52b8fad9a6878155dc8e3f18a0995c33f76e16b532cdca19e277da60d971",
      "https://etherscan.io/tx/0x159e87e14969caafd667b27944a8d9b72b9296f0ad1ca77b67867dcb045d8c9b",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_766_853_587, // 2025-12-27T16:39:47Z
    windowEnd: 1_766_894_494, // 2025-12-28T04:01:34Z
    reason: REASON,
    evidenceUrls: [
      "https://etherscan.io/tx/0x7014ed8ca2b1537276bd37058cb54c3ebdc44c998714c59b203097b72a56966f",
      "https://etherscan.io/tx/0x9e0b9b3f05d4a40aadd0528666b878fcc0a222e7ddb4ad1700658ec0730bd363",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_771_065_524, // 2026-02-14T10:38:44Z
    windowEnd: 1_771_104_920, // 2026-02-14T21:35:20Z
    reason: REASON,
    evidenceUrls: [
      "https://starkscan.co/tx/0x07d34fc678b61239d32725b01bfd2bb6d7669b58d2f782e98e6631b0315106c9",
      "https://starkscan.co/tx/0x0273de25b5c85ca7d851b3cbf1824565506632b03cf4f9818d4b356fa86ddea3",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_772_453_730, // 2026-03-02T12:15:30Z
    windowEnd: 1_772_471_721, // 2026-03-02T17:15:21Z
    reason: REASON,
    evidenceUrls: [
      "https://starkscan.co/tx/0x04c69b971c345f9774d24495062f50d7eda09d661ca67e8517e0ccafcded9b31",
      "https://starkscan.co/tx/0x04fdf45b0020118046ec7de859377cfe968910de8361644ab2afbabc3eb2ac93",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "dola-inverse-finance",
    direction: "below",
    windowStart: 1_707_602_628, // 2024-02-10T22:03:48Z (stored start − 2h)
    windowEnd: 1_707_660_185, // 2024-02-11T14:03:05Z (stored end + 2h)
    reason:
      "CoinGecko last-trade print artifact: one 0.101649 DOLA sample with no further sample for ~12h; no observed venue printed below 0.96 in the window and a 44,133 DOLA Curve DOLA/FRAXBP trade executed at 0.995317 (block 19201299).",
    evidenceUrls: [
      "https://etherscan.io/tx/0xd993da53705884ec3fab6b6262f52ebbab570858bcf345830b7f387a5de12474",
      "https://www.coingecko.com/en/coins/dola-usd",
    ],
    reviewedAt: "2026-10-17",
  },
  {
    coinId: "dola-inverse-finance",
    direction: "above",
    windowStart: 1_678_780_927, // 2023-03-14T08:02:07Z (stored start − 2h)
    windowEnd: 1_678_806_236, // 2023-03-14T15:03:56Z (stored end + 2h)
    reason:
      "CoinGecko last-trade print artifact: 1.540/1.568/1.645 DOLA samples between 09:57Z and 12:01Z; executed Curve trades in the same window printed 0.9953-0.9965 (20,000 DOLA -> 19,910.22 USDC at block 16826133).",
    evidenceUrls: [
      "https://etherscan.io/tx/0x47a9e16ccb59edd396a26ca5ef15978db8c6074393f0e4e3611e79cf6fbdedb1",
      "https://www.coingecko.com/en/coins/dola-usd",
    ],
    reviewedAt: "2026-10-17",
  },
  // 2026-10-30 verified plausibility review (t5). These windows record the
  // reviewed artifact conclusion so a later bounded replay cannot recreate the
  // removed rows. Venue forensics and the sealed-DDR check remain deletion
  // preconditions in the runbook; a registry entry alone does not authorize it.
  {
    coinId: "alusd-alchemix",
    direction: "below",
    windowStart: 1_616_187_644, // 2021-03-19T21:00:44Z
    windowEnd: 1_621_680_956, // 2021-05-22T10:55:56Z
    reason:
      "CoinGecko/DefiLlama alUSD 2021 series is one degenerate feed: a 0.0602 all-time low on a ~$200M 1:1-redeemable CDP token, whipsawing 30-65% per day while DAI, USDC, LUSD, FRAX and USDP stayed within ~1.6% of par; no economic-size trade printed at the stored discounts.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:alchemix-usd?start=1615500000&span=70&period=1d",
      "https://defillama.com/token/alusd",
      "https://www.coingecko.com/en/coins/alchemix-usd",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "alusd-alchemix",
    direction: "above",
    windowStart: 1_616_191_262, // 2021-03-19T22:01:02Z
    windowEnd: 1_617_946_447, // 2021-04-09T05:34:07Z
    reason:
      "Same alUSD feed printing 2.1274 and 1.8815 against par for a token mintable at ~$1; the prints also sit above Pharos's own 1.19 USD ceiling and no venue traded at the premium.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:alchemix-usd?start=1616351380&span=20&period=1h",
      "https://www.gate.io/zh/price/alchemix-usd-alusd",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "cadc-cad-coin",
    direction: "above",
    windowStart: 1_637_618_400, // 2021-11-22T22:00:00Z
    windowEnd: 1_664_676_000, // 2022-10-02T02:00:00Z
    reason:
      "CoinGecko's cad-coin native series alternates between the USD print and an FX-scaled print (USD/CAD applied twice); CADC redeems 1:1 for CAD at ATB Financial, so the 38-86% premium for eleven months is impossible and every stored row divides back to DefiLlama's same-day USD print within 0.4%.",
    evidenceUrls: [
      "https://api.frankfurter.app/2021-11-01..2022-10-14?from=USD&to=CAD",
      "https://coins.llama.fi/chart/coingecko:cad-coin?start=1636848000&span=340&period=1d",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "dgld-gold-token-sa",
    direction: "above",
    windowStart: 1_771_879_557, // 2026-02-23T20:45:57Z
    windowEnd: 1_772_051_457, // 2026-02-25T20:30:57Z
    reason:
      "Upstream DGLD quote printed ~2.03-2.06x gold spot (10,591 vs 5,140-5,227 USD/oz) on 2026-02-23/24 while the token count stayed at 1,603.69; a 1-oz claim cannot trade at twice spot and the issuer's 2026-02-23 exploit produced downside prints, not a premium.",
    evidenceUrls: [
      "https://coins.llama.fi/prices/historical/1771886757/coingecko:gold-token-sa-dgld-tokenized-gold",
      "https://dgld.ch/news/post-incident-report-february-2026-exploit",
      "https://congthuong.vn/gia-vang-hom-nay-ngay-24-2-lap-dinh-3-tuan-qua-444035.media",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "dgld-gold-token-sa",
    direction: "below",
    windowStart: 1_771_826_531, // 2026-02-23T06:02:11Z
    windowEnd: 1_771_894_974, // 2026-02-24T01:02:54Z
    reason:
      "Companion 0.5037x/0.7950x prints from the same broken DGLD provider series on 2026-02-23; gold spot and peer tokens (PAXG 5,257, XAUT 5,216, XNK 5,239) never printed there.",
    evidenceUrls: [
      "https://coins.llama.fi/prices/historical/1771886757/coingecko:gold-token-sa-dgld-tokenized-gold",
      "https://dgld.ch/news/post-incident-report-february-2026-exploit",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "idrt-rupiah-token",
    direction: "above",
    windowStart: 1_597_269_600, // 2020-08-12T22:00:00Z
    windowEnd: 1_597_370_400, // 2020-08-14T02:00:00Z
    reason:
      "CoinGecko IDR tape printed 1.70 IDR against a 1.0 peg for one day and reverted; CMC's day series tops out near 1.007 IDR and no IDRT pool printed the premium.",
    evidenceUrls: [
      "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id=4702&convertId=2781&timeStart=1597104000&timeEnd=1597449600",
      "https://coins.llama.fi/chart/coingecko:rupiah-token?start=1597100000&span=40&period=1d",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "idrt-rupiah-token",
    direction: "above",
    windowStart: 1_615_240_800, // 2021-03-08T22:00:00Z
    windowEnd: 1_615_341_600, // 2021-03-10T02:00:00Z
    reason:
      "The same IDRT IDR tape printed 1.798 IDR for one day (2021-03-09) and reverted; CMC's day series shows no print near the implied 0.000124 USD.",
    evidenceUrls: [
      "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id=4702&convertId=2781&timeStart=1615075200&timeEnd=1615420800",
      "https://coins.llama.fi/chart/coingecko:rupiah-token?start=1614900000&span=30&period=1d",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "idrt-rupiah-token",
    direction: "below",
    windowStart: 1_763_416_800, // 2025-11-17T22:00:00Z
    windowEnd: 1_764_381_600, // 2025-11-29T02:00:00Z
    reason:
      "CoinGecko's IDR tape printed 0.1527, 0.0291 and 0.0756 against a 1.0 peg and reverted within hours; every aggregatable IDRT pool held $4.90-$46 and the Uniswap-v4 BSC pool that fed the tape was created at the exact onset, while market cap moved only with the price leg and circulating supply stayed at 173,856,905,811 tokens.",
    evidenceUrls: [
      "https://api.coingecko.com/api/v3/coins/rupiah-token/market_chart/range?vs_currency=idr&from=1763251200&to=1764201600",
      "https://api.geckoterminal.com/api/v2/networks/bsc/tokens/0x66207e39bb77e6b99aab56795c7c340c08520d83/pools",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "gusd-gemini",
    direction: "above",
    windowStart: 1_539_243_835, // 2018-10-11T07:43:55Z
    windowEnd: 1_540_828_107, // 2018-10-29T15:48:27Z
    reason:
      "Gemini Dollar 2018 single prints of 1.7254 and 1.3578 against a 1.0 peg, absent from the Yahoo/aggregator daily series and reverting immediately; no venue traded at the premium.",
    evidenceUrls: [
      "https://query1.finance.yahoo.com/v8/finance/chart/GUSD-USD?period1=1539043200&period2=1540944000&interval=1d",
      "https://coincodex.com/crypto/gemini-dollar/",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "mim-abracadabra",
    direction: "below",
    windowStart: 1_723_599_067, // 2024-08-14T01:31:07Z
    windowEnd: 1_723_714_343, // 2024-08-15T09:32:23Z
    reason:
      "MIM single wick prints of 0.5432 and 0.2497 on 2024-08-14/15 reverted within an hour; CoinGecko hourly series for both MIM contracts prints par around them and no pool traded at the discount.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/ethereum:0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3?start=1723507200&span=72&period=1h",
      "https://coins.llama.fi/chart/arbitrum:0xFEa7a6a0B346362BF88A9e4A88416B77a57D6c2A?start=1723593600&span=30&period=1h",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "susd-synthetix",
    direction: "above",
    windowStart: 1_570_158_017, // 2019-10-04T03:00:17Z
    windowEnd: 1_570_179_730, // 2019-10-04T09:02:10Z
    reason:
      "sUSD 2019-10-04 single 1.9504 print against a 1.0 peg; the hourly sUSD/NUSD series and the historical price endpoint print ~par around it.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:nusd?period=1h&start=1570140000&span=40",
      "https://coins.llama.fi/prices/historical/1570165217/ethereum:0x57Ab1ec28D129707052df4dF418D58a2D46d5f51",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "dola-inverse-finance",
    direction: "above",
    windowStart: 1_636_795_459, // 2021-11-13T09:24:19Z
    windowEnd: 1_636_820_694, // 2021-11-13T16:24:54Z
    reason:
      "DOLA 2021-11-13 single 1.8710 print against a 1.0 peg; DefiLlama historical samples around it are ~1.00 and the reviewed 2023/2024 DOLA windows establish the same CoinGecko last-trade artifact class.",
    evidenceUrls: [
      "https://coins.llama.fi/prices/historical/1636802659/",
      "https://coins.llama.fi/chart/ethereum:0x865377367054516e17014CcdED1e7d814EDC9ce4?start=1636588800&span=7&period=1d",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "usdg-paxos",
    direction: "above",
    windowStart: 1_738_188_231, // 2025-01-29T22:03:51Z
    windowEnd: 1_738_206_230, // 2025-01-30T03:03:50Z
    reason:
      "USDG 2025-01-30 single 1.6544 print against a 1.0 peg; the DefiLlama 1h series prints par either side and the neighboring 1.2960 row is the same provider glitch.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:global-dollar?start=1738191600&span=30&period=1h&searchWidth=1h",
      "https://investors.defillama.com/token/USDG",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "a7a5-old-vector",
    direction: "below",
    windowStart: 1_755_208_800, // 2025-08-14T22:00:00Z
    windowEnd: 1_756_778_400, // 2025-09-02T02:00:00Z
    reason:
      "A7A5 printed 0.000844 against its 1.0 native reference during the 2025-08 sanction volatility while the provider's daily series and independent marks stayed near $0.012; the stored -9992 bps is a single-feed artifact, not a real depeg.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:a7a5?start=1754006400&span=70&period=1d",
      "https://www.coindesk.com/policy/2025/08/14/ofac-sanctions-crypto-network-behind-ruble-backed-stablecoin-and-shuttered-exchange-garantex",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "uusd-youves",
    direction: "above",
    windowStart: 1_687_294_886, // 2023-06-20T21:01:26Z
    windowEnd: 1_687_312_879, // 2023-06-21T02:01:19Z
    reason:
      "youves uUSD's 2023-06-20 single 1.8890 print against a 1.0 peg; the hourly series prints ~1.00 adjacent and no pool traded at the premium.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:youves-uusd?start=1687219200&span=24&period=1h",
      "https://www.coinlore.com/coin/youves-uusd/historical-data",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "eurc-circle",
    direction: "below",
    windowStart: 1_670_623_200, // 2022-12-09T22:00:00Z
    windowEnd: 1_670_896_800, // 2022-12-13T02:00:00Z
    reason:
      "EURC's 2022-12-10 single 0.0501 print against a 1.0 EUR peg (EUR/USD 1.05); the daily EURC series prints ~1.00 and the ECB reference confirms 1.05, so the print is a provider artifact rather than an economic depeg.",
    evidenceUrls: [
      "https://api.frankfurter.app/2022-12-09?from=EUR&to=USD",
      "https://coins.llama.fi/chart/coingecko:euro-coin?start=1670457600&span=10&period=1d",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "usdo-openeden",
    direction: "above",
    windowStart: 1_745_201_079, // 2025-04-21T02:04:39Z
    windowEnd: 1_745_226_280, // 2025-04-21T09:04:40Z
    reason:
      "OpenEden USDO's 2025-04-21 single 2.6798 print against a 1.0 peg; CoinGecko/CMC daily series print ~1.00 and the pool set shows no premium.",
    evidenceUrls: [
      "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id=36067&convertId=2781&timeStart=1745000000&timeEnd=1745330000",
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe/pools",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "tryb-bilira",
    direction: "below",
    windowStart: 1_742_594_400, // 2025-03-21T22:00:00Z
    windowEnd: 1_743_040_800, // 2025-03-27T02:00:00Z
    reason:
      "BiLira's 2025-03-22 native TRY print of 0.0662 against a 1.0 TRY peg (0.00037 USD vs a 0.0252 USD CMC close); the ECB USD/TRY reference and the provider's own daily series show a single-feed artifact, not a -93% discount.",
    evidenceUrls: [
      "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id=5181&convertId=2781&timeStart=1742515200&timeEnd=1743033600&interval=1d",
      "https://api.frankfurter.app/2025-03-22?from=USD&to=TRY",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "tryb-bilira",
    direction: "above",
    windowStart: 1_751_666_400, // 2025-07-04T22:00:00Z
    windowEnd: 1_751_853_600, // 2025-07-07T02:00:00Z
    reason:
      "BiLira's 2025-07-05 +26.95% print on a TRY peg; CMC's daily close is flat at 0.0251 and the native/USD series never leaves the FX band.",
    evidenceUrls: [
      "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id=5181&convertId=2781&timeStart=1751500800&timeEnd=1751932800&interval=1d",
      "https://api.frankfurter.app/2025-07-05?from=USD&to=TRY",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "msusd-metronome",
    direction: "above",
    windowStart: 1_755_169_258, // 2025-08-14T11:00:58Z
    windowEnd: 1_755_187_264, // 2025-08-14T16:01:04Z
    reason:
      "msUSD's 2025-08-14 single-hour 1.4825 sample appears as an isolated tick between parity readings in the provider's own series; the row lasts exactly one interval.",
    evidenceUrls: [
      "https://coins.llama.fi/prices/historical/1755176404/ethereum:0xab5eb14c09d416f0ac63661e57edb7aecdb9befa",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "msusd-metronome",
    direction: "above",
    windowStart: 1_760_605_389, // 2025-10-16T09:03:09Z
    windowEnd: 1_760_623_372, // 2025-10-16T14:02:52Z
    reason:
      "msUSD's 2025-10-16 single-hour 3.4314 sample is an isolated provider tick between parity readings; the 1h series prints par either side.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/ethereum:0xab5eb14c09d416f0ac63661e57edb7aecdb9befa?start=1760580000&span=60&period=1h",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "xnk-kinka",
    direction: "above",
    windowStart: 1_735_733_336, // 2025-01-01T12:08:56Z
    windowEnd: 1_735_751_063, // 2025-01-01T17:04:23Z
    reason:
      "XNK's 2025-01-01 55-minute 1.8413x gold-spot print (4,846.93 vs 2,632.29 per token) while the provider's own daily series placed XNK at 2,619.54 that day; no pool or peer corroborated the spike.",
    evidenceUrls: [
      "https://coins.llama.fi/chart/coingecko:kinka?start=1735516800&span=3&period=1d",
      "https://coins.llama.fi/chart/coingecko:pax-gold?start=1735603200&span=3&period=1d",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "eurs-stasis",
    direction: "above",
    windowStart: 1_737_237_600, // 2025-01-18T22:00:00Z
    windowEnd: 1_737_424_800, // 2025-01-21T02:00:00Z
    reason:
      "EURS's 2025-01-19 native print of 1.2322 against a 1.0 EUR peg while the published USD price was 1.031; a single CoinGecko soft quote, not an economic +23% premium.",
    evidenceUrls: [
      "https://api.coingecko.com/api/v3/coins/stasis-eurs/market_chart/range?vs_currency=usd&from=1737244800&to=1737374400",
    ],
    reviewedAt: "2026-10-30",
  },
  // 2026-10-30 t5-w3 verified plausibility review (second wave). The four
  // tracked-coin entries below record reviewed artifact verdicts; the
  // untracked RAI/IRON/RUBT/GOLD-VRO rows cannot be registered here because
  // the corpus rejects ids absent from canonical-order.json.
  {
    coinId: "axcnh-anchorx",
    direction: "below",
    windowStart: 1_785_808_966, // 2026-08-04T02:02:46Z (stored start − 2h)
    windowEnd: 1_785_844_983, // 2026-08-04T12:03:03Z (stored end + 2h)
    reason:
      "CoinGecko native-CNY quote artifact: vs_currencies=cny returned 0.4717-0.4714 while the same provider's USD feed pinned AxCNH at $0.1438-0.1453 (=0.985 CNH, −148 bps) through 04:02-10:03 UTC; no supply change (5,627,925 -> 5,685,720 USD) and a 346-day USD range of 0.1363-0.1505.",
    evidenceUrls: [
      "https://pharos.watch/depeg/axcnh-2026-08-04/",
      "https://coinmarketcap.com/currencies/axcnh/",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "satusd-river",
    direction: "below",
    windowStart: 1_764_201_687, // 2025-11-27T00:01:27Z (stored start − 2h)
    windowEnd: 1_764_237_693, // 2025-11-27T10:01:33Z (stored end + 2h)
    reason:
      "CoinGecko satUSD hourly series carries one 0.6488937042791159 sample at 07:00Z bracketed by 0.9759037 and 0.9950772; the episode is a routine ~2% discount that the single-point backfill peak raised to −3511 bps.",
    evidenceUrls: [
      "https://api.coingecko.com/api/v3/coins/satoshi-stablecoin/market_chart/range?vs_currency=usd&from=1764201600&to=1764288000",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "jpyc-jpyc",
    direction: "above",
    windowStart: 1_778_552_331, // 2026-05-12T02:18:51Z (stored start − 2h)
    windowEnd: 1_780_075_277, // 2026-05-29T17:21:17Z (stored end + 2h)
    reason:
      "Catalog mis-attribution: from 2026-05-11 to 2026-05-29 the current JPYC row carried the deprecated JPYC v2 geckoId 'jpy-coin', so the primary CoinGecko lane published that token's ~$0.0076 quote against the current coin's 0.00634 peg reference for 17.5 days; the coin's own contract held par and the +2102 bps 'recovery' is the catalog revert.",
    evidenceUrls: [
      "https://www.coingecko.com/en/coins/jpy-coin",
      "https://coins.llama.fi/prices/historical/1778803200/ethereum:0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
    ],
    reviewedAt: "2026-10-30",
  },
  {
    coinId: "usdt-tether",
    direction: "below",
    windowStart: 1_533_490_538, // 2018-08-05T17:35:38Z (cluster start − 2h)
    windowEnd: 1_534_238_686, // 2018-08-14T09:24:46Z (cluster end + 2h)
    reason:
      "USDT's 2018-08-05..08-14 hourly CoinGecko series prints 0.7518-0.9850 against a $1 peg while the verified 2018 low was $0.9251 and the same hours print TUSD 1.2346 / sUSD 0.8255; the two-point confirmation was satisfied by two consecutive corrupted samples, not a market depeg.",
    evidenceUrls: [
      "https://www.coinlore.com/coin/tether/historical-data",
      "https://www.caixinglobal.com/2018-10-16/dollar-pegged-cryptocurrency-drops-to18-month-low-on-transparency-concerns-101335654.html",
    ],
    reviewedAt: "2026-10-30",
  },
];

const KNOWN_STABLECOIN_IDS = new Set(canonicalOrderAsset as readonly string[]);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(index: number, message: string): never {
  throw new Error(`Invalid backfill replay suppression [${index}]: ${message}`);
}

function validateRegistry(entries: readonly BackfillReplaySuppression[]): void {
  entries.forEach((entry, index) => {
    if (!KNOWN_STABLECOIN_IDS.has(entry.coinId)) {
      invalid(index, `unknown stablecoin id ${entry.coinId}`);
    }
    if (!DepegDirectionSchema.options.includes(entry.direction)) {
      invalid(index, `direction must be one of ${DepegDirectionSchema.options.join(", ")}`);
    }
    if (!Number.isInteger(entry.windowStart) || !Number.isInteger(entry.windowEnd)) {
      invalid(index, "window bounds must be integer Unix seconds");
    }
    if (entry.windowStart >= entry.windowEnd) {
      invalid(index, "windowStart must be before windowEnd");
    }
    if (entry.reason.trim().length === 0) {
      invalid(index, "reason must be non-empty");
    }
    if (!DATE_ONLY_RE.test(entry.reviewedAt) || Number.isNaN(Date.parse(entry.reviewedAt))) {
      invalid(index, "reviewedAt must be a YYYY-MM-DD date");
    }
    if (entry.evidenceUrls.length === 0) {
      invalid(index, "at least one evidence URL is required");
    }
    entry.evidenceUrls.forEach((url, urlIndex) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        invalid(index, `evidenceUrls[${urlIndex}] is not a valid URL: ${url}`);
      }
      if (parsed.protocol !== "https:") {
        invalid(index, `evidenceUrls[${urlIndex}] must use https: ${url}`);
      }
    });
  });
}

validateRegistry(BACKFILL_REPLAY_SUPPRESSIONS);

/**
 * Interval-overlap test between a recomputed backfill episode and a suppression
 * window. Both bounds are inclusive: an episode shares at least one second with
 * the window iff `episodeStart <= windowEnd && windowStart <= episodeEnd`.
 * Open episodes (endedAt null) are treated as point-in-time intervals at their
 * start, matching how the live/open rows are compared elsewhere.
 */
export function backfillEpisodeInSuppressionWindow(
  episode: { startedAt: number; endedAt: number | null },
  entry: Pick<BackfillReplaySuppression, "windowStart" | "windowEnd">,
): boolean {
  const episodeEnd = episode.endedAt ?? episode.startedAt;
  return episode.startedAt <= entry.windowEnd && entry.windowStart <= episodeEnd;
}

/**
 * Returns the reviewed suppression covering a recomputed backfill episode for
 * this coin and direction, or null when the episode is not suppressed.
 */
export function findBackfillReplaySuppression(
  coinId: string,
  direction: string,
  episode: { startedAt: number; endedAt: number | null },
): BackfillReplaySuppression | null {
  return BACKFILL_REPLAY_SUPPRESSIONS.find(
    (entry) =>
      entry.coinId === coinId &&
      entry.direction === direction &&
      backfillEpisodeInSuppressionWindow(episode, entry),
  ) ?? null;
}
