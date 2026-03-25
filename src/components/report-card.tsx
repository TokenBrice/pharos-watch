"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard as ReportCardType } from "@shared/types";
import {
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  METHODOLOGY_VERSION,
} from "@shared/lib/report-cards";
import { ReportCardRadar } from "./radar-chart";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import Link from "next/link";
import { buildStablecoinUrl } from "@/lib/urls";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

// ---------------------------------------------------------------------------
// Grade Glow Component
// ---------------------------------------------------------------------------

const GRADE_GLOW_COLORS: Record<string, string> = {
  A: 'oklch(0.5 0.18 145 / 0.2)',
  B: 'oklch(0.5 0.12 250 / 0.18)',
  C: 'oklch(0.55 0.15 85 / 0.18)',
  D: 'oklch(0.55 0.18 55 / 0.22)',
  F: 'oklch(0.5 0.2 25 / 0.25)',
};

const GRADE_BORDER_HEX: Record<string, string> = {
  A: 'oklch(0.65 0.2 145 / 0.5)',
  B: 'oklch(0.6 0.14 250 / 0.45)',
  C: 'oklch(0.65 0.16 85 / 0.45)',
  D: 'oklch(0.6 0.2 55 / 0.5)',
  F: 'oklch(0.55 0.22 25 / 0.55)',
};

function GradeGlow({ grade }: { grade: string }) {
  const color = GRADE_GLOW_COLORS[grade] || GRADE_GLOW_COLORS.B;
  
  return (
    <div 
      className="absolute inset-0 pointer-events-none"
      style={{ 
        background: `radial-gradient(circle at center, ${color}, transparent 65%)`,
        transform: 'scale(0.9)',
      }}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReportCardDetailProps {
  card: ReportCardType;
  liquidityComponents?: {
    tvlDepth: number;
    volumeActivity: number;
    poolQuality: number;
    durability: number;
    pairDiversity: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardDetail({ card, liquidityComponents }: ReportCardDetailProps) {
  // Defunct coins get a minimal card
  if (card.isDefunct) {
    return (
      <Card
        className="overflow-hidden"
        style={{ borderTopWidth: '3px', borderTopColor: GRADE_BORDER_HEX.F }}
      >
        <CardHeader>
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>Safety Score</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Badge
              variant="outline"
              className={`text-2xl px-4 py-2 font-bold ${REPORT_CARD_GRADE_COLORS.F}`}
            >
              F
            </Badge>
            <div>
              <p className="text-lg font-medium text-muted-foreground">Defunct</p>
              <p className="text-sm text-muted-foreground">
                This stablecoin is no longer active.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const gradeRange = card.overallGrade.charAt(0);
  const topBorderColor = GRADE_BORDER_HEX[gradeRange] ?? GRADE_BORDER_HEX.B;

  return (
      <Card
        className="overflow-hidden"
        style={{ borderTopWidth: '3px', borderTopColor: topBorderColor }}
      >
        <CardHeader>
          <CardTitle as="h2" className="text-xl font-bold tracking-tight">
            <div className="flex items-center justify-between">
              <MethodologyLabel topic="safetyScore">Safety Score</MethodologyLabel>
              <span className="text-xs font-normal text-muted-foreground">
                v{METHODOLOGY_VERSION}
              </span>
            </div>
          </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Two-column layout: grade + radar | dimension breakdown */}
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:items-stretch">
          {/* Left column: grade + radar stacked */}
          <div className="flex flex-col items-center gap-4">
            {/* Grade hero */}
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Badge
                variant="outline"
                className={`text-4xl px-6 py-2.5 font-extrabold tracking-tight ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
              >
                {card.overallGrade}
              </Badge>
              {card.overallScore !== null && (
                <span className="text-2xl font-bold font-mono tabular-nums tracking-tight text-foreground">
                  {card.overallScore}
                  <span className="text-base text-muted-foreground">/100</span>
                </span>
              )}
              {card.baseScore != null && card.overallScore != null && card.dimensions.pegStability.score != null && (
                <details className="mt-2 basis-full text-center text-xs text-muted-foreground">
                  <summary className="pharos-focus-ring inline-flex cursor-pointer rounded-md px-2 py-1 transition-colors hover:text-foreground hover:bg-muted/50">
                    Score breakdown
                  </summary>
                  <div className="mt-2 mx-auto max-w-[200px] space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span>Base score</span>
                      <span className="font-mono tabular-nums">{card.baseScore.toFixed(1)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Peg multiplier</span>
                      <span className="font-mono tabular-nums">
                        {card.baseScore !== card.overallScore
                          ? `\u2212${(card.baseScore - card.overallScore).toFixed(1)}pts`
                          : "none"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between font-medium text-foreground">
                      <span>Final score</span>
                      <span className="font-mono tabular-nums">{card.overallScore.toFixed(1)}</span>
                    </div>
                  </div>
                </details>
              )}
            </div>
            {/* Radar chart — grows to fill remaining height, capped width */}
            <div className="relative w-full max-w-[320px] min-h-[220px] flex-1">
              <GradeGlow grade={card.overallGrade} />
              <ReportCardRadar card={card} labels="short" />
            </div>
          </div>

          {/* Right column: Dimension breakdown */}
          <div className="space-y-2">
            {DIMENSION_ORDER.map((key) => {
              const dim = card.dimensions[key];
              const dimRange = dim.grade.charAt(0);
              const dimBorder = GRADE_BORDER_HEX[dimRange] ?? 'transparent';
              return (
                <div key={key}>
                  <div
                    className="flex items-center justify-between rounded-lg border border-l-[3px] px-3 py-2"
                    style={{ borderLeftColor: dimBorder }}
                  >
                    <span className="text-sm font-medium">
                      {key === "resilience" ? (
                        <MethodologyLabel topic="resilience">{DIMENSION_LABELS[key]}</MethodologyLabel>
                      ) : key === "dependencyRisk" ? (
                        <MethodologyLabel topic="dependencyRisk">{DIMENSION_LABELS[key]}</MethodologyLabel>
                      ) : (
                        DIMENSION_LABELS[key]
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-xs font-semibold ${REPORT_CARD_GRADE_COLORS[dim.grade]}`}
                      >
                        {dim.grade}
                      </Badge>
                      <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                        {dim.score !== null ? (
                          <>
                            {dim.score}
                            <span className="text-xs">/100</span>
                          </>
                        ) : (
                          "\u2014"
                        )}
                      </span>
                    </div>
                  </div>
                  {key === "pegStability" && dim.detail.includes("capped at C") && (
                    <p className="ml-4 mt-1 text-xs text-amber-700 dark:text-amber-400">
                      Capped — active depeg in progress
                    </p>
                  )}
                  {(key === "resilience" || key === "decentralization" || key === "dependencyRisk") && dim.score !== null && (
                    <div className="ml-4 mt-1 space-y-0.5">
                      {dim.detail.split(". ").map((part) => {
                        const match = part.match(/^(.+?):\s*(.+?)\s*\((-?\d+)\)$/);
                        if (!match) return null;
                        const [, label, desc, scoreStr] = match;
                        const subScore = parseInt(scoreStr, 10);
                        const isNegative = subScore < 0;
                        return (
                          <div
                            key={label}
                            className="flex items-center justify-between text-xs text-muted-foreground"
                          >
                            <span>
                              {label}: <span className="text-foreground/70">{desc}</span>
                            </span>
                            <span className={`tabular-nums ${isNegative ? "text-amber-700 dark:text-amber-400" : "text-foreground/80"}`}>
                              {isNegative ? subScore : subScore === 0 ? "—" : subScore}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {key === "resilience" && card.rawInputs.collateralFromLive && (
                    <span className="text-xs text-muted-foreground ml-4" title="Scored from live reserve data">(live data)</span>
                  )}
                  {key === "liquidity" && dim.score !== null && (
                    <div className="ml-4 mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {card.rawInputs.liquidityScore != null ? (
                        <div className="flex items-center justify-between">
                          <span>DEX liquidity</span>
                          <span className="tabular-nums text-foreground/80">
                            {card.rawInputs.liquidityScore}/100
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <span>DEX liquidity</span>
                          <span className="text-foreground/60">Unavailable</span>
                        </div>
                      )}
                      {card.rawInputs.redemptionBackstopScore != null ? (
                        <div className="flex items-center justify-between">
                          <MethodologyLabel topic="redemptionBackstop">Redemption backstop</MethodologyLabel>
                          <span className="tabular-nums text-foreground/80">
                            {card.rawInputs.redemptionBackstopScore}/100
                            {!card.rawInputs.redemptionUsedForLiquidity &&
                            card.rawInputs.redemptionModelConfidence === "low"
                              ? " (not used)"
                              : ""}
                          </span>
                        </div>
                      ) : null}
                      {card.rawInputs.effectiveExitScore != null ? (
                        <div className="flex items-center justify-between">
                          <MethodologyLabel topic="effectiveExit">Effective exit</MethodologyLabel>
                          <span className="tabular-nums text-foreground/80">
                            {card.rawInputs.effectiveExitScore}/100
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {key === "liquidity" && liquidityComponents && dim.score !== null && (
                    <details className="mt-1.5 text-xs text-muted-foreground">
                      <summary className="pharos-focus-ring ml-4 cursor-pointer rounded-md transition-colors hover:text-foreground">
                        Show components
                      </summary>
                      <div className="mt-2 ml-4 space-y-1.5">
                        {[
                          { label: "TVL Depth", key: "tvlDepth" as const, weight: 35 },
                          { label: "Volume Activity", key: "volumeActivity" as const, weight: 20 },
                          { label: "Pool Quality", key: "poolQuality" as const, weight: 22.5 },
                          { label: "Durability", key: "durability" as const, weight: 15 },
                          { label: "Pair Diversity", key: "pairDiversity" as const, weight: 7.5 },
                        ].map(({ label, key: k, weight }) => {
                          const value = liquidityComponents[k];
                          return value != null ? (
                            <div key={k} className="flex items-center gap-2">
                              <span className="w-28 shrink-0">{label}</span>
                              <div className="h-1.5 flex-1 rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-foreground/40"
                                  style={{ width: `${Math.min(100, value)}%` }}
                                />
                              </div>
                              <span className="w-8 text-right font-mono tabular-nums">{value.toFixed(0)}</span>
                              <span className="w-8 text-right text-muted-foreground/60">{weight}%</span>
                            </div>
                          ) : null;
                        })}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Dependency callout */}
        {card.dependencies && card.dependencies.length > 0 && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
            <p className="mb-2 text-sm font-medium text-blue-700 dark:text-blue-400">
              Dependencies
            </p>
            <p className="text-sm text-muted-foreground">
              This stablecoin has exposure to{" "}
              {card.dependencies.map((dep, i) => {
                const depMeta = TRACKED_STABLECOINS.find(
                  (s) => s.id === dep.id,
                );
                const name = depMeta?.symbol ?? dep.id;
                const typeLabel = dep.type === "wrapper" ? " (wrapper)"
                  : dep.type === "mechanism" ? " (mechanism-critical)"
                  : "";
                return (
                  <span key={`${dep.id}-${dep.type}`}>
                    {i > 0 && ", "}
                    <Link
                      href={buildStablecoinUrl(dep.id)}
                      className="pharos-focus-ring rounded-sm font-medium text-blue-700 underline underline-offset-2 transition-colors hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {name}
                    </Link>
                    {typeLabel && (
                      <span className="text-xs text-blue-700/80 dark:text-blue-400/80">{typeLabel}</span>
                    )}
                  </span>
                );
              })}
              . Its dependency risk score reflects the health and stability of
              these assets.
            </p>
          </div>
        )}

        <MethodologyCardActions topic="safetyScore" showVersion={false} />
      </CardContent>
    </Card>
  );
}
