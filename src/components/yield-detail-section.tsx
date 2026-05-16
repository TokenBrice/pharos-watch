"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { YieldSourceLink } from "@/components/yield-source-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import { YIELD_SOURCE_DEPTH_DEFINITIONS } from "@/lib/yield-source-risk";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { useYieldDetailSectionModel } from "@/components/yield-detail-section-model";
import { formatSignedPercent } from "@/components/yield-detail-section-model";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldDetailSectionAltSources } from "@/components/yield-detail-section-alt-sources";
import { PysBreakdown } from "@/components/pys-breakdown";
import { YieldDetailSectionStatCard } from "@/components/yield-detail-section-stat-card";

interface YieldDetailSectionProps {
  stablecoinId: string;
}

function YieldDetailSectionFrame({ headerEnd, children }: { headerEnd?: ReactNode; children: ReactNode }) {
  return (
    <section id="yield" aria-labelledby="yield-intelligence-heading">
      <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <DetailSectionTitle id="yield-intelligence-heading">
                <MethodologyLabel topic="pys">Yield Intelligence</MethodologyLabel>
              </DetailSectionTitle>
            </div>
            {headerEnd}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </section>
  );
}

export default function YieldDetailSection({ stablecoinId }: YieldDetailSectionProps) {
  const view = useYieldDetailSectionModel(stablecoinId);

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
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs font-medium",
        view.yieldTypeBadge,
      )}
    >
      {view.yieldTypeLabel}
    </span>
  );
  const sourceAgeMinutes =
    ranking.provenance?.sourceAgeSeconds != null
      ? Math.round(ranking.provenance.sourceAgeSeconds / 60)
      : null;
  const sourceTvl = view.sourceExplorer.selectedSource.sourceTvlUsd;
  const sourceDepthMeta = YIELD_SOURCE_DEPTH_DEFINITIONS[view.sourceDepthLens];
  const excessYield = ranking.excessYield;

  return (
    <YieldDetailSectionFrame headerEnd={headerEnd}>
      {view.apiWarning ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {view.apiWarning}
        </div>
      ) : null}
      {view.singleWarning ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span>
            <span className="font-medium">{formatYieldWarningSignal(view.singleWarning)}</span>
            <span className="block text-xs text-amber-800/80 dark:text-amber-200/80">
              {formatYieldWarningSignalDescription(view.singleWarning)}
            </span>
          </span>
        </div>
      ) : null}

      {view.warningSignals.length >= 2 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <strong>Multiple risk signals active:</strong>
              <ul className="mt-1 space-y-0.5 text-xs text-amber-700/90 dark:text-amber-300/85">
                {view.warningSignals.map((signal) => (
                  <li key={signal}>
                    <span className="font-medium">{formatYieldWarningSignal(signal)}</span>
                    <span className="block text-amber-700/80 dark:text-amber-300/75">
                      {formatYieldWarningSignalDescription(signal)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          APY trend against the current benchmark hurdle rate and peer median.
        </p>

        <YieldHistoryChart
          stablecoinId={stablecoinId}
          defaultDays={30}
          benchmarkRate={view.benchmarkRate}
          benchmarkLabel={view.ranking.benchmarkLabel}
          benchmarkIsFallback={view.benchmarkIsFallback}
          medianApy={view.medianApy}
          availableSources={view.historySources}
          hideSourceSelector={view.historySources.length > 1}
          externalSourceKeys={view.externalSourceKeys}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <YieldDetailSectionStatCard label="Yield">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-2xl tabular-nums text-foreground">
              {formatPercent(view.ranking.apy30d)}
            </span>
            {excessYield !== null ? (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                  excessYield >= 0
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-red-500/10 text-red-700 dark:text-red-400",
                )}
              >
                {formatSignedPercent(excessYield)}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            30d trailing · Current {formatPercent(view.ranking.currentApy)}
            {view.benchmarkSubtitle ? ` · ${view.benchmarkSubtitle}` : ""}
          </p>
        </YieldDetailSectionStatCard>
        <YieldDetailSectionStatCard label={<MethodologyLabel topic="pys">PYS</MethodologyLabel>}>
          <PysBreakdown
            mode="inline"
            score={view.ranking.pharosYieldScore}
            toneClass={view.pysColor}
            apy30d={view.ranking.apy30d}
            effectiveYield={view.pysBreakdown.effectiveYield}
            benchmarkAdjustment={view.pysBreakdown.benchmarkAdjustment}
            benchmarkSpread={view.pysBreakdown.benchmarkSpread}
            benchmarkLabel={view.ranking.benchmarkLabel}
            benchmarkSelectionMode={view.ranking.benchmarkSelectionMode}
            sourceRiskPenalty={view.pysBreakdown.sourceRiskPenalty}
            adjustedRiskPenalty={view.pysBreakdown.adjustedRiskPenalty}
            sustainabilityMult={view.pysBreakdown.sustainabilityMult}
            grade={view.ranking.safetyGrade}
            safetyScore={view.ranking.safetyScore}
            sourceRiskDrivers={view.sourceRiskDrivers}
          />
          {view.ranking.provenance?.usedDefaultSafety ? (
            <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">Default safety inputs</p>
          ) : null}
        </YieldDetailSectionStatCard>
        <YieldDetailSectionStatCard
          label={<MethodologyLabel topic="yieldStability">Stability</MethodologyLabel>}
          value={view.stabilityValue}
        />
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
          <span className="font-semibold text-foreground">
            <YieldSourceLink href={view.sourceExplorer.sourceIdentity.url}>
              {view.sourceExplorer.sourceIdentity.displayLabel}
            </YieldSourceLink>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-medium",
              view.dataSourceMeta.badge,
            )}
          >
            {view.dataSourceMeta.label}
          </span>
          {sourceAgeMinutes !== null ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">age {sourceAgeMinutes}m</span>
            </>
          ) : null}
          {sourceTvl !== null ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                TVL {formatCurrency(sourceTvl)}
              </span>
              <span
                className="text-muted-foreground/70"
                title={sourceDepthMeta.description}
              >
                ({sourceDepthMeta.label.toLowerCase()} depth)
              </span>
            </>
          ) : null}
          {view.sourceExplorer.sourceSwitch.changed ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                source changed
                {view.sourceExplorer.sourceSwitch.previousSourceDisplayLabel
                  ? ` from ${view.sourceExplorer.sourceSwitch.previousSourceDisplayLabel}`
                  : ""}
              </span>
            </>
          ) : null}
        </div>
        {view.ranking.provenance?.selectionReason ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {view.ranking.provenance.selectionReason}
          </p>
        ) : null}
      </div>

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
              <div
                key={source.sourceKey}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2"
              >
                <YieldSourceLink href={source.url} className="max-w-full text-sm text-foreground">
                  {source.displayLabel}
                </YieldSourceLink>
                <span className="font-mono text-sm tabular-nums text-muted-foreground">
                  {formatPercent(source.currentApy)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
        <Link
          href={`${buildStablecoinUrl(stablecoinId)}yield/`}
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm font-medium underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          View full yield analysis
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
        <MethodologyCardActions topic="pys" className="border-t-0 pt-0" />
      </div>
    </YieldDetailSectionFrame>
  );
}
