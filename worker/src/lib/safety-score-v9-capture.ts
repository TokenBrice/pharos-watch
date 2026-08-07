import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import {
  computeReportCardsRegistryFingerprint,
  computeRedemptionPayloadFingerprint,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import type { DexDeploymentSupplyCoverage } from "@shared/lib/report-card-peg-liquidity";
import type { StablecoinData } from "@shared/types/market";
import { summarizeCollateralDriftFromLiveReserveMap } from "./collateral-drift";
import type { StablecoinsCacheLoadResult } from "./stablecoins-cache";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import { publishPegAnalyticsCache } from "./peg-analytics-cache";
import {
  loadReportCardsSnapshotInputs,
  type ReportCardsInputFreshness,
} from "./report-cards-snapshot-inputs";
import {
  buildNavPriceById,
  loadExactDexPublicationGeneration,
  resolveExactRedemptionPublicationGeneration,
} from "./report-cards-snapshot";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeNativeV9Input,
  type NativeDexLiquidityRow,
  type NativeSafetyScoreV9Input,
} from "./safety-score-v9-native-input";
import type { SafetyScoreV9PegProvenanceSource } from "./safety-score-v9-peg-provenance";

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
    missing: string[];
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
    includeBluechipRatings: false,
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

  const activeAssetIds = ACTIVE_STABLECOINS.map((coin) => coin.id).sort();
  const activeAssetIdSet = new Set(activeAssetIds);
  const missing = [...ACTIVE_IDS].filter((id) => !activeAssetIdSet.has(id)).sort();
  if (missing.length > 0) {
    throw new Error(`Native V9 capture is missing ${missing.length} active assets: ${missing.join(",")}`);
  }

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
    chainCirculatingById: Object.fromEntries(
      peggedAssets.map((asset) => [
        asset.id,
        Object.fromEntries(
          Object.entries(asset.chainCirculating ?? {}).map(([chain, bucket]) => [
            chain,
            { current: bucket.current },
          ]),
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
    completeness: { expectedCount: ACTIVE_IDS.size, missing },
  };
}
