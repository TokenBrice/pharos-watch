import { HorizonConstellation } from "@/components/horizon-constellation";
import type { DriftDisplayStatus } from "@/lib/pre-launch";

// Hero-scale constellation for the `/upcoming/` page hero. This variant drops
// the homepage section header and outer card because the hero shell supplies
// both, and adds the tracker-only slippage rings and Unphased cell.
export function UpcomingHorizonHero({
  driftById,
}: {
  driftById?: ReadonlyMap<string, DriftDisplayStatus>;
}): React.JSX.Element {
  return (
    <div className="h-full">
      <HorizonConstellation
        wideClassName="h-full"
        widePhaseClassName="flex flex-col items-center justify-center gap-4 px-3 py-6"
        narrowPhaseClassName="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3.5"
        slippage
        driftById={driftById}
        includeUnphased
      />
    </div>
  );
}
