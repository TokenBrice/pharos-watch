"use client";

import type { TelegramPulse } from "@shared/types/status";
import { FRONTEND_API_QUERY_RUNTIME_REGISTRY } from "@/lib/api-query-runtime-registry";
import { useRegisteredApiQuery } from "./api-hooks";

// Public /pharoswatchbot telemetry contract. Keep rendered fields and
// docs/telegram-alerts.md in sync with worker/src/api/telegram-pulse.ts.
export function useTelegramPulse() {
  return useRegisteredApiQuery<TelegramPulse>(FRONTEND_API_QUERY_RUNTIME_REGISTRY.telegramPulse);
}
