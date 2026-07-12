"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo } from "react";
import { AlertTriangle, ArrowLeft, ArrowLeftRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { PysBreakdown } from "@/components/pys-breakdown";
import { YieldSourceRiskCard } from "@/components/yield-source-risk-card";
import { useYieldHistory, useYieldRankings } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import {
  computePysBreakdown,
  formatYieldWarningSignal,
  formatYieldWarningSignalDescription,
  getPysColor,
} from "@/lib/yield-constants";
import { buildYieldSourceExplorerModel } from "@/lib/yield-source-explorer-model";
import type { YieldSourceRiskDriver } from "@/lib/yield-source-risk";
import { buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { toTimestampMs } from "@/lib/time";
import { classifyApyChange } from "@/lib/yield-change-attribution";
import {
  buildYieldPeerRailModel,
  type YieldPeerRailModel,
  type YieldPeerRelation,
  type YieldPeerSafetyBand,
} from "@/lib/yield-peers";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { formatChartDate, formatPercent, formatScore } from "@shared/lib/format";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT, YIELD_TYPE_LABELS } from "@shared/lib/classification";
import type { YieldHistoryPoint, YieldRanking } from "@shared/types";

// Keep chart-bearing pieces dynamic: a static import here re-attaches the
// whole recharts chunk to the eager first load of all 400+ coin yield pages.
// Loaders route through the detail sections-bundle so this page shares the
// detail family's lazy chunk instead of emitting its own recharts copy.
const YieldHistoryChart = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.YieldHistoryChart),
  {
    loading: () => <Skeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const YieldChangeAttributionCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.YieldChangeAttributionCard),
  {
    loading: () => <Skeleton className="h-[120px] w-full rounded-xl" />,
  },
);

interface YieldAnalysisClientProps {
  id: string;
  staticCoin: StablecoinStaticMeta;
  logoSrc?: string;
}

interface WarningSignalEvent {
  timestamp: number;
  signal: string;
  apy: number;
  sourceLabel: string | null;
}

/** One timeline row: consecutive identical signals collapse into a single
 * entry with a count and time range so repeats don't drown the timeline. */
interface WarningSignalGroup {
  signal: string;
  apy: number;
  sourceLabel: string | null;
  count: number;
  latestTimestamp: number;
  earliestTimestamp: number;
}

interface SourceSwitchEvent {
  timestamp: number;
  apy: number;
  toSourceKey: string | null;
  toSourceLabel: string | null;
  fromSourceLabel: string | null;
}

const YIELD_PEER_RELATION_LABELS: Record<YieldPeerRelation, string> = {
  above: "Above",
  below: "Below",
  top: "Top peer",
};

const YIELD_PEER_SAFETY_BAND_LABELS: Record<YieldPeerSafetyBand, string> = {
  "80-plus": "80+ safety",
  "70-79": "70-79 safety",
  "60-69": "60-69 safety",
  "50-59": "50-59 safety",
  "under-50": "<50 safety",
  unknown: "unrated safety",
};

const YIELD_COMPARE_LINK_LIMIT = 4;

function buildYieldCompareHref(currentId: string, peerIds: readonly string[]): string {
  const ids: string[] = [];
  for (const id of [currentId, ...peerIds]) {
    if (ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= YIELD_COMPARE_LINK_LIMIT) break;
  }
  return `/yield/?compare=${encodeURIComponent(ids.join(","))}`;
}

function formatPeerCohortLabel(model: YieldPeerRailModel): string {
  const yieldTypeLabel = YIELD_TYPE_LABELS[model.currentYieldType] ?? model.currentYieldType;
  if (model.cohortKind === "same-peg") {
    const pegLabel = model.currentPeg ? (PEG_LABELS_SHORT[model.currentPeg] ?? model.currentPeg) : "same-peg";
    return `${pegLabel} peg peers by PYS rank`;
  }
  if (model.cohortKind === "same-yield-type-safety") {
    return `${yieldTypeLabel} · ${YIELD_PEER_SAFETY_BAND_LABELS[model.currentSafetyBand]}`;
  }
  if (model.cohortKind === "same-yield-type") {
    return `${yieldTypeLabel} peers by PYS rank`;
  }
  return "Top yield rows by PYS rank";
}

function formatPeerSelectionNote(model: YieldPeerRailModel): string {
  const windowLabel = model.selectionMode === "neighbors" ? "nearest peers" : "top peers";
  return `${windowLabel} · ${model.cohortSize} row${model.cohortSize === 1 ? "" : "s"} in cohort`;
}

function YieldPeerRail({ model, currentId }: { model: YieldPeerRailModel; currentId: string }) {
  const compareSetHref = buildYieldCompareHref(
    currentId,
    model.items.map((item) => item.row.id),
  );

  return (
    <section className="pharos-card-shell px-4 py-3 sm:px-5" aria-labelledby="yield-peer-rail-title">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Peer rail</p>
          <h2 id="yield-peer-rail-title" className="text-base font-semibold tracking-tight text-foreground">
            Nearby yield context
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatPeerCohortLabel(model)} · {formatPeerSelectionNote(model)}
          </p>
        </div>
        <Link
          href={compareSetHref}
          className="pharos-control-pill inline-flex w-fit items-center gap-1.5 text-xs font-medium"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
          Compare set
        </Link>
      </div>

      <div className="mt-3 overflow-x-auto pb-1">
        <ul className="flex min-w-max gap-3">
          {model.items.map((item) => {
            const row = item.row;
            const compareHref = buildYieldCompareHref(currentId, [row.id]);
            return (
              <li
                key={`${row.id}-${item.relation}`}
                className="min-w-[220px] border-r border-border/60 pr-3 last:border-r-0"
              >
                <Link
                  href={compareHref}
                  className="pharos-focus-ring group block rounded-md px-2 py-2 transition-colors hover:bg-muted/45"
                  aria-label={`Compare ${row.symbol} with the current stablecoin on the yield leaderboard`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="pharos-numeric text-[11px] text-muted-foreground">#{item.rank}</span>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {YIELD_PEER_RELATION_LABELS[item.relation]}
                    </span>
                  </div>
                  <div className="mt-1 min-w-0">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">{row.symbol}</span>
                      <span className="truncate text-xs text-muted-foreground">{row.name}</span>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <div>
                      <span className="block text-[10px] uppercase tracking-[0.1em] text-muted-foreground">PYS</span>
                      <span className="pharos-numeric text-sm font-semibold text-foreground">
                        {row.pharosYieldScore != null ? formatScore(row.pharosYieldScore) : "—"}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="block text-[10px] uppercase tracking-[0.1em] text-muted-foreground">APY</span>
                      <span className="pharos-numeric text-sm font-semibold text-foreground">
                        {formatPercent(row.apy30d)}
                      </span>
                    </div>
                  </div>
                  <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                    Compare
                    <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function StablecoinYieldDetailHeader({
  staticCoin,
  logoSrc,
  ranking,
  sourceRiskDrivers,
  scalingFactor,
}: {
  staticCoin: StablecoinStaticMeta;
  logoSrc?: string;
  ranking: YieldRanking | null;
  sourceRiskDrivers: readonly YieldSourceRiskDriver[];
  scalingFactor: number | null;
}) {
  const pysBreakdown = ranking
    ? computePysBreakdown(
        ranking.apy30d,
        ranking.safetyScore,
        ranking.yieldStability,
        ranking.benchmarkRate,
        ranking.sourceRisk?.sourceRiskPenalty ?? null,
      )
    : null;
  const pysColor = ranking ? getPysColor(ranking.pharosYieldScore) : "text-muted-foreground";

  return (
    <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex items-start gap-3">
            <StablecoinLogo src={logoSrc} name={staticCoin.name} size={56} />
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="pharos-page-title text-2xl sm:text-3xl">{staticCoin.name}</h1>
                <span className="font-mono tabular-nums text-base text-muted-foreground">{staticCoin.symbol}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {GOVERNANCE_LABELS[staticCoin.flags.governance] ?? staticCoin.flags.governance} ·{" "}
                {BACKING_LABELS[staticCoin.flags.backing] ?? staticCoin.flags.backing} ·{" "}
                {PEG_LABELS_SHORT[staticCoin.flags.pegCurrency] ?? staticCoin.flags.pegCurrency}
              </p>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Source comparison, warning signals timeline, and source-switch history for {staticCoin.symbol}.
              </p>
            </div>
          </div>
        </div>

        {ranking && pysBreakdown && scalingFactor !== null ? (
          <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3 sm:min-w-[280px]">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Pharos Yield Score
            </p>
            <PysBreakdown
              mode="inline"
              score={ranking.pharosYieldScore}
              toneClass={pysColor}
              apy30d={ranking.apy30d}
              effectiveYield={pysBreakdown.effectiveYield}
              benchmarkAdjustment={pysBreakdown.benchmarkAdjustment}
              benchmarkSpread={pysBreakdown.benchmarkSpread}
              benchmarkLabel={ranking.benchmarkLabel}
              benchmarkSelectionMode={ranking.benchmarkSelectionMode}
              sourceRiskPenalty={pysBreakdown.sourceRiskPenalty}
              adjustedRiskPenalty={pysBreakdown.adjustedRiskPenalty}
              sustainabilityMult={pysBreakdown.sustainabilityMult}
              grade={ranking.safetyGrade}
              safetyScore={ranking.safetyScore}
              sourceRiskDrivers={sourceRiskDrivers}
              scalingFactor={scalingFactor}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EmptyStateCard({ title, message }: { title: string; message: string }) {
  return (
    <Card className="pharos-card-shell">
      <CardContent className="px-4 py-6">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

function deriveWarningEvents(history: YieldHistoryPoint[]): WarningSignalGroup[] {
  const events: WarningSignalEvent[] = [];
  for (const point of history) {
    if (!point.warningSignals || point.warningSignals.length === 0) continue;
    const timestamp = toTimestampMs(point.date);
    if (!Number.isFinite(timestamp)) continue;
    for (const signal of point.warningSignals) {
      events.push({
        timestamp,
        signal,
        apy: point.apy,
        sourceLabel: point.yieldSource ?? null,
      });
    }
  }
  events.sort((a, b) => b.timestamp - a.timestamp);

  const groups: WarningSignalGroup[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last && last.signal === event.signal && last.sourceLabel === event.sourceLabel && last.apy === event.apy) {
      last.count += 1;
      last.earliestTimestamp = event.timestamp;
    } else {
      groups.push({
        signal: event.signal,
        apy: event.apy,
        sourceLabel: event.sourceLabel,
        count: 1,
        latestTimestamp: event.timestamp,
        earliestTimestamp: event.timestamp,
      });
    }
  }
  return groups;
}

function deriveSourceSwitchEvents(history: YieldHistoryPoint[]): SourceSwitchEvent[] {
  const events: SourceSwitchEvent[] = [];
  let previousSourceLabel: string | null = null;
  for (const point of history) {
    const currentSourceLabel = point.yieldSource ?? null;
    if (point.sourceSwitch) {
      const timestamp = toTimestampMs(point.date);
      if (!Number.isFinite(timestamp)) continue;
      events.push({
        timestamp,
        apy: point.apy,
        toSourceKey: point.sourceKey ?? null,
        toSourceLabel: currentSourceLabel,
        fromSourceLabel: previousSourceLabel,
      });
    }
    previousSourceLabel = currentSourceLabel;
  }
  return events.sort((a, b) => b.timestamp - a.timestamp);
}

export default function YieldAnalysisClient({ id, staticCoin, logoSrc }: YieldAnalysisClientProps) {
  const rankingsQuery = useYieldRankings();
  const historyQuery = useYieldHistory(id, { days: 90, mode: "best" });
  const { getParam, replaceParams } = useUrlFilters();

  const coin = TRACKED_META_BY_ID.get(id);
  const isPreLaunch = coin?.status === "pre-launch";
  const isFrozen = coin?.status === "frozen";
  const shouldHaveYieldData = coin?.flags.yieldBearing ?? false;

  const ranking = useMemo(
    () => rankingsQuery.data?.rankings.find((row) => row.id === id) ?? null,
    [rankingsQuery.data, id],
  );

  const sourceExplorer = useMemo(() => (ranking ? buildYieldSourceExplorerModel(ranking) : null), [ranking]);

  const peerRailModel = useMemo(
    () =>
      ranking
        ? buildYieldPeerRailModel({
            rankings: rankingsQuery.data?.rankings ?? [],
            currentId: id,
            currentRow: ranking,
          })
        : null,
    [id, ranking, rankingsQuery.data?.rankings],
  );

  const warningEvents = useMemo(() => deriveWarningEvents(historyQuery.data?.history ?? []), [historyQuery.data]);

  const sourceSwitchEvents = useMemo(
    () => deriveSourceSwitchEvents(historyQuery.data?.history ?? []),
    [historyQuery.data],
  );

  const apyChangeAttribution = useMemo(
    () =>
      ranking
        ? classifyApyChange({
            history: historyQuery.data?.history ?? [],
            decisionLedger: ranking.decisionLedger ?? null,
            yieldStability: ranking.yieldStability ?? null,
          })
        : null,
    [historyQuery.data, ranking],
  );

  const allSourceKeys = useMemo(() => {
    if (!sourceExplorer) return undefined;
    const keys = sourceExplorer.allSources.map((source) => source.sourceKey);
    return keys.length > 1 ? keys : undefined;
  }, [sourceExplorer]);

  const sourcesParam = getParam("sources");
  const overlaySourceKeys = useMemo(() => {
    if (!sourcesParam || !sourceExplorer) return null;
    const available = new Set(sourceExplorer.allSources.map((source) => source.sourceKey));
    const requested = sourcesParam
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key && available.has(key));
    return requested.length > 0 ? requested : null;
  }, [sourcesParam, sourceExplorer]);

  const chartSourceKeys = overlaySourceKeys ?? allSourceKeys;
  const showResetSources = overlaySourceKeys !== null;
  const resetSources = () => {
    replaceParams((params) => {
      params.delete("sources");
    });
  };

  const backLink = (
    <Button variant="ghost" asChild className="w-fit">
      <Link href={buildStablecoinUrl(id)}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to {staticCoin.symbol} detail
      </Link>
    </Button>
  );

  if (rankingsQuery.isLoading) {
    return (
      <div className="space-y-6">
        {backLink}
        <StablecoinYieldDetailHeader
          staticCoin={staticCoin}
          logoSrc={logoSrc}
          ranking={null}
          sourceRiskDrivers={[]}
          scalingFactor={null}
        />
        <Skeleton className="h-[420px] w-full rounded-xl" />
        <Skeleton className="h-[260px] w-full rounded-xl" />
      </div>
    );
  }

  if (rankingsQuery.error && !ranking) {
    return (
      <div className="space-y-6">
        {backLink}
        <StablecoinYieldDetailHeader
          staticCoin={staticCoin}
          logoSrc={logoSrc}
          ranking={null}
          sourceRiskDrivers={[]}
          scalingFactor={null}
        />
        <QueryErrorNotice error={rankingsQuery.error instanceof Error ? rankingsQuery.error : null} hasData={false} />
      </div>
    );
  }

  if (isPreLaunch) {
    return (
      <div className="space-y-6">
        {backLink}
        <StablecoinYieldDetailHeader
          staticCoin={staticCoin}
          logoSrc={logoSrc}
          ranking={null}
          sourceRiskDrivers={[]}
          scalingFactor={null}
        />
        <EmptyStateCard
          title="Pre-launch — no yield data yet"
          message={`${staticCoin.name} is in pre-launch tracking. Yield history will appear here once the stablecoin is live and the cron has observed source data.`}
        />
      </div>
    );
  }

  if (!ranking) {
    const reason = isFrozen
      ? "This stablecoin is frozen — historical yield data is no longer being refreshed."
      : shouldHaveYieldData
        ? "Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet."
        : "This stablecoin doesn't currently have yield data tracked. The protocol may not expose a yield-bearing pool, or the source is not on the curated allowlist.";
    return (
      <div className="space-y-6">
        {backLink}
        <StablecoinYieldDetailHeader
          staticCoin={staticCoin}
          logoSrc={logoSrc}
          ranking={null}
          sourceRiskDrivers={[]}
          scalingFactor={null}
        />
        <EmptyStateCard title="No yield data available" message={reason} />
      </div>
    );
  }

  const benchmarkIsFallback = ranking.benchmarkSelectionMode === "fallback-usd" || !!ranking.benchmarkIsFallback;
  const benchmarkRate = ranking.benchmarkRate ?? rankingsQuery.data?.riskFreeRate ?? 0;
  const medianApy = rankingsQuery.data?.medianApy ?? 0;
  const historySources = sourceExplorer?.historySources ?? [];
  const sourceSwitchCount30d = ranking.sourceRisk?.sourceSwitchCount30d ?? null;
  const currentWarningSignals = ranking.warningSignals;

  return (
    <div className="space-y-6">
      {backLink}

      <StablecoinYieldDetailHeader
        staticCoin={staticCoin}
        logoSrc={logoSrc}
        ranking={ranking}
        sourceRiskDrivers={sourceExplorer?.sourceRiskDrivers ?? []}
        scalingFactor={rankingsQuery.data?.scalingFactor ?? null}
      />

      {peerRailModel ? <YieldPeerRail model={peerRailModel} currentId={id} /> : null}

      {sourceExplorer ? (
        <YieldSourceRiskCard
          sourceLabel={sourceExplorer.selectedSource.displayLabel}
          sourceRisk={sourceExplorer.selectedSource.sourceRisk}
          sourceTvlUsd={sourceExplorer.selectedSource.sourceTvlUsd}
          sourceDepthLens={sourceExplorer.selectedSource.depthLens}
          sourceRiskDrivers={sourceExplorer.selectedSource.sourceRiskDrivers}
          sourceChanged={sourceExplorer.sourceSwitch.changed}
          confidenceTier={sourceExplorer.selectedSource.confidenceTier}
          sourceFreshness={ranking.provenance?.sourceFreshness}
          warningSignals={ranking.warningSignals}
        />
      ) : null}

      {apyChangeAttribution ? <YieldChangeAttributionCard attribution={apyChangeAttribution} /> : null}

      <Card id="source-comparison" className="pharos-card-shell scroll-mt-24">
        <CardHeader className="pb-2">
          <DetailSectionTitle>Source comparison</DetailSectionTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            APY across every retained source over time, plotted against the benchmark hurdle rate
            {medianApy > 0 ? " and peer median." : "."}
          </p>
          <YieldHistoryChart
            stablecoinId={id}
            benchmarkRate={benchmarkRate}
            benchmarkLabel={ranking.benchmarkLabel}
            benchmarkIsFallback={benchmarkIsFallback}
            medianApy={medianApy}
            availableSources={historySources}
            hideSourceSelector
            externalSourceKeys={chartSourceKeys}
          />
          {showResetSources ? (
            <button
              type="button"
              onClick={resetSources}
              className="pharos-focus-ring rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Reset to all sources
            </button>
          ) : null}
        </CardContent>
      </Card>

      <Card id="warning-signals" className="pharos-card-shell scroll-mt-24">
        <CardHeader className="pb-2">
          <DetailSectionTitle>Warning signals timeline</DetailSectionTitle>
        </CardHeader>
        <CardContent>
          {historyQuery.isLoading ? (
            <Skeleton className="h-[160px] w-full rounded-xl" />
          ) : warningEvents.length === 0 ? (
            currentWarningSignals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No warning signals recorded for this stablecoin in the past 90 days.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Historical signal occurrences are not exposed by the yield history API. Showing currently active
                  signals only.
                </p>
                <ul className="space-y-2">
                  {currentWarningSignals.map((signal) => (
                    <li
                      key={signal}
                      className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      <div className="text-sm text-amber-800 dark:text-amber-200">
                        <span className="font-medium">{formatYieldWarningSignal(signal)}</span>
                        <span className="block text-xs text-amber-700/80 dark:text-amber-300/75">
                          {formatYieldWarningSignalDescription(signal)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <ul className="space-y-2">
              {warningEvents.map((event, index) => (
                <li
                  key={`${event.latestTimestamp}-${event.signal}-${index}`}
                  className="flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-200">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-medium">{formatYieldWarningSignal(event.signal)}</span>
                      {event.count > 1 ? (
                        <span className="pharos-numeric text-xs font-medium">×{event.count}</span>
                      ) : null}
                      <span className="pharos-numeric text-xs text-amber-700/80 dark:text-amber-300/75">
                        {event.count > 1
                          ? `${formatChartDate(event.earliestTimestamp, "with-time")} – ${formatChartDate(event.latestTimestamp, "with-time")}`
                          : formatChartDate(event.latestTimestamp, "with-time")}
                      </span>
                    </div>
                    <p className="text-xs text-amber-700/80 dark:text-amber-300/75">
                      {event.sourceLabel ? `${event.sourceLabel} at ` : "APY "}
                      <span className="pharos-numeric">{formatPercent(event.apy)}</span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card id="source-switches" className="pharos-card-shell scroll-mt-24">
        <CardHeader className="pb-2">
          <DetailSectionTitle>Source-switch history</DetailSectionTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {historyQuery.isLoading ? (
            <Skeleton className="h-[120px] w-full rounded-xl" />
          ) : sourceSwitchEvents.length === 0 ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                No source switches recorded in the past 90 days.
                {sourceSwitchCount30d != null ? ` (30-day switch count: ${sourceSwitchCount30d}.)` : ""}
              </p>
              {sourceExplorer?.sourceSwitch.changed ? (
                <p>
                  Latest published snapshot switched away from{" "}
                  {sourceExplorer.sourceSwitch.previousSourceDisplayLabel ?? "the previous source"}.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {sourceSwitchCount30d != null ? (
                <p className="text-xs text-muted-foreground">
                  {sourceSwitchCount30d} source switch{sourceSwitchCount30d === 1 ? "" : "es"} in the past 30 days.
                </p>
              ) : null}
              <ul className="space-y-2">
                {sourceSwitchEvents.map((event) => (
                  <li
                    key={`${event.timestamp}-${event.toSourceKey ?? "switch"}`}
                    className="flex items-start gap-3 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2"
                  >
                    <ArrowLeftRight className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
                    <div className="min-w-0 flex-1 text-sm text-sky-800 dark:text-sky-200">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-medium">
                          {event.fromSourceLabel
                            ? `${event.fromSourceLabel} → ${event.toSourceLabel ?? "—"}`
                            : `Switched to ${event.toSourceLabel ?? "—"}`}
                        </span>
                        <span className="pharos-numeric text-xs text-sky-700/80 dark:text-sky-300/75">
                          {formatChartDate(event.timestamp, "with-time")}
                        </span>
                      </div>
                      <p className="text-xs text-sky-700/80 dark:text-sky-300/75">
                        APY at switch: <span className="pharos-numeric">{formatPercent(event.apy)}</span>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
