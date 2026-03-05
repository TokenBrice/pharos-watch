"use client";

import { apiFetch } from "@/lib/api";
import { BlacklistResponseSchema, type BlacklistResponse } from "@shared/types";
import { CRON_20MIN, usePollingQuery } from "./use-api-query";

async function fetchBlacklistEvents(): Promise<BlacklistResponse> {
  return apiFetch("/api/blacklist", BlacklistResponseSchema);
}

export function useBlacklistEvents() {
  return usePollingQuery(
    ["blacklist-events"],
    fetchBlacklistEvents,
    CRON_20MIN,
    { retry: 1 },
  );
}
