"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { DigestInputData } from "@shared/types";
import { createApiQueryFn, createStaticQueryOptions } from "./use-api-query";

interface DigestSnapshotData {
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
    createApiQueryFn<DigestSnapshotData>(`/api/digest-snapshot?date=${date}`),
    { enabled: !!date, retry: 1 },
  ));
}
