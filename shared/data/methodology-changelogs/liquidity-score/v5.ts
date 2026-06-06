import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const LIQUIDITY_SCORE_V5: readonly MethodologyChangelogEntry[] = [
  {
    version: "5.8",
    title: "Retained-pool DEX price ownership hardening",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "DEX implied-price publication now reapplies the documented $50K retained-pool price floor and weights medians by source family instead of protocol labels.",
    impact: [
      "Retained pools below the $50K DEX price-observation floor can still contribute to liquidity scoring when otherwise eligible, but no longer publish dex_price_usd or price_sources_json rows",
      "DEX price median weighting now uses canonical source families: DeFiLlama and direct API at 1.0, CoinGecko Onchain and GeckoTerminal at 0.85, DexScreener and CoinGecko tickers at 0.55",
      "Fallback rows that claim high-trust protocol names can no longer receive primary-source median weight solely from the protocol label",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.7",
    title: "Peg-aware staged discovery price gate",
    date: "2026-05-20",
    effectiveAt: 1779235200,
    summary:
      "Secondary discovery pools now need a plausible tracked-token price before their TVL can be staged or merged into Liquidity Score aggregates.",
    impact: [
      "CoinGecko Onchain and GeckoTerminal pool rows whose tracked-token price fails the existing peg-aware DEX observation sanity gate are rejected before staging",
      "Already-staged rows with implausible tracked-token prices are skipped during scoring merge, so malformed discovery rows cannot inflate coin or global TVL until their staging TTL expires",
      "Carbon DeFi chain-suffixed secondary-source ids now normalize to the DefiLlama `carbon-defi` protocol cap, adding a cap-level backstop for Carbon rows",
      "Rows without a measured token price still flow through the existing TVL, volume, dedupe, protocol-cap, and retained-pool quality gates",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.6",
    title: "Staged discovery TVL sanity ceiling",
    date: "2026-05-07",
    effectiveAt: 1778144000,
    summary:
      "Secondary discovery rows now reject impossible pool TVL before staging and skip any already-staged over-cap row during the scoring merge.",
    impact: [
      "CoinGecko Onchain, GeckoTerminal, DexScreener, and CoinGecko ticker staging can no longer persist non-finite, negative, or over-cap TVL values",
      "The scoring cron skips legacy staged rows above the same sanity ceiling before they can affect global TVL, coverage drift, or DEX price observations",
      "Valid high-liquidity pools below the ceiling continue through the existing dedupe, protocol-cap, and retained-pool quality gates",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.5",
    title: "Absolute TVL Depth fallback recalibration and Slipstream sqrt_ratio price",
    date: "2026-04-17",
    effectiveAt: 1776384000,
    summary:
      "Absolute TVL Depth fallback (used when circulatingUsd is unavailable) now shares the ratio formula's anchor via a $1B implied reference mcap. Aerodrome/Velodrome Slipstream price derivation now uses on-chain sqrt_ratio (Q64.96) instead of total-reserve ratios for concentrated liquidity pools.",
    impact: [
      "Absolute TVL Depth fallback: `20 * log10(tvl / 100_000) + 20` → `35 * log10(tvl / 700_000)`; coins without market cap data no longer gain ~24 points of unearned TVL Depth",
      "Aerodrome/Velodrome Slipstream price observations now derive from on-chain sqrt_ratio instead of reserve ratios; concentrated liquidity pools no longer emit biased spot prices when one side lacks a tracked USD price",
      "Slipstream pools where sqrt_ratio is unusable and one side has no tracked price are now dropped entirely (no reserve-ratio fallback derivation)",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.4",
    title: "Curve enrichment scoping and staged UUID dedupe",
    date: "2026-04-14",
    effectiveAt: 1776165200,
    summary:
      "Curve API enrichment is now scoped to Curve DeFiLlama rows, and staged exact pool-id rows can dedupe against a single identity-poor DeFiLlama UUID row through the same narrow optional-metadata wildcard used by primary dedupe.",
    impact: [
      "Non-Curve DeFiLlama pools that share token symbols with a Curve pool no longer inherit Curve registry metadata, balance ratios, token prices, or metapool-adjusted TVL",
      "CoinGecko/GeckoTerminal provider ids with underscores or provider suffixes normalize to the same canonical protocol family as DeFiLlama ids during pool-identity construction",
      "Staged discovery now skips a staged exact pool-id row when it uniquely matches one primary DeFiLlama UUID row by chain, protocol, token set, and pool-shape family, while ambiguous same-pair staged buckets still remain separate",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.3",
    title: "PancakeSwap trailing-hour volume window",
    date: "2026-04-08",
    effectiveAt: 1775613600,
    summary:
      "PancakeSwap V3 direct volume now sums the official `poolHourDatas.volumeUSD` buckets across a bounded trailing 24-hour window instead of treating the latest `poolDayDatas` row as if it were a rolling 24h metric.",
    impact: [
      "Intraday PancakeSwap volume no longer collapses toward zero until UTC rollover just because the current day bucket has only accumulated partial activity",
      "Fresh non-swap day buckets can no longer zero out yesterday's still-relevant trading activity, because trailing volume now comes from summed hourly swap buckets",
      "The PancakeSwap direct fetch keeps bounded batching under The Graph row cap while staying on official subgraph entities instead of adding a new historical block lookup dependency",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.2",
    title: "Orderbook ticker contract refresh and Balancer exact-address identity",
    date: "2026-04-08",
    effectiveAt: 1775606400,
    summary:
      "CoinGecko orderbook fallback now ignores the deprecated `trust_score` field and validates tickers by observable freshness/price/volume fields, while Balancer direct pools now use the API's exact pool address for identity instead of the 32-byte vault pool id.",
    impact: [
      "CoinGecko tickers fallback and discovery staging no longer drop every post-March-2026 ticker row just because CoinGecko now returns `trust_score = null`",
      "Orderbook fallback ticker intake now requires finite USD price/volume plus a stable exchange identifier, improving sanitization without depending on deprecated metadata",
      "Balancer direct API pools now reserve and dedupe by the true pool address, restoring exact-id confirmation against staged discovery and overlap checks",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Authoritative protocol confirmation for staged discovery",
    date: "2026-04-07",
    effectiveAt: 1775520000,
    summary:
      "Staged discovery rows can no longer invent new pools inside protocol families that already have a clean protocol-native direct source. When that authoritative fetch succeeds on a supported chain, staged rows must match one of its exact pool ids or they are excluded.",
    impact: [
      "GeckoTerminal, CoinGecko Onchain, and DexScreener staging rows that claim Balancer, Fluid, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, or Velodrome liquidity now require authoritative exact-id confirmation when the matching direct fetch succeeded cleanly on that chain",
      "The guard fails open when the authoritative source is unavailable or degraded, so discovery sources still recover coverage during native-source incidents instead of hard-zeroing the row",
      "Liquidity cron metadata now records `stagedPoolsSkippedByAuthoritativeProtocol` separately from exact-id and derived-identity dedupe skips",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "Size-aware scoring: relative TVL depth, recalibrated volume, quality retention",
    date: "2026-04-05",
    effectiveAt: 1775347200,
    summary:
      "All scoring dimensions are now size-independent. TVL Depth measures effective TVL relative to market cap instead of absolute dollar value. Volume Activity has a recalibrated curve with a realistic ceiling (tops out at ~32% V/T instead of ~500%). Pool Quality measures venue quality retention ratio (qualityAdjustedTvl / totalTvl, rescaled) instead of absolute quality-adjusted TVL. Weights rebalanced to 30/20/20/20/10.",
    impact: [
      "TVL Depth uses effective-TVL-to-market-cap ratio on a log scale (35 × log10(ratio / 0.0007)), with absolute fallback for coins without market cap data",
      "Volume Activity recalibrated: 38 × (log10(V/T) + 3) — zero line at 0.1% V/T, tops at ~32% V/T. USDC/USDT now score 86-90 instead of 52-56",
      "Pool Quality measures quality retention (qualityAdjustedTvl / totalTvl, rescaled from 15-80% range to 0-100). Fully size-independent",
      "Weights rebalanced from 35/20/22.5/15/7.5 to 30/20/20/20/10 — structural quality (Pool Quality + Durability = 40%) now matches depth + activity (50%)",
      "Coins like BOLD and LUSD with high relative depth ratios see significant score improvements; large-cap coins with low relative depth see depth dimension scores decrease but compensate through volume, durability, and diversity",
    ],
    commits: [],
    reconstructed: false,
  },
];
