import { D1_BATCH_SIZE, USER_AGENT } from "../lib/constants";
import { batchExecute } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { YIELD_POOL_MAP } from "./yield-config";

const DL_CHART_BASE = "https://yields.llama.fi/chart";
const MAX_BACKFILL_DAYS = 365;

interface DlChartPoint {
  timestamp: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  il7d: number | null;
  apyBase7d: number | null;
}

interface BackfillRow {
  stablecoin_id: string;
  source_key: string;
  recorded_at: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  source_tvl_usd: number | null;
  data_source: string;
  is_best: number;
  warning_signals: string;
}

export function buildBackfillRows(
  stablecoinId: string,
  sourceKey: string,
  dlData: DlChartPoint[],
): BackfillRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - MAX_BACKFILL_DAYS * 86400;
  return dlData
    .map((point) => {
      const recordedAt = Math.floor(new Date(point.timestamp).getTime() / 1000);
      if (recordedAt < cutoff) return null;
      if (typeof point.apy !== "number" || !Number.isFinite(point.apy)) return null;
      return {
        stablecoin_id: stablecoinId,
        source_key: sourceKey,
        recorded_at: recordedAt,
        apy: point.apy,
        apy_base: point.apyBase,
        apy_reward: point.apyReward,
        source_tvl_usd: point.tvlUsd as number | null,
        data_source: "defillama-backfill",
        is_best: 1,
        warning_signals: "[]",
      } satisfies BackfillRow;
    })
    .filter((row): row is BackfillRow => row != null);
}

/** Backfill yield history from DeFiLlama chart data. Wire to an admin endpoint when needed. */
async function _backfillYieldHistory(
  db: D1Database,
  stablecoinId: string,
  signal?: AbortSignal,
): Promise<{ inserted: number; skipped: number }> {
  const poolUuid = YIELD_POOL_MAP[stablecoinId];
  if (!poolUuid) return { inserted: 0, skipped: 0 };

  const res = await fetchWithRetry(
    `${DL_CHART_BASE}/${poolUuid}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
    1,
  );
  if (!res?.ok) return { inserted: 0, skipped: 0 };

  const body = (await res.json()) as { status: string; data?: DlChartPoint[] };
  if (body.status !== "success" || !Array.isArray(body.data)) return { inserted: 0, skipped: 0 };

  const rows = buildBackfillRows(stablecoinId, poolUuid, body.data);
  if (rows.length === 0) return { inserted: 0, skipped: body.data.length };

  const stmts = rows.map((row) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO yield_history
         (stablecoin_id, source_key, recorded_at, apy, apy_base, apy_reward, source_tvl_usd, data_source, is_best, warning_signals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.stablecoin_id,
        row.source_key,
        row.recorded_at,
        row.apy,
        row.apy_base,
        row.apy_reward,
        row.source_tvl_usd,
        row.data_source,
        row.is_best,
        row.warning_signals,
      ),
  );
  await batchExecute(db, stmts, D1_BATCH_SIZE);
  return { inserted: rows.length, skipped: body.data.length - rows.length };
}
