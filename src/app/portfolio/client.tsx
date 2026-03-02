"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinSelector } from "@/components/coin-selector";
import { ReportCardRadar } from "@/components/radar-chart";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { ReportCardMini } from "@/components/report-card-mini";
import { useReportCards } from "@/hooks/use-report-cards";
import { useLogos } from "@/hooks/use-logos";
import { usePortfolio } from "@/hooks/use-portfolio";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { DIMENSION_ORDER, scoreToGrade } from "@/lib/report-cards";
import type { ReportCard } from "@/lib/types";
import { AlertTriangle, Share2, Trash2, Wallet, X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_15MIN } from "@/hooks/use-api-query";

// ---------------------------------------------------------------------------
// Coin options (built once at module level)
// ---------------------------------------------------------------------------

const deadIds = new Set(
  DEAD_STABLECOINS.filter((d) => d.llamaId).map((d) => d.llamaId!),
);

const coinOptions = TRACKED_STABLECOINS
  .filter((s) => !deadIds.has(s.id))
  .map((s) => ({ id: s.id, name: s.name, symbol: s.symbol }));

// ---------------------------------------------------------------------------
// USD formatters
// ---------------------------------------------------------------------------

const usdFormatterCompact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

const usdFormatterDetailed = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

function formatUsd(value: number): string {
  return `$${usdFormatterDetailed.format(value)}`;
}

function parseUsdInput(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

// ---------------------------------------------------------------------------
// HoldingRow
// ---------------------------------------------------------------------------

function HoldingRow({
  coinId,
  amount,
  logos,
  onSetAmount,
  onRemove,
}: {
  coinId: string;
  amount: number;
  logos?: Record<string, string>;
  onSetAmount: (coinId: string, amount: number) => void;
  onRemove: (coinId: string) => void;
}) {
  const meta = TRACKED_META_BY_ID.get(coinId);
  const [editing, setEditing] = useState(false);
  const [rawValue, setRawValue] = useState(usdFormatterCompact.format(amount));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setRawValue(amount > 0 ? usdFormatterCompact.format(amount) : "");
    }
  }, [amount, editing]);

  const handleFocus = useCallback(() => {
    setEditing(true);
    setRawValue(amount > 0 ? String(amount) : "");
  }, [amount]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    const parsed = parseUsdInput(rawValue);
    onSetAmount(coinId, parsed);
    setRawValue(parsed > 0 ? usdFormatterCompact.format(parsed) : "");
  }, [rawValue, coinId, onSetAmount]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRawValue(e.target.value);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") inputRef.current?.blur();
  }, []);

  if (!meta) return null;

  return (
    <div className="flex items-center gap-3 py-2">
      <StablecoinLogo src={logos?.[coinId]} name={meta.name} size={24} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{meta.name}</div>
        <div className="text-xs text-muted-foreground">{meta.symbol}</div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
            $
          </span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={rawValue}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="0"
            className="w-28 rounded-md border bg-transparent pl-5 pr-2 py-1.5 text-sm text-right outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Amount in USD for ${meta.name}`}
          />
        </div>
        <button
          onClick={() => onRemove(coinId)}
          className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Remove ${meta.name}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExposureBar
// ---------------------------------------------------------------------------

function ExposureBar({
  name,
  symbol,
  usd,
  pct,
  isWarning,
  isCollateral,
}: {
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isWarning: boolean;
  isCollateral: boolean;
}) {
  const widthPct = Math.min(100, Math.round(pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium">
          {name}
          {!isCollateral && (
            <span className="text-muted-foreground"> ({symbol})</span>
          )}
          {isWarning && (
            <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-500" />
          )}
        </span>
        <span className="text-muted-foreground ml-2 shrink-0">
          {formatUsd(usd)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={
            isCollateral
              ? "h-full rounded-full bg-teal-500/50"
              : isWarning
                ? "h-full rounded-full bg-amber-500/70"
                : "h-full rounded-full bg-blue-500/50"
          }
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PortfolioClient
// ---------------------------------------------------------------------------

export function PortfolioClient() {
  const { data: reportData, isLoading: isLoadingCards, dataUpdatedAt: rcUpdatedAt } = useReportCards();
  const { data: logos } = useLogos();
  const [toast, setToast] = useState<string | null>(null);
  const [showUpstreamDetail, setShowUpstreamDetail] = useState(false);

  const portfolio = usePortfolio(reportData?.cards);

  const exposureToShow = showUpstreamDetail
    ? portfolio.upstreamExposure
    : portfolio.upstreamExposureGrouped;

  // URL sync: keep query string in sync with portfolio holdings
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams();

    // Encode portfolio holdings as ?p=symbol:amount,...
    const encoded = portfolio.holdings
      .map((h) => {
        const meta = TRACKED_META_BY_ID.get(h.coinId);
        return meta ? `${meta.symbol.toLowerCase()}:${h.amount}` : null;
      })
      .filter(Boolean)
      .join(",");
    if (encoded) params.set("p", encoded);

    const qs = params.toString();
    const newPath = qs ? `/portfolio/?${qs}` : "/portfolio/";
    router.replace(newPath, { scroll: false });
  }, [portfolio.holdings, router]);

  // Build synthetic ReportCard for the portfolio radar chart
  const portfolioRadarCard = useMemo((): ReportCard | null => {
    if (portfolio.holdings.length === 0 || portfolio.portfolioScore === null) return null;
    return {
      id: "__portfolio__",
      name: "Portfolio",
      symbol: "PORT",
      overallGrade: portfolio.portfolioGrade,
      overallScore: portfolio.portfolioScore,
      dimensions: Object.fromEntries(
        DIMENSION_ORDER.map((key) => [
          key,
          {
            grade: scoreToGrade(portfolio.dimensionScores[key]),
            score: portfolio.dimensionScores[key],
            detail: "",
          },
        ]),
      ) as ReportCard["dimensions"],
      ratedDimensions: DIMENSION_ORDER.filter(
        (k) => portfolio.dimensionScores[k] !== null,
      ).length,
      isDefunct: false,
      rawInputs: {
        pegScore: null,
        activeDepeg: false,
        depegEventCount: 0,
        lastEventAt: null,
        liquidityScore: null,
        concentrationHhi: null,
        bluechipGrade: null,
        canBeBlacklisted: false,
        chainTier: "ethereum",
        deploymentModel: "single-chain",
        collateralQuality: "native",
        custodyModel: "onchain",
        governanceTier: "centralized",
        governanceQuality: "single-entity",
        dependencies: [],
        navToken: false,
      },
    };
  }, [
    portfolio.holdings.length,
    portfolio.portfolioGrade,
    portfolio.portfolioScore,
    portfolio.dimensionScores,
  ]);

  // Grade card grid: filtered to held coins only
  const heldCardIds = useMemo(
    () => new Set(portfolio.holdings.map((h) => h.coinId)),
    [portfolio.holdings],
  );

  const heldCards = useMemo(
    () => (reportData?.cards ?? []).filter((c) => heldCardIds.has(c.id)),
    [reportData?.cards, heldCardIds],
  );

  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      trackEvent("portfolio_shared", { coin_count: portfolio.holdings.length });
      setToast("Link copied to clipboard");
      setTimeout(() => setToast(null), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);

  const handleClear = useCallback(() => {
    trackEvent("portfolio_cleared", { coin_count: portfolio.holdings.length });
    portfolio.clearAll();
  }, [portfolio]);

  if (isLoadingCards) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-4 pb-4 space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StaleDataBanner
        queries={[{ label: "Grades", dataUpdatedAt: rcUpdatedAt, staleTime: CRON_15MIN }]}
      />
      {/* Holdings editor */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-violet-500 shrink-0" />
              <CardTitle className="text-lg">My Holdings</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {toast && (
                <span className="text-xs text-muted-foreground animate-in fade-in duration-300">
                  {toast}
                </span>
              )}
              {portfolio.holdings.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleShare}
                    className="text-muted-foreground"
                  >
                    <Share2 className="h-3 w-3" />
                    Share
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleClear}
                    className="text-muted-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {portfolio.holdings.map((h) => (
            <HoldingRow
              key={h.coinId}
              coinId={h.coinId}
              amount={h.amount}
              logos={logos}
              onSetAmount={portfolio.setAmount}
              onRemove={(coinId) => {
                trackEvent("portfolio_coin_removed", { coin_id: coinId });
                portfolio.removeCoin(coinId);
              }}
            />
          ))}
          <CoinSelector
            coins={coinOptions}
            selected={null}
            logos={logos}
            disabledIds={heldCardIds}
            onSelect={(coin) => {
              trackEvent("portfolio_coin_added", { coin_id: coin.id });
              portfolio.addCoin(coin.id, 0);
            }}
            onRemove={() => {}}
          />
        </CardContent>
      </Card>

      {/* Portfolio summary: grade + radar + upstream exposure */}
      {portfolio.holdings.length > 0 && reportData?.cards && (
        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="flex items-center gap-4">
              <GradeBadge
                grade={portfolio.portfolioGrade}
                score={portfolio.portfolioScore}
                size="lg"
              />
              <div>
                <div className="text-sm text-muted-foreground">Portfolio Total</div>
                <div className="text-lg font-semibold">{formatUsd(portfolio.totalUsd)}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {portfolioRadarCard && (
                <div>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Portfolio Radar
                  </h3>
                  <ReportCardRadar card={portfolioRadarCard} size={260} labels="short" />
                </div>
              )}

              {(portfolio.upstreamExposureGrouped.length > 0 || portfolio.upstreamExposure.length > 0) && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Upstream Exposure
                    </h3>
                    <div className="inline-flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
                      <button
                        type="button"
                        onClick={() => setShowUpstreamDetail(false)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${!showUpstreamDetail ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Summary
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowUpstreamDetail(true)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${showUpstreamDetail ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Detail
                      </button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {exposureToShow.map((exp) => (
                      <ExposureBar
                        key={exp.coinId}
                        name={exp.name}
                        symbol={exp.symbol}
                        usd={exp.usd}
                        pct={exp.pct}
                        isWarning={!exp.isCollateral && exp.pct > 80}
                        isCollateral={exp.isCollateral}
                      />
                    ))}
                  </div>
                  {exposureToShow.some((e) => !e.isCollateral && e.pct > 80) && (
                    <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>
                        High concentration: a single upstream stablecoin accounts for over 80% of
                        your portfolio exposure.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Grade cards for held coins only */}
      {portfolio.holdings.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Holdings Safety Grades
          </h2>

          {heldCards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Grade data not yet available for your holdings.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {heldCards.map((card) => (
                <ReportCardMini
                  key={card.id}
                  card={card}
                  logo={logos?.[card.id]}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
