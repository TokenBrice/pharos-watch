"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard as ReportCardType, DimensionKey } from "@shared/types";
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
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { MethodologyCardActions, MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { cn } from "@/lib/utils";
import { parseDimensionDetail } from "@/lib/report-card-parsing";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";

// ---------------------------------------------------------------------------
// Grade Glow Component
// ---------------------------------------------------------------------------

const GRADE_GLOW_COLORS: Record<string, string> = {
  A: 'oklch(0.5 0.2 145 / 0.53)',
  B: 'oklch(0.5 0.16 250 / 0.45)',
  C: 'oklch(0.55 0.18 85 / 0.45)',
  D: 'oklch(0.55 0.2 55 / 0.53)',
  F: 'oklch(0.5 0.22 25 / 0.6)',
};

const GRADE_BORDER_HEX: Record<string, string> = {
  A: 'oklch(0.65 0.22 145 / 0.6)',
  B: 'oklch(0.6 0.18 250 / 0.55)',
  C: 'oklch(0.65 0.2 85 / 0.55)',
  D: 'oklch(0.6 0.22 55 / 0.6)',
  F: 'oklch(0.55 0.24 25 / 0.65)',
};

function GradeGlow({ grade }: { grade: string }) {
  const color = GRADE_GLOW_COLORS[grade] || GRADE_GLOW_COLORS.B;
  
  return (
    <div 
      className="absolute inset-0 pointer-events-none -z-10"
      style={{ 
        background: `radial-gradient(circle at center, ${color}, transparent 70%)`,
        transform: 'scale(1.2)',
        filter: 'blur(20px)',
      }}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// Dimension Row Component
// ---------------------------------------------------------------------------

function DimensionLabel({ dimKey }: { dimKey: DimensionKey }) {
  if (dimKey === "resilience") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>{DIMENSION_LABELS[dimKey]}</span>
        <MethodologyHint topic="resilience" className="pointer-events-auto" />
      </span>
    );
  }

  if (dimKey === "dependencyRisk") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>{DIMENSION_LABELS[dimKey]}</span>
        <MethodologyHint topic="dependencyRisk" className="pointer-events-auto" />
      </span>
    );
  }

  return DIMENSION_LABELS[dimKey];
}

interface DimensionRowProps {
  dimKey: DimensionKey;
  dim: ReportCardType["dimensions"][DimensionKey];
  card: ReportCardType;
  liquidityComponents?: ReportCardDetailProps["liquidityComponents"];
}

function DimensionRow({ dimKey, dim, card, liquidityComponents }: DimensionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const dimRange = dim.grade.charAt(0);
  const dimBorder = GRADE_BORDER_HEX[dimRange] ?? 'transparent';
  const hasDetails = (dimKey === "resilience" || dimKey === "decentralization" || dimKey === "dependencyRisk" || dimKey === "liquidity") && dim.score !== null;
  const detailsId = `report-card-${card.id}-${dimKey}-details`;

  return (
    <div className="group">
      <div
        className={cn(
          "relative w-full rounded-lg border border-l-[4px] px-3 py-2.5 transition-colors",
          hasDetails ? "cursor-pointer hover:bg-muted/30" : "cursor-default"
        )}
        style={{ borderLeftColor: dimBorder }}
      >
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="pharos-focus-ring absolute inset-0 z-0 cursor-pointer rounded-lg border-0 bg-transparent p-0"
            aria-expanded={expanded}
            aria-controls={detailsId}
          >
            <span className="sr-only">
              {expanded ? "Hide" : "Show"} {DIMENSION_LABELS[dimKey]} details
            </span>
          </button>
        )}
        <div className={cn("relative z-10 flex items-center justify-between", hasDetails && "pointer-events-none")}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              <DimensionLabel dimKey={dimKey} />
            </span>
            {hasDetails && (
              <ChevronDown aria-hidden="true" className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
            )}
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={`text-xs font-semibold ${REPORT_CARD_GRADE_COLORS[dim.grade]}`}
            >
              {dim.grade}
            </Badge>
            <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
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
      </div>

      {/* Expanded Details */}
      {expanded && hasDetails && (
        <div id={detailsId} className="mt-2 ml-4 space-y-2 animate-in slide-in-from-top-1 duration-200">
          {/* Factor breakdown for resilience/decentralization/dependencyRisk */}
          {(dimKey === "resilience" || dimKey === "decentralization" || dimKey === "dependencyRisk") && (
            <div className="space-y-1">
              {dim.detail.split(". ").map((part) => {
                const detail = parseDimensionDetail(part);
                if (!detail) return null;
                return (
                  <div
                    key={`${dimKey}-${detail.label}`}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-muted-foreground">
                      {detail.label}: <span className="text-foreground/80">{detail.desc}</span>
                    </span>
                    <span className={`tabular-nums font-mono ${detail.isNegative ? "text-amber-700 dark:text-amber-400" : "text-foreground/80"}`}>
                      {detail.displayScore}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Live data indicator */}
          {dimKey === "resilience" && card.rawInputs.collateralFromLive && (
            <span className="text-xs text-muted-foreground" title="Scored from live reserve data">(live data)</span>
          )}

          {/* Liquidity breakdown */}
          {dimKey === "liquidity" && (
            <div className="space-y-2">
              <div className="space-y-1">
                {card.rawInputs.liquidityScore != null ? (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">DEX liquidity</span>
                    <span className="tabular-nums text-foreground font-mono">
                      {card.rawInputs.liquidityScore}/100
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">DEX liquidity</span>
                    <span className="text-foreground/60">Unavailable</span>
                  </div>
                )}
                {card.rawInputs.redemptionBackstopScore != null && (
                  <div className="flex items-center justify-between text-xs">
                    <MethodologyLabel topic="redemptionBackstop" className="text-muted-foreground">Redemption backstop</MethodologyLabel>
                    <span className="tabular-nums text-foreground font-mono">
                      {card.rawInputs.redemptionBackstopScore}/100
                      {!card.rawInputs.redemptionUsedForLiquidity
                        ? " (not used)"
                        : ""}
                    </span>
                  </div>
                )}
                {card.rawInputs.effectiveExitScore != null && (
                  <div className="flex items-center justify-between text-xs">
                    <MethodologyLabel topic="effectiveExit" className="text-muted-foreground">Effective exit</MethodologyLabel>
                    <span className="tabular-nums text-foreground font-mono">
                      {card.rawInputs.effectiveExitScore}/100
                    </span>
                  </div>
                )}
              </div>

              {/* Liquidity components */}
              {liquidityComponents && (
                <div className="pt-2 border-t border-border/30 space-y-1.5">
                  {LIQUIDITY_SCORE_WEIGHTS.map((w) => {
                    const value = liquidityComponents[w.key];
                    return value != null ? (
                      <div key={w.key} className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-xs text-muted-foreground">{w.label}</span>
                        <div className="h-1.5 flex-1 rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-foreground/40"
                            style={{ width: `${Math.min(100, value)}%` }}
                          />
                        </div>
                        <span className="w-8 text-right font-mono tabular-nums text-xs">{value.toFixed(0)}</span>
                        <span className="w-8 text-right text-muted-foreground/60 text-xs">{w.displayWeight}</span>
                      </div>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
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
          <DetailSectionTitle>Safety Score</DetailSectionTitle>
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
  const pegDrag =
    card.baseScore != null && card.uncappedOverallScore != null
      ? Math.max(0, card.baseScore - card.uncappedOverallScore)
      : card.baseScore != null && card.overallScore != null
        ? Math.max(0, card.baseScore - card.overallScore)
        : null;
  const parentCapDelta =
    card.overallCapped === true && card.uncappedOverallScore != null && card.overallScore != null
      ? Math.max(0, card.uncappedOverallScore - card.overallScore)
      : null;

  return (
    <Card
      className="overflow-hidden"
      style={{ borderTopWidth: '3px', borderTopColor: topBorderColor }}
    >
      <CardHeader>
        <CardTitle as="h2" className="text-xl font-bold tracking-tight">
          <span className="flex items-center justify-between">
            <MethodologyLabel topic="safetyScore">Safety Score</MethodologyLabel>
            <span className="text-xs font-normal text-muted-foreground">
              v{METHODOLOGY_VERSION}
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Two-column layout: grade + radar | dimension breakdown */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-stretch">
          {/* Left column: grade + radar stacked */}
          <div className="flex flex-col items-center gap-5">
            {/* Grade hero with glow */}
            <div className="relative flex flex-col items-center gap-3 pt-4 pb-2 px-6">
              <GradeGlow grade={card.overallGrade} />
              <div className="flex items-center gap-4">
                <Badge
                  variant="outline"
                  className={`text-5xl px-7 py-3 font-extrabold tracking-tight shadow-lg ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
                >
                  {card.overallGrade}
                </Badge>
                {card.overallScore !== null && (
                  <div className="flex flex-col">
                    <span className="text-3xl font-bold font-mono tabular-nums tracking-tight text-foreground">
                      {card.overallScore}
                      <span className="text-lg text-muted-foreground">/100</span>
                    </span>
                  </div>
                )}
              </div>
              
              {/* Score breakdown - surfaced from details */}
              {card.baseScore != null && card.overallScore != null && (
                <div className="text-xs text-muted-foreground text-center space-y-1 mt-1">
                  <div className="flex items-center gap-2 justify-center">
                    <span>Base: <span className="font-mono text-foreground">{card.baseScore.toFixed(1)}</span></span>
                    {pegDrag != null && pegDrag > 0 ? (
                      <>
                        <span>·</span>
                        <span>Peg: <span className="font-mono text-amber-600 dark:text-amber-400">−{pegDrag.toFixed(1)}</span></span>
                      </>
                    ) : null}
                    {parentCapDelta != null ? (
                      <>
                        <span>·</span>
                        <span>Parent cap: <span className="font-mono text-amber-600 dark:text-amber-400">−{parentCapDelta.toFixed(1)}</span></span>
                      </>
                    ) : null}
                  </div>
                  {card.overallCapped === true && card.rawInputs.variantParentId ? (
                    <div className="flex justify-center">
                      <span className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                        Overall capped at parent stablecoin
                      </span>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            
            {/* Radar chart - larger */}
            <div className="relative w-full max-w-[380px] min-h-[280px] flex-1">
              <ReportCardRadar card={card} labels="short" />
            </div>
          </div>

          {/* Right column: Dimension breakdown */}
          <div className="space-y-2">
            {DIMENSION_ORDER.map((key) => (
              <DimensionRow
                key={key}
                dimKey={key}
                dim={card.dimensions[key]}
                card={card}
                liquidityComponents={liquidityComponents}
              />
            ))}
          </div>
        </div>

        {/* Dependency callout */}
        {card.rawInputs.dependencies.length > 0 && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
            <p className="mb-2 text-sm font-medium text-blue-700 dark:text-blue-400">
              Dependencies
            </p>
            <p className="text-sm text-muted-foreground">
              This stablecoin has exposure to{" "}
              {card.rawInputs.dependencies.map((dep, i) => {
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
