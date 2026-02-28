"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { formatCurrency } from "@/lib/format";
import type { StressTestState } from "@/hooks/use-stress-test";
import type { ReportCardGrade } from "@/lib/types";
import { Network, Play } from "lucide-react";
import { trackEvent } from "@/lib/analytics";

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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StressTestPanelProps {
  stressTest: StressTestState;
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// StressTestPanel
// ---------------------------------------------------------------------------

export function StressTestPanel({ stressTest, mcapMap, logos }: StressTestPanelProps) {
  return (
    <Card>
      {/* Header */}
      <CardHeader>
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-rose-500 shrink-0" />
          <CardTitle as="h2" className="text-lg">
            Contagion Map
          </CardTitle>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {/* Systemic Risk Scoreboard */}
        {stressTest.systemicRisks.length > 0 && (
          <div className="space-y-3">
            <div className="space-y-1">
              {stressTest.systemicRisks.map((risk, i) => (
                <div
                  key={risk.coinId}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="text-muted-foreground w-5 text-right shrink-0">
                    {i + 1}.
                  </span>
                  <span className="font-medium">{risk.symbol}</span>
                  <span className="text-muted-foreground">
                    &rarr; {risk.affectedCount} coin
                    {risk.affectedCount !== 1 ? "s" : ""},{" "}
                    {formatCurrency(risk.supplyAtRisk)} at risk
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 ml-auto shrink-0"
                    aria-label={`Simulate ${risk.symbol} downgrade`}
                    onClick={() => {
                      stressTest.setTarget(risk.coinId);
                      stressTest.setGrade("D" as ReportCardGrade);
                      trackEvent("stress_test_run", {
                        target_coin: risk.coinId,
                        target_grade: "D",
                        affected_count: risk.affectedCount,
                      });
                    }}
                  >
                    <Play className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="border-t pt-3">
              <p className="text-xs text-muted-foreground">
                or simulate your own
              </p>
            </div>
          </div>
        )}

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
              onChange={(e) => {
                const grade = (e.target.value as ReportCardGrade) || null;
                stressTest.setGrade(grade);
                if (grade && stressTest.targetCoinId) {
                  trackEvent("stress_test_run", {
                    target_coin: stressTest.targetCoinId,
                    target_grade: grade,
                    affected_count: stressTest.impacts.length,
                  });
                }
              }}
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
        {stressTest.headline && (
          <div className="text-sm text-muted-foreground">
            {stressTest.headline.affectedCount} coin
            {stressTest.headline.affectedCount !== 1 ? "s" : ""} affected.{" "}
            {stressTest.headline.totalAtRisk > 0 && (
              <>{formatCurrency(stressTest.headline.totalAtRisk)} in supply at risk.</>
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
                    Mkt Cap
                  </th>
                  <th className="pb-2 pr-3 font-medium">Before</th>
                  <th className="pb-2 pr-3 font-medium">After</th>
                  <th className="pb-2 font-medium">Delta</th>
                </tr>
              </thead>
              <tbody>
                {stressTest.impacts.map((impact) => {
                  const mcap = mcapMap.get(impact.coinId);
                  return (
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
                        {mcap != null ? formatCurrency(mcap) : ""}
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
                  );
                })}
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
    </Card>
  );
}
