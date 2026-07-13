import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import { writePegAnalyticsCache } from "./peg-analytics-cache";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { toErrorMessage } from "./error-utils";
import { summarizeCollateralDriftFromLiveReserveMap, type CollateralDriftEntry } from "./collateral-drift";
import { parseBluechipRatingsCache } from "./bluechip-cache";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import { loadReportCardsSnapshotInputs, type ReportCardsInputFreshness } from "./report-cards-snapshot-inputs";
import type { StablecoinsCacheLoadResult } from "./stablecoins-cache";
import { buildLiveReportCards } from "./report-cards-snapshot-card";
import {
  buildDefunctReportCards,
  buildReportCardsSnapshotEnvelope,
  sortReportCards,
} from "./report-cards-snapshot-finalize";
import type { StablecoinData } from "@shared/types/market";
import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { DexDeploymentSupplyCoverage } from "@shared/lib/report-card-peg-liquidity";
import type { DimensionKey, ReportCard, ReportCardGrade } from "@shared/types/report-cards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import {
  computeReportCardsRegistryFingerprint,
  createReportCardsFixedInput,
  type FixedDexLiquidityRow,
  type ReportCardsFixedInput,
} from "./report-cards-fixed-input";

export { ReportCardsSnapshotUnavailableError } from "./report-cards-snapshot-inputs";
export { topologicalOrder } from "./report-cards-snapshot-card";

export interface ReportCardsSnapshot {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    activeDepegSeveritySource: string;
    activeDepegCaps: {
      d: { thresholdBps: number; score: number };
      f: { thresholdBps: number; score: number };
    };
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: {
    edges: DependencyGraphEdge[];
  };
  updatedAt: number;
  liquidityStale: boolean;
  redemptionStale: boolean;
  inputFreshness: ReportCardsInputFreshness;
  /** Coins where live vs curated collateral score diverges by >15 points */
  collateralDriftCoins?: CollateralDriftEntry[];
  /** Coins that fell back from live to curated scoring */
  liveToFallbackCoins?: string[];
  /** Exact in-memory scoring inputs, present only for the publication cron. */
  fixedInput?: ReportCardsFixedInput;
}

export interface BuildReportCardsSnapshotOptions {
  /**
   * Publish the peg-analytics aggregate cache as a side effect. Only the
   * quarter-hourly report-card publish cron should set this; the builder is
   * also invoked from several read paths that must not perform D1 writes.
   */
  publishPegAnalytics?: boolean;
  preloadedStablecoinsCache?: StablecoinsCacheLoadResult;
  sameNotionalScoringMode?: "legacy" | "active";
  captureFixedInput?: boolean;
}

interface DexPublicationRow {
  stablecoin_id: string;
  publication_generation_id: string | null;
  updated_at: number | null;
}

export function resolveExactDexPublicationGeneration(
  rows: readonly DexPublicationRow[],
  activeIds: readonly string[] = ACTIVE_STABLECOINS.map((coin) => coin.id),
): { generationId: string; updatedAt: number } {
  const byId = new Map(rows.map((row) => [row.stablecoin_id, row]));
  const missingIds = activeIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Exact fixed-input capture missing ${missingIds.length} active DEX rows: ${missingIds.join(",")}`);
  }
  const activeRows = activeIds.map((id) => byId.get(id)!);
  const generations = new Set(activeRows.map((row) => row.publication_generation_id));
  const timestamps = new Set(activeRows.map((row) => row.updated_at));
  if (generations.size !== 1 || generations.has(null)) {
    throw new Error(`Exact fixed-input capture spans ${generations.size} active DEX generations`);
  }
  if (timestamps.size !== 1 || timestamps.has(null)) {
    throw new Error(`Exact fixed-input capture spans ${timestamps.size} active DEX timestamps`);
  }
  const generationId = activeRows[0]!.publication_generation_id!;
  const updatedAt = activeRows[0]!.updated_at!;
  if (generationId !== `dex-liquidity-${updatedAt}`) {
    throw new Error(`Active DEX generation ${generationId} does not match row timestamp ${updatedAt}`);
  }
  return { generationId, updatedAt };
}

async function loadExactDexPublicationGeneration(db: D1Database): Promise<{
  generationId: string;
  updatedAt: number;
}> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, publication_generation_id, updated_at
         FROM dex_liquidity
        WHERE stablecoin_id != '__global__'
          AND (publication_generation_id IS NULL OR publication_generation_id IN (
            SELECT generation_id FROM dex_liquidity_publication_generations WHERE state = 'published'
          ))`,
    )
    .all<DexPublicationRow>();
  return resolveExactDexPublicationGeneration(rows.results ?? []);
}

export function resolveExactRedemptionPublicationGeneration(args: {
  entries: readonly { updatedAt: number; methodologyVersion: string }[];
  freshnessUpdatedAt: number | null;
  stale: boolean;
  runId: string | null;
  methodologyVersion: string | null;
}): string {
  if (args.entries.length === 0) {
    if (!args.stale) {
      throw new Error("Exact fixed-input capture has no redemption rows but marks redemption current");
    }
    return "redemption-backstops-unavailable";
  }
  if (args.stale || args.freshnessUpdatedAt == null) {
    throw new Error("Exact fixed-input redemption generation has inconsistent freshness and row coverage");
  }
  if (!args.runId?.startsWith("redemption:") || !args.methodologyVersion) {
    throw new Error("Exact fixed-input redemption rows are not bound to a completed producer run");
  }
  const timestamps = new Set(args.entries.map((entry) => entry.updatedAt));
  if (timestamps.size !== 1 || !timestamps.has(args.freshnessUpdatedAt)) {
    throw new Error("Exact fixed-input redemption rows do not match producer freshness");
  }
  const methodologyVersions = new Set(args.entries.map((entry) => entry.methodologyVersion));
  if (methodologyVersions.size !== 1 || !methodologyVersions.has(args.methodologyVersion)) {
    throw new Error("Exact fixed-input redemption rows do not match producer methodology");
  }
  return args.runId;
}

function freshnessAtClock(
  entry: ReportCardsInputFreshness["dexLiquidity"],
  clockSec: number,
  lane: "DEX liquidity" | "redemption backstops",
) {
  if (entry.updatedAt != null && entry.updatedAt > clockSec) {
    throw new Error(
      `Exact fixed-input ${lane} producer timestamp ${entry.updatedAt} is later than scoring clock ${clockSec}`,
    );
  }
  return {
    ...entry,
    ageSeconds: entry.updatedAt == null ? null : clockSec - entry.updatedAt,
  };
}

export async function buildReportCardsSnapshot(
  db: D1Database,
  {
    publishPegAnalytics = false,
    preloadedStablecoinsCache,
    sameNotionalScoringMode = "legacy",
    captureFixedInput = false,
  }: BuildReportCardsSnapshotOptions = {},
): Promise<ReportCardsSnapshot> {
  const {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    redemptionSnapshotProvenance,
    liveReserveMap,
    liveReserveProvenanceMap,
    liquidityStale,
    redemptionStale,
    inputFreshness,
  } = await loadReportCardsSnapshotInputs(db, { preloadedStablecoinsCache });

  const peggedAssets: StablecoinData[] = stablecoinsCached.payload.peggedAssets;
  const fxFallbackRates = stablecoinsCached.payload.fxFallbackRates;

  const bluechipMap = parseBluechipRatingsCache(bluechipCached?.value, "report-cards-snapshot");

  // Nav-inclusive so the published peg-analytics cache can serve peg-summary
  // (which needs nav tokens); the cards path filters nav entries back out.
  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCached.updatedAt,
    includeNavTokens: true,
  });

  // Publish the request-hot aggregate at producer cadence: peg-summary and the
  // per-coin OG renderer previously re-scanned ~21K depeg_events rows per edge
  // miss to rebuild this exact snapshot.
  if (publishPegAnalytics) {
    const todayStartSec = Math.floor(pegAnalytics.nowSec / DAY_SECONDS) * DAY_SECONDS;
    const yesterdayStartSec = todayStartSec - DAY_SECONDS;
    let depegEventsToday = 0;
    let depegEventsYesterday = 0;
    for (const event of pegAnalytics.allEvents ?? []) {
      if (TRACKED_META_BY_ID.get(event.stablecoinId)?.flags.navToken === true) continue;
      if (event.startedAt >= todayStartSec) depegEventsToday += 1;
      else if (event.startedAt >= yesterdayStartSec) depegEventsYesterday += 1;
    }
    try {
      await writePegAnalyticsCache(db, {
        computedAtSec: pegAnalytics.nowSec,
        depegEventsToday,
        depegEventsYesterday,
        pegData: [...pegAnalytics.pegDataById.values()],
      });
    } catch (error) {
      console.warn(
        "[report-cards-snapshot] peg-analytics cache publish failed (read paths fall back to direct compute):",
        toErrorMessage(error),
      );
    }
  }

  const nonNavPegDataById = new Map(
    [...pegAnalytics.pegDataById].filter(([id]) => ACTIVE_META_BY_ID.get(id)?.flags.navToken !== true),
  );
  const scoringInputFreshness: ReportCardsInputFreshness = captureFixedInput
    ? {
        dexLiquidity: freshnessAtClock(inputFreshness.dexLiquidity, pegAnalytics.nowSec, "DEX liquidity"),
        redemptionBackstops: freshnessAtClock(
          inputFreshness.redemptionBackstops,
          pegAnalytics.nowSec,
          "redemption backstops",
        ),
      }
    : inputFreshness;

  const resolvedBlacklistStatuses = resolveBlacklistStatuses(ACTIVE_STABLECOINS, {
    reserveSlicesById: liveReserveMap,
    trackedMetaById: ACTIVE_META_BY_ID,
  });
  const activeDepegPeakBpsById = new Map<string, number>();
  for (const [stablecoinId, events] of pegAnalytics.eventsByCoin ?? new Map()) {
    const activePeakBps = events
      .filter((event) => event.endedAt === null)
      .reduce((max, event) => Math.max(max, Math.abs(event.peakDeviationBps)), 0);
    if (activePeakBps > 0) {
      activeDepegPeakBpsById.set(stablecoinId, activePeakBps);
    }
  }

  const liveReportCards = buildLiveReportCards({
    pegDataById: nonNavPegDataById,
    activeDepegPeakBpsById,
    dexLiqMap: dexLiquiditySnapshot.map,
    redemptionBackstopMap,
    bluechipMap,
    resolvedBlacklistStatuses,
    liveReserveMap,
    liveReserveProvenanceMap,
    chainCirculatingById: new Map(peggedAssets.map((asset) => [asset.id, asset.chainCirculating])),
    sameNotionalScoringMode,
    exitObservationAsOfSec: pegAnalytics.nowSec,
    dexExitObservationMaxAgeSec: CRON_INTERVALS["sync-dex-liquidity"] * 2,
    liveRedemptionExitObservationMaxAgeSec: CRON_INTERVALS["sync-redemption-backstops"] * 2,
  });

  const { driftCoins: collateralDriftCoins, fallbackCoins: liveToFallbackCoins } =
    summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);

  const snapshot = buildReportCardsSnapshotEnvelope({
    cards: sortReportCards([...liveReportCards.cards, ...buildDefunctReportCards()]),
    updatedAt: stablecoinsCached.updatedAt,
    liquidityStale,
    redemptionStale,
    inputFreshness: scoringInputFreshness,
    collateralDriftCoins,
    liveToFallbackCoins,
    dependencyGraphEdges: liveReportCards.dependencyGraphEdges,
  });

  if (!captureFixedInput) return snapshot;

  const dexPublication = await loadExactDexPublicationGeneration(db);
  if (scoringInputFreshness.dexLiquidity.updatedAt !== dexPublication.updatedAt) {
    throw new Error(
      `Exact fixed-input DEX freshness ${scoringInputFreshness.dexLiquidity.updatedAt} does not match active generation ${dexPublication.updatedAt}`,
    );
  }
  const dexLiqMap: Record<string, FixedDexLiquidityRow> = {};
  const dexMethodologyVersions = new Set<string>();
  const dexDeploymentSupplyCoverageById: ReportCardsFixedInput["dexDeploymentSupplyCoverageById"] = {};
  for (const coin of ACTIVE_STABLECOINS) {
    const row = dexLiquiditySnapshot.map[coin.id];
    if (!row) throw new Error(`Exact fixed-input capture has no in-memory DEX row for ${coin.id}`);
    const methodologyVersion = (row as typeof row & { methodologyVersion?: string }).methodologyVersion?.trim();
    if (!methodologyVersion) {
      throw new Error(`Exact fixed-input capture has no persisted DEX methodology for ${coin.id}`);
    }
    dexMethodologyVersions.add(methodologyVersion);
    dexLiqMap[coin.id] = {
      ...row,
      methodologyVersion,
      updatedAt: dexPublication.updatedAt,
    };
    const coverage = (row as typeof row & { deploymentSupplyCoverage?: DexDeploymentSupplyCoverage })
      .deploymentSupplyCoverage;
    if (coverage) dexDeploymentSupplyCoverageById[coin.id] = coverage;
  }
  if (dexMethodologyVersions.size !== 1) {
    throw new Error(`Exact fixed-input capture spans ${dexMethodologyVersions.size} DEX methodologies`);
  }

  const redemptionUpdatedAt = scoringInputFreshness.redemptionBackstops.updatedAt;
  const redemptionGenerationId = resolveExactRedemptionPublicationGeneration({
    entries: Object.values(redemptionBackstopMap),
    freshnessUpdatedAt: redemptionUpdatedAt,
    stale: redemptionStale,
    runId: redemptionSnapshotProvenance.runId,
    methodologyVersion: redemptionSnapshotProvenance.methodologyVersion,
  });
  const registryFingerprint = computeReportCardsRegistryFingerprint();
  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    capturedAt: new Date(pegAnalytics.nowSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${stablecoinsCached.updatedAt}`,
    dexGenerationId: dexPublication.generationId,
    redemptionGenerationId,
    registryRevision: `sha256:${registryFingerprint}`,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: pegAnalytics.nowSec,
    updatedAt: stablecoinsCached.updatedAt,
    liquidityStale,
    redemptionStale,
    inputFreshness: scoringInputFreshness,
    pegDataById: Object.fromEntries(nonNavPegDataById),
    activeDepegPeakBpsById: Object.fromEntries(activeDepegPeakBpsById),
    dexLiqMap,
    redemptionBackstopMap,
    bluechipMap,
    resolvedBlacklistStatuses: Object.fromEntries(resolvedBlacklistStatuses),
    liveReserveMap: Object.fromEntries(liveReserveMap),
    liveReserveProvenanceMap: Object.fromEntries(liveReserveProvenanceMap),
    chainCirculatingById: Object.fromEntries(peggedAssets.map((asset) => [asset.id, asset.chainCirculating])),
    dexDeploymentSupplyCoverageById,
    collateralDriftCoins,
    liveToFallbackCoins,
  });
  return { ...snapshot, fixedInput };
}
