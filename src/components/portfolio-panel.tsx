"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CoinSelector } from "@/components/coin-selector";
import { ReportCardRadar } from "@/components/radar-chart";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { DIMENSION_ORDER, scoreToGrade } from "@/lib/report-cards";
import type { PortfolioState } from "@/hooks/use-portfolio";
import type { ReportCard } from "@/lib/types";
import { ChevronDown, ChevronRight, X, Share2, Trash2, AlertTriangle, Wallet } from "lucide-react";

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

const usdFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const usdFormatterCompact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

function formatUsd(value: number): string {
  return `$${usdFormatter.format(value)}`;
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
}: {
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isWarning: boolean;
}) {
  const widthPct = Math.min(100, Math.round(pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium">
          {name}{" "}
          <span className="text-muted-foreground">({symbol})</span>
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
            isWarning
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
// Props
// ---------------------------------------------------------------------------

interface PortfolioPanelProps {
  portfolio: PortfolioState;
  cards: ReportCard[] | undefined;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// PortfolioPanel
// ---------------------------------------------------------------------------

export function PortfolioPanel({ portfolio, cards, logos }: PortfolioPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const disabledIds = useMemo(
    () => new Set(portfolio.holdings.map((h) => h.coinId)),
    [portfolio.holdings],
  );

  // Build synthetic ReportCard for portfolio radar
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
        chainCount: 0,
        freezeEventsPerMonth: null,
        hasTrackedFreezeEvents: false,
        governanceTier: "centralized",
        dependencies: [],
      },
    };
  }, [
    portfolio.holdings.length,
    portfolio.portfolioGrade,
    portfolio.portfolioScore,
    portfolio.dimensionScores,
  ]);

  const collapsedSummary = useMemo(() => {
    if (portfolio.holdings.length === 0) return null;
    const count = portfolio.holdings.length;
    const grade = portfolio.portfolioGrade;
    const score = portfolio.portfolioScore;
    const gradeText = score !== null ? `${grade} (${score})` : grade;
    return `${count} coin${count !== 1 ? "s" : ""}, ${gradeText}`;
  }, [portfolio.holdings.length, portfolio.portfolioGrade, portfolio.portfolioScore]);

  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setToast("Link copied to clipboard");
      setTimeout(() => setToast(null), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);

  const handleClear = useCallback(() => {
    portfolio.clearAll();
  }, [portfolio]);

  return (
    <Card>
      {/* Header */}
      <CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => !v)}>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-violet-500 shrink-0" />
            <CardTitle as="h2" className="text-lg">
              My Portfolio
            </CardTitle>
            {!isOpen && collapsedSummary && (
              <span className="text-sm text-muted-foreground hidden sm:inline">
                &mdash; {collapsedSummary}
              </span>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={isOpen ? "Collapse" : "Expand"}>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-6 pt-0">
          {/* Holdings */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Holdings
              </h3>
              <div className="flex items-center gap-2">
                {toast && (
                  <span className="text-xs text-muted-foreground animate-in fade-in duration-200">
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

            {portfolio.holdings.map((h) => (
              <HoldingRow
                key={h.coinId}
                coinId={h.coinId}
                amount={h.amount}
                logos={logos}
                onSetAmount={portfolio.setAmount}
                onRemove={portfolio.removeCoin}
              />
            ))}

            <CoinSelector
              coins={coinOptions}
              selected={null}
              logos={logos}
              disabledIds={disabledIds}
              onSelect={(coin) => portfolio.addCoin(coin.id, 0)}
              onRemove={() => {}}
            />
          </div>

          {/* Portfolio analysis */}
          {portfolio.holdings.length > 0 && cards && (
            <div className="space-y-4 border-t pt-4">
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
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Portfolio Radar
                    </h4>
                    <ReportCardRadar card={portfolioRadarCard} size={260} labels="short" />
                  </div>
                )}

                {portfolio.upstreamExposure.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Upstream Exposure
                    </h4>
                    <div className="space-y-3">
                      {portfolio.upstreamExposure.map((exp) => (
                        <ExposureBar
                          key={exp.coinId}
                          name={exp.name}
                          symbol={exp.symbol}
                          usd={exp.usd}
                          pct={exp.pct}
                          isWarning={exp.pct > 80}
                        />
                      ))}
                    </div>
                    {portfolio.upstreamExposure.some((e) => e.pct > 80) && (
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
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
