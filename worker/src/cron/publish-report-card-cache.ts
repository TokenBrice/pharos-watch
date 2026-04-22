import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import {
  ALERT_SAFETY_SOURCE_CACHE_KEY,
  buildAlertSafetySourceSnapshot,
} from "../lib/alert-safety-source-cache";
import { setCache } from "../lib/db-cache";
import { writeReportCardCache } from "../lib/report-card-cache";
import type { CronResult } from "../lib/cron-logger";

export async function publishReportCardCache(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("publish-report-card-cache aborted");
  }

  const snapshot = await buildReportCardsSnapshot(db);

  if (signal?.aborted) {
    throw signal.reason ?? new Error("publish-report-card-cache aborted");
  }

  const { writtenCount } = await writeReportCardCache(db, snapshot.cards, snapshot.updatedAt);
  await setCache(
    db,
    ALERT_SAFETY_SOURCE_CACHE_KEY,
    JSON.stringify(buildAlertSafetySourceSnapshot(snapshot.cards, snapshot.methodology.version)),
  );

  return {
    itemCount: writtenCount,
    metadata: JSON.stringify({
      updatedAt: snapshot.updatedAt,
      liquidityStale: snapshot.liquidityStale,
      redemptionStale: snapshot.redemptionStale,
    }),
  };
}
