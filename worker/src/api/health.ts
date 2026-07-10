import {
  withErrorHandler,
  jsonResponse,
} from "../lib/api-utils";
import type { HealthResponse, TelegramHealthSummary } from "@shared/types/status";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import { assessPublicHealth } from "../lib/public-health-assessment";
import { CACHE_PROFILES } from "../lib/constants";
import { logWorkerEvent } from "../lib/structured-log";

export const handleHealth = withErrorHandler("health", async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const assessment = await assessPublicHealth(db, now, { logPrefix: "health" });

  // Lightweight telegram summary — silently null if tables are not migrated
  let telegramSummary: TelegramHealthSummary | null = null;
  if (assessment.dbHealthy) {
    try {
      const [chatCount, pendingCount, lastDispatch] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS n FROM telegram_subscribers").first<{ n: number }>(),
        db.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").first<{ n: number }>(),
        db
          .prepare(
            "SELECT started_at, status, metadata FROM cron_runs WHERE job = 'dispatch-telegram-alerts' ORDER BY started_at DESC LIMIT 1",
          )
          .first<{ started_at: number; status: string; metadata: string | null }>(),
      ]);
      let dispatchMeta = null;
      if (lastDispatch?.metadata) {
        try {
          dispatchMeta = parseTelegramDispatchCronMetadata(JSON.parse(lastDispatch.metadata));
        } catch (error) {
          logWorkerEvent({
            scope: "status",
            level: "warn",
            event: "telegram_dispatch_metadata_unavailable",
            route: "health",
            message: "Telegram dispatch metadata unavailable",
            error,
          });
        }
      }
      telegramSummary = {
        totalChats: chatCount?.n ?? 0,
        pendingDeliveries: pendingCount?.n ?? 0,
        lastDispatchAt: lastDispatch?.started_at ?? null,
        lastDispatchStatus: lastDispatch?.status ?? null,
        safetyAlertSourceState: dispatchMeta?.safetyAlertSourceState ?? null,
        safetyAlertSourceAgeSeconds: dispatchMeta?.safetyAlertSourceAgeSeconds ?? null,
        safetyAlertsSuppressed: dispatchMeta?.safetyAlertsSuppressed ?? false,
        safetyAlertSourceGeneration: dispatchMeta?.safetyAlertSourceGeneration ?? null,
      };
      if (dispatchMeta?.safetyAlertsSuppressed) {
        assessment.warnings.push(
          `telegram-safety-alerts-suppressed:${dispatchMeta.safetyAlertSourceState ?? "missing"}`,
        );
      }
    } catch (error) {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "telegram_summary_unavailable",
        route: "health",
        message: "Telegram summary unavailable",
        error,
      });
      // Telegram tables may not be migrated yet, or the summary queries may be
      // temporarily unavailable. Keep the endpoint healthy and return null.
    }
  }

  const body: HealthResponse = {
    status: assessment.overallStatus,
    timestamp: now,
    warnings: assessment.warnings,
    caches: assessment.caches,
    blacklist: assessment.blacklist,
    mintBurn: assessment.mintBurn,
    circuits: assessment.circuits,
    alertBroker: assessment.alertBroker,
    telegramSummary,
  };

  return jsonResponse(body, { "Cache-Control": CACHE_PROFILES.realtime });
});
