import { logWorkerEventArgs } from "../../lib/structured-log";
import type { DigestInputData } from "@shared/types/digest";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { round1 } from "@shared/lib/math";
import type { StablecoinData } from "@shared/types/market";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getConditionBand } from "../../lib/stability-index";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { SECONDS } from "../../lib/time-constants";
import {
  collectActiveDepegs,
  collectBlacklistActivity,
  collectLiquidityShifts,
  collectMintBurnFlows,
  collectResolvedDepegs,
  collectSupplyVelocity,
} from "./collectors-market";
import {
  collectDewsStress,
  collectGradeTransitions,
  collectSafetyScores,
  collectYieldAnomalies,
} from "./collectors-risk";
import {
  collectCrossDayTrends,
  collectHistoricalContext,
  collectPsiContributors,
  collectTotalMcapAth,
} from "./collectors-history";
import type {
  CollectorContext,
  CollectorResult,
} from "./collectors-shared";
import { collectorDegraded } from "./collectors-shared";
import type { DepegLifecycleFlag } from "../../lib/depeg-lifecycle";
import { buildRecentDigestMeta, type RecentDigestMetaEntry } from "./runtime-helpers";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../../lib/digest-sql-filters";
import { buildEditorialCandidates } from "./editorial-candidates";
import { buildStandingConditions, collectCauseContext } from "./cause-context";
import { buildDigestIntelligence, parseStoredDigestInput } from "./digest-intelligence";
import { tryParseJson } from "../../lib/json-parse";

function aggregateCollectorReasons(results: readonly CollectorResult<unknown>[]): string[] {
  const seen = new Set<string>();
  const degradedReasons: string[] = [];
  for (const result of results) {
    for (const reason of result.degradedReasons) {
      if (seen.has(reason)) continue;
      seen.add(reason);
      degradedReasons.push(reason);
    }
  }
  return degradedReasons;
}

export interface DailyDigestInputBuildResult {
  inputData: DigestInputData;
  degradedReasons: string[];
  recentMeta: RecentDigestMetaEntry[];
  /** Parsed previous edition input, for lead re-escalation checks. */
  previousInputData: DigestInputData | null;
  /** leadSignalIds of recent editions (newest first), for the lead quota. */
  recentLeadSignalIds: (string | null)[];
  /** Owner-review lifecycle flags over the full open depeg-event set. */
  lifecycleFlags: DepegLifecycleFlag[];
  /** Trailing titles (newest first, up to 30) for long-window title dedupe. */
  recentTitles: string[];
  stablecoinsCacheReason: string | null;
  llmSignals: {
    activeDepegCount: number;
    topDepegs: NonNullable<DigestInputData["topDepegs"]>;
    resolvedDepegs: NonNullable<DigestInputData["resolvedDepegs"]>;
    yieldAnomalies: NonNullable<DigestInputData["yieldAnomalies"]>;
    liquidityShifts: NonNullable<DigestInputData["liquidityShifts"]>;
  };
}

export async function buildDailyDigestInput(db: D1Database): Promise<DailyDigestInputBuildResult> {
  const recentRows = await db
    .prepare(
      `SELECT digest_title, digest_text, digest_extended, digest_meta, input_data
       FROM daily_digest
       WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 7`,
    )
    .all<{
      digest_title: string | null;
      digest_text: string;
      digest_extended: string | null;
      digest_meta: string | null;
      input_data: string | null;
    }>();
  const recentMeta = buildRecentDigestMeta(recentRows.results ?? []);
  const previousInputData = parseStoredDigestInput(recentRows.results?.[0]?.input_data ?? null);
  // Lead-quota history is wider than the 7-edition variety window; a separate
  // meta-only query keeps the variety semantics untouched.
  const leadHistoryRows = await db
    .prepare(
      `SELECT digest_meta FROM daily_digest
       WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 14`,
    )
    .all<{ digest_meta: string | null }>();
  // Trailing titles for the 30-edition title-dedupe window (titles only; the
  // 7-edition variety window and 14-edition lead history stay separate).
  const recentTitleRows = await db
    .prepare(
      `SELECT digest_title FROM daily_digest
       WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 30`,
    )
    .all<{ digest_title: string | null }>();
  const recentTitles = (recentTitleRows.results ?? [])
    .map((row) => row.digest_title)
    .filter((title): title is string => Boolean(title));
  const recentLeadSignalIds = (leadHistoryRows.results ?? []).map((row) => {
    if (!row.digest_meta) return null;
    const parsed = tryParseJson(row.digest_meta, { onFailure: () => undefined });
    return parsed && typeof parsed === "object" && typeof (parsed as { leadSignalId?: unknown }).leadSignalId === "string"
      ? (parsed as { leadSignalId: string }).leadSignalId
      : null;
  });
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient" });
  if (stablecoinsCacheResult.kind !== "ok") {
    logWorkerEventArgs("handler", "warn",
      `[daily-digest] stablecoins cache unavailable (${stablecoinsCacheResult.reason}), skipping regeneration`,
    );
    return {
      inputData: {
        digestVersion: 2,
        aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
        totalMcapUsd: 0,
        mcap7dDelta: 0,
        degradedSources: [stablecoinsCacheResult.reason],
        activeDepegCount: 0,
        topDepegs: [],
        biggestSupplyChange: null,
        stabilityIndex: null,
        yesterdayIndex: null,
      },
      degradedReasons: [],
      recentMeta,
      previousInputData,
      recentLeadSignalIds,
      lifecycleFlags: [],
      recentTitles,
      stablecoinsCacheReason: stablecoinsCacheResult.reason,
      llmSignals: {
        activeDepegCount: 0,
        topDepegs: [],
        resolvedDepegs: [],
        yieldAnomalies: [],
        liquidityShifts: [],
      },
    };
  }

  const stablecoinAssets = stablecoinsCacheResult.payload.peggedAssets as StablecoinData[];
  const trackedStablecoinAssets = stablecoinAssets.filter((coin) => ACTIVE_IDS.has(coin.id));
  const coreAggregateStablecoinAssets = trackedStablecoinAssets.filter((coin) =>
    CORE_AGGREGATE_ACTIVE_IDS.has(coin.id),
  );
  const stablecoinAssetById = new Map<string, StablecoinData>();
  const mcapById = new Map<string, number>();
  for (const coin of trackedStablecoinAssets) {
    stablecoinAssetById.set(coin.id, coin);
    const raw = getCirculatingRaw(coin);
    if (raw > 0) mcapById.set(coin.id, raw);
  }

  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  let biggestSupplyChange: DigestInputData["biggestSupplyChange"] = null;
  const supplyChanges7d: NonNullable<DigestInputData["supplyChanges7d"]> = [];
  let biggestAbsChange = 0;

  for (const coin of coreAggregateStablecoinAssets) {
    const mcap = getCirculatingRaw(coin);
    const prevWeek = getPrevWeekRaw(coin);
    if (mcap <= 0) continue;
    totalMcapUsd += mcap;
    totalPrevWeek += prevWeek;

    if (mcap > 1_000_000) {
      const change7d = mcap - prevWeek;
      supplyChanges7d.push({ coin: coin.symbol, change7d });
      const absChange = Math.abs(change7d);
      if (absChange > biggestAbsChange) {
        biggestAbsChange = absChange;
        biggestSupplyChange = {
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          changeUsd: change7d,
          currentMcap: mcap,
        };
      }
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = bucketUnixSecondsToUtcDay(nowSec);
  const yesterdayTs = todayTs - SECONDS.ONE_DAY;

  const ctx: CollectorContext = {
    db,
    trackedStablecoinAssets,
    trackedStablecoinIds: ACTIVE_IDS,
    coreAggregateStablecoinAssets,
    coreAggregateStablecoinIds: CORE_AGGREGATE_ACTIVE_IDS,
    stablecoinAssetById,
    mcapById,
    stablecoinsCacheIsFresh:
      stablecoinsCacheResult.updatedAt != null &&
      nowSec - stablecoinsCacheResult.updatedAt <= API_FRESHNESS_MAX_AGE_SEC.stablecoins,
    nowSec,
    todayTs,
    yesterdayTs,
  };

  // Stablecoins prices are quoted as live/current in the digest. Use the same
  // public freshness budget as /api/stablecoins and the depeg resolver; once
  // stale, collectors may still use market-cap context but must not treat the
  // cached price as a current depeg-severity signal.
  const collectorResults: CollectorResult<unknown>[] = [];
  if (!ctx.stablecoinsCacheIsFresh) {
    collectorResults.push(collectorDegraded(undefined, "stablecoins-cache-stale"));
  }

  const activeDepegsResult = await collectActiveDepegs(ctx);
  collectorResults.push(activeDepegsResult);
  const { activeDepegCount, topDepegs, lifecycleFlags } = activeDepegsResult.value;

  const [latestSample, latestDaily, avg24hRow, yesterdayRow] = await Promise.all([
    db
      .prepare("SELECT score, band, components, stored_at FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number; band: string; components: string; stored_at: number }>(),
    db
      .prepare(
        "SELECT score, band, components, computed_at as stored_at FROM stability_index ORDER BY computed_at DESC LIMIT 1",
      )
      .first<{ score: number; band: string; components: string; stored_at: number }>(),
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
      .bind(nowSec - SECONDS.ONE_DAY)
      .first<{ avg: number | null }>(),
    db
      .prepare("SELECT score, band FROM stability_index WHERE computed_at = ?")
      .bind(yesterdayTs)
      .first<{ score: number; band: string }>(),
  ]);
  if (latestSample && nowSec - latestSample.stored_at > 2 * SECONDS.ONE_HOUR) {
    collectorResults.push(collectorDegraded(undefined, "psi-sample-stale"));
  }
  const currentPsiSource = latestSample ?? latestDaily;

  const avg24h = avg24hRow?.avg != null ? round1(avg24hRow.avg) : null;

  const displayPsi = currentPsiSource
    ? getDisplayedPsi({
        score: currentPsiSource.score,
        band: currentPsiSource.band,
        avg24h: avg24h ?? undefined,
        avg24hBand: avg24h != null ? getConditionBand(avg24h) : undefined,
        computedAt: nowSec,
      })
    : null;
  const displayScore = displayPsi?.score ?? null;
  const displayBand = displayPsi?.band ?? null;

  let parsedComponents: { severity: number; breadth: number; stressBreadth?: number; trend: number } | null = null;
  if (currentPsiSource) {
    const parsed = tryParseJson(currentPsiSource.components, {
      context: "daily-digest PSI components",
      onFailure: (failure) => logWorkerEventArgs("handler", "warn", "[daily-digest] Failed to parse PSI components JSON:", failure.message),
    });
    parsedComponents = parsed as typeof parsedComponents;
  }
  const stabilityIndex =
    currentPsiSource && displayScore != null && displayBand && parsedComponents != null
      ? { score: displayScore, band: displayBand, components: parsedComponents }
      : null;

  const yesterdayIndex = yesterdayRow ? { score: yesterdayRow.score, band: yesterdayRow.band } : null;

  const [blacklistActivityResult, supplyVelocityResult] = await Promise.all([
    collectBlacklistActivity(ctx),
    collectSupplyVelocity(ctx),
  ]);
  collectorResults.push(blacklistActivityResult, supplyVelocityResult);
  const blacklistActivity = blacklistActivityResult.value;
  const supplyVelocity = supplyVelocityResult.value;

  const mentionedSymbols = new Set<string>();
  for (const d of topDepegs) mentionedSymbols.add(d.symbol);
  if (biggestSupplyChange) mentionedSymbols.add(biggestSupplyChange.symbol);
  if (supplyVelocity) for (const v of supplyVelocity) mentionedSymbols.add(v.coin);
  const safetyScoresResult = await collectSafetyScores(ctx, mentionedSymbols);
  collectorResults.push(safetyScoresResult);
  const { safetyScores, safetyGrades, safetyIdentity, safetyContext } = safetyScoresResult.value;

  // These eight collectors are independent (no cross-collector inputs) and only
  // issue D1 queries, so run them concurrently. Their results are reduced below
  // in this explicit order so degraded-reason serialization is stable.
  const [
    resolvedDepegsResult,
    mintBurnFlowsResult,
    dewsStressResult,
    psiContributorsResult,
    yieldAnomaliesResult,
    liquidityShiftsResult,
    crossDayTrendsResult,
    totalMcapAthResult,
  ] = await Promise.all([
    collectResolvedDepegs(ctx),
    collectMintBurnFlows(ctx),
    collectDewsStress(ctx),
    collectPsiContributors(ctx),
    collectYieldAnomalies(ctx),
    collectLiquidityShifts(ctx),
    collectCrossDayTrends(ctx),
    collectTotalMcapAth(ctx),
  ]);
  collectorResults.push(
    resolvedDepegsResult,
    mintBurnFlowsResult,
    dewsStressResult,
    psiContributorsResult,
    yieldAnomaliesResult,
    liquidityShiftsResult,
    crossDayTrendsResult,
    totalMcapAthResult,
  );
  const historicalContextResult = await collectHistoricalContext(ctx, displayScore, displayBand, biggestSupplyChange);
  collectorResults.push(historicalContextResult);
  const gradeTransitionsResult = await collectGradeTransitions(ctx, safetyGrades, safetyIdentity);
  collectorResults.push(gradeTransitionsResult);

  const degradedReasons = aggregateCollectorReasons(collectorResults);
  const resolvedDepegs = resolvedDepegsResult.value;
  const mintBurnFlows = mintBurnFlowsResult.value;
  const dewsStress = dewsStressResult.value;
  const psiContributors = psiContributorsResult.value;
  const yieldAnomalies = yieldAnomaliesResult.value;
  const liquidityShifts = liquidityShiftsResult.value;
  const crossDayTrends = crossDayTrendsResult.value;
  const totalMcapAth = totalMcapAthResult.value;
  const historicalContext = historicalContextResult.value;
  const gradeTransitions = gradeTransitionsResult.value;

  const inputData: DigestInputData = {
    digestVersion: 2,
    aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
    totalMcapUsd,
    mcap7dDelta: totalMcapUsd - totalPrevWeek,
    totalMcapAth,
    dataQuality: {
      generatedAt: nowSec,
      stablecoinsCacheUpdatedAt: stablecoinsCacheResult.updatedAt,
      stablecoinsCacheAgeSec: stablecoinsCacheResult.updatedAt
        ? Math.max(0, nowSec - stablecoinsCacheResult.updatedAt)
        : null,
      // Intentional dual-write of degradedReasons (mirrored at top level below):
      // this nested copy feeds the LLM prompt data-quality block (prompt/data-fmt.ts
      // reads quality.degradedSources), while the top-level copy feeds editorial
      // confidence scoring (editorial-candidates.ts reads data.degradedSources).
      // Both are snapshotted from the same array at the same time and must stay in sync.
      ...(degradedReasons.length > 0 ? { degradedSources: [...degradedReasons] } : {}),
      windows: {
        blacklistActivity: {
          label: "rolling last 24h",
          start: nowSec - SECONDS.ONE_DAY,
          end: nowSec,
        },
        mintBurnFlows: {
          label: "rolling last 24h",
          start: nowSec - SECONDS.ONE_DAY,
          end: nowSec,
        },
        supplyVelocity: {
          label: "UTC snapshots: today, yesterday, 7d ago",
          dates: [todayTs, yesterdayTs, todayTs - 7 * SECONDS.ONE_DAY],
        },
        psi: {
          label: latestSample
            ? "latest 30-minute sample with daily snapshot fallback"
            : "latest daily snapshot fallback",
          sampleAt: latestSample?.stored_at ?? null,
          dailySnapshotAt: latestDaily?.stored_at ?? null,
        },
      },
    },
    // Top-level mirror of dataQuality.degradedSources (see comment above): consumed
    // by editorial-candidates.ts for confidence scoring; kept separate so the LLM
    // prompt block and editorial scoring read from their own stable field.
    ...(degradedReasons.length > 0 ? { degradedSources: [...degradedReasons] } : {}),
    safetyContext,
    activeDepegCount,
    topDepegs,
    biggestSupplyChange,
    stabilityIndex,
    yesterdayIndex,
    blacklistActivity,
    supplyVelocity,
    supplyChanges7d,
    safetyScores,
    resolvedDepegs,
    mintBurnFlows,
    dewsStress,
    historicalContext,
    psiContributors,
    gradeTransitions,
    yieldAnomalies,
    liquidityShifts,
    crossDayTrends,
  };
  inputData.causeContext = collectCauseContext(topDepegs, nowSec);
  inputData.standingConditions = buildStandingConditions(topDepegs);
  inputData.editorialCandidates = buildEditorialCandidates(inputData, previousInputData);
  Object.assign(inputData, buildDigestIntelligence(inputData, previousInputData));

  return {
    inputData,
    degradedReasons,
    recentMeta,
    previousInputData,
    recentLeadSignalIds,
    lifecycleFlags,
    recentTitles,
    stablecoinsCacheReason: null,
    llmSignals: {
      activeDepegCount,
      topDepegs,
      resolvedDepegs: resolvedDepegs ?? [],
      yieldAnomalies: yieldAnomalies ?? [],
      liquidityShifts: liquidityShifts ?? [],
    },
  };
}
