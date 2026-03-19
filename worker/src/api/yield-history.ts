import {
  withErrorHandler,
  parseStablecoinHistoryQuery,
  jsonFreshResponse,
  getLatestSuccessfulCronTimestamp,
  errorResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { resolveYieldSourceUrl } from "../lib/yield-source-links";
import { z } from "zod";

interface YieldHistoryRow {
  recorded_at: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
  warning_signals: string | null;
  source_key: string | null;
  yield_source: string | null;
  yield_type: string | null;
  data_source: string | null;
  is_best: number | null;
}

const LEGACY_LUSD_BPROTOCOL_SOURCE_KEY = "bprotocol-lqty-only";

function buildOnChainSourceKey(stablecoinId: string): string {
  return `onchain:${stablecoinId}`;
}

function normalizeHistorySourceKey(
  stablecoinId: string,
  row: YieldHistoryRow,
  mode: "best" | "source",
): string {
  const sourceKey = row.source_key ?? "legacy-best";
  if (
    mode === "best"
    && stablecoinId === "lusd-liquity"
    && row.data_source === "onchain"
    && sourceKey === LEGACY_LUSD_BPROTOCOL_SOURCE_KEY
  ) {
    return buildOnChainSourceKey(stablecoinId);
  }
  return sourceKey;
}

function parseWarningSignals(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return z.array(z.string()).catch([]).parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * GET /api/yield-history?stablecoin=<id>&days=<n>&mode=best&sourceKey=<key>
 * Returns historical yield data points for a given stablecoin.
 *
 * - default mode (`best`) returns the historically selected best source rows
 * - `sourceKey=<key>` returns source-specific history for that key
 */
export const handleYieldHistory = withErrorHandler("yield-history", async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  const parsed = parseStablecoinHistoryQuery(url, {
    defaultDays: 90,
    minDays: 1,
    maxDays: 365,
  });
  if (parsed instanceof Response) {
    return parsed;
  }

  const requestedMode = url.searchParams.get("mode")?.trim() ?? "best";
  const sourceKey = url.searchParams.get("sourceKey")?.trim() ?? null;
  const mode = sourceKey ? "source" : requestedMode;
  if (mode !== "best" && mode !== "source") {
    return errorResponse(400, "Invalid mode: expected 'best' or 'source'");
  }
  if (mode === "source" && !sourceKey) {
    return errorResponse(400, "Missing ?sourceKey= parameter for source history mode");
  }

  const sql = mode === "source"
    ? `SELECT recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ? AND source_key = ?
       ORDER BY recorded_at ASC`
    : `SELECT recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ? AND is_best = 1
       ORDER BY recorded_at ASC`;

  const result = mode === "source"
    ? await db.prepare(sql).bind(parsed.stablecoinId, parsed.cutoff, sourceKey).all<YieldHistoryRow>()
    : await db.prepare(sql).bind(parsed.stablecoinId, parsed.cutoff).all<YieldHistoryRow>();

  let previousSourceKey: string | null = null;
  const history = (result.results ?? []).map((row) => {
    const normalizedSourceKey = normalizeHistorySourceKey(parsed.stablecoinId, row, mode);
    const sourceSwitch =
      mode === "best" &&
      previousSourceKey != null &&
      previousSourceKey !== normalizedSourceKey;
    previousSourceKey = normalizedSourceKey;

    return {
      date: row.recorded_at,
      apy: row.apy,
      apyBase: row.apy_base,
      apyReward: row.apy_reward,
      exchangeRate: row.exchange_rate,
      sourceTvlUsd: row.source_tvl_usd,
      warningSignals: parseWarningSignals(row.warning_signals),
      sourceKey: normalizedSourceKey,
      yieldSource: row.yield_source,
      yieldSourceUrl: resolveYieldSourceUrl({
        stablecoinId: parsed.stablecoinId,
        sourceKey: normalizedSourceKey,
        yieldSource: row.yield_source,
      }),
      yieldType: row.yield_type,
      dataSource: row.data_source,
      isBest: row.is_best === 1,
      sourceSwitch,
    };
  });

  const latestHistoryTimestamp = history.length > 0
    ? Math.max(...history.map((row) => (typeof row.date === "number" ? row.date : 0)))
    : await getLatestSuccessfulCronTimestamp(db, "sync-yield-data", Math.floor(Date.now() / 1000));

  return jsonFreshResponse(history, {
    cacheControl: CACHE_PROFILES.slow,
    updatedAt: latestHistoryTimestamp,
    maxAgeSec: 1800,
  });
});
