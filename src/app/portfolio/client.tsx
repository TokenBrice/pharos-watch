"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { usePortfolio } from "@/hooks/use-portfolio";
import { trackEvent } from "@/lib/analytics";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { encodePortfolioHoldings } from "@/lib/portfolio-codec";
import { PortfolioEmptyState } from "@/components/portfolio-empty-state";
import type { PortfolioPreset } from "@/components/portfolio-empty-state";
import {
  PortfolioGradesSection,
  PortfolioHoldingsEditor,
  PortfolioLoadingState,
  PortfolioSummaryCard,
} from "./components";
import { buildHeldCardIds, buildHeldCards, buildPortfolioRadarCard } from "./model";
import { PORTFOLIO_PRESETS } from "./presets";

// ---------------------------------------------------------------------------
// PortfolioClient
// ---------------------------------------------------------------------------

export function PortfolioClient() {
  const {
    data: reportData,
    isLoading: isLoadingCards,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCards();
  const { data: logos } = useLogos();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [showUpstreamDetail, setShowUpstreamDetail] = useState(false);

  const portfolio = usePortfolio(reportData?.cards);

  const exposureToShow = showUpstreamDetail ? portfolio.upstreamExposure : portfolio.upstreamExposureGrouped;

  // Clean up toast timer on unmount
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // URL sync: keep query string in sync with portfolio holdings
  const { setParam } = useUrlFilters();

  useEffect(() => {
    if (!portfolio.initialized) return;

    const encoded = encodePortfolioHoldings(portfolio.holdings);
    setParam("p", encoded);
  }, [portfolio.holdings, portfolio.initialized, setParam]);

  const portfolioRadarCard = useMemo(
    () =>
      buildPortfolioRadarCard({
        holdingCount: portfolio.holdings.length,
        portfolioGrade: portfolio.portfolioGrade,
        portfolioScore: portfolio.portfolioScore,
        dimensionScores: portfolio.dimensionScores,
      }),
    [portfolio.holdings.length, portfolio.portfolioGrade, portfolio.portfolioScore, portfolio.dimensionScores],
  );

  const heldCardIds = useMemo(() => buildHeldCardIds(portfolio.holdings), [portfolio.holdings]);

  const heldCards = useMemo(
    () => buildHeldCards(reportData?.cards, heldCardIds),
    [reportData?.cards, heldCardIds],
  );

  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      trackEvent("portfolio_shared", { coin_count: portfolio.holdings.length });
      setToast("Link copied to clipboard");
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);

  const handleClear = useCallback(() => {
    trackEvent("portfolio_cleared", { coin_count: portfolio.holdings.length });
    portfolio.clearAll();
  }, [portfolio]);

  const handleApplyPreset = useCallback(
    (preset: PortfolioPreset) => {
      trackEvent("portfolio_preset_loaded", { preset: preset.title });
      portfolio.clearAll();
      for (const holding of preset.holdings) {
        portfolio.addCoin(holding.coinId, holding.amount);
      }
    },
    [portfolio],
  );

  if (isLoadingCards) {
    return <PortfolioLoadingState />;
  }

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={reportCardsError}
        hasData={!!reportData?.cards?.length}
        onRetry={() => {
          void refetchReportCards();
        }}
        queries={[
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportData?.cards?.length,
            meta: reportCardsMeta,
          },
        ]}
      />
      <PortfolioHoldingsEditor
        holdings={portfolio.holdings}
        heldCardIds={heldCardIds}
        logos={logos}
        toast={toast}
        onSetAmount={portfolio.setAmount}
        onRemove={(coinId) => {
          trackEvent("portfolio_coin_removed", { coin_id: coinId });
          portfolio.removeCoin(coinId);
        }}
        onSelectCoin={(coin) => {
          trackEvent("portfolio_coin_added", { coin_id: coin.id });
          portfolio.addCoin(coin.id, 0);
        }}
        onShare={() => {
          void handleShare();
        }}
        onClear={handleClear}
      />

      {portfolio.holdings.length === 0 && (
        <PortfolioEmptyState presets={PORTFOLIO_PRESETS} logos={logos} onApplyPreset={handleApplyPreset} />
      )}

      {portfolio.holdings.length > 0 && reportData?.cards && (
        <PortfolioSummaryCard
          portfolioGrade={portfolio.portfolioGrade}
          portfolioScore={portfolio.portfolioScore}
          totalUsd={portfolio.totalUsd}
          radarCard={portfolioRadarCard}
          exposureToShow={exposureToShow}
          showUpstreamDetail={showUpstreamDetail}
          onShowUpstreamDetailChange={setShowUpstreamDetail}
        />
      )}

      {portfolio.holdings.length > 0 && (
        <PortfolioGradesSection heldCards={heldCards} logos={logos} />
      )}
    </div>
  );
}
