"use client";

import { useApiQuery, CRON_15MIN } from "@/hooks/use-api-query";

interface StabilityIndexComponents {
  severity: number;
  breadth: number;
  freezes: number;
  trend: number;
}

export interface StabilityContributor {
  id: string;
  symbol: string;
  bps: number;
  mcapUsd: number;
  ageDays: number;
  factor: number;
}

interface StabilityIndexCurrent {
  score: number;
  band: string;
  avg24h?: number;
  avg24hBand?: string;
  components: StabilityIndexComponents;
  contributors?: StabilityContributor[];
  totalMcapUsd?: number;
  computedAt: number;
}

interface StabilityIndexHistoryPoint {
  date: number;
  score: number;
  band: string;
}

export interface StabilityIndexData {
  current: StabilityIndexCurrent | null;
  history: StabilityIndexHistoryPoint[];
}

export function useStabilityIndex() {
  return useApiQuery<StabilityIndexData>(
    ["stability-index"],
    "/api/stability-index",
    CRON_15MIN,
  );
}

interface StabilityIndexDetailHistoryPoint {
  date: number;
  score: number;
  band: string;
  components: StabilityIndexComponents;
}

export interface StabilityIndexDetailData {
  current: StabilityIndexCurrent | null;
  history: StabilityIndexDetailHistoryPoint[];
}

export function useStabilityIndexDetail() {
  return useApiQuery<StabilityIndexDetailData>(
    ["stability-index-detail"],
    "/api/stability-index?detail=true",
    CRON_15MIN,
  );
}
