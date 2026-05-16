"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReportCard as ReportCardType, DimensionKey } from "@shared/types";
import { DIMENSION_LABELS, DIMENSION_ORDER, METHODOLOGY_VERSION } from "@shared/lib/report-cards";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { ReportCardRadar } from "@/components/radar-chart";
import { CLIENT_TRACKED_STABLECOINS as TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import Link from "next/link";
import { buildStablecoinUrl } from "@/lib/urls";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { MethodologyCardActions, MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { cn } from "@/lib/utils";
import { parseDimensionDetail } from "@/lib/report-card-parsing";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { CRON_24H } from "@/lib/cron-intervals";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";

// ---------------------------------------------------------------------------
// Grade-band tooltip helper
// ---------------------------------------------------------------------------

function gradeBandLabel(score: number, metric?: string): string {
  let band: string;
  if (score >= 90) band = "Excellent — top of the grading scale";
  else if (score >= 75) band = "Strong — production-ready";
  else if (score >= 60) band = "Adequate — meaningful weaknesses present";
  else if (score >= 40) band = "Weak — significant risks";
  else band = "Poor — major risks";
  return metric ? `${metric}: ${score} — ${band}` : `${score} — ${band}`;
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
  const hasDetails =
    (dimKey === "resilience" ||
      dimKey === "decentralization" ||
      dimKey === "dependencyRisk" ||
      dimKey === "liquidity") &&
    dim.score !== null;
  const detailsId = `report-card-${card.id}-${dimKey}-details`;

  return (
    <div className="group">
      <div
        className={cn(
          "relative w-full rounded-lg border border-border/60 px-2.5 py-2 transition-colors",
          hasDetails ? "cursor-pointer hover:border-border/80 hover:bg-muted/30" : "cursor-default",
        )}
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
        <div
          className={cn("relative z-10 flex items-center justify-between gap-2", hasDetails && "pointer-events-none")}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              <DimensionLabel dimKey={dimKey} />
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                !hasDetails && "invisible",
                hasDetails && expanded && "rotate-180",
              )}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <SafetyGradeBadge grade={dim.grade} size="sm" />
            {dim.score !== null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="pointer-events-auto w-12 text-right text-sm tabular-nums text-muted-foreground sm:w-14">
                    {dim.score}
                    <span className="text-xs">/100</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{gradeBandLabel(dim.score, DIMENSION_LABELS[dimKey])}</TooltipContent>
              </Tooltip>
            ) : (
              <span className="w-12 text-right text-sm tabular-nums text-muted-foreground sm:w-14">{"\u2014"}</span>
            )}
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
                  <div key={`${dimKey}-${detail.label}`} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {detail.label}: <span className="text-foreground/80">{detail.desc}</span>
                    </span>
                    <span
                      className={`tabular-nums font-mono ${detail.isNegative ? "text-amber-700 dark:text-amber-400" : "text-foreground/80"}`}
                    >
                      {detail.displayScore}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Live data indicator */}
          {dimKey === "resilience" && card.rawInputs.collateralFromLive && (
            <span className="text-xs text-muted-foreground" title="Scored from live reserve data">
              (live data)
            </span>
          )}

          {/* Liquidity breakdown */}
          {dimKey === "liquidity" && (
            <div className="space-y-2">
              <div className="space-y-1">
                {card.rawInputs.liquidityScore != null ? (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">DEX liquidity</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="tabular-nums text-foreground font-mono">
                          {card.rawInputs.liquidityScore}/100
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{gradeBandLabel(card.rawInputs.liquidityScore, "DEX liquidity")}</TooltipContent>
                    </Tooltip>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">DEX liquidity</span>
                    <span className="text-foreground/60">Unavailable</span>
                  </div>
                )}
                {card.rawInputs.redemptionBackstopScore != null && (
                  <div className="flex items-center justify-between text-xs">
                    <MethodologyLabel topic="redemptionBackstop" className="text-muted-foreground">
                      Redemption backstop
                    </MethodologyLabel>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="tabular-nums text-foreground font-mono">
                          {card.rawInputs.redemptionBackstopScore}/100
                          {!card.rawInputs.redemptionUsedForLiquidity ? " (not used)" : ""}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {gradeBandLabel(card.rawInputs.redemptionBackstopScore, "Redemption backstop")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
                {card.rawInputs.effectiveExitScore != null && (
                  <div className="flex items-center justify-between text-xs">
                    <MethodologyLabel topic="effectiveExit" className="text-muted-foreground">
                      Effective exit
                    </MethodologyLabel>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="tabular-nums text-foreground font-mono">
                          {card.rawInputs.effectiveExitScore}/100
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {gradeBandLabel(card.rawInputs.effectiveExitScore, "Effective exit")}
                      </TooltipContent>
                    </Tooltip>
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
  updatedAtMs?: number | null;
  /** Optional slot rendered as the right column at lg+; when absent, the safety column fills the card. */
  rightColumn?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardDetail({ card, liquidityComponents, updatedAtMs, rightColumn }: ReportCardDetailProps) {
  // Defunct coins get a minimal card
  if (card.isDefunct) {
    return (
      <Card
        className="overflow-hidden"
        style={{ borderTopWidth: "3px", borderTopColor: getSafetyGradeMetadata("F").borderColor }}
      >
        <CardHeader>
          <DetailSectionTitle>Safety Score</DetailSectionTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <SafetyGradeBadge grade="F" size="defunct" />
            <div>
              <p className="text-lg font-medium text-muted-foreground">Defunct</p>
              <p className="text-sm text-muted-foreground">This stablecoin is no longer active.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const topBorderColor = getSafetyGradeMetadata(card.overallGrade).borderColor;
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

  const hasRightColumn = !!rightColumn;

  const safetyColumn = (
    <div className="space-y-5">
      {/* Grade hero — left-aligned in split, centered when single-column */}
      <div className={cn("flex items-center gap-4 pb-1 pt-1", !hasRightColumn && "justify-center")}>
        <SafetyGradeBadge grade={card.overallGrade} size="lg" className="sm:hidden" />
        <SafetyGradeBadge grade={card.overallGrade} size="hero" className="hidden sm:inline-flex" />
        <div className="flex min-w-0 flex-col">
          {card.overallScore !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-mono text-3xl font-bold tracking-tight tabular-nums text-foreground">
                  {card.overallScore}
                  <span className="text-lg text-muted-foreground">/100</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{gradeBandLabel(card.overallScore, "Safety Score")}</TooltipContent>
            </Tooltip>
          )}
          {card.baseScore != null && card.overallScore != null && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>
                Base: <span className="font-mono text-foreground">{card.baseScore.toFixed(1)}</span>
              </span>
              {pegDrag != null && pegDrag > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Peg: <span className="font-mono">−{pegDrag.toFixed(1)}</span>
                  </span>
                </>
              ) : null}
              {parentCapDelta != null ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Parent cap: <span className="font-mono">−{parentCapDelta.toFixed(1)}</span>
                  </span>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {card.overallCapped === true && card.rawInputs.variantParentId ? (
        <div className={cn("flex", !hasRightColumn && "justify-center")}>
          <span className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            Overall capped at parent stablecoin
          </span>
        </div>
      ) : null}

      {/* Dimension breakdown — half-width beside the radar at xl+ when the card is in dual-column mode */}
      <div className={cn("grid grid-cols-1 gap-4", hasRightColumn && "xl:grid-cols-2 xl:gap-6 xl:items-center")}>
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
        {hasRightColumn ? (
          <div className="hidden xl:block">
            <ReportCardRadar card={card} labels="short" size={280} />
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <TooltipProvider>
      <Card className="overflow-hidden" style={{ borderTopWidth: "3px", borderTopColor: topBorderColor }}>
        <CardHeader>
          <CardTitle as="h2" className="text-xl font-bold tracking-tight">
            <span className="flex items-center justify-between gap-2">
              <MethodologyLabel topic="safetyScore">Safety Score</MethodologyLabel>
              <span className="flex items-center gap-2">
                {updatedAtMs != null ? (
                  <FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={CRON_24H} labelPrefix="Updated" />
                ) : null}
                <span className="text-xs font-normal text-muted-foreground">v{METHODOLOGY_VERSION}</span>
              </span>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {hasRightColumn ? (
            <div className="grid gap-6 lg:grid-cols-2">
              {safetyColumn}
              {rightColumn}
            </div>
          ) : (
            <div className="mx-auto max-w-2xl">{safetyColumn}</div>
          )}

          {/* Dependency callout */}
          {card.rawInputs.dependencies.length > 0 && (
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
              <p className="mb-2 text-sm font-medium text-blue-700 dark:text-blue-400">Dependencies</p>
              <p className="text-sm text-muted-foreground">
                This stablecoin has exposure to{" "}
                {card.rawInputs.dependencies.map((dep, i) => {
                  const depMeta = TRACKED_STABLECOINS.find((s) => s.id === dep.id);
                  const name = depMeta?.symbol ?? dep.id;
                  const typeLabel =
                    dep.type === "wrapper" ? " (wrapper)" : dep.type === "mechanism" ? " (mechanism-critical)" : "";
                  return (
                    <span key={`${dep.id}-${dep.type}`}>
                      {i > 0 && ", "}
                      <Link
                        href={buildStablecoinUrl(dep.id)}
                        className="pharos-focus-ring rounded-sm font-medium text-blue-700 underline underline-offset-2 transition-colors hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        {name}
                      </Link>
                      {typeLabel && <span className="text-xs text-blue-700/80 dark:text-blue-400/80">{typeLabel}</span>}
                    </span>
                  );
                })}
                . Its dependency risk score reflects the health and stability of these assets.
              </p>
            </div>
          )}

          <ShowYourWorkPanel
            kind="report-card"
            rawInputs={card.rawInputs}
            stablecoinId={card.id}
            stablecoinName={card.name}
          />

          <MethodologyCardActions topic="safetyScore" showWorkToggle className="font-medium" />
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
