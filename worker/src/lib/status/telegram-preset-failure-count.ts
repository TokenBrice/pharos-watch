import { getCache } from "../db-cache";

export const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";

export async function loadPresetQueryFailureCount(db: D1Database): Promise<number> {
  const cached = await getCache(db, PRESET_QUERY_FAILURE_CACHE_KEY);
  if (!cached) return 0;
  const parsed = Number(cached.value);
  if (!/^\d+$/.test(cached.value) || !Number.isSafeInteger(parsed)) {
    throw new Error("telegram_preset_query_failure_count_invalid");
  }
  return parsed;
}
