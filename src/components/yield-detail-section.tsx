"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { YieldSourceLink } from "@/components/yield-source-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { useYieldDetailSectionModel } from "@/components/yield-detail-section-model";
import { formatSignedPercent } from "@/components/yield-detail-section-model";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { YieldDetailSectionAltSources } from "@/components/yield-detail-section-alt-sources";
import { YieldDetailSectionPysBreakdown } from "@/components/yield-detail-section-pys-breakdown";
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
              <CardTitle as="h2" id="yield-intelligence-heading" className={DETAIL_SECTION_TITLE_CLASS}>
                Yield Intelligence
              </CardTitle>
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
  const headerEnd = (
    <div className="flex items-center gap-2">
      {ranking.altSources.length > 0 ? (
        <span className="rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-mono text-muted-foreground">
          Sources ({1 + ranking.altSources.length})
        </span>
      ) : null}
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-xs font-medium",
          view.yieldTypeBadge,
        )}
      >
        {view.yieldTypeLabel}
      </span>
    </div>
  );

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
          <span>{formatYieldWarningSignal(view.singleWarning)}</span>
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
                  <li key={signal}>{formatYieldWarningSignal(signal)}</li>
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
          benchmarkRate={view.benchmarkRate}
          benchmarkLabel={view.ranking.benchmarkLabel}
          benchmarkIsFallback={view.benchmarkIsFallback}
          medianApy={view.medianApy}
          availableSources={view.historySources}
          hideSourceSelector={view.historySources.length > 1}
          externalSourceKeys={view.externalSourceKeys}
        />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Excess Yield</span>
        <span
          className={cn(
            "font-mono text-3xl tabular-nums",
            ranking.excessYield === null
              ? "text-muted-foreground"
              : ranking.excessYield >= 0
              ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-700 dark:text-red-400",
          )}
        >
          {formatSignedPercent(view.ranking.excessYield)}
        </span>
        {view.benchmarkSubtitle ? <span className="text-sm text-muted-foreground">{view.benchmarkSubtitle}</span> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <YieldDetailSectionStatCard label="Current APY" value={formatPercent(view.ranking.currentApy)} />
        <YieldDetailSectionStatCard label="30d APY" value={formatPercent(view.ranking.apy30d)} />
        <YieldDetailSectionStatCard label={<MethodologyLabel topic="pys">PYS</MethodologyLabel>}>
          <YieldDetailSectionPysBreakdown
            score={view.ranking.pharosYieldScore}
            toneClass={view.pysColor}
            adjustedRiskPenalty={view.pysBreakdown.adjustedRiskPenalty}
            benchmarkAdjustment={view.pysBreakdown.benchmarkAdjustment}
            benchmarkLabel={view.ranking.benchmarkLabel}
            benchmarkSpread={view.pysBreakdown.benchmarkSpread}
            effectiveYield={view.pysBreakdown.effectiveYield}
            yieldEfficiency={view.pysBreakdown.yieldEfficiency}
            safetyGrade={view.ranking.safetyGrade}
            safetyScore={view.ranking.safetyScore}
            sustainabilityMult={view.pysBreakdown.sustainabilityMult}
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

      <div className="grid gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Yield Source</p>
          <div className="mt-2 text-sm font-medium text-foreground">
            <YieldSourceLink href={view.ranking.yieldSourceUrl}>{view.ranking.yieldSource}</YieldSourceLink>
          </div>
          {view.ranking.provenance?.selectionReason ? (
            <p className="mt-1 text-xs text-muted-foreground">{view.ranking.provenance.selectionReason}</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Data Source</p>
          <div className="mt-2">
            <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", view.dataSourceMeta.badge)}>
              {view.dataSourceMeta.label}
            </span>
          </div>
          {view.ranking.provenance?.sourceAgeSeconds != null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Source age {Math.round(view.ranking.provenance.sourceAgeSeconds / 60)}m
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">TVL</p>
          <p className="mt-2 font-mono text-sm tabular-nums text-foreground">
            {view.ranking.sourceTvlUsd !== null ? formatCurrency(view.ranking.sourceTvlUsd) : "—"}
          </p>
          {view.ranking.provenance?.sourceSwitch ? (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Current best source recently switched</p>
          ) : null}
        </div>
      </div>

      {view.ranking.altSources.length >= 2 ? (
        <YieldDetailSectionAltSources
          altSources={view.ranking.altSources}
          bestApy={view.ranking.apy30d}
          bestSourceKey={view.ranking.provenance?.sourceKey ?? null}
          onSelectSource={(sourceKey) => {
            view.toggleSource(sourceKey);
            document.getElementById("yield")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          selectedSourceKeys={view.selectedSourceKeys}
          showAll={view.showAllSources}
          onShowAll={() => view.setShowAllSources(true)}
        />
      ) : view.ranking.altSources.length === 1 ? (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Alternative Sources</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {view.ranking.altSources.map((source) => (
              <div
                key={source.sourceKey}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2"
              >
                <YieldSourceLink href={source.yieldSourceUrl} className="max-w-full text-sm text-foreground">
                  {source.yieldSource}
                </YieldSourceLink>
                <span className="font-mono text-sm tabular-nums text-muted-foreground">
                  {formatPercent(source.currentApy)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <MethodologyCardActions topic="pys" />
    </YieldDetailSectionFrame>
  );
}
