import type { Metadata } from "next";
import Link from "next/link";
import {
  MECHANISM_ARCHETYPE_VALUES,
  type MechanismArchetype,
} from "@shared/types";
import {
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { ARCHETYPE_VISUALS } from "./content/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Mechanism Explainers",
  description:
    "Five plain-English explainers covering every stablecoin mechanism Pharos tracks: fiat-backed, tokenized Treasuries, CDP, delta-neutral, and algorithmic designs.",
  canonical: "/learn/mechanisms/",
});

export default function MechanismExplainersHub() {
  return (
    <FeaturePageShell
      breadcrumbName="Learn"
      breadcrumbLabel="Learn"
      path="/learn/mechanisms/"
      title="Stablecoin Mechanism Explainers"
      variant="longform"
      containerClassName="mx-auto w-full max-w-[68rem] space-y-8"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/mechanisms/" },
      ]}
      leadParagraphs={[
        "Five mechanism archetypes account for every stablecoin Pharos tracks. Each explainer walks through how the design produces its peg, where it tends to fail, and which tracked coins implement it.",
      ]}
    >
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {MECHANISM_ARCHETYPE_VALUES.map((archetype: MechanismArchetype) => {
          const visuals = ARCHETYPE_VISUALS[archetype];
          return (
            <li key={archetype}>
              <Link
                href={getMechanismExplainerPath(archetype)}
                className={cn(
                  "pharos-card-shell pharos-focus-ring pharos-interactive-card group flex h-full flex-col gap-3 border-l-[3px] p-4",
                  visuals.accentBorder,
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-foreground">
                    {getMechanismArchetypeLabel(archetype)}
                  </span>
                  <span
                    className={cn("pharos-kicker", visuals.kickerClass)}
                    aria-hidden="true"
                  >
                    Mechanism
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {getMechanismArchetypeOneLiner(archetype)}
                </p>
                <div className="-mx-2 mt-auto flex justify-center pt-2">
                  {mechanismDiagramFor(archetype, "USDX")}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </FeaturePageShell>
  );
}
