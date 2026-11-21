import { HorizonConstellation } from "@/components/upcoming/horizon-constellation";
import { HomeAltTrackerLink } from "@/components/homepage/home-alt-tracker-link";
import { HomeSectionHeader } from "@/components/homepage/home-section-header";
import { HORIZON_PRE_LAUNCH_STABLECOINS, HORIZON_UNPHASED_STABLECOINS } from "@/lib/horizon-constellation-layout";

export function HomeAltUpcomingHorizonConstellation(): React.JSX.Element | null {
  // Same census as /upcoming/: phased coins plus the opt-in Unphased cell.
  const total = HORIZON_PRE_LAUNCH_STABLECOINS.length + HORIZON_UNPHASED_STABLECOINS.length;
  if (total === 0) return null;

  return (
    <section aria-labelledby="upcoming-horizon-constellation-title" className="space-y-3 sm:space-y-4">
      <HomeSectionHeader
        titleId="upcoming-horizon-constellation-title"
        title="On the horizon"
        subtitle="Explore announced stablecoins and their varying levels of readiness."
        stat={
          <>
            <span className="pharos-numeric font-semibold text-foreground">{total}</span> Tokens
          </>
        }
        action={<HomeAltTrackerLink href="/upcoming/" ariaLabel="Open tracker" />}
      />

      <div className="pharos-card-shell overflow-hidden">
        <HorizonConstellation
          includeUnphased
          widePhaseClassName="flex flex-col items-center gap-4 px-3 py-5"
          narrowPhaseClassName="flex items-center gap-2 px-3 py-[2px] sm:gap-3 sm:px-4 sm:py-3.5"
        />
      </div>
    </section>
  );
}
