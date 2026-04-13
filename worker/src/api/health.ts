import {
  withErrorHandler,
  jsonResponse,
} from "../lib/api-utils";
import type { HealthResponse, TelegramHealthSummary } from "@shared/types/status";
import { assessPublicHealth } from "../lib/public-health-assessment";

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
            "SELECT started_at, status FROM cron_runs WHERE job = 'dispatch-telegram-alerts' ORDER BY started_at DESC LIMIT 1",
          )
          .first<{ started_at: number; status: string }>(),
      ]);
      telegramSummary = {
        totalChats: chatCount?.n ?? 0,
        pendingDeliveries: pendingCount?.n ?? 0,
        lastDispatchAt: lastDispatch?.started_at ?? null,
        lastDispatchStatus: lastDispatch?.status ?? null,
      };
    } catch (error) {
      console.warn("[health] telegram summary unavailable:", error);
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
    telegramSummary,
  };

  return jsonResponse(body, { "Cache-Control": "no-store" });
});
