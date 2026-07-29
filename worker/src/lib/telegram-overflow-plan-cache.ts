import { isRecord } from "@shared/lib/type-guards";
import { getCache, setCache } from "./db-cache";
import { parseJsonObject } from "./json-parse";

const OVERFLOW_PLAN_CACHE_KEY = "telegram:dispatch-overflow-plan";
const OVERFLOW_PLAN_CACHE_VERSION = 1;

export async function pruneOverflowPlanBacklogForChat(
  db: D1Database,
  chatId: string,
  nowSec: number,
): Promise<void> {
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
    await setCache(
      db,
      OVERFLOW_PLAN_CACHE_KEY,
      JSON.stringify({
        version: OVERFLOW_PLAN_CACHE_VERSION,
        writtenAt: nowSec,
        plans: remainingPlans,
      }),
    );
  } catch {
    return;
  }
}
