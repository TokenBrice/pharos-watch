"use client";

import { useId, useMemo, useState } from "react";
import { AreaChart, Area, ReferenceArea } from "recharts";
import { Table2 } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { useStressSignalDetail } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { THREAT_BAND_LABELS, THREAT_BAND_STYLES } from "@shared/lib/classification";
import { DEWS_THREAT_BANDS } from "@shared/lib/dews-config";
import { THREAT_BAND_HEX, SIGNAL_CHART_COLORS } from "@/lib/chart-colors";
import { CHART_TICK_FILL } from "@/lib/chart-theme";
import type { ThreatBand } from "@shared/lib/classification";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import { DateTooltip, MonoYAxis, TimeXAxis } from "@/components/chart-primitives/axes";
import { formatChartDate } from "@shared/lib/format";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { cn } from "@/lib/utils";
import { getDewsAmplifiers, getDewsSignalLabel } from "@/lib/dews-signal-utils";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";

const SIGNAL_META: Record<string, { name: string; metricKey: string; metricLabel: string }> = {
  supply: { name: getDewsSignalLabel("supply"), metricKey: "delta1d", metricLabel: "1d change" },
  pool: { name: getDewsSignalLabel("pool"), metricKey: "balanceRatio", metricLabel: "balance ratio" },
  liq: { name: getDewsSignalLabel("liq"), metricKey: "scoreDelta7d", metricLabel: "7d score change" },
  price: { name: getDewsSignalLabel("price"), metricKey: "confidence", metricLabel: "confidence" },
  diverg: { name: getDewsSignalLabel("diverg"), metricKey: "spreadBps", metricLabel: "spread" },
  black: { name: getDewsSignalLabel("black"), metricKey: "events24h", metricLabel: "24h events" },
  flow: { name: getDewsSignalLabel("flow"), metricKey: "burnSurge", metricLabel: "burn surge" },
  yield: { name: getDewsSignalLabel("yield"), metricKey: "warnings", metricLabel: "warnings" },
};

/** "Cross-Source Divergence" → "Cross-source divergence" (sentence-case labels). */
function sentenceCase(label: string): string {
  return label.charAt(0) + label.slice(1).toLowerCase();
}

/**
 * Plain-language reasons for a signal the worker could not score. Every
 * producer code in worker/src/lib/dews is mapped; an unknown code falls back to
 * a generic phrase so a raw machine key never reaches the page.
 */
const UNSCORED_REASON_TEXT: Record<string, string> = {
  "not-applicable": "not applicable",
  "supply-history-anchors-missing": "no supply history yet",
  "price-evidence-unavailable": "no price evidence",
  "invalid-price": "no valid price",
  "peg-type-unavailable": "peg type unknown",
  "peg-reference-missing": "no peg reference rate",
  "peg-reference-unavailable": "no peg reference rate",
  "peg-reference-untrusted": "peg reference rate not trusted",
  "thin-reference": "too few reference rates",
  "blacklist-source-failed": "freeze tracker read failed",
  "mint-burn-data-missing": "no mint/burn data",
  "mint-burn-baseline-too-short": "under 7 days of mint/burn history",
  "mint-burn-stale": "mint/burn data out of date",
  "mint-burn-valuation-partial": "mint/burn values incomplete",
  "mint-burn-valuation-unknown": "mint/burn values incomplete",
  "mint-burn-baseline-valuation-partial": "mint/burn baseline incomplete",
  "mint-burn-baseline-valuation-unknown": "mint/burn baseline incomplete",
  "mint-burn-isolated-no-outflow": "partial chain coverage, no outflow seen",
  "mint-burn-isolated-no-stress-increase": "partial chain coverage, adds no stress",
  "yield-warnings-unscored": "yield flags carry no stress weight",
};

/** Signals the worker leaves unscored without a reason code, by cause. */
const UNSCORED_DEFAULT_TEXT: Record<string, string> = {
  pool: "no DEX pool data",
  liq: "no liquidity history",
  black: "no freeze ledger",
  yield: "no yield warnings",
};

const UNSCORED_GENERIC_TEXT = "no reading this cycle";

export function describeUnscoredSignal(key: string, reason: unknown): string {
  if (typeof reason === "string" && reason.length > 0) {
    return UNSCORED_REASON_TEXT[reason] ?? UNSCORED_GENERIC_TEXT;
  }
  return UNSCORED_DEFAULT_TEXT[key] ?? UNSCORED_GENERIC_TEXT;
}

const BAND_VERDICT: Record<ThreatBand, string> = {
  CALM: "No early signs of depeg stress.",
  WATCH: "Minor stress signals; nothing points to a depeg yet.",
  ALERT: "Several stress signals are elevated.",
  WARNING: "Strong stress signals; depeg risk is elevated.",
  DANGER: "Severe stress across signals; depeg risk is high.",
};

/* The chart reads on the published threat ladder: a fixed 0–100 scale with
 * one tinted band per threshold, named at the right edge. */
const BAND_AREAS = DEWS_THREAT_BANDS.map(({ band, upper }, index) => ({
  band,
  y1: index === 0 ? 0 : DEWS_THREAT_BANDS[index - 1].upper,
  y2: upper,
}));
const Y_TICKS = [0, ...DEWS_THREAT_BANDS.map(({ upper }) => upper)];

function bandForValue(value: number): ThreatBand {
  return DEWS_THREAT_BANDS.find(({ upper }) => value <= upper)?.band ?? "DANGER";
}

/* Only available signals reach a bar (unscored ones are named in one line),
 * so every value here is a measured reading on the threat ladder. A measured
 * zero keeps a visible cap at the origin rather than an empty track. */
function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-muted" aria-hidden="true">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(Math.max(value, 0), 100)}%`, minWidth: "4px", backgroundColor: THREAT_BAND_HEX[bandForValue(value)] }}
      />
    </div>
  );
}

function signedFixed(val: number, digits: number): string {
  const text = Math.abs(val).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${val < 0 ? "\u2212" : "+"}${text}`;
}

function formatMetric(key: string, val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (Array.isArray(val)) return `${val.length} active`;
  if (typeof val === "number") {
    if (key === "delta1d" || key === "delta7d" || key === "scoreDelta7d" || key === "tvlDelta7d") {
      return `${signedFixed(val, 1)}%`;
    }
    if (key === "spreadBps" || key === "primaryDevBps" || key === "dexDevBps") {
      return `${val.toFixed(0)} bps`;
    }
    if (key === "burnSurge" || key === "burnToMintRatio") {
      return `${val.toFixed(1)}×`;
    }
    return String(val);
  }
  return String(val);
}

interface DEWSDetailProps {
  stablecoinId: string;
}

export function DEWSDetail({ stablecoinId }: DEWSDetailProps) {
  const chartSummaryId = useId();
  const { data, isLoading, error, meta, refetch } = useStressSignalDetail(stablecoinId);
  const history = data?.history;
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Include per-signal values in chart data for breakdown mode
  const chartData = useMemo(() => {
    if (!history?.length) return [];
    return history.map((h) => {
      const point: Record<string, unknown> = {
        ts: h.date * 1000,
        score: h.score,
        band: h.band,
      };
      for (const key of Object.keys(SIGNAL_META)) {
        const sig = h.signals?.[key];
        point[key] = sig?.available ? sig.value : null;
      }
      return point;
    });
  }, [history]);

  const chartSummary = useMemo(() => {
    if (!history || history.length < 2) return "";
    const first = history[0];
    const last = history[history.length - 1];
    const peak = history.reduce((max, h) => (h.score > max.score ? h : max), first);
    const day = (sec: number) => formatChartDate(sec * 1000, "short");
    return `Composite score from ${Math.round(first.score)} on ${day(first.date)} to ${Math.round(last.score)} on ${day(last.date)}; peak ${Math.round(peak.score)} on ${day(peak.date)}, out of 100.`;
  }, [history]);

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <StablecoinModuleTitle>
            <MethodologyLabel topic="dews">DEWS: Depeg Early Warning System</MethodologyLabel>
          </StablecoinModuleTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 bg-muted rounded-sm" />
        </CardContent>
      </Card>
    );
  }

  // A failed refresh keeps the retained detail; the in-card banner below owns its age.
  if (error && data == null) {
    return <QueryErrorNotice error={error} hasData={false} onRetry={() => void refetch()} />;
  }

  if (!data?.current) {
    return null;
  }

  const { score, band, signals } = data.current;
  const typedBand = band as ThreatBand;
  const bandStyle = THREAT_BAND_STYLES[typedBand];
  const availableCount = Object.values(signals).filter((s) => s.available).length;
  const amplifiers = getDewsAmplifiers(data.current);
  const sortedSignals = Object.entries(SIGNAL_META)
    .flatMap(([key, meta]) => {
      const signal = signals[key];
      if (!signal || !signal.available) return [];
      return [{ key, meta, signal }];
    })
    .sort((a, b) => b.signal.value - a.signal.value);
  const topSignal = sortedSignals[0] && Math.round(sortedSignals[0].signal.value) > 0 ? sortedSignals[0] : null;

  const unscoredSignals = Object.entries(SIGNAL_META)
    .filter(([key]) => !signals[key]?.available)
    .map(([key, meta]) => `${sentenceCase(meta.name).toLowerCase()} (${describeUnscoredSignal(key, signals[key]?.unavailableReason)})`);

  return (
    <Card className="pharos-card-shell animate-in gap-0 overflow-hidden py-0 fade-in duration-300">
      {/* Title row with the Composite / Signal breakdown toggle at the right;
          the composite score, its band and a one-line verdict lead beneath. */}
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b border-border/40 px-4 py-5 sm:px-5">
        <div className="min-w-0 space-y-3">
          <StablecoinModuleTitle className="text-sm font-semibold tracking-normal text-muted-foreground">
            Depeg Early Warning
          </StablecoinModuleTitle>
          <ScoreBadgeWrapper topic="dews" variant="tooltip-only">
            <span className="flex items-center gap-2.5">
              <span className="flex items-baseline gap-0.5">
                <span className="pharos-numeric text-3xl font-bold leading-none tabular-nums" data-dews-score="">{score}</span>
                <span className="pharos-numeric text-xs text-muted-foreground">/100</span>
              </span>
              <span className={cn("rounded-md border px-2 py-0.5 text-xs font-semibold", bandStyle?.cls)}>
                {THREAT_BAND_LABELS[typedBand] ?? band}
              </span>
            </span>
          </ScoreBadgeWrapper>
          {BAND_VERDICT[typedBand] ? (
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground">{BAND_VERDICT[typedBand]}</span>
              {topSignal ? (
                <>
                  {" "}Largest input: {sentenceCase(topSignal.meta.name).toLowerCase()}{" "}
                  <span className="pharos-numeric text-foreground">{Math.round(topSignal.signal.value)}</span>.
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {chartData.length > 1 ? (
            <div
              className="pharos-segmented"
              role="group"
              aria-label="DEWS chart mode"
            >
              <button
                type="button"
                aria-pressed={!showBreakdown}
                onClick={() => setShowBreakdown(false)}
                className="pharos-focus-ring pharos-segmented-item min-h-11 md:min-h-7 md:px-2.5"
              >
                Composite
              </button>
              <button
                type="button"
                aria-pressed={showBreakdown}
                onClick={() => setShowBreakdown(true)}
                className="pharos-focus-ring pharos-segmented-item min-h-11 md:min-h-7 md:px-2.5"
              >
                Signal breakdown
              </button>
            </div>
          ) : null}
          <MethodologyHint
            topic="dews"
            buttonClassName="!h-11 !min-h-11 !w-11 rounded-md !border-border/60 !bg-muted/50 !text-muted-foreground hover:!border-border hover:!bg-muted hover:!text-foreground dark:!border-border/60 dark:!bg-muted/50 dark:!text-muted-foreground md:!h-6 md:!w-6 md:!min-h-0"
          />
          <ShowYourWorkToggle className="pharos-focus-ring inline-flex h-11 min-h-11 w-11 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground md:h-6 md:min-h-0 md:w-6">
            <Table2 className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">Toggle score inputs</span>
          </ShowYourWorkToggle>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-4 py-5 sm:px-5">
        <StaleDataBanner
          queries={[{
            preset: "stressSignals",
            // This detail's own generation: never the aggregate feed's clock, never receipt time.
            dataUpdatedAt: data.current.computedAt * 1000,
            hasData: true,
            error,
            meta,
          }]}
          onRetry={() => void refetch()}
        />
        {availableCount < 4 && (
          <p className="text-xs text-muted-foreground">
            Limited data: only {availableCount} of 8 signals available. Score may be less reliable.
          </p>
        )}

        {amplifiers.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {amplifiers.map((amp) => (
              <span
                key={amp.key}
                className="rounded-sm border border-state-warn bg-state-warn-subtle px-2 py-1 text-xs text-state-warn-bright"
                title={amp.key === "psi" ? "Market-wide stress (PSI) is amplifying this score" : "Stress in same-peg stablecoins is amplifying this score"}
              >
                {amp.label} amplifier ×{amp.value.toFixed(2)}
              </span>
            ))}
          </div>
        )}

        {/* Signal bars, sorted by descending score, on the same threat-band
            ramp as the composite; two columns at lg+, read row by row. An odd
            last signal spans the row instead of standing alone. */}
        {(() => {
          const renderRow = ({ key, meta, signal }: (typeof sortedSignals)[number]) => {
            const metricVal = signal[meta.metricKey];
            const rounded = Math.round(signal.value);
            return (
              <div key={key} className="space-y-1.5 lg:odd:last:col-span-2" data-dews-signal={key}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0">
                    <span className="text-foreground">{sentenceCase(meta.name)}</span>
                    <span className="text-muted-foreground">
                      {" · "}{meta.metricLabel}{" "}
                      <span className="pharos-numeric">{formatMetric(meta.metricKey, metricVal)}</span>
                    </span>
                  </span>
                  <span className="pharos-numeric shrink-0 tabular-nums text-foreground" aria-label={`${rounded} out of 100`}>
                    {rounded}
                  </span>
                </div>
                <ProgressBar value={signal.value} />
              </div>
            );
          };
          return <div className="grid gap-y-3.5 lg:grid-cols-2 lg:gap-x-8">{sortedSignals.map(renderRow)}</div>;
        })()}

        {/* The bars render in both chart modes, so the unscored signals are
            named in both, each with a plain reason. */}
        {unscoredSignals.length > 0 && (
          <p className="text-xs text-muted-foreground" data-dews-unscored="">
            Not scored: {unscoredSignals.join(", ")}.
          </p>
        )}

        {chartData.length > 1 && (
          <div className="space-y-2">
            <div
              ref={chartContainerRef}
              className="h-[180px] text-foreground"
              role="figure"
              aria-label="DEWS score history"
              aria-describedby={chartSummaryId}
            >
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={chartData}
                  margin={{ top: 6, right: 52, bottom: 0, left: 0 }}
                >
                  {BAND_AREAS.map(({ band: areaBand, y1, y2 }) => (
                    <ReferenceArea
                      key={areaBand}
                      y1={y1}
                      y2={y2}
                      fill={THREAT_BAND_HEX[areaBand]}
                      fillOpacity={areaBand === typedBand ? 0.14 : 0.06}
                      stroke="none"
                      ifOverflow="hidden"
                      label={{
                        value: THREAT_BAND_LABELS[areaBand],
                        position: "right",
                        fontSize: 10,
                        fill: areaBand === typedBand ? "var(--color-foreground)" : CHART_TICK_FILL,
                        fontWeight: areaBand === typedBand ? 600 : 400,
                      }}
                    />
                  ))}
                  <TimeXAxis dataKey="ts" minTickGap={36} tickFormatter={(ts: number) => formatChartDate(ts, "short")} />
                  <MonoYAxis domain={[0, 100]} ticks={Y_TICKS} interval={0} width={34} />
                  <DateTooltip
                    formatter={(val, name) => val == null ? null : [
                      `${Math.round(val as number)}/100`,
                      showBreakdown ? sentenceCase(SIGNAL_META[name as string]?.name ?? String(name)) : "DEWS",
                    ]}
                    {...(showBreakdown && {
                      itemStyle: { fontFamily: "var(--font-mono)", fontSize: "0.875rem" },
                    })}
                  />
                  {showBreakdown ? (
                    Object.keys(SIGNAL_META).map((key) => (
                      <Area
                        key={key}
                        type="monotone"
                        dataKey={key}
                        stroke={SIGNAL_CHART_COLORS[key]}
                        fill="none"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))
                  ) : (
                    <Area
                      type="monotone"
                      dataKey="score"
                      stroke="var(--color-foreground)"
                      fill="none"
                      strokeWidth={1.75}
                      isAnimationActive={false}
                    />
                  )}
                </AreaChart>
              ) : (
                <div className="h-full w-full animate-pulse rounded-sm bg-muted" />
              )}
            </div>
            <p id={chartSummaryId} className="sr-only">{chartSummary}</p>

            {showBreakdown ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                {Object.entries(SIGNAL_META).map(([key, meta]) => (
                  <div key={key} className="flex items-center gap-1">
                    <div className="h-2 w-2 rounded-full" style={{ backgroundColor: SIGNAL_CHART_COLORS[key] }} />
                    <span>{sentenceCase(meta.name)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-2xs text-muted-foreground">
                Daily composite score over {chartData.length} days, read against the Calm → Danger threat bands.
              </p>
            )}
          </div>
        )}

        <ShowYourWorkPanel kind="dews" current={data.current} stablecoinId={stablecoinId} />
      </CardContent>
    </Card>
  );
}
