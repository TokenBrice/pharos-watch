"use client";

import { useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useQueries } from "@tanstack/react-query";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins, detailToSupplyHistory } from "@/hooks/use-stablecoins";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { MintBurnPerCoinResponseSchema } from "@shared/types";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { formatCurrency, formatNativePrice } from "@shared/lib/format";
import { apiFetch } from "@/lib/api";
import { CRON_1H } from "@/hooks/use-api-query";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { CoinSelector } from "@/components/coin-selector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { Share2, Twitter, Download } from "lucide-react";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { GOVERNANCE_LABELS_SHORT, BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { renderCompareShareImage, canvasToBlob, loadImage } from "@/lib/compare-share-image";
import type { ShareCoinData, ShareRadarData } from "@/lib/compare-share-image";
import { DIMENSION_ORDER, DIMENSION_SHORT_LABELS } from "@shared/lib/report-cards";
import type { CoinOption } from "@/components/coin-selector";
import type { StablecoinDetail } from "@/hooks/use-stablecoins";
import type { ReportCard } from "@shared/types";
import { trackEvent } from "@/lib/analytics";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { CompareEmptyState } from "@/components/compare-empty-state";
import type { ComparePreset } from "@/components/compare-empty-state";

const MAX_COINS = 5;
const COMPARE_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];

const ComparisonTable = dynamic(() => import("@/components/comparison-table").then((m) => m.ComparisonTable), {
  loading: () => <ChartSkeleton className="h-[340px] rounded-xl" />,
});

const ComparisonChart = dynamic(() => import("@/components/comparison-chart").then((m) => m.ComparisonChart), {
  loading: () => <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />,
});

const CompareRadar = dynamic(() => import("@/components/radar-chart").then((m) => m.CompareRadar), {
  loading: () => <ChartSkeleton className="h-[420px] rounded-xl" />,
});

const FlowComparisonChart = dynamic(
  () => import("@/components/flow-comparison-chart").then((m) => ({ default: m.FlowComparisonChart })),
  { loading: () => <div className="h-[280px] rounded-xl animate-pulse bg-muted/20" /> },
);

/** Lookup from lowercased symbol to coin — used for preset cards and legacy URL fallback. */
const SYMBOL_TO_COIN = new Map<string, CoinOption>(
  TRACKED_STABLECOINS.map((c) => [c.symbol.toLowerCase(), { id: c.id, name: c.name, symbol: c.symbol }]),
);

/** Lookup from canonical ID string to coin — primary URL identifier (avoids duplicate-symbol collisions). */
const ID_TO_COIN = new Map<string, CoinOption>(
  TRACKED_STABLECOINS.map((c) => [c.id, { id: c.id, name: c.name, symbol: c.symbol }]),
);

const COMPARISON_PRESETS: readonly ComparePreset[] = [
  {
    title: "The Big Four",
    description: "The four largest USD stablecoins by market cap",
    coins: ["usdt-tether", "usdc-circle", "usds-sky", "usde-ethena"],
  },
  {
    title: "DeFi Natives",
    description: "Decentralized, crypto-backed stablecoins",
    coins: ["dai-makerdao", "lusd-liquity", "bold-liquity"],
  },
  {
    title: "Gold Pegs",
    description: "Tokenized gold stablecoins",
    coins: ["paxg-paxos", "xaut-tether", "kau-kinesis"],
  },
  {
    title: "Euro Stablecoins",
    description: "EUR-pegged stablecoins",
    coins: ["eurs-stasis", "eura-angle", "eure-monerium"],
  },
  {
    title: "Tokenized Treasuries",
    description: "NAV-priced tokens backed by U.S. Treasury bills",
    coins: ["usyc-hashnote", "usdy-ondo-finance", "tbill-openeden", "buidl-blackrock"],
  },
  {
    title: "Protocol Stablecoins",
    description: "Native stablecoins issued by major DeFi protocols",
    coins: ["gho-aave", "crvusd-curve", "frax-frax"],
  },
  {
    title: "Institutional RWA",
    description: "Tokenized real-world assets from institutional issuers",
    coins: ["buidl-blackrock", "m-m0", "usd0-usual"],
  },
  {
    title: "Emerging Currency Pegs",
    description: "Stablecoins pegged to emerging market fiat currencies",
    coins: ["brz-transfero", "zarp-zarp"],
  },
  {
    title: "Non-USD Majors",
    description: "Stablecoins pegged to developed-market non-USD currencies",
    coins: ["xsgd-straitsx", "gyen-gyen", "zchf-frankencoin"],
  },
];

export function CompareClient() {
  const { data: logos } = useLogos();
  const { searchParams, replaceParams } = useUrlFilters();

  // Derive selected IDs from URL (single source of truth).
  // Accepts canonical IDs and lowercase symbols (presets).
  const selectedIds = useMemo(() => {
    const param = searchParams.get("coins");
    if (!param) return [];
    return param
      .split(",")
      .map((s) => {
        const trimmed = s.trim();
        const byId = ID_TO_COIN.get(trimmed);
        if (byId) return byId;
        const bySym = SYMBOL_TO_COIN.get(trimmed.toLowerCase());
        if (bySym) return bySym;
        return null;
      })
      .filter((c): c is CoinOption => !!c)
      .slice(0, MAX_COINS)
      .map((c) => c.id);
  }, [searchParams]);

  const range = (searchParams.get("range") as TimeRangeOption) || "all";
  const [flowHours, setFlowHours] = useState<24 | 168 | 720>(24);

  const setRange = useCallback(
    (newRange: TimeRangeOption) => {
      trackEvent("time_range_changed", { page: "compare", range: newRange });
      replaceParams((params) => {
        if (newRange === "all") {
          params.delete("range");
        } else {
          params.set("range", newRange);
        }
      });
    },
    [replaceParams],
  );

  // Write selected IDs to URL (using canonical IDs to avoid duplicate-symbol collisions)
  const setSelectedIds = useCallback(
    (updater: (prev: string[]) => string[]) => {
      const next = updater(selectedIds);
      replaceParams((params) => {
        if (next.length > 0) params.set("coins", next.join(","));
        else params.delete("coins");

        if (range !== "all") params.set("range", range);
        else params.delete("range");
      });
    },
    [selectedIds, range, replaceParams],
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
    () => selectedIds.map((id) => coinOptions.find((c) => c.id === id) ?? null),
    [selectedIds, coinOptions],
  );

  const disabledIds = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Global data hooks
  const { data: listData, dataUpdatedAt, error: listError, refetch: refetchList } = useStablecoins();
  const { data: pegSummary, dataUpdatedAt: pegUpdatedAt, error: pegError, refetch: refetchPeg } = usePegSummary();
  const {
    data: bluechipData,
    dataUpdatedAt: bcUpdatedAt,
    error: bluechipError,
    refetch: refetchBluechip,
  } = useBluechipRatings();
  const { data: dexData, dataUpdatedAt: liqUpdatedAt, error: dexError, refetch: refetchLiquidity } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = useReportCards();
  // hours=24 (default); netFlow30dUsd is a fixed 30-day aggregate computed server-side
  // regardless of the hours param — no need for useMintBurnFlows(720).
  const { data: flowData } = useMintBurnFlows();
  const globalError = listError ?? pegError ?? bluechipError ?? dexError ?? reportCardsError;

  const cardMap = useMemo(() => {
    if (!reportCardsData?.cards) return new Map<string, ReportCard>();
    return new Map(reportCardsData.cards.map((c) => [c.id, c]));
  }, [reportCardsData]);

  const radarCards = useMemo(() => {
    return selectedIds
      .map((id, i) => {
        const card = cardMap.get(id);
        if (!card) return null;
        return { card, color: COMPARE_COLORS[i % COMPARE_COLORS.length] };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [selectedIds, cardMap]);

  // Derive peg rates from stablecoin list
  const pegRates = useMemo(() => {
    if (!listData?.peggedAssets) return {};
    return derivePegRates(listData.peggedAssets, TRACKED_META_BY_ID, listData.fxFallbackRates).rates;
  }, [listData]);

  // Per-coin detail data for supply history chart
  const detailQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["stablecoin-detail", id],
      queryFn: () => apiFetch<StablecoinDetail>(`/api/stablecoin/${encodeURIComponent(id)}`),
      staleTime: CRON_1H,
      enabled: !!id,
    })),
  });

  // Per-coin flow queries for the Live Flow Signals chart
  // Direct apiFetch used here because hooks cannot be called inside useQueries callbacks —
  // same pattern as detailQueries above.
  const flowCoinQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ["mint-burn-flows", id, flowHours],
      queryFn: async () => {
        const raw = await apiFetch(`/api/mint-burn-flows?stablecoin=${encodeURIComponent(id)}&hours=${flowHours}`);
        return MintBurnPerCoinResponseSchema.parse(raw);
      },
      staleTime: CRON_1H,
      enabled: !!id,
    })),
  });

  // Track per-coin detail fetch errors
  const detailErrors = useMemo(() => {
    const errors: Record<string, boolean> = {};
    selectedIds.forEach((id, i) => {
      if (detailQueries[i]?.isError) errors[id] = true;
    });
    return errors;
  }, [selectedIds, detailQueries]);

  const CHART_COLORS = CHART_PALETTE;

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
        const safetyGrade = cardMap.get(id)?.overallGrade ?? null;
        const flowCoin = flowData?.coins.find((c) => c.stablecoinId === id);
        return {
          id,
          symbol: data.symbol,
          name: data.name,
          data,
          meta,
          pegScore: pegCoin?.pegScore ?? null,
          liquidityScore: dexCoin?.liquidityScore ?? null,
          safetyGrade,
          netFlow30d: flowCoin?.netFlow30dUsd ?? null,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [selectedIds, listData, pegSummary, dexData, cardMap, flowData]);

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
  }, [selectedIds, detailQueries, CHART_COLORS]);

  // Build flow series for the net flow chart
  const flowSeries = useMemo(() => {
    return selectedIds
      .map((id, i) => {
        const detail = flowCoinQueries[i]?.data;
        if (!detail?.hourly?.length) return null;
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          label: meta?.symbol ?? id,
          color: COMPARE_COLORS[i % COMPARE_COLORS.length],
          data: detail.hourly.map((h) => ({ ts: h.hourTs * 1000, netFlowUsd: h.netFlowUsd })),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [selectedIds, flowCoinQueries]);

  // Build per-coin flow card data from the aggregate flow response
  const flowCardData = useMemo(() => {
    if (!flowData?.coins) return [];
    return selectedIds
      .map((id, i) => {
        const coin = flowData.coins.find((c) => c.stablecoinId === id);
        if (!coin) return null;
        // normalizeMintBurnFlowsResponse always sets these, but the schema marks them optional
        const netFlowDirection24h = coin.netFlowDirection24h ?? "inactive";
        const pressureShiftState = coin.pressureShiftState ?? "nr";
        const meta = TRACKED_META_BY_ID.get(id);
        return {
          id,
          symbol: meta?.symbol ?? id,
          color: COMPARE_COLORS[i % COMPARE_COLORS.length],
          netFlow24hUsd: coin.netFlow24hUsd,
          pressureShiftScore: coin.pressureShiftScore ?? null,
          netFlowDirection24h,
          pressureShiftState,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [selectedIds, flowData]);

  const detailLoading = detailQueries.some((q) => q.isLoading);
  const handleRetry = useCallback(() => {
    void Promise.allSettled([
      refetchList(),
      refetchPeg(),
      refetchBluechip(),
      refetchLiquidity(),
      refetchReportCards(),
      ...detailQueries.map((q) => q.refetch()),
    ]);
  }, [detailQueries, refetchBluechip, refetchLiquidity, refetchList, refetchPeg, refetchReportCards]);

  const handleSelect = (slotIndex: number, coin: CoinOption) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      if (slotIndex < prev.length) {
        next[slotIndex] = coin.id;
      } else {
        next.push(coin.id);
      }
      if (next.length >= 2 && prev.length < 2) {
        trackEvent("comparison_created", {
          coin_count: next.length,
          coin_ids: next.slice(0, 5).join(","),
        });
      }
      return next;
    });
  };

  const handleRemove = (slotIndex: number) => {
    setSelectedIds((prev) => prev.filter((_, i) => i !== slotIndex));
  };

  const [shareLoading, setShareLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const buildShareData = useCallback(async (): Promise<{
    coins: ShareCoinData[];
    pharosLogo: HTMLImageElement;
    radarData?: ShareRadarData;
  } | null> => {
    if (comparisonCoins.length < 2) return null;

    // Preload Pharos logo
    const pharosLogo = await loadImage("/pharos-icon.png");
    if (!pharosLogo) return null;

    // Preload coin logos in parallel
    const logoImgs = await Promise.all(
      comparisonCoins.map((c) => {
        const src = logos?.[c.id];
        return src ? loadImage(src) : Promise.resolve(null);
      }),
    );

    // Build formatted stats
    const shareCoins: ShareCoinData[] = comparisonCoins.map((coin, i) => {
      const cap = getCirculatingRaw(coin.data);
      const prev = getPrevWeekRaw(coin.data);
      const weeklyPct = prev > 0 ? ((cap - prev) / prev) * 100 : null;
      const pegRef = getPegReference(coin.data.pegType, pegRates, coin.meta.commodityOunces);

      return {
        symbol: coin.symbol,
        name: coin.name,
        price: formatNativePrice(coin.data.price, coin.meta.flags.pegCurrency, pegRef),
        marketCap: formatCurrency(cap),
        pegScore: coin.pegScore != null ? `${coin.pegScore.toFixed(1)}` : "—",
        weeklyChange: weeklyPct != null ? `${weeklyPct >= 0 ? "+" : ""}${weeklyPct.toFixed(2)}%` : "—",
        weeklyChangePositive: weeklyPct != null ? weeklyPct >= 0 : true,
        liquidityScore: coin.liquidityScore != null ? `${coin.liquidityScore.toFixed(1)}` : "—",
        governance: GOVERNANCE_LABELS_SHORT[coin.meta.flags.governance] ?? coin.meta.flags.governance,
        backing: BACKING_LABELS_SHORT[coin.meta.flags.backing] ?? coin.meta.flags.backing,
        pegCurrency: coin.meta.flags.pegCurrency,
        safetyRating: coin.safetyGrade,
        logoImg: logoImgs[i],
      };
    });

    // Build radar data when ≥ 2 coins have report cards
    let radarData: ShareRadarData | undefined;
    if (radarCards.length >= 2) {
      radarData = {
        dimensionLabels: DIMENSION_ORDER.map((k) => DIMENSION_SHORT_LABELS[k]),
        coins: radarCards.map(({ card, color }) => ({
          symbol: card.symbol,
          overallGrade: card.overallGrade,
          color,
          scores: DIMENSION_ORDER.map((k) => card.dimensions[k]?.score ?? 0),
        })),
      };
    }

    return { coins: shareCoins, pharosLogo, radarData };
  }, [comparisonCoins, logos, pegRates, radarCards]);

  const handleTwitterShare = useCallback(async () => {
    setShareLoading(true);
    try {
      // Generate and copy image to clipboard so the user can paste it into the tweet
      const data = await buildShareData();
      if (data) {
        const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData);
        const blob = await canvasToBlob(canvas);
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          setToast("Image copied! Paste it in your tweet (Ctrl+V)");
          setTimeout(() => setToast(null), 5000);
        } catch {
          // Clipboard image write not supported — open intent anyway
        }
      }
    } finally {
      setShareLoading(false);
    }
    trackEvent("comparison_exported", { method: "tweet", coin_count: comparisonCoins.length });
    const symbols = comparisonCoins.map((c) => c.symbol).join(" vs ");
    const text = `Comparing ${symbols} on Pharos`;
    const url = window.location.href;
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [buildShareData, comparisonCoins]);

  const handleWebShare = useCallback(async () => {
    setShareLoading(true);
    trackEvent("comparison_exported", { method: "share", coin_count: comparisonCoins.length });
    try {
      const data = await buildShareData();
      if (!data) return;
      const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData);
      const blob = await canvasToBlob(canvas);
      const file = new File([blob], "pharos-compare.png", { type: "image/png" });
      const symbols = comparisonCoins.map((c) => c.symbol).join(" vs ");

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: `${symbols} on Pharos Compare`,
          text: `Comparing ${symbols} on Pharos`,
          url: window.location.href,
          files: [file],
        });
      } else {
        // Fallback: copy image to clipboard
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          setToast("Image copied to clipboard");
          setTimeout(() => setToast(null), 3000);
        } catch {
          await navigator.clipboard.writeText(window.location.href);
          setToast("Link copied to clipboard");
          setTimeout(() => setToast(null), 3000);
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name !== "AbortError") {
        console.warn("Share failed:", e);
      }
    } finally {
      setShareLoading(false);
    }
  }, [buildShareData, comparisonCoins]);

  const handleDownload = useCallback(async () => {
    setShareLoading(true);
    try {
      const data = await buildShareData();
      if (!data) return;
      const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData);
      const blob = await canvasToBlob(canvas);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "pharos-compare.png";
      a.click();
      URL.revokeObjectURL(url);
      trackEvent("comparison_exported", { method: "download", coin_count: comparisonCoins.length });
    } finally {
      setShareLoading(false);
    }
  }, [buildShareData, comparisonCoins]);

  // Render selector slots (filled slots + empty slots up to MAX_COINS)
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
      <QueryErrorNotice error={globalError} hasData={!!listData?.peggedAssets?.length} onRetry={handleRetry} />
      <StaleDataBanner
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error: listError, hasData: !!listData?.peggedAssets?.length },
          { preset: "pegSummary", dataUpdatedAt: pegUpdatedAt, error: pegError, hasData: !!pegSummary?.coins?.length },
          { preset: "dexLiquidity", dataUpdatedAt: liqUpdatedAt, error: dexError, hasData: !!dexData },
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
          },
          { preset: "bluechip", dataUpdatedAt: bcUpdatedAt, error: bluechipError, hasData: !!bluechipData },
        ]}
      />
      {selectedIds.length >= 2 && (
        <div className="flex items-center justify-end gap-2">
          {toast && <span className="text-xs text-muted-foreground animate-in fade-in duration-300">{toast}</span>}
          <button
            onClick={handleTwitterShare}
            disabled={shareLoading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
            title="Share on Twitter/X"
          >
            <Twitter className="h-3.5 w-3.5" />
            Tweet
          </button>
          <button
            onClick={handleWebShare}
            disabled={shareLoading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
            title="Share comparison"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share
          </button>
          <button
            onClick={handleDownload}
            disabled={shareLoading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
            title="Download comparison image"
          >
            <Download className="h-3.5 w-3.5" />
            Image
          </button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{slots}</div>

      {selectedIds.length < 2 && (
        <CompareEmptyState
          presets={COMPARISON_PRESETS}
          logos={logos}
          onApplyPreset={(preset) => {
            trackEvent("comparison_preset_selected", {
              preset: preset.title,
            });
            replaceParams((params) => {
              params.set("coins", preset.coins.join(","));
              params.delete("range");
            });
          }}
        />
      )}

      {selectedIds.length >= 2 && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <ComparisonTable coins={comparisonCoins} pegRates={pegRates} logos={logos} detailErrors={detailErrors} />

          {/* Live Flow Signals */}
          {(flowCardData.length > 0 || flowSeries.length > 0) && (
            <div className="rounded-2xl border border-border/60 bg-card/50 p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Live Flow Signals
                </h3>
                {flowData?.updatedAt && (
                  <span className="text-xs text-muted-foreground">
                    Updated {Math.round((Date.now() / 1000 - flowData.updatedAt) / 60)} min ago · Ethereum
                  </span>
                )}
              </div>

              {/* Per-coin flow cards */}
              {flowCardData.length > 0 && (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${Math.min(flowCardData.length, 5)}, minmax(0, 1fr))` }}
                >
                  {flowCardData.map((card) => (
                    <CoinFlowCard key={card.id} {...card} />
                  ))}
                </div>
              )}

              {/* Net flow chart */}
              {flowSeries.length >= 2 && (
                <FlowComparisonChart
                  series={flowSeries}
                  hours={flowHours}
                  onHoursChange={(h) => setFlowHours(h as 24 | 168 | 720)}
                />
              )}

              {/* Coverage note */}
              {selectedIds.length > flowCardData.length && (
                <p className="text-xs text-muted-foreground">
                  {flowCardData.length} of {selectedIds.length} selected coins have Ethereum flow tracking.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {detailLoading ? (
              <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />
            ) : (
              supplySeries.length >= 2 && (
                <ComparisonChart
                  title="Market Cap History Comparison"
                  series={supplySeries}
                  formatValue={formatCurrency}
                  range={range}
                  onRangeChange={setRange}
                  normalizable
                />
              )
            )}

            {radarCards.length >= 2 && (
              <Card className="h-full flex flex-col">
                <CardHeader>
                  <CardTitle className="text-lg">Safety Score Comparison</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col items-center justify-center">
                  <CompareRadar cards={radarCards} size={350} />
                  <div className="flex flex-wrap gap-3 justify-center mt-3">
                    {radarCards.map(({ card, color }) => (
                      <div key={card.id} className="flex items-center gap-1.5 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                        <span>
                          {card.symbol}: {card.overallGrade}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
