"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import { canvasToBlob, loadImage, renderCompareShareImage } from "@/lib/compare-share-image";
import type { ShareCoinData, ShareRadarData } from "@/lib/compare-share-image";
import { formatCurrency, formatNativePrice } from "@shared/lib/format";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { getPegReference } from "@shared/lib/peg-rates";
import { GOVERNANCE_LABELS_SHORT, BACKING_LABELS_SHORT } from "@shared/lib/classification";
import type { StablecoinData } from "@shared/types";
import type { ComparisonMeta } from "@/lib/compare-derive";

interface CompareCoinForShare {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: ComparisonMeta;
  pegScore: number | null;
  liquidityScore: number | null;
  safetyGrade: string | null;
}

interface CompareRadarCard {
  symbol: string;
  card: {
    grade: string;
    pillars: Record<string, { score: number | null }>;
  };
  color: string;
}

interface UseCompareShareActionsOptions {
  comparisonCoins: CompareCoinForShare[];
  logos: Record<string, string> | undefined;
  pegRates: Record<string, number>;
  radarCards: CompareRadarCard[];
  axisOrder: readonly string[];
  axisLabels: Record<string, string>;
}

export function useCompareShareActions({
  comparisonCoins,
  logos,
  pegRates,
  radarCards,
  axisOrder,
  axisLabels,
}: UseCompareShareActionsOptions) {
  const [shareLoading, setShareLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((message: string, durationMs: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, durationMs);
  }, []);

  const buildShareData = useCallback(async (): Promise<{
    coins: ShareCoinData[];
    pharosLogo: HTMLImageElement;
    radarData?: ShareRadarData;
  } | null> => {
    if (comparisonCoins.length < 2) return null;

    const pharosLogo = await loadImage("/pharos-mark.png");
    if (!pharosLogo) return null;

    const logoImages = await Promise.all(
      comparisonCoins.map((coin) => {
        const src = logos?.[coin.id];
        return src ? loadImage(src) : Promise.resolve(null);
      }),
    );

    const shareCoins: ShareCoinData[] = comparisonCoins.map((coin, index) => {
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
        logoImg: logoImages[index],
      };
    });

    let radarData: ShareRadarData | undefined;
    if (radarCards.length >= 2) {
      radarData = {
        dimensionLabels: axisOrder.map((key) => axisLabels[key] ?? key),
        coins: radarCards.map(({ card, color, symbol }) => ({
          symbol,
          overallGrade: card.grade,
          color,
          scores: axisOrder.map((key) => card.pillars[key]?.score ?? 0),
        })),
      };
    }

    return { coins: shareCoins, pharosLogo, radarData };
  }, [axisLabels, axisOrder, comparisonCoins, logos, pegRates, radarCards]);

  const handleTwitterShare = useCallback(async () => {
    setShareLoading(true);
    try {
      const data = await buildShareData();
      if (data) {
        const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData);
        if (canvas) {
          const blob = await canvasToBlob(canvas);
          try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            showToast("Image copied! Paste it in your tweet (Ctrl+V)", 5000);
          } catch {
            // Clipboard image write not supported — continue to intent URL.
          }
        }
      }
    } catch (error) {
      console.warn("Share image render failed:", error);
      showToast("Couldn't generate the share image", 3000);
    } finally {
      setShareLoading(false);
    }

    trackEvent("comparison_exported", { method: "tweet", coin_count: comparisonCoins.length });
    const symbols = comparisonCoins.map((coin) => coin.symbol).join(" vs ");
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Comparing ${symbols} on Pharos`)}&url=${encodeURIComponent(window.location.href)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [buildShareData, comparisonCoins, showToast]);

  const handleWebShare = useCallback(async () => {
    setShareLoading(true);
    trackEvent("comparison_exported", { method: "share", coin_count: comparisonCoins.length });
    try {
      const data = await buildShareData();
      if (!data) return;
      const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData);
      if (!canvas) return;
      const blob = await canvasToBlob(canvas);
      const file = new File([blob], "pharos-compare.png", { type: "image/png" });
      const symbols = comparisonCoins.map((coin) => coin.symbol).join(" vs ");

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: `${symbols} on Pharos Compare`,
          text: `Comparing ${symbols} on Pharos`,
          url: window.location.href,
          files: [file],
        });
      } else {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          showToast("Image copied to clipboard", 3000);
        } catch {
          try {
            await navigator.clipboard.writeText(window.location.href);
            showToast("Link copied to clipboard", 3000);
          } catch {
            showToast("Could not copy to clipboard", 3000);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        console.warn("Share failed:", error);
      }
    } finally {
      setShareLoading(false);
    }
  }, [buildShareData, comparisonCoins, showToast]);

  const handleDownload = useCallback(async () => {
    setShareLoading(true);
    try {
      const data = await buildShareData();
      if (!data) return;
      const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData);
      if (!canvas) return;
      const blob = await canvasToBlob(canvas);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "pharos-compare.png";
      anchor.click();
      URL.revokeObjectURL(url);
      trackEvent("comparison_exported", { method: "download", coin_count: comparisonCoins.length });
    } catch (error) {
      console.warn("Share image render failed:", error);
      showToast("Couldn't generate the share image", 3000);
    } finally {
      setShareLoading(false);
    }
  }, [buildShareData, comparisonCoins, showToast]);

  return {
    shareLoading,
    toast,
    handleTwitterShare,
    handleWebShare,
    handleDownload,
  };
}
