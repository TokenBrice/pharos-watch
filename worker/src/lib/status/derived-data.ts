import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { STATUS_RECONCILIATION_THRESHOLDS } from "@shared/lib/status-thresholds";
import { sumPegBuckets } from "@shared/lib/supply";
import type { MintBurnReconciliationRow, MintBurnReconciliationSummary, StatusResponse } from "@shared/types/status";
import { buildInClause } from "../db";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
  type StablecoinsCacheLoadResult,
} from "../stablecoins-cache";
import { emptyReserveCompositionOverview } from "../live-reserves-store";
import { logWorkerEvent } from "../structured-log";
import { loadMintBurnFirstHourRows } from "../mint-burn-hourly-queries";
import { readDewsPublishedGenerationResult } from "../dews-publication-pointer";
import { loadReportCardCache } from "../report-card-cache";
import { isCurrentSafetyScoreV8Identity } from "../safety-score-current-identity";
import { loadActiveSafetyScoreSource } from "../safety-score-active-source";

export function emptyDatasetFreshness(): StatusResponse["datasetFreshness"] {
  return {
    stablecoins: null,
    blacklist: null,
    mintBurn: null,
    supply: null,
    safetyGrades: null,
    yield: null,
    depegs: null,
    dews: null,
    digest: null,
  };
}

export function emptyReserveComposition(): StatusResponse["reserveComposition"] {
  return {
    ...emptyReserveCompositionOverview(),
    status: "healthy",
    freshCoverageRatio: 0,
    authoritativeFreshCoverageRatio: 0,
  };
}

type DatasetFreshnessTarget =
  | {
      type: "table";
      table: string;
      column: string;
      where?: string;
    }
  | {
      type: "cron";
      jobs: readonly string[];
    }
  | {
      type: "dews-publication";
    }
  | {
      type: "report-card-publication";
    };

const DATASET_FRESHNESS_TARGETS: Record<keyof StatusResponse["datasetFreshness"], DatasetFreshnessTarget> = {
  stablecoins: { type: "table", table: "cache", column: "updated_at", where: "key = 'stablecoins'" },
  blacklist: { type: "cron", jobs: ["sync-blacklist"] },
  mintBurn: { type: "cron", jobs: ["sync-mint-burn", "sync-mint-burn-extended"] },
  supply: { type: "table", table: "supply_history", column: "snapshot_date" },
  safetyGrades: { type: "report-card-publication" },
  yield: {
    type: "table",
    table: "yield_data",
    column: "updated_at",
    where: "is_best = 1 AND (publication_generation_id IS NULL OR publication_state = 'published')",
  },
  depegs: { type: "cron", jobs: ["sync-stablecoins"] },
  dews: { type: "dews-publication" },
  digest: { type: "table", table: "daily_digest", column: "generated_at" },
};

const TABLE_TARGETS = Object.values(DATASET_FRESHNESS_TARGETS).filter(
  (t): t is Extract<DatasetFreshnessTarget, { type: "table" }> => t.type === "table",
);
const ALLOWED_DATASET_TABLES = new Set(TABLE_TARGETS.map((t) => t.table));
const ALLOWED_DATASET_COLUMNS = new Set(TABLE_TARGETS.map((t) => t.column));
const ALLOWED_DATASET_WHERE_CLAUSES = new Set(TABLE_TARGETS.map((t) => t.where).filter(Boolean));

async function getLastTableUpdate(
  db: D1Database,
  target: Extract<DatasetFreshnessTarget, { type: "table" }>,
): Promise<number | null> {
  if (!ALLOWED_DATASET_TABLES.has(target.table)) {
    throw new Error(`Invalid dataset table: ${target.table}`);
  }
  if (!ALLOWED_DATASET_COLUMNS.has(target.column)) {
    throw new Error(`Invalid dataset column: ${target.column}`);
  }
  if (target.where && !ALLOWED_DATASET_WHERE_CLAUSES.has(target.where)) {
    throw new Error(`Invalid dataset where clause: ${target.where}`);
  }
  const where = target.where ? ` WHERE ${target.where}` : "";
  try {
    const row = await db
      .prepare(`SELECT MAX(${target.column}) as latest FROM ${target.table}${where}`)
      .first<{ latest: number | null }>();
    return row?.latest ?? null;
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "dataset_table_freshness_query_failed",
      route: "status",
      source: target.table,
      message: "Failed dataset freshness query",
      error: err,
      metadata: { column: target.column },
    });
    return null;
  }
}

async function getLastSuccessfulCronRun(db: D1Database, jobs: readonly string[]): Promise<number | null> {
  try {
    const jobInClause = buildInClause(jobs);
    const successStatuses = buildInClause(["ok", "degraded"]);
    const row = await db
      .prepare(
        `SELECT MAX(started_at) as latest
         FROM cron_runs
         WHERE job IN (${jobInClause.sql})
           AND status IN (${successStatuses.sql})`,
      )
      .bind(...jobInClause.binds, ...successStatuses.binds)
      .first<{ latest: number | null }>();
    return row?.latest ?? null;
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "dataset_cron_freshness_query_failed",
      route: "status",
      message: "Failed dataset freshness query for cron jobs",
      error: err,
      metadata: { jobs },
    });
    return null;
  }
}

async function getLastUpdate(db: D1Database, target: DatasetFreshnessTarget, now: number): Promise<number | null> {
  if (target.type === "cron") {
    return getLastSuccessfulCronRun(db, target.jobs);
  }
  if (target.type === "dews-publication") {
    const published = await readDewsPublishedGenerationResult(db, now);
    if (published.status === "ok") return published.computedAt;
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "dews_publication_freshness_unavailable",
      route: "status",
      source: "dews:published-generation",
      message: "Failed to validate the DEWS published generation for dataset freshness",
      metadata: { status: published.status },
    });
    return null;
  }
  if (target.type === "report-card-publication") {
    let active;
    try {
      active = await loadActiveSafetyScoreSource(db);
    } catch (err) {
      logWorkerEvent({
        scope: "status",
        level: "error",
        event: "report_card_publication_freshness_read_failed",
        route: "status",
        source: "safety_score_active_source",
        message: "Failed to resolve the expected active Safety Score source for dataset freshness",
        error: err,
      });
      return null;
    }
    if (active.kind === "v9") return active.snapshot.updatedAt;
    if (active.kind === "error") {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "report_card_publication_freshness_unavailable",
        route: "status",
        source: "safety_score_active_source",
        message: "Failed to validate the expected active V9 report-card publication for dataset freshness",
        metadata: {
          reason: active.reason,
          expectedModel: active.expectedModel,
          activationUpdatedAt: active.activationUpdatedAt,
        },
      });
      return null;
    }

    let published: Awaited<ReturnType<typeof loadReportCardCache>>;
    try {
      published = await loadReportCardCache(db, { requireCompleteness: true });
    } catch (err) {
      logWorkerEvent({
        scope: "status",
        level: "error",
        event: "report_card_publication_freshness_read_failed",
        route: "status",
        source: "report_card_cache",
        message: "Failed to read report-card cache for dataset freshness",
        error: err,
      });
      return null;
    }
    if (published.kind === "ok" && isCurrentSafetyScoreV8Identity(published.payload.safetyScoreIdentity)) {
      return published.updatedAt;
    }
    const reason = published.kind === "ok" ? "identity-mismatch" : published.reason;
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "report_card_publication_freshness_unavailable",
      route: "status",
      source: "report_card_cache",
      message: "Failed to validate the complete identified report-card publication for dataset freshness",
      metadata: { reason, updatedAt: published.updatedAt },
    });
    return null;
  }
  return getLastTableUpdate(db, target);
}

export async function getDatasetFreshness(db: D1Database): Promise<StatusResponse["datasetFreshness"]> {
  const now = Math.floor(Date.now() / 1000);
  const [stablecoins, blacklist, mintBurn, supply, safetyGrades, yieldTs, depegs, dews, digest] =
    await Promise.all([
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.stablecoins, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.blacklist, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.mintBurn, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.supply, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.safetyGrades, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.yield, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.depegs, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.dews, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.digest, now),
    ]);

  return {
    stablecoins,
    blacklist,
    mintBurn,
    supply,
    safetyGrades,
    yield: yieldTs,
    depegs,
    dews,
    digest,
  };
}

export async function getMintBurnReconciliation(
  db: D1Database,
  now: number,
  preloadedCache?: StablecoinsCacheLoadResult,
): Promise<MintBurnReconciliationSummary | null> {
  const stablecoinsCacheResult =
    preloadedCache ?? (await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true }));
  if (!hasUsableStablecoinsPayload(stablecoinsCacheResult)) {
    return null;
  }

  const configChainsByStablecoin = new Map<string, Set<string>>();
  for (const config of MINT_BURN_CONFIGS) {
    const chains = configChainsByStablecoin.get(config.stablecoinId) ?? new Set<string>();
    chains.add(config.chain.chainId);
    configChainsByStablecoin.set(config.stablecoinId, chains);
  }
  const trackedIds = new Set(configChainsByStablecoin.keys());
  const assets = (
    stablecoinsCacheResult.payload.peggedAssets as Array<{
      id: string;
      symbol: string;
      circulating?: Record<string, number>;
      chainCirculating?: Record<
        string,
        {
          current?: number;
          circulatingPrevDay?: number;
        }
      >;
    }>
  ).filter((asset) => trackedIds.has(asset.id));

  let flowRows: D1Result<{ stablecoin_id: string; chain_id: string; net_flow_usd: number }>;
  let firstSeenRows: Array<{ stablecoin_id: string; chain_id: string; first_hour_ts: number }>;
  try {
    [flowRows, firstSeenRows] = await Promise.all([
      db
        .prepare(
          `SELECT /* pharos:status-derived:mint-burn-24h */
             stablecoin_id, chain_id, SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(now - 24 * 3600)
        .all<{ stablecoin_id: string; chain_id: string; net_flow_usd: number }>(),
      loadMintBurnFirstHourRows(
        db,
        MINT_BURN_CONFIGS.map((config) => ({
          stablecoinId: config.stablecoinId,
          chainId: config.chain.chainId,
        })),
        "status",
      ),
    ]);
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "mint_burn_reconciliation_query_failed",
      route: "status",
      source: "mint_burn_hourly",
      message: "Failed mint-burn reconciliation query",
      error: err,
    });
    // Rethrow so the call site surfaces sectionErrors.mintBurnReconciliation,
    // keeping a transient D1 failure distinguishable from the legitimate
    // bootstrap case where no mint-burn data exists yet (returns rows: []).
    throw err;
  }

  const flowMap = new Map(
    (flowRows.results ?? []).map((row) => [`${row.stablecoin_id}|${row.chain_id}`, row.net_flow_usd]),
  );
  const firstSeenMap = new Map(firstSeenRows.map((row) => [`${row.stablecoin_id}|${row.chain_id}`, row.first_hour_ts]));

  const rows = assets
    .map<MintBurnReconciliationRow>((asset) => {
      const canonicalChains = configChainsByStablecoin.get(asset.id) ?? new Set<string>();
      const canonicalChainId = canonicalChains.size === 1 ? [...canonicalChains][0]! : null;
      const flowNet24hUsd = canonicalChainId ? (flowMap.get(`${asset.id}|${canonicalChainId}`) ?? 0) : 0;
      const historyStartAt = canonicalChainId ? (firstSeenMap.get(`${asset.id}|${canonicalChainId}`) ?? null) : null;
      const coverageStatus: MintBurnReconciliationRow["coverageStatus"] =
        historyStartAt == null
          ? "unknown"
          : historyStartAt > now - 24 * 3600
            ? "bootstrapping"
            : historyStartAt > now - 30 * 24 * 3600
              ? "partial-history"
              : "full";

      const chainSupply = canonicalChainId ? asset.chainCirculating?.[canonicalChainId] : undefined;
      const current = chainSupply?.current;
      const prevDay = chainSupply?.circulatingPrevDay;
      if (
        canonicalChainId == null ||
        typeof current !== "number" ||
        !Number.isFinite(current) ||
        typeof prevDay !== "number" ||
        !Number.isFinite(prevDay)
      ) {
        return {
          stablecoinId: asset.id,
          symbol: TRACKED_META_BY_ID.get(asset.id)?.symbol ?? asset.symbol,
          flowNet24hUsd,
          chainSupplyDelta24hUsd: null,
          absoluteDiffUsd: null,
          diffRatio: null,
          status: "insufficient-source",
          coverageStatus,
        };
      }

      const chainSupplyDelta24hUsd = current - prevDay;
      const absoluteDiffUsd = Math.abs(flowNet24hUsd - chainSupplyDelta24hUsd);
      const denominator = Math.max(
        Math.abs(chainSupplyDelta24hUsd),
        Math.abs(flowNet24hUsd),
        Math.max(sumPegBuckets(asset.circulating), 1) * 0.005,
      );
      const diffRatio = denominator > 0 ? absoluteDiffUsd / denominator : 0;
      const status: MintBurnReconciliationRow["status"] =
        absoluteDiffUsd >= STATUS_RECONCILIATION_THRESHOLDS.criticalAbsoluteUsd ||
        diffRatio >= STATUS_RECONCILIATION_THRESHOLDS.criticalRatio
          ? "critical"
          : absoluteDiffUsd >= STATUS_RECONCILIATION_THRESHOLDS.warnAbsoluteUsd ||
              diffRatio >= STATUS_RECONCILIATION_THRESHOLDS.warnRatio
            ? "warn"
            : "ok";

      return {
        stablecoinId: asset.id,
        symbol: TRACKED_META_BY_ID.get(asset.id)?.symbol ?? asset.symbol,
        flowNet24hUsd,
        chainSupplyDelta24hUsd,
        absoluteDiffUsd,
        diffRatio,
        status,
        coverageStatus,
      };
    })
    .sort((a, b) => {
      const severityOrder: Record<MintBurnReconciliationRow["status"], number> = {
        critical: 0,
        warn: 1,
        "insufficient-source": 2,
        ok: 3,
      };
      return severityOrder[a.status] - severityOrder[b.status];
    });

  return {
    checkedAt: now,
    comparedCoins: rows.filter((row) => row.status !== "insufficient-source").length,
    criticalCount: rows.filter((row) => row.status === "critical").length,
    warnCount: rows.filter((row) => row.status === "warn").length,
    insufficientCount: rows.filter((row) => row.status === "insufficient-source").length,
    rows,
  };
}
