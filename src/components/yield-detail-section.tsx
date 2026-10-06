"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { TableSourceLink } from "@/components/table/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { useYieldHistory } from "@/hooks/api-hooks";
import { hasStaticYieldWorkbench } from "@shared/lib/yield-auto-lending";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { YieldSourceIdentity } from "@/components/yield-leaderboard-row-parts";
import { YieldFreshnessLabel } from "@/components/yield-freshness-label";
import { resolveYieldScoreQualification } from "@/lib/yield-constants";
import { YIELD_SOURCE_CONFIDENCE_STYLES, getYieldSourceFreshnessDisplay } from "@/lib/yield-source-risk";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import {
  YIELD_RANK_CHANGE_DRIVER_LABELS,
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  formatYieldSourceRiskCompact,
} from "@/lib/yield-source-risk";
import { formatPercent, formatSignedPercent } from "@shared/lib/format";
import type { YieldRankChangeAttribution } from "@shared/types";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { useYieldDetailSectionModel } from "@/components/yield-detail-section-model";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldDetailSectionAltSources } from "@/components/yield-detail-section-alt-sources";
import { PysBreakdown } from "@/components/pys-breakdown";
import { StatTile } from "@/components/stat-tile";
import { YieldSourceRiskCard } from "@/components/yield-source-risk-card";
import { YieldDecisionLedgerCard } from "@/components/yield-decision-ledger-card";
import { classifyApyChange, type YieldChangeAttributionResult } from "@/lib/yield-change-attribution";
import {
  formatSignedPysDelta, formatYieldBenchmarkSpread, formatYieldBenchmarkSpreadChip,
  formatYieldDepositExplanation, formatYieldDriverContext,
  YIELD_SOURCE_FACT_LABELS, YIELD_CALCULATION_MODE_LABELS, YIELD_SCORE_QUALIFICATION_LABELS,
} from "@/lib/yield-presentation";

interface YieldDetailSectionProps {
  stablecoinId: string;
}

function YieldDetailSectionFrame({ headerEnd, children }: { headerEnd?: ReactNode; children: ReactNode }) {
  return (
    <TooltipProvider>
      <section id="yield" aria-labelledby="yield-intelligence-heading">
        <Card className={DETAIL_MODULE_SHELL_CLASS}>
          <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <StablecoinModuleTitle id="yield-intelligence-heading" className={DETAIL_MODULE_TITLE_CLASS}>
                  <MethodologyLabel topic="pys">Yield Intelligence</MethodologyLabel>
                </StablecoinModuleTitle>
              </div>
              {headerEnd}
            </div>
          </CardHeader>
          <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>{children}</CardContent>
        </Card>
      </section>
    </TooltipProvider>
  );
}

export default function YieldDetailSection({ stablecoinId }: YieldDetailSectionProps) {
  const view = useYieldDetailSectionModel(stablecoinId);
  // 640px matches the sm breakpoint; server snapshot renders the chart so
  // desktop-first crawls keep it, phones fold it after hydration. Called
  // before the status early-returns to keep hook order stable.
  const isMobileViewport = useIsMobile(640, false);
  const historyQuery = useYieldHistory(stablecoinId, { days: 30, mode: "best" });
  const rankingForAttribution = view.status === "ready" ? view.ranking : null;
  const attribution = useMemo(
    () =>
      rankingForAttribution
        ? classifyApyChange({
            history: historyQuery.data?.history ?? [],
            decisionLedger: rankingForAttribution.decisionLedger ?? null,
            yieldStability: rankingForAttribution.yieldStability ?? null,
          })
        : null,
    [historyQuery.data, rankingForAttribution],
  );

  if (view.status === "hidden") {
    return null;
  }

  if (view.status === "loading") {
    return (
      <YieldDetailSectionFrame>
        <Skeleton className="h-[300px] rounded-xl" />
        <Skeleton className="h-9 w-48" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-border/60 bg-muted/20 p-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-8 w-24" />
            </div>
          ))}
        </div>
      </YieldDetailSectionFrame>
    );
  }

  if (view.status === "unavailable") {
    return (
      <YieldDetailSectionFrame>
        {view.shouldHaveYieldData ? (
          <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.
          </div>
        ) : null}
      </YieldDetailSectionFrame>
    );
  }

  if (view.status === "error") {
    return (
      <YieldDetailSectionFrame>
        <QueryErrorNotice error={view.error} hasData={false} />
      </YieldDetailSectionFrame>
    );
  }

  const { ranking } = view;
  const totalSourceCount = 1 + ranking.altSources.length;
  const headerEnd = (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", view.yieldTypeBadge)}>
      {view.yieldTypeLabel}
    </span>
  );
  const coin = CLIENT_TRACKED_META_BY_ID.get(stablecoinId);
  const hasWorkbench = coin != null && hasStaticYieldWorkbench(coin);
  const qualification = resolveYieldScoreQualification(ranking);
  const qualificationLabel = YIELD_SCORE_QUALIFICATION_LABELS[qualification as keyof typeof YIELD_SCORE_QUALIFICATION_LABELS];
  const rolePrefix = ranking.sourceRole === "canonical-holder"
    ? YIELD_SOURCE_FACT_LABELS.holder
    : ranking.sourceRole === "external-opportunity"
      ? YIELD_SOURCE_FACT_LABELS.external
      : ranking.sourceRole === "fallback-proxy" && qualification === "estimated"
        ? YIELD_SOURCE_FACT_LABELS.estimated : null;
  const confidence = ranking.provenance?.confidenceTier;
  const freshness = getYieldSourceFreshnessDisplay({
    sourceAgeSeconds: ranking.provenance?.sourceAgeSeconds,
    sourceFreshness: ranking.provenance?.sourceFreshness,
    warningSignals: ranking.warningSignals,
  });
  const venue = ranking.sourceRisk?.venueProtocol;
  const chain = ranking.sourceRisk?.venueChain;
  const deployment = ranking.sourceRisk?.deploymentPlace;
  const calculationMode = ranking.provenance?.calculationMode;
  const excessYield = ranking.excessYield;
  // An excess that prints as ±0.00% (|excess| below half of the last displayed
  // 0.01% digit) is a hurdle match, not a miss; the hurdle label is
  // schema-optional and needs a spoken default (E20).
  const excessWithinDisplayPrecision = excessYield != null && Math.abs(excessYield) < 0.005;
  const benchmarkHurdleLabel = view.ranking.benchmarkLabel ?? "benchmark";
  const historyChart = (
    <YieldHistoryChart
      stablecoinId={stablecoinId}
      defaultDays={30}
      benchmarkRate={view.benchmarkRate}
      benchmarkLabel={view.benchmarkLabel}
      benchmarkIsFallback={view.benchmarkIsFallback}
      medianApy={view.medianApy}
      availableSources={view.historySources}
      hideSourceSelector={view.historySources.length > 1}
      externalSourceKeys={view.externalSourceKeys}
    />
  );

  return (
    <YieldDetailSectionFrame headerEnd={headerEnd}>
      <QueryErrorNotice error={view.refreshError} hasData />
      {view.apiWarning ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {view.apiWarning}
        </div>
      ) : null}
      <div className="space-y-3">
        <div className="space-y-1 text-xs">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {rolePrefix ? <span className="font-medium">{rolePrefix} ·</span> : null}
            <YieldSourceIdentity
              displayLabel={view.sourceExplorer.sourceIdentity.displayLabel}
              url={view.sourceExplorer.sourceIdentity.url}
              confidenceStyle={confidence ? YIELD_SOURCE_CONFIDENCE_STYLES[confidence] : null}
              confidenceLabel={confidence ? YIELD_SOURCE_CONFIDENCE_DEFINITIONS[confidence].label : null}
              sourceChanged={view.sourceExplorer.sourceSwitch.changed}
            />
            {freshness ? <YieldFreshnessLabel freshness={freshness} /> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", view.dataSourceMeta.badge)}>
              {view.dataSourceMeta.label}
            </span>
            {venue ? <span>{YIELD_SOURCE_FACT_LABELS.venue}: {venue}</span> : null}
            {chain ? <span>{venue ? "· " : ""}{chain}</span> : null}
            {deployment && deployment !== "price-derived" && deployment !== "rate-derived" ? (
              <span>{venue || chain ? "· " : ""}{deployment.replaceAll("-", " ")}</span>
            ) : null}
            {ranking.sourceRole === "external-opportunity" && venue && chain ? (
              <span>{formatYieldDepositExplanation(ranking.symbol, venue, chain)}</span>
            ) : null}
            {calculationMode === "price-return" ? <span>{YIELD_SOURCE_FACT_LABELS.priceReturn}</span>
              : ranking.sourceRole === "fallback-proxy" && calculationMode
                ? <span>{YIELD_CALCULATION_MODE_LABELS[calculationMode]}</span> : null}
          </div>
        </div>
        {/* Verdict line derived from published figures (excess yield vs the
            benchmark hurdle, PYS after adjustments) — falls back to the
            neutral caption when the hurdle comparison is unavailable. */}
        <p className="text-sm text-muted-foreground">
          {excessYield != null && view.ranking.apy30d != null
            ? `APY ${formatPercent(view.ranking.apy30d)} is ${formatYieldBenchmarkSpread(excessYield, benchmarkHurdleLabel, view.benchmarkRate)}; PYS ${view.ranking.pharosYieldScore ?? "NR"} after risk adjustments.`
            : "APY trend against the current benchmark hurdle rate and peer median."}
        </p>

      {view.warningSignals.length > 0 ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {view.warningSignals.map((signal) => (
              <span
                key={signal}
                className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", SEVERITY_TONE_CLASS.watch.pill)}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {formatYieldWarningSignal(signal)}
              </span>
            ))}
          </div>
          <ModuleDisclosure label="What these warnings mean" count={view.warningSignals.length}>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              {view.warningSignals.map((signal) => (
                <li key={signal}>
                  <span className="font-medium text-foreground">{formatYieldWarningSignal(signal)}:</span>{" "}
                  {formatYieldWarningSignalDescription(signal)}
                </li>
              ))}
            </ul>
          </ModuleDisclosure>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Yield" variant="yield">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-2xl tabular-nums text-foreground">
              {formatPercent(view.ranking.apy30d)}
            </span>
            {excessYield !== null ? (
              <span
                aria-label={formatYieldBenchmarkSpread(excessYield, benchmarkHurdleLabel, view.benchmarkRate)}
                className={cn(
                  "rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                  excessWithinDisplayPrecision
                    ? "bg-muted text-muted-foreground"
                    : excessYield >= 0
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-700 dark:text-red-400",
                )}
              >
                {formatYieldBenchmarkSpreadChip(excessYield)}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            30d trailing · Current {formatPercent(view.ranking.currentApy)}
            {view.benchmarkSubtitle ? ` · ${view.benchmarkSubtitle}` : ""}
          </p>
        </StatTile>
        <StatTile label={<MethodologyLabel topic="pys">PYS</MethodologyLabel>} variant="yield">
          {qualificationLabel ? <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">{qualificationLabel}</span> : null}
          <PysBreakdown
            mode="inline"
            score={view.ranking.pharosYieldScore}
            pysNullReason={ranking.pysNullReason}
            toneClass={view.pysColor}
            apy30d={view.ranking.apy30d}
            effectiveYield={view.pysBreakdown.effectiveYield}
            benchmarkAdjustment={view.pysBreakdown.benchmarkAdjustment}
            benchmarkSpread={view.pysBreakdown.benchmarkSpread}
            hurdleRebase={view.pysBreakdown.hurdleRebase}
            benchmarkLabel={view.ranking.benchmarkLabel}
            benchmarkSelectionMode={view.ranking.benchmarkSelectionMode}
            sourceRiskPenalty={view.pysBreakdown.sourceRiskPenalty}
            adjustedRiskPenalty={view.pysBreakdown.adjustedRiskPenalty}
            sustainabilityMult={view.pysBreakdown.sustainabilityMult}
            grade={view.ranking.safetyGrade}
            safetyScore={view.ranking.safetyScore}
            sourceRiskDrivers={view.sourceRiskDrivers}
            scalingFactor={view.pysBreakdown.scalingFactor}
          />
          {view.ranking.provenance?.usedDefaultSafety ? (
            <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">Default safety inputs</p>
          ) : null}
        </StatTile>
        <StatTile
          label={<MethodologyLabel topic="yieldStability">Stability</MethodologyLabel>}
          value={view.stabilityValue}
          variant="yield"
        />
      </div>

        {/* The chart folds behind a disclosure on phones (owner feedback: it
            dominated the mobile module while rarely being the key read). */}
        {isMobileViewport ? (
          <ModuleDisclosure label="APY trend" deferredChildren={<div className="mt-2">{historyChart}</div>}>
            <></>
          </ModuleDisclosure>
        ) : historyChart}
      </div>


      {/* ── Detail layer: diagnostics fold behind the standard disclosure —
             active warnings, the chart, and the three stat tiles stay above ── */}
      <ModuleDisclosure label="Yield diagnostics">
      <div className="mt-3 space-y-4">
      {attribution ? <p className="text-sm text-muted-foreground">{attribution.headline}</p> : null}

      <YieldRankMovementCard attribution={ranking.rankChangeAttribution} />

      <YieldSourceRiskCard
        sourceLabel={view.sourceExplorer.selectedSource.displayLabel}
        sourceRisk={view.sourceExplorer.selectedSource.sourceRisk}
        sourceTvlUsd={view.sourceExplorer.selectedSource.sourceTvlUsd}
        sourceDepthLens={view.sourceExplorer.selectedSource.depthLens}
        sourceRiskDrivers={view.sourceExplorer.selectedSource.sourceRiskDrivers}
        sourceChanged={view.sourceExplorer.sourceSwitch.changed}
        confidenceTier={view.sourceExplorer.selectedSource.confidenceTier}
        sourceFreshness={ranking.provenance?.sourceFreshness}
        warningSignals={ranking.warningSignals}
        compact
        showVenueBreakdown={false}
      />

      <YieldDecisionLedgerCard ledger={ranking.decisionLedger} />


      {view.sourceExplorer.retainedAlternates.length >= 2 ? (
        <YieldDetailSectionAltSources
          altSources={view.sourceExplorer.retainedAlternates}
          bestApy={view.ranking.apy30d}
          bestSourceKey={view.sourceExplorer.selectedSource.sourceKey}
          totalSourceCount={totalSourceCount}
          onSelectSource={(sourceKey) => {
            view.toggleSource(sourceKey);
            document.getElementById("yield")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          selectedSourceKeys={view.selectedSourceKeys}
          showAll={view.showAllSources}
          onShowAll={() => view.setShowAllSources(true)}
        />
      ) : view.sourceExplorer.retainedAlternates.length === 1 ? (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Retained alternates</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {view.sourceExplorer.retainedAlternates.map((source) => (
              <div key={source.sourceKey} className="rounded-lg border border-border/60 bg-background/55 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <TableSourceLink href={source.url} className="max-w-full text-sm text-foreground">
                    {source.displayLabel}
                  </TableSourceLink>
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    {formatPercent(source.currentApy)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                  {source.confidenceTier ? (
                    <span>{YIELD_SOURCE_CONFIDENCE_DEFINITIONS[source.confidenceTier]?.label}</span>
                  ) : null}
                  <span title={YIELD_SOURCE_DEPTH_DEFINITIONS[source.depthLens].description}>
                    {YIELD_SOURCE_DEPTH_DEFINITIONS[source.depthLens].label} depth
                  </span>
                  <span className="font-mono tabular-nums">Risk {formatYieldSourceRiskCompact(source.sourceRisk)}</span>
                  {source.rejectionHint ? (
                    <span title={source.rejectionHint.description}>Reason {source.rejectionHint.label}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      </div>
      </ModuleDisclosure>

      {hasWorkbench ? <nav
        aria-label="More yield analysis"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      >
        <span className="font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">More on yield</span>
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
        <Link
          href={buildStablecoinUrl(stablecoinId, "yield/#warning-signals")}
          className="pharos-focus-ring rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Warning timeline
        </Link>
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
        <Link
          href={buildStablecoinUrl(stablecoinId, "yield/#source-switches")}
          className="pharos-focus-ring rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Source switches
        </Link>
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
        <Link
          href={buildStablecoinUrl(stablecoinId, "yield/#source-comparison")}
          className="pharos-focus-ring rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Source comparison
        </Link>
      </nav> : null}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
        <Link
          href={hasWorkbench ? buildStablecoinUrl(stablecoinId, "yield/") : `/yield/?workbenchFallback=${encodeURIComponent(stablecoinId)}`}
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm font-medium underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {hasWorkbench ? "View full yield analysis" : YIELD_SOURCE_FACT_LABELS.fallbackLink}
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
        <EvidenceFooter topic="pys" className="border-t-0 pt-0" />
      </div>
    </YieldDetailSectionFrame>
  );
}

const ATTRIBUTION_TONE: Record<YieldChangeAttributionResult["attribution"], { wrapper: string; kicker: string }> = {
  organic: {
    wrapper: "border-emerald-500/25 bg-emerald-500/5",
    kicker: "text-emerald-700 dark:text-emerald-400",
  },
  "source-switch": {
    wrapper: "border-sky-500/25 bg-sky-500/5",
    kicker: "text-sky-700 dark:text-sky-300",
  },
  mixed: {
    wrapper: "border-amber-500/25 bg-amber-500/5",
    kicker: "text-amber-700 dark:text-amber-300",
  },
  "insufficient-data": {
    wrapper: "border-border/60 bg-muted/20",
    kicker: "text-muted-foreground",
  },
};

export function YieldChangeAttributionCard({ attribution }: { attribution: YieldChangeAttributionResult }) {
  const tone = ATTRIBUTION_TONE[attribution.attribution];
  const hasEvidence = attribution.largestDelta !== null || attribution.sourceSwitchDetail !== undefined;
  return (
    <div className={cn("rounded-xl border px-4 py-3", tone.wrapper)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className={cn("text-xs font-semibold uppercase tracking-[0.12em]", tone.kicker)}>Why this APY changed</p>
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {attribution.confidence} confidence
        </span>
        <MethodologyHint topic="pys" />
      </div>
      <p className="mt-1.5 text-sm text-foreground">{attribution.headline}</p>
      {hasEvidence ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="flex min-h-6 cursor-pointer select-none items-center rounded-sm pharos-focus-ring underline-offset-4 hover:text-foreground hover:underline">
            Show evidence
          </summary>
          <ul className="mt-2 space-y-1">
            {attribution.largestDelta ? (
              <li>
                Largest 30d move:{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatSignedPercent(attribution.largestDelta.value, 2)}
                </span>{" "}
                on{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {new Date(attribution.largestDelta.ts).toISOString().slice(0, 10)}
                </span>
                .
              </li>
            ) : null}
            {attribution.sourceSwitchDetail ? (
              <li>
                Source switched from{" "}
                <span className="text-foreground">
                  {attribution.sourceSwitchDetail.previousSourceLabel ??
                    attribution.sourceSwitchDetail.previousSourceKey}
                </span>{" "}
                with{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatSignedPercent(attribution.sourceSwitchDetail.apy30dDelta, 2)}
                </span>{" "}
                impact on 30d APY.
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function formatSignedRankDelta(delta: number): string {
  if (delta === 0) return "0";
  // Backend contract: previousRank - liveRank. Positive means rank improved.
  return delta > 0 ? `+${delta}` : `-${Math.abs(delta)}`;
}

const DRIVER_CONTRIBUTION_TO_DRIVER_KEY: Record<
  keyof NonNullable<YieldRankChangeAttribution["driverContributions"]>,
  keyof typeof YIELD_RANK_CHANGE_DRIVER_LABELS
> = {
  apy: "apy",
  benchmark: "benchmark",
  stablecoinSafety: "stablecoin-safety",
  sourceRisk: "source-risk",
  sourceSwitch: "source-switch",
  freshness: "freshness",
  volatility: "volatility",
  tvlDepth: "tvl-depth",
};

export function YieldRankMovementCard({ attribution }: { attribution: YieldRankChangeAttribution | null | undefined }) {
  const rankDelta = attribution?.rankDelta ?? null;
  const pysDelta = attribution?.pysDelta ?? null;
  const previousRank = attribution?.previousRank ?? null;
  const primaryDriver = attribution?.primaryDriver ?? null;
  const driverContributions = attribution?.driverContributions ?? null;

  // Stable state: render explicit "no movement" card so users see continuity —
  // but only when a baseline was actually measured. The worker omits the
  // attribution object entirely when previousRank/liveRank is missing, and
  // claiming stability then would assert something never measured (E21).
  const allZero = (rankDelta === null || rankDelta === 0) && (pysDelta === null || Math.abs(pysDelta) < 0.005);
  if (attribution === undefined) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Movement vs last publication
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          No comparison baseline — movement vs the previous publication was not measured.
        </p>
      </div>
    );
  }
  if (allZero) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Movement vs last publication
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">Stable — no movement since last publication.</p>
      </div>
    );
  }
  const arrow = rankDelta == null ? "■" : rankDelta > 0 ? "▲" : rankDelta < 0 ? "▼" : "■";
  const rankColor =
    rankDelta != null && rankDelta > 0
      ? "text-emerald-700 dark:text-emerald-400"
      : rankDelta != null && rankDelta < 0
        ? "text-red-700 dark:text-red-400"
        : "text-muted-foreground";

  const driverLabel = primaryDriver != null ? (YIELD_RANK_CHANGE_DRIVER_LABELS[primaryDriver]?.short ?? null) : null;

  // Different units are never ranked against each other. Primary first, then
  // the stable presentation order, with explicit heuristic context.
  const topDrivers = driverContributions
    ? (Object.keys(DRIVER_CONTRIBUTION_TO_DRIVER_KEY) as Array<keyof typeof driverContributions>)
        .filter((key) => driverContributions[key] != null && driverContributions[key] !== 0)
        .sort((a, b) => Number(DRIVER_CONTRIBUTION_TO_DRIVER_KEY[b] === primaryDriver)
          - Number(DRIVER_CONTRIBUTION_TO_DRIVER_KEY[a] === primaryDriver))
        .map((key) => [key, driverContributions[key]] as const)
    : [];

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Movement vs last publication
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn("font-mono text-2xl tabular-nums", rankColor)}
          aria-label={
            rankDelta != null
              ? rankDelta > 0
                ? `Rank improved by ${Math.abs(rankDelta)} places`
                : rankDelta < 0
                  ? `Rank fell by ${Math.abs(rankDelta)} places`
                  : "Rank unchanged"
              : "Rank delta unavailable"
          }
        >
          {arrow} {rankDelta != null ? `${formatSignedRankDelta(rankDelta)} places` : "—"}
        </span>
        {pysDelta != null ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatSignedPysDelta(pysDelta)}
            {driverLabel ? ` (${driverLabel})` : ""}
          </span>
        ) : null}
      </div>
      {previousRank != null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Previous rank <span className="font-mono tabular-nums text-foreground">#{previousRank}</span>
          {rankDelta != null ? (
            <>
              {" "}
              → current rank <span className="font-mono tabular-nums text-foreground">#{previousRank - rankDelta}</span>
            </>
          ) : null}
          .
        </p>
      ) : null}
      {topDrivers.length > 0 ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="flex min-h-6 cursor-pointer select-none items-center rounded-sm pharos-focus-ring underline-offset-4 hover:text-foreground hover:underline">
            {YIELD_SOURCE_FACT_LABELS.heuristicDrivers}
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {topDrivers.map(([key, value]) => {
              const driverKey = DRIVER_CONTRIBUTION_TO_DRIVER_KEY[key];
              const label = driverKey ? YIELD_RANK_CHANGE_DRIVER_LABELS[driverKey] : null;
              if (!label || value == null) return null;
              return (
                <li key={key}>
                  <span className="text-foreground">{label.short}</span>:{" "}
                  <span className="font-mono tabular-nums text-foreground">{formatYieldDriverContext(key, value)}</span>{" "}
                  <span className="text-muted-foreground/80">— {label.long}</span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
