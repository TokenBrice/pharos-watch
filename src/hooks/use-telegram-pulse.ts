"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import type { TelegramPulse } from "@shared/types/status";
import { CRON_TELEGRAM_PULSE } from "@/lib/cron-intervals";
import { useApiQuery } from "./use-api-query";

// Public /pharoswatchbot telemetry contract. Keep rendered fields and
// docs/telegram-alerts.md in sync with worker/src/api/telegram-pulse.ts.
export function useTelegramPulse() {
  return useApiQuery<TelegramPulse>(
    ["telegram-pulse"],
    API_PATHS.telegramPulse(),
    CRON_TELEGRAM_PULSE,
  );
}
