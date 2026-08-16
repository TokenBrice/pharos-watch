#!/usr/bin/env tsx

import { resolve } from "node:path";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters-definitions";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import type { LiveReserveEvidenceClass } from "@shared/types/live-reserves";
import type { ReserveSlice, StablecoinMeta } from "@shared/types";
import {
  buildMarketCapMapFromStablecoins,
  formatUsd,
  isRecord,
  loadCoverageAuditSiteDataInputs,
  markdownValue,
  readRequiredJsonFile,
  resolveGeneratedAt,
  sortByMarketCapOrRank,
  stringValue,
  writeOutputFile,
  type UnknownRecord,
} from "../lib/coverage-audit-cli";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  DEFAULT_SOURCE_QUALITY_NOTE,
  REVIEWED_LIVE_RESERVE_SOURCE_NOTES,
  type LiveReserveSourceQualityNote,
} from "../lib/reserve-coverage-notes";

export {
  REVIEWED_LIVE_RESERVE_SOURCE_NOTES,
  type LiveReserveSourceQuality,
  type LiveReserveSourceQualityNote,
} from "../lib/reserve-coverage-notes";

const SCORE_GRADE_GAP_LIMIT = 50;
const CURATED_ONLY_CANDIDATE_LIMIT = 50;
const RESERVE_REVIEW_STALE_DAYS = 365;
const RESERVE_COMPOSITION_STALE_DAYS = 180;
const MATERIAL_UNKNOWN_EXPOSURE_PCT = 10;

const PROOF_REPORT_MAX_AGE_DAYS: Readonly<
  Record<NonNullable<StablecoinMeta["proofOfReserves"]>["cadence"] & string, number>
> = {
  "daily-nav": 14,
  "real-time": 14,
  daily: 14,
  weekly: 21,
  monthly: 62,
  "semi-monthly": 45,
  quarterly: 125,
  "semi-annual": 215,
  annual: 400,
  "ad-hoc": 400,
  none: 400,
};

export interface ReserveEvidenceGapRow {
  coinId: string;
  symbol: string;
  reason: string;
}

export interface MaterialUnknownExposureRow extends ReserveEvidenceGapRow {
  pct: number;
}

export interface OpaqueReserveSliceRow {
  coinId: string;
  symbol: string;
  reserveIndex: number;
  reserveName: string;
  pct: number;
  disposition: string | null;
}

export interface CuratedOnlyReserveCandidateRow extends LiveReserveSourceQualityNote {
  coinId: string;
  symbol: string;
  name: string;
  marketCapUsd: number | null;
  rank: number;
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
    activeStructuredReserveSliceCount: number;
    activeWithReserveReviewCount: number;
    activeMissingReserveReviewCount: number;
    activeStaleReserveReviewCount: number;
    activeMissingCompositionDateCount: number;
    activeStaleCompositionCount: number;
    activeMaterialUnknownExposureCount: number;
    activeOpaqueReserveSliceCount: number;
    activeWithProofOfReservesCount: number;
    activeWithLatestProofReportCount: number;
    activeLatestProofAssetsOnlyCount: number;
    activeLatestProofAssetsAndLiabilitiesCount: number;
    activeIndependentAuditCount: number;
    activeIndependentAuditMissingLatestReportCount: number;
    activeStaleLatestProofReportCount: number;
    activeExplicitCustodyModelCount: number;
    activeWithCustodyProfileCount: number;
    activeMissingCustodyProfileCount: number;
    activeCustodyConsistencyWarningCount: number;
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
  missingReserveReview: ReserveEvidenceGapRow[];
  staleReserveReview: ReserveEvidenceGapRow[];
  missingCompositionDate: ReserveEvidenceGapRow[];
  staleComposition: ReserveEvidenceGapRow[];
  materialUnknownExposure: MaterialUnknownExposureRow[];
  opaqueReserveSlices: OpaqueReserveSliceRow[];
  independentAuditMissingLatestReport: ReserveEvidenceGapRow[];
  staleLatestProofReport: ReserveEvidenceGapRow[];
  missingCustodyProfile: ReserveEvidenceGapRow[];
  custodyConsistencyWarnings: ReserveEvidenceGapRow[];
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

function boolValue(value: unknown): boolean {
  return value === true;
}

function ageDays(date: string, generatedAt: string): number {
  return (Date.parse(generatedAt) - Date.parse(`${date}T00:00:00.000Z`)) / 86_400_000;
}

function evidenceGap(coin: StablecoinMeta, reason: string): ReserveEvidenceGapRow {
  return { coinId: coin.id, symbol: coin.symbol, reason };
}

function isOpaqueReserveSlice(reserve: ReserveSlice): boolean {
  if (reserve.coinId || reserve.pct < MATERIAL_UNKNOWN_EXPOSURE_PCT) return false;
  return (
    /\b(?:basket|mix(?:ed)?|other|various|multiple|portfolio|strateg(?:y|ies))\b|\([^)]*\/[^)]*\)/i.test(
      reserve.name,
    ) ||
    (reserve.assetClass === "other" && reserve.name.includes(",") && /\band\b/i.test(reserve.name))
  );
}

function custodyConsistencyReason(coin: StablecoinMeta): string | null {
  if (!coin.custodyModel || !coin.custodyProfile) return null;
  const offchainRoles = coin.custodyProfile.providers.filter((provider) => provider.role !== "other");
  if (coin.custodyModel === "onchain" && offchainRoles.length > 0) {
    return "onchain custodyModel has a reviewed bank, custodian, or prime-broker provider";
  }
  if (coin.custodyModel.startsWith("institutional-") && offchainRoles.length === 0) {
    return "institutional custodyModel has no reviewed bank, custodian, or prime-broker provider";
  }
  if (coin.custodyModel === "cex" && coin.custodyProfile.segregation === "segregated") {
    return "cex custodyModel conflicts with a fully segregated custody profile";
  }
  return null;
}

function extractReportCardRows(payload: unknown): UnknownRecord[] | null {
  const envelope = isRecord(payload) && isRecord(payload.payload) ? payload.payload : payload;
  if (!isRecord(envelope) || !Array.isArray(envelope.cards)) return null;
  return envelope.cards.filter(isRecord);
}

function reserveSlicesFor(coin: StablecoinMeta): readonly ReserveSlice[] {
  return coin.reserves ?? [];
}

function buildCuratedOnlyCandidates(
  activeCoins: readonly StablecoinMeta[],
  marketCapById: ReadonlyMap<string, number> | null,
): CuratedOnlyReserveCandidateRow[] {
  const rows = activeCoins.flatMap((coin, index): CuratedOnlyReserveCandidateRow[] => {
    if (coin.liveReservesConfig?.adapter || reserveSlicesFor(coin).length === 0) return [];
    const note = REVIEWED_LIVE_RESERVE_SOURCE_NOTES[coin.id] ?? DEFAULT_SOURCE_QUALITY_NOTE;
    return [
      {
        coinId: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        marketCapUsd: marketCapById?.get(coin.id) ?? null,
        rank: index + 1,
        ...note,
      },
    ];
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
  "reportCardActiveCount" | "collateralFromLiveActiveCount" | "dependencyFromLiveActiveCount"
> & { collateralFromLiveIds: Set<string> } {
  const rows = extractReportCardRows(payload);
  if (!rows) {
    throw new Error("Report-card input does not contain cards[].");
  }

  const activeRows = rows.filter((row) => {
    const id = stringValue(row.id, { trim: false });
    return id != null && activeIds.has(id);
  });
  const collateralFromLiveIds = new Set<string>();
  let dependencyFromLiveActiveCount = 0;

  for (const row of activeRows) {
    const id = stringValue(row.id, { trim: false });
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
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const trackedCoins = input.trackedCoins ?? TRACKED_STABLECOINS;
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const preLaunchCoins = input.preLaunchCoins ?? PRE_LAUNCH_STABLECOINS;
  const frozenCoins = input.frozenCoins ?? FROZEN_STABLECOINS;
  const activeIds = new Set(activeCoins.map((coin) => coin.id));
  const warnings: string[] = [];
  const liveEnabledByEvidenceClass = emptyEvidenceClassCounts();
  const marketCapById = buildMarketCapMapFromStablecoins(input.stablecoins, { trimId: false });
  if (input.stablecoins !== undefined && marketCapById?.size === 0) {
    warnings.push("Stablecoin payload did not contain any pegged asset rows.");
  }

  const staleReviewedSourceNoteIds = Object.keys(REVIEWED_LIVE_RESERVE_SOURCE_NOTES)
    .filter((id) => !activeIds.has(id))
    .sort();
  for (const id of staleReviewedSourceNoteIds) {
    warnings.push(`Reviewed reserve source-quality note for "${id}" no longer matches any active stablecoin.`);
  }

  let activeReserveSliceCount = 0;
  let activeLinkedReserveSliceCount = 0;
  let activeUnlinkedReserveSliceCount = 0;
  let activeUnlinkedReserveSlicePctGte10Count = 0;
  let activeUnlinkedReserveSlicePctGte50Count = 0;
  let activeWithLinkedReserveSliceCount = 0;
  let activeStructuredReserveSliceCount = 0;
  let liveEnabledActiveCount = 0;
  const independentConfiguredIds: string[] = [];
  const missingReserveReview: ReserveEvidenceGapRow[] = [];
  const staleReserveReview: ReserveEvidenceGapRow[] = [];
  const missingCompositionDate: ReserveEvidenceGapRow[] = [];
  const staleComposition: ReserveEvidenceGapRow[] = [];
  const materialUnknownExposure: MaterialUnknownExposureRow[] = [];
  const opaqueReserveSlices: OpaqueReserveSliceRow[] = [];
  const independentAuditMissingLatestReport: ReserveEvidenceGapRow[] = [];
  const staleLatestProofReport: ReserveEvidenceGapRow[] = [];
  const missingCustodyProfile: ReserveEvidenceGapRow[] = [];
  const custodyConsistencyWarnings: ReserveEvidenceGapRow[] = [];
  let activeWithReserveReviewCount = 0;
  let activeWithProofOfReservesCount = 0;
  let activeWithLatestProofReportCount = 0;
  let activeLatestProofAssetsOnlyCount = 0;
  let activeLatestProofAssetsAndLiabilitiesCount = 0;
  let activeIndependentAuditCount = 0;
  let activeExplicitCustodyModelCount = 0;
  let activeWithCustodyProfileCount = 0;

  for (const coin of activeCoins) {
    const reserves = reserveSlicesFor(coin);
    activeReserveSliceCount += reserves.length;
    if (reserves.some((reserve) => reserve.coinId)) {
      activeWithLinkedReserveSliceCount += 1;
    }

    for (const reserve of reserves) {
      if (
        reserve.assetClass ||
        reserve.issuerOrObligor ||
        reserve.riskFactors ||
        reserve.liquidityHorizon ||
        reserve.maturityDaysMax != null
      ) {
        activeStructuredReserveSliceCount += 1;
      }
      if (reserve.coinId) {
        activeLinkedReserveSliceCount += 1;
      } else {
        activeUnlinkedReserveSliceCount += 1;
        if (reserve.pct >= 10) activeUnlinkedReserveSlicePctGte10Count += 1;
        if (reserve.pct >= 50) activeUnlinkedReserveSlicePctGte50Count += 1;
      }
    }

    if (reserves.length > 0) {
      if (coin.reserveReview) {
        activeWithReserveReviewCount += 1;
        if (ageDays(coin.reserveReview.reviewedAt, generatedAt) > RESERVE_REVIEW_STALE_DAYS) {
          staleReserveReview.push(evidenceGap(coin, `reviewed ${coin.reserveReview.reviewedAt}`));
        }
        if (!coin.reserveReview.compositionAsOf) {
          missingCompositionDate.push(evidenceGap(coin, "reserveReview has no compositionAsOf date"));
        } else if (ageDays(coin.reserveReview.compositionAsOf, generatedAt) > RESERVE_COMPOSITION_STALE_DAYS) {
          staleComposition.push(evidenceGap(coin, `composition as of ${coin.reserveReview.compositionAsOf}`));
        }
        if (coin.reserveReview.knownUnknownExposurePct >= MATERIAL_UNKNOWN_EXPOSURE_PCT) {
          materialUnknownExposure.push({
            ...evidenceGap(coin, coin.reserveReview.knownUnknownExposure),
            pct: coin.reserveReview.knownUnknownExposurePct,
          });
        }
      } else {
        missingReserveReview.push(evidenceGap(coin, "curated reserves have no sourced reserveReview"));
      }

      for (let reserveIndex = 0; reserveIndex < reserves.length; reserveIndex += 1) {
        const reserve = reserves[reserveIndex];
        if (!isOpaqueReserveSlice(reserve)) continue;
        const disposition = coin.reserveReview?.nonLinkDispositions?.find(
          (entry) => entry.reserveIndex === reserveIndex && entry.reserveName === reserve.name,
        );
        opaqueReserveSlices.push({
          coinId: coin.id,
          symbol: coin.symbol,
          reserveIndex,
          reserveName: reserve.name,
          pct: reserve.pct,
          disposition: disposition?.disposition ?? null,
        });
      }
    }

    if (coin.proofOfReserves) {
      activeWithProofOfReservesCount += 1;
      if (coin.proofOfReserves.type === "independent-audit") {
        activeIndependentAuditCount += 1;
        if (!coin.proofOfReserves.latestReport) {
          independentAuditMissingLatestReport.push(
            evidenceGap(coin, "independent-audit label has no structured latestReport"),
          );
        }
      }
      if (coin.proofOfReserves.latestReport) {
        activeWithLatestProofReportCount += 1;
        if (coin.proofOfReserves.latestReport.scope === "assets-only") {
          activeLatestProofAssetsOnlyCount += 1;
        } else {
          activeLatestProofAssetsAndLiabilitiesCount += 1;
        }
        const cadence = coin.proofOfReserves.cadence ?? "ad-hoc";
        const maxAgeDays = PROOF_REPORT_MAX_AGE_DAYS[cadence];
        if (ageDays(coin.proofOfReserves.latestReport.periodEnd, generatedAt) > maxAgeDays) {
          staleLatestProofReport.push(
            evidenceGap(
              coin,
              `latest report period ended ${coin.proofOfReserves.latestReport.periodEnd}; ${cadence} limit is ${maxAgeDays} days`,
            ),
          );
        }
      }
    }

    if (coin.custodyModel) {
      activeExplicitCustodyModelCount += 1;
      if (!coin.custodyProfile) {
        missingCustodyProfile.push(
          evidenceGap(coin, `explicit custodyModel ${coin.custodyModel} has no custodyProfile`),
        );
      }
    }
    if (coin.custodyProfile) activeWithCustodyProfileCount += 1;
    const consistencyReason = custodyConsistencyReason(coin);
    if (consistencyReason) custodyConsistencyWarnings.push(evidenceGap(coin, consistencyReason));

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
    generatedAt,
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
      activeStructuredReserveSliceCount,
      activeWithReserveReviewCount,
      activeMissingReserveReviewCount: missingReserveReview.length,
      activeStaleReserveReviewCount: staleReserveReview.length,
      activeMissingCompositionDateCount: missingCompositionDate.length,
      activeStaleCompositionCount: staleComposition.length,
      activeMaterialUnknownExposureCount: materialUnknownExposure.length,
      activeOpaqueReserveSliceCount: opaqueReserveSlices.length,
      activeWithProofOfReservesCount,
      activeWithLatestProofReportCount,
      activeLatestProofAssetsOnlyCount,
      activeLatestProofAssetsAndLiabilitiesCount,
      activeIndependentAuditCount,
      activeIndependentAuditMissingLatestReportCount: independentAuditMissingLatestReport.length,
      activeStaleLatestProofReportCount: staleLatestProofReport.length,
      activeExplicitCustodyModelCount,
      activeWithCustodyProfileCount,
      activeMissingCustodyProfileCount: missingCustodyProfile.length,
      activeCustodyConsistencyWarningCount: custodyConsistencyWarnings.length,
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
    missingReserveReview,
    staleReserveReview,
    missingCompositionDate,
    staleComposition,
    materialUnknownExposure,
    opaqueReserveSlices,
    independentAuditMissingLatestReport,
    staleLatestProofReport,
    missingCustodyProfile,
    custodyConsistencyWarnings,
    warnings,
  };
}

function renderNullableCount(value: number | null): string {
  return value == null ? "not supplied" : String(value);
}

function renderCuratedOnlyCandidates(rows: readonly CuratedOnlyReserveCandidateRow[]): string[] {
  const clipped = rows.slice(0, CURATED_ONLY_CANDIDATE_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | rank | quality | score-grade plausible | source / adapter note",
    "--- | ---: | ---: | --- | --- | ---",
    ...clipped.map((row) =>
      [
        `${row.symbol} (${row.coinId})`,
        formatUsd(row.marketCapUsd),
        row.rank,
        row.sourceQuality,
        row.scoreGradePlausible ? "yes" : "no",
        `${row.sourceUrl ?? "unreviewed"}; ${row.expectedAdapterFamily}; ${row.freshnessEvidence}`,
      ]
        .map(markdownValue)
        .join(" | "),
    ),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderEvidenceGapRows(rows: readonly ReserveEvidenceGapRow[]): string[] {
  return rows.length === 0 ? ["_None._"] : rows.map((row) => `- ${row.symbol} (${row.coinId}): ${row.reason}`);
}

function renderOpaqueReserveSlices(rows: readonly OpaqueReserveSliceRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "coin | slice | pct | review disposition",
    "--- | --- | ---: | ---",
    ...rows.map((row) =>
      [
        `${row.symbol} (${row.coinId})`,
        `#${row.reserveIndex} ${row.reserveName}`,
        `${row.pct.toFixed(2)}%`,
        row.disposition ?? "unreviewed",
      ]
        .map(markdownValue)
        .join(" | "),
    ),
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
    `- Active reserve slices with structured backing facts: ${audit.summary.activeStructuredReserveSliceCount}`,
    `- Active coins with reserve review: ${audit.summary.activeWithReserveReviewCount}`,
    `- Active coins missing reserve review: ${audit.summary.activeMissingReserveReviewCount}`,
    `- Active stale reserve reviews (>${RESERVE_REVIEW_STALE_DAYS} days): ${audit.summary.activeStaleReserveReviewCount}`,
    `- Active reserve reviews missing composition date: ${audit.summary.activeMissingCompositionDateCount}`,
    `- Active stale reserve compositions (>${RESERVE_COMPOSITION_STALE_DAYS} days): ${audit.summary.activeStaleCompositionCount}`,
    `- Active material known-unknown exposures (>=${MATERIAL_UNKNOWN_EXPOSURE_PCT}%): ${audit.summary.activeMaterialUnknownExposureCount}`,
    `- Active opaque reserve slices: ${audit.summary.activeOpaqueReserveSliceCount}`,
    `- Active coins with proof-of-reserves metadata: ${audit.summary.activeWithProofOfReservesCount}`,
    `- Active coins with a structured latest proof report: ${audit.summary.activeWithLatestProofReportCount}`,
    `- Latest proof reports scoped assets-only: ${audit.summary.activeLatestProofAssetsOnlyCount}`,
    `- Latest proof reports scoped assets-and-liabilities: ${audit.summary.activeLatestProofAssetsAndLiabilitiesCount}`,
    `- Active independent-audit labels: ${audit.summary.activeIndependentAuditCount}`,
    `- Independent-audit labels missing latest report: ${audit.summary.activeIndependentAuditMissingLatestReportCount}`,
    `- Stale latest proof reports: ${audit.summary.activeStaleLatestProofReportCount}`,
    `- Active explicit custodyModel summaries: ${audit.summary.activeExplicitCustodyModelCount}`,
    `- Active coins with custody profile: ${audit.summary.activeWithCustodyProfileCount}`,
    `- Explicit custodyModel summaries missing custody profile: ${audit.summary.activeMissingCustodyProfileCount}`,
    `- Custody profile/summary advisory warnings: ${audit.summary.activeCustodyConsistencyWarningCount}`,
    `- Live-enabled active coins: ${audit.summary.liveEnabledActiveCount}`,
    `- Curated-only active reserve candidates: ${audit.summary.curatedOnlyActiveCount}`,
    `- Curated-only candidate rank source: ${audit.summary.curatedOnlyCandidateRankSource}`,
    `- Live-enabled independent: ${audit.liveEnabledByEvidenceClass.independent}`,
    `- Live-enabled static-validated: ${audit.liveEnabledByEvidenceClass["static-validated"]}`,
    `- Live-enabled weak-live-probe: ${audit.liveEnabledByEvidenceClass["weak-live-probe"]}`,
    `- Report-card active cards: ${renderNullableCount(audit.summary.reportCardActiveCount)}`,
    `- Active collateralFromLive cards: ${renderNullableCount(audit.summary.collateralFromLiveActiveCount)}`,
    `- Active dependencyFromLive cards: ${renderNullableCount(audit.summary.dependencyFromLiveActiveCount)}`,
    `- Independent configured but not score-grade: ${renderNullableCount(
      audit.summary.independentConfiguredButNotScoreGradeCount,
    )}`,
    "",
    "## Independent Configured But Not Score-Grade",
    "",
    audit.independentConfiguredButNotScoreGradeIds == null
      ? "_Report-card snapshot not supplied._"
      : clippedGaps.length === 0
        ? "_None._"
        : clippedGaps.map((id) => `- ${id}`).join("\n"),
    ...(audit.independentConfiguredButNotScoreGradeIds != null &&
    audit.independentConfiguredButNotScoreGradeIds.length > clippedGaps.length
      ? [`_Plus ${audit.independentConfiguredButNotScoreGradeIds.length - clippedGaps.length} more IDs._`]
      : []),
    "",
    "## Highest-Market-Cap Curated-Only Active Candidates",
    "",
    ...renderCuratedOnlyCandidates(audit.curatedOnlyActiveCandidates),
    "",
    "## Reserve Review Gaps",
    "",
    ...renderEvidenceGapRows(audit.missingReserveReview),
    "",
    "### Stale Reviews",
    "",
    ...renderEvidenceGapRows(audit.staleReserveReview),
    "",
    "### Composition Dates",
    "",
    ...renderEvidenceGapRows([...audit.missingCompositionDate, ...audit.staleComposition]),
    "",
    "## Material Known Unknown Exposure",
    "",
    ...renderEvidenceGapRows(
      audit.materialUnknownExposure.map((row) => ({
        ...row,
        reason: `${row.pct.toFixed(2)}%: ${row.reason}`,
      })),
    ),
    "",
    "## Opaque Reserve Slices",
    "",
    ...renderOpaqueReserveSlices(audit.opaqueReserveSlices),
    "",
    "## Proof Report Gaps",
    "",
    ...renderEvidenceGapRows([...audit.independentAuditMissingLatestReport, ...audit.staleLatestProofReport]),
    "",
    "## Custody Evidence Gaps",
    "",
    ...renderEvidenceGapRows([...audit.missingCustodyProfile, ...audit.custodyConsistencyWarnings]),
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

async function loadReportCardInput(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<ReserveCoverageAuditInput, "reportCards" | "stablecoins" | "mode">> {
  const fetchedInputs = await loadCoverageAuditSiteDataInputs(
    { prod: options.prod, apiBase: options.apiBase, apiKeyEnv: "RESERVE_COVERAGE_API_KEY" },
    fetchImpl,
  );
  if (fetchedInputs) return fetchedInputs;

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

function writeOutput(path: string, output: string, cwd: string): void {
  const target = writeOutputFile(path, output, cwd);
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
  const output =
    options.format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : renderReserveCoverageAuditMarkdown(audit);

  if (options.reportPath) {
    writeOutput(options.reportPath, output, cwd);
  } else {
    process.stdout.write(output);
  }

  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
