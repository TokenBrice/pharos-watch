import { isKinesisWrapperSupplyId } from "./onchain-supply-probe";
import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
} from "../types/aggregate-universe-constants";

const UTC_SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatUtcShortDate(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  return `${UTC_SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export interface MarketPerimeterMarker {
  readonly id: string;
  readonly date: string;
  readonly tsMs: number;
  readonly shortLabel: string;
  readonly note: string;
}

export const MARKET_PERIMETER_MARKERS: readonly MarketPerimeterMarker[] = [
  {
    id: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
    date: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
    tsMs: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC * 1000,
    shortLabel: "Listing policy v2",
    note: `Listing policy v2 (${formatUtcShortDate(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC)}): Pharos totals and non-USD cohorts exclude tokenized fund shares; prior history is unchanged (provider-sourced charts may still include some).`,
  },
] as const;

/**
 * changedAt is first publication of the redefined quantity; evidence may have been read earlier.
 * marketWide marks a step large enough to break whole-market comparisons (total all-time high,
 * market trajectories and ranges); other entries only withhold their own asset's comparisons.
 */
export const SUPPLY_PERIMETER_CHANGES = [
  {
    stablecoinId: "gho-aave",
    changedAt: Date.parse("2026-11-13T10:30:00Z") / 1000,
    chainIds: ["ethereum", "arbitrum", "monad", "plasma"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/pull/987",
    marketWide: true,
  },
  // Quantoz, 2026-11-13: DefiLlama reports the issuer's XRPL treasury account as unreleased. EURQ was
  // then outside the chain dropout guard (CoinGecko detail provider), so the 03:15 UTC sync published the
  // lower figure directly; that clock is inferred from USDQ's pair, which changed in the same commit.
  {
    stablecoinId: "eurq-quantoz",
    changedAt: Date.parse("2026-11-13T03:15:41Z") / 1000,
    chainIds: ["xrpl"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/commit/110fb5b87eaebe9c3f0c957967a91b6d591cf8f3",
    marketWide: false,
  },
  {
    stablecoinId: "usdq-quantoz",
    changedAt: Date.parse("2026-11-13T14:00:00Z") / 1000,
    chainIds: ["xrpl"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/commit/110fb5b87eaebe9c3f0c957967a91b6d591cf8f3",
    marketWide: false,
  },
  // Pricing v6.80: reviewed refusals end CoinGecko gap-fills whose missing-chain remainder is not that chain's stock
  // (USDf: $163.6M Solana remainder double counting DefiLlama's bridged BSC + XDC rows; wPEN: $9.4K HyperEVM
  // remainder with zero supply; apxUSD: $18.9M Solana remainder against 6.27M on-chain). Each refusal takes effect
  // at this clock, so earlier published values counted the larger quantity. Set it at or after the deploy.
  {
    stablecoinId: "usdf-falcon",
    changedAt: Date.parse("2026-11-13T23:00:00Z") / 1000,
    chainIds: ["solana"],
    evidenceUrl: "https://solscan.io/token/9ksrtYx1vnRxr4X5YqmGxqRMRBhgsc6FfQwWjB1KZq2x",
    marketWide: false,
  },
  {
    stablecoinId: "wpen-ripio",
    changedAt: Date.parse("2026-11-13T23:00:00Z") / 1000,
    chainIds: ["hyperevm"],
    evidenceUrl: "https://purrsec.com/token/0x4f34c8b3b5fb6d98da888f0fea543d4d9c9f2ebe",
    marketWide: false,
  },
  {
    stablecoinId: "apxusd-apyx",
    changedAt: Date.parse("2026-11-13T23:00:00Z") / 1000,
    chainIds: ["solana"],
    evidenceUrl: "https://solscan.io/token/HAYQtfJEQ9DbDbaHEhxfGsWbSZ3ywthdsVB3PuB72DYe",
    marketWide: false,
  },
  // Legacy FRAX, 2026-11-19: DefiLlama PR #1001 counts only legacy FRAX under id 6 (frxUSD and canonical L2
  // FRAX removed; list total $136.7M -> $76.0M, no Fraxtal row). Pharos carried the old quantity under the
  // chain-dropout quarantine until the reviewed Fraxtal exclusion takes effect at this clock.
  {
    stablecoinId: "frax-frax",
    changedAt: Date.parse("2026-11-19T20:00:00Z") / 1000,
    chainIds: ["ethereum", "fraxtal"],
    evidenceUrl: "https://github.com/DefiLlama/peggedassets-server/pull/1001",
    marketWide: false,
  },
  // XAUT, 2026-11-19: PR #2157 let the scoped read reach Tether's disclosure, so XAUT moved from DefiLlama's
  // protocol cap to canonical Ethereum supply minus the Tether treasury balance, reconciled to that disclosure
  // (749,423.564532 XAUT; about $2.71B against $2.97B). The 21:45 UTC sync first published it; its finalized
  // block (21:29:59 UTC) is earlier evidence, not adoption.
  {
    stablecoinId: "xaut-tether",
    changedAt: Date.parse("2026-11-19T21:45:15Z") / 1000,
    chainIds: ["ethereum"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/pull/2157",
    marketWide: false,
  },
  // Movement USDCx, 2026-11-22: Pricing v6.91 prefers Movement's pinned-ledger ConcurrentSupply reconciled to
  // Ethereum Circle xReserve (562,714.44 USDCx vs 568,408.47 USDC, +101.19 bps excess) over CoinGecko's
  // stalled market cap ($600,982 frozen since 2026-11-14T00:41:51Z). The 14:45:16 UTC sync, the first on the
  // released Worker, first published it.
  {
    stablecoinId: "usdcx-movement",
    changedAt: Date.parse("2026-11-22T14:45:16Z") / 1000,
    chainIds: ["movement"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2145",
    marketWide: false,
  },
  // === #2169 Wave-1 non-USD reviewed on-chain supply checkpoints ===
  // Transition from undated DefiLlama USD caps to clocked on-chain native totalSupply()
  // checkpoints so DEWS 1d/7d supply velocity activates cleanly without FX-deflation noise.
  // Live parity verified 2026-11-22 within 0.00%-0.074% of DefiLlama (asset-scoped cutovers). The 14:45:16 UTC
  // sync, the first on the released Worker, dropped the DefiLlama rows and first published native counts.
  {
    stablecoinId: "eurcv-societe-generale-forge",
    changedAt: Date.parse("2026-11-22T14:45:16Z") / 1000,
    chainIds: ["ethereum", "xrpl", "stellar", "solana"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "jpysc-sbi-startale",
    changedAt: Date.parse("2026-11-22T14:45:16Z") / 1000,
    chainIds: ["ethereum"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "brla-brla-digital",
    changedAt: Date.parse("2026-11-22T14:45:16Z") / 1000,
    chainIds: ["polygon", "gnosis", "celo", "moonbeam"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "zchf-frankencoin",
    changedAt: Date.parse("2026-11-22T14:45:16Z") / 1000,
    chainIds: ["ethereum", "optimism", "gnosis", "base", "arbitrum", "polygon", "avalanche", "sonic"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "euri-banking-circle",
    changedAt: Date.parse("2026-11-22T14:45:16Z") / 1000,
    chainIds: ["ethereum", "bsc"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  // === #2169 D5: EURC reviewed on-chain circulating supply checkpoints ===
  // Transition from undated DefiLlama USD cap to clocked 9-chain issuer-native circulating supply
  // (Solana minus Circle's three official pre-mint treasury accounts; five Ethereum-escrowed
  // bridge representations conserved in Ethereum totalSupply). Live parity verified 2026-11-23
  // within -0.000055% of Circle's API (459,761,121.36 vs 459,761,376.36 EURC). Released so the
  // Worker deploy completes before the 16:45 UTC quarter-hourly sync-stablecoins slot, the first
  // production run on the new perimeter.
  {
    stablecoinId: "eurc-circle",
    changedAt: Date.parse("2026-11-23T16:45:00Z") / 1000,
    chainIds: [
      "ethereum", "base", "avalanche", "worldchain", "stellar", "solana", "cronos", "plasma", "arc",
      "polygon", "sonic", "tempo", "cardano", "optimism",
    ],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  // Listing policy v2 (core-stablecoins-v2): Pharos stablecoin totals and non-USD cohorts exclude
  // tokenized fund shares from the cutover without restating pre-cutover core-stablecoins-v1
  // history; provider-sourced /api/stablecoin-charts may still include llamaId fund shares while
  // non-llamaId fund overlays end at the cutover. Whole-market comparisons across this boundary are withheld.
  {
    stablecoinId: null as string | null,
    changedAt: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
    chainIds: [] as readonly string[],
    evidenceUrl: "https://pharos.watch/methodology/stability-index-changelog/",
    marketWide: true,
  },
] as const;

/** A reviewed perimeter record enables the Kinesis wrapper publication and snapshot together. */
export function isKinesisWrapperSupplyCutoverActive(stablecoinId: string, nowSec: number): boolean {
  return isKinesisWrapperSupplyId(stablecoinId) &&
    SUPPLY_PERIMETER_CHANGES.some((change) => change.stablecoinId === stablecoinId && change.changedAt <= nowSec &&
      change.chainIds.join(",") === "ethereum");
}

/** Intraday observations retain their strict observation timestamp. */
export function isEarlierSupplyPerimeter(stablecoinId: string, observedAt: number): boolean {
  return SUPPLY_PERIMETER_CHANGES.some((change) => change.stablecoinId === stablecoinId && observedAt < change.changedAt);
}

/** The change day's midnight label cannot identify which quantity a daily row counted. */
export function isAmbiguousSupplyPerimeterDay(stablecoinId: string, observedAt: number): boolean {
  return SUPPLY_PERIMETER_CHANGES.some((change) => change.stablecoinId === stablecoinId
    && observedAt === Math.floor(change.changedAt / 86_400) * 86_400);
}

/** Whole-market totals across a market-wide boundary cannot be compared without restating their members. */
export function getLatestSupplyPerimeterChange(start: number, end: number): number | null {
  const changes = SUPPLY_PERIMETER_CHANGES.filter((change) => change.marketWide && change.changedAt > start && change.changedAt <= end);
  return changes.length ? Math.max(...changes.map((change) => change.changedAt)) : null;
}
