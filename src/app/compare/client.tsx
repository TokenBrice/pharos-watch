"use client";

import { useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins, detailToSupplyHistory, detailToPriceHistory } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { derivePegRates } from "@/lib/peg-rates";
import { formatCurrency } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import { CRON_1H } from "@/hooks/use-api-query";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { CoinSelector } from "@/components/coin-selector";
import { ComparisonTable } from "@/components/comparison-table";
import { ComparisonChart } from "@/components/comparison-chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { Link2, Check } from "lucide-react";
import type { CoinOption } from "@/components/coin-selector";
import type { StablecoinDetail } from "@/hooks/use-stablecoins";

const MAX_COINS = 5;

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

  // Derive selected IDs from URL (single source of truth)
  const selectedIds = useMemo(() => {
    const param = searchParams.get("coins");
    if (!param) return [];
    return param
      .split(",")
      .map((s) => SYMBOL_TO_COIN.get(s.trim().toLowerCase()))
      .filter((c): c is CoinOption => !!c)
      .slice(0, MAX_COINS)
      .map((c) => c.id);
  }, [searchParams]);

  const range = (searchParams.get("range") as TimeRangeOption) || "all";

  const setRange = useCallback(
    (newRange: TimeRangeOption) => {
      const params = new URLSearchParams(searchParams.toString());
      if (newRange === "all") {
        params.delete("range");
      } else {
        params.set("range", newRange);
      }
      const qs = params.toString();
      router.replace(qs ? `/compare/?${qs}` : "/compare/", { scroll: false });
    },
    [searchParams, router],
  );

  // Write selected IDs to URL
  const setSelectedIds = useCallback(
    (updater: (prev: string[]) => string[]) => {
      const next = updater(selectedIds);
      const symbols = next
        .map((id) => TRACKED_STABLECOINS.find((c) => c.id === id))
        .filter((c): c is (typeof TRACKED_STABLECOINS)[number] => !!c)
        .map((c) => c.symbol.toLowerCase());
      const params = new URLSearchParams();
      if (symbols.length > 0) params.set("coins", symbols.join(","));
      const currentRange = searchParams.get("range");
      if (currentRange) params.set("range", currentRange);
      const qs = params.toString();
      router.replace(qs ? `/compare/?${qs}` : "/compare/", { scroll: false });
    },
    [selectedIds, router, searchParams],
  );

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
    return derivePegRates(listData.peggedAssets, TRACKED_META_BY_ID, listData.fxFallbackRates).rates;
  }, [listData]);

  // Per-coin detail data (raw, used for both supply and price history)
  const detailQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["stablecoin-detail", id],
      queryFn: () =>
        apiFetch<StablecoinDetail>(`/api/stablecoin/${encodeURIComponent(id)}`),
      staleTime: CRON_1H,
      enabled: !!id,
    })),
  });

  // Color palette for chart series (first 5 from shared palette)
  const CHART_COLORS = CHART_PALETTE.slice(0, 5);

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
        const detail = detailQueries[i]?.data;
        const history = detailToSupplyHistory(detail);
        if (history.length === 0) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          label: meta?.name ?? id,
          data: history.map((d) => ({ ts: d.date * 1000, value: d.circulatingUsd })),
          color: CHART_COLORS[i % CHART_COLORS.length],
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [selectedIds, detailQueries]);

  // Build price chart series
  const priceSeries = useMemo(() => {
    return selectedIds
      .map((id, i) => {
        const detail = detailQueries[i]?.data;
        const history = detailToPriceHistory(detail);
        if (history.length === 0) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          label: meta?.name ?? id,
          data: history.map((d) => ({ ts: d.date * 1000, value: d.price })),
          color: CHART_COLORS[i % CHART_COLORS.length],
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [selectedIds, detailQueries]);

  const detailLoading = detailQueries.some((q) => q.isLoading);

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

  const [copied, setCopied] = useState(false);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may not be available
    }
  }, []);

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
      {selectedIds.length >= 2 && (
        <div className="flex justify-end">
          <button
            onClick={handleCopyLink}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied!
              </>
            ) : (
              <>
                <Link2 className="h-3.5 w-3.5" />
                Copy link
              </>
            )}
          </button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{slots}</div>

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

          {detailLoading ? (
            <Skeleton className="h-[300px] sm:h-[400px] rounded-2xl" />
          ) : (
            <>
              {supplySeries.length >= 2 && (
                <ComparisonChart
                  title="Market Cap History"
                  series={supplySeries}
                  formatValue={formatCurrency}
                  range={range}
                  onRangeChange={setRange}
                />
              )}
              {priceSeries.length >= 2 && (
                <ComparisonChart
                  title="Price History"
                  series={priceSeries}
                  formatValue={(v) => `$${v.toFixed(4)}`}
                  range={range}
                  onRangeChange={setRange}
                />
              )}
            </>
          )}

        </div>
      )}
    </div>
  );
}
