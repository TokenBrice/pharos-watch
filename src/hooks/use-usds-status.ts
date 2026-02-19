"use client";

import { useApiQuery, CRON_15MIN } from "./use-api-query";

interface UsdsStatus {
  freezeActive: boolean;
  implementationAddress: string;
  lastChecked: number;
}

export function useUsdsStatus() {
  return useApiQuery<UsdsStatus | null>(["usds-status"], "/api/usds-status", CRON_15MIN);
}
