"use client";

import { useMemo, useCallback, useEffect, useState } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { RECHARTS_TOOLTIP_STYLES, CHART_BLUE, CHART_GREEN, CHART_ORANGE, CHART_RED } from "@/lib/chart-colors";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { computeApyAxis, computeSafetyDomain, SAFETY_SCORE_THRESHOLD } from "@/lib/yield-scatter";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import type { YieldRanking, YieldType } from "@shared/types";

interface ScatterDataPoint {
  x: number; // safety score
  y: number; // APY 30d
  plotY: number;
  id: string;
  name: string;
  symbol: string;
  yieldType: YieldType;
  safetyGrade: string | null;
  pharosYieldScore: number | null;
  yieldSource: string;
  tvl: number | null;
  logoSrc?: string;
  isClipped: boolean;
  clipThreshold: number | null;
}

interface YieldScatterPlotProps {
  rankings: YieldRanking[];
  riskFreeRate: number;
  logos?: Record<string, string>;
  onDotClick: (id: string) => void;
}

interface LogoScatterShapeProps {
  cx?: number;
  cy?: number;
  payload?: ScatterDataPoint;
  emphasized?: boolean;
  compact?: boolean;
}

function sanitizeSvgId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function LogoScatterPoint({ cx, cy, payload, emphasized = false, compact = false }: LogoScatterShapeProps) {
  if (typeof cx !== "number" || typeof cy !== "number" || !payload) return null;

  const diameter = compact ? 14 : 16;
  const radius = diameter / 2;
  const haloRadius = radius + (emphasized ? 3 : 2);
  const clipId = `yield-logo-${sanitizeSvgId(payload.id)}-${emphasized ? "active" : "idle"}`;
  const ringStroke = emphasized ? CHART_BLUE : "var(--color-border)";

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <title>{`${payload.name} (${payload.symbol})`}</title>
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
            xlinkHref={payload.logoSrc}
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

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [breakpoint]);

  return isMobile;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScatterDataPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        ...RECHARTS_TOOLTIP_STYLES.contentStyle,
        padding: "8px 12px",
        fontSize: "12px",
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <StablecoinLogo src={d.logoSrc} name={d.name} size={18} />
        <div className="min-w-0">
          <p className="font-semibold text-foreground leading-none">{d.name}</p>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{d.symbol}</p>
        </div>
      </div>
      <p className="text-muted-foreground">
        APY: <span className="font-mono">{d.y.toFixed(2)}%</span>
      </p>
      {d.isClipped && d.clipThreshold !== null ? (
        <p className="text-muted-foreground">
          Chart rail: <span className="font-mono">&gt; {d.clipThreshold.toFixed(0)}%</span>
        </p>
      ) : null}
      <p className="text-muted-foreground">
        Safety: <span className="font-mono">{d.safetyGrade ?? "N/A"}</span> ({d.x}/100)
      </p>
      <p className="text-muted-foreground">Type: {YIELD_TYPE_LABELS[d.yieldType] ?? d.yieldType}</p>
      <p className="text-muted-foreground">
        PYS: <span className="font-mono">{d.pharosYieldScore !== null ? d.pharosYieldScore.toFixed(1) : "N/A"}</span>
      </p>
      <p className="text-muted-foreground">Source: {d.yieldSource}</p>
    </div>
  );
}

export function YieldScatterPlot({ rankings, riskFreeRate, logos, onDotClick }: YieldScatterPlotProps) {
  const isMobile = useIsMobile();
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
        tvl: r.sourceTvlUsd,
        logoSrc: logos?.[r.id],
      }));
  }, [logos, rankings]);

  const apyAxis = useMemo(
    () =>
      computeApyAxis(
        rawData.map((point) => point.y),
        riskFreeRate,
      ),
    [rawData, riskFreeRate],
  );

  const data = useMemo(
    (): ScatterDataPoint[] =>
      rawData.map((point) => {
        const isClipped = apyAxis.clipThreshold !== null && point.y > apyAxis.clipThreshold;
        return {
          ...point,
          plotY: isClipped ? apyAxis.domainMax : point.y,
          isClipped,
          clipThreshold: apyAxis.clipThreshold,
        };
      }),
    [apyAxis, rawData],
  );

  const safetyDomain = useMemo(
    () =>
      computeSafetyDomain(
        data.map((point) => point.x),
        isMobile,
      ),
    [data, isMobile],
  );

  const handleClick = useCallback(
    (entry: ScatterDataPoint) => {
      if (entry?.id) onDotClick(entry.id);
    },
    [onDotClick],
  );

  const renderLogoMarker = useCallback(
    (props: LogoScatterShapeProps) => <LogoScatterPoint {...props} compact={isMobile} />,
    [isMobile],
  );

  const renderActiveLogoMarker = useCallback(
    (props: LogoScatterShapeProps) => <LogoScatterPoint {...props} compact={isMobile} emphasized />,
    [isMobile],
  );

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] text-sm text-muted-foreground">
        No scatter data available (safety scores required)
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="h-[280px] sm:h-[420px] overflow-hidden">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <ScatterChart
            margin={
              isMobile ? { top: 10, right: 8, bottom: 18, left: 8 } : { top: 16, right: 24, bottom: 24, left: 14 }
            }
          >
            {/* Quadrant shading */}
            {safetyDomain[1] > SAFETY_SCORE_THRESHOLD ? (
              <ReferenceArea
                x1={Math.max(SAFETY_SCORE_THRESHOLD, safetyDomain[0])}
                x2={safetyDomain[1]}
                y1={riskFreeRate}
                y2={apyAxis.domainMax}
                fill={CHART_GREEN}
                fillOpacity={0.05}
                label={
                  isMobile
                    ? undefined
                    : { value: "Sweet Spot", position: "insideTopRight", fill: CHART_GREEN, fontSize: 12, opacity: 0.7 }
                }
              />
            ) : null}
            {safetyDomain[0] < SAFETY_SCORE_THRESHOLD ? (
              <ReferenceArea
                x1={safetyDomain[0]}
                x2={Math.min(SAFETY_SCORE_THRESHOLD, safetyDomain[1])}
                y1={riskFreeRate}
                y2={apyAxis.domainMax}
                fill={CHART_RED}
                fillOpacity={0.05}
                label={
                  isMobile
                    ? undefined
                    : { value: "Danger Zone", position: "insideTopLeft", fill: CHART_RED, fontSize: 12, opacity: 0.7 }
                }
              />
            ) : null}
            {safetyDomain[1] > SAFETY_SCORE_THRESHOLD ? (
              <ReferenceArea
                x1={Math.max(SAFETY_SCORE_THRESHOLD, safetyDomain[0])}
                x2={safetyDomain[1]}
                y1={0}
                y2={riskFreeRate}
                fill={CHART_BLUE}
                fillOpacity={0.05}
                label={
                  isMobile
                    ? undefined
                    : {
                        value: "Play It Safe",
                        position: "insideBottomRight",
                        fill: CHART_BLUE,
                        fontSize: 12,
                        opacity: 0.7,
                      }
                }
              />
            ) : null}
            {safetyDomain[0] < SAFETY_SCORE_THRESHOLD ? (
              <ReferenceArea
                x1={safetyDomain[0]}
                x2={Math.min(SAFETY_SCORE_THRESHOLD, safetyDomain[1])}
                y1={0}
                y2={riskFreeRate}
                fill="#94a3b8"
                fillOpacity={0.05}
                label={
                  isMobile
                    ? undefined
                    : {
                        value: "Why Bother?",
                        position: "insideBottomLeft",
                        fill: "#94a3b8",
                        fontSize: 12,
                        opacity: 0.7,
                      }
                }
              />
            ) : null}

            <ReferenceLine x={SAFETY_SCORE_THRESHOLD} stroke="#94a3b8" strokeOpacity={0.35} strokeDasharray="3 4" />

            {/* Risk-free rate reference line */}
            <ReferenceLine
              y={riskFreeRate}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              label={
                isMobile
                  ? undefined
                  : { value: `T-Bill ${riskFreeRate.toFixed(2)}%`, position: "right", fill: "#94a3b8", fontSize: 12 }
              }
            />

            <XAxis
              type="number"
              dataKey="x"
              domain={safetyDomain}
              name="Safety Score"
              label={
                isMobile
                  ? undefined
                  : {
                      value: "Safety Score",
                      position: "insideBottom",
                      offset: -10,
                      fill: "var(--color-muted-foreground)",
                      fontSize: 12,
                    }
              }
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
              tickCount={isMobile ? 5 : 6}
              allowDecimals={false}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              type="number"
              dataKey="plotY"
              domain={[0, apyAxis.domainMax]}
              name="APY (%)"
              label={
                isMobile
                  ? undefined
                  : {
                      value: "APY %",
                      angle: -90,
                      position: "insideLeft",
                      offset: -5,
                      fill: "var(--color-muted-foreground)",
                      fontSize: 12,
                    }
              }
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
              tickCount={isMobile ? 5 : 7}
              tickFormatter={(v: number) => v.toFixed(0)}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              width={isMobile ? 34 : 40}
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
        </ResponsiveContainer>
      </div>
      {apyAxis.clippedCount > 0 && apyAxis.clipThreshold !== null ? (
        <p className="text-[11px] text-muted-foreground">
          {apyAxis.clippedCount} high-yield outlier{apyAxis.clippedCount === 1 ? "" : "s"} above{" "}
          {apyAxis.clipThreshold.toFixed(0)}% {apyAxis.clippedCount === 1 ? "is" : "are"} pinned to the top rail.
        </p>
      ) : null}
    </div>
  );
}
