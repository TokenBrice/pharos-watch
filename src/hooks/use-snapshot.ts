"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_PATHS, type PublicSnapshotIndexResponse } from "@shared/lib/api-endpoints";
import { apiFetch } from "@/lib/api";
import { createStaticQueryOptions } from "./use-api-query";

/**
 * Public-snapshot consumers. Snapshots are immutable archives — once a row
 * is written for a UTC date, its content never changes. The query options
 * therefore use `staleTime: Infinity` and `refetchInterval: false`.
 *
 * The index endpoint is the only path that can mutate (new rows appear daily);
 * we still treat it as static within a session, since the producer cron runs
 * exactly once per day and no UI polling justifies live refetch.
 */

export function useSnapshotsIndex(opts: { enabled?: boolean } = {}): UseQueryResult<
  PublicSnapshotIndexResponse,
  Error
> {
  return useQuery<PublicSnapshotIndexResponse, Error>(
    createStaticQueryOptions<PublicSnapshotIndexResponse>(
      ["snapshots", "index"] as const,
      () => apiFetch<PublicSnapshotIndexResponse>(API_PATHS.snapshotsIndex()),
      { enabled: opts.enabled },
    ),
  );
}

export interface PublicSnapshotDay {
  snapshotDate: string;
  generatedAt: number;
  methodologyVersions: Record<string, string>;
  stablecoins: Array<Record<string, unknown> & { id: string }>;
  fxFallbackRates: Record<string, number> | null;
  reportCards: { scores?: Record<string, unknown> } | null;
  psi: Record<string, unknown> | null;
  dews: Array<Record<string, unknown> & { stablecoinId: string }>;
  liquidity: Array<Record<string, unknown> & { stablecoinId: string }>;
}

export function useSnapshotDay(date: string | null, opts: { enabled?: boolean } = {}): UseQueryResult<
  PublicSnapshotDay,
  Error
> {
  const enabled = (opts.enabled ?? true) && typeof date === "string" && date.length > 0;
  return useQuery<PublicSnapshotDay, Error>(
    createStaticQueryOptions<PublicSnapshotDay>(
      ["snapshots", "day", date] as const,
      () => apiFetch<PublicSnapshotDay>(API_PATHS.snapshotDay(date ?? "")),
      { enabled },
    ),
  );
}

export interface PublicSnapshotCoin {
  snapshotDate: string;
  stablecoinId: string;
  generatedAt: number;
  methodologyVersions: Record<string, string> | null;
  stablecoin: Record<string, unknown> & { id: string };
  scores: {
    reportCard: Record<string, unknown> | null;
    psi: Record<string, unknown> | null;
    dews: Record<string, unknown> | null;
    liquidity: Record<string, unknown> | null;
  };
}

export function useSnapshotCoin(
  date: string | null,
  stablecoinId: string | null,
  opts: { enabled?: boolean } = {},
): UseQueryResult<PublicSnapshotCoin, Error> {
  const enabled =
    (opts.enabled ?? true) &&
    typeof date === "string" && date.length > 0 &&
    typeof stablecoinId === "string" && stablecoinId.length > 0;
  return useQuery<PublicSnapshotCoin, Error>(
    createStaticQueryOptions<PublicSnapshotCoin>(
      ["snapshots", "coin", date, stablecoinId] as const,
      () => apiFetch<PublicSnapshotCoin>(API_PATHS.snapshotCoin(date ?? "", stablecoinId ?? "")),
      { enabled },
    ),
  );
}
