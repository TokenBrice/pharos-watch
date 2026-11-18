"use client";

import { useState } from "react";
import { HomeSectionErrorBoundary } from "@/components/homepage/home-section-error-boundary";
import { useHomepageSnapshot, usePegSummary } from "@/hooks/api-hooks";
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
// the top-right. Row 2 carries the tall event lists. While any confirmed
// incident is open (market state, not ops health) Active depegs leads row 1,
// first on phones, and the promo takes its row-2 slot.
export function HomeAltMiniCardGrid(): React.JSX.Element {
  // Measure the CSS-controlled slot, not a second copy of the @4xl breakpoint.
  // Its desktop grid track reserves the same geometry before hydration/mount.
  const [digestSlotRef, digestSlotWidth] = useElementWidth<HTMLDivElement>();
  // The hero's compact snapshot has usually landed before this grid mounts; the
  // cards' peg summary backs it. The order is latched in render the first time
  // either source settles, so a later poll or incident change never moves the
  // slots after mount (the steady order holds until then).
  const snapshot = useHomepageSnapshot();
  const pegSummary = usePegSummary();
  const settled = snapshot.data !== undefined || snapshot.error != null
    || pegSummary.data !== undefined || pegSummary.error != null;
  const [latchedLead, setLatchedLead] = useState<boolean | null>(null);
  if (latchedLead === null && settled) {
    setLatchedLead((snapshot.data?.incidents.data?.activeDepegCount ?? 0) > 0
      || (pegSummary.data?.summary?.activeDepegCount ?? 0) > 0);
  }
  const depegsLead = latchedLead ?? false;
  const digestSlot = (
    // Desktop-only editorial promo.
    <div ref={digestSlotRef} className="hidden @4xl:col-span-1 @4xl:block">
      {digestSlotWidth > 0 ? <DailyDigestCard /> : null}
    </div>
  );

  return (
    <HomeSectionErrorBoundary name="mini-card grid">
      <div className="@container space-y-3">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[322px] @4xl:grid-cols-3">
          {depegsLead ? <ActiveDepegsCard /> : null}
          <PegHealthCard />
          <div className="pharos-card-shell grid h-full grid-rows-[1fr_1fr] overflow-hidden">
            <div className="min-h-0 border-b border-border/50">
              <PsiBandCard embedded />
            </div>
            <div className="min-h-0">
              <MintBurnCard embedded />
            </div>
          </div>
          {depegsLead ? null : digestSlot}
        </div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[260px] @4xl:grid-cols-3">
          <SupplyMovesCard />
          <RecentFreezesCard />
          {depegsLead ? digestSlot : <ActiveDepegsCard />}
        </div>
      </div>
    </HomeSectionErrorBoundary>
  );
}
