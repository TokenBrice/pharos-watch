"use client";

import { fetchAllBlacklistEvents } from "@/lib/blacklist-api";
import { usePollingQuery } from "./use-api-query";
import { CRON_20MIN } from "@/lib/cron-intervals";

export function useBlacklistEvents() {
  return usePollingQuery(["blacklist-events"], fetchAllBlacklistEvents, CRON_20MIN, { retry: 1 });
}
