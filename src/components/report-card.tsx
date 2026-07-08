"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, CircleHelp, History, Table2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type {
  BridgeRouteRiskConfidence,
  DimensionKey,
  OracleRiskConfidence,
  ReportCard as ReportCardType,
} from "@shared/types";
import {
  BREAKDOWN_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  DRILLDOWN_DIMENSIONS,
} from "@shared/lib/report-cards";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { CLIENT_TRACKED_STABLECOINS as TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import Link from "next/link";
import { buildStablecoinUrl } from "@/lib/urls";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { MethodologyHint } from "@/components/methodology-hint";
import { cn } from "@/lib/utils";
import { parseDimensionDetail } from "@/lib/report-card-parsing";
import { getSafetyGradeMetadata, gradeBandLabel } from "@/lib/report-card-ui";
import { LIQUIDITY_SCORE_WEIGHTS, type LiquidityScoreComponentKey } from "@shared/lib/liquidity-score-weights";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";

// ---------------------------------------------------------------------------
// Dimension Row Component
// ---------------------------------------------------------------------------

function dimensionHintTopic(dimKey: DimensionKey): "resilience" | "dependencyRisk" | null {
  if (dimKey === "resilience") return "resilience";
  if (dimKey === "dependencyRisk") return "dependencyRisk";
  return null;
}

type OracleRiskDisplay = NonNullable<ReportCardType["oracleRisk"]>;
type BridgeRouteRiskDisplay = NonNullable<ReportCardType["bridgeRouteRisk"]>;
type RiskSourceLink =
  NonNullable<OracleRiskDisplay["sources"]>[number] | NonNullable<BridgeRouteRiskDisplay["sources"]>[number];

const ORACLE_RISK_CONFIDENCE_LABELS: Record<OracleRiskConfidence, string> = {
  verified: "Verified",
  probable: "Probable",
  limited: "Limited",
  unknown: "Unknown",
};

const BRIDGE_ROUTE_RISK_CONFIDENCE_LABELS: Record<BridgeRouteRiskConfidence, string> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

function RiskSourceLinks({ links }: { links: readonly RiskSourceLink[] }) {
  if (links.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs">
      {links.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline"
        >
          {source.label}
        </a>
      ))}
    </div>
  );
}

function ScoreWithBand({ score, label, children }: { score: number; label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{gradeBandLabel(score, label)}</TooltipContent>
    </Tooltip>
  );
}

const HEADER_ICON_BUTTON_CLASS =
  "pharos-focus-ring inline-flex !h-11 !min-h-11 !w-11 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground md:!h-5 md:!min-h-0 md:!w-5";
const SAFETY_INLINE_HINT_BUTTON_CLASS =
  "pharos-focus-ring -mx-3.5 -my-3.5 inline-flex h-11 min-h-11 w-11 shrink-0 items-center justify-center rounded-full border border-transparent bg-muted/70 p-0 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground md:mx-0 md:my-0 md:h-4 md:min-h-0 md:w-4";

function ReportCardHeaderActions({ updatedAtMs }: { updatedAtMs?: number | null }) {
  const methodology = METHODOLOGY_CONTEXT.safetyScore;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {updatedAtMs != null ? (
        <FreshnessIndicator
          compact
          updatedAtMs={updatedAtMs}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.reportCards * 1000}
          labelPrefix="Updated"
        />
      ) : null}
      {updatedAtMs != null ? (
        <span className="text-muted-foreground/50" aria-hidden="true">
          ·
        </span>
      ) : null}
      <MethodologyHint topic="safetyScore" buttonClassName={HEADER_ICON_BUTTON_CLASS} />
      {methodology.changelogPath ? (
        <Link
          href={methodology.changelogPath}
          aria-label="Safety Score version history"
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <History className="h-3 w-3" aria-hidden="true" />
        </Link>
      ) : null}
      <ShowYourWorkToggle className={HEADER_ICON_BUTTON_CLASS}>
        <Table2 className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">Show inputs</span>
      </ShowYourWorkToggle>
    </div>
  );
}

function SafetyInlineHint({ topic }: { topic: MethodologyContextKey }) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <MethodologyHint topic={topic} asChild className="pointer-events-auto">
      <button type="button" aria-label={`Explain ${item.title}`} className={SAFETY_INLINE_HINT_BUTTON_CLASS}>
        <CircleHelp className="h-2.5 w-2.5" aria-hidden="true" />
      </button>
    </MethodologyHint>
  );
}

/** Shared wrapper for OracleRiskPanel and BridgeRouteRiskPanel.
 * Renders the border-left container, title/score header, a meta row
 * whose content is passed as `metaRow`, a summary paragraph, optional
 * extra content (`children`), and source links. */
function RiskSubPanel({
  title,
  score,
  metaRow,
  summary,
  children,
  sourceLinks,
}: {
  title: string;
  score: number;
  metaRow: ReactNode;
  summary: string;
  children?: ReactNode;
  sourceLinks: readonly RiskSourceLink[];
}) {
  return (
    <div className="border-l border-border/70 pl-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{title}</span>
        <span className="font-mono tabular-nums text-foreground/80">{score}/100</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{metaRow}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      {children}
      <RiskSourceLinks links={sourceLinks} />
    </div>
  );
}

function OracleRiskPanel({ risk }: { risk: OracleRiskDisplay }) {
  const sourceLinks = risk.sources ?? [];
  const branchRows = risk.branches ?? [];

  const metaRow = (
    <>
      <span>{risk.label}</span>
      {risk.inheritedFrom ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            inherited from{" "}
            <Link
              href={buildStablecoinUrl(risk.inheritedFrom.id)}
              className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-2"
            >
              {risk.inheritedFrom.symbol}
            </Link>
          </span>
        </>
      ) : null}
      {risk.confidence ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{ORACLE_RISK_CONFIDENCE_LABELS[risk.confidence]}</span>
        </>
      ) : null}
      {risk.reviewedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            reviewed {risk.reviewedAt}
            {risk.reviewer ? ` by ${risk.reviewer}` : ""}
          </span>
        </>
      ) : null}
    </>
  );

  return (
    <RiskSubPanel
      title="Oracle setup"
      score={risk.score}
      metaRow={metaRow}
      summary={risk.summary}
      sourceLinks={sourceLinks}
    >
      {risk.selectedBranch ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Binding branch: <span className="text-foreground/80">{risk.selectedBranch.label}</span>
        </p>
      ) : null}
      {branchRows.length > 0 ? (
        <div className="mt-2 grid gap-1 text-xs">
          {branchRows.map((branch) => (
            <div key={branch.id} className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-muted-foreground">
                {branch.label}
                {branch.collateralAssets?.length ? ` (${branch.collateralAssets.join(", ")})` : ""}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-foreground/80">{branch.score}/100</span>
            </div>
          ))}
        </div>
      ) : null}
    </RiskSubPanel>
  );
}

function BridgeRouteRiskPanel({ risk }: { risk: BridgeRouteRiskDisplay }) {
  const sourceLinks = risk.sources ?? [];
  const protocols = risk.protocols ?? [];

  const metaRow = (
    <>
      <span>{risk.label}</span>
      <span aria-hidden="true">·</span>
      <span>{BRIDGE_ROUTE_RISK_CONFIDENCE_LABELS[risk.confidence]}</span>
      <span aria-hidden="true">·</span>
      <span>
        reviewed {risk.reviewedAt}
        {risk.reviewer ? ` by ${risk.reviewer}` : ""}
      </span>
    </>
  );

  return (
    <RiskSubPanel
      title="Bridge route"
      score={risk.score}
      metaRow={metaRow}
      summary={risk.summary}
      sourceLinks={sourceLinks}
    >
      {protocols.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 text-xs">
          {protocols.map((protocol) => (
            <span
              key={`${protocol.source}-${protocol.slug ?? protocol.name}`}
              className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground"
            >
              {protocol.name}
              {protocol.bridgeTypes?.length ? ` (${protocol.bridgeTypes.join(", ")})` : ""}
            </span>
          ))}
        </div>
      ) : null}
    </RiskSubPanel>
  );
}

interface DimensionRowProps {
  dimKey: DimensionKey;
  dim: ReportCardType["dimensions"][DimensionKey];
  card: ReportCardType;
  liquidityComponents?: ReportCardDetailProps["liquidityComponents"];
}

function DimensionRow({ dimKey, dim, card, liquidityComponents }: DimensionRowProps) {
  const [expanded, setExpanded] = useState(dimKey === "liquidity");
  const hasDetails = DRILLDOWN_DIMENSIONS.has(dimKey) && dim.score !== null;
  const detailsId = `report-card-${card.id}-${dimKey}-details`;
  const hintTopic = dimensionHintTopic(dimKey);

  return (
    <div className="group">
      <div
        className={cn(
          "relative w-full py-3 transition-colors",
          hasDetails ? "cursor-pointer hover:bg-muted/20" : "cursor-default",
        )}
      >
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="pharos-focus-ring absolute inset-0 z-0 cursor-pointer rounded-sm border-0 bg-transparent p-0"
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
          {/* Figma coin template row: flat hairline row \u2014 label left; score \u00b7
              grade chip \u00b7 boxed chevron right. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-sm font-medium", expanded && "font-semibold")}>
              {DIMENSION_LABELS[dimKey]}
            </span>
            {hintTopic && <SafetyInlineHint topic={hintTopic} />}
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
            {dim.score !== null ? (
              <ScoreWithBand score={dim.score} label={DIMENSION_LABELS[dimKey]}>
                <span className="pointer-events-auto whitespace-nowrap text-right font-mono text-sm tabular-nums text-muted-foreground">
                  {dim.score} <span className="text-xs">/ 100</span>
                </span>
              </ScoreWithBand>
            ) : (
              <span className="text-right font-mono text-sm tabular-nums text-muted-foreground">{"\u2014"}</span>
            )}
            <SafetyGradeBadge grade={dim.grade} size="sm" versionTopic="safetyScore" versionVariant="tooltip-only" />
            <span
              aria-hidden="true"
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded border border-border/60",
                !hasDetails && "invisible",
              )}
            >
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                  hasDetails && expanded && "rotate-180",
                )}
              />
            </span>
          </div>
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && hasDetails && (
        <div id={detailsId} className="space-y-2 pb-3 animate-in slide-in-from-top-1 duration-200">
          {/* Factor breakdown for resilience/decentralization/dependencyRisk */}
          {BREAKDOWN_DIMENSIONS.has(dimKey) && (
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

          {dimKey === "decentralization" && card.oracleRisk ? <OracleRiskPanel risk={card.oracleRisk} /> : null}
          {dimKey === "decentralization" && card.bridgeRouteRisk ? (
            <BridgeRouteRiskPanel risk={card.bridgeRouteRisk} />
          ) : null}

          {/* Live data indicator */}
          {dimKey === "resilience" && card.rawInputs.collateralFromLive && (
            <span className="text-xs text-muted-foreground" title="Scored from live reserve data">
              (live data)
            </span>
          )}

          {/* Liquidity breakdown (Figma coin template): mono uppercase
              subscore rows, then the gray weighted-component bars with
              score · weight at the right. */}
          {dimKey === "liquidity" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                {card.rawInputs.liquidityScore != null ? (
                  <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.08em]">
                    <span className="text-muted-foreground">DEX Liquidity</span>
                    <ScoreWithBand score={card.rawInputs.liquidityScore} label="DEX liquidity">
                      <span className="tabular-nums text-foreground">{card.rawInputs.liquidityScore} / 100</span>
                    </ScoreWithBand>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.08em]">
                    <span className="text-muted-foreground">DEX Liquidity</span>
                    <span className="text-foreground/60">Unavailable</span>
                  </div>
                )}
                {card.rawInputs.redemptionBackstopScore != null && (
                  <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.08em]">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      Redemption Backstop
                      <SafetyInlineHint topic="redemptionBackstop" />
                    </span>
                    <ScoreWithBand score={card.rawInputs.redemptionBackstopScore} label="Redemption backstop">
                      <span className="tabular-nums text-foreground">
                        {card.rawInputs.redemptionBackstopScore} / 100
                        {!card.rawInputs.redemptionUsedForLiquidity ? " (not used)" : ""}
                      </span>
                    </ScoreWithBand>
                  </div>
                )}
                {card.rawInputs.effectiveExitScore != null && (
                  <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.08em]">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      Effective Exit
                      <SafetyInlineHint topic="effectiveExit" />
                    </span>
                    <ScoreWithBand score={card.rawInputs.effectiveExitScore} label="Effective exit">
                      <span className="tabular-nums text-foreground">{card.rawInputs.effectiveExitScore} / 100</span>
                    </ScoreWithBand>
                  </div>
                )}
              </div>

              {/* Liquidity components */}
              {liquidityComponents && (
                <div className="space-y-2.5 pt-1.5">
                  {LIQUIDITY_SCORE_WEIGHTS.map((w) => {
                    const value = liquidityComponents[w.key];
                    return value != null ? (
                      <div key={w.key} className="flex items-center gap-2.5">
                        <span className="w-28 shrink-0 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                          {w.label}
                        </span>
                        <div className="h-3 flex-1 overflow-hidden rounded-[3px] border border-neutral-300 bg-neutral-200 dark:border-[#2a2a2d] dark:bg-[#1f1f21]">
                          <div
                            className="h-full rounded-[2px] bg-neutral-500 dark:bg-[#858585]"
                            style={{ width: `${Math.min(100, value)}%` }}
                          />
                        </div>
                        <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
                          {value.toFixed(0)}
                        </span>
                        <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/70">
                          · {w.displayWeight}
                        </span>
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
  liquidityComponents?: Record<LiquidityScoreComponentKey, number> | null;
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
            <SafetyGradeBadge grade="F" size="defunct" versionTopic="safetyScore" versionVariant="tooltip-only" />
            <div>
              <p className="text-lg font-medium text-muted-foreground">Defunct</p>
              <p className="text-sm text-muted-foreground">This stablecoin is no longer active.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

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
      {/* Grade hero (Figma coin template): inline "B+ 72 / 100" line — the
          grade as colored text beside the big score, no circular badge. */}
      <div className={cn("flex flex-col gap-1 pb-1 pt-1", !hasRightColumn && "items-center")}>
        <div className="flex items-baseline gap-2.5">
          <span
            className={cn(
              "pharos-numeric text-4xl font-extrabold leading-none tracking-tight",
              getSafetyGradeMetadata(card.overallGrade).pulse.accentClassName,
            )}
          >
            {card.overallGrade}
          </span>
          {card.overallScore !== null && (
            <ScoreWithBand score={card.overallScore} label="Safety Score">
              <span className="pharos-numeric text-4xl font-extrabold leading-none tracking-tight text-foreground">
                {card.overallScore} <span className="text-2xl font-bold text-muted-foreground">/ 100</span>
              </span>
            </ScoreWithBand>
          )}
        </div>
        <div className="flex min-w-0 flex-col">
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

      {/* Dimension breakdown (Figma coin template): flat hairline-divided
          rows — no per-row boxes and no radar on the detail card. */}
      <div className="divide-y divide-border/40 border-y border-border/40">
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
  );

  return (
    <TooltipProvider>
      <Card className="pharos-card-shell gap-0 overflow-hidden py-0">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-5 sm:px-5">
          <DetailSectionTitle className="text-sm font-semibold tracking-normal text-muted-foreground">
            Safety Score
          </DetailSectionTitle>
          <ReportCardHeaderActions updatedAtMs={updatedAtMs} />
        </CardHeader>
        <CardContent className="px-0 py-0">
          {hasRightColumn ? (
            <div className="grid min-h-[560px] lg:grid-cols-2">
              <div className="min-w-0 px-4 py-5 sm:px-5">{safetyColumn}</div>
              <div className="min-w-0 border-t border-border/40 px-4 py-5 sm:px-5 lg:border-l lg:border-t-0">
                {rightColumn}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl px-4 py-5 sm:px-5">{safetyColumn}</div>
          )}

          {/* Dependency callout */}
          {card.rawInputs.dependencies.length > 0 && (
            <div className="mx-4 mb-5 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 sm:mx-5">
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
                        className="pharos-focus-ring rounded-sm font-medium text-frost-blue underline-offset-2 transition-colors hover:underline"
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
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
