"use client";

import { useMemo, useCallback } from "react";
import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ReferenceArea, ReferenceLine } from "recharts";
import {
  CHART_AMBER,
  CHART_BLUE,
  CHART_GREEN,
  CHART_ORANGE,
  CHART_RED,
  CHART_SLATE,
  CHART_TEAL,
} from "@/lib/chart-colors";
import { PharosChartTooltip } from "@/components/pharos-chart-tooltip";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useSvgId } from "@/components/chart-primitives/axes";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { computeApyAxis, computeSafetyDomain, nudgeOverlaps, SAFETY_SCORE_THRESHOLD } from "@/lib/yield-scatter";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import { YIELD_RISK_BUDGET_MIN_SAFETY } from "@/lib/yield-view-model";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import type { YieldType } from "@shared/types";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

interface ScatterDataPoint {
  x: number; // safety score (original, for tooltip)
  y: number; // APY 30d (original, for tooltip)
  plotX: number; // nudged X for rendering
  plotY: number; // clipped + nudged Y for rendering
  id: string;
  name: string;
  symbol: string;
  yieldType: YieldType;
  safetyGrade: string | null;
  pharosYieldScore: number | null;
  yieldSource: string;
  benchmarkLabel: string;
  benchmarkRate: number;
  excessYield: number | null;
  tvl: number | null;
  logoSrc?: string;
  isClipped: boolean;
  clipThreshold: number | null;
}

interface YieldScatterPlotProps {
  rankings: YieldWorkbenchRanking[];
  benchmarkRate: number;
  benchmarkLabel?: string;
  showBenchmarkReference?: boolean;
  benchmarkIsFallback?: boolean;
  usesDefaultBenchmarkFrame?: boolean;
  logos?: Record<string, string>;
  onDotClick: (id: string) => void;
  compact?: boolean;
  /**
   * "stage" (default) wraps the chart in its own `pharos-chart-stage` frame.
   * "bare" drops the frame + padding so the chart fills its container
   * edge-to-edge — used when the plot is promoted into the hero's right slot,
   * which already supplies the card surface (avoids a nested card).
   */
  frame?: "stage" | "bare";
}

const SCATTER_Y_VISUAL_PADDING = 0.4;
const QUADRANT_LABEL_STYLE = {
  fontSize: 13,
  opacity: 0.9,
  fontWeight: 700,
} as const;
const YIELD_SCATTER_QUADRANTS = [
  {
    key: "sweet-spot",
    safetySide: "above-threshold",
    yieldSide: "above-benchmark",
    label: "Sweet Spot",
    labelPosition: "insideTopRight",
    fill: CHART_GREEN,
    fillOpacity: 0.12,
  },
  {
    key: "danger-zone",
    safetySide: "below-threshold",
    yieldSide: "above-benchmark",
    label: "Danger Zone",
    labelPosition: "insideTopLeft",
    fill: CHART_RED,
    fillOpacity: 0.12,
  },
  {
    key: "play-it-safe",
    safetySide: "above-threshold",
    yieldSide: "below-benchmark",
    label: "Play It Safe",
    labelPosition: "insideBottomRight",
    fill: CHART_BLUE,
    fillOpacity: 0.12,
  },
  {
    key: "why-bother",
    safetySide: "below-threshold",
    yieldSide: "below-benchmark",
    label: "Why Bother?",
    labelPosition: "insideBottomLeft",
    fill: CHART_SLATE,
    fillOpacity: 0.07,
  },
] as const;

type YieldScatterQuadrant = (typeof YIELD_SCATTER_QUADRANTS)[number];

function shouldRenderYieldScatterQuadrant(quadrant: YieldScatterQuadrant, safetyDomain: [number, number]) {
  return quadrant.safetySide === "above-threshold"
    ? safetyDomain[1] > SAFETY_SCORE_THRESHOLD
    : safetyDomain[0] < SAFETY_SCORE_THRESHOLD;
}

function getYieldScatterQuadrantBounds(
  quadrant: YieldScatterQuadrant,
  safetyDomain: [number, number],
  plotYDomain: [number, number],
  benchmarkRate: number,
) {
  const isAboveSafetyThreshold = quadrant.safetySide === "above-threshold";
  const isAboveBenchmark = quadrant.yieldSide === "above-benchmark";
  return {
    x1: isAboveSafetyThreshold ? Math.max(SAFETY_SCORE_THRESHOLD, safetyDomain[0]) : safetyDomain[0],
    x2: isAboveSafetyThreshold ? safetyDomain[1] : Math.min(SAFETY_SCORE_THRESHOLD, safetyDomain[1]),
    y1: isAboveBenchmark ? benchmarkRate : plotYDomain[0],
    y2: isAboveBenchmark ? plotYDomain[1] : benchmarkRate,
  };
}

// Mirrors YIELD_RISK_BUDGET_MIN_SAFETY thresholds so the risk-tolerance slider
// acts as the legend for the scatter: each dot's ring tier matches the band
// that would just barely include it. The <opportunistic tier (CHART_ORANGE)
// has no risk-budget counterpart and is intentionally scatter-only.
function safetyTierColor(safetyScore: number | null): string {
  if (safetyScore === null) return "var(--color-border)";
  if (safetyScore >= YIELD_RISK_BUDGET_MIN_SAFETY.conservative) return CHART_GREEN;
  if (safetyScore >= YIELD_RISK_BUDGET_MIN_SAFETY.balanced) return CHART_TEAL;
  if (safetyScore >= YIELD_RISK_BUDGET_MIN_SAFETY.opportunistic) return CHART_AMBER;
  return CHART_ORANGE;
}

interface LogoScatterShapeProps {
  cx?: number;
  cy?: number;
  payload?: ScatterDataPoint;
  emphasized?: boolean;
  compact?: boolean;
  idPrefix?: string;
}

function sanitizeSvgId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function LogoScatterPoint({
  cx,
  cy,
  payload,
  emphasized = false,
  compact = false,
  idPrefix = "yield-logo",
}: LogoScatterShapeProps) {
  if (typeof cx !== "number" || typeof cy !== "number" || !payload) return null;

  const diameter = compact ? 14 : 16;
  const radius = diameter / 2;
  const haloRadius = radius + (emphasized ? 3 : 2);
  const clipId = `${idPrefix}-${sanitizeSvgId(payload.id)}-${emphasized ? "active" : "idle"}`;
  const ringStroke = emphasized ? CHART_BLUE : safetyTierColor(payload.x);

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r={haloRadius} fill="var(--color-background)" opacity={0.9} />
      {payload.logoSrc ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <circle r={radius} />
            </clipPath>
          </defs>
          <circle r={radius + 0.5} fill="var(--color-card)" stroke={ringStroke} strokeWidth={emphasized ? 2 : 1} />
          <image
            href={payload.logoSrc}
            x={-radius}
            y={-radius}
            width={diameter}
            height={diameter}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${clipId})`}
          />
        </>
      ) : (
        <>
          <circle r={radius} fill="var(--color-muted)" stroke={ringStroke} strokeWidth={emphasized ? 2 : 1} />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill="var(--color-foreground)"
            fontSize={compact ? 8 : 9}
            fontWeight="700"
          >
            {payload.symbol.slice(0, 1)}
          </text>
        </>
      )}
      {payload.isClipped ? (
        <path
          d={`M 0 ${-haloRadius - 5} L 3.5 ${-haloRadius - 1} L -3.5 ${-haloRadius - 1} Z`}
          fill={CHART_ORANGE}
          opacity={0.95}
        />
      ) : null}
      {emphasized ? (
        <circle r={haloRadius + 1.5} fill="none" stroke={CHART_BLUE} strokeOpacity={0.35} strokeWidth={1.5} />
      ) : null}
    </g>
  );
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScatterDataPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <PharosChartTooltip active={active} className="text-xs">
      <div className="mb-2 flex items-center gap-2">
        <StablecoinLogo src={d.logoSrc} name={d.name} size={18} />
        <div className="min-w-0">
          <p className="font-semibold text-foreground leading-none">{d.name}</p>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{d.symbol}</p>
        </div>
      </div>
      <p className="text-muted-foreground">
        APY: <span className="pharos-numeric">{d.y.toFixed(2)}%</span>
      </p>
      <p className="text-muted-foreground">
        Benchmark: <span className="pharos-numeric">{d.benchmarkRate.toFixed(2)}%</span>{" "}
        <span className="text-[11px]">({d.benchmarkLabel})</span>
      </p>
      <p className="text-muted-foreground">
        Excess:{" "}
        <span className="pharos-numeric">
          {d.excessYield !== null ? `${d.excessYield >= 0 ? "+" : ""}${d.excessYield.toFixed(2)}%` : "—"}
        </span>
      </p>
      {d.isClipped && d.clipThreshold !== null ? (
        <p className="text-muted-foreground">
          Chart rail: <span className="pharos-numeric">&gt; {d.clipThreshold.toFixed(0)}%</span>
        </p>
      ) : null}
      <p className="text-muted-foreground">
        Safety: <span className="font-mono tabular-nums">{d.safetyGrade ?? "—"}</span> ({d.x}/100)
      </p>
      <p className="text-muted-foreground">Type: {YIELD_TYPE_LABELS[d.yieldType] ?? d.yieldType}</p>
      <p className="text-muted-foreground">
        PYS: <span className="pharos-numeric">{d.pharosYieldScore !== null ? d.pharosYieldScore.toFixed(1) : "—"}</span>
      </p>
      <p className="text-muted-foreground">Source: {d.yieldSource}</p>
    </PharosChartTooltip>
  );
}

export function YieldScatterPlot({
  rankings,
  benchmarkRate,
  benchmarkLabel,
  showBenchmarkReference = true,
  benchmarkIsFallback = false,
  usesDefaultBenchmarkFrame = false,
  logos,
  onDotClick,
  compact = false,
  frame = "stage",
}: YieldScatterPlotProps) {
  const isMobile = useIsMobile();
  const compactMarker = compact || isMobile;
  const hideAxisLabels = isMobile;
  const hideQuadrantLabels = isMobile;
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const rawData = useMemo(() => {
    return rankings
      .filter((r) => r.safetyScore !== null)
      .map((r) => ({
        x: r.safetyScore!,
        y: r.apy30d,
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        yieldType: r.yieldType,
        safetyGrade: r.safetyGrade,
        pharosYieldScore: r.pharosYieldScore,
        yieldSource: r.yieldSource,
        benchmarkLabel: getYieldBenchmarkDisplayLabel({
          benchmarkLabel: r.benchmarkLabel ?? benchmarkLabel,
          benchmarkIsFallback: r.benchmarkIsFallback,
        }),
        benchmarkRate: r.benchmarkRate ?? benchmarkRate,
        excessYield: r.benchmarkRate != null ? r.apy30d - r.benchmarkRate : null,
        tvl: r.sourceTvlUsd,
        logoSrc: resolveCompactLogoSrc(logos?.[r.id], compactMarker ? 14 : 16),
      }));
  }, [benchmarkLabel, benchmarkRate, compactMarker, logos, rankings]);

  const apyAxis = useMemo(
    () =>
      computeApyAxis(
        rawData.map((point) => point.y),
        benchmarkRate,
      ),
    [benchmarkRate, rawData],
  );
  const plotYDomain = useMemo<[number, number]>(
    () => [-SCATTER_Y_VISUAL_PADDING, apyAxis.domainMax + SCATTER_Y_VISUAL_PADDING],
    [apyAxis.domainMax],
  );

  const safetyDomain = useMemo(
    () =>
      computeSafetyDomain(
        rawData.map((point) => point.x),
        isMobile,
      ),
    [rawData, isMobile],
  );

  const data = useMemo((): ScatterDataPoint[] => {
    const clipped = rawData.map((point) => {
      const isClipped = apyAxis.clipThreshold !== null && point.y > apyAxis.clipThreshold;
      return {
        ...point,
        plotX: point.x,
        plotY: isClipped ? apyAxis.domainMax : point.y,
        isClipped,
        clipThreshold: apyAxis.clipThreshold,
      };
    });
    return nudgeOverlaps(clipped, safetyDomain, plotYDomain, width || 900, height || 300, isMobile);
  }, [apyAxis, rawData, safetyDomain, plotYDomain, width, height, isMobile]);

  const handleClick = useCallback(
    (entry: unknown) => {
      if (entry && typeof entry === "object" && "id" in entry && typeof (entry as { id: unknown }).id === "string") {
        onDotClick((entry as { id: string }).id);
      }
    },
    [onDotClick],
  );

  const logoIdPrefix = useSvgId("yield-logo");

  const renderLogoMarker = useCallback(
    (props: LogoScatterShapeProps) => <LogoScatterPoint {...props} compact={compactMarker} idPrefix={logoIdPrefix} />,
    [compactMarker, logoIdPrefix],
  );

  const renderActiveLogoMarker = useCallback(
    (props: LogoScatterShapeProps) => (
      <LogoScatterPoint {...props} compact={compactMarker} emphasized idPrefix={logoIdPrefix} />
    ),
    [compactMarker, logoIdPrefix],
  );
  const resolvedBenchmarkLabel = getYieldBenchmarkDisplayLabel({
    benchmarkLabel,
    benchmarkIsFallback,
  });

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[500px] text-sm text-muted-foreground">
        <p>No scatter data available (safety scores required)</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Safety scores are calculated daily for tracked stablecoins.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        className={
          frame === "bare"
            ? compact
              ? "h-[420px] overflow-hidden"
              : "h-[600px] overflow-hidden sm:h-[850px]"
            : compact
              ? "pharos-chart-stage h-[420px] overflow-hidden p-2"
              : "pharos-chart-stage h-[600px] overflow-hidden p-2 sm:h-[850px] sm:p-4"
        }
        role="figure"
        aria-label={`Yield vs safety scatter plot with ${data.length} stablecoins.${usesDefaultBenchmarkFrame ? " The background benchmark frame uses the default USD benchmark for mixed views." : ""}${compact ? " Compressed mini-map." : ""} Click a logo to open its detail page.`}
      >
        <div ref={chartContainerRef} className="h-full w-full">
          {isChartReady ? (
            <ScatterChart
              width={width}
              height={height}
              margin={
                compact
                  ? { top: 4, right: 4, bottom: 4, left: 0 }
                  : isMobile
                    ? { top: 6, right: 6, bottom: 12, left: 0 }
                    : { top: 10, right: 14, bottom: 16, left: 2 }
              }
            >
              {/* Quadrant shading */}
              {showBenchmarkReference
                ? YIELD_SCATTER_QUADRANTS.map((quadrant) =>
                    shouldRenderYieldScatterQuadrant(quadrant, safetyDomain) ? (
                      <ReferenceArea
                        key={quadrant.key}
                        {...getYieldScatterQuadrantBounds(quadrant, safetyDomain, plotYDomain, benchmarkRate)}
                        fill={quadrant.fill}
                        fillOpacity={quadrant.fillOpacity}
                        label={
                          hideQuadrantLabels
                            ? undefined
                            : {
                                value: quadrant.label,
                                position: quadrant.labelPosition,
                                fill: quadrant.fill,
                                ...QUADRANT_LABEL_STYLE,
                              }
                        }
                      />
                    ) : null,
                  )
                : null}

              <ReferenceLine
                x={SAFETY_SCORE_THRESHOLD}
                stroke={CHART_SLATE}
                strokeOpacity={0.35}
                strokeDasharray="3 4"
              />

              {/* Risk-free rate reference line */}
              {showBenchmarkReference ? (
                <ReferenceLine
                  y={benchmarkRate}
                  stroke={CHART_SLATE}
                  strokeDasharray="4 4"
                  label={
                    hideAxisLabels
                      ? undefined
                      : {
                          value: usesDefaultBenchmarkFrame
                            ? `${resolvedBenchmarkLabel} frame ${benchmarkRate.toFixed(2)}%`
                            : `${resolvedBenchmarkLabel} ${benchmarkRate.toFixed(2)}%`,
                          position: "right",
                          fill: CHART_SLATE,
                          fontSize: 13,
                          fontWeight: 600,
                        }
                  }
                />
              ) : null}

              <XAxis
                type="number"
                dataKey="plotX"
                domain={safetyDomain}
                name="Safety Score"
                label={
                  hideAxisLabels
                    ? undefined
                    : {
                        value: "Safety Score",
                        position: "insideBottom",
                        offset: -6,
                        fill: "var(--color-muted-foreground)",
                        fontSize: 11,
                      }
                }
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                tickCount={isMobile ? 5 : 6}
                allowDecimals={false}
                tickLine={false}
                axisLine={{ stroke: "var(--color-border)" }}
              />
              <YAxis
                type="number"
                dataKey="plotY"
                domain={plotYDomain}
                allowDataOverflow
                name="APY (%)"
                label={
                  hideAxisLabels
                    ? undefined
                    : {
                        value: "APY %",
                        angle: -90,
                        position: "insideLeft",
                        offset: -2,
                        fill: "var(--color-muted-foreground)",
                        fontSize: 11,
                      }
                }
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                tickCount={isMobile ? 5 : 7}
                tickFormatter={(v: number) => v.toFixed(0)}
                tickLine={false}
                axisLine={{ stroke: "var(--color-border)" }}
                width={isMobile ? 28 : 34}
              />

              <Tooltip content={<CustomTooltip />} cursor={false} />

              <Scatter
                data={data}
                onClick={handleClick}
                cursor="pointer"
                shape={renderLogoMarker}
                activeShape={renderActiveLogoMarker}
              />
            </ScatterChart>
          ) : (
            <ChartSkeleton className="h-full rounded-xl" />
          )}
        </div>
      </div>
      {compact ? null : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <span className="text-foreground font-medium">Sweet spot</span>
            {showBenchmarkReference && usesDefaultBenchmarkFrame ? (
              <span className="hidden md:inline">
                = above the USD frame and right of {SAFETY_SCORE_THRESHOLD}; row tags still show local benchmarks
              </span>
            ) : showBenchmarkReference ? (
              <span className="hidden md:inline">
                = above {benchmarkRate.toFixed(2)}% and right of {SAFETY_SCORE_THRESHOLD}
              </span>
            ) : (
              <span className="hidden md:inline">= high safety with yield that clears the local benchmark</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            <span className="text-foreground font-medium">Danger zone</span>
            <span className="hidden md:inline">= high APY on low safety</span>
          </span>
          {apyAxis.clippedCount > 0 && apyAxis.clipThreshold !== null ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              {apyAxis.clippedCount} outlier{apyAxis.clippedCount === 1 ? "" : "s"} pinned above{" "}
              {apyAxis.clipThreshold.toFixed(0)}%
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
