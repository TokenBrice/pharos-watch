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
import { countActiveByArchetype, getCoinsByLifecycleStatus } from "@shared/lib/stablecoins/by-mechanism";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { MechanismJsonLd } from "@/lib/mechanism-json-ld";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { LearnPageShell } from "../_shared/learn-page-shell";
import { MechanismComparisonMatrix } from "./comparison-matrix";
import { ARCHETYPE_CONTENT } from "./content";

const FEATURED_MECHANISM_PATHS: ReadonlyArray<{
  archetype: MechanismArchetype;
  label: string;
  description: string;
}> = [
  {
    archetype: "rwa-credit-fund",
    label: "RWA credit fund stablecoins",
    description:
      "Start here for credit-fund collateral, NAV marks, redemption gates, and why off-chain loan books fail differently from T-bills.",
  },
  {
    archetype: "tbill",
    label: "Tokenized Treasury stablecoins",
    description:
      "Compare the cleaner short-duration Treasury model before reading credit-fund designs with longer asset and gate risk.",
  },
  {
    archetype: "algorithmic",
    label: "Algorithmic stablecoins",
    description:
      "Use the reflexive failure model as the contrast case for undercollateralized designs and collapse-style case studies.",
  },
];

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Mechanism Explainers",
  description:
    "Learn six stablecoin mechanism designs: fiat-backed, tokenized Treasuries, CDP, delta-neutral, algorithmic, and tokenized credit funds.",
  canonical: "/learn/mechanisms/",
  ogImage: `${SITE_URL}/og-editorial-learn.png`,
});

export default function MechanismExplainersHub() {
  const counts = countActiveByArchetype();
  const preLaunchCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [a, getCoinsByLifecycleStatus(a, "pre-launch").length]),
  ) as Record<MechanismArchetype, number>;
  const frozenCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [a, getCoinsByLifecycleStatus(a, "frozen").length]),
  ) as Record<MechanismArchetype, number>;

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Mechanisms", url: "/learn/mechanisms/" },
      ]}
      visibleBreadcrumbs={[
        { label: "Dashboard", href: "/" },
        { label: "Learn" },
        { label: "Mechanisms" },
      ]}
      title="Six ways a stablecoin holds its peg"
      subtitle="The mechanism a coin uses determines how it survives stress. These six explainers map each design — what produces the peg, where it tends to fail, and which Pharos signals fire first when it does."
      titleClassName="max-w-[22ch]"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(buildPublicDatasetMirrorJsonLd("peg-mechanism-distribution")),
        }}
      />
      <MechanismJsonLd />
      <section aria-labelledby="mechanism-start-here-title" className="space-y-4 border-y border-border/60 py-5">
        <div className="space-y-2">
          <p className="pharos-kicker">Start Here</p>
          <h2 id="mechanism-start-here-title" className="text-xl font-semibold text-foreground">
            Collateral paths to read first
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Three high-signal explainers for readers comparing off-chain collateral, fund gates, and reflexive peg
            mechanics.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURED_MECHANISM_PATHS.map((item) => (
            <Link
              key={item.archetype}
              href={getMechanismExplainerPath(item.archetype)}
              className="pharos-focus-ring group block border-t border-border/60 pt-4 md:border-t-0 md:pt-0"
            >
              <p className="text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                {item.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-frost-blue opacity-80 transition-opacity group-hover:opacity-100">
                Read the explainer
                <ArrowUpRight
                  className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <MechanismComparisonMatrix />
      <ol className="divide-y divide-border/60">
        {MECHANISM_ARCHETYPE_VALUES.map((archetype: MechanismArchetype, index: number) => {
          const count = counts[archetype];
          const preLaunch = preLaunchCounts[archetype];
          const frozen = frozenCounts[archetype];
          const dead = ARCHETYPE_CONTENT[archetype]?.decommissioned?.length ?? 0;
          const countParts: string[] = [count === 1 ? "1 tracked" : `${count} tracked`];
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
                <div className="flex items-center justify-center">{mechanismDiagramFor(archetype, "STBL")}</div>
              </Link>
            </li>
          );
        })}
      </ol>
    </LearnPageShell>
  );
}
