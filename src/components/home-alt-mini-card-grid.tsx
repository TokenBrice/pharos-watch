"use client";

import Link from "next/link";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
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
  return (
    <SectionErrorBoundary name="mini-card grid">
      <div className="@container space-y-3">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[322px] @4xl:grid-cols-3">
          <PegHealthCard />
          <div className="pharos-card-shell grid h-full grid-rows-[1fr_1fr_auto] overflow-hidden">
            <div className="min-h-0 border-b border-border/50">
              <PsiBandCard embedded />
            </div>
            <div className="min-h-0 border-b border-border/50">
              <MintBurnCard embedded />
            </div>
            <p className="bg-[color:var(--panel-header-bg)] px-4 py-3 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
              Pharos is powered by your support —{" "}
              <Link
                prefetch={false}
                href="/funding/"
                className="pharos-focus-ring rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                Donate here
              </Link>
            </p>
          </div>
          {/* Desktop-only editorial promo completes the first-row Figma trio. */}
          <div className="hidden @4xl:col-span-1 @4xl:block">
            <DailyDigestCard />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:auto-rows-[252px] @4xl:grid-cols-3">
          <SupplyMovesCard />
          <RecentFreezesCard />
          <ActiveDepegsCard />
        </div>
      </div>
    </SectionErrorBoundary>
  );
}
