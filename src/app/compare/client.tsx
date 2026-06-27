"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useLogos } from "@/hooks/use-logos";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import { useCompareDataModel } from "@/hooks/use-compare-data-model";
import { useCompareShareActions } from "@/hooks/use-compare-share-actions";
import { usePreference } from "@/hooks/use-preferences";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { formatCurrency } from "@shared/lib/format";
import { CoinSelector } from "@/components/coin-selector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { Share2, X, Download, type LucideIcon } from "lucide-react";
import { DIMENSION_ORDER, DIMENSION_SHORT_LABELS } from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { CompareEmptyState } from "@/components/compare-empty-state";
import { resolveCohortBaseline, type CompareRadarCohort } from "@/components/radar-chart";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import {
  COMPARISON_PRESETS,
  MAX_COMPARE_COINS,
  getPresetCoins,
} from "@/lib/compare-config";
import { buildCompareSelectionInsights } from "@/lib/compare-selection-insights";
import type { CoinOption } from "@/lib/compare-types";

const ComparisonTable = dynamic(() => import("@/components/comparison-table").then((m) => m.ComparisonTable), {
  loading: () => <ChartSkeleton className="h-[340px] rounded-xl" />,
});

const ComparisonChart = dynamic(() => import("@/components/comparison-chart").then((m) => m.ComparisonChart), {
  loading: () => <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />,
});

const CompareRadar = dynamic(() => import("@/components/radar-chart").then((m) => m.CompareRadar), {
  loading: () => <ChartSkeleton className="h-[420px] rounded-xl" />,
});

const FlowComparisonChart = dynamic(
  () => import("@/components/flow-comparison-chart").then((m) => ({ default: m.FlowComparisonChart })),
  { loading: () => <div className="h-[280px] rounded-xl animate-pulse bg-muted/20" /> },
);

const COMPARE_SHARE_BUTTON_CLASS =
  "pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 sm:min-h-0 sm:py-1.5";

function CompareShareButton({
  icon: Icon,
  label,
  title,
  ariaLabel,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={COMPARE_SHARE_BUTTON_CLASS}
      aria-label={ariaLabel}
      title={title}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

interface CompareMobileSelectionControlsProps {
  selectedIds: readonly string[];
  selectedCoins: readonly (CoinOption | null)[];
  coinOptions: CoinOption[];
  logos?: Record<string, string>;
  disabledIds: Set<string>;
  onSelect: (slotIndex: number, coin: CoinOption) => void;
  onRemove: (slotIndex: number) => void;
  onClear: () => void;
}

export function CompareMobileSelectionControls({
  selectedIds,
  selectedCoins,
  coinOptions,
  logos,
  disabledIds,
  onSelect,
  onRemove,
  onClear,
}: CompareMobileSelectionControlsProps) {
  const mobileAddSlotIndex = selectedIds.length;

  return (
    <div className="space-y-3 sm:hidden">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="pharos-kicker">Selection</p>
          <p className="text-xs text-muted-foreground">
            {selectedIds.length}/{MAX_COMPARE_COINS} selected
          </p>
        </div>
        {selectedIds.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>
      {selectedCoins.map((coin, index) =>
        coin ? (
          <CoinSelector
            key={coin.id}
            coins={coinOptions}
            selected={coin}
            logos={logos}
            disabledIds={disabledIds}
            onSelect={(selectedCoin) => onSelect(index, selectedCoin)}
            onRemove={() => onRemove(index)}
          />
        ) : null,
      )}
      {selectedIds.length < MAX_COMPARE_COINS ? (
        <CoinSelector
          coins={coinOptions}
          selected={null}
          logos={logos}
          disabledIds={disabledIds}
          onSelect={(selectedCoin) => onSelect(mobileAddSlotIndex, selectedCoin)}
          onRemove={() => {}}
        />
      ) : null}
    </div>
  );
}

export function CompareClient() {
  const { data: logos } = useLogos();
  const [nowSeconds, setNowSeconds] = useState<number | null>(null);
  const {
    applyPreset,
    coinOptions,
    disabledIds,
    flowHours,
    handleRemove,
    handleSelect,
    range,
    selectedCoins,
    selectedIds,
    setSelectedIds,
    setFlowHours,
    setRange,
  } = useCompareSelection();

  const {
    bcUpdatedAt,
    bluechipData,
    bluechipError,
    bluechipMeta,
    comparisonCoins,
    dataUpdatedAt,
    detailErrors,
    detailLoading,
    dexData,
    dexError,
    dexMeta,
    flowCardData,
    flowCoinQueries,
    flowData,
    flowSeries,
    globalError,
    handleRetry,
    liqUpdatedAt,
    listData,
    listError,
    listMeta,
    pegError,
    pegMeta,
    pegRates,
    pegSummary,
    pegUpdatedAt,
    radarCards,
    rcUpdatedAt,
    reportCardsData,
    reportCardsError,
    reportCardsMeta,
    supplySeries,
  } = useCompareDataModel({
    selectedIds,
    flowHours,
  });

  const { handleDownload, handleTwitterShare, handleWebShare, shareLoading, toast } = useCompareShareActions({
    comparisonCoins,
    logos,
    pegRates,
    radarCards,
    dimensionOrder: DIMENSION_ORDER,
    dimensionLabels: DIMENSION_SHORT_LABELS,
  });

  const [radarCohort, setRadarCohort] = usePreference<CompareRadarCohort>(
    "pharos-compare-radar-cohort",
    "peg",
    {
      decode: (raw) =>
        raw === "peg" || raw === "mechanism" || raw === "all" ? raw : "peg",
    },
  );

  // nowSeconds only feeds the "Updated N min ago" flow-staleness label, so the
  // per-minute ticker is only worth running once flow data is present.
  const flowUpdatedAt = flowData?.updatedAt ?? null;
  useEffect(() => {
    if (flowUpdatedAt == null) return;
    const updateNow = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateNow();
    const interval = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(interval);
  }, [flowUpdatedAt]);

  const cohortBaseline = useMemo(() => {
    const allCards = reportCardsData?.cards ?? [];
    if (allCards.length === 0 || radarCards.length === 0) {
      return {
        effectiveCohort: "all" as CompareRadarCohort,
        medians: null,
        memberCount: 0,
      };
    }
    const leadCardId = radarCards[0].card.id;
    const leadMeta = TRACKED_META_BY_ID.get(leadCardId);
    const leadPeg = leadMeta?.flags.pegCurrency ?? null;
    const leadMech = leadMeta?.mechanismArchetype ?? null;
    const cohortCards =
      radarCohort === "peg"
        ? allCards.filter((card) => {
            const meta = TRACKED_META_BY_ID.get(card.id);
            return meta?.flags.pegCurrency === leadPeg;
          })
        : radarCohort === "mechanism"
          ? allCards.filter((card) => {
              const meta = TRACKED_META_BY_ID.get(card.id);
              return meta?.mechanismArchetype === leadMech;
            })
          : allCards;
    return resolveCohortBaseline(radarCohort, allCards, cohortCards);
  }, [radarCards, radarCohort, reportCardsData?.cards]);

  const activeSelectionLabel = selectedCoins
    .filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null)
    .map((coin) => coin.symbol)
    .join(" vs ");
  const selectionInsights = useMemo(
    () => buildCompareSelectionInsights({ selectedIds, selectedCoins, comparisonCoins }),
    [comparisonCoins, selectedCoins, selectedIds],
  );
  const flowUpdatedMinutes =
    flowData?.updatedAt && nowSeconds != null
      ? Math.max(0, Math.round((nowSeconds - flowData.updatedAt) / 60))
      : null;

  // Render selector slots (filled slots + empty slots up to MAX_COINS)
  const slots = [];
  for (let i = 0; i < MAX_COMPARE_COINS; i++) {
    const coin = selectedCoins[i] ?? null;
    slots.push(
      <CoinSelector
        key={i}
        coins={coinOptions}
        selected={coin}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={(c) => handleSelect(i, c)}
        onRemove={() => handleRemove(i)}
      />,
    );
  }

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={globalError}
        hasData={!!listData?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error: listError, hasData: !!listData?.peggedAssets?.length, meta: listMeta },
          { preset: "pegSummary", dataUpdatedAt: pegUpdatedAt, error: pegError, hasData: !!pegSummary?.coins?.length, meta: pegMeta },
          { preset: "dexLiquidity", dataUpdatedAt: liqUpdatedAt, error: dexError, hasData: !!dexData, meta: dexMeta },
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
            meta: reportCardsMeta,
          },
          { preset: "bluechip", dataUpdatedAt: bcUpdatedAt, error: bluechipError, hasData: !!bluechipData, meta: bluechipMeta },
        ]}
      />
      {selectedIds.length >= 2 ? (
        <div className="pharos-card-shell px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="pharos-kicker">Active Comparison</p>
                <p className="truncate text-sm text-foreground">
                  {activeSelectionLabel}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Shareable link · up to {MAX_COMPARE_COINS} assets · live data
              </p>
            </div>
            {selectionInsights ? (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="rounded-xl border border-border/60 bg-background/50 px-3.5 py-3">
                  <p className="pharos-kicker">How To Read This Set</p>
                  <p className="mt-1 text-sm text-foreground">{selectionInsights.lens}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectionInsights.cohort} {selectionInsights.structure}
                  </p>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/50 px-3.5 py-3">
                  <p className="pharos-kicker">Jump To Detail</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectionInsights.links.map((coin) => (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-accent lg:min-h-9"
                      >
                        {coin.symbol} detail
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {selectedIds.length >= 2 && (
        <div className="flex items-center justify-end gap-2">
          {toast && <span className="text-xs text-muted-foreground animate-in fade-in duration-300">{toast}</span>}
          <CompareShareButton
            icon={X}
            label="Tweet"
            title="Share on Twitter/X"
            ariaLabel="Share comparison on Twitter"
            disabled={shareLoading}
            onClick={handleTwitterShare}
          />
          <CompareShareButton
            icon={Share2}
            label="Share"
            title="Share comparison"
            ariaLabel="Share comparison link or image"
            disabled={shareLoading}
            onClick={handleWebShare}
          />
          <CompareShareButton
            icon={Download}
            label="Image"
            title="Download comparison image"
            ariaLabel="Download comparison as image"
            disabled={shareLoading}
            onClick={handleDownload}
          />
        </div>
      )}
      <CompareMobileSelectionControls
        selectedIds={selectedIds}
        selectedCoins={selectedCoins}
        coinOptions={coinOptions}
        logos={logos}
        disabledIds={disabledIds}
        onSelect={handleSelect}
        onRemove={handleRemove}
        onClear={() => setSelectedIds(() => [])}
      />
      <div className="hidden gap-3 sm:grid sm:grid-cols-3 lg:grid-cols-5">{slots}</div>

      {selectedIds.length < 2 && (
        <CompareEmptyState
          presets={COMPARISON_PRESETS}
          logos={logos}
          onApplyPreset={(preset) => applyPreset(getPresetCoins(preset), preset.title)}
        />
      )}

      {selectedIds.length >= 2 && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <ComparisonTable coins={comparisonCoins} pegRates={pegRates} logos={logos} detailErrors={detailErrors} />

          {/* Live Flow Signals */}
          {flowCoinQueries.length > 0 && flowCoinQueries.every((q) => q.isError) && (
            <QueryErrorNotice
              error={flowCoinQueries[0]?.error as Error | null}
              hasData={false}
              onRetry={() => flowCoinQueries.forEach((q) => void q.refetch())}
            />
          )}
          {(flowCardData.length > 0 || flowSeries.length > 0) && (
            <div className="pharos-card-shell space-y-4 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="pharos-kicker">
                  Live Flow Signals
                </h3>
                {flowUpdatedMinutes != null && (
                  <span className="text-xs text-muted-foreground">
                    Updated {flowUpdatedMinutes} min ago · Ethereum
                  </span>
                )}
              </div>

              {/* Per-coin flow cards */}
              {flowCardData.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {flowCardData.map((card) => (
                    <CoinFlowCard key={card.id} {...card} />
                  ))}
                </div>
              )}

              {/* Net flow chart */}
              {flowSeries.length >= 2 && (
                <FlowComparisonChart
                  series={flowSeries}
                  hours={flowHours}
                  onHoursChange={(h) => setFlowHours(h as 24 | 168 | 720)}
                />
              )}

              {/* Coverage note */}
              {selectedIds.length > flowCardData.length && (
                <p className="text-xs text-muted-foreground">
                  {flowCardData.length} of {selectedIds.length} selected coins have Ethereum flow tracking.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {detailLoading ? (
              <ChartSkeleton className="h-[300px] sm:h-[400px] rounded-xl" />
            ) : (
              supplySeries.length >= 2 && (
                <ComparisonChart
                  title="Market Cap History Comparison"
                  series={supplySeries}
                  formatValue={formatCurrency}
                  range={range}
                  onRangeChange={setRange}
                  normalizable
                />
              )
            )}

            {radarCards.length >= 2 && (
              <Card className="pharos-card-shell h-full flex flex-col">
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <CardTitle className="pharos-kicker">Safety Score Comparison</CardTitle>
                  <CohortToggle
                    cohort={radarCohort}
                    onChange={setRadarCohort}
                    effective={cohortBaseline.effectiveCohort}
                    memberCount={cohortBaseline.memberCount}
                  />
                </CardHeader>
                <CardContent className="flex-1 flex flex-col items-center justify-center">
                  <CompareRadar cards={radarCards} size={300} cohortMedians={cohortBaseline.medians} />
                  <div className="flex flex-wrap gap-3 justify-center mt-3">
                    {radarCards.map(({ card, color }) => (
                      <div key={card.id} className="flex items-center gap-1.5 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                        <span>
                          {card.symbol}: {card.overallGrade}
                        </span>
                      </div>
                    ))}
                    {cohortBaseline.medians ? (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className="inline-block h-0 w-4 border-t border-dashed border-muted-foreground/60"
                        />
                        <span>
                          {cohortBaseline.effectiveCohort === "peg"
                            ? "Peg cohort"
                            : cohortBaseline.effectiveCohort === "mechanism"
                              ? "Mechanism cohort"
                              : "All tracked"}{" "}
                          median ({cohortBaseline.memberCount})
                        </span>
                      </div>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CohortToggle — D10 control pill for the radar baseline cohort.
// ---------------------------------------------------------------------------

const COHORT_OPTIONS: { value: CompareRadarCohort; label: string }[] = [
  { value: "peg", label: "Peg" },
  { value: "mechanism", label: "Mechanism" },
  { value: "all", label: "All" },
];

interface CohortToggleProps {
  cohort: CompareRadarCohort;
  effective: CompareRadarCohort;
  memberCount: number;
  onChange: (next: CompareRadarCohort) => void;
}

function CohortToggle({ cohort, effective, memberCount, onChange }: CohortToggleProps) {
  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <span className="pharos-meta">Cohort baseline</span>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Cohort baseline">
        {COHORT_OPTIONS.map((option) => {
          const isActive = cohort === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={isActive}
              className={cn(
                "pharos-focus-ring pharos-control-pill px-2.5 py-1 text-xs",
                isActive ? "pharos-control-pill-active" : "",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {cohort !== effective ? (
        <span className="text-[10px] text-muted-foreground">
          Falling back to All ({memberCount}); selected cohort too thin.
        </span>
      ) : null}
    </div>
  );
}
