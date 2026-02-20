"use client";

import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { derivePegRates } from "@/lib/peg-rates";
import { formatCurrency } from "@/lib/format";
import { API_BASE } from "@/lib/api";
import { CRON_1H } from "@/hooks/use-api-query";
import { CoinSelector } from "@/components/coin-selector";
import { ComparisonTable } from "@/components/comparison-table";
import { ComparisonChart } from "@/components/comparison-chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { CoinOption } from "@/components/coin-selector";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

const MAX_COINS = 3;

/** Lookup from lowercased symbol to coin for URL parsing. */
const SYMBOL_TO_COIN = new Map<string, CoinOption>(
  TRACKED_STABLECOINS.map((c) => [
    c.symbol.toLowerCase(),
    { id: c.id, name: c.name, symbol: c.symbol },
  ]),
);

export function CompareClient() {
  const { data: logos } = useLogos();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Parse initial selection from URL: ?coins=usdt,usdc,dai
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const param = searchParams.get("coins");
    if (!param) return [];
    return param
      .split(",")
      .map((s) => SYMBOL_TO_COIN.get(s.trim().toLowerCase()))
      .filter((c): c is CoinOption => !!c)
      .slice(0, MAX_COINS)
      .map((c) => c.id);
  });

  // Sync selected coins to URL
  useEffect(() => {
    const symbols = selectedIds
      .map((id) => TRACKED_STABLECOINS.find((c) => c.id === id))
      .filter((c): c is (typeof TRACKED_STABLECOINS)[number] => !!c)
      .map((c) => c.symbol.toLowerCase());
    const paramStr = symbols.join(",");
    const newUrl = paramStr ? `/compare/?coins=${paramStr}` : "/compare/";
    router.replace(newUrl, { scroll: false });
  }, [selectedIds, router]);

  const coinOptions = useMemo<CoinOption[]>(
    () =>
      TRACKED_STABLECOINS.map((c) => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol,
      })),
    [],
  );

  const selectedCoins = useMemo(
    () =>
      selectedIds.map(
        (id) => coinOptions.find((c) => c.id === id) ?? null,
      ),
    [selectedIds, coinOptions],
  );

  const disabledIds = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Global data hooks
  const { data: listData } = useStablecoins();
  const { data: pegSummary } = usePegSummary();
  const { data: bluechipData } = useBluechipRatings();
  const { data: dexData } = useDexLiquidity();

  // Derive peg rates from stablecoin list
  const pegRates = useMemo(() => {
    if (!listData?.peggedAssets) return {};
    return derivePegRates(listData.peggedAssets, TRACKED_META_BY_ID, listData.fxFallbackRates);
  }, [listData]);

  // Per-coin supply history using useQueries
  const supplyQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["supply-history", id],
      queryFn: () =>
        fetch(`${API_BASE}/api/supply-history?stablecoin=${encodeURIComponent(id)}&days=1825`)
          .then((r) => r.json()) as Promise<SupplyHistoryPoint[]>,
      staleTime: CRON_1H,
      enabled: !!id,
    })),
  });

  // Color palette for chart series
  const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b"];

  // Build enriched coin objects for ComparisonTable
  const comparisonCoins = useMemo(() => {
    if (!listData?.peggedAssets) return [];
    return selectedIds
      .map((id) => {
        const data = listData.peggedAssets.find((a) => a.id === id);
        const meta = TRACKED_META_BY_ID.get(id);
        if (!data || !meta) return null;
        const pegCoin = pegSummary?.coins?.find((c) => c.id === id);
        const dexCoin = dexData?.[id];
        const bluechipGrade = bluechipData?.[id]?.grade ?? null;
        return {
          id,
          symbol: data.symbol,
          name: data.name,
          data,
          meta,
          pegScore: pegCoin?.pegScore ?? null,
          liquidityScore: dexCoin?.liquidityScore ?? null,
          bluechipGrade,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [selectedIds, listData, pegSummary, dexData, bluechipData]);

  // Build supply chart series
  const supplySeries = useMemo(() => {
    return selectedIds
      .map((id, i) => {
        const queryResult = supplyQueries[i];
        if (!queryResult?.data || queryResult.data.length === 0) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          label: meta?.name ?? id,
          data: queryResult.data.map((d: SupplyHistoryPoint) => ({
            ts: d.date * 1000,
            value: d.circulatingUsd,
          })),
          color: CHART_COLORS[i % CHART_COLORS.length],
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [selectedIds, supplyQueries]);

  const supplyLoading = supplyQueries.some((q) => q.isLoading);

  const handleSelect = (slotIndex: number, coin: CoinOption) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      // If the slot already has a value, replace it; otherwise append
      if (slotIndex < prev.length) {
        next[slotIndex] = coin.id;
      } else {
        next.push(coin.id);
      }
      return next;
    });
  };

  const handleRemove = (slotIndex: number) => {
    setSelectedIds((prev) => prev.filter((_, i) => i !== slotIndex));
  };

  // Render 3 selector slots (filled slots + empty slots up to MAX_COINS)
  const slots = [];
  for (let i = 0; i < MAX_COINS; i++) {
    const coin = selectedCoins[i] ?? null;
    slots.push(
      <CoinSelector
        key={i}
        coins={coinOptions}
        selected={coin}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={(c) => handleSelect(i, c)}
        onRemove={() => handleRemove(i)}
      />,
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">{slots}</div>

      {selectedIds.length < 2 && (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-sm">
            Select at least 2 stablecoins to compare.
          </p>
        </div>
      )}

      {selectedIds.length >= 2 && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <ComparisonTable
            coins={comparisonCoins}
            pegRates={pegRates}
            logos={logos}
          />

          {supplyLoading ? (
            <Skeleton className="h-[300px] sm:h-[400px] rounded-2xl" />
          ) : supplySeries.length >= 2 ? (
            <ComparisonChart
              title="Market Cap History"
              series={supplySeries}
              formatValue={formatCurrency}
            />
          ) : null}

          {supplySeries.length >= 2 && !supplyLoading && (
            <ComparisonChart
              title="Market Cap (Normalized)"
              series={supplySeries}
              formatValue={(v) => `${v.toFixed(0)}`}
              normalized
              referenceLine={100}
            />
          )}
        </div>
      )}
    </div>
  );
}
