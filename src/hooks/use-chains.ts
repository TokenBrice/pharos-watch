"use client";

import { useMemo } from "react";
import { findCanonicalChainData, type RawChainCirculating } from "@shared/lib/chain-circulating";
import { type ChainsResponse } from "@shared/types/chains";
import { useRegisteredApiQueryWithMeta } from "./api-hooks";
import { useStablecoins } from "./use-stablecoins";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ApiMeta } from "@/lib/api";

export function useChains() {
  return useRegisteredApiQueryWithMeta<ChainsResponse>(FRONTEND_API_QUERY_DESCRIPTORS.chains);
}

export interface ChainStablecoin {
  id: string;
  name: string;
  symbol: string;
  price: number | null;
  pegType: string | undefined;
  supplyOnChain: number;
  chainShare: number;
  change24h: number;
  change24hPct: number;
  change7d: number;
  change7dPct: number;
  change30d: number;
  change30dPct: number;
  backing: string | undefined;
}

export interface ChainStablecoinsResult {
  coins: ChainStablecoin[];
  totalUsd: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  dataUpdatedAt: number;
  meta: ApiMeta | null;
}

export function useChainStablecoins(chainId: string) {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
    meta,
  } = useStablecoins();

  const { coins, totalUsd } = useMemo(() => {
    if (!data?.peggedAssets) {
      return { coins: [] as ChainStablecoin[], totalUsd: 0 };
    }

    let totalUsd = 0;
    const coins: ChainStablecoin[] = [];

    for (const asset of data.peggedAssets) {
      const cc = asset.chainCirculating;
      if (!cc || typeof cc !== "object") continue;

      const chainData = findCanonicalChainData(
        cc as RawChainCirculating,
        chainId,
      );
      if (!chainData || chainData.current <= 0) continue;

      const supplyOnChain = chainData.current;
      totalUsd += supplyOnChain;

      const prev24h = chainData.circulatingPrevDay;
      const prev7d = chainData.circulatingPrevWeek;
      const prev30d = chainData.circulatingPrevMonth;
      const meta = TRACKED_META_BY_ID.get(asset.id);

      coins.push({
        id: asset.id,
        name: asset.name ?? asset.symbol,
        symbol: asset.symbol,
        price: typeof asset.price === "number" ? asset.price : null,
        pegType: asset.pegType,
        supplyOnChain,
        chainShare: 0, // computed below
        change24h: supplyOnChain - prev24h,
        change24hPct: prev24h > 0 ? (supplyOnChain - prev24h) / prev24h : 0,
        change7d: supplyOnChain - prev7d,
        change7dPct: prev7d > 0 ? (supplyOnChain - prev7d) / prev7d : 0,
        change30d: supplyOnChain - prev30d,
        change30dPct: prev30d > 0 ? (supplyOnChain - prev30d) / prev30d : 0,
        backing: meta?.flags?.backing,
      });
    }

    // Fill chainShare now that totalUsd is known
    for (const coin of coins) {
      coin.chainShare = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
    }

    coins.sort((a, b) => b.supplyOnChain - a.supplyOnChain);

    return { coins, totalUsd };
  }, [data, chainId]);

  return {
    coins,
    totalUsd,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
    meta,
  } satisfies ChainStablecoinsResult;
}
