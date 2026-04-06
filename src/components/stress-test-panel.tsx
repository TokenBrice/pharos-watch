"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { GradeBadge } from "@/components/grade-badge";
import { formatCurrency } from "@shared/lib/format";
import type { StressTestState } from "@/hooks/use-stress-test";
import type { ReportCardGrade } from "@shared/types";
import { ReportCardGradeSchema } from "@shared/types/report-cards";
import { Network, Play, ChevronDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
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
  /** Controlled open state — when provided, the panel is driven by the parent. */
  isOpen?: boolean;
  /** Callback when the panel's open state changes (controlled mode). */
  onOpenChange?: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// StressTestPanel
// ---------------------------------------------------------------------------

export function StressTestPanel({
  stressTest,
  mcapMap,
  logos,
  isOpen: controlledOpen,
  onOpenChange,
}: StressTestPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;

  return (
    <Card>
      {/* Header */}
      <CardHeader className="pb-3">
        <button
          type="button"
          className="w-full text-left appearance-none bg-transparent border-none p-0 cursor-pointer select-none"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setIsOpen(!isOpen);
            }
          }}
        >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/15">
              <Network className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />
            </div>
            <div>
              <p className="pharos-kicker text-rose-600 dark:text-rose-400">Risk Simulation</p>
              <CardTitle as="h2" className="text-base font-semibold">
                Contagion Map
              </CardTitle>
            </div>
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ml-2 ${isOpen ? "rotate-180" : ""}`}
            />
          </div>
          <Link
            href="/dependency-map/"
            className="pharos-focus-ring rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            Full map →
          </Link>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Simulate cascading failures when a stablecoin degrades. Trace dependency chains and see which coins are affected.
        </p>
        </button>
      </CardHeader>

      {isOpen && <CardContent className="space-y-4 pt-0">
        {/* Systemic Risk Scoreboard */}
        {stressTest.systemicRisks.length > 0 && (
          <div className="space-y-3">
            <p className="pharos-kicker">Highest Systemic Risk</p>
            <div className="space-y-2">
              {stressTest.systemicRisks.slice(0, 5).map((risk, i) => (
                <div
                  key={risk.coinId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg p-2 text-sm transition-colors",
                    i === 0 ? "bg-rose-500/10 border border-rose-500/20" : "hover:bg-muted/50"
                  )}
                >
                  <span className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold shrink-0",
                    i === 0 ? "bg-rose-500 text-white" : "bg-muted text-muted-foreground"
                  )}>
                    {i + 1}
                  </span>
                  <StablecoinLogo src={logos?.[risk.coinId]} name={risk.symbol} size={24} />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium block truncate">{risk.symbol}</span>
                    <span className="text-xs text-muted-foreground">
                      {risk.affectedCount} dependent{risk.affectedCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className={cn(
                      "font-mono text-sm font-semibold block",
                      i === 0 ? "text-rose-600 dark:text-rose-400" : ""
                    )}>
                      {formatCurrency(risk.supplyAtRisk)}
                    </span>
                    <span className="text-xs text-muted-foreground">at risk</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="pharos-focus-ring h-7 shrink-0 text-xs"
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
                    <Play className="h-3 w-3 mr-1" />
                    Run
                  </Button>
                </div>
              ))}
            </div>

            <div className="border-t pt-3">
              <p className="text-xs text-muted-foreground">Or simulate a custom scenario below</p>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="stress-target" className="pharos-kicker mb-2 block">
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
            <label htmlFor="stress-grade" className="pharos-kicker mb-2 block">
              Downgrade To
            </label>
            <select
              id="stress-grade"
              value={stressTest.targetGrade ?? ""}
              onChange={(e) => {
                const parsed = ReportCardGradeSchema.safeParse(e.target.value);
                const grade = parsed.success ? parsed.data : null;
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
        {stressTest.headline && stressTest.headline.affectedCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span className="text-sm">
              <strong className="text-amber-700 dark:text-amber-400">{stressTest.headline.affectedCount}</strong>
              {" "}coin{stressTest.headline.affectedCount !== 1 ? "s" : ""} affected
              {stressTest.headline.totalAtRisk > 0 && (
                <>, <strong className="font-mono">{formatCurrency(stressTest.headline.totalAtRisk)}</strong> at risk</>
              )}
            </span>
          </div>
        )}

        {/* Impact table */}
        {stressTest.impacts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Stress test results">
              <caption className="sr-only">Stress test results</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="pb-2 pr-3 font-medium">
                    Coin
                  </th>
                  <th scope="col" className="pb-2 pr-3 font-medium hidden sm:table-cell">
                    Market Cap
                  </th>
                  <th scope="col" className="pb-2 pr-3 font-medium text-center">
                    Before
                  </th>
                  <th scope="col" className="pb-2 pr-3 font-medium text-center">
                    After
                  </th>
                  <th scope="col" className="pb-2 font-medium text-right">
                    Impact
                  </th>
                </tr>
              </thead>
              <tbody>
                {stressTest.impacts.map((impact) => {
                  const mcap = mcapMap.get(impact.coinId);
                  const severity = Math.abs(impact.delta);
                  const severityColor = severity >= 25 ? "text-red-600 dark:text-red-400" :
                                        severity >= 15 ? "text-orange-600 dark:text-orange-400" :
                                        severity >= 5 ? "text-amber-600 dark:text-amber-400" :
                                        "text-muted-foreground";
                  return (
                    <tr key={impact.coinId} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                        <div className="flex items-center gap-2">
                          <StablecoinLogo src={logos?.[impact.coinId]} name={impact.name} size={22} />
                          <div className="min-w-0">
                            <span className="block truncate font-medium">{impact.name}</span>
                            <span className="text-xs text-muted-foreground">{impact.symbol}</span>
                          </div>
                        </div>
                      </th>
                      <td className="py-2.5 pr-3 text-muted-foreground font-mono text-xs hidden sm:table-cell">
                        {mcap != null ? formatCurrency(mcap) : "—"}
                      </td>
                      <td className="py-2.5 pr-3 text-center">
                        <GradeBadge grade={impact.gradeBefore} score={impact.scoreBefore} />
                      </td>
                      <td className="py-2.5 pr-3 text-center">
                        <GradeBadge grade={impact.gradeAfter} score={impact.scoreAfter} />
                      </td>
                      <td className="py-2.5 text-right">
                        <span className={cn("font-mono font-semibold", severityColor)}>
                          {impact.delta > 0 ? "+" : ""}{impact.delta}
                        </span>
                        {severity >= 5 && (
                          <span className="block text-xs text-red-600 dark:text-red-400">
                            {severityArrow(impact.delta)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* No results */}
        {stressTest.targetCoinId && stressTest.targetGrade && stressTest.impacts.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4">
            No coins are affected by this downgrade scenario.
          </div>
        )}

        {/* Methodology note */}
        {stressTest.impacts.length > 0 && (
          <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
            <div className="h-4 w-4 rounded-full bg-muted-foreground/20 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[10px] text-muted-foreground">i</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Grades recomputed client-side using the same algorithm.
              Only the <strong>Dependency Risk</strong> dimension is affected by this simulation.
            </p>
          </div>
        )}
      </CardContent>}
    </Card>
  );
}
