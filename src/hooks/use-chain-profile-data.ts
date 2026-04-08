"use client";

import { useCallback, useMemo } from "react";
import { useChainStablecoins, useChains } from "./use-chains";

type SnapshotConsistency = "matched" | "mismatched" | "unknown";

export function useChainProfileData(chainId: string) {
  const chainsQuery = useChains();
  const stablecoinsQuery = useChainStablecoins(chainId);

  const chain = useMemo(() => {
    if (!chainsQuery.data?.chains) return null;
    return chainsQuery.data.chains.find((candidate) => candidate.id === chainId) ?? null;
  }, [chainId, chainsQuery.data]);

  const chainsSnapshotAt = chainsQuery.meta?.updatedAt ?? null;
  const stablecoinsSnapshotAt = stablecoinsQuery.meta?.updatedAt ?? null;
  const hasAuthoritativeSnapshots = chainsSnapshotAt != null && stablecoinsSnapshotAt != null;
  const hasStablecoinsSnapshotData =
    stablecoinsQuery.meta != null || stablecoinsQuery.dataUpdatedAt > 0;
  const snapshotConsistency: SnapshotConsistency = hasAuthoritativeSnapshots
    ? chainsSnapshotAt === stablecoinsSnapshotAt
      ? "matched"
      : "mismatched"
    : "unknown";
  const canRenderDetailedSections =
    snapshotConsistency === "matched"
    && hasStablecoinsSnapshotData;

  const isInitialLoading =
    (chainsQuery.isLoading && !chainsQuery.data)
    || (stablecoinsQuery.isLoading && stablecoinsQuery.meta == null && stablecoinsQuery.dataUpdatedAt === 0);
  const routeError = (!chainsQuery.data ? chainsQuery.error : null)
    ?? stablecoinsQuery.error
    ?? null;
  const canConfirmMissingChain = Boolean(chainsQuery.data?.chains) && chainsQuery.error == null;
  const hasAnyData = Boolean(chain)
    || chainsQuery.dataUpdatedAt > 0
    || stablecoinsQuery.dataUpdatedAt > 0
    || stablecoinsQuery.meta != null;

  const detailedSectionNotice = useMemo(() => {
    if (stablecoinsQuery.error) {
      return "Detailed stablecoin composition is temporarily unavailable. Summary chain metrics are still shown from the latest chain snapshot.";
    }
    if (snapshotConsistency === "mismatched") {
      return "Detailed stablecoin composition is syncing to the latest chain snapshot. Breakdown sections are hidden until both sources match exactly.";
    }
    if (snapshotConsistency === "unknown") {
      return "Detailed stablecoin composition is waiting for authoritative freshness metadata. Breakdown sections stay hidden to avoid mixing snapshots.";
    }
    return null;
  }, [snapshotConsistency, stablecoinsQuery.error]);

  const refetchAll = useCallback(async () => {
    await Promise.allSettled([
      chainsQuery.refetch(),
      stablecoinsQuery.refetch(),
    ]);
  }, [chainsQuery, stablecoinsQuery]);

  return {
    chain,
    coins: stablecoinsQuery.coins,
    totalUsd: stablecoinsQuery.totalUsd,
    canRenderDetailedSections,
    detailedSectionNotice,
    hasAnyData,
    canConfirmMissingChain,
    isInitialLoading,
    routeError,
    snapshotConsistency,
    chainsQuery,
    stablecoinsQuery,
    refetchAll,
  };
}
