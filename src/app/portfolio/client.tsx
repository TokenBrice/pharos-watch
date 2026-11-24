"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import Link from "next/link";
import { useReportCardsV9Table } from "@/hooks/api-hooks";
import { useCoinStates } from "@/hooks/use-coin-states";
import { useWatchlist } from "@/hooks/use-watchlist";
import { CoinStateChip } from "@/components/coin-state-chip";
import { logosById } from "@/lib/logos";
import { usePortfolio } from "@/hooks/use-portfolio";
import { trackEvent } from "@/lib/analytics";
import { copyText } from "@/lib/clipboard";
import { MAX_COMPARE_COINS } from "@/lib/compare-config";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { encodePortfolioHoldings, mergeCoinsParam } from "@/lib/portfolio-codec";
import { PortfolioEmptyState } from "@/components/portfolio/portfolio-empty-state";
import type { PortfolioPreset } from "@/components/portfolio/portfolio-empty-state";
import { TelegramSubscribeCommand } from "@/components/selector/telegram-subscribe-command";
import {
  PortfolioConcentrationCard,
  PortfolioHeroStrip,
  PortfolioHoldingsEditor,
  PortfolioLoadingState,
  PortfolioStateCallout,
  PortfolioUpstreamExposureCard,
} from "./components";
import {
  PORTFOLIO_COIN_OPTION_IDS,
  buildHeldCardIds,
  computePortfolioConcentrations,
  groupDependencyExposure,
  rankExceptionalHoldings,
} from "./model";
import { PORTFOLIO_PRESETS } from "./presets";
import { buildV9PortfolioProjection } from "@/lib/safety-score-v9-consumers";
import { Card, CardContent } from "@/components/ui/card";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { isClientTokenizedFundId } from "@shared/lib/stablecoins/aggregate-client-registry";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { ECONOMIC_CONTROL_LABEL } from "@shared/lib/classification";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";

// ---------------------------------------------------------------------------
// PortfolioClient
// ---------------------------------------------------------------------------

function holdingSymbols(ids: readonly string[]): string {
  return ids.map((id) => CLIENT_TRACKED_META_BY_ID.get(id)?.symbol ?? id).join(", ");
}

function pillarLabel(pillar: "backing" | "exit" | "control"): string {
  if (pillar === "backing") return "Backing";
  if (pillar === "exit") return "Exit";
  return ECONOMIC_CONTROL_LABEL;
}

function pillarFillClass(score: number): string {
  if (score < 40) return "bg-[var(--severity-severe)]";
  if (score < 60) return "bg-[var(--severity-moderate)]";
  return "bg-[var(--chart-primary)]";
}

export function PortfolioClient() {
  const logos = logosById;
  const watchlist = useWatchlist();
  const [toast, setToast] = useState<string | null>(null);
  const [shareFallbackUrl, setShareFallbackUrl] = useState<string | null>(null);
  const [lastAddedCoinId, setLastAddedCoinId] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Wait for the browser URL snapshot before exposing or writing holdings;
  // the portfolio bootstrap preserves incoming shares during hydration.
  const { getParam, isReady, setParams } = useUrlFilters();
  const portfolio = usePortfolio(mergeCoinsParam(getParam("p"), getParam("coins")), isReady);
  const {
    data: reportData,
    isLoading: isLoadingCards,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCardsV9Table({ enabled: portfolio.initialized && portfolio.holdings.length > 0 });
  const coinStates = useCoinStates({ enabled: portfolio.initialized && portfolio.holdings.length > 0 });
  const exceptionalHoldings = useMemo(
    () => rankExceptionalHoldings(portfolio.holdings, coinStates.byId),
    [coinStates.byId, portfolio.holdings],
  );

  // Clean up toast timer on unmount
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    if (!portfolio.initialized) return;

    const encoded = encodePortfolioHoldings(portfolio.holdings);
    setParams({ p: encoded, coins: "" });
  }, [portfolio.holdings, portfolio.initialized, setParams]);

  const heldCardIds = useMemo(() => buildHeldCardIds(portfolio.holdings), [portfolio.holdings]);

  const importableWatchlistIds = useMemo(() => {
    if (!portfolio.initialized) return [];
    return watchlist.ids.filter(
      (coinId) => PORTFOLIO_COIN_OPTION_IDS.has(coinId) && !heldCardIds.has(coinId),
    );
  }, [portfolio.initialized, watchlist.ids, heldCardIds]);

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
  const groupedExposure = useMemo(
    () =>
      v9Projection?.status === "available"
        ? groupDependencyExposure(v9Projection.value.dependencyExposure, portfolio.totalUsd)
        : [],
    [v9Projection, portfolio.totalUsd],
  );
  const concentrations = useMemo(
    () => computePortfolioConcentrations(portfolio.holdings),
    [portfolio.holdings],
  );

  const compareHref = useMemo(() => {
    if (portfolio.holdings.length === 0) return undefined;
    return buildLiveCompareUrl(portfolio.holdings.slice(0, MAX_COMPARE_COINS).map((h) => h.coinId));
  }, [portfolio.holdings]);

  const upstreamTraceHref = useMemo(() => {
    if (portfolio.holdings.length === 0) return undefined;
    const primaryRoot = groupedExposure[0]?.upstreamAssetId ?? portfolio.holdings[0]?.coinId;
    return primaryRoot
      ? `/dependency-map/?mode=exposure&root=${encodeURIComponent(primaryRoot)}`
      : "/dependency-map/?mode=exposure";
  }, [groupedExposure, portfolio.holdings]);

  const portfolioCoinIds = useMemo(
    () => portfolio.holdings.map((holding) => holding.coinId),
    [portfolio.holdings],
  );

  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    const result = await copyText(url);
    if (result.ok) {
      setShareFallbackUrl(null);
      trackEvent("portfolio_shared", { coin_count: portfolio.holdings.length });
      showToast("Link copied to clipboard");
    } else {
      setShareFallbackUrl(url);
      showToast("Clipboard blocked. Copy the link below.");
    }
  }, [portfolio, showToast]);

  const handleClear = useCallback(() => {
    setShareFallbackUrl(null);
    setLastAddedCoinId(null);
    trackEvent("portfolio_cleared", { coin_count: portfolio.holdings.length });
    portfolio.clearAll();
  }, [portfolio]);

  const handleApplyPreset = useCallback(
    (preset: PortfolioPreset) => {
      setShareFallbackUrl(null);
      setLastAddedCoinId(null);
      trackEvent("portfolio_preset_loaded", { preset: preset.title });
      portfolio.clearAll();
      for (const holding of preset.holdings) {
        portfolio.addCoin(holding.coinId, holding.amount);
      }
    },
    [portfolio],
  );

  const handleImportWatchlist = useCallback(() => {
    if (importableWatchlistIds.length === 0) return;
    setShareFallbackUrl(null);
    for (const coinId of importableWatchlistIds) {
      portfolio.addCoin(coinId, 0);
    }
    setLastAddedCoinId(importableWatchlistIds[0] ?? null);
    trackEvent("portfolio_watchlist_imported", { coin_count: importableWatchlistIds.length });
    showToast(
      `Imported ${importableWatchlistIds.length} watchlist ${importableWatchlistIds.length === 1 ? "coin" : "coins"}. Enter USD amounts.`,
    );
  }, [importableWatchlistIds, portfolio, showToast]);

  const handleSelectCoin = useCallback(
    (coin: { id: string }) => {
      setShareFallbackUrl(null);
      trackEvent("portfolio_coin_added", { coin_id: coin.id });
      portfolio.addCoin(coin.id, 0);
      setLastAddedCoinId(coin.id);
    },
    [portfolio],
  );

  const handleAutoFocusHandled = useCallback(() => {
    setLastAddedCoinId(null);
  }, []);

  return (
    <div>
      <div className={portfolio.initialized ? "space-y-6" : "hidden space-y-6 [html[data-portfolio-empty]_&]:block"}>
        {portfolio.holdings.length > 0 && (
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
        )}

        <PortfolioHeroStrip
          holdingCount={portfolio.holdings.length}
          totalUsd={portfolio.totalUsd}
          faceValueNote={exceptionalHoldings.length > 0}
          compareHref={compareHref}
          upstreamTraceHref={upstreamTraceHref}
        />

        <PortfolioStateCallout holdings={exceptionalHoldings} totalUsd={portfolio.totalUsd} />

        <PortfolioHoldingsEditor
          holdings={portfolio.holdings}
          totalUsd={portfolio.totalUsd}
          heldCardIds={heldCardIds}
          autoFocusCoinId={lastAddedCoinId}
          onAutoFocusHandled={handleAutoFocusHandled}
          coinStatesById={coinStates.byId}
          logos={logos}
          toast={toast}
          shareFallbackUrl={shareFallbackUrl}
          onDismissShareFallback={() => setShareFallbackUrl(null)}
          presets={PORTFOLIO_PRESETS}
          onApplyPreset={handleApplyPreset}
          importableWatchlistCount={importableWatchlistIds.length}
          onImportWatchlist={handleImportWatchlist}
          onSetAmount={portfolio.setAmount}
          onRemove={(coinId) => {
            setShareFallbackUrl(null);
            trackEvent("portfolio_coin_removed", { coin_id: coinId });
            portfolio.removeCoin(coinId);
          }}
          onSelectCoin={handleSelectCoin}
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
                <p className="pharos-label">
                  {v9Projection.value.partialEvidence
                    ? "Known-only weighted safety subtotal"
                    : "Weighted safety aggregate"}
                </p>
                <p className="mt-1 pharos-numeric text-3xl font-semibold text-foreground">
                  {v9Projection.value.score === null ? (
                    "Pipeline gap"
                  ) : (
                    <>
                      {v9Projection.value.score}
                      <span className="text-sm text-muted-foreground">/100</span>
                    </>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Portfolio aggregate only; this is not an asset safety grade.
                </p>
                {v9Projection.value.partialEvidence && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Partial evidence. Known-only score covers {v9Projection.value.coverageUsd.score} USD of{" "}
                    {v9Projection.value.coverageUsd.total} USD
                    {v9Projection.value.coverageUsd.excludedIds.score.length > 0 &&
                      ` (excludes ${holdingSymbols(v9Projection.value.coverageUsd.excludedIds.score)})`}
                    ; unavailable holdings and pillar readings are excluded from these subtotals, not scored as zero.
                    Rated holding scores retain any priced-unknown assumptions described below.
                  </p>
                )}
              </div>

              <dl className="grid gap-3 sm:grid-cols-3">
                {(["backing", "exit", "control"] as const).map((pillar) => {
                  const score = v9Projection.value.pillars[pillar];
                  const bounded = score === null ? null : Math.max(0, Math.min(100, score));
                  const label = pillarLabel(pillar);
                  return (
                    <div key={pillar} className="space-y-2 rounded-lg border border-border/60 px-3 py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="pharos-label">
                          {label}
                          {v9Projection.value.partialEvidence && " · known-only subtotal"}
                        </dt>
                        <dd className="pharos-numeric text-base font-semibold text-foreground">
                          {score === null ? "Unavailable" : `${score}/100`}
                        </dd>
                      </div>
                      <div
                        aria-hidden="true"
                        className={
                          bounded === null
                            ? "h-2 w-full rounded-full border border-dashed border-muted-foreground/50"
                            : "h-2 w-full overflow-hidden rounded-full border border-meter-track-border bg-meter-track"
                        }
                      >
                        {bounded !== null ? (
                          <div
                            className={`h-full rounded-full ${pillarFillClass(bounded)}`}
                            style={{ width: `${bounded}%` }}
                          />
                        ) : null}
                      </div>
                      {v9Projection.value.partialEvidence && (
                        <p className="text-xs text-muted-foreground">
                          Included holdings: {v9Projection.value.coverageUsd.pillars[pillar]} USD of{" "}
                          {v9Projection.value.coverageUsd.total} USD
                          {v9Projection.value.coverageUsd.excludedIds.pillars[pillar].length > 0 &&
                            ` · excludes ${holdingSymbols(v9Projection.value.coverageUsd.excludedIds.pillars[pillar])}`}
                        </p>
                      )}
                    </div>
                  );
                })}
              </dl>
            </CardContent>
          </Card>
        )}

        {portfolio.holdings.length > 0 && v9Projection?.status === "available" && (
          <PortfolioUpstreamExposureCard
            groups={groupedExposure}
            totalRoutes={v9Projection.value.dependencyExposure.length}
            logos={logos}
          />
        )}

        {concentrations.length > 0 && <PortfolioConcentrationCard strips={concentrations} />}

        {portfolio.holdings.length > 0 && (
          <>
            <h2 className="pharos-label">Holdings safety grades</h2>
            {!reportData && (
              <p className="text-sm text-muted-foreground" role="status">
                {isLoadingCards ? "Loading holdings safety evidence…" : "Holdings safety evidence is unavailable."}
              </p>
            )}
            {v9Projection?.status === "unavailable" && v9Projection.reason === "portfolio-empty" && (
              <p className="text-sm text-muted-foreground">
                Enter an amount for at least one holding to compute the weighted safety aggregate.
              </p>
            )}
            {v9Projection?.status === "unavailable" && v9Projection.reason !== "portfolio-empty" ? (
              <p className="text-sm text-muted-foreground" role="alert">
                Portfolio safety is unavailable ({v9Projection.reason}).
              </p>
            ) : null}
            {reportData ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {heldCards.map((card) => {
                  const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
                  const isFund = isClientTokenizedFundId(card.id);
                  const partial = isFund ? null : describePartialEvidence(card);
                  const state = coinStates.byId.get(card.id)?.[0];
                  return (
                    <Link key={card.id} href={buildStablecoinUrl(card.id)} className="pharos-card-shell p-3">
                      <p className="truncate text-sm font-medium">{meta?.symbol ?? card.id}</p>
                      {card.ratingStatus === "pipeline-gap" || (!isFund && card.grade === null) ? (
                        <p className="mt-2 text-sm">
                          Pipeline gap ·{" "}
                          {card.reasonCodes.includes("all-pillars-pipeline-gap")
                            ? "all pillars unavailable"
                            : "fewer than two pillars available"}
                        </p>
                      ) : isFund ? (
                        <p className="mt-2 text-xs font-medium text-muted-foreground">
                          Tokenized fund · not graded
                        </p>
                      ) : (
                        <SafetyGradeBadge grade={card.grade} score={card.score} showScore size="sm" className="mt-2 whitespace-nowrap" />
                      )}
                      {partial && (
                        <p className="mt-2 text-xs text-muted-foreground" title={partial.summary}>
                          {partial.gaps.map(formatPartialEvidenceGap).join(" · ")}
                        </p>
                      )}
                      {state ? <CoinStateChip state={state} className="mt-2" /> : null}
                    </Link>
                  );
                })}
              </div>
            ) : null}

            <TelegramSubscribeCommand
              coinIds={portfolioCoinIds}
              headingId="portfolio-telegram-command-heading"
              heading="Follow book in Telegram"
              description="Copies a Telegram command for DEWS, depeg, and safety alerts on your portfolio holdings."
            />
          </>
        )}
      </div>
      {!portfolio.initialized && (
        <div className="[html[data-portfolio-empty]_&]:hidden">
          <PortfolioLoadingState />
        </div>
      )}
    </div>
  );
}
