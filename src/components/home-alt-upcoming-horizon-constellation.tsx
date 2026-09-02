import { HorizonConstellation } from "@/components/horizon-constellation";
import { HomeAltTrackerLink } from "@/components/home-alt-tracker-link";
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
            <HomeAltTrackerLink
              href="/upcoming/"
              ariaLabel="Open tracker"
            />
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
