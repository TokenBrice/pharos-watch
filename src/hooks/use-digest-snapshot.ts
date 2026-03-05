"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { DigestInputData } from "@shared/types";
import { createStaticQueryOptions } from "./use-api-query";

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
  return useQuery<DigestSnapshotData, Error>(createStaticQueryOptions(
    ["digest-snapshot", date],
    () => apiFetch<DigestSnapshotData>(`/api/digest-snapshot?date=${date}`),
    { enabled: !!date, retry: 1 },
  ));
}
