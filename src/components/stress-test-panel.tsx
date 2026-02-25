"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { formatCurrency } from "@/lib/format";
import { scoreToGrade } from "@/lib/report-cards";
import type { PortfolioState } from "@/hooks/use-portfolio";
import type { StressTestState } from "@/hooks/use-stress-test";
import type { ReportCard, ReportCardGrade } from "@/lib/types";
import { ChevronDown, ChevronRight } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityArrow(delta: number): string {
  const abs = Math.abs(delta);
  if (abs >= 25) return "\u25BC\u25BC\u25BC";
  if (abs >= 15) return "\u25BC\u25BC";
  if (abs >= 5) return "\u25BC";
  return "";
}

function formatUsd(value: number): string {
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value)}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StressTestPanelProps {
  portfolio: PortfolioState;
  stressTest: StressTestState;
  cards: ReportCard[] | undefined;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// StressTestPanel
// ---------------------------------------------------------------------------

export function StressTestPanel({ portfolio, stressTest, cards, logos }: StressTestPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Collapsed summary: show active scenario if set
  const collapsedSummary = useMemo(() => {
    if (!stressTest.targetCoinId || !stressTest.targetGrade) return null;
    const meta = TRACKED_META_BY_ID.get(stressTest.targetCoinId);
    return meta ? `${meta.symbol} → ${stressTest.targetGrade}` : null;
  }, [stressTest.targetCoinId, stressTest.targetGrade]);

  // Compute stressed portfolio headline
  const portfolioStressHeadline = useMemo(() => {
    if (!stressTest.headline || !cards) return null;
    const { isPortfolioMode, totalAtRisk, totalHeld, affectedCount, ecosystemAffectedCount } =
      stressTest.headline;

    if (isPortfolioMode) {
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
      const afterScore = scoredUsd > 0 ? Math.round(weightedSum / scoredUsd) : null;
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
        ecosystemAffectedCount,
        riskPct: totalHeld > 0 ? (totalAtRisk / totalHeld) * 100 : 0,
      };
    }

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
      ecosystemAffectedCount,
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
      {/* Header */}
      <CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => !v)}>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <CardTitle as="h2" className="text-lg">
              Contagion Map
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
        <CardContent className="space-y-4 pt-0">
          {/* Controls */}
          <div className="flex flex-col sm:flex-row gap-3">
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
                onChange={(e) => stressTest.setTarget(e.target.value || null)}
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
                  stressTest.setGrade((e.target.value as ReportCardGrade) || null)
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

          {/* Headline */}
          {portfolioStressHeadline && (
            <div className="space-y-2">
              {portfolioStressHeadline.isPortfolioMode ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">Your portfolio:</span>
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
                  <div className="text-sm text-muted-foreground">
                    {portfolioStressHeadline.totalAtRisk > 0 && (
                      <>
                        {formatUsd(portfolioStressHeadline.totalAtRisk)} of{" "}
                        {formatUsd(portfolioStressHeadline.totalHeld)} at risk (
                        {portfolioStressHeadline.riskPct.toFixed(0)}%).{" "}
                      </>
                    )}
                    {portfolioStressHeadline.ecosystemAffectedCount} coin
                    {portfolioStressHeadline.ecosystemAffectedCount !== 1 ? "s" : ""} affected
                    ecosystem-wide.
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {portfolioStressHeadline.ecosystemAffectedCount} coin
                  {portfolioStressHeadline.ecosystemAffectedCount !== 1 ? "s" : ""} affected.{" "}
                  {portfolioStressHeadline.totalAtRisk > 0 && (
                    <>{formatCurrency(portfolioStressHeadline.totalAtRisk)} in supply at risk.</>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Impact table */}
          {stressTest.impacts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Coin</th>
                    <th className="pb-2 pr-3 font-medium hidden sm:table-cell">
                      {portfolio.holdings.length > 0 ? "Holding" : "Mkt Cap"}
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
                          <span className="truncate font-medium">{impact.name}</span>
                          <span className="text-xs text-muted-foreground hidden sm:inline">
                            {impact.symbol}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground hidden sm:table-cell">
                        {impact.holdingUsd !== null ? formatUsd(impact.holdingUsd) : ""}
                      </td>
                      <td className="py-2 pr-3">
                        <GradeBadge grade={impact.gradeBefore} score={impact.scoreBefore} />
                      </td>
                      <td className="py-2 pr-3">
                        <GradeBadge grade={impact.gradeAfter} score={impact.scoreAfter} />
                      </td>
                      <td className="py-2">
                        <span className="font-medium text-red-500">
                          {impact.delta > 0 ? "+" : ""}
                          {impact.delta} {severityArrow(impact.delta)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* No results */}
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
              Grades recomputed client-side using the same algorithm. Only the Dependency Risk
              dimension is affected.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
