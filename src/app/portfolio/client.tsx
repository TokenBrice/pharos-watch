"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CoinSelector } from "@/components/coin-selector";
import { ReportCardRadar } from "@/components/radar-chart";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { ReportCardMini } from "@/components/report-card-mini";
import { useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { usePortfolio } from "@/hooks/use-portfolio";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { DIMENSION_ORDER, scoreToGrade } from "@shared/lib/report-cards";
import type { ReportCard } from "@shared/types";
import { AlertTriangle, Share2, Trash2, Wallet, X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { encodePortfolioHoldings } from "@/lib/portfolio-codec";
import { PortfolioEmptyState } from "@/components/portfolio-empty-state";
import type { PortfolioPreset } from "@/components/portfolio-empty-state";

// ---------------------------------------------------------------------------
// Coin options (built once at module level)
// ---------------------------------------------------------------------------

const deadIds = new Set(DEAD_STABLECOINS.filter((d) => d.llamaId).map((d) => d.llamaId!));

const coinOptions = ACTIVE_STABLECOINS.filter((s) => !deadIds.has(s.id)).map((s) => ({
  id: s.id,
  name: s.name,
  symbol: s.symbol,
}));

const PORTFOLIO_PRESETS: readonly PortfolioPreset[] = [
  {
    title: "CeFi Core",
    description: "A major-issuer blend with high liquidity and limited complexity.",
    holdings: [
      { coinId: "usdc-circle", amount: 40 },
      { coinId: "usdt-tether", amount: 35 },
      { coinId: "pyusd-paypal", amount: 25 },
    ],
  },
  {
    title: "Treasury Heavy",
    description: "A mix tilted toward tokenized T-bills and institutional cash wrappers.",
    holdings: [
      { coinId: "buidl-blackrock", amount: 30 },
      { coinId: "usdy-ondo-finance", amount: 25 },
      { coinId: "usyc-hashnote", amount: 25 },
      { coinId: "usdc-circle", amount: 20 },
    ],
  },
  {
    title: "DeFi Native",
    description: "Protocol-issued names with more dependency and collateral nuance.",
    holdings: [
      { coinId: "dai-makerdao", amount: 35 },
      { coinId: "usds-sky", amount: 25 },
      { coinId: "frax-frax", amount: 20 },
      { coinId: "lusd-liquity", amount: 20 },
    ],
  },
  {
    title: "Barbell Mix",
    description: "Core fiat liquidity on one side, higher-yield synthetic exposure on the other.",
    holdings: [
      { coinId: "usdc-circle", amount: 45 },
      { coinId: "usde-ethena", amount: 20 },
      { coinId: "usdtb-ethena", amount: 20 },
      { coinId: "dai-makerdao", amount: 15 },
    ],
  },
];

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
  const [rawValue, setRawValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValue = editing ? rawValue : amount > 0 ? usdFormatterCompact.format(amount) : "";

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
            value={inputValue}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="0"
            className="pharos-focus-ring w-28 rounded-md border bg-transparent pl-5 pr-2 py-1.5 text-sm text-right outline-none placeholder:text-muted-foreground"
            aria-label={`Amount in USD for ${meta.name}`}
          />
        </div>
        <button
          onClick={() => onRemove(coinId)}
          className="pharos-focus-ring text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
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
          {!isCollateral && <span className="text-muted-foreground"> ({symbol})</span>}
          {isWarning && <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-700 dark:text-amber-400" />}
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
  const {
    data: reportData,
    isLoading: isLoadingCards,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = useReportCards();
  const { data: logos } = useLogos();
  const [toast, setToast] = useState<string | null>(null);
  const [showUpstreamDetail, setShowUpstreamDetail] = useState(false);

  const portfolio = usePortfolio(reportData?.cards);

  const exposureToShow = showUpstreamDetail ? portfolio.upstreamExposure : portfolio.upstreamExposureGrouped;

  // URL sync: keep query string in sync with portfolio holdings
  const { setParam } = useUrlFilters();

  useEffect(() => {
    if (!portfolio.initialized) return;

    const encoded = encodePortfolioHoldings(portfolio.holdings);
    setParam("p", encoded);
  }, [portfolio.holdings, portfolio.initialized, setParam]);

  // Build synthetic ReportCard for the portfolio radar chart
  const portfolioRadarCard = useMemo((): ReportCard | null => {
    if (portfolio.holdings.length === 0 || portfolio.portfolioScore === null) return null;
    return {
      id: "__portfolio__",
      name: "Portfolio",
      symbol: "PORT",
      overallGrade: portfolio.portfolioGrade,
      overallScore: portfolio.portfolioScore,
      baseScore: null,
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
      ratedDimensions: DIMENSION_ORDER.filter((k) => portfolio.dimensionScores[k] !== null).length,
      isDefunct: false,
      rawInputs: {
        pegScore: null,
        activeDepeg: false,
        depegEventCount: 0,
        lastEventAt: null,
        liquidityScore: null,
        effectiveExitScore: null,
        redemptionBackstopScore: null,
        redemptionRouteFamily: null,
        redemptionImmediateCapacityUsd: null,
        redemptionImmediateCapacityRatio: null,
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
        collateralFromLive: false,
      },
    };
  }, [portfolio.holdings.length, portfolio.portfolioGrade, portfolio.portfolioScore, portfolio.dimensionScores]);

  // Grade card grid: filtered to held coins only
  const heldCardIds = useMemo(() => new Set(portfolio.holdings.map((h) => h.coinId)), [portfolio.holdings]);

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
      <QueryErrorNotice
        error={reportCardsError}
        hasData={!!reportData?.cards?.length}
        onRetry={() => {
          void refetchReportCards();
        }}
      />
      <StaleDataBanner
        queries={[
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportData?.cards?.length,
          },
        ]}
      />
      {/* Holdings editor */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-violet-700 dark:text-violet-400 shrink-0" />
              <CardTitle className="pharos-kicker">My Holdings</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {toast && <span className="text-xs text-muted-foreground animate-in fade-in duration-300">{toast}</span>}
              {portfolio.holdings.length > 0 && (
                <>
                  <Button variant="ghost" size="xs" onClick={handleShare} className="pharos-focus-ring text-muted-foreground">
                    <Share2 className="h-3 w-3" />
                    Share
                  </Button>
                  <Button variant="ghost" size="xs" onClick={handleClear} className="pharos-focus-ring text-muted-foreground">
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
          {portfolio.holdings.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
              Add holdings manually or load a starter mix below. Share and clear actions stay hidden until your
              portfolio has at least one position.
            </div>
          )}
        </CardContent>
      </Card>

      {portfolio.holdings.length === 0 && (
        <PortfolioEmptyState presets={PORTFOLIO_PRESETS} logos={logos} onApplyPreset={handleApplyPreset} />
      )}

      {/* Portfolio summary: grade + radar + upstream exposure */}
      {portfolio.holdings.length > 0 && reportData?.cards && (
        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="flex items-center gap-4">
              <GradeBadge grade={portfolio.portfolioGrade} score={portfolio.portfolioScore} size="lg" />
              <div>
                <div className="text-sm text-muted-foreground">Portfolio Total</div>
                <div className="text-lg font-semibold">{formatUsd(portfolio.totalUsd)}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {portfolioRadarCard && (
                <div>
                  <h3 className="pharos-kicker mb-2">
                    Portfolio Radar
                  </h3>
                  <ReportCardRadar card={portfolioRadarCard} size={260} labels="short" />
                </div>
              )}

              {(portfolio.upstreamExposureGrouped.length > 0 || portfolio.upstreamExposure.length > 0) && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="pharos-kicker">
                      Upstream Exposure
                    </h3>
                    <div className="inline-flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
                      <button
                        type="button"
                        onClick={() => setShowUpstreamDetail(false)}
                        className={`pharos-focus-ring px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${!showUpstreamDetail ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        Summary
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowUpstreamDetail(true)}
                        className={`pharos-focus-ring px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${showUpstreamDetail ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
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
                    <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 dark:border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>
                        High concentration: a single upstream stablecoin accounts for over 80% of your portfolio
                        exposure.
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
          <h2 className="pharos-kicker">
            Holdings Safety Grades
          </h2>

          {heldCards.length === 0 ? (
            <p className="text-sm text-muted-foreground">Grade data not yet available for your holdings.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {heldCards.map((card) => (
                <ReportCardMini key={card.id} card={card} logo={logos?.[card.id]} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
