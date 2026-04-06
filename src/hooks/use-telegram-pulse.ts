"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import type { TelegramPulse } from "@shared/types/status";
import { useApiQuery } from "./use-api-query";

const FIVE_MIN = 300_000;

export function useTelegramPulse() {
  return useApiQuery<TelegramPulse>(
    ["telegram-pulse"],
    API_PATHS.telegramPulse(),
    FIVE_MIN,
  );
}
