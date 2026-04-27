import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import {
  ALERT_SAFETY_SOURCE_CACHE_KEY,
  buildAlertSafetySourceEnvelope,
} from "../lib/alert-safety-source-cache";
import { setCache } from "../lib/db-cache";
import { writeReportCardCache } from "../lib/report-card-cache";
import type { CronResult } from "../lib/cron-logger";
import { FROZEN_IDS } from "@shared/lib/stablecoins";

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

  const writableCards = snapshot.cards.filter((card) => !FROZEN_IDS.has(card.id));
  const { writtenCount } = await writeReportCardCache(db, writableCards, snapshot.updatedAt);
  await setCache(
    db,
    ALERT_SAFETY_SOURCE_CACHE_KEY,
    JSON.stringify(buildAlertSafetySourceEnvelope(
      writableCards,
      snapshot.methodology.version,
      snapshot.updatedAt,
    )),
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
