"use client";

import { fetchAllBlacklistEvents } from "@/lib/blacklist-api";
import { CRON_BLACKLIST } from "@/lib/cron-intervals";
import { usePollingQuery } from "./use-api-query";

export function useBlacklistEvents() {
  return usePollingQuery(["blacklist-events"], fetchAllBlacklistEvents, CRON_BLACKLIST, { retry: 1 });
}
