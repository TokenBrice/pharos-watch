"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CoinSelector } from "@/components/coin-selector";
import { ReportCardRadar } from "@/components/radar-chart";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { formatCurrency } from "@/lib/format";
import {
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_ORDER,
  scoreToGrade,
} from "@/lib/report-cards";
import type { PortfolioState } from "@/hooks/use-portfolio";
import type { StressTestState } from "@/hooks/use-stress-test";
import type { ReportCard, ReportCardGrade, DimensionKey } from "@/lib/types";
import { ChevronDown, ChevronRight, X, Share2, Trash2, AlertTriangle } from "lucide-react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PortfolioStressPanelProps {
  portfolio: PortfolioState;
  stressTest: StressTestState;
  cards: ReportCard[] | undefined;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Coin options for CoinSelector (built once at module level)
// ---------------------------------------------------------------------------

const deadIds = new Set(
  DEAD_STABLECOINS.filter((d) => d.llamaId).map((d) => d.llamaId!),
);

const coinOptions = TRACKED_STABLECOINS
  .filter((s) => !deadIds.has(s.id))
  .map((s) => ({ id: s.id, name: s.name, symbol: s.symbol }));

// ---------------------------------------------------------------------------
// USD formatter for inputs (no abbreviation)
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
  // Strip everything except digits and decimal point
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

// ---------------------------------------------------------------------------
// Severity indicator for delta
// ---------------------------------------------------------------------------

function severityArrow(delta: number): string {
  const abs = Math.abs(delta);
  if (abs >= 25) return "\u25BC\u25BC\u25BC";
  if (abs >= 15) return "\u25BC\u25BC";
  if (abs >= 5) return "\u25BC";
  return "";
}

// ---------------------------------------------------------------------------
// HoldingRow — individual holding with editable amount
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

  // Sync display value when amount changes externally
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

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setRawValue(e.target.value);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        inputRef.current?.blur();
      }
    },
    [],
  );

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
// GradeBadge — colored grade badge
// ---------------------------------------------------------------------------

function GradeBadge({
  grade,
  score,
  size = "sm",
}: {
  grade: ReportCardGrade;
  score: number | null;
  size?: "sm" | "lg";
}) {
  const colorClasses = REPORT_CARD_GRADE_COLORS[grade];
  const sizeClasses =
    size === "lg" ? "text-2xl px-4 py-2 font-bold" : "text-xs px-2 py-0.5 font-medium";

  return (
    <Badge variant="outline" className={`${colorClasses} ${sizeClasses}`}>
      {grade}
      {score !== null && (
        <span className="ml-1 opacity-70">({score})</span>
      )}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// ExposureBar — horizontal bar for upstream exposure
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
          className={isWarning ? "h-full rounded-full bg-amber-500/70" : "h-full rounded-full bg-blue-500/50"}
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PortfolioStressPanel({
  portfolio,
  stressTest,
  cards,
  logos,
}: PortfolioStressPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Build disabled IDs set for CoinSelector
  const disabledIds = useMemo(
    () => new Set(portfolio.holdings.map((h) => h.coinId)),
    [portfolio.holdings],
  );

  // Build synthetic ReportCard for portfolio radar
  const portfolioRadarCard = useMemo((): ReportCard | null => {
    if (portfolio.holdings.length === 0 || portfolio.portfolioScore === null) {
      return null;
    }
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

  // Collapsed summary text
  const collapsedSummary = useMemo(() => {
    if (portfolio.holdings.length === 0) return null;
    const count = portfolio.holdings.length;
    const grade = portfolio.portfolioGrade;
    const score = portfolio.portfolioScore;
    const gradeText =
      score !== null ? `${grade} (${score})` : grade;
    return `${count} coin${count !== 1 ? "s" : ""}, ${gradeText}`;
  }, [portfolio.holdings.length, portfolio.portfolioGrade, portfolio.portfolioScore]);

  // Handle share
  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setToast("Link copied to clipboard");
      setTimeout(() => setToast(null), 2500);
    } catch {
      // Fallback: prompt
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);

  // Handle clear
  const handleClear = useCallback(() => {
    portfolio.clearAll();
    stressTest.clear();
  }, [portfolio, stressTest]);

  // Compute portfolio stress headline
  const portfolioStressHeadline = useMemo(() => {
    if (!stressTest.headline || !cards) return null;
    const { isPortfolioMode, totalAtRisk, totalHeld, affectedCount } =
      stressTest.headline;

    if (isPortfolioMode) {
      // Compute stressed portfolio grade
      const stressedCards = stressTest.stressedCards;
      if (!stressedCards) return null;

      const cardMap = new Map<string, ReportCard>();
      for (const c of stressedCards) cardMap.set(c.id, c);

      let weightedSum = 0;
      let scoredUsd = 0;
      for (const h of portfolio.holdings) {
        const card = cardMap.get(h.coinId);
        if (!card || card.overallScore === null) continue;
        weightedSum += card.overallScore * h.amount;
        scoredUsd += h.amount;
      }
      const afterScore =
        scoredUsd > 0 ? Math.round(weightedSum / scoredUsd) : null;
      const afterGrade = afterScore !== null ? scoreToGrade(afterScore) : ("NR" as ReportCardGrade);

      const delta =
        afterScore !== null && portfolio.portfolioScore !== null
          ? afterScore - portfolio.portfolioScore
          : null;

      return {
        isPortfolioMode: true,
        beforeGrade: portfolio.portfolioGrade,
        beforeScore: portfolio.portfolioScore,
        afterGrade,
        afterScore,
        delta,
        totalAtRisk,
        totalHeld,
        affectedCount,
        riskPct: totalHeld > 0 ? (totalAtRisk / totalHeld) * 100 : 0,
      };
    }

    // Ecosystem mode
    return {
      isPortfolioMode: false,
      beforeGrade: null,
      beforeScore: null,
      afterGrade: null,
      afterScore: null,
      delta: null,
      totalAtRisk,
      totalHeld,
      affectedCount,
      riskPct: 0,
    };
  }, [
    stressTest.headline,
    stressTest.stressedCards,
    cards,
    portfolio.holdings,
    portfolio.portfolioGrade,
    portfolio.portfolioScore,
  ]);

  return (
    <Card>
      {/* ── Header (always visible) ── */}
      <CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => !v)}>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <CardTitle as="h2" className="text-lg">
              My Portfolio &amp; Stress Test
            </CardTitle>
            {!isOpen && collapsedSummary && (
              <span className="text-sm text-muted-foreground hidden sm:inline">
                &mdash; {collapsedSummary}
              </span>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={isOpen ? "Collapse" : "Expand"}>
            {isOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-6 pt-0">
          {/* ═══════════════════ HOLDINGS SECTION ═══════════════════ */}
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

            {/* Holding rows */}
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

            {/* Add stablecoin */}
            <CoinSelector
              coins={coinOptions}
              selected={null}
              logos={logos}
              disabledIds={disabledIds}
              onSelect={(coin) => portfolio.addCoin(coin.id, 0)}
              onRemove={() => {}}
            />
          </div>

          {/* ═══════════════════ PORTFOLIO ANALYSIS ═══════════════════ */}
          {portfolio.holdings.length > 0 && cards && (
            <div className="space-y-4 border-t pt-4">
              {/* Grade + total */}
              <div className="flex items-center gap-4">
                <GradeBadge
                  grade={portfolio.portfolioGrade}
                  score={portfolio.portfolioScore}
                  size="lg"
                />
                <div>
                  <div className="text-sm text-muted-foreground">
                    Portfolio Total
                  </div>
                  <div className="text-lg font-semibold">
                    {formatUsd(portfolio.totalUsd)}
                  </div>
                </div>
              </div>

              {/* Radar + Exposure — side by side on lg, stacked on mobile */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left: radar */}
                {portfolioRadarCard && (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Portfolio Radar
                    </h4>
                    <ReportCardRadar
                      card={portfolioRadarCard}
                      size={260}
                      labels="short"
                    />
                  </div>
                )}

                {/* Right: upstream exposure */}
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
                          High concentration: a single upstream stablecoin
                          accounts for over 80% of your portfolio exposure.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══════════════════ STRESS TEST SECTION ═══════════════════ */}
          <div className="space-y-4 border-t pt-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Stress Test
            </h3>

            {/* Controls */}
            <div className="flex flex-col sm:flex-row gap-3">
              {/* Target coin selector */}
              <div className="flex-1">
                <label
                  htmlFor="stress-target"
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Target Coin
                </label>
                <select
                  id="stress-target"
                  value={stressTest.targetCoinId ?? ""}
                  onChange={(e) =>
                    stressTest.setTarget(e.target.value || null)
                  }
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select a coin...</option>
                  {stressTest.targetableCoins.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.symbol}) &mdash; {c.dependentCount} dependent
                      {c.dependentCount !== 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {/* Grade selector */}
              <div className="flex-1">
                <label
                  htmlFor="stress-grade"
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Downgrade To
                </label>
                <select
                  id="stress-grade"
                  value={stressTest.targetGrade ?? ""}
                  onChange={(e) =>
                    stressTest.setGrade(
                      (e.target.value as ReportCardGrade) || null,
                    )
                  }
                  disabled={!stressTest.targetCoinId}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">Select grade...</option>
                  {stressTest.gradeOptions.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* ── Headline stats ── */}
            {portfolioStressHeadline && (
              <div className="space-y-2">
                {portfolioStressHeadline.isPortfolioMode ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">
                        Your portfolio:
                      </span>
                      <GradeBadge
                        grade={portfolioStressHeadline.beforeGrade!}
                        score={portfolioStressHeadline.beforeScore}
                      />
                      <span className="text-muted-foreground">&rarr;</span>
                      <GradeBadge
                        grade={portfolioStressHeadline.afterGrade!}
                        score={portfolioStressHeadline.afterScore}
                      />
                      {portfolioStressHeadline.delta !== null &&
                        portfolioStressHeadline.delta !== 0 && (
                          <span className="text-sm font-medium text-red-500">
                            {portfolioStressHeadline.delta > 0 ? "+" : ""}
                            {portfolioStressHeadline.delta} pts
                          </span>
                        )}
                    </div>
                    {portfolioStressHeadline.totalAtRisk > 0 && (
                      <div className="text-sm text-muted-foreground">
                        {formatUsd(portfolioStressHeadline.totalAtRisk)} of{" "}
                        {formatUsd(portfolioStressHeadline.totalHeld)} at risk (
                        {portfolioStressHeadline.riskPct.toFixed(0)}%)
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {portfolioStressHeadline.affectedCount} coin
                    {portfolioStressHeadline.affectedCount !== 1 ? "s" : ""}{" "}
                    affected.{" "}
                    {portfolioStressHeadline.totalAtRisk > 0 && (
                      <>
                        {formatCurrency(portfolioStressHeadline.totalAtRisk)} in
                        supply at risk.
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Impact table ── */}
            {stressTest.impacts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">Coin</th>
                      <th className="pb-2 pr-3 font-medium hidden sm:table-cell">
                        {portfolio.holdings.length > 0
                          ? "Holding"
                          : "Mkt Cap"}
                      </th>
                      <th className="pb-2 pr-3 font-medium">Before</th>
                      <th className="pb-2 pr-3 font-medium">After</th>
                      <th className="pb-2 font-medium">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stressTest.impacts.map((impact) => (
                      <tr key={impact.coinId} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <StablecoinLogo
                              src={logos?.[impact.coinId]}
                              name={impact.name}
                              size={20}
                            />
                            <span className="truncate font-medium">
                              {impact.name}
                            </span>
                            <span className="text-xs text-muted-foreground hidden sm:inline">
                              {impact.symbol}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground hidden sm:table-cell">
                          {impact.holdingUsd !== null
                            ? formatUsd(impact.holdingUsd)
                            : ""}
                        </td>
                        <td className="py-2 pr-3">
                          <GradeBadge
                            grade={impact.gradeBefore}
                            score={impact.scoreBefore}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <GradeBadge
                            grade={impact.gradeAfter}
                            score={impact.scoreAfter}
                          />
                        </td>
                        <td className="py-2">
                          <span className="font-medium text-red-500">
                            {impact.delta > 0 ? "+" : ""}
                            {impact.delta}{" "}
                            {severityArrow(impact.delta)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* No results message */}
            {stressTest.targetCoinId &&
              stressTest.targetGrade &&
              stressTest.impacts.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No coins are affected by this downgrade scenario.
                </div>
              )}

            {/* Methodology note */}
            {stressTest.impacts.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Grades recomputed client-side using the same algorithm. Only
                the Dependency Risk dimension is affected.
              </p>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
