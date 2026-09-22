import { isRecord } from "@shared/lib/type-guards";
import { getCache } from "../db-cache";
import { parseJsonObject } from "../json-parse";

const OVERFLOW_PLAN_CACHE_KEY = "telegram:dispatch-overflow-plan";
const OVERFLOW_PLAN_CACHE_VERSION = 1;
const OVERFLOW_PLAN_PRUNE_MAX_ATTEMPTS = 3;

export async function pruneOverflowPlanBacklogForChat(
  db: D1Database,
  chatId: string,
  nowSec: number,
): Promise<void> {
  for (let attempt = 0; attempt < OVERFLOW_PLAN_PRUNE_MAX_ATTEMPTS; attempt += 1) {
    const cached = await getCache(db, OVERFLOW_PLAN_CACHE_KEY);
    if (!cached) return;
    try {
      const parsed = parseJsonObject(cached.value, { onFailure: () => undefined });
      if (!parsed || parsed.version !== OVERFLOW_PLAN_CACHE_VERSION || !Array.isArray(parsed.plans)) {
        return;
      }
      const remainingPlans = parsed.plans.filter((plan) =>
        isRecord(plan) && typeof plan.chatId === "string" && plan.chatId !== chatId
      );
      if (remainingPlans.length === parsed.plans.length) return;
      const nextValue = JSON.stringify({
        version: OVERFLOW_PLAN_CACHE_VERSION,
        writtenAt: nowSec,
        plans: remainingPlans,
      });
      const result = await db
        .prepare(
          `UPDATE cache
              SET value = ?, updated_at = ?
            WHERE key = ? AND updated_at = ? AND value = ?`,
        )
        .bind(nextValue, nowSec, OVERFLOW_PLAN_CACHE_KEY, cached.updatedAt, cached.value)
        .run();
      if ((result.meta.changes ?? 0) > 0) return;
    } catch {
      return;
    }
  }
}
