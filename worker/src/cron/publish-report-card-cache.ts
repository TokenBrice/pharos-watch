import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
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

  return {
    itemCount: writtenCount,
    metadata: JSON.stringify({
      updatedAt: snapshot.updatedAt,
      liquidityStale: snapshot.liquidityStale,
      redemptionStale: snapshot.redemptionStale,
    }),
  };
}

