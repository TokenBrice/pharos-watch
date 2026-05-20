"use client";

import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import { MintBurnCard } from "@/components/home-alt-mini-cards/mint-burn-card";
import { PegHealthCard } from "@/components/home-alt-mini-cards/peg-health-card";
import { PsiBandCard } from "@/components/home-alt-mini-cards/psi-band-card";
import { RecentFreezesCard } from "@/components/home-alt-mini-cards/recent-freezes-card";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";

// Two-row bento. Column 2 reads vertically as a peg-stress column: the slim
// Peg Health distribution sits directly above the Active Depegs list, so the
// summary band feeds the live offenders. Recent Freezes promoted to the tall
// row with a daily bar chart + recent events list.
export function HomeAltMiniCardGrid(): React.JSX.Element {
  return (
    <SectionErrorBoundary name="mini-card grid">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <PsiBandCard />
          <PegHealthCard />
          <MintBurnCard />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <RecentFreezesCard />
          <ActiveDepegsCard />
          <SupplyMovesCard />
        </div>
      </div>
    </SectionErrorBoundary>
  );
}
