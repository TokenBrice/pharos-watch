"use client";

import { useMemo, useCallback } from "react";
import { CartesianGrid, ScatterChart, Scatter, XAxis, YAxis, Tooltip, ReferenceArea, ReferenceLine } from "recharts";
import {
  CHART_AMBER,
  CHART_BLUE,
  CHART_GREEN,
  CHART_ORANGE,
  CHART_RED,
  CHART_SLATE,
  CHART_TEAL,
} from "@/lib/chart-colors";
import { ChartTooltipSurface, TooltipRow } from "@/components/pharos-chart-tooltip";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useSvgId } from "@/components/chart-primitives/axes";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  computeApyAxis,
  computeSafetyDomain,
  declutterScatterMarkers,
  LOGO_DIAMETER_DESKTOP,
  LOGO_DIAMETER_MOBILE,
  SAFETY_SCORE_THRESHOLD,
  type ScatterMarkerKind,
} from "@/lib/yield-scatter";
import {
  CHART_AXIS_LABEL,
  CHART_AXIS_LINE,
  CHART_AXIS_TICK,
  CHART_GRID_DASH,
  CHART_GRID_STROKE,
  CHART_REFERENCE_DASH,
} from "@/lib/chart-theme";
import { niceTicks } from "@/lib/chart-ticks";
import {
  getYieldBenchmarkDisplayLabel,
  resolveYieldRowBenchmark,
  type YieldBenchmarkAgeEvidence,
} from "@/lib/yield-benchmark";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { YIELD_TYPE_LABELS, YIELD_ZONE_LABELS, YIELD_ZONE_OUTLIER_DOT_CLASS, YIELD_ZONE_STYLES } from "@shared/lib/classification";
import { YIELD_RISK_BUDGET_MIN_SAFETY } from "@/lib/yield-view-model";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import type { YieldType } from "@shared/types/yield-vocabulary";
import type { YieldBenchmarkRegistry } from "@shared/types/yield";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";
import { formatYieldApyDelta } from "@/lib/yield-presentation";
import { isOpportunityDerivedSafety, YIELD_OPPORTUNITY_SAFETY_DESCRIPTION } from "@shared/lib/yield-opportunity-provenance";

interface ScatterDataPoint {
  x: number; // safety score (original, for tooltip)
  y: number; // APY 30d (original, for tooltip)
  plotX: number; // rendered X: the true safety score
  plotY: number; // rendered Y: the true APY, or the rail when clipped
  id: string;
  name: string;
  symbol: string;
  yieldType: YieldType;
  safetyGrade: string | null;
  opportunityDerivedSafety: boolean;
  pharosYieldScore: number | null;
  yieldSource: string;
  benchmarkLabel: string;
  benchmarkRate: number | null;
  excessYield: number | null;
  tvl: number | null;
  logoSrc?: string;
  isClipped: boolean;
  /** True when the row is pinned to the lower (losing-tail) rail. */
  clippedBelow: boolean;
  clipThreshold: number | null;
  /** "dot" when a larger market's logo already occupies this spot. */
  marker: ScatterMarkerKind;
}

interface YieldScatterPlotProps {
  rankings: YieldWorkbenchRanking[];
  benchmarkRate: number | null;
  benchmarkLabel?: string;
  showBenchmarkReference?: boolean;
  benchmarkIsFallback?: boolean;
  usesDefaultBenchmarkFrame?: boolean;
  /**
   * Benchmark registry used to resolve a missing row rate by the row's
   * benchmark key before the chart-wide USD frame (E5).
   */
  benchmarks?: YieldBenchmarkRegistry | null;
  /**
   * Age evidence for the chart-wide benchmark, so a stale frame label carries
   * the shared age marker (E9).
   */
  benchmarkAgeEvidence?: YieldBenchmarkAgeEvidence | null;
  logos?: Record<string, string>;
  compact?: boolean;
  /**
   * "stage" (default) wraps the chart in its own `pharos-chart-stage` frame.
   * "bare" drops the frame + padding so the chart fills its container
   * edge-to-edge when promoted into the hero's right slot.
   */
  frame?: "stage" | "bare";
  /** Click callback on a scatter point (scrolls to and highlights the leaderboard row). */
  onSelectRow?: (id: string) => void;
  /** Currently hovered or focused leaderboard row ID to highlight on the scatter. */
  highlightedRowId?: string | null;
  /** Optional hover callback for scatter-to-table coupling. */
  onHoverRow?: (id: string | null) => void;
}

const SCATTER_Y_VISUAL_PADDING = 0.4;
const QUADRANT_LABEL_STYLE = {
  fontSize: 12,
  opacity: 0.95,
  fontWeight: 700,
} as const;
const YIELD_SCATTER_QUADRANTS = [
  {
    key: "sweet-spot",
    safetySide: "above-threshold",
    yieldSide: "above-benchmark",
    label: YIELD_ZONE_LABELS["sweet-spot"],
    labelPosition: "insideTopRight",
    fill: CHART_GREEN,
    labelFill: "var(--state-positive-text)",
    fillOpacity: 0.1,
  },
  {
    key: "danger-zone",
    safetySide: "below-threshold",
    yieldSide: "above-benchmark",
    label: YIELD_ZONE_LABELS["danger-zone"],
    labelPosition: "insideTopLeft",
    fill: CHART_RED,
    labelFill: "var(--state-danger-text)",
    fillOpacity: 0.1,
  },
  {
    key: "play-it-safe",
    safetySide: "above-threshold",
    yieldSide: "below-benchmark",
    label: YIELD_ZONE_LABELS["play-it-safe"],
    labelPosition: "insideBottomRight",
    fill: CHART_BLUE,
    labelFill: "var(--state-info-text)",
    fillOpacity: 0.1,
  },
  {
    key: "why-bother",
    safetySide: "below-threshold",
    yieldSide: "below-benchmark",
    label: YIELD_ZONE_LABELS["why-bother"],
    labelPosition: "insideBottomLeft",
    fill: CHART_SLATE,
    labelFill: "var(--color-muted-foreground)",
    fillOpacity: 0.06,
  },
] as const;

const RING_TIER_LEGEND = [
  { label: `≥${YIELD_RISK_BUDGET_MIN_SAFETY.conservative}`, color: CHART_GREEN },
  { label: `≥${YIELD_RISK_BUDGET_MIN_SAFETY.balanced}`, color: CHART_TEAL },
  { label: `≥${YIELD_RISK_BUDGET_MIN_SAFETY.opportunistic}`, color: CHART_AMBER },
  { label: `<${YIELD_RISK_BUDGET_MIN_SAFETY.opportunistic}`, color: CHART_ORANGE },
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

// Mirrors YIELD_RISK_BUDGET_MIN_SAFETY thresholds so each point's ring color
// matches the risk-tolerance band that includes it.
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
  clickable?: boolean;
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
  clickable = false,
  idPrefix = "yield-logo",
}: LogoScatterShapeProps) {
  if (typeof cx !== "number" || typeof cy !== "number" || !payload) return null;

  const diameter = compact ? LOGO_DIAMETER_MOBILE : LOGO_DIAMETER_DESKTOP;
  const radius = diameter / 2;
  const haloRadius = radius + (emphasized ? 3 : 2);
  const clipId = `${idPrefix}-${sanitizeSvgId(payload.id)}-${emphasized ? "active" : "idle"}`;
  const ringStroke = emphasized ? CHART_BLUE : safetyTierColor(payload.x);
  const cursorStyle = clickable ? { cursor: "pointer" } : undefined;

  // A crowded point keeps its exact position as a tier-colored dot; hover
  // or row-coupled highlight still shows its logo.
  if (payload.marker === "dot" && !emphasized) {
    return (
      <g transform={`translate(${cx}, ${cy})`} style={cursorStyle}>
        <circle r={3.5} fill={ringStroke} stroke="var(--color-card)" strokeWidth={1} />
        {payload.isClipped ? (
          <path
            d="M 0 -9.5 L 3 -5.5 L -3 -5.5 Z"
            fill={CHART_ORANGE}
            opacity={0.95}
            transform={payload.clippedBelow ? "scale(1,-1)" : undefined}
          />
        ) : null}
      </g>
    );
  }

  return (
    <g transform={`translate(${cx}, ${cy})`} style={cursorStyle}>
      <circle r={haloRadius} fill="var(--color-background)" opacity={0.9} />
      {payload.logoSrc ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <circle r={radius} />
            </clipPath>
          </defs>
          <circle r={radius + 0.5} fill="var(--color-card)" stroke={ringStroke} strokeWidth={emphasized ? 2 : 1.25} />
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
          <circle r={radius} fill="var(--color-muted)" stroke={ringStroke} strokeWidth={emphasized ? 2 : 1.25} />
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
          transform={payload.clippedBelow ? "scale(1,-1)" : undefined}
        />
      ) : null}
      {emphasized ? (
        <circle r={haloRadius + 1.5} fill="none" stroke={CHART_BLUE} strokeOpacity={0.45} strokeWidth={1.75} />
      ) : null}
    </g>
  );
}

function ReferenceBenchmarkLabel({
  viewBox,
  text,
}: {
  viewBox?: { x?: number; y?: number; width?: number; height?: number };
  text: string;
}) {
  if (!viewBox || typeof viewBox.x !== "number" || typeof viewBox.y !== "number" || typeof viewBox.width !== "number") {
    return null;
  }
  return (
    <text
      x={viewBox.x + viewBox.width - 8}
      y={viewBox.y - 6}
      textAnchor="end"
      fill="var(--color-foreground)"
      fontSize={12}
      fontWeight={600}
      paintOrder="stroke"
      stroke="var(--color-card)"
      strokeWidth={4}
      strokeLinejoin="round"
    >
      {text}
    </text>
  );
}

function extractScatterPointId(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { id?: unknown; payload?: { id?: unknown } };
  if (typeof record.payload?.id === "string") return record.payload.id;
  if (typeof record.id === "string") return record.id;
  return null;
}

function CustomTooltip({
  active,
  payload,
  usesDefaultBenchmarkFrame = false,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterDataPoint }>;
  usesDefaultBenchmarkFrame?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  const safetyValue = `${d.safetyGrade ?? "—"} (${d.x}/100)`;
  return (
    <ChartTooltipSurface className="min-w-[210px] max-w-[280px] space-y-1 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <StablecoinLogo src={d.logoSrc} name={d.name} size={18} />
        <div className="min-w-0">
          <p className="truncate font-semibold leading-none text-foreground">{d.name}</p>
          <p className="text-2xs uppercase text-muted-foreground">{d.symbol}</p>
        </div>
      </div>
      <TooltipRow label="APY (30d)" value={`${d.y.toFixed(2)}%`} bold />
      {d.benchmarkRate != null ? (
        <>
          <TooltipRow label={`Benchmark (${d.benchmarkLabel})`} value={`${d.benchmarkRate.toFixed(2)}%`} />
          <TooltipRow label="Excess" value={d.excessYield != null ? formatYieldApyDelta(d.excessYield) : "—"} />
        </>
      ) : null}
      {d.isClipped && d.clipThreshold !== null ? (
        <TooltipRow
          label="Chart rail"
          value={`${d.clippedBelow ? "<" : ">"} ${d.clipThreshold.toFixed(0)}%${usesDefaultBenchmarkFrame ? " (USD frame)" : ""}`}
        />
      ) : null}
      <TooltipRow
        label={d.opportunityDerivedSafety ? "Venue-adjusted safety" : "Safety"}
        value={safetyValue}
      />
      {d.opportunityDerivedSafety ? (
        <p className="pt-0.5 text-2xs leading-snug text-muted-foreground">{YIELD_OPPORTUNITY_SAFETY_DESCRIPTION}</p>
      ) : null}
      <TooltipRow label="Type" value={YIELD_TYPE_LABELS[d.yieldType] ?? d.yieldType} />
      <TooltipRow label="PYS" value={d.pharosYieldScore !== null ? d.pharosYieldScore.toFixed(1) : "—"} bold />
      <TooltipRow label="Source" value={d.yieldSource} />
    </ChartTooltipSurface>
  );
}

export function YieldScatterPlot({
  rankings,
  benchmarkRate,
  benchmarkLabel,
  showBenchmarkReference = true,
  benchmarkIsFallback = false,
  usesDefaultBenchmarkFrame = false,
  benchmarks = null,
  benchmarkAgeEvidence = null,
  logos,
  compact = false,
  frame = "stage",
  onSelectRow,
  highlightedRowId = null,
  onHoverRow,
}: YieldScatterPlotProps) {
  const isMobile = useIsMobile();
  const compactMarker = compact || isMobile;
  const hideAxisLabels = isMobile;
  const hideQuadrantLabels = isMobile;
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const rawData = useMemo(() => {
    return rankings
      .filter((r) => r.safetyScore !== null && !(r.provenance?.usedDefaultSafety || r.provenance?.safetyProvenance === "default-safety"))
      .map((r) => {
        // E5: one resolution per row; a missing row rate resolves from the
        // registry by the row's benchmark key before the chart-wide USD frame.
        const benchmark = resolveYieldRowBenchmark(r, benchmarks, benchmarkRate);
        return {
          x: r.safetyScore!,
          y: r.apy30d,
          id: r.id,
          name: r.name,
          symbol: r.symbol,
          yieldType: r.yieldType,
          safetyGrade: r.safetyGrade,
          opportunityDerivedSafety: isOpportunityDerivedSafety(r.provenance?.safetyProvenance),
          pharosYieldScore: r.pharosYieldScore,
          yieldSource: r.yieldSource,
          benchmarkLabel: benchmark.label,
          benchmarkRate: benchmark.rate,
          excessYield: benchmark.rate != null ? r.apy30d - benchmark.rate : null,
          tvl: r.sourceTvlUsd,
          logoSrc: resolveCompactLogoSrc(logos?.[r.id], compactMarker ? 14 : 16),
        };
      });
  }, [benchmarks, benchmarkRate, compactMarker, logos, rankings]);

  const apyAxis = useMemo(
    () =>
      computeApyAxis(
        rawData.map((point) => point.y),
        benchmarkRate,
      ),
    [benchmarkRate, rawData],
  );
  const plotYDomain = useMemo<[number, number]>(
    () => [apyAxis.domainMin - SCATTER_Y_VISUAL_PADDING, apyAxis.domainMax + SCATTER_Y_VISUAL_PADDING],
    [apyAxis.domainMin, apyAxis.domainMax],
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
      const clippedAbove = apyAxis.clipThreshold !== null && point.y > apyAxis.clipThreshold;
      const clippedBelow = apyAxis.floorThreshold !== null && point.y < apyAxis.floorThreshold;
      return {
        ...point,
        plotX: point.x,
        plotY: clippedAbove ? apyAxis.domainMax : clippedBelow ? apyAxis.domainMin : point.y,
        isClipped: clippedAbove || clippedBelow,
        clippedBelow,
        clipThreshold: clippedBelow ? apyAxis.floorThreshold : apyAxis.clipThreshold,
      };
    });
    // Approximate plot area: the container less the y-axis column and x-axis row.
    const plotWidth = (width || 900) - (isMobile ? 40 : 60);
    const plotHeight = (height || 300) - (isMobile ? 42 : 68);
    return declutterScatterMarkers(clipped, safetyDomain, plotYDomain, plotWidth, plotHeight, compactMarker);
  }, [apyAxis, rawData, safetyDomain, plotYDomain, width, height, isMobile, compactMarker]);

  const safetyTicks = useMemo(
    () => niceTicks(safetyDomain[0], safetyDomain[1], { kind: "score", count: isMobile ? 5 : 6, extend: false }).ticks,
    [safetyDomain, isMobile],
  );
  const apyTicks = useMemo(() => {
    let ticks = niceTicks(apyAxis.domainMin, apyAxis.domainMax, { kind: "count", count: isMobile ? 5 : 7, extend: false }).ticks;
    const minGap = (ticks.length > 1 ? ticks[ticks.length - 1] - ticks[ticks.length - 2] : apyAxis.domainMax - apyAxis.domainMin) * 0.5;
    if (apyAxis.domainMin < 0 && !ticks.some((tick) => tick < 0)) ticks.unshift(apyAxis.domainMin);
    if (apyAxis.floorThreshold !== null) {
      ticks = [apyAxis.domainMin, ...ticks.filter((tick) => tick - apyAxis.domainMin >= minGap)];
    }
    if (apyAxis.clipThreshold !== null) {
      ticks = [...ticks.filter((tick) => apyAxis.domainMax - tick >= minGap), apyAxis.domainMax];
    }
    return ticks;
  }, [apyAxis, isMobile]);
  const formatApyTick = useCallback(
    (value: number) =>
      apyAxis.clipThreshold !== null && value === apyAxis.domainMax
        ? `>${apyAxis.clipThreshold}`
        : apyAxis.floorThreshold !== null && value === apyAxis.domainMin
          ? `<${apyAxis.floorThreshold}`
          : String(value),
    [apyAxis],
  );

  const logoIdPrefix = useSvgId("yield-logo");

  const renderLogoMarker = useCallback(
    (props: LogoScatterShapeProps) => (
      <LogoScatterPoint
        {...props}
        compact={compactMarker}
        clickable={!!onSelectRow}
        emphasized={highlightedRowId !== null && props.payload?.id === highlightedRowId}
        idPrefix={logoIdPrefix}
      />
    ),
    [compactMarker, highlightedRowId, logoIdPrefix, onSelectRow],
  );

  const renderActiveLogoMarker = useCallback(
    (props: LogoScatterShapeProps) => (
      <LogoScatterPoint
        {...props}
        compact={compactMarker}
        clickable={!!onSelectRow}
        emphasized
        idPrefix={logoIdPrefix}
      />
    ),
    [compactMarker, logoIdPrefix, onSelectRow],
  );

  const handleScatterClick = useCallback(
    (entry: unknown) => {
      if (!onSelectRow) return;
      const id = extractScatterPointId(entry);
      if (id) onSelectRow(id);
    },
    [onSelectRow],
  );

  const handleScatterMouseEnter = useCallback(
    (entry: unknown) => {
      if (!onHoverRow) return;
      onHoverRow(extractScatterPointId(entry));
    },
    [onHoverRow],
  );

  const handleScatterMouseLeave = useCallback(() => {
    onHoverRow?.(null);
  }, [onHoverRow]);

  const resolvedBenchmarkLabel = getYieldBenchmarkDisplayLabel({
    benchmarkLabel,
    benchmarkIsFallback,
    ...benchmarkAgeEvidence,
  });

  const referenceLineLabelText =
    benchmarkRate != null
      ? usesDefaultBenchmarkFrame
        ? `${resolvedBenchmarkLabel} frame ${benchmarkRate.toFixed(2)}%`
        : `${resolvedBenchmarkLabel} ${benchmarkRate.toFixed(2)}%`
      : null;

  // E17: rows dropped for a missing safety score are counted and annotated.
  const droppedUnscoredCount = rankings.length - rawData.length;
  const safetyAxisLabel = rawData.some((point) => point.opportunityDerivedSafety)
    ? "Venue-adjusted Safety Score"
    : "Safety Score";

  const floorNote =
    apyAxis.floorClippedCount > 0 && apyAxis.floorThreshold !== null ? (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
          SEVERITY_TONE_CLASS.caution.banner,
        )}
      >
        <span className={cn("h-2 w-2 rounded-full", YIELD_ZONE_OUTLIER_DOT_CLASS)} />
        {apyAxis.floorClippedCount} outlier{apyAxis.floorClippedCount === 1 ? "" : "s"} pinned below{" "}
        {apyAxis.floorThreshold.toFixed(0)}%
      </span>
    ) : null;
  const outlierNote =
    apyAxis.clippedCount > 0 && apyAxis.clipThreshold !== null ? (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
          SEVERITY_TONE_CLASS.caution.banner,
        )}
      >
        <span className={cn("h-2 w-2 rounded-full", YIELD_ZONE_OUTLIER_DOT_CLASS)} />
        {apyAxis.clippedCount} outlier{apyAxis.clippedCount === 1 ? "" : "s"} pinned above{" "}
        {apyAxis.clipThreshold.toFixed(0)}%
        {usesDefaultBenchmarkFrame ? <span className="hidden md:inline">(USD frame)</span> : null}
      </span>
    ) : null;
  const unscoredNote =
    droppedUnscoredCount > 0 ? (
      <span>
        {droppedUnscoredCount} row{droppedUnscoredCount === 1 ? "" : "s"} without a measured safety score not shown
      </span>
    ) : null;

  if (data.length === 0) {
    return (
      <div className="flex h-[500px] flex-col items-center justify-center text-sm text-muted-foreground">
        <p>No scatter data available (safety scores required)</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Safety scores refresh with each yield publication.
        </p>
        {unscoredNote ? <p className="mt-1 text-xs">{unscoredNote}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
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
        aria-label={`Yield vs venue-adjusted safety scatter plot with ${data.length} yield-source rows plotted, including ${apyAxis.clippedCount} on the upper rail and ${apyAxis.floorClippedCount} on the lower rail.${droppedUnscoredCount > 0 ? ` ${droppedUnscoredCount} row${droppedUnscoredCount === 1 ? "" : "s"} without a measured safety score not shown.` : ""}${usesDefaultBenchmarkFrame ? " The background benchmark frame uses the default USD benchmark for mixed views." : ""}${compact ? " Compressed mini-map." : ""} Use the leaderboard for accessible row actions.`}
      >
        <div ref={chartContainerRef} className="h-full w-full">
          {isChartReady ? (
            <ScatterChart
              width={width}
              height={height}
              margin={
                compact
                  ? { top: 4, right: 12, bottom: 4, left: 0 }
                  : isMobile
                    ? { top: 6, right: 6, bottom: 12, left: 0 }
                    : { top: 10, right: 14, bottom: 16, left: 2 }
              }
            >
              <CartesianGrid
                stroke={CHART_GRID_STROKE}
                strokeDasharray={CHART_GRID_DASH}
                strokeOpacity={0.55}
              />

              {showBenchmarkReference && benchmarkRate != null
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
                                fill: quadrant.labelFill,
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

              {showBenchmarkReference && benchmarkRate != null ? (
                <ReferenceLine
                  y={benchmarkRate}
                  stroke={CHART_SLATE}
                  strokeDasharray={CHART_REFERENCE_DASH}
                />
              ) : null}

              <XAxis
                type="number"
                dataKey="plotX"
                domain={safetyDomain}
                name={safetyAxisLabel}
                label={
                  hideAxisLabels
                    ? undefined
                    : {
                        value: safetyAxisLabel,
                        position: "insideBottom",
                        offset: 0,
                        ...CHART_AXIS_LABEL,
                      }
                }
                tick={CHART_AXIS_TICK}
                ticks={safetyTicks}
                interval={0}
                height={hideAxisLabels ? 30 : 42}
                tickLine={false}
                axisLine={CHART_AXIS_LINE}
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
                        offset: 6,
                        ...CHART_AXIS_LABEL,
                      }
                }
                tick={CHART_AXIS_TICK}
                ticks={apyTicks}
                interval={0}
                tickFormatter={formatApyTick}
                tickLine={false}
                axisLine={CHART_AXIS_LINE}
                width={hideAxisLabels ? (isMobile ? 28 : 34) : isMobile ? 40 : 46}
              />

              <Tooltip
                content={<CustomTooltip usesDefaultBenchmarkFrame={usesDefaultBenchmarkFrame} />}
                cursor={false}
              />

              <Scatter
                data={data}
                shape={renderLogoMarker}
                activeShape={renderActiveLogoMarker}
                onClick={onSelectRow ? handleScatterClick : undefined}
                onMouseEnter={onHoverRow ? handleScatterMouseEnter : undefined}
                onMouseLeave={onHoverRow ? handleScatterMouseLeave : undefined}
                cursor={onSelectRow ? "pointer" : undefined}
              />

              {showBenchmarkReference && benchmarkRate != null && !hideAxisLabels && referenceLineLabelText ? (
                <ReferenceLine
                  y={benchmarkRate}
                  stroke="none"
                  label={<ReferenceBenchmarkLabel text={referenceLineLabelText} />}
                />
              ) : null}
            </ScatterChart>
          ) : (
            <ChartSkeleton className="h-full rounded-xl" />
          )}
        </div>
      </div>

      {/* Compact ring/dot legend + mixed-currency benchmark clarification */}
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted-foreground", frame === "bare" && "px-4 pb-3")}>
        <span className="pharos-chart-legend-chip">
          <span className="font-medium text-foreground">Ring:</span>
          <span className="inline-flex items-center gap-2">
            {RING_TIER_LEGEND.map((tier) => (
              <span key={tier.label} className="inline-flex items-center gap-1 font-mono tabular-nums">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-full border-2 bg-card"
                  style={{ borderColor: tier.color }}
                />
                <span>{tier.label}</span>
              </span>
            ))}
          </span>
        </span>
        <span className="pharos-chart-legend-chip">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-muted-foreground/70"
          />
          <span>Dot = crowded spot</span>
        </span>
        {usesDefaultBenchmarkFrame ? (
          <span className="text-2xs text-muted-foreground">
            Non-USD coins compare to local rates on hover and in the table
          </span>
        ) : null}
      </div>

      {/* Mobile 4-chip quadrant key (SVG quadrant labels are hidden on narrow screens) */}
      {showBenchmarkReference && benchmarkRate != null ? (
        <div
          aria-label="Scatter quadrant key"
          className={cn("grid grid-cols-2 gap-1.5 sm:hidden", frame === "bare" && "px-4 pb-3")}
        >
          {YIELD_SCATTER_QUADRANTS.map((quadrant) => (
            <span
              key={quadrant.key}
              className="pharos-chart-legend-chip rounded-md border border-border/50 bg-muted/25 px-2 py-1 text-2xs"
            >
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", YIELD_ZONE_STYLES[quadrant.key].dot)}
              />
              <span className="truncate font-medium text-foreground">{quadrant.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      {outlierNote || floorNote || unscoredNote ? (
        <div className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground", frame === "bare" && "px-4 pb-3")}>
          {outlierNote}
          {floorNote}
          {unscoredNote}
        </div>
      ) : null}

      {compact ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span className="pharos-chart-legend-chip">
            <span className={cn("h-2.5 w-2.5 rounded-full", YIELD_ZONE_STYLES["sweet-spot"].dot)} />
            <span className="font-medium text-foreground">Sweet Spot</span>
            {showBenchmarkReference && usesDefaultBenchmarkFrame ? (
              <span className="hidden md:inline">
                above the USD frame and right of {SAFETY_SCORE_THRESHOLD}; row tags use local benchmarks
              </span>
            ) : showBenchmarkReference && benchmarkRate != null ? (
              <span className="hidden md:inline">
                above {benchmarkRate.toFixed(2)}% and right of {SAFETY_SCORE_THRESHOLD}
              </span>
            ) : (
              <span className="hidden md:inline">high safety with yield clearing the local benchmark</span>
            )}
          </span>
          <span className="pharos-chart-legend-chip">
            <span className={cn("h-2.5 w-2.5 rounded-full", YIELD_ZONE_STYLES["danger-zone"].dot)} />
            <span className="font-medium text-foreground">Danger Zone</span>
            <span className="hidden md:inline">high APY on lower safety</span>
          </span>
        </div>
      )}
    </div>
  );
}
