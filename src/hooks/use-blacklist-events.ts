"use client";

import { fetchAllBlacklistEvents } from "@/lib/blacklist-api";
import { CRON_20MIN, usePollingQuery } from "./use-api-query";

export function useBlacklistEvents() {
  return usePollingQuery(["blacklist-events"], fetchAllBlacklistEvents, CRON_20MIN, { retry: 1 });
}
