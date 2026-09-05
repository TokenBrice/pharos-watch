"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { logosById } from "@/lib/logos";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import { useCompareDataModel } from "@/hooks/use-compare-data-model";
import { useCompareShareActions } from "@/hooks/use-compare-share-actions";
import { usePreference } from "@/hooks/use-preferences";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { formatCurrency } from "@shared/lib/format";
import { CoinSelector } from "@/components/coin-selector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { Share2, X, Download, type LucideIcon } from "lucide-react";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { CompareEmptyState } from "@/components/compare-empty-state";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import type { CompareRadarCohort } from "@/components/radar-chart-v9";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CHART_PALETTE } from "@/lib/chart-colors";
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

const CompareRadarV9 = dynamic(() => import("@/components/radar-chart-v9").then((m) => m.CompareRadarV9), {
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

// ---------------------------------------------------------------------------
// CompareScopeHero — FeatureHeroSplit hero band for the compare hub. One Beam =
// the size of the comparable registry (a neutral magnitude, so it takes the
// frost recipe); the right slot decomposes that universe by peg currency with
// the flat proportional-bar idiom. Frost stays the beam: segments use the
// non-frost CHART_PALETTE sequence tones.
// ---------------------------------------------------------------------------

const PEG_SEGMENT_COLORS = CHART_PALETTE.slice(1);
const MAX_PEG_SEGMENTS = 4;

function buildPegSegments(coinOptions: CoinOption[]) {
  const counts = new Map<string, number>();
  for (const option of coinOptions) {
    const peg = TRACKED_META_BY_ID.get(option.id)?.flags.pegCurrency ?? "OTHER";
    counts.set(peg, (counts.get(peg) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, MAX_PEG_SEGMENTS);
  const restCount = sorted.slice(MAX_PEG_SEGMENTS).reduce((sum, [, count]) => sum + count, 0);
  const segments = top.map(([peg, count], index) => ({
    label: peg,
    count,
    color: PEG_SEGMENT_COLORS[index % PEG_SEGMENT_COLORS.length],
  }));
  if (restCount > 0) {
    segments.push({
      label: "Other pegs",
      count: restCount,
      color: PEG_SEGMENT_COLORS[MAX_PEG_SEGMENTS % PEG_SEGMENT_COLORS.length],
    });
  }
  return segments;
}

function CompareHeroMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0 truncate text-sm text-muted-foreground">{label}</span>
      <span className="pharos-numeric shrink-0 text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}

function CompareScopeHero({
  coinOptions,
  selectedCount,
}: {
  coinOptions: CoinOption[];
  selectedCount: number;
}) {
  const segments = useMemo(() => buildPegSegments(coinOptions), [coinOptions]);
  const legend = segments.map((segment) => `${segment.count} ${segment.label}`).join(", ");

  return (
    <FeatureHeroSplit
      ariaLabel="Comparison scope overview"
      beamLabel="Stablecoins ready to compare"
      beamValue={coinOptions.length}
      subKicker="Set Scope"
      sub={
        <div className="divide-y divide-border/50">
          <CompareHeroMetricRow label="Assets per set" value="2–5" />
          <CompareHeroMetricRow label="Preset packs" value={String(COMPARISON_PRESETS.length)} />
          <CompareHeroMetricRow label="Selected now" value={`${selectedCount}/${MAX_COMPARE_COINS}`} />
        </div>
      }
    >
      <div className="flex h-full flex-col justify-center space-y-3 p-5 sm:p-6 lg:p-7">
        <p className="pharos-kicker">Comparable coins by peg</p>
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-border/40"
          role="img"
          aria-label={`Comparable coins by peg: ${legend}.`}
        >
          {segments.map((segment) => (
            <span
              key={segment.label}
              aria-hidden="true"
              style={{ flexGrow: segment.count, backgroundColor: segment.color }}
            />
          ))}
        </div>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {segments.map((segment) => (
            <li key={segment.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: segment.color }} />
              <span className="pharos-numeric text-[13px] font-semibold text-foreground">{segment.count}</span>
              <span className="text-[11px] text-muted-foreground">{segment.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </FeatureHeroSplit>
  );
}

export function CompareClient() {
  const logos = logosById;
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

  const [radarCohort, setRadarCohort] = usePreference<CompareRadarCohort>(
    "pharos-compare-radar-cohort",
    "peg",
    {
      decode: (raw) =>
        raw === "peg" || raw === "mechanism" || raw === "all" ? raw : "peg",
    },
  );

  const {
    cohortBaseline,
    comparisonCoins,
    detailErrors,
    detailLoading,
    flowCardData,
    flowErrorNotice,
    flowScopeLabel,
    flowSeries,
    flowUpdatedAt,
    freshnessQueries,
    globalError,
    handleRetry,
    hasPrimaryData,
    pegRates,
    radarCards,
    reportCardsResponse,
    supplySeries,
  } = useCompareDataModel({
    selectedIds,
    flowHours,
    radarCohort,
  });

  const { handleDownload, handleTwitterShare, handleWebShare, shareLoading, toast } = useCompareShareActions({
    comparisonCoins,
    logos,
    pegRates,
    radarCards,
    axisOrder: ["backing", "exit", "control"],
    axisLabels: { backing: "Backing", exit: "Exit", control: "Control" },
  });

  // nowSeconds only feeds the "Updated N min ago" flow-staleness label, so the
  // per-minute ticker is only worth running once flow data is present.
  useEffect(() => {
    if (flowUpdatedAt == null) return;
    const updateNow = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateNow();
    const interval = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(interval);
  }, [flowUpdatedAt]);

  const activeSelectionLabel = selectedCoins
    .filter((coin): coin is NonNullable<(typeof selectedCoins)[number]> => coin !== null)
    .map((coin) => coin.symbol)
    .join(" vs ");
  const selectionInsights = useMemo(
    () => buildCompareSelectionInsights({ selectedIds, selectedCoins, comparisonCoins }),
    [comparisonCoins, selectedCoins, selectedIds],
  );
  const flowUpdatedMinutes =
    flowUpdatedAt && nowSeconds != null
      ? Math.max(0, Math.round((nowSeconds - flowUpdatedAt) / 60))
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
        hasData={hasPrimaryData}
        onRetry={handleRetry}
        queries={freshnessQueries}
      />
      <SafetyScoreV9StatusNotice response={reportCardsResponse} />
      <CompareScopeHero coinOptions={coinOptions} selectedCount={selectedIds.length} />
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
          {toast && <span className="text-xs text-muted-foreground animate-fade-in">{toast}</span>}
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
        <div className="space-y-6 animate-fade-in">
          <ComparisonTable coins={comparisonCoins} pegRates={pegRates} logos={logos} detailErrors={detailErrors} />

          {/* Live Flow Signals */}
          {flowErrorNotice ? <QueryErrorNotice {...flowErrorNotice} /> : null}
          {(flowCardData.length > 0 || flowSeries.length > 0) && (
            <div className="pharos-card-shell space-y-4 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="pharos-section-title">
                  Live Flow Signals
                </h3>
                {flowUpdatedMinutes != null && (
                  <span className="text-xs text-muted-foreground">
                    Updated {flowUpdatedMinutes} min ago · {flowScopeLabel}
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
                  {flowCardData.length} of {selectedIds.length} selected coins have tracked issuance flows.
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
                  <CardTitle className="pharos-section-title">Safety Score Comparison</CardTitle>
                  <CohortToggle
                    cohort={radarCohort}
                    onChange={setRadarCohort}
                    effective={cohortBaseline.effectiveCohort}
                    memberCount={cohortBaseline.memberCount}
                  />
                </CardHeader>
                <CardContent className="flex-1 flex flex-col items-center justify-center">
                  <div className="pharos-chart-stage flex w-full justify-center">
                    <CompareRadarV9 series={radarCards} cohortSeries={cohortBaseline.series} size={300} />
                  </div>
                  <div className="flex flex-wrap gap-3 justify-center mt-3">
                    {radarCards.map(({ card, color, symbol }) => (
                      <div key={card.id} className="flex items-center gap-1.5 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                        <span>
                          {symbol}: {card.grade}
                        </span>
                      </div>
                    ))}
                    {cohortBaseline.series.length >= 3 ? (
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
      <ControlPillToggle
        className="flex flex-wrap gap-1"
        ariaLabel="Cohort baseline"
        options={COHORT_OPTIONS}
        value={cohort}
        onChange={onChange}
        buttonClassName="px-2.5 py-1 text-xs"
      />
      {cohort !== effective ? (
        <span className="text-[10px] text-muted-foreground">
          Falling back to All ({memberCount}); selected cohort too thin.
        </span>
      ) : null}
    </div>
  );
}
