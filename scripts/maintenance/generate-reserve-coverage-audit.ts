#!/usr/bin/env tsx

import { resolve } from "node:path";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapter-descriptors";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import type { LiveReserveEvidenceClass, LiveReserveFreshnessMode } from "@shared/types/live-reserves";
import type { ReserveSlice, StablecoinMeta } from "@shared/types";
import {
  buildMarketCapMapFromStablecoins,
  formatUsd,
  isRecord,
  loadCoverageAuditSiteDataInputs,
  parseCoverageAuditCliArgs,
  readRequiredJsonFile,
  resolveGeneratedAt,
  runCoverageAuditCli,
  sortByMarketCapOrRank,
  stringValue,
  type UnknownRecord,
} from "../lib/coverage-audit-cli";
import { runAsMain } from "../lib/coverage-audit-cli";
import { renderMarkdownRows } from "../lib/markdown-report";
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
  // Undisclosed cadence carries the same permissive ceiling as `none`/`ad-hoc`:
  // an unknown publication rhythm cannot imply a tighter staleness budget.
  undisclosed: 400,
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

export type ReserveSyncStatus = "ok" | "degraded" | "error" | "skipped";

/** One coin's resolved prod reserve state, as carried by the `--reserve-states` input. */
export interface ReserveStateRow {
  id: string;
  syncStatus: ReserveSyncStatus | null;
  scoringEligible: boolean | null;
  freshnessMode: LiveReserveFreshnessMode | null;
}

/** Per-adapter prod reliability rollup: bound coins and their sync/score-grade split. */
export interface AdapterReliabilityRow {
  adapter: string;
  boundCoinCount: number;
  syncOk: number;
  syncDegraded: number;
  syncError: number;
  syncSkippedOrUnknown: number;
  scoreGradeCount: number;
}

export interface ReserveCoverageAuditInput {
  trackedCoins?: readonly StablecoinMeta[];
  activeCoins?: readonly StablecoinMeta[];
  preLaunchCoins?: readonly StablecoinMeta[];
  frozenCoins?: readonly StablecoinMeta[];
  reportCards?: unknown;
  stablecoins?: unknown;
  reserveStates?: unknown;
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
    activeAgreedUponProceduresCount: number;
    activeAgreedUponProceduresMissingLatestReportCount: number;
    activeAttestationCount: number;
    activeAttestationMissingLatestReportCount: number;
    activeStaleLatestProofReportCount: number;
    activeExplicitCustodyModelCount: number;
    activeWithCustodyProfileCount: number;
    activeMissingCustodyProfileCount: number;
    activeCustodyConsistencyWarningCount: number;
    liveEnabledActiveCount: number;
    curatedOnlyActiveCount: number;
    curatedOnlyCandidateRankSource: "stablecoin-api-market-cap" | "local-canonical-order";
    reportCardActiveCount: number | null;
    backingFromLiveReservesActiveCount: number | null;
    dependencyFromLiveActiveCount: number | null;
    independentConfiguredButNotScoreGradeCount: number | null;
  };
  liveEnabledByEvidenceClass: Record<LiveReserveEvidenceClass, number>;
  independentConfiguredButNotScoreGradeIds: string[] | null;
  freshnessProbeGaps: ReserveEvidenceGapRow[];
  freshnessUpstreamLimitations: ReserveEvidenceGapRow[];
  freshnessObservationsMissing: number;
  adapterReliability: AdapterReliabilityRow[];
  reserveStatesSupplied: boolean;
  curatedOnlyActiveCandidates: CuratedOnlyReserveCandidateRow[];
  missingReserveReview: ReserveEvidenceGapRow[];
  staleReserveReview: ReserveEvidenceGapRow[];
  missingCompositionDate: ReserveEvidenceGapRow[];
  staleComposition: ReserveEvidenceGapRow[];
  materialUnknownExposure: MaterialUnknownExposureRow[];
  opaqueReserveSlices: OpaqueReserveSliceRow[];
  independentAuditMissingLatestReport: ReserveEvidenceGapRow[];
  agreedUponProceduresMissingLatestReport: ReserveEvidenceGapRow[];
  attestationMissingLatestReport: ReserveEvidenceGapRow[];
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
  reserveStatesPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  generatedAt: string | null;
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
  "reportCardActiveCount" | "backingFromLiveReservesActiveCount" | "dependencyFromLiveActiveCount"
> & { backingFromLiveReservesIds: Set<string> | null } {
  const rows = extractReportCardRows(payload);
  if (!rows || rows.length === 0) {
    throw new Error("Report-card input must contain at least one card.");
  }

  const activeRows = rows.filter((row) => {
    const id = stringValue(row.id, { trim: false });
    return id != null && activeIds.has(id);
  });
  const backingFromLiveReservesIds = new Set<string>();
  let backingFromLiveReservesAvailable = true;

  for (const row of activeRows) {
    const id = stringValue(row.id, { trim: false });
    if (typeof row.backingFromLiveReserves !== "boolean") {
      backingFromLiveReservesAvailable = false;
    } else if (id && row.backingFromLiveReserves) {
      backingFromLiveReservesIds.add(id);
    }
  }

  return {
    reportCardActiveCount: activeRows.length,
    backingFromLiveReservesActiveCount: backingFromLiveReservesAvailable
      ? backingFromLiveReservesIds.size
      : null,
    dependencyFromLiveActiveCount: null,
    backingFromLiveReservesIds: backingFromLiveReservesAvailable
      ? backingFromLiveReservesIds
      : null,
  };
}

/** Parses a `--reserve-states` payload into per-coin prod reserve states. */
export function extractReserveStateRows(payload: unknown): ReserveStateRow[] {
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.reserves)
      ? payload.reserves
      : [];
  const rows: ReserveStateRow[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.stablecoinId === "string"
      ? entry.stablecoinId
      : typeof entry.id === "string"
        ? entry.id
        : "";
    if (id === "") continue;
    const provenance = isRecord(entry.provenance) ? entry.provenance : null;
    const sync = isRecord(entry.sync) ? entry.sync : null;
    const status = sync?.status;
    const syncStatus =
      status === "ok" || status === "degraded" || status === "error" || status === "skipped" ? status : null;
    const scoringEligible =
      provenance != null && typeof provenance.scoringEligible === "boolean"
        ? provenance.scoringEligible
        : null;
    const freshnessMode =
      provenance != null &&
      (provenance.freshnessMode === "verified" ||
        provenance.freshnessMode === "unverified" ||
        provenance.freshnessMode === "not-applicable")
        ? provenance.freshnessMode
        : null;
    rows.push({ id, syncStatus, scoringEligible, freshnessMode });
  }
  return rows;
}

function buildAdapterReliability(
  activeCoins: readonly StablecoinMeta[],
  reserveStateRows: readonly ReserveStateRow[],
): AdapterReliabilityRow[] {
  const stateById = new Map(reserveStateRows.map((row) => [row.id, row]));
  const coinsByAdapter = new Map<string, StablecoinMeta[]>();
  for (const coin of activeCoins) {
    const adapter = coin.liveReservesConfig?.adapter;
    if (!adapter) continue;
    const list = coinsByAdapter.get(adapter) ?? [];
    list.push(coin);
    coinsByAdapter.set(adapter, list);
  }
  return [...coinsByAdapter.entries()]
    .map(([adapter, coins]) => {
      let syncOk = 0;
      let syncDegraded = 0;
      let syncError = 0;
      let syncSkippedOrUnknown = 0;
      let scoreGradeCount = 0;
      for (const coin of coins) {
        const state = stateById.get(coin.id);
        if (state?.syncStatus === "ok") syncOk += 1;
        else if (state?.syncStatus === "degraded") syncDegraded += 1;
        else if (state?.syncStatus === "error") syncError += 1;
        else syncSkippedOrUnknown += 1;
        if (state?.scoringEligible === true) scoreGradeCount += 1;
      }
      return {
        adapter,
        boundCoinCount: coins.length,
        syncOk,
        syncDegraded,
        syncError,
        syncSkippedOrUnknown,
        scoreGradeCount,
      };
    })
    .sort((left, right) => right.boundCoinCount - left.boundCoinCount || left.adapter.localeCompare(right.adapter));
}

function buildFreshnessCoverage(
  activeCoins: readonly StablecoinMeta[],
  rows: readonly ReserveStateRow[],
) {
  const states = new Map(rows.map((row) => [row.id, row]));
  const freshnessProbeGaps: ReserveEvidenceGapRow[] = [];
  const freshnessUpstreamLimitations: ReserveEvidenceGapRow[] = [];
  let freshnessObservationsMissing = 0;
  for (const coin of activeCoins) {
    const config = coin.liveReservesConfig;
    if (!config) continue;
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
    if (definition.evidenceClass !== "independent") continue;
    const modes: readonly string[] = "validation" in definition
      ? definition.validation.allowedFreshnessModes ?? []
      : [];
    if (!modes.includes("unverified")) continue;
    const freshness = states.get(coin.id)?.freshnessMode;
    if (freshness == null) freshnessObservationsMissing += 1;
    if ("freshnessLimitation" in definition) {
      freshnessUpstreamLimitations.push(evidenceGap(
        coin, `${config.adapter}: ${definition.freshnessLimitation} Latest known: ${freshness ?? "not supplied"}.`,
      ));
    } else if (
      freshness === "unverified" &&
      "preferredFreshnessMode" in definition &&
      definition.preferredFreshnessMode != null
    ) {
      freshnessProbeGaps.push(evidenceGap(
        coin, `${config.adapter}: latest unverified; preferred ${definition.preferredFreshnessMode} — probe not built or not producing preferred evidence.`,
      ));
    }
  }
  return { freshnessProbeGaps, freshnessUpstreamLimitations, freshnessObservationsMissing };
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

  const liveConfiguredAdapterById: Record<string, string> = {};
  for (const coin of activeCoins) {
    if (coin.liveReservesConfig?.adapter) {
      liveConfiguredAdapterById[coin.id] = coin.liveReservesConfig.adapter;
    }
  }
  const liveConfiguredReviewedNoteIds = Object.keys(REVIEWED_LIVE_RESERVE_SOURCE_NOTES)
    .filter((id) => liveConfiguredAdapterById[id] !== undefined)
    .sort();
  for (const id of liveConfiguredReviewedNoteIds) {
    warnings.push(
      `Reviewed reserve source-quality note for "${id}" is now live-configured via ${liveConfiguredAdapterById[id]}; delete the note.`,
    );
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
  const agreedUponProceduresMissingLatestReport: ReserveEvidenceGapRow[] = [];
  const attestationMissingLatestReport: ReserveEvidenceGapRow[] = [];
  const staleLatestProofReport: ReserveEvidenceGapRow[] = [];
  const missingCustodyProfile: ReserveEvidenceGapRow[] = [];
  const custodyConsistencyWarnings: ReserveEvidenceGapRow[] = [];
  let activeWithReserveReviewCount = 0;
  let activeWithProofOfReservesCount = 0;
  let activeWithLatestProofReportCount = 0;
  let activeLatestProofAssetsOnlyCount = 0;
  let activeLatestProofAssetsAndLiabilitiesCount = 0;
  let activeIndependentAuditCount = 0;
  let activeAgreedUponProceduresCount = 0;
  let activeAttestationCount = 0;
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
      if (coin.proofOfReserves.type === "agreed-upon-procedures") {
        activeAgreedUponProceduresCount += 1;
        if (!coin.proofOfReserves.latestReport) {
          agreedUponProceduresMissingLatestReport.push(
            evidenceGap(coin, "agreed-upon-procedures label has no structured latestReport"),
          );
        }
      }
      if (coin.proofOfReserves.type === "attestation") {
        activeAttestationCount += 1;
        if (!coin.proofOfReserves.latestReport) {
          attestationMissingLatestReport.push(
            evidenceGap(coin, "attestation label has no structured latestReport"),
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
  const reserveStateRows = extractReserveStateRows(input.reserveStates);
  let reportCardActiveCount: number | null = null;
  let backingFromLiveReservesActiveCount: number | null = null;
  let dependencyFromLiveActiveCount: number | null = null;
  let independentConfiguredButNotScoreGradeIds: string[] | null = null;
  if (input.reportCards !== undefined) {
    const reportCardSummary = summarizeReportCards(input.reportCards, activeIds);
    reportCardActiveCount = reportCardSummary.reportCardActiveCount;
    backingFromLiveReservesActiveCount = reportCardSummary.backingFromLiveReservesActiveCount;
    dependencyFromLiveActiveCount = reportCardSummary.dependencyFromLiveActiveCount;
    const backingFromLiveReservesIds = reportCardSummary.backingFromLiveReservesIds;
    if (backingFromLiveReservesIds) {
      independentConfiguredButNotScoreGradeIds = independentConfiguredIds
        .filter((id) => !backingFromLiveReservesIds.has(id))
        .sort();
    }
  }

  return {
    generatedAt,
    ...buildFreshnessCoverage(activeCoins, reserveStateRows),
    adapterReliability: buildAdapterReliability(activeCoins, reserveStateRows),
    reserveStatesSupplied: input.reserveStates !== undefined,
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
      activeAgreedUponProceduresCount,
      activeAgreedUponProceduresMissingLatestReportCount: agreedUponProceduresMissingLatestReport.length,
      activeAttestationCount,
      activeAttestationMissingLatestReportCount: attestationMissingLatestReport.length,
      activeStaleLatestProofReportCount: staleLatestProofReport.length,
      activeExplicitCustodyModelCount,
      activeWithCustodyProfileCount,
      activeMissingCustodyProfileCount: missingCustodyProfile.length,
      activeCustodyConsistencyWarningCount: custodyConsistencyWarnings.length,
      liveEnabledActiveCount,
      curatedOnlyActiveCount: curatedOnlyActiveCandidates.length,
      curatedOnlyCandidateRankSource: marketCapById ? "stablecoin-api-market-cap" : "local-canonical-order",
      reportCardActiveCount,
      backingFromLiveReservesActiveCount,
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
    agreedUponProceduresMissingLatestReport,
    attestationMissingLatestReport,
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
  return renderMarkdownRows({
    headings: ["coin", "mcap", "rank", "quality", "score-grade plausible", "source / adapter note"],
    rows,
    cells: (row) => [
        `${row.symbol} (${row.coinId})`,
        formatUsd(row.marketCapUsd),
        row.rank,
        row.sourceQuality,
        row.scoreGradePlausible ? "yes" : "no",
        `${row.sourceUrl ?? "unreviewed"}; ${row.expectedAdapterFamily}; ${row.freshnessEvidence}`,
    ],
    alignments: ["left", "right", "right", "left", "left", "left"],
    empty: "_None._",
    limit: CURATED_ONLY_CANDIDATE_LIMIT,
    overflow: (hidden) => `_Plus ${hidden} more rows._`,
  });
}

function renderEvidenceGapRows(rows: readonly ReserveEvidenceGapRow[]): string[] {
  return rows.length === 0 ? ["_None._"] : rows.map((row) => `- ${row.symbol} (${row.coinId}): ${row.reason}`);
}

function renderOpaqueReserveSlices(rows: readonly OpaqueReserveSliceRow[]): string[] {
  return renderMarkdownRows({
    headings: ["coin", "slice", "pct", "review disposition"],
    rows,
    cells: (row) => [
        `${row.symbol} (${row.coinId})`,
        `#${row.reserveIndex} ${row.reserveName}`,
        `${row.pct.toFixed(2)}%`,
        row.disposition ?? "unreviewed",
    ],
    alignments: ["left", "left", "right", "left"],
    empty: "_None._",
  });
}

function renderAdapterReliability(audit: ReserveCoverageAudit): string[] {
  if (!audit.reserveStatesSupplied) {
    return [
      "_Reserve sync state not supplied._ Run with `--reserve-states <file>` (populated from the " +
        "`/api/stablecoin-reserves/<id>` `provenance`/`sync` fields) to render per-adapter sync-status " +
        "and score-grade counts.",
    ];
  }
  return renderMarkdownRows({
    headings: ["adapter", "bound coins", "sync ok", "degraded", "error", "skipped/unknown", "score-grade"],
    rows: audit.adapterReliability,
    cells: (row) => [
        row.adapter,
        row.boundCoinCount,
        row.syncOk,
        row.syncDegraded,
        row.syncError,
        row.syncSkippedOrUnknown,
        row.scoreGradeCount,
    ],
    alignments: ["left", "right", "right", "right", "right", "right", "right"],
    empty: "_None._",
  });
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
    `- Active agreed-upon-procedures labels: ${audit.summary.activeAgreedUponProceduresCount}`,
    `- Agreed-upon-procedures labels missing latest report: ${audit.summary.activeAgreedUponProceduresMissingLatestReportCount}`,
    `- Active attestation labels: ${audit.summary.activeAttestationCount}`,
    `- Attestation labels missing latest report: ${audit.summary.activeAttestationMissingLatestReportCount}`,
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
    `- Active backingFromLiveReserves cards: ${renderNullableCount(audit.summary.backingFromLiveReservesActiveCount)}`,
    `- Active dependency provenance cards: ${renderNullableCount(audit.summary.dependencyFromLiveActiveCount)}`,
    `- Independent configured but not score-grade: ${renderNullableCount(
      audit.summary.independentConfiguredButNotScoreGradeCount,
    )}`,
    "",
    "## Freshness: Tolerated, Not Preferred",
    "",
    "Independent-configured coins observed at tolerated unverified freshness rather than their declared target (probe not built or not producing preferred evidence). This is not an assertion that a new probe alone fixes other scoring exclusions.",
    "",
    ...renderEvidenceGapRows(audit.freshnessProbeGaps),
    "",
    `Missing latest-known freshness observations: ${audit.freshnessObservationsMissing}. Supply --reserve-states to distinguish observed fallback from absent data.`,
    "",
    "### Upstream Freshness Limitations (Not Probe Candidates)",
    "",
    ...renderEvidenceGapRows(audit.freshnessUpstreamLimitations),
    "",
    "## Adapter Reliability (--prod)",
    "",
    ...renderAdapterReliability(audit),
    "",
    "## Independent Configured But Not Score-Grade",
    "",
    audit.independentConfiguredButNotScoreGradeIds == null
      ? audit.summary.reportCardActiveCount == null
        ? "_Report-card snapshot not supplied._"
        : "_backingFromLiveReserves unavailable in one or more active report cards._"
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
    ...renderEvidenceGapRows([
      ...audit.independentAuditMissingLatestReport,
      ...audit.agreedUponProceduresMissingLatestReport,
      ...audit.attestationMissingLatestReport,
      ...audit.staleLatestProofReport,
    ]),
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
  return parseCoverageAuditCliArgs(argv, {
    createOptions: (): CliOptions => ({ prod: false, apiBase: null, reportCardsPath: null, stablecoinsPath: null, reserveStatesPath: null, format: "markdown", reportPath: null, generatedAt: null }),
    includeGeneratedAt: true,
    generatedAtMissingMessage: "--generated-at requires an ISO timestamp or 'now'",
    options: [
      { flag: "--prod", kind: "boolean", apply: (options) => { options.prod = true; } },
      { flag: "--api-base", kind: "value", missingMessage: "--api-base requires a URL", apply: (options, value) => { options.apiBase = value!; } },
      { flag: "--report-cards", kind: "value", missingMessage: "--report-cards requires a file path", apply: (options, value) => { options.reportCardsPath = value!; } },
      { flag: "--stablecoins", kind: "value", missingMessage: "--stablecoins requires a file path", apply: (options, value) => { options.stablecoinsPath = value!; } },
      { flag: "--reserve-states", kind: "value", missingMessage: "--reserve-states requires a file path", apply: (options, value) => { options.reserveStatesPath = value!; } },
    ],
    validate: (options) => {
      if (options.prod && options.apiBase) throw new Error("Choose only one of --prod or --api-base.");
      if ((options.prod || options.apiBase) && (options.reportCardsPath || options.stablecoinsPath)) {
        throw new Error("Choose fetched reserve coverage inputs or local input files, not both.");
      }
    },
  });
}

async function loadReportCardInput(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<ReserveCoverageAuditInput, "reportCards" | "stablecoins" | "reserveStates" | "mode">> {
  const reserveStates = options.reserveStatesPath
    ? readRequiredJsonFile(resolve(cwd, options.reserveStatesPath), "--reserve-states")
    : undefined;

  const fetchedInputs = await loadCoverageAuditSiteDataInputs(
    { prod: options.prod, apiBase: options.apiBase, apiKeyEnv: "RESERVE_COVERAGE_API_KEY" },
    fetchImpl,
  );
  if (fetchedInputs) return { ...fetchedInputs, reserveStates };

  const reportCards = options.reportCardsPath
    ? readRequiredJsonFile(resolve(cwd, options.reportCardsPath), "--report-cards")
    : undefined;
  const stablecoins = options.stablecoinsPath
    ? readRequiredJsonFile(resolve(cwd, options.stablecoinsPath), "--stablecoins")
    : undefined;

  return {
    reportCards,
    stablecoins,
    reserveStates,
    mode: reportCards !== undefined || stablecoins !== undefined ? "input" : "static",
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  return runCoverageAuditCli(argv, {
    parse: parseArgs,
    cwd,
    build: async (options) => {
      const loaded = await loadReportCardInput(options, cwd, fetchImpl);
      return buildReserveCoverageAudit({ ...loaded, generatedAt: resolveGeneratedAt(options) });
    },
    renderMarkdown: renderReserveCoverageAuditMarkdown,
    writeMessage: (target) => `Wrote reserve coverage audit to ${target}`,
  });
}

runAsMain(import.meta.url, runCli);
