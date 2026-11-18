"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import { canvasToBlob, loadImage, renderCompareShareImage } from "@/lib/compare-share-image";
import { copyText } from "@/lib/clipboard";
import { triggerBlobDownload } from "@/lib/exports/download";
import type { ShareCoinData, ShareRadarData } from "@/lib/compare-share-image";
import { formatCurrency } from "@shared/lib/format";
import { formatComparisonPrice } from "@/lib/current-peg";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { GOVERNANCE_LABELS_SHORT, BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { getSupplyChangePercent } from "@/components/stablecoin-directory/stablecoin-table-logic";
import type { StablecoinData } from "@shared/types/supply";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { ComparisonMeta } from "@/lib/compare-derive";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

interface CompareCoinForShare {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: ComparisonMeta;
  navPriceReference?: number | null;
  pegDetails?: PegSummaryCoin | null;
  liquidity?: { liquidityScore: number | null } | null;
  safetyCard?: Pick<SafetyScoreV9CurrentCard, "grade" | "ratingStatus" | "partialEvidence"> | null;
}

interface CompareRadarCard {
  symbol: string;
  card: Pick<SafetyScoreV9CurrentCard, "grade" | "ratingStatus" | "pillars">;
  color: string;
}

interface UseCompareShareActionsOptions {
  comparisonCoins: CompareCoinForShare[];
  logos: Record<string, string> | undefined;
  radarCards: CompareRadarCard[];
  axisOrder: readonly string[];
  axisLabels: Record<string, string>;
  /** Oldest producer generation behind the exported figures; null omits the stamp. */
  asOfUpdatedAt: number | null;
}

export function useCompareShareActions({
  comparisonCoins,
  logos,
  radarCards,
  axisOrder,
  axisLabels,
  asOfUpdatedAt,
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
    asOfUpdatedAt: number | null;
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
      const cap = getCirculatingRawOrNull(coin.data);
      const weeklyPct = getSupplyChangePercent(coin.data, "week");
      const navReference = coin.meta.flags.navToken ? coin.navPriceReference ?? null : undefined;

      return {
        symbol: coin.symbol,
        name: coin.name,
        price: formatComparisonPrice(coin.data, coin.meta.flags.pegCurrency ?? "USD", navReference, coin.pegDetails),
        marketCap: cap != null ? formatCurrency(cap) : "—",
        pegScore: coin.pegDetails?.pegScore != null ? `${coin.pegDetails.pegScore.toFixed(1)}` : "—",
        weeklyChange: weeklyPct != null ? `${weeklyPct >= 0 ? "+" : ""}${weeklyPct.toFixed(2)}%` : "—",
        liquidityScore: coin.liquidity?.liquidityScore != null ? `${coin.liquidity.liquidityScore.toFixed(1)}` : "—",
        governance: GOVERNANCE_LABELS_SHORT[coin.meta.flags.governance] ?? coin.meta.flags.governance,
        backing: BACKING_LABELS_SHORT[coin.meta.flags.backing] ?? coin.meta.flags.backing,
        pegCurrency: coin.meta.flags.pegCurrency,
        safetyRating: coin.safetyCard?.ratingStatus === "pipeline-gap" ? "Pipeline gap"
          : coin.safetyCard ? `${coin.safetyCard.grade}${coin.safetyCard.partialEvidence === null ? "" : " · Partial evidence"}` : null,
        logoImg: logoImages[index],
      };
    });

    let radarData: ShareRadarData | undefined;
    if (radarCards.length >= 2 && radarCards.every(({ card }) =>
      card.ratingStatus === "rated" && card.grade !== null && axisOrder.every((key) =>
        card.pillars[key as keyof typeof card.pillars]?.score != null))) {
      radarData = {
        dimensionLabels: axisOrder.map((key) => axisLabels[key] ?? key),
        coins: radarCards.map(({ card, color, symbol }) => ({
          symbol,
          overallGrade: card.grade!,
          color,
          scores: axisOrder.map((key) => card.pillars[key as keyof typeof card.pillars].score!),
        })),
      };
    }

    return { coins: shareCoins, pharosLogo, radarData, asOfUpdatedAt };
  }, [asOfUpdatedAt, axisLabels, axisOrder, comparisonCoins, logos, radarCards]);

  const handleTwitterShare = useCallback(async () => {
    setShareLoading(true);
    try {
      const data = await buildShareData();
      if (data) {
        const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData, data.asOfUpdatedAt);
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
      const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData, data.asOfUpdatedAt);
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
          const result = await copyText(window.location.href);
          if (result.ok) {
            showToast("Link copied to clipboard", 3000);
          } else {
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
      const canvas = renderCompareShareImage(data.coins, data.pharosLogo, data.radarData, data.asOfUpdatedAt);
      if (!canvas) return;
      const blob = await canvasToBlob(canvas);
      triggerBlobDownload(blob, "pharos-compare.png", "sync");
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
