"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { getHhiBand } from "@shared/lib/classification";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import {
  aggregateThroatSelection,
  chainRouteGeometry,
  compactRouteLabel,
  EXIT_ROUTE_INSTRUMENT_GEOMETRY,
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

function SelectedExitRoutePanel({ selection }: { selection: LiquidityExitRouteSelection }) {
  if (selection.kind === "throat") {
    // The aggregate depth is the hero beam; the readout gives the protocol crowding read instead of repeating it.
    return (
      <div className="exit-route-selection-panel" data-testid="selected-exit-route-panel" aria-live="polite">
        <span className="pharos-label">Exit throat</span>
        <span className="min-w-0 text-muted-foreground">
          <span className="font-semibold text-foreground">{selection.detail}.</span> Hover or focus a door or lane for its depth.
        </span>
      </div>
    );
  }
  return (
    <div className="exit-route-selection-panel" data-testid="selected-exit-route-panel" aria-live="polite">
      <span className="pharos-label">{selection.kind === "protocol" ? "Protocol door" : "Chain lane"}</span>
      <span className="font-semibold text-foreground">{selection.label}</span>
      <span className="pharos-numeric font-semibold text-foreground">{formatCurrency(selection.valueUsd)}</span>
      <span className="pharos-numeric text-muted-foreground">
        {selection.sharePct == null ? "100%" : formatPercent(selection.sharePct, 1)} of depth
      </span>
      <span className="min-w-0 text-muted-foreground">{selection.detail}</span>
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

function InteractiveExitRouteGroup({
  route,
  kind,
  selected,
  onSelect,
  children,
}: {
  route: LiquidityExitRouteItem;
  kind: "protocol" | "chain";
  selected: LiquidityExitRouteSelection;
  onSelect: (selection: LiquidityExitRouteSelection) => void;
  children: React.ReactNode;
}) {
  const nextSelection = selectionFromRoute(kind, route);
  const selectedKey = selectionKey(selected.kind, selected.key);
  const isSelected = selectedKey === selectionKey(kind, route.key);
  const isDimmed = selected.kind !== "throat" && !isSelected;
  const kindLabel = kind === "protocol" ? "protocol door" : "chain lane";
  const testId = kind === "protocol" ? `protocol-door-${route.key}` : `chain-lane-${route.key}`;
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(nextSelection);
  };

  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className={`exit-route-instrument__route exit-route-instrument__route--${kind} ${isSelected ? "exit-route-instrument__route-selected" : ""} ${isDimmed ? "exit-route-instrument__route-dimmed" : ""}`}
      data-testid={testId}
      data-flow-intensity={route.flowIntensity}
      data-share-pct={route.sharePct.toFixed(2)}
      aria-label={`${route.label} ${kindLabel}, ${formatCurrency(route.valueUsd)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
      onFocus={() => onSelect(nextSelection)}
      onMouseEnter={() => onSelect(nextSelection)}
      onClick={() => onSelect(nextSelection)}
      onKeyDown={handleKeyDown}
    >
      <title>{`${route.label}: ${formatCurrency(route.valueUsd)} ${kindLabel} (${formatPercent(route.sharePct, 1)})`}</title>
      {children}
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
  const crowding = getHhiBand(model.concentrationHhi);
  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol` : null,
    model.topChain ? `${model.topChain.label} leading chain` : null,
    !crowding ? null : `${model.concentrationHhi!.toFixed(2)} protocol crowding`,
  ].filter(Boolean).join(", ");

  const throatSelection = aggregateThroatSelection(model);
  const handleRouteKeyDown = (event: KeyboardEvent<SVGGElement>, nextSelection: LiquidityExitRouteSelection) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(nextSelection);
  };

  return (
    <div className="exit-route-instrument">
      <div className="exit-route-instrument__viewport">
        <svg
          viewBox={`0 0 ${EXIT_ROUTE_SCENE.width} ${EXIT_ROUTE_SCENE.height}`}
          role="img"
          aria-label={`Exit route instrument: ${routeSummary}. Secondary-market DEX exits only.`}
          className="exit-route-instrument__scene"
          data-testid="exit-route-instrument"
        >
          <defs>
            <linearGradient id="exit-route-channel-fill" x1="0" x2="1">
              <stop offset="0%" stopColor="var(--route-channel-edge)" />
              <stop offset="50%" stopColor="var(--route-channel-throat)" />
              <stop offset="100%" stopColor="var(--route-channel-edge)" />
            </linearGradient>
          </defs>

          <g stroke="var(--route-grid)" strokeWidth="1" aria-hidden="true">
            {EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridVerticalX.map((x) => (
              <line key={`grid-v-${x}`} x1={x} y1={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridTop} x2={x} y2={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridBottom} />
            ))}
            <line x1={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridLeft} y1={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridTop} x2={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridRight} y2={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridTop} />
            <line x1={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridLeft} y1={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridBottom} x2={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridRight} y2={EXIT_ROUTE_INSTRUMENT_GEOMETRY.gridBottom} />
          </g>

          <text x="54" y="30" fill="var(--route-caption)" fontSize="10" fontWeight="700" aria-hidden="true">
            Protocol doors
          </text>
          <text x={EXIT_ROUTE_SCENE.laneX} y="30" fill="var(--route-caption)" fontSize="10" fontWeight="700" aria-hidden="true">
            Chain lanes
          </text>

          <path className="exit-route-instrument__channel" d={throat.channelPath} fill="url(#exit-route-channel-fill)" opacity="0.78" aria-hidden="true" />
          <path d={throat.upperRail} fill="none" stroke="var(--route-rail)" strokeWidth="2" strokeDasharray={throat.railDashArray} aria-hidden="true" />
          <path d={throat.lowerRail} fill="none" stroke="var(--route-rail)" strokeWidth="2" strokeDasharray={throat.railDashArray} aria-hidden="true" />

          {model.protocolRoutes.map((route, i) => {
            const label = compactRouteLabel(route.label, 16);
            const geometry = protocolRouteGeometry(route, i);
            return (
              <InteractiveExitRouteGroup
                key={`protocol-${route.key}`}
                route={route}
                kind="protocol"
                selected={selected}
                onSelect={onSelect}
              >
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
                  <image aria-hidden="true" href={resolveCompactLogoSrc(route.logoPath, 18)} x={EXIT_ROUTE_SCENE.doorX - 9} y={geometry.y - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={EXIT_ROUTE_SCENE.doorX} y={geometry.y + 4} textAnchor="middle" fill="var(--route-hero)" fontSize="13" fontWeight="800" aria-hidden="true">+</text>
                )}
                <text className="exit-route-instrument__route-label" x="78" y={geometry.y - 4} fill="var(--route-hero)" fontSize="12" fontWeight="700" aria-hidden="true">
                  {label}
                </text>
                <text x="78" y={geometry.y + 11} fill="var(--route-caption)" fontSize="10.5" fontFamily="var(--font-geist-mono)" aria-hidden="true">
                  {formatPercent(route.sharePct, 1)}
                </text>
              </InteractiveExitRouteGroup>
            );
          })}

          {model.chainRoutes.map((route, i) => {
            const label = compactRouteLabel(route.label, 16);
            const geometry = chainRouteGeometry(route, i);
            return (
              <InteractiveExitRouteGroup
                key={`chain-${route.key}`}
                route={route}
                kind="chain"
                selected={selected}
                onSelect={onSelect}
              >
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
                <text x={EXIT_ROUTE_SCENE.laneX + EXIT_ROUTE_SCENE.laneMaxWidth} y={geometry.y} textAnchor="end" fill="var(--route-caption)" fontSize="10.5" fontFamily="var(--font-geist-mono)" aria-hidden="true">
                  {formatPercent(route.sharePct, 1)}
                </text>
                <rect x={EXIT_ROUTE_SCENE.laneX} y={geometry.laneBarY} width={geometry.laneWidth} height={geometry.laneHeight} rx="3" fill={route.colorHex} opacity="0.78" />
                <line x1={EXIT_ROUTE_SCENE.laneX} y1={geometry.laneBarY + 3} x2={EXIT_ROUTE_SCENE.laneX + geometry.laneWidth} y2={geometry.laneBarY + 3} stroke="var(--route-lane-highlight)" strokeWidth="0.7" opacity="0.5" />
                <circle cx={EXIT_ROUTE_SCENE.laneLogoX} cy={geometry.logoY} r="12" fill="var(--route-chip-bg)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image aria-hidden="true" className={route.logoDarkInvert ? "dark:invert" : undefined} href={resolveCompactLogoSrc(route.logoPath, 16)} x={EXIT_ROUTE_SCENE.laneLogoX - 8} y={geometry.logoY - 8} width="16" height="16" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={EXIT_ROUTE_SCENE.laneLogoX} y={geometry.logoY + 4} textAnchor="middle" fill="var(--route-hero)" fontSize="12" fontWeight="800" aria-hidden="true">+</text>
                )}
              </InteractiveExitRouteGroup>
            );
          })}

          <g
            role="button"
            tabIndex={0}
            aria-pressed={selected.kind === "throat"}
            className={`exit-route-instrument__throat ${selected.kind === "throat" ? "exit-route-instrument__route-selected" : ""}`}
            data-testid="exit-throat"
            data-crowding-band={throat.band}
            aria-label={`Aggregate exit throat, ${formatCurrency(model.totalTvlUsd)} total DEX TVL, protocol crowding ${!crowding ? "not scored" : `${model.concentrationHhi!.toFixed(2)}, ${crowding.concentrationLabel.toLowerCase()} crowding`}`}
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
            {/* The throat is drawn from the protocol-bucket HHI, so it carries the protocol crowding read; the depth it passes is the hero beam above. */}
            <text x={EXIT_ROUTE_SCENE.throatX} y="212" textAnchor="middle" fill="var(--route-hero)" fontSize="30" fontWeight="700" fontFamily="var(--font-geist-mono)" style={{ fontVariantNumeric: "tabular-nums slashed-zero" }} aria-hidden="true">
              {!crowding ? "NR" : model.concentrationHhi!.toFixed(2)}
            </text>
            <text x={EXIT_ROUTE_SCENE.throatX} y="231" textAnchor="middle" fill="var(--route-caption)" fontSize="10.5" fontWeight="500" fontFamily="var(--font-sans), ui-sans-serif, system-ui, sans-serif" aria-hidden="true">
              Protocol crowding
            </text>
            <text x={EXIT_ROUTE_SCENE.throatX} y="248" textAnchor="middle" fill="var(--route-throat-marker)" fontSize="10.5" fontWeight="600" fontFamily="var(--font-sans), ui-sans-serif, system-ui, sans-serif" aria-hidden="true">
              {crowding ? `${crowding.concentrationLabel} crowding` : "Not scored"}
            </text>
          </g>

          <g className="exit-route-instrument__flow" data-testid="exit-route-flow-markers" stroke="var(--route-flow-marker)" strokeWidth="2" strokeLinecap="round" strokeDasharray={throat.flowDashArray} aria-hidden="true">
            {EXIT_ROUTE_INSTRUMENT_GEOMETRY.flowMarkers.map((marker) => (
              <path key={`flow-${marker.y}`} d={`M${marker.x1} ${marker.y} H ${marker.x2}`} />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

function FallbackRouteColumn({
  title,
  routes,
}: {
  title: string;
  routes: readonly LiquidityExitRouteItem[];
}) {
  return (
    <div className="min-w-0">
      <p className="pharos-label pb-1">{title}</p>
      <ol className="divide-y divide-border/50">
        {routes.map((route) => (
          <li key={route.key} className="flex min-h-9 items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: route.colorHex }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{route.label}</span>
            <span className="pharos-numeric text-xs text-muted-foreground">{formatPercent(route.sharePct, 1)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Below 768px the scene would crop; the same doors and lanes read as two short
 * lists, and the throat's protocol crowding (shown nowhere else) leads them.
 */
function ExitRouteFallbackList({ model }: { model: LiquidityExitRouteModel }) {
  const crowding = getHhiBand(model.concentrationHhi);
  return (
    <div className="exit-route-fallback-list" data-testid="exit-route-fallback-list" aria-label="Exit routes as a list">
      <p className="col-span-2 flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 text-sm" data-testid="exit-route-fallback-crowding">
        <span className="text-muted-foreground">Protocol crowding</span>
        <span>
          <span className="pharos-numeric font-semibold">
            {!crowding ? "NR" : model.concentrationHhi!.toFixed(2)}
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            {crowding ? `${crowding.concentrationLabel} crowding` : "Not scored"}
          </span>
        </span>
      </p>
      <FallbackRouteColumn title="Protocol doors" routes={model.protocolRoutes} />
      <FallbackRouteColumn title="Chain lanes" routes={model.chainRoutes} />
    </div>
  );
}

/**
 * The exit route instrument as a hero visual: unframed on the hero surface, the
 * selection readout under the scene, and the route census as its caption.
 * Shares are drawn here; exact dollar depth lives in the ledger beneath.
 */
export function LiquidityExitRouteMap({ model }: { model: LiquidityExitRouteModel }) {
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const handleSelectRoute = useCallback((selection: LiquidityExitRouteSelection) => {
    setSelectedRouteKey(selectionKey(selection.kind, selection.key));
  }, []);
  const allSelections = [
    ...model.protocolRoutes.map((route) => selectionFromRoute("protocol", route)),
    ...model.chainRoutes.map((route) => selectionFromRoute("chain", route)),
    aggregateThroatSelection(model),
  ];
  const selected = allSelections.find((selection) => selectionKey(selection.kind, selection.key) === selectedRouteKey)
    // At rest the aggregate throat is selected, so no route is dimmed.
    ?? aggregateThroatSelection(model);

  return (
    <div className="space-y-3 px-5 py-5 sm:px-6 lg:px-7" data-testid="exit-route-map">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="pharos-section-title">Exit route map</h2>
        <p className="pharos-meta">Protocol doors and chain lanes, sized by their share of DEX depth</p>
      </div>
      <ExitRouteInstrumentScene model={model} selected={selected} onSelect={handleSelectRoute} />
      <SelectedExitRoutePanel selection={selected} />
      <ExitRouteFallbackList model={model} />
      <p className="pharos-meta">
        <span className="pharos-numeric">{model.protocolCount.toLocaleString("en-US")}</span> protocol doors ·{" "}
        <span className="pharos-numeric">{model.chainCount.toLocaleString("en-US")}</span> chain lanes ·{" "}
        <span className="pharos-numeric">{model.poolCount.toLocaleString("en-US")}</span> pools
      </p>
    </div>
  );
}
