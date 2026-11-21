"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStressSignals } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCompactUsd } from "@shared/lib/format";
import { THREAT_BAND_HEX, THREAT_BAND_LABELS } from "@shared/lib/classification";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { ThreatBand } from "@shared/lib/classification";
import { sweepDuration, pulseDuration } from "@/lib/dews-radar-utils";
import {
  CX,
  CY,
  OUTER_R,
  VB_W,
  VB_H,
  RING_BANDS,
  LEGEND_BANDS,
  RING_RADII,
  CALM_INNER_R,
  SPOKES,
  WAKE_PATH,
  WATCH_DOT_RADIUS,
  dewsLogoRadius,
  mcapDotRadius,
  resolveRadarClick,
  buildDewsSummaryViewModel,
  type BandCounts,
  type CalmDot,
  type ElevatedCoin,
} from "@/components/dews/dews-summary-model";
import { ChartTooltipSurface, TooltipRow } from "@/components/pharos-chart-tooltip";
import { useSvgId } from "@/components/chart-primitives/axes";
import { useMediaQuery } from "@/hooks/use-is-mobile";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

// DEWS radar keyframes are defined in globals.css under "DEWS Radar animations".

function DEWSCalmDot({ x, y }: CalmDot) {
  const cx = x.toFixed(1);
  const cy = y.toFixed(1);
  return (
    <g>
      <circle cx={cx} cy={cy} r={5} fill="var(--dews-radar-calm-dot-bloom)" />
      <circle cx={cx} cy={cy} r={2} fill="var(--dews-radar-calm-dot-core)" />
    </g>
  );
}

const DEWS_DOT_KEY_ACTIONS: Record<string, 1 | -1 | "first" | "last"> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

function DEWSDot({
  coin,
  onHover,
  onClick,
  onFocusDot,
  onArrowKey,
  isSelected,
  isActiveDepeg,
  tabIndex,
  ariaLabel,
  registerRef,
}: {
  coin: ElevatedCoin;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
  onFocusDot: (id: string) => void;
  onArrowKey: (direction: 1 | -1 | "first" | "last") => void;
  isSelected?: boolean;
  isActiveDepeg?: boolean;
  tabIndex: 0 | -1;
  ariaLabel: string;
  registerRef: (id: string, node: SVGGElement | null) => void;
}) {
  const logoClipId = useSvgId("dews-logo");
  const prefersReducedMotion = usePrefersReducedMotion();
  const hex = THREAT_BAND_HEX[coin.band];
  const isWatch = coin.band === "WATCH";
  const isHighTier = coin.band === "WARNING" || coin.band === "DANGER";
  const showLogo = !isWatch && Boolean(coin.logoUrl);
  const dotR = isWatch ? WATCH_DOT_RADIUS : (mcapDotRadius(coin.mcap) ?? (isHighTier ? 9 : 6));
  const logoR = showLogo ? dewsLogoRadius(coin) : dotR;
  const visualR = showLogo ? logoR : dotR;
  const logoInnerR = logoR * 0.75;
  const glowR = visualR + 6;
  const dur = pulseDuration(coin.band);

  return (
    <g
      ref={(node) => registerRef(coin.id, node)}
      transform={`translate(${coin.x.toFixed(1)}, ${coin.y.toFixed(1)})`}
      role="button"
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      data-dews-band={coin.band}
      style={{ cursor: "pointer" }}
      onMouseEnter={() => onHover(coin.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => {
        onHover(coin.id);
        onFocusDot(coin.id);
      }}
      onBlur={() => onHover(null)}
      onClick={() => onClick(coin.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(coin.id);
          return;
        }
        const action = DEWS_DOT_KEY_ACTIONS[e.key];
        if (action) {
          e.preventDefault();
          onArrowKey(action);
        }
      }}
    >
      {/* Touch-friendly hit area to improve mobile targeting precision */}
      <circle r={18} fill="transparent" stroke="transparent" />
      {isSelected && (
        <>
          <circle
            r={visualR + 10}
            fill="none"
            stroke={hex}
            strokeWidth={2}
            strokeDasharray="4 2"
            opacity={0.65}
          >
            {!prefersReducedMotion && (
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 0 0"
                to="360 0 0"
                dur="8s"
                repeatCount="indefinite"
              />
            )}
          </circle>
          <circle
            r={visualR + 4}
            fill="none"
            stroke="var(--color-background)"
            strokeWidth={2}
          />
        </>
      )}
      {!isWatch && (
        <circle
          r={glowR}
          fill={hex}
          className="dews-glow-r"
          style={{ animation: `dews-glow ${dur}s ease-in-out infinite` }}
        />
      )}
      {/* Confirmed-depeg halo: one crisp +4px ring around the mark so open
          incidents stand out by shape without multi-ring visual smear. */}
      {isActiveDepeg && (
        <circle
          r={visualR + 4}
          fill="none"
          stroke={hex}
          strokeWidth={1.75}
          data-dews-depeg-ring=""
        />
      )}
      {showLogo ? (
        <>
          <defs>
            <clipPath id={logoClipId}>
              <circle r={logoR - 1.5} />
            </clipPath>
          </defs>
          <circle r={logoR + 2} fill={hex} fillOpacity={0.18} />
          <circle r={logoR} fill="var(--color-background)" stroke={hex} strokeWidth={1.75} />
          <image
            href={coin.logoUrl}
            x={-logoInnerR}
            y={-logoInnerR}
            width={logoInnerR * 2}
            height={logoInnerR * 2}
            preserveAspectRatio="xMidYMid meet"
            clipPath={`url(#${logoClipId})`}
          />
        </>
      ) : (
        <circle r={dotR} fill={hex} fillOpacity={isWatch ? 0.9 : 0.92} data-dews-dot="" />
      )}
      {/* Always-visible label: WARNING and DANGER only, stroke-backed for legibility */}
      {isHighTier && (
        <text
          y={-(visualR + 7)}
          textAnchor="middle"
          dominantBaseline="auto"
          fill={hex}
          stroke="var(--color-card)"
          strokeWidth={3.5}
          strokeLinejoin="round"
          paintOrder="stroke"
          fontSize={10}
          fontWeight={700}
          fontFamily="var(--font-mono)"
        >
          {coin.symbol}
        </text>
      )}
    </g>
  );
}

function DEWSTooltip({ coin }: { coin: ElevatedCoin }) {
  const hex = THREAT_BAND_HEX[coin.band];
  const leftPct = (coin.x / VB_W) * 100;
  const topPct = (coin.y / VB_H) * 100;
  const alignRight = coin.x > VB_W * 0.62;
  const placeBelow = coin.y < VB_H * 0.28;
  const tx = alignRight ? "calc(-100% - 12px)" : "12px";
  const ty = placeBelow ? "10px" : "calc(-100% - 10px)";

  return (
    <ChartTooltipSurface
      data-dews-tooltip=""
      className="pointer-events-none absolute z-10 min-w-40 space-y-1.5"
      style={{
        left: `${leftPct.toFixed(2)}%`,
        top: `${topPct.toFixed(2)}%`,
        transform: `translate(${tx}, ${ty})`,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-foreground">{coin.symbol}</span>
        <span className="font-mono text-2xs font-semibold" style={{ color: hex }}>
          {coin.band}
        </span>
      </div>
      <div className="space-y-0.5">
        <TooltipRow label="DEWS" value={`${coin.score}/100`} color={hex} bold />
        <TooltipRow
          label="Market cap"
          value={coin.mcap == null ? "Supply unavailable" : `${formatCompactUsd(coin.mcap)} cap`}
        />
      </div>
    </ChartTooltipSurface>
  );
}

function DEWSCenter({ highest, totalCount, sweepDur }: { highest: ThreatBand; totalCount: number; sweepDur: number }) {
  const hex = THREAT_BAND_HEX[highest];
  const label = "SCANNING";
  const sublabel = `${totalCount} DEWS-covered`;

  return (
    <g>
      <circle
        cx={CX}
        cy={CY}
        r={38}
        fill={hex}
        fillOpacity={0.13}
        stroke={hex}
        strokeOpacity={0.38}
        strokeWidth={1.5}
        className="dews-center-r"
        style={{ animation: `dews-center-pulse ${sweepDur}s ease-in-out infinite` }}
      />
      <text
        x={CX}
        y={CY - 5}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={hex}
        fontSize={11}
        fontWeight={700}
        fontFamily="var(--font-mono)"
        letterSpacing={1}
      >
        {label}
      </text>
      <text
        x={CX}
        y={CY + 11}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--color-muted-foreground)"
        fontSize={9}
        fontFamily="var(--font-mono)"
      >
        {sublabel}
      </text>
    </g>
  );
}

// Severity rank for keyboard nav ordering (highest first).
const ROVING_BAND_RANK: Record<ElevatedCoin["band"], number> = {
  DANGER: 4,
  WARNING: 3,
  ALERT: 2,
  WATCH: 1,
};

function buildRovingOrder(elevated: ElevatedCoin[]): ElevatedCoin[] {
  return [...elevated].sort((a, b) => {
    const rank = ROVING_BAND_RANK[b.band] - ROVING_BAND_RANK[a.band];
    if (rank !== 0) return rank;
    if (a.mcap == null) return b.mcap == null ? a.id.localeCompare(b.id) : 1;
    if (b.mcap == null) return -1;
    return b.mcap - a.mcap;
  });
}

function DEWSRadar({
  elevated,
  calmDots,
  highest,
  totalCount,
  activeDepegIds,
  maxHeight,
  onCoinClick,
}: {
  elevated: ElevatedCoin[];
  calmDots: CalmDot[];
  highest: ThreatBand;
  totalCount: number;
  activeDepegIds?: ReadonlySet<string>;
  maxHeight: number;
  onCoinClick: (id: string) => void;
}) {
  const uid = useId();
  const wakeGradId = useSvgId("dews-wake");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Hover affordances require a hover-capable fine pointer; touch devices fall
  // back to tap-to-navigate via resolveRadarClick.
  const isFinePointer = useMediaQuery("(hover: hover) and (pointer: fine)", false);

  // Roving tabindex: keyboard order = severity desc, then mcap desc.
  const rovingOrder = useMemo(() => buildRovingOrder(elevated), [elevated]);
  const [rovingFocusId, setRovingFocusId] = useState<string | null>(null);
  const dotRefs = useRef<Map<string, SVGGElement>>(new Map());
  const liveMessageId = `dews-live-${uid}`;
  const [liveMessage, setLiveMessage] = useState("");

  // Derived roving anchor: the user's explicit selection if still valid,
  // otherwise the first dot in keyboard order. Derived (not effect-synced) so
  // it stays correct when the elevated set or ordering changes without a
  // setState-in-effect cascade.
  const effectiveRovingId = useMemo(() => {
    if (rovingOrder.length === 0) return null;
    if (rovingFocusId && rovingOrder.some((c) => c.id === rovingFocusId)) return rovingFocusId;
    return rovingOrder[0]?.id ?? null;
  }, [rovingOrder, rovingFocusId]);

  const registerRef = useCallback((id: string, node: SVGGElement | null) => {
    if (node) dotRefs.current.set(id, node);
    else dotRefs.current.delete(id);
  }, []);

  const focusDotById = useCallback((id: string) => {
    const node = dotRefs.current.get(id);
    if (node) node.focus();
  }, []);

  const handleArrow = useCallback(
    (direction: 1 | -1 | "first" | "last") => {
      if (rovingOrder.length === 0) return;
      const currentIdx = effectiveRovingId
        ? rovingOrder.findIndex((c) => c.id === effectiveRovingId)
        : 0;
      let nextIdx: number;
      if (direction === "first") nextIdx = 0;
      else if (direction === "last") nextIdx = rovingOrder.length - 1;
      else nextIdx = Math.min(Math.max(currentIdx + direction, 0), rovingOrder.length - 1);
      const next = rovingOrder[nextIdx];
      if (!next) return;
      setRovingFocusId(next.id);
      focusDotById(next.id);
    },
    [rovingOrder, effectiveRovingId, focusDotById],
  );

  const buildAnnouncement = useCallback(
    (coin: ElevatedCoin): string => {
      const idx = rovingOrder.findIndex((c) => c.id === coin.id);
      const position = idx >= 0 ? `${idx + 1} of ${rovingOrder.length}` : `${rovingOrder.length}`;
      const mcap = coin.mcap != null ? `, ${formatCompactUsd(coin.mcap)} market cap` : ", supply unavailable";
      const depeg = activeDepegIds?.has(coin.id) ? ", with an open confirmed incident" : "";
      return `${position}: ${coin.symbol}, ${THREAT_BAND_LABELS[coin.band]} band${depeg}${mcap}`;
    },
    [rovingOrder, activeDepegIds],
  );

  const handleFocusDot = useCallback(
    (id: string) => {
      setRovingFocusId(id);
      const coin = rovingOrder.find((c) => c.id === id);
      if (coin) setLiveMessage(buildAnnouncement(coin));
    },
    [rovingOrder, buildAnnouncement],
  );

  const hex = THREAT_BAND_HEX[highest];
  const dur = sweepDuration(highest);

  return (
    <div className="relative">
      <span
        id={liveMessageId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveMessage}
      </span>
      <svg
      className="mx-auto block"
      viewBox="0 0 560 500"
      width="100%"
      style={{ maxHeight }}
      aria-label={`DEWS radar: ${elevated.length === 0 ? "all coins calm" : `${elevated.length} elevated, highest: ${highest}. Use arrow keys to navigate elevated coins.`}`}
      aria-describedby={liveMessageId}
      // group, not img: the radar contains focusable role="button" blips, and
      // interactive descendants inside an img role are invalid (axe
      // nested-interactive). group keeps the accessible name.
      role="group"
    >
      <defs>
        <radialGradient id={wakeGradId} cx={CX} cy={CY} r={OUTER_R} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={hex} stopOpacity={0.18} />
          <stop offset="100%" stopColor={hex} stopOpacity={0} />
        </radialGradient>
      </defs>

      {SPOKES.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="var(--dews-radar-spoke)" strokeWidth={1} />
      ))}

      {RING_BANDS.map((band) => (
        <circle
          key={band}
          cx={CX}
          cy={CY}
          r={RING_RADII[band]}
          fill="none"
          stroke={THREAT_BAND_HEX[band]}
          style={{ strokeOpacity: "var(--dews-radar-band-ring-opacity)" }}
          strokeWidth={1}
          strokeDasharray="4 6"
        />
      ))}
      {/* Calm zone inner boundary — faint gray, not a threat color */}
      <circle
        cx={CX}
        cy={CY}
        r={CALM_INNER_R}
        fill="none"
        stroke="var(--dews-radar-calm-boundary)"
        strokeWidth={1}
        strokeDasharray="4 6"
      />
      <circle
        cx={CX}
        cy={CY}
        r={OUTER_R}
        fill="none"
        stroke={hex}
        style={{ strokeOpacity: "var(--dews-radar-outer-ring-opacity)" }}
        strokeWidth={1}
        strokeDasharray="4 6"
      />

      <g
        className="dews-sweep-g"
        style={{
          transformOrigin: `${CX}px ${CY}px`,
          animation: `dews-sweep-rotate ${dur}s linear infinite`,
        }}
      >
        <path d={WAKE_PATH} fill={`url(#${wakeGradId})`} />
        <line
          x1={CX}
          y1={CY}
          x2={CX + OUTER_R}
          y2={CY}
          stroke={hex}
          strokeOpacity={0.65}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </g>

      {calmDots.map((dot, i) => (
        <DEWSCalmDot key={i} x={dot.x} y={dot.y} />
      ))}

      {elevated.map((coin) => (
        <DEWSDot
          key={coin.id}
          coin={coin}
          isSelected={hoveredId === coin.id}
          isActiveDepeg={activeDepegIds?.has(coin.id) ?? false}
          tabIndex={coin.id === effectiveRovingId ? 0 : -1}
          ariaLabel={buildAnnouncement(coin)}
          registerRef={registerRef}
          onFocusDot={handleFocusDot}
          onArrowKey={handleArrow}
          onHover={(id) => {
            if (isFinePointer) {
              setHoveredId(id);
            }
          }}
          onClick={(id) => {
            const outcome = resolveRadarClick(isFinePointer, hoveredId, id);
            setHoveredId(outcome.nextHoveredId);
            if (outcome.shouldNavigate) {
              onCoinClick(id);
            }
          }}
        />
      ))}
      <DEWSCenter highest={highest} totalCount={totalCount} sweepDur={dur} />
      </svg>
      {hoveredId &&
        (() => {
          const hovered = elevated.find((c) => c.id === hoveredId);
          return hovered ? <DEWSTooltip coin={hovered} /> : null;
        })()}
    </div>
  );
}

function DEWSLegend({
  bandCounts,
  updatedAtLabel,
  activeDepegCount,
}: {
  bandCounts: BandCounts;
  updatedAtLabel: string;
  activeDepegCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-y-1 border-t gap-x-4 pt-3">
      {LEGEND_BANDS.map((band) => (
        <div key={band} className="flex items-center gap-1.5">
          {band === "CALM" ? (
            <svg width={20} height={8} aria-hidden="true">
              <circle cx={10} cy={4} r={3.5} fill="var(--dews-radar-calm-dot-bloom)" />
              <circle cx={10} cy={4} r={1.75} fill="var(--dews-radar-calm-dot-core)" />
            </svg>
          ) : (
            <svg width={20} height={4} aria-hidden="true">
              <line x1={0} y1={2} x2={20} y2={2} stroke={THREAT_BAND_HEX[band]} strokeWidth={2} />
            </svg>
          )}
          <span className="text-xs text-muted-foreground capitalize">
            {THREAT_BAND_LABELS[band]} ({bandCounts[band]})
          </span>
        </div>
      ))}
      {activeDepegCount > 0 ? (
        <div className="flex items-center gap-1.5">
          <svg width={20} height={12} aria-hidden="true">
            <circle cx={10} cy={6} r={3} fill="var(--color-muted-foreground)" />
            <circle cx={10} cy={6} r={5.5} fill="none" stroke="var(--color-muted-foreground)" strokeWidth={1.25} />
          </svg>
          <span className="text-xs text-muted-foreground">Elevated, open confirmed incident ({activeDepegCount})</span>
        </div>
      ) : null}
      <span className="pharos-meta ml-auto">Updated {updatedAtLabel}</span>
    </div>
  );
}

interface DEWSRadarPanelProps {
  logos?: Record<string, string>;
  className?: string;
  /** Coins in a confirmed live depeg, drawn as a halo on their radar mark. */
  activeDepegIds?: ReadonlySet<string>;
  /** Cap for the radar stage, so a hero can run it more compactly. */
  maxHeight?: number;
  /** Keep the depeg hero chart and legend footprint through every first-read outcome. */
  reserveSpace?: boolean;
  /** Peg arrival can change the halo legend even when DEWS already settled. */
  reserveLegend?: boolean;
}

/**
 * The DEWS radar as an embeddable panel: chart stage plus legend, no card shell
 * and no heading. The owning surface supplies the header and methodology link.
 *
 * Its universe is every DEWS-covered asset, which is wider than the tracked
 * peg-status universe the surrounding peg-summary figures use. The centre
 * caption and legend name that scope so the two counts are not read as one.
 */
export function DEWSRadarPanel({ logos, className, activeDepegIds, maxHeight = 440, reserveSpace = false, reserveLegend = reserveSpace }: DEWSRadarPanelProps) {
  const { data, isLoading, error } = useStressSignals();
  const { data: stablecoinsData } = useStablecoins();
  const router = useRouter();
  const peggedAssets = stablecoinsData?.peggedAssets;

  const mcapById = useMemo(() => {
    if (!peggedAssets) return undefined;
    return new Map(peggedAssets.map((c) => [c.id, getCirculatingRawOrNull(c)]));
  }, [peggedAssets]);

  const viewModel = useMemo(() => {
    if (!data?.signals || Object.keys(data.signals).length === 0) return null;
    return buildDewsSummaryViewModel(data, logos, mcapById);
  }, [data, logos, mcapById]);

  // Halo changes belong inside the reserved legend, not in the chart's height.
  const haloCount = activeDepegIds
    ? viewModel?.elevated.filter((coin) => activeDepegIds.has(coin.id)).length ?? 0
    : 0;
  const radar = viewModel ? (
    <DEWSRadar
      elevated={viewModel.elevated}
      calmDots={viewModel.calmDots}
      highest={viewModel.highest}
      totalCount={viewModel.totalCount}
      activeDepegIds={activeDepegIds}
      maxHeight={maxHeight}
      onCoinClick={(id) => router.push(buildStablecoinUrl(id))}
    />
  ) : null;
  const legend = viewModel ? (
    <DEWSLegend bandCounts={viewModel.bandCounts} updatedAtLabel={viewModel.updatedAtLabel} activeDepegCount={haloCount} />
  ) : null;

  if (reserveSpace || reserveLegend) {
    return (
      <div className={cn("pharos-chart-stage flex flex-col", className)}>
        {reserveSpace ? (
          <div
            className="relative mx-auto aspect-[560/500] w-full"
            style={{ maxWidth: Math.round((maxHeight * VB_W) / VB_H) }}
          >
            {isLoading ? (
              <div aria-busy="true" className="absolute inset-0 animate-pulse rounded-lg bg-muted" />
            ) : error && data == null ? (
              <div tabIndex={0} className="absolute inset-0 overflow-auto">
                <QueryErrorNotice error={error} hasData={false} />
              </div>
            ) : <div className="absolute inset-0">{radar}</div>}
          </div>
        ) : <div className="flex-1">{radar}</div>}
        {reserveLegend ? <div className="min-h-36 sm:min-h-16">{legend}</div> : legend}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn("pharos-chart-stage flex flex-col", className)}>
        <div aria-busy="true" className="rounded-lg bg-muted animate-pulse" style={{ height: maxHeight }} />
      </div>
    );
  }

  // A failed refresh keeps the retained radar; the route's shared DEWS notice owns its age.
  if (error && data == null) {
    return <QueryErrorNotice error={error} hasData={false} />;
  }

  if (!viewModel) return null;

  return (
    <div className={cn("pharos-chart-stage flex flex-col", className)}>
      <div className="flex-1">{radar}</div>
      {legend}
    </div>
  );
}
