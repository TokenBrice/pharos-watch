import { ConstellationCohort } from "@/app/alt-pegs/fiat-world-atlas/constellation-cohort";
import { MoonCohort } from "@/app/alt-pegs/fiat-world-atlas/moon-cohort";
import { Starfield } from "@/app/alt-pegs/fiat-world-atlas/starfield";
import { SunCohort } from "@/app/alt-pegs/fiat-world-atlas/sun-cohort";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function SkyLayer({ cohorts }: { cohorts: readonly SkyCohort[] }) {
  const byKind = new Map(cohorts.map((c) => [c.kind, c] as const));
  const sun = byKind.get("sun");
  const moon = byKind.get("moon");
  const constellation = byKind.get("constellation");
  return (
    <div className="peg-hero__sky">
      <Starfield />
      {sun ? <SunCohort cohort={sun} /> : null}
      {moon ? <MoonCohort cohort={moon} /> : null}
      {constellation ? <ConstellationCohort cohort={constellation} /> : null}
    </div>
  );
}
