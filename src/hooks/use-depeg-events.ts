"use client";

import type { DepegEvent } from "@shared/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

interface DepegEventsResponse {
  events: DepegEvent[];
  total: number;
  methodology?: {
    version: string;
    versionLabel: string;
    currentVersion: string;
    currentVersionLabel: string;
    changelogPath: string;
    asOf: number;
    isCurrent: boolean;
  };
}

export function useDepegEvents(stablecoinId?: string) {
  const params = stablecoinId ? `?stablecoin=${encodeURIComponent(stablecoinId)}` : "";
  return useApiQuery<DepegEventsResponse>(
    ["depeg-events", stablecoinId],
    `/api/depeg-events${params}`,
    CRON_15MIN
  );
}
