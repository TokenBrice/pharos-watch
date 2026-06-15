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
