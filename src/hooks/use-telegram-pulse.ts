"use client";

import type { TelegramPulse } from "@shared/types/status";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";
import { useApiQuery } from "./use-api-query";

// Public /pharoswatchbot telemetry contract. Keep rendered fields and
// docs/telegram-alerts.md in sync with worker/src/api/telegram-pulse.ts.
export function useTelegramPulse() {
  const descriptor = FRONTEND_API_QUERY_REGISTRY.telegramPulse;
  return useApiQuery<TelegramPulse>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    { schema: descriptor.schema },
  );
}
