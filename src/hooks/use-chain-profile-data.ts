"use client";

import { useMemo } from "react";
import { useChainDetail } from "./use-chains";

export function useChainProfileData(chainId: string) {
  const chainsQuery = useChainDetail(chainId);

  const chain = useMemo(() => {
    if (!chainsQuery.data?.chains) return null;
    return chainsQuery.data.chains.find((candidate) => candidate.id === chainId) ?? null;
  }, [chainId, chainsQuery.data]);

  const detail = chainsQuery.data?.chainDetail;
  const canConfirmMissingChain = Boolean(chainsQuery.data?.chains) && chainsQuery.error == null;

  return {
    chain,
    // The Worker detail payload is authoritative; do not re-aggregate the
    // stablecoins endpoint or reconcile two independently refreshed snapshots.
    coins: detail?.coins ?? [],
    totalUsd: detail?.totalUsd ?? 0,
    canConfirmMissingChain,
    hasAnyData: Boolean(chain) || chainsQuery.dataUpdatedAt > 0,
    isInitialLoading: chainsQuery.isLoading && !chainsQuery.data,
    routeError: chainsQuery.error ?? null,
    chainsQuery,
    refetchAll: chainsQuery.refetch,
  };
}
