"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import Link from "next/link";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";
import { usePortfolio } from "@/hooks/use-portfolio";
import { trackEvent } from "@/lib/analytics";
import { copyText } from "@/lib/clipboard";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { encodePortfolioHoldings } from "@/lib/portfolio-codec";
import { PortfolioEmptyState } from "@/components/portfolio-empty-state";
import type { PortfolioPreset } from "@/components/portfolio-empty-state";
import {
  PortfolioHeroStrip,
  PortfolioHoldingsEditor,
  PortfolioLoadingState,
} from "./components";
import { buildHeldCardIds } from "./model";
import { PORTFOLIO_PRESETS } from "./presets";
import { buildV9PortfolioProjection } from "@/lib/safety-score-v9-consumers";
import { Card, CardContent } from "@/components/ui/card";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";

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
  } = useReportCardsV9();
  const logos = logosById;
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Wait for the browser URL snapshot before exposing or writing holdings;
  // the portfolio bootstrap preserves incoming shares during hydration.
  const { getParam, isReady, setParam } = useUrlFilters();
  const portfolio = usePortfolio(getParam("p"), isReady);

  // Clean up toast timer on unmount
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  useEffect(() => {
    if (!portfolio.initialized) return;

    const encoded = encodePortfolioHoldings(portfolio.holdings);
    setParam("p", encoded);
  }, [portfolio.holdings, portfolio.initialized, setParam]);

  const heldCardIds = useMemo(() => buildHeldCardIds(portfolio.holdings), [portfolio.holdings]);

  const heldCards = useMemo(
    () => (reportData?.cards ?? []).filter((card) => heldCardIds.has(card.id)),
    [reportData?.cards, heldCardIds],
  );
  const v9Projection = useMemo(
    () => reportData
      ? buildV9PortfolioProjection(reportData, reportData.safetyScoreIdentity, portfolio.holdings)
      : null,
    [portfolio.holdings, reportData],
  );

  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    const result = await copyText(url);
    if (result.ok) {
      trackEvent("portfolio_shared", { coin_count: portfolio.holdings.length });
      setToast("Link copied to clipboard");
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 2500);
    } else {
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
      <SafetyScoreV9StatusNotice response={reportData} />
      <PortfolioHeroStrip holdingCount={portfolio.holdings.length} totalUsd={portfolio.totalUsd} />
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

      {portfolio.holdings.length > 0 && v9Projection?.status === "available" && (
        <Card className="pharos-card-shell">
          <CardContent className="space-y-5 pt-6">
            <div>
              <p className="pharos-kicker">Weighted V9 safety aggregate</p>
              <p className="mt-1 pharos-numeric text-3xl font-semibold text-foreground">
                {v9Projection.value.score}<span className="text-sm text-muted-foreground">/100</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Portfolio aggregate only; this is not an asset safety grade.
              </p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-3">
              {Object.entries(v9Projection.value.pillars).map(([pillar, score]) => (
                <div key={pillar} className="rounded-lg border border-border/60 px-3 py-3">
                  <dt className="pharos-kicker">{pillar === "control" ? "Economic control" : pillar}</dt>
                  <dd className="mt-1 pharos-numeric text-lg font-semibold">{score}/100</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {v9Projection.value.dependencyExposure.length} modeled upstream exposure{" "}
              {v9Projection.value.dependencyExposure.length === 1 ? "route" : "routes"} across these holdings.
            </p>
          </CardContent>
        </Card>
      )}

      {portfolio.holdings.length > 0 && (
        <>
          <h2 className="pharos-kicker">Holdings Safety Grades</h2>
          {v9Projection?.status === "unavailable" ? (
            <p className="text-sm text-muted-foreground" role="alert">
              V9 portfolio safety is unavailable ({v9Projection.reason}).
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {heldCards.map((card) => {
                const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
                return (
                  <Link key={card.id} href={buildStablecoinUrl(card.id)} className="pharos-card-shell p-3">
                    <p className="truncate text-sm font-medium">{meta?.symbol ?? card.id}</p>
                    <SafetyGradeBadge grade={card.grade} score={card.score} showScore size="sm" className="mt-2" />
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
