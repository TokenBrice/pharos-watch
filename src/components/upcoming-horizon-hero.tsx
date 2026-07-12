import { HorizonConstellation } from "@/components/horizon-constellation";

// Hero-scale constellation for the `/upcoming/` page hero. This variant drops
// the homepage section header and outer card because the hero shell supplies both.
export function UpcomingHorizonHero(): React.JSX.Element {
  return (
    <div className="h-full">
      <HorizonConstellation
        wideClassName="h-full"
        widePhaseClassName="flex flex-col items-center justify-center gap-4 px-3 py-6"
        narrowPhaseClassName="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3.5"
      />
    </div>
  );
}
