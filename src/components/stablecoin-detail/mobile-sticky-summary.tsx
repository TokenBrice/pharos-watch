"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { formatHeroNativePrice } from "@/components/stablecoin-detail/hero-card-metrics";
import { isMobileStickySummaryEnabled } from "@/lib/feature-flags";
import type { StablecoinData, StablecoinMeta } from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

interface MobileStickySummaryProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  pegRef: number | null;
  logoSrc?: string;
  reportCard: V9ConsumerCard | null;
  observeTarget: RefObject<HTMLElement | null>;
}

const STICKY_HEIGHT_VAR = "--pharos-sticky-summary-h";

/**
 * Mobile-only compact summary that appears once the hero card scrolls out of
 * view. Sticks to top: 0; the scrollspy nav sticks to top: 3.5rem just below.
 *
 * Publishes its measured height as `--pharos-sticky-summary-h` on
 * `document.documentElement` so `LongformScrollspyNav` can include it in
 * `scrollMarginTop` (via a `calc()`) without prop-drilling between sibling
 * components. Variable is removed when the summary unmounts or hides.
 */
export function MobileStickySummary({
  coin,
  coinData,
  pegRef,
  logoSrc,
  reportCard,
  observeTarget,
}: MobileStickySummaryProps) {
  const enabled = isMobileStickySummaryEnabled();
  const [visible, setVisible] = useState(false);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = observeTarget.current;
    if (!el) return;
    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, observeTarget]);

  useEffect(() => {
    if (!enabled || !visible) return;
    const node = summaryRef.current;
    if (!node) return;
    if (typeof window === "undefined" || typeof window.ResizeObserver === "undefined") return;
    const publish = () => {
      const h = node.getBoundingClientRect().height;
      document.documentElement.style.setProperty(
        STICKY_HEIGHT_VAR,
        `${Math.round(h)}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(node);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty(STICKY_HEIGHT_VAR);
    };
  }, [enabled, visible]);

  if (!enabled || !visible) return null;
  return (
    <div
      ref={summaryRef}
      aria-hidden={false}
      className="sticky top-0 z-40 -mx-4 flex items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-1.5 lg:hidden"
    >
      <StablecoinLogo src={logoSrc} name={coin.name} size={20} />
      <span className="text-sm font-semibold">{coin.symbol}</span>
      <span className="ml-auto font-mono text-sm tabular-nums">
        {formatHeroNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef, 4)}
      </span>
      {reportCard ? (
        <SafetyGradeBadge
          grade={reportCard.grade}
          size="xs"
          versionTopic="safetyScore"
          versionVariant="tooltip-only"
        />
      ) : null}
    </div>
  );
}
