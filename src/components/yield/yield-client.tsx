"use client";

import { useMemo, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useYieldRankingsSummary } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { logosById } from "@/lib/logos";
import { useWatchlist } from "@/hooks/use-watchlist";
import { YieldLeaderboard } from "@/components/yield-leaderboard";
import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { YieldRiskBudgetSlider } from "@/components/yield-risk-budget-slider";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { YieldSourceBoard } from "@/components/yield/yield-source-board";
import { buildYieldSourceBoardModel } from "@/lib/yield-source-board-model";
import { ReferenceRatesStrip } from "@/components/yield/reference-rates-strip";
import { YieldCoinIndex } from "@/components/yield/coin-index";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { YieldDataHealth } from "@/components/yield/yield-data-health";
import {
  buildYieldViewModel,
  getActiveFilterSummaries,
  RISK_BUDGET_FILTER_KEYS,
  YIELD_PRESET_SPECS,
  YIELD_RISK_BUDGET_SPECS,
  type YieldPresetKey,
  type YieldRiskBudgetKey,
  type YieldViewModel,
  type YieldViewModelRow,
} from "@/lib/yield-view-model";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { buildYieldStoryCallouts } from "@/lib/yield-story-callouts";
import { trackEvent } from "@/lib/analytics";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { YIELD_WORKBENCH_FALLBACK_PARAM, parseYieldWorkbenchFallbackId } from "@shared/lib/yield-workbench-fallback";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";

interface HeroHighlightRowProps {
  label: string;
  logoSrc: string | undefined;
  name: string;
  symbol: string;
  value: string;
  unit: string;
  context: string;
  onClick: () => void;
}

interface HeroPysPodiumProps {
  rows: YieldViewModelRow[];
  logos: Record<string, string>;
  onSelect: (id: string) => void;
}

const HERO_PYS_PODIUM_PLACES = [
  { rank: 1, orderClass: "order-2 -translate-y-3", logoSize: 64 },
  { rank: 2, orderClass: "order-1", logoSize: 52 },
  { rank: 3, orderClass: "order-3 translate-y-1", logoSize: 44 },
] as const;

function HeroPysPodium({ rows, logos, onSelect }: HeroPysPodiumProps) {
  const winner = rows[0];

  return (
    <>
      {winner && winner.pharosYieldScore != null ? (
        <button
          type="button"
          aria-label={`Best Pharos Yield Score: ${winner.name} (${winner.symbol}), PYS ${winner.pharosYieldScore.toFixed(1)}`}
          title={`${winner.symbol} · PYS ${winner.pharosYieldScore.toFixed(1)}`}
          onClick={() => onSelect(winner.id)}
          className="pharos-focus-ring flex shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 text-[9px] font-medium leading-none text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground sm:hidden"
        >
          <StablecoinLogo src={logos[winner.id]} name={winner.name} size={44} />
          <span className="max-w-12 truncate">{winner.symbol}</span>
        </button>
      ) : null}
      <span
        role="group"
        aria-label="Top three Pharos Yield Scores"
        className="hidden shrink-0 items-end gap-2 pr-8 sm:flex"
      >
        {rows.map((row, index) => {
          const place = HERO_PYS_PODIUM_PLACES[index];
          if (!place || row.pharosYieldScore == null) return null;

          return (
            <button
              key={row.id}
              type="button"
              aria-label={`Rank ${place.rank}: ${row.name} (${row.symbol}), PYS ${row.pharosYieldScore.toFixed(1)}`}
              title={`${row.symbol} · PYS ${row.pharosYieldScore.toFixed(1)}`}
              onClick={() => onSelect(row.id)}
              className={`pharos-focus-ring ${place.orderClass} group/podium flex min-w-11 flex-col items-center gap-1 rounded-md px-0.5 py-1 text-[10px] font-medium leading-none text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground`}
            >
              <span className="relative">
                <StablecoinLogo src={logos[row.id]} name={row.name} size={place.logoSize} />
                <span
                  aria-hidden="true"
                  className="absolute -bottom-1 -right-1 inline-flex size-5 items-center justify-center rounded-full border border-border bg-background font-mono text-[10px] font-bold text-foreground"
                >
                  {place.rank}
                </span>
              </span>
              <span className="max-w-14 truncate">{row.symbol}</span>
            </button>
          );
        })}
      </span>
    </>
  );
}

// A folded KPI tile: the standalone interchangeable-tile grid is retired in
// favour of these compact, click-to-scroll metric rows in the hero sub-slot.
function HeroHighlightRow({ label, logoSrc, name, symbol, value, unit, context, onClick }: HeroHighlightRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pharos-focus-ring group flex w-full items-center justify-between gap-3 rounded-md py-2 text-left transition-colors"
    >
      <span className="flex min-w-0 items-center gap-2">
        <StablecoinLogo src={logoSrc} name={name} size={18} />
        <span className="min-w-0">
          <span className="block truncate text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
          <span className="block truncate text-sm font-semibold text-foreground">{symbol}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{context}</span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="pharos-numeric text-sm font-semibold text-foreground">{value}</span>
        <span className="ml-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{unit}</span>
      </span>
    </button>
  );
}

function formatHeroRiskContext(row: YieldViewModelRow): string {
  const safety = row.safetyGrade && row.safetyGrade !== "NR" ? `${row.safetyGrade} safety` : "Safety NR";
  const pys = row.pharosYieldScore !== null ? `PYS ${row.pharosYieldScore.toFixed(1)}` : "PYS NR";
  const posture = row.sourcePosture ? row.sourcePosture.replaceAll("-", " ") : "posture unknown";
  const warningCount = row.warningSignals.length;
  return `${safety} · ${pys} · ${posture} · ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
}

function YieldApiWarnings({ warnings }: { warnings: YieldRankingsSummaryResponse["warnings"] }) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <section aria-label="Yield API warnings" className="space-y-2">
      {warnings.map((warning) =>
        // A publish-time snapshot fallback keeps the page fully populated, so it
        // reads as a neutral freshness note rather than an amber degradation.
        warning.code === "yield-safety-hydration-stale" ? (
          <div
            key={`${warning.code}:${warning.message}`}
            className={cn("rounded-xl border px-4 py-3 text-sm text-muted-foreground", SEVERITY_TONE_CLASS.neutral.banner)}
          >
            <p className="font-medium">{warning.message}</p>
            {warning.reasons && warning.reasons.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground/80">{warning.reasons.join(", ")}</p>
            ) : null}
          </div>
        ) : (
        <div
          key={`${warning.code}:${warning.message}`}
          className={cn("rounded-xl border px-4 py-3 text-sm text-amber-950 dark:text-amber-100", SEVERITY_TONE_CLASS.watch.banner)}
        >
          <p className="font-medium">{warning.message}</p>
          {warning.reasons && warning.reasons.length > 0 ? (
            <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">{warning.reasons.join(", ")}</p>
          ) : null}
        </div>
        ),
      )}
    </section>
  );
}

function SelectorHandoffNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <section
      aria-label="Stablecoin Picker handoff"
      className="rounded-xl border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm text-foreground"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>Opened from the Yield profile in Stablecoin Picker.</p>
        <Link
          href="/screener/picker/?p=yield"
          className="pharos-focus-ring w-fit rounded-sm font-medium underline underline-offset-4 hover:text-foreground/80"
        >
          Adjust picker answers
        </Link>
      </div>
    </section>
  );
}

function YieldWorkbenchFallbackNotice({ stablecoinId }: { stablecoinId: string | null }) {
  const meta = stablecoinId ? CLIENT_TRACKED_META_BY_ID.get(stablecoinId) : null;
  if (!meta) return null;

  return (
    <section
      aria-label="Yield workbench fallback"
      className={cn("rounded-xl border px-4 py-3 text-sm text-foreground", SEVERITY_TONE_CLASS.watch.banner)}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          The dedicated Yield workbench for <span className="font-semibold">{meta.symbol}</span> is not published in
          this release. The full leaderboard is shown instead, with {meta.symbol} kept in comparison when available.
        </p>
        <Link
          href={buildStablecoinUrl(meta.id)}
          className="pharos-focus-ring w-fit shrink-0 rounded-sm font-medium underline underline-offset-4 hover:text-foreground/80"
        >
          View {meta.symbol} dossier
        </Link>
      </div>
    </section>
  );
}

function YieldEmptyStateNotice({
  emptyState,
  onFilterChange,
}: {
  emptyState: YieldViewModel["emptyState"];
  onFilterChange: (key: string, value: string) => void;
}) {
  if (!emptyState.isEmpty) return null;

  return (
    <div className="pharos-empty-note px-4 py-6 text-center">
      <p className="font-medium text-foreground">{emptyState.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{emptyState.description}</p>
      {emptyState.suggestions.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {emptyState.suggestions.map((suggestion) => (
            <button
              key={suggestion.filterKey}
              type="button"
              onClick={() => onFilterChange(suggestion.filterKey, suggestion.targetValue ?? "all")}
              className="pharos-focus-ring pharos-control-pill gap-1.5"
            >
              <span>{suggestion.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">+{suggestion.gain}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function YieldClient() {
  const { data, meta, isLoading, error, dataUpdatedAt, refetch } = useYieldRankingsSummary();
  const logos = logosById;
  const { searchParams, setParam, replaceParams } = useUrlFilters();
  const arrivedFromSelector = searchParams.get("from") === "selector";
  const workbenchFallbackId = parseYieldWorkbenchFallbackId(searchParams.get(YIELD_WORKBENCH_FALLBACK_PARAM));

  const rankings = useMemo(() => dedupeYieldRankings(data?.rankings ?? []), [data?.rankings]);
  const watchlist = useWatchlist();
  const urlParams = useMemo(
    () => ({
      peg: searchParams.get("peg"),
      yieldType: searchParams.get("yieldType"),
      q: searchParams.get("q"),
      warnings: searchParams.get("warnings"),
      minSafety: searchParams.get("minSafety"),
      minTvl: searchParams.get("minTvl"),
      sourceConfidence: searchParams.get("sourceConfidence"),
      benchmark: searchParams.get("benchmark"),
      opportunity: searchParams.get("opportunity"),
      depth: searchParams.get("depth"),
      sourceChanged: searchParams.get("sourceChanged"),
      sourcePosture: searchParams.get("sourcePosture"),
      trending: searchParams.get("trending"),
      watchlist: searchParams.get("watchlist"),
      attention: searchParams.get("attention"),
    }),
    [searchParams],
  );
  const viewModel = useMemo<YieldViewModel>(
    () =>
      buildYieldViewModel(rankings, urlParams, {
        benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
        fallbackBenchmark: data?.provenance?.benchmark ?? null,
        watchlistIds: watchlist.idSet,
      }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, rankings, urlParams, watchlist.idSet],
  );
  const comparisonViewModel = useMemo<YieldViewModel>(
    () =>
      buildYieldViewModel(
        rankings,
        {},
        {
          benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
          fallbackBenchmark: data?.provenance?.benchmark ?? null,
          watchlistIds: watchlist.idSet,
        },
      ),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, rankings, watchlist.idSet],
  );
  const visibleRows = viewModel.visibleRows;
  const storyCallouts = useMemo(() => buildYieldStoryCallouts(visibleRows), [visibleRows]);
  const activeFilterSummaries = useMemo(() => getActiveFilterSummaries(viewModel), [viewModel]);
  const lastZeroResultSignature = useRef<string | null>(null);
  const exposedWarningCodes = useRef(new Set<string>());

  // The hero beam ("One Beam" frost figure) is the headline APY of the best
  // risk-adjusted opportunity in the current view — the row with the highest
  // Pharos Yield Score, not the highest raw APY.
  const topPysRows = useMemo<YieldViewModelRow[]>(() => {
    return visibleRows
      .filter((row) => row.pharosYieldScore != null)
      .toSorted((a, b) => (b.pharosYieldScore ?? 0) - (a.pharosYieldScore ?? 0))
      .slice(0, 3);
  }, [visibleRows]);
  const topPysRow = topPysRows[0] ?? null;

  const handleScrollToRow = useCallback((id: string) => {
    const el = document.getElementById(`yield-row-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const sourceBoardViewModel = useMemo<YieldViewModel>(
    () =>
      buildYieldViewModel(
        rankings,
        {
          ...urlParams,
          depth: null,
          sourceConfidence: null,
          sourcePosture: null,
        },
        {
          benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
          fallbackBenchmark: data?.provenance?.benchmark ?? null,
          watchlistIds: watchlist.idSet,
        },
      ),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, rankings, urlParams, watchlist.idSet],
  );

  const sourceBoardRows = sourceBoardViewModel.visibleRows;

  const sourceBoardModel = useMemo(
    () =>
      buildYieldSourceBoardModel(sourceBoardRows, {
        benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
        fallbackBenchmark: data?.provenance?.benchmark ?? null,
      }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, sourceBoardRows],
  );

  // Counts the full /yield ranking universe per peg currency (not filter-
  // aware), so the reference-rates table can show how many tracked coins
  // each benchmark currency covers.
  const currencyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const option of viewModel.options.peg) {
      if (
        option.value === "all" ||
        option.value === "non-usd" ||
        option.value === "aud-cad" ||
        option.value === "other"
      )
        continue;
      counts[option.value] = option.count;
    }
    return counts;
  }, [viewModel.options.peg]);

  useEffect(() => {
    if (viewModel.invalidParamKeys.length === 0) return;
    replaceParams((params) => {
      for (const key of viewModel.invalidParamKeys) {
        const normalizedValue = viewModel.normalizedParams[key];
        if (normalizedValue === null) params.delete(key);
        else params.set(key, normalizedValue);
      }
    });
  }, [replaceParams, viewModel.invalidParamKeys, viewModel.normalizedParams]);

  useEffect(() => {
    if (!viewModel.emptyState.isEmpty) {
      lastZeroResultSignature.current = null;
      return;
    }
    const signature = activeFilterSummaries
      .map((filter) => filter.key)
      .sort()
      .join(",");
    if (lastZeroResultSignature.current === signature) return;
    lastZeroResultSignature.current = signature;
    trackEvent("yield_zero_results", { active_filter_count: activeFilterSummaries.length });
  }, [activeFilterSummaries, viewModel.emptyState.isEmpty]);

  useEffect(() => {
    for (const warning of data?.warnings ?? []) {
      if (exposedWarningCodes.current.has(warning.code)) continue;
      exposedWarningCodes.current.add(warning.code);
      trackEvent("yield_degraded_exposure", { warning_code: warning.code });
    }
  }, [data?.warnings]);

  const handleFilterChange = useCallback(
    (key: string, value: string) => {
      setParam(key, value);
      const trackedValue = key === "q" ? (value.trim() ? "non-empty" : "empty") : value || "all";
      trackEvent("yield_filter_changed", {
        filter_type: key,
        filter_value: trackedValue,
        action: trackedValue === "all" || trackedValue === "empty" ? "cleared" : "applied",
      });
    },
    [setParam],
  );

  const handleClearFilters = useCallback(() => {
    trackEvent("yield_filters_cleared", { filter_count: activeFilterSummaries.length });
    replaceParams((params) => {
      for (const key of Object.keys(viewModel.normalizedParams)) {
        params.delete(key);
      }
    });
  }, [activeFilterSummaries.length, replaceParams, viewModel.normalizedParams]);

  const handleApplyPreset = useCallback(
    (presetKey: YieldPresetKey) => {
      const spec = YIELD_PRESET_SPECS.find((entry) => entry.key === presetKey);
      if (!spec) return;
      const clearing = viewModel.matchingPreset === presetKey;
      const presetState = viewModel.presets.find((entry) => entry.key === presetKey);
      trackEvent("yield_preset_selected", {
        preset: presetKey,
        action: clearing ? "cleared" : "applied",
        result_count: clearing ? viewModel.totalRows : (presetState?.count ?? 0),
      });
      // Stackable presets: merge spec.overrides on top of current params.
      // Re-clicking the active preset clears just that preset's keys.
      replaceParams((params) => {
        if (viewModel.matchingPreset === presetKey) {
          for (const key of Object.keys(spec.overrides)) {
            params.delete(key);
          }
          return;
        }
        for (const [key, value] of Object.entries(spec.overrides)) {
          if (value == null) continue;
          params.set(key, String(value));
        }
      });
    },
    [replaceParams, viewModel.matchingPreset, viewModel.presets, viewModel.totalRows],
  );

  const handleApplyRiskBudget = useCallback(
    (key: YieldRiskBudgetKey) => {
      const spec = YIELD_RISK_BUDGET_SPECS.find((entry) => entry.key === key);
      if (!spec) return;
      const stop = viewModel.riskBudget.stops.find((entry) => entry.key === key);
      trackEvent("yield_risk_budget_selected", {
        risk_budget: key,
        result_count: stop?.count ?? 0,
      });
      replaceParams((params) => {
        for (const paramKey of RISK_BUDGET_FILTER_KEYS) {
          params.delete(paramKey);
        }
        for (const [paramKey, value] of Object.entries(spec.overrides)) {
          if (value == null) continue;
          params.set(paramKey, String(value));
        }
      });
    },
    [replaceParams, viewModel.riskBudget.stops],
  );

  const stats = viewModel.stats;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-[500px] w-full rounded-xl" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <QueryErrorNotice
          error={error}
          hasData={false}
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  const exhibitTiles = storyCallouts;

  return (
    <div className="space-y-6">
      <YieldDataHealth dataUpdatedAt={dataUpdatedAt} error={error} hasData={!!data} meta={meta} />
      <YieldApiWarnings warnings={data.warnings} />
      <SelectorHandoffNotice visible={arrivedFromSelector} />
      <YieldWorkbenchFallbackNotice stablecoinId={workbenchFallbackId} />

      <div className="flex flex-col gap-6">
        <section aria-label="Risk tolerance" className="order-1 lg:order-2">
          <YieldRiskBudgetSlider stops={viewModel.riskBudget.stops} onSelect={handleApplyRiskBudget} />
        </section>

        <section className="order-2 lg:order-1">
          <FeatureHeroSplit
            ariaLabel="Yield landscape overview"
            mobileSubBeforeVisual
            beamLabel={
              topPysRow ? (
                <span className="space-y-1">
                  <span className="block">
                    Top risk-adjusted yield <span className="text-foreground/70">· {topPysRow.symbol}</span>
                  </span>
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {formatHeroRiskContext(topPysRow)}
                  </span>
                </span>
              ) : (
                "Top risk-adjusted yield"
              )
            }
            beamValue={
              topPysRow ? (
                <span className="flex w-full items-end justify-between gap-2">
                  <span>{formatPercent(topPysRow.apy30d)}</span>
                  <HeroPysPodium rows={topPysRows} logos={logos} onSelect={handleScrollToRow} />
                </span>
              ) : (
                "—"
              )
            }
            beamTitle={
              topPysRow && topPysRow.pharosYieldScore != null
                ? `Best Pharos Yield Score in view: ${topPysRow.pharosYieldScore.toFixed(1)}`
                : undefined
            }
            expand={{ href: "#data", label: "Jump to the full yield leaderboard" }}
            subKicker="This week's leaders"
            sub={
              exhibitTiles ? (
                <div className="divide-y divide-border/50">
                  {exhibitTiles.topYield ? (
                    <HeroHighlightRow
                      label="Highest APY"
                      logoSrc={logos?.[exhibitTiles.topYield.id]}
                      name={exhibitTiles.topYield.name}
                      symbol={exhibitTiles.topYield.symbol}
                      value={formatPercent(exhibitTiles.topYield.apy30d)}
                      unit="APY"
                      context={formatHeroRiskContext(exhibitTiles.topYield)}
                      onClick={() => handleScrollToRow(exhibitTiles.topYield!.id)}
                    />
                  ) : null}
                  {exhibitTiles.mostStable ? (
                    <HeroHighlightRow
                      label="Most stable A+"
                      logoSrc={logos?.[exhibitTiles.mostStable.id]}
                      name={exhibitTiles.mostStable.name}
                      symbol={exhibitTiles.mostStable.symbol}
                      value={formatPercent(exhibitTiles.mostStable.apy30d)}
                      unit="APY"
                      context={formatHeroRiskContext(exhibitTiles.mostStable)}
                      onClick={() => handleScrollToRow(exhibitTiles.mostStable!.id)}
                    />
                  ) : null}
                  {exhibitTiles.largestMarket ? (
                    <HeroHighlightRow
                      label="Largest market"
                      logoSrc={logos?.[exhibitTiles.largestMarket.id]}
                      name={exhibitTiles.largestMarket.name}
                      symbol={exhibitTiles.largestMarket.symbol}
                      value={formatCurrency(exhibitTiles.largestMarket.sourceTvlUsd!)}
                      unit="TVL"
                      context={formatHeroRiskContext(exhibitTiles.largestMarket)}
                      onClick={() => handleScrollToRow(exhibitTiles.largestMarket!.id)}
                    />
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No rows match your filters.</p>
              )
            }
          >
            {visibleRows.length > 0 ? (
              <div>
                <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
                  <span>X: Safety score · Y: APY · outliers are capped</span>
                  <a
                    href="#data"
                    className="pharos-focus-ring shrink-0 rounded-sm font-medium text-foreground underline underline-offset-2"
                  >
                    Full list
                  </a>
                </div>
                <YieldScatterPlot
                  rankings={visibleRows}
                  benchmarkRate={stats.referenceBenchmark?.rate ?? data.riskFreeRate}
                  benchmarkLabel={stats.referenceBenchmark?.label}
                  benchmarkIsFallback={stats.referenceBenchmark?.isFallback}
                  showBenchmarkReference
                  usesDefaultBenchmarkFrame={stats.usesDefaultBenchmarkFrame}
                  logos={logos}
                  compact
                  frame="bare"
                />
              </div>
            ) : (
              <div className="flex h-[420px] items-center justify-center p-6 text-center text-sm text-muted-foreground">
                No rows match your filters
              </div>
            )}
          </FeatureHeroSplit>
        </section>

        <section className="order-3" aria-label="Yield filters">
          <YieldLeaderboardControls
            viewModel={viewModel}
            onFilterChange={handleFilterChange}
            onClearFilters={handleClearFilters}
            onApplyPreset={handleApplyPreset}
          />
        </section>

        <section id="data" tabIndex={-1} aria-labelledby="leaderboard-heading" className="order-4">
          <div className="space-y-3">
            <YieldLeaderboard
              rows={visibleRows}
              logos={logos ?? {}}
              riskFreeRate={data.riskFreeRate}
              medianApy={data.medianApy ?? 0}
              scalingFactor={data.scalingFactor}
              emptyMessage={viewModel.emptyState.description}
              comparisonRows={comparisonViewModel.visibleRows}
              updatedAt={data.updatedAt}
              methodologyLabel={data.methodology?.versionLabel ?? "Pharos Yield Score current"}
              filterSummary={{
                visibleCount: visibleRows.length,
                totalCount: viewModel.totalRows,
                comparisonLabel: viewModel.comparisonLabel,
                activeFilters: activeFilterSummaries,
              }}
            />
          </div>
        </section>

        <section className="order-5 space-y-6" aria-label="Yield reference rates and sources">
          <YieldEmptyStateNotice emptyState={viewModel.emptyState} onFilterChange={handleFilterChange} />
          {visibleRows.length > 0 || sourceBoardModel.selectedCount > 0 ? (
            <>
              <ReferenceRatesStrip
                benchmarks={data.benchmarks ?? data.provenance?.benchmarks ?? null}
                fallbackBenchmark={data.provenance?.benchmark ?? null}
                poolInputMeta={data.provenance?.dlPools ?? null}
                safetySnapshot={data.provenance?.safetySnapshot ?? null}
                currencyCounts={currencyCounts}
              />
              <YieldSourceBoard
                model={sourceBoardModel}
                activeFilters={{
                  depth: viewModel.filters.depth,
                  sourceConfidence: viewModel.filters.sourceConfidence,
                  sourcePosture: viewModel.filters.sourcePosture,
                }}
                onFilterChange={handleFilterChange}
              />
            </>
          ) : null}
          <YieldCoinIndex />
        </section>
      </div>
    </div>
  );
}
