"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  topDepegs: { symbol: string; bps: number; mcapUsd: number }[];
  biggestSupplyChange: {
    id: string;
    symbol: string;
    name: string;
    changeUsd: number;
    currentMcap: number;
  } | null;
  stabilityIndex: {
    score: number;
    band: string;
    components: { severity: number; breadth: number; trend: number };
  } | null;
  yesterdayIndex: { score: number; band: string } | null;
}

export interface DigestSnapshotData {
  date: string;
  inputData: DigestInputData | null;
  prevInputData: DigestInputData | null;
  depegEvents: {
    stablecoinId: string;
    symbol: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }[];
  blacklistEvents: {
    stablecoin: string;
    chainName: string;
    eventType: string;
    address: string;
    amount: number | null;
    timestamp: number;
  }[];
}

export function useDigestSnapshot(date: string): UseQueryResult<DigestSnapshotData, Error> {
  return useQuery<DigestSnapshotData, Error>({
    queryKey: ["digest-snapshot", date],
    queryFn: () => apiFetch<DigestSnapshotData>(`/api/digest-snapshot?date=${date}`),
    staleTime: Infinity,
    enabled: !!date,
    retry: 1,
  });
}
