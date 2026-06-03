#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "../../shared/lib/live-reserve-adapters-definitions";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../../shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "../../shared/lib/supply";
import type { LiveReserveEvidenceClass } from "../../shared/types/live-reserves";
import type { ReserveSlice, StablecoinMeta } from "../../shared/types";

const PROD_ORIGIN = "https://pharos.watch";
const PROD_REPORT_CARDS_URL = `${PROD_ORIGIN}/_site-data/report-cards`;
const PROD_STABLECOINS_URL = `${PROD_ORIGIN}/_site-data/stablecoins`;
const SCORE_GRADE_GAP_LIMIT = 50;
const CURATED_ONLY_CANDIDATE_LIMIT = 50;

export type LiveReserveSourceQuality =
  | "independent"
  | "static-validated"
  | "weak-proof"
  | "not-plausible"
  | "unreviewed";

export interface LiveReserveSourceQualityNote {
  sourceUrl: string | null;
  sourceQuality: LiveReserveSourceQuality;
  expectedAdapterFamily: string;
  freshnessEvidence: string;
  scoreGradePlausible: boolean;
  note: string;
}

export interface CuratedOnlyReserveCandidateRow extends LiveReserveSourceQualityNote {
  coinId: string;
  symbol: string;
  name: string;
  marketCapUsd: number | null;
  rank: number;
}

export const REVIEWED_LIVE_RESERVE_SOURCE_NOTES: Record<string, LiveReserveSourceQualityNote> = {
  "aa-falconx-mev-capital": {
    sourceUrl: "https://docs.pareto.credit/product/credit-vaults/live-vaults",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Pareto/RWA.xyz vault adapter if a public current NAV/composition endpoint is found",
    freshnessEvidence: "Static credit-vault description and RWA.xyz/Pareto links exist; no parsed current reserve timestamp is configured.",
    scoreGradePlausible: false,
    note: "Single credit-line exposure is useful for display only until a public machine-readable NAV/composition source with freshness is verified.",
  },
  "bfusd-binance": {
    sourceUrl: "https://www.binance.com/en/support/faq/detail/d62d25f330b94f5ba613c53e3c1ee8d0",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Binance publishes current composition/freshness data",
    freshnessEvidence: "Binance FAQ/product disclosures are self-reported and ad hoc.",
    scoreGradePlausible: false,
    note: "BFUSD is an internal Binance account product backed by an opaque collateral pool and hedging portfolio; no public source can validate a live reserve mix.",
  },
  "busd0-usual": {
    sourceUrl: "https://docs.usual.money/resources-and-ecosystem/fact-sheets/usual-products/busd0",
    sourceQuality: "independent",
    expectedAdapterFamily: "evm-branch-balances wrapper read with totalSupply reconciliation",
    freshnessEvidence: "Ethereum bUSD0 totalSupply and USD0 balanceOf(bUSD0) are read in the same on-chain run.",
    scoreGradePlausible: true,
    note: "bUSD0 is a locked-USD0 wrapper; the live config verifies the Ethereum wrapper holds matching USD0 against bUSD0 supply.",
  },
  "eursafo-spiko": {
    sourceUrl: "https://www.spiko.io/spiko-euro",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if the page exposes dated PwC/fund documents consistently",
    freshnessEvidence: "Metadata records quarterly PwC/UCITS evidence, but no worker parser currently verifies a current EURSAFO document date.",
    scoreGradePlausible: false,
    note: "The fund source can plausibly validate the static one-bucket exposure, but it is not an independent live composition feed under current scoring policy.",
  },
  "moveusd-cfx": {
    sourceUrl: "https://docs.moveusd.com/docs/disclosures-disclaimers",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "single-asset or disclosure parser only after a current reserve/timestamp field is exposed",
    freshnessEvidence: "Public materials disclose 1:1 bank-deposit backing, but metadata notes no monthly attestation was found.",
    scoreGradePlausible: false,
    note: "A token supply/liveness probe would not independently verify bank deposits; score-grade use needs current reserve disclosure or attestation.",
  },
  "pc0000031-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals/861cce9e-08ae-45a0-aca8-9fa229a0189d",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links a deal page and docs, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated private-credit note contract-priced at par; live reserve scoring would overstate source transparency.",
  },
  "pc0000033-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals/e2c78ce9-1c20-4f4a-b6ca-eba1b2f575b1",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links a deal page and docs, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated private-credit note contract-priced at par; live reserve scoring would overstate source transparency.",
  },
  "safo-spiko-usd": {
    sourceUrl: "https://www.spiko.io/spiko-dollar",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if the page exposes dated PwC/fund documents consistently",
    freshnessEvidence: "Metadata records quarterly PwC/UCITS evidence, but no worker parser currently verifies a current SAFO document date.",
    scoreGradePlausible: false,
    note: "The fund source can plausibly validate the static one-bucket exposure, but it is not an independent live composition feed under current scoring policy.",
  },
  "usda-avalon": {
    sourceUrl: "https://docs.avalonfinance.xyz",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Avalon collateral API/parser if current collateral balances and timestamps are published",
    freshnessEvidence: "DefiLlama supply and issuer docs exist, but current public metadata does not include a parsed live collateral mix timestamp.",
    scoreGradePlausible: false,
    note: "The curated BTC/USDT/LST reserve mix cannot become score-grade without a current independent composition source.",
  },
  "usdf-astherus": {
    sourceUrl: "https://www.asterdex.com/en/usdf",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Astherus/Aster collateral API parser if a current composition endpoint is published",
    freshnessEvidence: "Current metadata describes Ceffu/MirrorX and delta-neutral backing, but no public current composition/timestamp endpoint is configured.",
    scoreGradePlausible: false,
    note: "The USDT plus delta-neutral strategy mix remains curated until the issuer exposes current, parseable reserve data.",
  },
  "acrdx-anemoy-apollo": {
    sourceUrl: "https://chroniclelabs.org/blog/chronicle-s-proof-of-asset-unlocks-apollo-s-acrdx-curated-by-steakhouse",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Chronicle proof-of-asset/Centrifuge adapter",
    freshnessEvidence: "Chronicle describes continuously refreshed Proof of Asset inputs, but no configured adapter currently verifies a public feed timestamp or composition split.",
    scoreGradePlausible: true,
    note: "The source is plausibly score-grade with a custom Chronicle adapter; it is not safe as a config-only addition today.",
  },
  "dusd-standx": {
    sourceUrl: "https://docs.standx.com/",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new StandX transparency/API adapter if a public reserve-ratio and composition endpoint is found",
    freshnessEvidence: "Public docs describe the delta-neutral backing model and reserve fund, but metadata has no proof-of-reserves or current composition timestamp.",
    scoreGradePlausible: false,
    note: "The backing is a CEX/custody-managed trading strategy; a display-only static mix should not be promoted without independent current position data.",
  },
  "eurspkcc-spiko": {
    sourceUrl: "https://www.spiko.io/spiko-cash-and-carry",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if the page exposes dated PwC/fund documents consistently",
    freshnessEvidence: "Metadata records quarterly PwC/AMF fund evidence, but no worker parser currently verifies a current cash-and-carry document date.",
    scoreGradePlausible: false,
    note: "The source can support a reviewed static split, but the strategy bucket is not independently measured by a live composition feed under current scoring policy.",
  },
  "hbd-hive": {
    sourceUrl: "https://developers.hive.io/",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Hive chain-state adapter if protocol debt, HIVE market value, and conversion state are modeled together",
    freshnessEvidence: "Hive chain state can expose protocol-derived debt and conversion data, but the current metadata has no configured parser for HBD backing capacity or freshness.",
    scoreGradePlausible: true,
    note: "HBD is protocol-backed rather than reserve-asset backed; score-grade use is plausible only through a dedicated solvency/collateralization adapter.",
  },
  "mglobal-midas-fasanara": {
    sourceUrl: "https://midas.app/transparency",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Midas transparency parser only if independently verified current NAV/composition fields are public and stable",
    freshnessEvidence: "Metadata records daily self-reported NAV/proof materials, but no configured parser verifies a current composition timestamp.",
    scoreGradePlausible: false,
    note: "The Fasanara private-credit exposure remains curated until the transparency page exposes parseable independent evidence suitable for scoring.",
  },
  "msusd-metronome": {
    sourceUrl: "https://docs.metronome.io/metronome-synth/metronome-synth-protocol",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Metronome on-chain collateral adapter if vault positions and stablecoin exposures can be separated reliably",
    freshnessEvidence: "Protocol docs describe accepted collateral, but no configured source verifies the current multi-collateral mix or timestamp.",
    scoreGradePlausible: false,
    note: "The reserve mix includes direct stables plus yield and crypto positions; score-grade use needs current on-chain position attribution.",
  },
  "pc0000089-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links Tradable docs and deal context, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated private-credit note contract-priced at par; live reserve scoring would overstate source transparency.",
  },
  "pc0000101-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links Tradable docs and deal context, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated legal-finance receivable exposure; live reserve scoring would overstate source transparency.",
  },
  "pmusd-precious-metals": {
    sourceUrl: "https://data.chain.link/feeds/ethereum/mainnet/ion-por",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "Chainlink proof-of-reserve feed plus liability reconciliation only if pmUSD supply and TokenBlender backing can be tied together",
    freshnessEvidence: "Metadata records a Chainlink/Instruxi proof source, but public feed state did not verify a current pmUSD-specific reserve/liability timestamp in this pass.",
    scoreGradePlausible: false,
    note: "The Chainlink source validates the referenced gold-claim backing, but score-grade use needs an end-to-end reserve/liability reconciliation.",
  },
  "sofid-sofi": {
    sourceUrl: "https://www.sofi.com/crypto/sofiusd/",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "none until SoFi publishes current attestations or an issuer reserve endpoint",
    freshnessEvidence: "Public product materials describe cash/cash-equivalent backing, but metadata has no proof-of-reserves or current attestation URL.",
    scoreGradePlausible: false,
    note: "Bank-account backing cannot be independently scored from product copy alone.",
  },
  "stac-securitize": {
    sourceUrl: "https://chroniclelabs.org/blog/chronicle-provides-proof-of-asset-verification-for-securitize-s-tokenized-aaa-clo-fund-bringing",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Chronicle proof-of-asset/NAV adapter",
    freshnessEvidence: "Chronicle describes continuous holdings, NAV, and pricing verification, but no configured adapter currently verifies a public feed timestamp or composition split.",
    scoreGradePlausible: true,
    note: "The source is plausibly score-grade with a custom Chronicle adapter; it is not safe as a config-only addition today.",
  },
  "susd-synthetix": {
    sourceUrl: "https://docs.synthetix.io/",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Synthetix on-chain collateral adapter if V2/V3 collateral pools and debt accounting can be reconciled",
    freshnessEvidence: "Protocol docs exist, but no configured source verifies current SNX, USDC, ETH/LST, and treasury-backed collateral weights.",
    scoreGradePlausible: true,
    note: "The backing spans legacy and V3 collateral systems; score-grade use is plausible only with current on-chain debt/collateral attribution.",
  },
  "usdkg-gold-dollar": {
    sourceUrl: "https://www.usdkg.com/transparency",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if current Kreston reserve reports are consistently published with parseable dates",
    freshnessEvidence: "Metadata records quarterly Kreston proof-of-reserve evidence, but no worker parser currently verifies a current report date.",
    scoreGradePlausible: false,
    note: "The audited gold backing supports static validation, but it is not a live independent composition feed under current scoring policy.",
  },
  "usdsui-sui": {
    sourceUrl: "https://apidocs.bridge.xyz/platform/issuance/reserve-management",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "Bridge attestation/API parser only if current reserve attestations become publicly parseable",
    freshnessEvidence: "Bridge docs describe reserve management and quarterly third-party audits, but metadata has no current public attestation parser.",
    scoreGradePlausible: false,
    note: "The Bridge-issued reserve model is credible for static display, but score-grade use needs a current public reserve report or API source.",
  },
  "usp-pikudao": {
    sourceUrl: "https://docs.piku.co/piku",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Piku strategy parser only if current strategy allocations and stablecoin buffers become public and timestamped",
    freshnessEvidence: "Docs describe the reserve strategy, but no configured source verifies the current BMMF, DeFi, or cash-stablecoin mix.",
    scoreGradePlausible: false,
    note: "The backing is dominated by opaque strategy buckets; only the small stablecoin buffers are directly linkable today.",
  },
  "xdai-gnosis": {
    sourceUrl: "https://docs.gnosischain.com/about/tokens/",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Gnosis native bridge adapter with USDS bridge balances and native xDAI debt reconciliation",
    freshnessEvidence: "Gnosis docs describe the native xDAI bridge model, but no configured adapter currently reconciles native supply to Ethereum-side USDS backing.",
    scoreGradePlausible: true,
    note: "xDAI is a plausible future score-grade wrapper candidate, but it needs a custom bridge/supply adapter before Safety Score can use live reserves.",
  },
  "xtusd-xt": {
    sourceUrl: "https://www.xt.com/",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until XT.com publishes independent current reserve composition data",
    freshnessEvidence: "Public issuer materials are insufficient to verify the current managed reserve pool.",
    scoreGradePlausible: false,
    note: "An exchange-managed opaque reserve pool should remain curated-only until independently measured reserve data is available.",
  },
};

const DEFAULT_SOURCE_QUALITY_NOTE: LiveReserveSourceQualityNote = {
  sourceUrl: null,
  sourceQuality: "unreviewed",
  expectedAdapterFamily: "unreviewed",
  freshnessEvidence: "Not reviewed in this source-quality pass.",
  scoreGradePlausible: false,
  note: "No source-quality note has been recorded yet.",
};

interface UnknownRecord {
  [key: string]: unknown;
}

export interface ReserveCoverageAuditInput {
  trackedCoins?: readonly StablecoinMeta[];
  activeCoins?: readonly StablecoinMeta[];
  preLaunchCoins?: readonly StablecoinMeta[];
  frozenCoins?: readonly StablecoinMeta[];
  reportCards?: unknown;
  stablecoins?: unknown;
  generatedAt?: string;
  mode?: "static" | "input" | "api" | "prod";
}

export interface ReserveCoverageAudit {
  generatedAt: string;
  mode: "static" | "input" | "api" | "prod";
  summary: {
    trackedCount: number;
    activeCount: number;
    preLaunchCount: number;
    frozenCount: number;
    activeWithCuratedReserves: number;
    activeReserveSliceCount: number;
    activeLinkedReserveSliceCount: number;
    activeUnlinkedReserveSliceCount: number;
    activeUnlinkedReserveSlicePctGte10Count: number;
    activeUnlinkedReserveSlicePctGte50Count: number;
    activeWithLinkedReserveSliceCount: number;
    liveEnabledActiveCount: number;
    curatedOnlyActiveCount: number;
    curatedOnlyCandidateRankSource: "stablecoin-api-market-cap" | "local-canonical-order";
    reportCardActiveCount: number | null;
    collateralFromLiveActiveCount: number | null;
    dependencyFromLiveActiveCount: number | null;
    independentConfiguredButNotScoreGradeCount: number | null;
  };
  liveEnabledByEvidenceClass: Record<LiveReserveEvidenceClass, number>;
  independentConfiguredButNotScoreGradeIds: string[] | null;
  curatedOnlyActiveCandidates: CuratedOnlyReserveCandidateRow[];
  warnings: string[];
}

interface CliOptions {
  prod: boolean;
  apiBase: string | null;
  reportCardsPath: string | null;
  stablecoinsPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  generatedAt: string | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractReportCardRows(payload: unknown): UnknownRecord[] | null {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  if (!isRecord(envelope) || !Array.isArray(envelope.cards)) return null;
  return envelope.cards.filter(isRecord);
}

function reserveSlicesFor(coin: StablecoinMeta): readonly ReserveSlice[] {
  return coin.reserves ?? [];
}

function extractStablecoinRows(payload: unknown): UnknownRecord[] {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  const rows = Array.isArray(envelope)
    ? envelope
    : isRecord(envelope) && Array.isArray(envelope.peggedAssets)
      ? envelope.peggedAssets
      : [];
  return rows.filter(isRecord);
}

function marketCapForStablecoinRow(row: UnknownRecord): number {
  const direct = numberValue(row.marketCapUsd ?? row.marketCap ?? row.mcapUsd);
  if (direct != null) return direct;
  return getCirculatingRaw(row as { circulating?: Record<string, number> | null | undefined });
}

function buildMarketCapMap(stablecoinsPayload: unknown | undefined): Map<string, number> | null {
  if (stablecoinsPayload === undefined) return null;

  const map = new Map<string, number>();
  for (const row of extractStablecoinRows(stablecoinsPayload)) {
    const id = stringValue(row.id);
    if (!id) continue;
    map.set(id, marketCapForStablecoinRow(row));
  }
  return map;
}

function sortByMarketCapOrRank<T extends { marketCapUsd: number | null; rank: number; coinId: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => {
    if (left.marketCapUsd != null || right.marketCapUsd != null) {
      return (right.marketCapUsd ?? -1) - (left.marketCapUsd ?? -1) || left.coinId.localeCompare(right.coinId);
    }
    return left.rank - right.rank || left.coinId.localeCompare(right.coinId);
  });
}

function buildCuratedOnlyCandidates(
  activeCoins: readonly StablecoinMeta[],
  marketCapById: ReadonlyMap<string, number> | null,
): CuratedOnlyReserveCandidateRow[] {
  const rows = activeCoins.flatMap((coin, index): CuratedOnlyReserveCandidateRow[] => {
    if (coin.liveReservesConfig?.adapter || reserveSlicesFor(coin).length === 0) return [];
    const note = REVIEWED_LIVE_RESERVE_SOURCE_NOTES[coin.id] ?? DEFAULT_SOURCE_QUALITY_NOTE;
    return [{
      coinId: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      marketCapUsd: marketCapById?.get(coin.id) ?? null,
      rank: index + 1,
      ...note,
    }];
  });

  return sortByMarketCapOrRank(rows);
}

function evidenceClassForCoin(coin: StablecoinMeta): LiveReserveEvidenceClass | null {
  const adapter = coin.liveReservesConfig?.adapter;
  if (!adapter) return null;
  return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapter]?.evidenceClass ?? null;
}

function emptyEvidenceClassCounts(): Record<LiveReserveEvidenceClass, number> {
  return {
    independent: 0,
    "static-validated": 0,
    "weak-live-probe": 0,
  };
}

function summarizeReportCards(
  payload: unknown,
  activeIds: ReadonlySet<string>,
): Pick<
  ReserveCoverageAudit["summary"],
  | "reportCardActiveCount"
  | "collateralFromLiveActiveCount"
  | "dependencyFromLiveActiveCount"
> & { collateralFromLiveIds: Set<string> } {
  const rows = extractReportCardRows(payload);
  if (!rows) {
    throw new Error("Report-card input does not contain cards[].");
  }

  const activeRows = rows.filter((row) => {
    const id = stringValue(row.id);
    return id != null && activeIds.has(id);
  });
  const collateralFromLiveIds = new Set<string>();
  let dependencyFromLiveActiveCount = 0;

  for (const row of activeRows) {
    const id = stringValue(row.id);
    const rawInputs = isRecord(row.rawInputs) ? row.rawInputs : {};
    if (id && boolValue(rawInputs.collateralFromLive)) {
      collateralFromLiveIds.add(id);
    }
    if (boolValue(rawInputs.dependencyFromLive)) {
      dependencyFromLiveActiveCount += 1;
    }
  }

  return {
    reportCardActiveCount: activeRows.length,
    collateralFromLiveActiveCount: collateralFromLiveIds.size,
    dependencyFromLiveActiveCount,
    collateralFromLiveIds,
  };
}

export function buildReserveCoverageAudit(input: ReserveCoverageAuditInput = {}): ReserveCoverageAudit {
  const trackedCoins = input.trackedCoins ?? TRACKED_STABLECOINS;
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const preLaunchCoins = input.preLaunchCoins ?? PRE_LAUNCH_STABLECOINS;
  const frozenCoins = input.frozenCoins ?? FROZEN_STABLECOINS;
  const activeIds = new Set(activeCoins.map((coin) => coin.id));
  const warnings: string[] = [];
  const liveEnabledByEvidenceClass = emptyEvidenceClassCounts();
  const marketCapById = buildMarketCapMap(input.stablecoins);
  if (input.stablecoins !== undefined && marketCapById?.size === 0) {
    warnings.push("Stablecoin payload did not contain any pegged asset rows.");
  }

  let activeReserveSliceCount = 0;
  let activeLinkedReserveSliceCount = 0;
  let activeUnlinkedReserveSliceCount = 0;
  let activeUnlinkedReserveSlicePctGte10Count = 0;
  let activeUnlinkedReserveSlicePctGte50Count = 0;
  let activeWithLinkedReserveSliceCount = 0;
  let liveEnabledActiveCount = 0;
  const independentConfiguredIds: string[] = [];

  for (const coin of activeCoins) {
    const reserves = reserveSlicesFor(coin);
    activeReserveSliceCount += reserves.length;
    if (reserves.some((reserve) => reserve.coinId)) {
      activeWithLinkedReserveSliceCount += 1;
    }

    for (const reserve of reserves) {
      if (reserve.coinId) {
        activeLinkedReserveSliceCount += 1;
      } else {
        activeUnlinkedReserveSliceCount += 1;
        if (reserve.pct >= 10) activeUnlinkedReserveSlicePctGte10Count += 1;
        if (reserve.pct >= 50) activeUnlinkedReserveSlicePctGte50Count += 1;
      }
    }

    const evidenceClass = evidenceClassForCoin(coin);
    if (evidenceClass) {
      liveEnabledActiveCount += 1;
      liveEnabledByEvidenceClass[evidenceClass] += 1;
      if (evidenceClass === "independent") independentConfiguredIds.push(coin.id);
    } else if (coin.liveReservesConfig?.adapter) {
      warnings.push(`Unknown live reserve adapter for ${coin.id}: ${coin.liveReservesConfig.adapter}`);
    }
  }

  const curatedOnlyActiveCandidates = buildCuratedOnlyCandidates(activeCoins, marketCapById);
  let reportCardActiveCount: number | null = null;
  let collateralFromLiveActiveCount: number | null = null;
  let dependencyFromLiveActiveCount: number | null = null;
  let independentConfiguredButNotScoreGradeIds: string[] | null = null;
  if (input.reportCards !== undefined) {
    const reportCardSummary = summarizeReportCards(input.reportCards, activeIds);
    reportCardActiveCount = reportCardSummary.reportCardActiveCount;
    collateralFromLiveActiveCount = reportCardSummary.collateralFromLiveActiveCount;
    dependencyFromLiveActiveCount = reportCardSummary.dependencyFromLiveActiveCount;
    independentConfiguredButNotScoreGradeIds = independentConfiguredIds
      .filter((id) => !reportCardSummary.collateralFromLiveIds.has(id))
      .sort();
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode ?? (input.reportCards === undefined ? "static" : "input"),
    summary: {
      trackedCount: trackedCoins.length,
      activeCount: activeCoins.length,
      preLaunchCount: preLaunchCoins.length,
      frozenCount: frozenCoins.length,
      activeWithCuratedReserves: activeCoins.filter((coin) => reserveSlicesFor(coin).length > 0).length,
      activeReserveSliceCount,
      activeLinkedReserveSliceCount,
      activeUnlinkedReserveSliceCount,
      activeUnlinkedReserveSlicePctGte10Count,
      activeUnlinkedReserveSlicePctGte50Count,
      activeWithLinkedReserveSliceCount,
      liveEnabledActiveCount,
      curatedOnlyActiveCount: curatedOnlyActiveCandidates.length,
      curatedOnlyCandidateRankSource: marketCapById ? "stablecoin-api-market-cap" : "local-canonical-order",
      reportCardActiveCount,
      collateralFromLiveActiveCount,
      dependencyFromLiveActiveCount,
      independentConfiguredButNotScoreGradeCount: independentConfiguredButNotScoreGradeIds?.length ?? null,
    },
    liveEnabledByEvidenceClass,
    independentConfiguredButNotScoreGradeIds,
    curatedOnlyActiveCandidates,
    warnings,
  };
}

function renderNullableCount(value: number | null): string {
  return value == null ? "not supplied" : String(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value: number | null): string {
  if (value == null) return "";
  if (value >= 1_000_000_000) return `$${formatNumber(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `$${formatNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${formatNumber(value / 1_000)}K`;
  return `$${formatNumber(value)}`;
}

function markdownValue(value: unknown): string {
  if (value == null || value === "") return "";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderCuratedOnlyCandidates(rows: readonly CuratedOnlyReserveCandidateRow[]): string[] {
  const clipped = rows.slice(0, CURATED_ONLY_CANDIDATE_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | rank | quality | score-grade plausible | source / adapter note",
    "--- | ---: | ---: | --- | --- | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.rank,
      row.sourceQuality,
      row.scoreGradePlausible ? "yes" : "no",
      `${row.sourceUrl ?? "unreviewed"}; ${row.expectedAdapterFamily}; ${row.freshnessEvidence}`,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

export function renderReserveCoverageAuditMarkdown(audit: ReserveCoverageAudit): string {
  const clippedGaps = (audit.independentConfiguredButNotScoreGradeIds ?? []).slice(0, SCORE_GRADE_GAP_LIMIT);
  const lines = [
    "# Reserve Coverage Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Mode: ${audit.mode}`,
    "",
    "## Summary",
    "",
    `- Tracked stablecoins: ${audit.summary.trackedCount}`,
    `- Active stablecoins: ${audit.summary.activeCount}`,
    `- Pre-launch stablecoins: ${audit.summary.preLaunchCount}`,
    `- Frozen stablecoins: ${audit.summary.frozenCount}`,
    `- Active coins with curated reserves: ${audit.summary.activeWithCuratedReserves}`,
    `- Active reserve slices: ${audit.summary.activeReserveSliceCount}`,
    `- Active linked reserve slices: ${audit.summary.activeLinkedReserveSliceCount}`,
    `- Active unlinked reserve slices: ${audit.summary.activeUnlinkedReserveSliceCount}`,
    `- Active unlinked reserve slices >=10%: ${audit.summary.activeUnlinkedReserveSlicePctGte10Count}`,
    `- Active unlinked reserve slices >=50%: ${audit.summary.activeUnlinkedReserveSlicePctGte50Count}`,
    `- Active coins with at least one linked reserve slice: ${audit.summary.activeWithLinkedReserveSliceCount}`,
    `- Live-enabled active coins: ${audit.summary.liveEnabledActiveCount}`,
    `- Curated-only active reserve candidates: ${audit.summary.curatedOnlyActiveCount}`,
    `- Curated-only candidate rank source: ${audit.summary.curatedOnlyCandidateRankSource}`,
    `- Live-enabled independent: ${audit.liveEnabledByEvidenceClass.independent}`,
    `- Live-enabled static-validated: ${audit.liveEnabledByEvidenceClass["static-validated"]}`,
    `- Live-enabled weak-live-probe: ${audit.liveEnabledByEvidenceClass["weak-live-probe"]}`,
    `- Report-card active cards: ${renderNullableCount(audit.summary.reportCardActiveCount)}`,
    `- Active collateralFromLive cards: ${renderNullableCount(audit.summary.collateralFromLiveActiveCount)}`,
    `- Active dependencyFromLive cards: ${renderNullableCount(audit.summary.dependencyFromLiveActiveCount)}`,
    `- Independent configured but not score-grade: ${
      renderNullableCount(audit.summary.independentConfiguredButNotScoreGradeCount)
    }`,
    "",
    "## Independent Configured But Not Score-Grade",
    "",
    audit.independentConfiguredButNotScoreGradeIds == null
      ? "_Report-card snapshot not supplied._"
      : clippedGaps.length === 0
        ? "_None._"
        : clippedGaps.map((id) => `- ${id}`).join("\n"),
    ...(audit.independentConfiguredButNotScoreGradeIds != null
        && audit.independentConfiguredButNotScoreGradeIds.length > clippedGaps.length
      ? [`_Plus ${audit.independentConfiguredButNotScoreGradeIds.length - clippedGaps.length} more IDs._`]
      : []),
    "",
    "## Highest-Market-Cap Curated-Only Active Candidates",
    "",
    ...renderCuratedOnlyCandidates(audit.curatedOnlyActiveCandidates),
    "",
    "## Warnings",
    "",
    ...(audit.warnings.length > 0 ? audit.warnings.map((warning) => `- ${warning}`) : ["_None._"]),
    "",
  ];

  return `${lines.flat().join("\n").trimEnd()}\n`;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    prod: false,
    apiBase: null,
    reportCardsPath: null,
    stablecoinsPath: null,
    format: "markdown",
    reportPath: null,
    generatedAt: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prod") {
      options.prod = true;
      continue;
    }
    if (arg === "--api-base") {
      const value = argv[i + 1];
      if (!value) throw new Error("--api-base requires a URL");
      options.apiBase = value;
      i += 1;
      continue;
    }
    if (arg === "--report-cards") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report-cards requires a file path");
      options.reportCardsPath = value;
      i += 1;
      continue;
    }
    if (arg === "--stablecoins") {
      const value = argv[i + 1];
      if (!value) throw new Error("--stablecoins requires a file path");
      options.stablecoinsPath = value;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--markdown") {
      options.format = "markdown";
      continue;
    }
    if (arg === "--report") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = value;
      i += 1;
      continue;
    }
    if (arg === "--generated-at") {
      const value = argv[i + 1];
      if (!value) throw new Error("--generated-at requires an ISO timestamp or 'now'");
      options.generatedAt = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.prod && options.apiBase) {
    throw new Error("Choose only one of --prod or --api-base.");
  }
  if ((options.prod || options.apiBase) && (options.reportCardsPath || options.stablecoinsPath)) {
    throw new Error("Choose fetched reserve coverage inputs or local input files, not both.");
  }

  return options;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  apiKey: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const response = await fetchImpl(url, { headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${body.slice(0, 160)}`);
  }
  return JSON.parse(body) as unknown;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function readRequiredJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`${label} file not found: ${path}`);
  }
  return readJsonFile(path);
}

async function loadReportCardInput(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<ReserveCoverageAuditInput, "reportCards" | "stablecoins" | "mode">> {
  if (options.prod) {
    const siteDataHeaders = {
      Origin: PROD_ORIGIN,
      Referer: `${PROD_ORIGIN}/coverage/`,
    };
    const [reportCards, stablecoins] = await Promise.all([
      fetchJson(PROD_REPORT_CARDS_URL, fetchImpl, undefined, siteDataHeaders),
      fetchJson(PROD_STABLECOINS_URL, fetchImpl, undefined, siteDataHeaders),
    ]);
    return { reportCards, stablecoins, mode: "prod" };
  }

  if (options.apiBase) {
    const apiKey = process.env.RESERVE_COVERAGE_API_KEY ?? process.env.PHAROS_API_KEY ?? process.env.SMOKE_API_KEY;
    const [reportCards, stablecoins] = await Promise.all([
      fetchJson(joinUrl(options.apiBase, "/api/report-cards"), fetchImpl, apiKey),
      fetchJson(joinUrl(options.apiBase, "/api/stablecoins"), fetchImpl, apiKey),
    ]);
    return { reportCards, stablecoins, mode: "api" };
  }

  const reportCards = options.reportCardsPath
    ? readRequiredJsonFile(resolve(cwd, options.reportCardsPath), "--report-cards")
    : undefined;
  const stablecoins = options.stablecoinsPath
    ? readRequiredJsonFile(resolve(cwd, options.stablecoinsPath), "--stablecoins")
    : undefined;

  return {
    reportCards,
    stablecoins,
    mode: reportCards !== undefined || stablecoins !== undefined ? "input" : "static",
  };
}

function resolveGeneratedAt(options: CliOptions): string {
  if (options.generatedAt === "now") return new Date().toISOString();
  return options.generatedAt ?? new Date().toISOString();
}

function writeOutput(path: string, output: string, cwd: string): void {
  const target = resolve(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output, "utf8");
  process.stdout.write(`Wrote reserve coverage audit to ${target}\n`);
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const options = parseArgs(argv);
  const loaded = await loadReportCardInput(options, cwd, fetchImpl);
  const audit = buildReserveCoverageAudit({
    ...loaded,
    generatedAt: resolveGeneratedAt(options),
  });
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderReserveCoverageAuditMarkdown(audit);

  if (options.reportPath) {
    writeOutput(options.reportPath, output, cwd);
  } else {
    process.stdout.write(output);
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => process.exit(code)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
