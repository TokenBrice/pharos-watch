"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import type { TelegramPulse } from "@shared/types/status";
import { useApiQuery } from "./use-api-query";

const FIVE_MIN = 300_000;

// Public /pharoswatchbot telemetry contract. Keep rendered fields and
// docs/telegram-alerts.md in sync with worker/src/api/telegram-pulse.ts.
export function useTelegramPulse() {
  return useApiQuery<TelegramPulse>(
    ["telegram-pulse"],
    API_PATHS.telegramPulse(),
    FIVE_MIN,
  );
}
