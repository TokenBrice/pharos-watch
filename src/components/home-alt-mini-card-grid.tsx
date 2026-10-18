"use client";

import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { useElementWidth } from "@/hooks/use-element-width";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";
import { MintBurnCard } from "@/components/home-alt-mini-cards/mint-burn-card";
import { PegHealthCard } from "@/components/home-alt-mini-cards/peg-health-card";
import { PsiBandCard } from "@/components/home-alt-mini-cards/psi-band-card";
import { RecentFreezesCard } from "@/components/home-alt-mini-cards/recent-freezes-card";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";

// Two-row bento. Row 1 mirrors the Figma pulse band: Peg Health, the PSI +
// Mint/Burn pair stacked into a single column, and the Daily Digest promo at
// the top-right. Row 2 carries the tall event lists.
export function HomeAltMiniCardGrid(): React.JSX.Element {
  // Measure the CSS-controlled slot, not a second copy of the @4xl breakpoint.
  // Its desktop grid track reserves the same geometry before hydration/mount.
  const [digestSlotRef, digestSlotWidth] = useElementWidth<HTMLDivElement>();

  return (
    <SectionErrorBoundary name="mini-card grid">
      <div className="@container space-y-3">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[322px] @4xl:grid-cols-3">
          <PegHealthCard />
          <div className="pharos-card-shell grid h-full grid-rows-[1fr_1fr] overflow-hidden">
            <div className="min-h-0 border-b border-border/50">
              <PsiBandCard embedded />
            </div>
            <div className="min-h-0">
              <MintBurnCard embedded />
            </div>
          </div>
          {/* Desktop-only editorial promo completes the first-row Figma trio. */}
          <div ref={digestSlotRef} className="hidden @4xl:col-span-1 @4xl:block">
            {digestSlotWidth > 0 ? <DailyDigestCard /> : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[260px] @4xl:grid-cols-3">
          <SupplyMovesCard />
          <RecentFreezesCard />
          <ActiveDepegsCard />
        </div>
      </div>
    </SectionErrorBoundary>
  );
}
