import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types";
import {
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import {
  countActiveByArchetype,
  getCoinsByLifecycleStatus,
} from "@shared/lib/stablecoins/by-mechanism";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { MechanismJsonLd } from "@/lib/mechanism-json-ld";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { MechanismComparisonMatrix } from "./comparison-matrix";
import { ARCHETYPE_CONTENT } from "./content";
import { ExplainerPageShell } from "./explainer-page-shell";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Mechanism Explainers",
  description:
    "Six plain-English explainers covering every stablecoin mechanism Pharos tracks: fiat-backed, tokenized Treasuries, CDP, delta-neutral, algorithmic, and tokenized credit fund designs.",
  canonical: "/learn/mechanisms/",
  ogImage: `${SITE_URL}/og-editorial-learn.png`,
});

export default function MechanismExplainersHub() {
  const counts = countActiveByArchetype();
  const preLaunchCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [
      a,
      getCoinsByLifecycleStatus(a, "pre-launch").length,
    ]),
  ) as Record<MechanismArchetype, number>;
  const frozenCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [
      a,
      getCoinsByLifecycleStatus(a, "frozen").length,
    ]),
  ) as Record<MechanismArchetype, number>;

  return (
    <ExplainerPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/" },
        { name: "Mechanisms", url: "/learn/mechanisms/" },
      ]}
      breadcrumbLabel="Mechanisms"
      title="Six ways a stablecoin holds its peg"
      subtitle="The mechanism a coin uses determines how it survives stress. These six explainers map each design — what produces the peg, where it tends to fail, and which Pharos signals fire first when it does."
    >
      <MechanismJsonLd />
      <MechanismComparisonMatrix />
      <ol className="divide-y divide-border/60">
        {MECHANISM_ARCHETYPE_VALUES.map(
          (archetype: MechanismArchetype, index: number) => {
            const count = counts[archetype];
            const preLaunch = preLaunchCounts[archetype];
            const frozen = frozenCounts[archetype];
            const dead = ARCHETYPE_CONTENT[archetype]?.decommissioned?.length ?? 0;
            const countParts: string[] = [
              count === 1 ? "1 tracked" : `${count} tracked`,
            ];
            if (preLaunch > 0) countParts.push(`+${preLaunch} upcoming`);
            if (frozen > 0) countParts.push(`+${frozen} frozen`);
            if (dead > 0) countParts.push(`+${dead} dead`);
            const indexLabel = String(index + 1).padStart(2, "0");
            return (
              <li key={archetype}>
                <Link
                  href={getMechanismExplainerPath(archetype)}
                  className="pharos-focus-ring group grid gap-6 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12 lg:py-10"
                >
                  <div className="flex flex-col gap-3">
                    <h2 className="text-[clamp(1.75rem,2.6vw,2.5rem)] font-extrabold leading-[1.02] tracking-[-0.025em] text-foreground transition-colors group-hover:text-frost-blue">
                      <span className="mr-3 font-mono text-[0.5em] font-semibold tabular-nums tracking-[0.12em] text-muted-foreground align-baseline">
                        {indexLabel}.
                      </span>
                      {getMechanismArchetypeLabel(archetype)}
                    </h2>
                    <p className="text-[15px] leading-relaxed text-muted-foreground">
                      {getMechanismArchetypeOneLiner(archetype)}
                    </p>
                    <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      {countParts.join(" · ")}
                    </p>
                    <span className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-frost-blue opacity-80 transition-opacity group-hover:opacity-100">
                      Read the explainer
                      <ArrowUpRight
                        className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </span>
                  </div>
                  <div className="flex items-center justify-center">
                    {mechanismDiagramFor(archetype, "STBL")}
                  </div>
                </Link>
              </li>
            );
          },
        )}
      </ol>
    </ExplainerPageShell>
  );
}
