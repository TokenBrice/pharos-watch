"use client";

import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { DoorOpen, Gauge, Route, Split } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MethodologyLabel } from "@/components/methodology-hint";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { DexLiquidityData } from "@shared/types";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import {
  aggregateThroatSelection,
  buildLiquidityExitRouteModel,
  chainRouteGeometry,
  compactRouteLabel,
  defaultExitRouteSelection,
  EXIT_ROUTE_SCENE,
  protocolRouteGeometry,
  routeMagnitudeScale,
  selectionFromRoute,
  selectionKey,
  throatGeometry,
  type LiquidityExitRouteItem,
  type LiquidityExitRouteModel,
  type LiquidityExitRouteSelection,
} from "@/components/exit-route-model";
import "./exit-route-instrument.css";

function ExitRouteMetric({
  icon,
  label,
  value,
  detail,
  active = false,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  detail: string;
  active?: boolean;
}) {
  return (
    <div className={`exit-route-metric rounded-xl border p-3 ${active ? "exit-route-metric--active" : "border-border/60 bg-background/35"}`}>
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function SelectedExitRoutePanel({ selection }: { selection: LiquidityExitRouteSelection }) {
  const kindLabel = selection.kind === "protocol" ? "Protocol door" : selection.kind === "chain" ? "Chain lane" : "Exit throat";
  return (
    <div className="exit-route-selection-panel" data-testid="selected-exit-route-panel">
      <div>
        <p className="pharos-kicker">{kindLabel}</p>
        <p className="mt-1 text-sm font-semibold text-foreground">{selection.label}</p>
      </div>
      <div>
        <p className="pharos-kicker">Depth</p>
        <p className="mt-1 font-mono text-sm font-bold tabular-nums">{formatCurrency(selection.valueUsd, 0)}</p>
      </div>
      <div>
        <p className="pharos-kicker">Share</p>
        <p className="mt-1 font-mono text-sm font-bold tabular-nums">
          {selection.sharePct == null ? "100%" : formatPercent(selection.sharePct, 1)}
        </p>
      </div>
      <p className="min-w-0 text-xs text-muted-foreground sm:col-span-3 xl:col-span-1">{selection.detail}</p>
    </div>
  );
}

function ExitRouteLegend() {
  const items = [
    {
      key: "door",
      label: "Protocol doors",
      detail: "Wider gate = more venue depth",
      sample: (
        <span className="exit-route-legend__sample exit-route-legend__sample--door" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ),
    },
    {
      key: "throat",
      label: "Exit throat",
      detail: "Narrower opening = more crowding",
      sample: (
        <span className="exit-route-legend__sample exit-route-legend__sample--throat" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
      ),
    },
    {
      key: "lane",
      label: "Chain lanes",
      detail: "Wider lane = more chain depth",
      sample: (
        <span className="exit-route-legend__sample exit-route-legend__sample--lane" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ),
    },
    {
      key: "flow",
      label: "Flow quality",
      detail: "Broken flow = weaker organic/balance",
      sample: (
        <span className="exit-route-legend__sample exit-route-legend__sample--flow" aria-hidden="true">
          <span />
          <span />
        </span>
      ),
    },
  ];

  return (
    <div className="exit-route-legend" aria-label="Exit route map visual encoding">
      <div className="exit-route-legend__header">
        <span className="pharos-kicker">Read the route map</span>
        <span>Protocol depth enters from the left, passes through the crowding throat, and exits by chain on the right.</span>
      </div>
      <div className="exit-route-legend__grid">
        {items.map(({ key, label, detail, sample }) => (
          <div key={key} className="exit-route-legend__item">
            {sample}
            <span className="font-medium text-foreground">{label}</span>
            <span>{detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExitRoutePackets({
  route,
  pathId,
  reverse = false,
}: {
  route: LiquidityExitRouteItem;
  pathId: string;
  reverse?: boolean;
}) {
  const packetRadius = routeMagnitudeScale(route.sharePct, 2, 4);
  return (
    <g
      className="exit-route-instrument__packets"
      data-testid={`exit-route-packets-${route.key}`}
      data-flow-intensity={route.flowIntensity}
      aria-hidden="true"
    >
      {Array.from({ length: route.packetCount }).map((_, index) => (
        <circle
          key={`${route.key}-packet-${index}`}
          r={packetRadius}
          fill={route.colorHex}
          style={{
            offsetPath: `path("${pathId}")`,
            animationDelay: `${index * -1.35}s`,
            offsetDistance: reverse ? `${94 - index * 12}%` : `${6 + index * 12}%`,
          }}
        />
      ))}
    </g>
  );
}

function ExitRouteInstrumentScene({
  model,
  selected,
  onSelect,
}: {
  model: LiquidityExitRouteModel;
  selected: LiquidityExitRouteSelection;
  onSelect: (selection: LiquidityExitRouteSelection) => void;
}) {
  const throat = throatGeometry(model);
  const selectedKey = selectionKey(selected.kind, selected.key);
  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd, 0)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol` : null,
    model.topChain ? `${model.topChain.label} leading chain` : null,
    model.concentrationHhi == null ? null : `${model.concentrationHhi.toFixed(2)} crowding index`,
  ].filter(Boolean).join(", ");

  const throatSelection = aggregateThroatSelection(model);
  const handleRouteKeyDown = (event: KeyboardEvent<SVGGElement>, nextSelection: LiquidityExitRouteSelection) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(nextSelection);
  };

  return (
    <div className="exit-route-instrument overflow-hidden rounded-xl border border-border/70">
      <div className="exit-route-instrument__viewport">
        <svg
          viewBox={`0 0 ${EXIT_ROUTE_SCENE.width} ${EXIT_ROUTE_SCENE.height}`}
          role="img"
          aria-label={`Exit route instrument: ${routeSummary}. Secondary-market DEX exits only.`}
          className="exit-route-instrument__scene"
          data-testid="exit-route-instrument"
        >
          <defs>
            <linearGradient id="exit-route-instrument-stage" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--route-stage-top)" />
              <stop offset="100%" stopColor="var(--route-stage-bottom)" />
            </linearGradient>
            <linearGradient id="exit-route-channel-fill" x1="0" x2="1">
              <stop offset="0%" stopColor="var(--route-channel-edge)" />
              <stop offset="50%" stopColor="var(--route-channel-throat)" />
              <stop offset="100%" stopColor="var(--route-channel-edge)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width={EXIT_ROUTE_SCENE.width} height={EXIT_ROUTE_SCENE.height} fill="url(#exit-route-instrument-stage)" aria-hidden="true" />
          <g stroke="var(--route-grid)" strokeWidth="1" aria-hidden="true">
            <line x1="372" y1="42" x2="372" y2="388" />
            <line x1="660" y1="42" x2="660" y2="388" />
            <line x1="40" y1="42" x2="960" y2="42" />
            <line x1="40" y1="388" x2="960" y2="388" />
          </g>

          <text x="54" y="30" fill="var(--route-caption)" fontSize="10" fontWeight="700" letterSpacing="1.8" aria-hidden="true">
            PROTOCOL DOORS
          </text>
          <text x={EXIT_ROUTE_SCENE.laneX} y="30" fill="var(--route-caption)" fontSize="10" fontWeight="700" letterSpacing="1.8" aria-hidden="true">
            CHAIN LANES
          </text>

          <path className="exit-route-instrument__channel" d={throat.channelPath} fill="url(#exit-route-channel-fill)" opacity="0.78" aria-hidden="true" />
          <path d={throat.upperRail} fill="none" stroke="var(--route-rail)" strokeWidth="2" strokeDasharray={throat.railDashArray} aria-hidden="true" />
          <path d={throat.lowerRail} fill="none" stroke="var(--route-rail)" strokeWidth="2" strokeDasharray={throat.railDashArray} aria-hidden="true" />

          {model.protocolRoutes.map((route, i) => {
            const label = compactRouteLabel(route.label, 16);
            const geometry = protocolRouteGeometry(route, i);
            const nextSelection = selectionFromRoute("protocol", route);
            const isSelected = selectedKey === selectionKey("protocol", route.key);
            const isDimmed = selected.kind !== "throat" && !isSelected;
            return (
              <g
                key={`protocol-${route.key}`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                className={`exit-route-instrument__route exit-route-instrument__route--protocol ${isSelected ? "exit-route-instrument__route-selected" : ""} ${isDimmed ? "exit-route-instrument__route-dimmed" : ""}`}
                data-testid={`protocol-door-${route.key}`}
                data-flow-intensity={route.flowIntensity}
                aria-label={`${route.label} protocol door, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                onFocus={() => onSelect(nextSelection)}
                onMouseEnter={() => onSelect(nextSelection)}
                onClick={() => onSelect(nextSelection)}
                onKeyDown={(event) => handleRouteKeyDown(event, nextSelection)}
              >
                <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} protocol door (${formatPercent(route.sharePct, 1)})`}</title>
                <path
                  className="exit-route-instrument__route-path"
                  d={geometry.pathD}
                  fill="none"
                  stroke={route.colorHex}
                  strokeWidth={geometry.strokeWidth}
                  strokeLinecap="round"
                  opacity="0.4"
                  strokeDasharray={throat.flowDashArray}
                />
                <ExitRoutePackets route={route} pathId={geometry.pathD} />
                <rect className="exit-route-instrument__gate-shadow" x={EXIT_ROUTE_SCENE.doorApertureX - 12} y={geometry.y - 17} width={geometry.apertureWidth + 28} height="34" rx="3" fill="var(--route-chip-bg)" opacity="0.34" />
                <rect x={EXIT_ROUTE_SCENE.doorApertureX} y={geometry.y - 10} width={geometry.apertureWidth} height="20" rx="2" fill={route.colorHex} opacity="0.78" />
                <rect x={EXIT_ROUTE_SCENE.doorApertureX - 8} y={geometry.y - 14} width="5" height="28" fill="var(--route-frame)" />
                <rect x={EXIT_ROUTE_SCENE.doorApertureX + geometry.apertureWidth + 3} y={geometry.y - 14} width="5" height="28" fill="var(--route-frame)" />
                <line x1={EXIT_ROUTE_SCENE.doorApertureX} y1={geometry.y - 13} x2={EXIT_ROUTE_SCENE.doorApertureX + geometry.apertureWidth} y2={geometry.y - 13} stroke={route.colorHex} strokeWidth="0.8" opacity="0.72" />
                <circle cx={EXIT_ROUTE_SCENE.doorX} cy={geometry.y} r="13" fill="var(--route-chip-bg)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image href={route.logoPath} x={EXIT_ROUTE_SCENE.doorX - 9} y={geometry.y - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={EXIT_ROUTE_SCENE.doorX} y={geometry.y + 4} textAnchor="middle" fill="var(--route-hero)" fontSize="13" fontWeight="800" aria-hidden="true">+</text>
                )}
                <text className="exit-route-instrument__route-label" x="78" y={geometry.y - 4} fill="var(--route-hero)" fontSize="12" fontWeight="700" aria-hidden="true">
                  {label}
                </text>
                <text x="78" y={geometry.y + 10} fill="var(--route-caption)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace" aria-hidden="true">
                  {`${formatCurrency(route.valueUsd, 0)} · ${formatPercent(route.sharePct, 1)}`}
                </text>
              </g>
            );
          })}

          {model.chainRoutes.map((route, i) => {
            const label = compactRouteLabel(route.label, 14);
            const geometry = chainRouteGeometry(route, i);
            const nextSelection = selectionFromRoute("chain", route);
            const isSelected = selectedKey === selectionKey("chain", route.key);
            const isDimmed = selected.kind !== "throat" && !isSelected;
            return (
              <g
                key={`chain-${route.key}`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                className={`exit-route-instrument__route exit-route-instrument__route--chain ${isSelected ? "exit-route-instrument__route-selected" : ""} ${isDimmed ? "exit-route-instrument__route-dimmed" : ""}`}
                data-testid={`chain-lane-${route.key}`}
                data-flow-intensity={route.flowIntensity}
                aria-label={`${route.label} chain lane, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                onFocus={() => onSelect(nextSelection)}
                onMouseEnter={() => onSelect(nextSelection)}
                onClick={() => onSelect(nextSelection)}
                onKeyDown={(event) => handleRouteKeyDown(event, nextSelection)}
              >
                <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} chain lane (${formatPercent(route.sharePct, 1)})`}</title>
                <path
                  className="exit-route-instrument__route-path"
                  d={geometry.pathD}
                  fill="none"
                  stroke={route.colorHex}
                  strokeWidth={geometry.strokeWidth}
                  strokeLinecap="round"
                  opacity="0.30"
                  strokeDasharray={throat.flowDashArray}
                />
                <ExitRoutePackets route={route} pathId={geometry.pathD} reverse />
                <text className="exit-route-instrument__route-label" x={EXIT_ROUTE_SCENE.laneLabelX} y={geometry.y} fill="var(--route-hero)" fontSize="12" fontWeight="700" aria-hidden="true">
                  {label}
                </text>
                <text x={EXIT_ROUTE_SCENE.laneLabelX} y={geometry.y + 13} fill="var(--route-caption)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace" aria-hidden="true">
                  {`${formatCurrency(route.valueUsd, 0)} · ${formatPercent(route.sharePct, 1)}`}
                </text>
                <rect x={EXIT_ROUTE_SCENE.laneX} y={geometry.laneBarY} width={geometry.laneWidth} height={geometry.laneHeight} rx="3" fill={route.colorHex} opacity="0.78" />
                <line x1={EXIT_ROUTE_SCENE.laneX} y1={geometry.laneBarY + 3} x2={EXIT_ROUTE_SCENE.laneX + geometry.laneWidth} y2={geometry.laneBarY + 3} stroke="var(--route-lane-highlight)" strokeWidth="0.7" opacity="0.5" />
                <circle cx={EXIT_ROUTE_SCENE.laneLogoX} cy={geometry.logoY} r="12" fill="var(--route-chip-bg)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image href={route.logoPath} x={EXIT_ROUTE_SCENE.laneLogoX - 8} y={geometry.logoY - 8} width="16" height="16" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={EXIT_ROUTE_SCENE.laneLogoX} y={geometry.logoY + 4} textAnchor="middle" fill="var(--route-hero)" fontSize="12" fontWeight="800" aria-hidden="true">+</text>
                )}
              </g>
            );
          })}

          <g
            role="button"
            tabIndex={0}
            aria-pressed={selected.kind === "throat"}
            className={`exit-route-instrument__throat ${selected.kind === "throat" ? "exit-route-instrument__route-selected" : ""}`}
            data-testid="exit-throat"
            data-crowding-band={throat.band}
            aria-label={`Aggregate exit throat, ${formatCurrency(model.totalTvlUsd, 0)} total DEX TVL, crowding ${throat.band}`}
            onFocus={() => onSelect(throatSelection)}
            onMouseEnter={() => onSelect(throatSelection)}
            onClick={() => onSelect(throatSelection)}
            onKeyDown={(event) => handleRouteKeyDown(event, throatSelection)}
          >
            <rect x={EXIT_ROUTE_SCENE.throatX - 64} y="174" width="128" height="82" rx="6" fill="var(--route-throat-panel)" stroke="var(--route-rail)" strokeWidth="1" />
            <rect x={EXIT_ROUTE_SCENE.throatX - 54} y="184" width="108" height="62" rx="4" fill="none" stroke="var(--route-grid)" strokeWidth="0.8" strokeDasharray={throat.flowDashArray} />
            <line x1={EXIT_ROUTE_SCENE.throatX - throat.throatHalfWidth} y1="164" x2={EXIT_ROUTE_SCENE.throatX - throat.throatHalfWidth} y2="266" stroke="var(--route-throat-marker)" strokeWidth="2" />
            <line x1={EXIT_ROUTE_SCENE.throatX + throat.throatHalfWidth} y1="164" x2={EXIT_ROUTE_SCENE.throatX + throat.throatHalfWidth} y2="266" stroke="var(--route-throat-marker)" strokeWidth="2" />
            {Array.from({ length: throat.poolTickCount }).map((_, index, ticks) => (
              <line
                key={`pool-tick-${index}`}
                x1={EXIT_ROUTE_SCENE.throatX - 50 + index * (100 / Math.max(1, ticks.length - 1))}
                y1="262"
                x2={EXIT_ROUTE_SCENE.throatX - 50 + index * (100 / Math.max(1, ticks.length - 1))}
                y2="268"
                stroke="var(--route-flow-marker)"
                strokeWidth="1"
                opacity="0.52"
                aria-hidden="true"
              />
            ))}
            <text x={EXIT_ROUTE_SCENE.throatX} y="211" textAnchor="middle" fill="var(--route-hero)" fontSize="34" fontWeight="800" fontFamily="ui-sans-serif, system-ui, sans-serif" aria-hidden="true">
              {formatCurrency(model.totalTvlUsd, 0)}
            </text>
            <text x={EXIT_ROUTE_SCENE.throatX} y="231" textAnchor="middle" fill="var(--route-caption)" fontSize="9" fontWeight="700" letterSpacing="0.45" textLength="116" lengthAdjust="spacingAndGlyphs" fontFamily="ui-sans-serif, system-ui, sans-serif" aria-hidden="true">
              SECONDARY EXIT TVL
            </text>
            <text x={EXIT_ROUTE_SCENE.throatX} y="249" textAnchor="middle" fill="var(--route-throat-marker)" fontSize="10" fontWeight="700" letterSpacing="1.4" fontFamily="ui-sans-serif, system-ui, sans-serif" aria-hidden="true">
              {throat.band.toUpperCase()} CROWDING
            </text>
          </g>

          <g className="exit-route-instrument__flow" data-testid="exit-route-flow-markers" stroke="var(--route-flow-marker)" strokeWidth="2" strokeLinecap="round" strokeDasharray={throat.flowDashArray} aria-hidden="true">
            <path d="M424 158 H 596" />
            <path d="M420 192 H 600" />
            <path d="M420 238 H 600" />
            <path d="M424 272 H 596" />
          </g>
        </svg>
      </div>
    </div>
  );
}

function ExitRouteFallbackList({
  model,
  selected,
  onSelect,
}: {
  model: LiquidityExitRouteModel;
  selected: LiquidityExitRouteSelection;
  onSelect: (selection: LiquidityExitRouteSelection) => void;
}) {
  const rows = [
    ...model.protocolRoutes.map((route) => selectionFromRoute("protocol", route)),
    ...model.chainRoutes.map((route) => selectionFromRoute("chain", route)),
    aggregateThroatSelection(model),
  ];
  const selectedKey = selectionKey(selected.kind, selected.key);

  return (
    <div className="exit-route-fallback-list" data-testid="exit-route-fallback-list" aria-label="Exit routes as a linear list">
      {rows.map((row) => {
        const isSelected = selectedKey === selectionKey(row.kind, row.key);
        return (
          <button
            key={selectionKey(row.kind, row.key)}
            type="button"
            className={`exit-route-fallback-list__row ${isSelected ? "exit-route-fallback-list__row--active" : ""}`}
            aria-pressed={isSelected}
            onClick={() => onSelect(row)}
          >
            <span>
              <span className="block text-xs uppercase tracking-wide text-muted-foreground">{row.kind === "protocol" ? "Protocol door" : row.kind === "chain" ? "Chain lane" : "Exit throat"}</span>
              <span className="font-medium text-foreground">{row.label}</span>
            </span>
            <span className="text-right font-mono text-sm font-semibold tabular-nums">
              {formatCurrency(row.valueUsd, 0)}
              <span className="block text-xs font-normal text-muted-foreground">{row.sharePct == null ? "100%" : formatPercent(row.sharePct, 1)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function LiquidityExitRouteMap({
  data,
  stats,
}: {
  data: Record<string, DexLiquidityData>;
  stats: LiquidityStatsData;
}) {
  const model = useMemo(() => buildLiquidityExitRouteModel(data, stats), [data, stats]);
  const fallbackSelection = useMemo(() => model ? defaultExitRouteSelection(model) : null, [model]);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const handleSelectRoute = useCallback((selection: LiquidityExitRouteSelection) => {
    setSelectedRouteKey(selectionKey(selection.kind, selection.key));
  }, []);
  if (!model) return null;
  const allSelections = [
    ...model.protocolRoutes.map((route) => selectionFromRoute("protocol", route)),
    ...model.chainRoutes.map((route) => selectionFromRoute("chain", route)),
    aggregateThroatSelection(model),
  ];
  const selected = allSelections.find((selection) => selectionKey(selection.kind, selection.key) === selectedRouteKey)
    ?? fallbackSelection
    ?? allSelections[0];
  const activeMetric = selected.kind === "throat"
    ? "crowding"
    : selected.kind === "protocol"
      ? "routes"
      : "organic";

  return (
    <Card className="overflow-hidden rounded-xl border-l-[3px] border-l-emerald-500">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold tracking-tight">Exit Route Map</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">
              DEX depth by venue and chain. This maps secondary-market exits only; issuer redemption capacity is scored separately.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ExitRouteLegend />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="pharos-chart-stage min-w-0 max-w-full space-y-3 overflow-hidden">
            <ExitRouteInstrumentScene model={model} selected={selected} onSelect={handleSelectRoute} />
            <SelectedExitRoutePanel selection={selected} />
            <ExitRouteFallbackList model={model} selected={selected} onSelect={handleSelectRoute} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              <span>
                Leading door:{" "}
                <span className="font-medium text-foreground">{model.topProtocol?.label ?? "n/a"}</span>
              </span>
              <span>
                Leading lane:{" "}
                <span className="font-medium text-foreground">{model.topChain?.label ?? "n/a"}</span>
              </span>
              <span className="font-mono tabular-nums">{formatCurrency(model.totalTvlUsd, 0)} total DEX TVL</span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <ExitRouteMetric
              icon={<DoorOpen className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
              label="Open routes"
              value={`${model.protocolCount} / ${model.chainCount}`}
              detail={`${model.poolCount} pools across protocol / chain buckets`}
              active={activeMetric === "routes"}
            />
            <ExitRouteMetric
              icon={<Gauge className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
              label="Crowding index"
              value={model.concentrationHhi == null ? "NR" : model.concentrationHhi.toFixed(2)}
              detail="HHI concentration; lower means more route diversity"
              active={activeMetric === "crowding"}
            />
            <ExitRouteMetric
              icon={<Split className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
              label="Pool balance"
              value={model.weightedBalancePct == null ? "NR" : `${model.weightedBalancePct}%`}
              detail="TVL-weighted balance across measured pools"
              active={selected.kind === "throat"}
            />
            <ExitRouteMetric
              icon={<Route className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden />}
              label={<MethodologyLabel topic="liquidityScore">Organic</MethodologyLabel>}
              value={model.organicPct == null ? "NR" : `${model.organicPct}%`}
              detail={`${formatCurrency(model.totalVolume24hUsd, 0)} 24h routed volume`}
              active={activeMetric === "organic"}
            />
          </div>
        </div>
        <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Source: DEX liquidity snapshot. Exit routes show secondary-market depth, not issuer redemption capacity. Updated with the liquidity snapshot cadence.
        </p>
      </CardContent>
    </Card>
  );
}
