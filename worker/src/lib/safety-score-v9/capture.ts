import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import {
  computeReportCardsRegistryFingerprint,
  computeRedemptionPayloadFingerprint,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import type { DexDeploymentSupplyCoverage } from "../report-cards-fixed-input";
import type { StablecoinData } from "@shared/types/market";
import { summarizeCollateralDriftFromLiveReserveMap } from "../collateral-drift";
import type { StablecoinsCacheLoadResult } from "../stablecoins-cache";
import { derivePegAnalyticsSnapshot } from "../peg-analytics";
import { publishPegAnalyticsCache } from "../peg-analytics-cache";
import {
  loadReportCardsSnapshotInputs,
  type ReportCardsInputFreshness,
} from "../report-cards-snapshot-inputs";
import {
  buildNavPriceById,
  loadExactDexPublicationGeneration,
  resolveExactRedemptionPublicationGeneration,
} from "../report-cards-snapshot";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeNativeV9Input,
  type NativeDexLiquidityRow,
  type NativeSafetyScoreV9Input,
} from "./native-input";
import type { SafetyScoreV9PegProvenanceSource } from "./peg-provenance";
import { loadReportCardEvidenceJournalByIdV1 } from "../report-card-evidence-journal-store";
import { createRuntimeGapVerdict } from "./fact-set-context";
import type { PipelineGapByAssetId } from "@shared/lib/report-cards-fixed-input-identity";
import type { ReportCardEvidenceJournalByIdV1 } from "@shared/lib/report-card-evidence-journal";
import { compareCodeUnits } from "@shared/lib/compare";

/** Freeze actual failed attempts; a configured/missing row alone is not a failure proof. */
export function captureReservePipelineGaps(
  journal: ReportCardEvidenceJournalByIdV1,
  liveReserveMap: ReadonlyMap<string, unknown>, clockSec: number,
): PipelineGapByAssetId {
  const rows: PipelineGapByAssetId = {};
  for (const [assetId, attempts] of Object.entries(journal)) {
    if (liveReserveMap.has(assetId)) continue;
    let latest: typeof attempts[number] | undefined;
    for (const attempt of attempts) {
      if (!latest || attempt.completedAtSec > latest.completedAtSec ||
          (attempt.completedAtSec === latest.completedAtSec && compareCodeUnits(attempt.attemptId, latest.attemptId) < 0)) latest = attempt;
    }
    if (!latest || latest.attemptCode !== "reserve.collector.attempted" ||
        !latest.admissionCode.startsWith("reserve.admission.rejected-")) continue;
    rows[assetId] = [createRuntimeGapVerdict({
      assetId, scope: { pillar: "backing", componentKey: "reserve-composition", factorKey: null,
        routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: latest.sourceId, sourceGenerationId: latest.attemptId,
      observedAtSec: latest.completedAtSec, asOfSec: clockSec,
      producerState: latest.admissionCode === "reserve.admission.rejected-sidecar-mismatch" ? "config-mismatch"
        : latest.admissionCode === "reserve.admission.rejected-stale" ? "stale-producer" : "producer-failed",
      rejectionCode: latest.admissionCode, reason: latest.admissionCode,
      contentSha256: latest.admissionCode === "reserve.admission.rejected-sidecar-mismatch"
        ? latest.sidecarMaterializationSha256 : latest.contentSha256,
    })];
  }
  return rows;
}

export interface BuildNativeSafetyScoreV9CaptureOptions {
  /**
   * Producer generation the scheduler observed before invoking the capture. A
   * mismatch means the DEX lane advanced mid-run and the capture would bind a
   * generation the compute cron will immediately reject.
   */
  expectedDexGenerationId?: string;
  preloadedStablecoinsCache?: StablecoinsCacheLoadResult;
}

export interface NativeSafetyScoreV9Capture {
  input: NativeSafetyScoreV9Input;
  /** Ephemeral raw peg evidence for the seed; never serialized into the input. */
  v9PegProvenanceSource: SafetyScoreV9PegProvenanceSource;
  pegAnalyticsPublished: boolean;
  completeness: {
    expectedCount: number;
  };
}

function freshnessAtClock(
  entry: ReportCardsInputFreshness["dexLiquidity"],
  clockSec: number,
  lane: "DEX liquidity" | "redemption backstops",
): ReportCardsInputFreshness["dexLiquidity"] {
  if (entry.updatedAt != null && entry.updatedAt > clockSec) {
    throw new Error(
      `Native V9 capture ${lane} producer timestamp ${entry.updatedAt} is later than scoring clock ${clockSec}`,
    );
  }
  return {
    ...entry,
    ageSeconds: entry.updatedAt == null ? null : clockSec - entry.updatedAt,
  };
}

/**
 * Captures the exact native V9 scoring input straight from its producers.
 *
 * This deliberately never calls `buildLiveReportCards`: the V8 report-card
 * projection is not on the V9 publication path, and running it only to throw
 * the cards away is what forced the capture to carry the bluechip, blacklist,
 * and collateral-drift fields the V9 compiler never reads.
 *
 * Publishing the peg-analytics aggregate is an explicit step here rather than a
 * side effect of a snapshot builder that several read paths also invoke.
 */
export async function buildNativeSafetyScoreV9Capture(
  db: D1Database,
  options: BuildNativeSafetyScoreV9CaptureOptions = {},
): Promise<NativeSafetyScoreV9Capture> {
  const {
    stablecoinsCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    redemptionSnapshotProvenance,
    liveReserveMap,
    liveReserveProvenanceMap,
    liquidityStale,
    redemptionStale,
    inputFreshness,
    v9PublicationInputHealth,
  } = await loadReportCardsSnapshotInputs(db, {
    ...(options.preloadedStablecoinsCache
      ? { preloadedStablecoinsCache: options.preloadedStablecoinsCache }
      : {}),
  });

  const peggedAssets: StablecoinData[] = stablecoinsCached.payload.peggedAssets;
  const fxFallbackRates = stablecoinsCached.payload.fxFallbackRates;

  // Nav-inclusive so the published peg-analytics cache can serve peg-summary
  // (which needs nav tokens); the capture filters nav entries back out.
  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCached.updatedAt,
    includeNavTokens: true,
  });
  const pegAnalyticsPublished = await publishPegAnalyticsCache(db, pegAnalytics);

  const clockSec = pegAnalytics.nowSec;
  const nonNavPegDataById = new Map(
    [...pegAnalytics.pegDataById].filter(([id]) => ACTIVE_META_BY_ID.get(id)?.flags.navToken !== true),
  );
  const scoringInputFreshness: ReportCardsInputFreshness = {
    dexLiquidity: freshnessAtClock(inputFreshness.dexLiquidity, clockSec, "DEX liquidity"),
    redemptionBackstops: freshnessAtClock(inputFreshness.redemptionBackstops, clockSec, "redemption backstops"),
  };

  const activeDepegPeakBpsById = new Map<string, number>();
  for (const [stablecoinId, events] of pegAnalytics.eventsByCoin ?? new Map()) {
    const activePeakBps = events
      .filter((event) => event.endedAt === null)
      .reduce((max, event) => Math.max(max, Math.abs(event.peakDeviationBps)), 0);
    if (activePeakBps > 0) activeDepegPeakBpsById.set(stablecoinId, activePeakBps);
  }

  const dexPublication = await loadExactDexPublicationGeneration(db);
  if (options.expectedDexGenerationId !== undefined && dexPublication.generationId !== options.expectedDexGenerationId) {
    throw new Error(
      `V9 input captured DEX generation ${dexPublication.generationId}; expected ${options.expectedDexGenerationId}`,
    );
  }
  if (scoringInputFreshness.dexLiquidity.updatedAt !== dexPublication.updatedAt) {
    throw new Error(
      `Native V9 capture DEX freshness ${scoringInputFreshness.dexLiquidity.updatedAt} does not match active generation ${dexPublication.updatedAt}`,
    );
  }

  const dexLiqMap: Record<string, NativeDexLiquidityRow> = {};
  const dexDeploymentSupplyCoverageById: NativeSafetyScoreV9Input["dexDeploymentSupplyCoverageById"] = {};
  const dexMethodologyVersions = new Set<string>();
  for (const coin of ACTIVE_STABLECOINS) {
    const row = dexLiquiditySnapshot.map[coin.id];
    if (!row) throw new Error(`Native V9 capture has no in-memory DEX row for ${coin.id}`);
    const methodologyVersion = (row as typeof row & { methodologyVersion?: string }).methodologyVersion?.trim();
    if (!methodologyVersion) {
      throw new Error(`Native V9 capture has no persisted DEX methodology for ${coin.id}`);
    }
    dexMethodologyVersions.add(methodologyVersion);
    // Producer methodology stays in `inputMethodologyVersions`; the row itself
    // carries only what the V9 exit compiler reads.
    dexLiqMap[coin.id] = {
      updatedAt: dexPublication.updatedAt,
      ...(row.exitRouteObservations !== undefined ? { exitRouteObservations: row.exitRouteObservations } : {}),
      ...(row.exitRouteObservationCoverage !== undefined
        ? { exitRouteObservationCoverage: row.exitRouteObservationCoverage }
        : {}),
    };
    const coverage = (row as typeof row & { deploymentSupplyCoverage?: DexDeploymentSupplyCoverage })
      .deploymentSupplyCoverage;
    if (coverage) dexDeploymentSupplyCoverageById[coin.id] = coverage;
  }
  if (dexMethodologyVersions.size !== 1) {
    throw new Error(`Native V9 capture spans ${dexMethodologyVersions.size} DEX methodologies`);
  }

  const redemptionUpdatedAt = scoringInputFreshness.redemptionBackstops.updatedAt;
  const redemptionGenerationId = resolveExactRedemptionPublicationGeneration({
    entries: Object.values(redemptionBackstopMap),
    freshnessUpdatedAt: redemptionUpdatedAt,
    stale: redemptionStale,
    runId: redemptionSnapshotProvenance.runId,
    methodologyVersion: redemptionSnapshotProvenance.methodologyVersion,
  });

  // `ACTIVE_IDS` is built from `ACTIVE_STABLECOINS` in the same registry
  // module, so the capture's asset list cannot diverge from the active set. The
  // guard that used to compare them, and the always-empty `missing` list it
  // reported, were tautologies left over from the V8-shaped bridge.
  const activeAssetIds = ACTIVE_STABLECOINS.map((coin) => coin.id).sort();
  const reserveJournal = await loadReportCardEvidenceJournalByIdV1(db, activeAssetIds, clockSec);
  const pipelineGapByAssetId = captureReservePipelineGaps(reserveJournal, liveReserveMap, clockSec);

  // Collateral drift itself keeps running in the reserve/status lane; only the
  // capture of its diagnostic output drops. The fallback list stays: the V9
  // backing compiler reads it.
  const { fallbackCoins: liveToFallbackCoins } = summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);

  const registryFingerprint = computeReportCardsRegistryFingerprint();
  const pegDataById = Object.fromEntries(nonNavPegDataById);
  const input = normalizeNativeV9Input({
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${stablecoinsCached.updatedAt}`,
    registryRevision: `sha256:${registryFingerprint}`,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: stablecoinsCached.updatedAt,
    liquidityStale,
    redemptionStale,
    inputFreshness: scoringInputFreshness,
    v9PublicationInputHealth: {
      ...v9PublicationInputHealth,
      dex: {
        ...v9PublicationInputHealth.dex,
        generationId: dexPublication.generationId,
        updatedAtSec: dexPublication.updatedAt,
      },
      redemption: {
        ...v9PublicationInputHealth.redemption,
        generationId: redemptionGenerationId,
        updatedAtSec: redemptionUpdatedAt,
      },
    },
    pegDataById,
    navPriceById: buildNavPriceById(peggedAssets, clockSec),
    activeDepegPeakBpsById: Object.fromEntries(activeDepegPeakBpsById),
    redemptionBackstopMap,
    liveReserveMap: Object.fromEntries(liveReserveMap),
    liveReserveProvenanceMap: Object.fromEntries(liveReserveProvenanceMap),
    pipelineGapByAssetId,
    chainCirculatingById: Object.fromEntries(
      peggedAssets.map((asset) => [
        asset.id,
        // An unavailable chain observation (`current: null`) is absent from the V9 input, never a zero row.
        Object.fromEntries(
          Object.entries(asset.chainCirculating ?? {}).flatMap(([chain, bucket]): [string, { current: number }][] =>
            bucket.current == null ? [] : [[chain, { current: bucket.current }]],
          ),
        ),
      ]),
    ),
    aggregateCirculatingById: Object.fromEntries(
      peggedAssets.map((asset) => [
        asset.id,
        { circulating: asset.circulating, observedAtSec: asset.supplyObservedAt ?? null },
      ]),
    ),
    dexDeploymentSupplyCoverageById,
    liveToFallbackCoins,
    activeAssetIds,
    dexGenerationId: dexPublication.generationId,
    redemptionGenerationId,
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, dexPublication.generationId),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(redemptionBackstopMap, redemptionGenerationId),
    registryFingerprint,
    inputMethodologyVersions: projectReportCardsFixedInputMethodologyVersions({
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      dexLiqMap: Object.fromEntries(
        ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: [...dexMethodologyVersions][0] }]),
      ),
      pegDataById,
      redemptionBackstopMap,
    }),
    dexLiqMap,
  });

  return {
    input,
    v9PegProvenanceSource: {
      clockSec,
      eventsByCoin: pegAnalytics.eventsByCoin,
    },
    pegAnalyticsPublished,
    completeness: { expectedCount: activeAssetIds.length },
  };
}
