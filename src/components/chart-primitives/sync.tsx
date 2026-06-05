"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// D4 — Linked-axis brushing + synchronized crosshair context
// ---------------------------------------------------------------------------

/**
 * Brushed time window as `[fromMs, toMs]`. `null` means "no brush — show the
 * full controlled range". When set, both paired charts re-domain to the
 * window.
 */
export type BrushedRange = readonly [number, number] | null;

export interface MarketDataChartSync {
  /** Currently hovered timestamp on either chart, or null. */
  hoveredTs: number | null;
  setHoveredTs: (ts: number | null) => void;
  brushedRange: BrushedRange;
  setBrushedRange: (next: BrushedRange) => void;
}

const MarketDataChartSyncContext = createContext<MarketDataChartSync | null>(null);

/**
 * Provides shared hover + brush state to the McapChart / PegDeviationChart
 * pair in `MarketDataSection`. Both charts subscribe via
 * `useMarketDataChartSync` and broadcast their hovered timestamp + brushed
 * window. The context is intentionally narrow — it's a UI sync channel, not a
 * data store.
 */
export function MarketDataChartSyncProvider({ children }: { children: ReactNode }) {
  const [hoveredTs, setHoveredTsState] = useState<number | null>(null);
  const [brushedRange, setBrushedRangeState] = useState<BrushedRange>(null);
  const setHoveredTs = useCallback((ts: number | null) => setHoveredTsState(ts), []);
  const setBrushedRange = useCallback((next: BrushedRange) => setBrushedRangeState(next), []);
  const value = useMemo(
    () => ({ hoveredTs, setHoveredTs, brushedRange, setBrushedRange }),
    [hoveredTs, brushedRange, setHoveredTs, setBrushedRange],
  );
  return <MarketDataChartSyncContext.Provider value={value}>{children}</MarketDataChartSyncContext.Provider>;
}

/**
 * Optional consumer of `MarketDataChartSyncContext`. Returns `null` when used
 * outside the provider so the same chart components can render standalone
 * (e.g. on the home page) without forcing the provider.
 */
export function useMarketDataChartSync(): MarketDataChartSync | null {
  return useContext(MarketDataChartSyncContext);
}

export function useChartSyncHandlers(sync: MarketDataChartSync | null) {
  const handleMouseMove = useCallback(
    (e: { activeLabel?: string | number } | null) => {
      if (!sync) return;
      const next = e?.activeLabel != null ? Number(e.activeLabel) : null;
      if (next == null || !Number.isFinite(next)) return;
      sync.setHoveredTs(next);
    },
    [sync],
  );
  const handleMouseLeave = useCallback(() => {
    sync?.setHoveredTs(null);
  }, [sync]);

  return useMemo(() => ({ handleMouseMove, handleMouseLeave }), [handleMouseMove, handleMouseLeave]);
}

// ---------------------------------------------------------------------------
// D4 — Custom SVG brush strip
// ---------------------------------------------------------------------------

interface ChartBrushProps {
  /** Full data window the brush can select within (the parent controlled range). */
  domain: readonly [number, number];
  /** Currently selected window. `null` = whole domain. */
  value: BrushedRange;
  onChange: (next: BrushedRange) => void;
  /** Strip height in px. */
  height?: number;
  className?: string;
}

/**
 * Thin SVG drag region for selecting a `[fromMs, toMs]` window. Intentionally
 * lightweight — Recharts' built-in `<Brush>` is heavy and styled to its
 * defaults; this primitive talks directly to the
 * `MarketDataChartSyncContext` shape (`BrushedRange`) so consumers can wire
 * it into linked charts.
 *
 * Interaction model:
 *   - Click-drag on the empty strip starts a new selection.
 *   - Drag the body of an existing selection to translate it.
 *   - Drag either edge handle to resize.
 *   - Double-click clears the brush.
 */
export function ChartBrush({ domain, value, onChange, height = 28, className }: ChartBrushProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<
    | null
    | { mode: "new"; anchor: number }
    | { mode: "move"; startPx: number; startRange: readonly [number, number] }
    | { mode: "resize"; edge: "from" | "to"; otherTs: number }
  >(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const [domainFrom, domainTo] = domain;
  const span = Math.max(1, domainTo - domainFrom);

  const tsToPx = useCallback((ts: number) => ((ts - domainFrom) / span) * width, [domainFrom, span, width]);
  const pxToTs = useCallback(
    (px: number) => {
      const clamped = Math.max(0, Math.min(width, px));
      return domainFrom + (clamped / Math.max(1, width)) * span;
    },
    [domainFrom, span, width],
  );

  const handlePointerDown = (e: ReactPointerEvent<SVGRectElement>, mode: "new" | "move" | "from" | "to") => {
    if (width <= 0) return;
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === "new") {
      dragRef.current = { mode: "new", anchor: pxToTs(px) };
      onChange([pxToTs(px), pxToTs(px)]);
    } else if (mode === "move" && value) {
      dragRef.current = { mode: "move", startPx: px, startRange: value };
    } else if ((mode === "from" || mode === "to") && value) {
      const otherTs = mode === "from" ? value[1] : value[0];
      dragRef.current = { mode: "resize", edge: mode, otherTs };
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (drag.mode === "new") {
      const cur = pxToTs(px);
      const lo = Math.min(drag.anchor, cur);
      const hi = Math.max(drag.anchor, cur);
      onChange([lo, hi]);
    } else if (drag.mode === "move") {
      const deltaTs = (px - drag.startPx) * (span / Math.max(1, width));
      let lo = drag.startRange[0] + deltaTs;
      let hi = drag.startRange[1] + deltaTs;
      const win = hi - lo;
      if (lo < domainFrom) {
        lo = domainFrom;
        hi = lo + win;
      }
      if (hi > domainTo) {
        hi = domainTo;
        lo = hi - win;
      }
      onChange([lo, hi]);
    } else if (drag.mode === "resize") {
      const cur = pxToTs(px);
      const lo = Math.min(drag.otherTs, cur);
      const hi = Math.max(drag.otherTs, cur);
      onChange([lo, hi]);
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    // Drop trivially-thin selections (< 0.5% of span) — treat as a click-to-clear.
    if (value && drag) {
      const winMs = value[1] - value[0];
      if (winMs < span * 0.005) {
        onChange(null);
      }
    }
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore — pointer wasn't captured by this element
    }
  };

  const handleDoubleClick = () => onChange(null);

  const fromPx = value ? tsToPx(value[0]) : 0;
  const toPx = value ? tsToPx(value[1]) : 0;

  return (
    <div ref={containerRef} className={cn("relative w-full select-none", className)}>
      <svg
        width={width}
        height={height}
        role="slider"
        aria-label="Brush time window"
        aria-valuemin={domainFrom}
        aria-valuemax={domainTo}
        aria-valuenow={value ? value[0] : domainFrom}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        style={{ touchAction: "none" }}
      >
        {/* Background track */}
        <rect x={0} y={height / 2 - 2} width={width} height={4} rx={2} fill="var(--color-border)" fillOpacity={0.4} />
        {/* Click-to-create capture layer */}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          cursor={value ? "default" : "crosshair"}
          onPointerDown={(e) => !value && handlePointerDown(e, "new")}
        />
        {value ? (
          <>
            {/* Selection body */}
            <rect
              x={Math.min(fromPx, toPx)}
              y={height / 2 - 6}
              width={Math.abs(toPx - fromPx)}
              height={12}
              rx={3}
              fill="var(--color-foreground)"
              fillOpacity={0.18}
              stroke="var(--color-foreground)"
              strokeOpacity={0.55}
              strokeWidth={1}
              cursor="grab"
              onPointerDown={(e) => handlePointerDown(e, "move")}
            />
            {/* Edge handles */}
            <rect
              x={fromPx - 4}
              y={height / 2 - 8}
              width={8}
              height={16}
              rx={2}
              fill="var(--color-foreground)"
              fillOpacity={0.75}
              cursor="ew-resize"
              onPointerDown={(e) => handlePointerDown(e, "from")}
            />
            <rect
              x={toPx - 4}
              y={height / 2 - 8}
              width={8}
              height={16}
              rx={2}
              fill="var(--color-foreground)"
              fillOpacity={0.75}
              cursor="ew-resize"
              onPointerDown={(e) => handlePointerDown(e, "to")}
            />
          </>
        ) : null}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D4 — Synchronized SVG crosshair (absolutely-positioned overlay)
// ---------------------------------------------------------------------------

interface ChartCrosshairOverlayProps {
  /** Hovered ms timestamp (or null to hide). */
  hoveredTs: number | null;
  /** First / last ts of the visible data window — the chart's x-domain. */
  domain: readonly [number, number] | null;
  /**
   * Plot-area inset (px) from the wrapper's left edge. Should match the
   * Recharts `<YAxis width>` (default 68 via `MonoYAxis`).
   */
  plotInsetLeft: number;
  /** Plot-area inset from the wrapper's right edge. Matches chart `margin.right`. */
  plotInsetRight: number;
  /** Top inset matching the chart's `margin.top`. */
  plotInsetTop: number;
  /** Bottom inset matching the chart's `margin.bottom` (the x-axis area). */
  plotInsetBottom: number;
  className?: string;
}

/**
 * Vertical hairline drawn over the chart's plot area at the x-position of
 * `hoveredTs`. Rendered as an absolutely-positioned overlay so the same
 * primitive works against any Recharts chart layout — we don't depend on
 * Recharts injecting internal axis maps.
 *
 * Use case: paired charts subscribing to the same shared `hoveredTs` via
 * `MarketDataChartSyncContext`. Hover on chart A → both A and B render a
 * matched hairline at the same timestamp.
 */
export function ChartCrosshairOverlay({
  hoveredTs,
  domain,
  plotInsetLeft,
  plotInsetRight,
  plotInsetTop,
  plotInsetBottom,
  className,
}: ChartCrosshairOverlayProps) {
  if (hoveredTs == null || !domain) return null;
  const [from, to] = domain;
  if (hoveredTs < from || hoveredTs > to || to <= from) return null;
  const t = (hoveredTs - from) / (to - from);
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute", className)}
      style={{
        left: plotInsetLeft,
        right: plotInsetRight,
        top: plotInsetTop,
        bottom: plotInsetBottom,
      }}
    >
      <div
        className="absolute top-0 bottom-0 border-l border-dashed border-foreground/55"
        style={{ left: `${t * 100}%` }}
      />
    </div>
  );
}
