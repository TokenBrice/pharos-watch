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
import { getCirculatingRaw } from "@shared/lib/supply";
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
  mcapDotRadius,
  resolveRadarClick,
  buildDewsSummaryViewModel,
  type BandCounts,
  type CalmDot,
  type ElevatedCoin,
} from "@/components/dews-summary-model";
import { useSvgId } from "@/components/chart-primitives/axes";
import { useMediaQuery } from "@/hooks/use-is-mobile";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

// DEWS radar keyframes are defined in globals.css under "DEWS Radar animations".

// ---------------------------------------------------------------------------
// Sub-components (unexported)
// ---------------------------------------------------------------------------

function DEWSCalmDot({ x, y }: CalmDot) {
  const cx = x.toFixed(1);
  const cy = y.toFixed(1);
  return (
    <g>
      {/* Bloom halo */}
      <circle cx={cx} cy={cy} r={5} fill="var(--dews-radar-calm-dot-bloom)" />
      {/* Core */}
      <circle cx={cx} cy={cy} r={2} fill="var(--dews-radar-calm-dot-core)" />
    </g>
  );
}

const DEWS_LOGO_SCALE_BY_BAND: Partial<Record<ElevatedCoin["band"], number>> = {
  ALERT: 2.25,
  WARNING: 2.7,
  DANGER: 3.24,
};
const DEWS_DOT_KEY_ACTIONS: Record<string, 1 | -1 | "first" | "last"> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

function dewsLogoRadius(coin: ElevatedCoin): number {
  const scale = DEWS_LOGO_SCALE_BY_BAND[coin.band] ?? 1;
  const baseR = mcapDotRadius(coin.mcap) ?? 8;
  return baseR * scale;
}

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
  const isHighTier = coin.band === "WARNING" || coin.band === "DANGER";
  const showLogo = coin.band !== "WATCH" && Boolean(coin.logoUrl);
  const dotR = mcapDotRadius(coin.mcap) ?? (isHighTier ? 9 : 6);
  const logoR = showLogo ? dewsLogoRadius(coin) : dotR;
  const visualR = showLogo ? logoR : dotR;
  const logoInnerR = logoR * 0.75;
  const glowR = visualR + 7;
  const dur = pulseDuration(coin.band);

  return (
    <g
      ref={(node) => registerRef(coin.id, node)}
      transform={`translate(${coin.x.toFixed(1)}, ${coin.y.toFixed(1)})`}
      role="button"
      tabIndex={tabIndex}
      aria-label={ariaLabel}
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
      {/* Visual selection ring for touch devices */}
      {isSelected && (
        <>
          <circle
            r={visualR + 12}
            fill="none"
            stroke={hex}
            strokeWidth={2}
            strokeDasharray="4 2"
            opacity={0.6}
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
      {/* Animated glow ring */}
      <circle
        r={glowR}
        fill={hex}
        className="dews-glow-r"
        style={{ animation: `dews-glow ${dur}s ease-in-out infinite` }}
      />
      {/* Confirmed-depeg halo: a double ring outside the glow. Binary state
          from the peg summary, not a DEWS band — shape carries it so the
          meaning does not rest on colour alone. */}
      {isActiveDepeg && (
        <>
          <circle r={visualR + 9} fill="none" stroke="var(--color-background)" strokeWidth={3} />
          <circle r={visualR + 9} fill="none" stroke={hex} strokeWidth={1.5} />
          <circle r={visualR + 12.5} fill="none" stroke={hex} strokeWidth={1.5} strokeOpacity={0.55} />
        </>
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
        <circle r={dotR} fill={hex} fillOpacity={0.92} />
      )}
      {/* Always-visible label: WARNING and DANGER only */}
      {isHighTier && (
        <text
          y={-(logoR + 7)}
          textAnchor="middle"
          dominantBaseline="auto"
          fill={hex}
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
  const W = 124;
  const H = 46;
  // Clamp so tooltip stays within viewBox; flip below the dot when near the top edge
  const tx = Math.min(Math.max(coin.x + 14, 4), VB_W - W - 4);
  const preferAbove = coin.y - H - 10 >= 4;
  const ty = preferAbove ? coin.y - H - 10 : Math.min(coin.y + 14, VB_H - H - 4);

  return (
    <g pointerEvents="none">
      <rect
        x={tx}
        y={ty}
        width={W}
        height={H}
        rx={6}
        fill="var(--color-popover)"
        stroke="var(--color-border)"
        strokeWidth={1}
      />
      <text
        x={tx + 10}
        y={ty + 16}
        fill="var(--color-foreground)"
        fontSize={11}
        fontWeight={600}
        fontFamily="var(--font-sans)"
      >
        {coin.symbol}
      </text>
      <text x={tx + 10} y={ty + 32} fill={hex} fontSize={10} fontWeight={600} fontFamily="var(--font-mono)">
        {coin.band}
      </text>
      <text
        x={tx + W - 10}
        y={ty + 32}
        fill="var(--color-muted-foreground)"
        fontSize={10}
        fontFamily="var(--font-mono)"
        textAnchor="end"
      >
        {coin.score}/100
      </text>
    </g>
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
    const mcapA = a.mcap ?? 0;
    const mcapB = b.mcap ?? 0;
    return mcapB - mcapA;
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
      const mcap = coin.mcap && coin.mcap > 0 ? `, ${formatCompactUsd(coin.mcap)} market cap` : "";
      const depeg = activeDepegIds?.has(coin.id) ? ", in confirmed depeg" : "";
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
      aria-label={`DEWS radar — ${elevated.length === 0 ? "all coins calm" : `${elevated.length} elevated, highest: ${highest}. Use arrow keys to navigate elevated coins.`}`}
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

      {/* Spokes */}
      {SPOKES.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="var(--dews-radar-spoke)" strokeWidth={1} />
      ))}

      {/* Band ring boundaries */}
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

      {/* Sweep group — wake arc + line, rotates together */}
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

      {/* Calm ambient starfield — non-interactive, beneath elevated coins */}
      {calmDots.map((dot, i) => (
        <DEWSCalmDot key={i} x={dot.x} y={dot.y} />
      ))}

      {/* Coin dots */}
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
      {hoveredId &&
        (() => {
          const hovered = elevated.find((c) => c.id === hoveredId);
          return hovered ? <DEWSTooltip coin={hovered} /> : null;
        })()}
      <DEWSCenter highest={highest} totalCount={totalCount} sweepDur={dur} />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DEWSLegend
// ---------------------------------------------------------------------------

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
          <span className="text-xs text-muted-foreground">Elevated, in depeg ({activeDepegCount})</span>
        </div>
      ) : null}
      <span className="pharos-meta ml-auto">Updated {updatedAtLabel}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface DEWSRadarPanelProps {
  logos?: Record<string, string>;
  className?: string;
  /** Coins in a confirmed live depeg, drawn as a halo on their radar mark. */
  activeDepegIds?: ReadonlySet<string>;
  /** Cap for the radar stage, so a hero can run it more compactly. */
  maxHeight?: number;
}

/**
 * The DEWS radar as an embeddable panel: chart stage plus legend, no card shell
 * and no heading. The owning surface supplies the header and methodology link.
 *
 * Its universe is every DEWS-covered asset, which is wider than the tracked
 * peg-status universe the surrounding peg-summary figures use. The centre
 * caption and legend name that scope so the two counts are not read as one.
 */
export function DEWSRadarPanel({ logos, className, activeDepegIds, maxHeight = 440 }: DEWSRadarPanelProps) {
  const { data, isLoading, error } = useStressSignals();
  const { data: stablecoinsData } = useStablecoins();
  const router = useRouter();
  const peggedAssets = stablecoinsData?.peggedAssets;

  const mcapById = useMemo(() => {
    if (!peggedAssets) return undefined;
    return new Map(peggedAssets.map((c) => [c.id, getCirculatingRaw(c)]));
  }, [peggedAssets]);

  const viewModel = useMemo(() => {
    if (!data?.signals || Object.keys(data.signals).length === 0) return null;
    return buildDewsSummaryViewModel(data, logos, mcapById);
  }, [data, logos, mcapById]);

  if (isLoading) {
    return (
      <div className={cn("pharos-chart-stage flex flex-col", className)}>
        <div aria-busy="true" className="rounded-lg bg-muted animate-pulse" style={{ height: maxHeight }} />
      </div>
    );
  }

  if (error) {
    return <QueryErrorNotice error={error} />;
  }

  if (!viewModel) return null;

  const {
    totalCount,
    elevated,
    calmDots,
    bandCounts,
    highest,
    updatedAtLabel,
  } = viewModel;

  // Calm marks are anonymous positions, so a coin in a confirmed depeg that is
  // still CALM on DEWS gets no halo. Count the halos actually drawn rather than
  // every active depeg, or the key promises marks the radar never renders.
  const haloCount = activeDepegIds ? elevated.filter((coin) => activeDepegIds.has(coin.id)).length : 0;

  return (
    <div className={cn("pharos-chart-stage flex flex-col", className)}>
      <div className="flex-1">
        <DEWSRadar
          elevated={elevated}
          calmDots={calmDots}
          highest={highest}
          totalCount={totalCount}
          activeDepegIds={activeDepegIds}
          maxHeight={maxHeight}
          onCoinClick={(id) => router.push(buildStablecoinUrl(id))}
        />
      </div>
      <DEWSLegend
        bandCounts={bandCounts}
        updatedAtLabel={updatedAtLabel}
        activeDepegCount={haloCount}
      />
    </div>
  );
}
