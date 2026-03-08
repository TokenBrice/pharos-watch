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
    crossChain: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardDetail({ card, liquidityComponents }: ReportCardDetailProps) {
  // Defunct coins get a minimal card
  if (card.isDefunct) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">Safety Score</CardTitle>
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

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          <div className="flex items-center justify-between">
            <span>Safety Score</span>
            <span className="text-xs font-normal text-muted-foreground">
              v{METHODOLOGY_VERSION}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Two-column layout: grade + radar | dimension breakdown */}
        <div className="grid gap-6 md:grid-cols-2 md:items-stretch">
          {/* Left column: grade top-left strip + radar filling full height */}
          <div className="flex flex-col items-center gap-4 md:flex-row md:items-stretch md:h-full">
            {/* Grade strip — top-aligned on desktop, centred inline on mobile */}
            <div className="flex flex-row items-center gap-3 md:flex-col md:justify-start md:items-center md:gap-1 md:pt-1 shrink-0">
              <Badge
                variant="outline"
                className={`text-3xl px-5 py-2 font-bold ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
              >
                {card.overallGrade}
              </Badge>
              {card.overallScore !== null && (
                <span className="text-lg text-muted-foreground md:text-base">
                  {card.overallScore}
                  <span className="text-sm">/100</span>
                </span>
              )}
              {card.baseScore != null && card.overallScore != null && card.dimensions.pegStability.score != null && (
                <details className="mt-2 text-xs text-muted-foreground w-full">
                  <summary className="cursor-pointer hover:text-foreground transition-colors">
                    Show score breakdown
                  </summary>
                  <div className="mt-2 space-y-1.5 pl-1">
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
            {/* Radar chart — fills remaining width and full column height on desktop */}
            <ReportCardRadar card={card} labels="full" className="w-full flex-1 min-h-[260px] md:h-full" />
          </div>

          {/* Right column: Dimension breakdown */}
          <div className="space-y-2">
            {DIMENSION_ORDER.map((key) => {
              const dim = card.dimensions[key];
              return (
                <div key={key}>
                  <div
                    className="flex items-center justify-between rounded-lg border px-3 py-2"
                  >
                    <span className="text-sm font-medium">
                      {DIMENSION_LABELS[key]}
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
                            <span className={`tabular-nums ${isNegative ? "text-amber-700 dark:text-amber-400" : ""}`}>
                              {isNegative ? subScore : subScore === 0 ? "—" : subScore}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {key === "liquidity" && liquidityComponents && dim.score !== null && (
                    <details className="mt-1.5 text-xs text-muted-foreground">
                      <summary className="cursor-pointer hover:text-foreground transition-colors ml-3">
                        Show components
                      </summary>
                      <div className="mt-2 ml-4 space-y-1">
                        {[
                          { label: "TVL Depth", key: "tvlDepth" as const, weight: 30 },
                          { label: "Volume Activity", key: "volumeActivity" as const, weight: 20 },
                          { label: "Pool Quality", key: "poolQuality" as const, weight: 20 },
                          { label: "Durability", key: "durability" as const, weight: 15 },
                          { label: "Pair Diversity", key: "pairDiversity" as const, weight: 7.5 },
                          { label: "Cross-chain", key: "crossChain" as const, weight: 7.5 },
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
                  <span key={dep.id}>
                    {i > 0 && ", "}
                    <Link
                      href={buildStablecoinUrl(dep.id)}
                      className="font-medium text-blue-700 dark:text-blue-400 underline underline-offset-2 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
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
      </CardContent>
    </Card>
  );
}
