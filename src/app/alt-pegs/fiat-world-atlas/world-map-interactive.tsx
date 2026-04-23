"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PegCurrency } from "@shared/types";

export interface CountryInfo {
  peg: PegCurrency;
  label: string;
  coinCount: number;
  symbolPreview: string;
}

interface TooltipState {
  iso: string;
  info: CountryInfo;
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
}

const TOOLTIP_OFFSET = 16;
const TOOLTIP_EST_WIDTH = 220;
const TOOLTIP_EST_HEIGHT = 64;

export function WorldMapInteractive({
  countryInfo,
  children,
}: {
  countryInfo: Readonly<Record<string, CountryInfo>>;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const marked: Element[] = [];
    for (const iso of Object.keys(countryInfo)) {
      const path = root.querySelector(`path#${iso}`);
      if (path) {
        path.setAttribute("data-tracked", "true");
        marked.push(path);
      }
    }
    return () => {
      for (const path of marked) path.removeAttribute("data-tracked");
    };
  }, [countryInfo]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const target = event.target as Element | null;
      const path = target?.closest?.("path") ?? null;
      const iso = path?.getAttribute("id") ?? null;
      const info = iso ? countryInfo[iso] : undefined;
      if (!iso || !info) {
        setTooltip((prev) => (prev === null ? prev : null));
        return;
      }
      const rect = container.getBoundingClientRect();
      setTooltip({
        iso,
        info,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        containerWidth: rect.width,
        containerHeight: rect.height,
      });
    },
    [countryInfo],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      data-testid="world-map-interactive"
    >
      {children}
      {tooltip ? <CountryTooltip state={tooltip} /> : null}
    </div>
  );
}

function CountryTooltip({ state }: { state: TooltipState }) {
  const { info, x, y, containerWidth, containerHeight } = state;
  const flipX = x + TOOLTIP_OFFSET + TOOLTIP_EST_WIDTH > containerWidth;
  const flipY = y + TOOLTIP_OFFSET + TOOLTIP_EST_HEIGHT > containerHeight;
  const tx = flipX ? x - TOOLTIP_OFFSET - TOOLTIP_EST_WIDTH : x + TOOLTIP_OFFSET;
  const ty = flipY ? y - TOOLTIP_OFFSET - TOOLTIP_EST_HEIGHT : y + TOOLTIP_OFFSET;
  const transform = `translate(${tx}px, ${ty}px)`;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute left-0 top-0 z-20 max-w-xs rounded-xl border border-border/70 bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm"
      style={{ transform }}
      data-peg={info.peg}
      data-iso={state.iso}
    >
      <p className="text-sm font-semibold tracking-tight text-foreground">
        {info.label}
      </p>
      <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        {info.coinCount} coin{info.coinCount === 1 ? "" : "s"}
        {info.symbolPreview ? ` · ${info.symbolPreview}` : ""}
      </p>
    </div>
  );
}
