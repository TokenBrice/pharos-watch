"use client";

import { useEffect, useState, type RefObject } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { formatNativePrice } from "@shared/lib/format";
import { isMobileStickySummaryEnabled } from "@/lib/feature-flags";
import type { ReportCard, StablecoinData, StablecoinMeta } from "@shared/types";

interface MobileStickySummaryProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  pegRef: number;
  logoSrc?: string;
  reportCard: ReportCard | null;
  observeTarget: RefObject<HTMLElement | null>;
}

/**
 * Mobile-only compact summary that appears once the hero card scrolls out of
 * view. Sticks to top: 0; the scrollspy nav sticks to top: 3.5rem just below.
 *
 * KNOWN OFFSET: section anchors set their scrollMarginTop based on the
 * scrollspy rail only; this 36px summary slightly overlaps section heading
 * text when scrollspy pills are clicked. Acceptable for the initial ship.
 * A follow-up may extend `applyScrollMargins` in longform-scrollspy-nav.tsx
 * to add this summary's measured height when mounted.
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
  if (!enabled || !visible) return null;
  return (
    <div
      aria-hidden={false}
      className="sticky top-0 z-40 -mx-4 flex items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-1.5 lg:hidden"
    >
      <StablecoinLogo src={logoSrc} name={coin.name} size={20} />
      <span className="text-sm font-semibold">{coin.symbol}</span>
      <span className="ml-auto font-mono text-sm tabular-nums">
        {formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef, 4)}
      </span>
      {reportCard ? <SafetyGradeBadge grade={reportCard.overallGrade} size="xs" /> : null}
    </div>
  );
}
