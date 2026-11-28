import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
} from "../types/aggregate-universe-constants";

export function isKinesisWrapperSupplyId(id: string): boolean {
  return id === "kau-kinesis" || id === "kag-kinesis";
}

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
 * Fences compare observation clocks, so when the first published packet carries an earlier
 * supply observation (JLTXX: finalized-block read), changedAt sits at that observation instead.
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
  // === #2306: wM (wm-m0) 17-chain reviewed native on-chain supply plan (Pricing v6.96) ===
  // Switched wM from withheld CoinGecko fallback to reviewed 17-chain clocked native on-chain
  // supply (preferMcap: true; Option A2) after proving M0 Portal V2 / Portal Lite / Solana
  // Portal zero-escrow burn-and-mint semantics and Ethereum HubPortal L1 Nexus bound.
  // Aligned to Pricing v6.96 activation (2026-11-25T13:30:00Z, Unix 1795613400).
  {
    stablecoinId: "wm-m0",
    changedAt: Date.parse("2026-11-25T13:30:00Z") / 1000,
    chainIds: [
      "ethereum", "solana", "arbitrum", "base", "plume", "linea", "bsc", "hyperevm", "soneium",
      "plasma", "citrea", "monad", "optimism", "rise", "0g", "sei", "fluent",
    ],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2306",
    marketWide: false,
  },
  // === Listing Policy v2 PR-1B Wave-0 tokenized-fund re-admissions (Pricing v6.99) ===
  // Re-admit WTGXX (8-chain native), TBILL (5-chain native excl. XRPL hotwallet),
  // JLTXX (2-chain finalized Ethereum + Solana Token-2022 pinned shares), and CETES
  // (6-chain native incl. Stellar Horizon SAC) on preferred native supply plans.
  // The 10:45:15 UTC sync (first on the PR-1B Worker) first published WTGXX, TBILL and CETES;
  // JLTXX first published on the 11:00:31 UTC sync, but that packet's finalized-block supply
  // observation is 10:43:35 UTC; the fence compares observation clocks, so it sits there.
  {
    stablecoinId: "wtgxx-wisdomtree",
    changedAt: Date.parse("2026-11-27T10:45:15Z") / 1000,
    chainIds: ["arbitrum", "avalanche", "base", "ethereum", "optimism", "plume", "stellar", "solana"],
    evidenceUrl: "https://stellar.wisdomtree.com/.well-known/stellar.toml",
    marketWide: false,
  },
  {
    stablecoinId: "tbill-openeden",
    changedAt: Date.parse("2026-11-27T10:45:15Z") / 1000,
    chainIds: ["ethereum", "arbitrum", "solana", "xrpl", "bsc"],
    evidenceUrl: "https://docs.openeden.com/tbill/smart-contract-addresses",
    marketWide: false,
  },
  {
    stablecoinId: "jltxx-jpmorgan",
    changedAt: Date.parse("2026-11-27T10:43:35Z") / 1000,
    chainIds: ["ethereum", "solana"],
    evidenceUrl: "https://www.sec.gov/Archives/edgar/data/1659326/000119312526410014/d172947d497.htm",
    marketWide: false,
  },
  {
    stablecoinId: "cetes-etherfuse",
    changedAt: Date.parse("2026-11-27T10:45:15Z") / 1000,
    chainIds: ["solana", "base", "polygon", "monad", "stellar", "avalanche"],
    evidenceUrl: "https://api.etherfuse.com/statement/attestation/9fa9cef5-3077-435d-9bcf-9f3990256ab3.pdf",
    marketWide: false,
  },
  // === Listing Policy v2 PR-3 mGLO six-chain native supply plan (Pricing v7.0) ===
  // Admit Midas Fasanara Global Open (mGLO) on reviewed 6-chain additive native supply
  // (Base, Robinhood Chain, Ethereum, X Layer, Optimism, Monad; preferMcap: true).
  // The first PR-3 sync at 16:00:29 UTC withheld mGLO; the 16:15:39 UTC sync first published it.
  {
    stablecoinId: "mglo-midas-fasanara",
    changedAt: Date.parse("2026-11-27T16:15:39Z") / 1000,
    chainIds: ["base", "robinhood", "ethereum", "xlayer", "optimism", "monad"],
    evidenceUrl: "https://raw.githubusercontent.com/midas-apps/midas-por-v2/main/tokens.json",
    marketWide: false,
  },
  // === #2169 Wave 2 non-USD native checkpoints + #2393 CADC legacy/successor registers (Pricing v7.1) ===
  // Undated DefiLlama caps move to clocked complete native rosters: CADD adds Solana, Tempo and Arc
  // (owner ruling D8), CADC counts its legacy and successor registers (D10), and KRWQ, XOFm, ZARm and
  // tGBP reconcile to DefiLlama's native totals. Provisional at the planned 11:00 UTC deploy hour:
  // re-date each entry to the supply observation clock of the first published packet with the new
  // quantity (see the note above).
  {
    stablecoinId: "cadd-cad-digital",
    changedAt: Date.parse("2026-11-28T11:00:00Z") / 1000,
    chainIds: ["ethereum", "base", "solana", "tempo", "arc"],
    evidenceUrl: "https://tetradg.com/supported-blockchains/",
    marketWide: false,
  },
  {
    stablecoinId: "krwq-iq",
    changedAt: Date.parse("2026-11-28T11:00:00Z") / 1000,
    chainIds: ["ethereum", "base", "polygon", "fraxtal", "codex", "morph-l2"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "xofm-mento",
    changedAt: Date.parse("2026-11-28T11:00:00Z") / 1000,
    chainIds: ["celo"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "zarm-mento",
    changedAt: Date.parse("2026-11-28T11:00:00Z") / 1000,
    chainIds: ["celo"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "tgbp-tokenised",
    changedAt: Date.parse("2026-11-28T11:00:00Z") / 1000,
    chainIds: ["ethereum", "base", "bsc", "polygon", "avalanche", "solana", "arbitrum", "gnosis", "arc"],
    evidenceUrl: "https://github.com/TokenBrice/pharos-watch/issues/2169",
    marketWide: false,
  },
  {
    stablecoinId: "cadc-cad-coin",
    changedAt: Date.parse("2026-11-28T11:00:00Z") / 1000,
    chainIds: ["ethereum", "polygon", "arbitrum", "base", "linea", "solana"],
    evidenceUrl: "https://loon.finance/cadc",
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
