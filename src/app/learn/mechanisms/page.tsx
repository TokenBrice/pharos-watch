import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  MECHANISM_ARCHETYPE_VALUES,
  type MechanismArchetype,
} from "@shared/types";
import {
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { ExplainerPageShell } from "./explainer-page-shell";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Mechanism Explainers",
  description:
    "Five plain-English explainers covering every stablecoin mechanism Pharos tracks: fiat-backed, tokenized Treasuries, CDP, delta-neutral, and algorithmic designs.",
  canonical: "/learn/mechanisms/",
});

function countActiveByArchetype(): Record<MechanismArchetype, number> {
  const counts: Record<MechanismArchetype, number> = {
    "fiat-cash": 0,
    tbill: 0,
    cdp: 0,
    "synthetic-delta-neutral": 0,
    algorithmic: 0,
  };
  for (const coin of ACTIVE_STABLECOINS) {
    const archetype = coin.mechanismArchetype;
    if (archetype && archetype in counts) {
      counts[archetype as MechanismArchetype] += 1;
    }
  }
  return counts;
}

export default function MechanismExplainersHub() {
  const counts = countActiveByArchetype();

  return (
    <ExplainerPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/mechanisms/" },
      ]}
      breadcrumbLabel="Learn"
      title="Five ways a stablecoin holds its peg"
      subtitle="The mechanism a coin uses determines how it survives stress. These five explainers map each design — what produces the peg, where it tends to fail, and which Pharos signals are most informative when it does."
    >
      <ol className="divide-y divide-border/60">
        {MECHANISM_ARCHETYPE_VALUES.map(
          (archetype: MechanismArchetype, index: number) => {
            const count = counts[archetype];
            return (
              <li key={archetype}>
                <Link
                  href={getMechanismExplainerPath(archetype)}
                  className="pharos-focus-ring group grid gap-6 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12 lg:py-10"
                >
                  <div className="flex flex-col gap-3">
                    <div className="flex items-baseline gap-3 text-muted-foreground">
                      <span className="font-mono text-xs font-semibold tabular-nums tracking-[0.18em]">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
                        {count === 1 ? "1 tracked" : `${count} tracked`}
                      </span>
                    </div>
                    <h2 className="text-[clamp(1.75rem,2.6vw,2.5rem)] font-extrabold leading-[1.02] tracking-[-0.025em] text-foreground transition-colors group-hover:text-frost-blue">
                      {getMechanismArchetypeLabel(archetype)}
                    </h2>
                    <p className="max-w-[42ch] text-[15px] leading-relaxed text-muted-foreground">
                      {getMechanismArchetypeOneLiner(archetype)}
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
                    {mechanismDiagramFor(archetype, "USDX")}
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
