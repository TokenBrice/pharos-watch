import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { STATUS_RECONCILIATION_THRESHOLDS } from "@shared/lib/status-thresholds";
import { sumPegBuckets } from "@shared/lib/supply";
import type {
  MintBurnReconciliationRow,
  MintBurnReconciliationSummary,
  StatusResponse,
  TelegramBotStats,
} from "@shared/types/status";
import { buildInClause } from "../db";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../stablecoins-cache";

function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function coerceNullableTimestamp(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value: unknown, digits = 2): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

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
    discoveryCandidates: null,
  };
}

export function emptyReserveComposition(): StatusResponse["reserveComposition"] {
  return {
    configuredCoins: 0,
    freshCoins: 0,
    staleCoins: 0,
    missingCoins: 0,
    degradedCoins: 0,
    errorCoins: 0,
    corruptCoins: 0,
    independentFreshEligible: 0,
    independentFreshUnverified: 0,
    staticValidatedFresh: 0,
    weakProbeFresh: 0,
    writeTimeoutUncertain: 0,
    lastSuccessAt: null,
    oldestFreshAgeSec: null,
  };
}

interface TelegramBotAggregateRow {
  total_chats: number | string | null;
  alert_enabled_chats: number | string | null;
  deliverable_chats: number | string | null;
  subscribed_chats: number | string | null;
  empty_alert_chats: number | string | null;
  muted_chats_with_subscriptions: number | string | null;
  dews_chats: number | string | null;
  depeg_chats: number | string | null;
  safety_chats: number | string | null;
  all_types_chats: number | string | null;
  total_subscriptions: number | string | null;
  avg_subscriptions_per_subscribed_chat: number | string | null;
  last_subscriber_activity_at: number | string | null;
  custom_preference_chats: number | string | null;
  quiet_hours_enabled_chats: number | string | null;
}

interface TelegramBotPendingRow {
  pending_count: number | string | null;
}

interface TelegramBotTopStablecoinRow {
  stablecoin_id: string;
  subscribers: number | string | null;
}

export async function getTelegramBotStats(db: D1Database, now: number): Promise<TelegramBotStats | null> {
  const [aggregate, pending, pendingDeliveries, topCoins] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total_chats,
           SUM(
             CASE
               WHEN COALESCE(sub.active_sub_count, 0) > 0
                 OR s.global_alert_dews = 1
                 OR s.global_alert_depeg = 1
                 OR s.global_alert_safety = 1
                 OR s.alert_dews = 1
                 OR s.alert_depeg = 1
                 OR s.alert_safety = 1
               THEN 1 ELSE 0
             END
           ) AS alert_enabled_chats,
           SUM(
             CASE
               WHEN COALESCE(sub.active_sub_count, 0) > 0
                 OR s.global_alert_dews = 1
                 OR s.global_alert_depeg = 1
                 OR s.global_alert_safety = 1
               THEN 1 ELSE 0
             END
           ) AS deliverable_chats,
           SUM(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN 1 ELSE 0 END) AS subscribed_chats,
           SUM(
             CASE
               WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1)
                 AND s.global_alert_dews = 0
                 AND s.global_alert_depeg = 0
                 AND s.global_alert_safety = 0
                 AND COALESCE(sub.sub_count, 0) = 0
               THEN 1 ELSE 0
             END
           ) AS empty_alert_chats,
           SUM(
             CASE
               WHEN COALESCE(sub.sub_count, 0) > 0 AND COALESCE(sub.active_sub_count, 0) = 0
               THEN 1 ELSE 0
             END
           ) AS muted_chats_with_subscriptions,
           SUM(CASE WHEN COALESCE(sub.dews_enabled, 0) = 1 OR s.global_alert_dews = 1 THEN 1 ELSE 0 END) AS dews_chats,
           SUM(CASE WHEN COALESCE(sub.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_chats,
           SUM(CASE WHEN COALESCE(sub.safety_enabled, 0) = 1 OR s.global_alert_safety = 1 THEN 1 ELSE 0 END) AS safety_chats,
           SUM(
             CASE
               WHEN (COALESCE(sub.dews_enabled, 0) = 1 OR s.global_alert_dews = 1)
                AND (COALESCE(sub.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1)
                AND (COALESCE(sub.safety_enabled, 0) = 1 OR s.global_alert_safety = 1)
               THEN 1 ELSE 0
             END
           ) AS all_types_chats,
           SUM(COALESCE(sub.sub_count, 0)) AS total_subscriptions,
           AVG(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN sub.sub_count END) AS avg_subscriptions_per_subscribed_chat,
           MAX(s.last_active_at) AS last_subscriber_activity_at,
           SUM(CASE WHEN COALESCE(sub.custom_preferences, 0) = 1 THEN 1 ELSE 0 END) AS custom_preference_chats,
           SUM(CASE WHEN COALESCE(s.quiet_hours_enabled, 0) = 1 THEN 1 ELSE 0 END) AS quiet_hours_enabled_chats
         FROM telegram_subscribers s
         LEFT JOIN (
           SELECT chat_id,
                  COUNT(*) AS sub_count,
                  SUM(CASE WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 THEN 1 ELSE 0 END) AS active_sub_count,
                  MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
                  MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
                  MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled,
                  MAX(
                    CASE
                      WHEN alert_dews = 0
                        OR alert_depeg = 0
                        OR alert_safety = 0
                        OR dews_min_band IS NOT NULL
                        OR safety_mode IS NOT NULL
                        OR depeg_worsening_bps_step IS NOT NULL
                      THEN 1 ELSE 0
                    END
                  ) AS custom_preferences
             FROM telegram_subscriptions
            GROUP BY chat_id
         ) sub ON sub.chat_id = s.chat_id`,
      )
      .first<TelegramBotAggregateRow>(),
    db
      .prepare("SELECT COUNT(*) AS pending_count FROM telegram_pending_disambiguation WHERE expires_at > ?")
      .bind(now)
      .first<TelegramBotPendingRow>(),
    db.prepare("SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts").first<TelegramBotPendingRow>(),
    db
      .prepare(
        `SELECT stablecoin_id, COUNT(*) AS subscribers
           FROM telegram_subscriptions
          GROUP BY stablecoin_id
          ORDER BY subscribers DESC, stablecoin_id ASC
          LIMIT 5`,
      )
      .all<TelegramBotTopStablecoinRow>()
      .then((result) => result.results ?? []),
  ]);

  return {
    totalChats: coerceCount(aggregate?.total_chats),
    alertEnabledChats: coerceCount(aggregate?.alert_enabled_chats),
    deliverableChats: coerceCount(aggregate?.deliverable_chats),
    subscribedChats: coerceCount(aggregate?.subscribed_chats),
    emptyAlertChats: coerceCount(aggregate?.empty_alert_chats),
    mutedChatsWithSubscriptions: coerceCount(aggregate?.muted_chats_with_subscriptions),
    totalSubscriptions: coerceCount(aggregate?.total_subscriptions),
    avgSubscriptionsPerSubscribedChat: roundMetric(aggregate?.avg_subscriptions_per_subscribed_chat, 1),
    pendingDisambiguations: coerceCount(pending?.pending_count),
    pendingDeliveries: coerceCount(pendingDeliveries?.pending_count),
    lastSubscriberActivityAt: coerceNullableTimestamp(aggregate?.last_subscriber_activity_at),
    customPreferenceChats: coerceCount(aggregate?.custom_preference_chats),
    quietHoursEnabledChats: coerceCount(aggregate?.quiet_hours_enabled_chats),
    alertTypeChats: {
      dews: coerceCount(aggregate?.dews_chats),
      depeg: coerceCount(aggregate?.depeg_chats),
      safety: coerceCount(aggregate?.safety_chats),
      allTypes: coerceCount(aggregate?.all_types_chats),
    },
    topStablecoins: topCoins.map((row) => ({
      stablecoinId: row.stablecoin_id,
      symbol: TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
      subscribers: coerceCount(row.subscribers),
    })),
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
    };

const DATASET_FRESHNESS_TARGETS: Record<keyof StatusResponse["datasetFreshness"], DatasetFreshnessTarget> = {
  stablecoins: { type: "table", table: "cache", column: "updated_at", where: "key = 'stablecoins'" },
  blacklist: { type: "cron", jobs: ["sync-blacklist"] },
  mintBurn: { type: "cron", jobs: ["sync-mint-burn", "sync-mint-burn-extended"] },
  supply: { type: "table", table: "supply_history", column: "snapshot_date" },
  safetyGrades: { type: "table", table: "safety_grade_history", column: "recorded_at" },
  yield: { type: "table", table: "yield_data", column: "updated_at" },
  depegs: { type: "cron", jobs: ["sync-stablecoins"] },
  dews: { type: "table", table: "stress_signals", column: "computed_at" },
  digest: { type: "table", table: "daily_digest", column: "generated_at" },
  discoveryCandidates: { type: "cron", jobs: ["sync-stablecoins", "discovery-scan"] },
};

const TABLE_TARGETS = Object.values(DATASET_FRESHNESS_TARGETS).filter(
  (t): t is Extract<DatasetFreshnessTarget, { type: "table" }> => t.type === "table",
);
const ALLOWED_DATASET_TABLES = new Set(TABLE_TARGETS.map((t) => t.table));
const ALLOWED_DATASET_COLUMNS = new Set(TABLE_TARGETS.map((t) => t.column));
const ALLOWED_DATASET_WHERE_CLAUSES = new Set(
  TABLE_TARGETS.map((t) => t.where).filter(Boolean),
);

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
    console.error(`[status] Failed dataset freshness query for ${target.table}:`, err);
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
    console.error(`[status] Failed dataset freshness query for cron jobs ${jobs.join(", ")}:`, err);
    return null;
  }
}

async function getLastUpdate(db: D1Database, target: DatasetFreshnessTarget): Promise<number | null> {
  if (target.type === "cron") {
    return getLastSuccessfulCronRun(db, target.jobs);
  }
  return getLastTableUpdate(db, target);
}

export async function getDatasetFreshness(db: D1Database): Promise<StatusResponse["datasetFreshness"]> {
  const [stablecoins, blacklist, mintBurn, supply, safetyGrades, yieldTs, depegs, dews, digest, discoveryCandidates] =
    await Promise.all([
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.stablecoins),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.blacklist),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.mintBurn),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.supply),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.safetyGrades),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.yield),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.depegs),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.dews),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.digest),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.discoveryCandidates),
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
    discoveryCandidates,
  };
}

export async function getMintBurnReconciliation(
  db: D1Database,
  now: number,
): Promise<MintBurnReconciliationSummary | null> {
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (!hasUsableStablecoinsPayload(stablecoinsCacheResult)) {
    return null;
  }

  const trackedIds = new Set(
    MINT_BURN_CONFIGS.filter((config) => config.chain.chainId === "ethereum").map((config) => config.stablecoinId),
  );
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

  const [flowRows, firstSeenRows] = await Promise.all([
    db
      .prepare(
        `SELECT stablecoin_id, SUM(net_flow_usd) as net_flow_usd
         FROM mint_burn_hourly
         WHERE chain_id = ? AND hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind("ethereum", now - 24 * 3600)
      .all<{ stablecoin_id: string; net_flow_usd: number }>(),
    db
      .prepare(
        `SELECT stablecoin_id, MIN(hour_ts) as first_hour_ts
         FROM mint_burn_hourly
         WHERE chain_id = ?
         GROUP BY stablecoin_id`,
      )
      .bind("ethereum")
      .all<{ stablecoin_id: string; first_hour_ts: number | null }>(),
  ]);

  const flowMap = new Map((flowRows.results ?? []).map((row) => [row.stablecoin_id, row.net_flow_usd]));
  const firstSeenMap = new Map(
    (firstSeenRows.results ?? []).map((row) => [row.stablecoin_id, row.first_hour_ts ?? null]),
  );

  const rows = assets
    .map<MintBurnReconciliationRow>((asset) => {
      const ethereumSupply = asset.chainCirculating?.ethereum;
      const flowNet24hUsd = flowMap.get(asset.id) ?? 0;
      const historyStartAt = firstSeenMap.get(asset.id) ?? null;
      const coverageStatus: MintBurnReconciliationRow["coverageStatus"] =
        historyStartAt == null
          ? "unknown"
          : historyStartAt > now - 24 * 3600
            ? "bootstrapping"
            : historyStartAt > now - 30 * 24 * 3600
              ? "partial-history"
              : "full";

      const current = ethereumSupply?.current;
      const prevDay = ethereumSupply?.circulatingPrevDay;
      if (
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
        absoluteDiffUsd >= STATUS_RECONCILIATION_THRESHOLDS.criticalAbsoluteUsd || diffRatio >= STATUS_RECONCILIATION_THRESHOLDS.criticalRatio
          ? "critical"
          : absoluteDiffUsd >= STATUS_RECONCILIATION_THRESHOLDS.warnAbsoluteUsd || diffRatio >= STATUS_RECONCILIATION_THRESHOLDS.warnRatio
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
