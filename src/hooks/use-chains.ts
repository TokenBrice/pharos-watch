"use client";

import { useMemo } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { ChainsResponse } from "@shared/types/chains";
import { useApiQuery } from "./use-api-query";
import { useStablecoins } from "./use-stablecoins";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

export function useChains() {
  return useApiQuery<ChainsResponse>(
    ["chains"],
    API_PATHS.chains(),
    CRON_15MIN,
  );
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

export function useChainStablecoins(chainId: string) {
  const { data, isLoading, isError } = useStablecoins();

  return useMemo(() => {
    if (!data?.peggedAssets) {
      return { coins: [], totalUsd: 0, isLoading, isError };
    }

    let totalUsd = 0;
    const coins: ChainStablecoin[] = [];

    for (const asset of data.peggedAssets) {
      const cc = asset.chainCirculating;
      if (!cc || typeof cc !== "object") continue;
      const chainData = cc[chainId] as { current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number } | undefined;
      if (!chainData?.current || chainData.current <= 0) continue;

      const supplyOnChain = chainData.current;
      totalUsd += supplyOnChain;

      const prev24h = chainData.circulatingPrevDay ?? 0;
      const prev7d = chainData.circulatingPrevWeek ?? 0;
      const prev30d = chainData.circulatingPrevMonth ?? 0;
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

    return { coins, totalUsd, isLoading, isError };
  }, [data, chainId, isLoading, isError]);
}
