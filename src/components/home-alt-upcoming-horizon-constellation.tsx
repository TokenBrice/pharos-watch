import Link from "next/link";
import { SquareArrowRight } from "lucide-react";

import { HorizonConstellation } from "@/components/horizon-constellation";
import { HORIZON_PRE_LAUNCH_STABLECOINS } from "@/lib/horizon-constellation-layout";

export function HomeAltUpcomingHorizonConstellation(): React.JSX.Element | null {
  const total = HORIZON_PRE_LAUNCH_STABLECOINS.length;
  if (total === 0) return null;

  return (
    <section aria-labelledby="upcoming-horizon-constellation-title" className="space-y-3 sm:space-y-4">
      <h2 id="upcoming-horizon-constellation-title" className="sr-only">
        Upcoming stablecoins on the horizon — constellation view
      </h2>

      <div className="space-y-1 sm:space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className="font-display text-2xl font-bold text-foreground sm:text-3xl">On The Horizon</p>
          <div className="flex shrink-0 items-center gap-3 sm:pt-0">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              <span className="pharos-numeric font-semibold text-foreground">{total}</span> Tokens
            </span>
            <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-border sm:inline-block" />
            <Link
              href="/upcoming/"
              aria-label="Open tracker"
              className="pharos-focus-ring group inline-flex min-h-7 items-center gap-1.5 rounded-[4px] border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-border hover:bg-muted/60 sm:min-h-8 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-[13px]"
            >
              Tracker
              <SquareArrowRight
                aria-hidden="true"
                className="h-3 w-3 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground sm:h-3.5 sm:w-3.5"
                strokeWidth={2}
              />
            </Link>
          </div>
        </div>
        <p className="max-w-[13rem] text-[10px] leading-snug text-muted-foreground sm:max-w-none sm:text-sm">
          Explore announced stablecoins and their varying levels of readiness.
        </p>
      </div>

      <div className="pharos-card-shell overflow-hidden">
        <HorizonConstellation
          widePhaseClassName="flex flex-col items-center gap-4 px-3 py-5"
          narrowPhaseClassName="flex items-center gap-2 px-3 py-[2px] sm:gap-3 sm:px-4 sm:py-3.5"
        />
      </div>
    </section>
  );
}
