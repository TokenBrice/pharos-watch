import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types";
import {
  MECHANISM_ARCHETYPE_SHORT_LABELS,
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
import { CHART_PALETTE } from "@/lib/chart-colors";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { LearnHero } from "../_shared/learn-hero";
import { LearnPageShell } from "../_shared/learn-page-shell";
import { SectionHeading, SectionKicker } from "../_shared/section-primitives";
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
    "Learn how every stablecoin mechanism holds its peg: fiat-backed, tokenized Treasuries, CDP, delta-neutral, algorithmic, tokenized credit funds, and commodity claims.",
  canonical: "/learn/mechanisms/",
  ogImage: `${SITE_URL}/og-editorial-learn.png`,
});

// Non-frost sequence tones for the archetype segments (frost stays the
// headline beam). CHART_PALETTE[0] is frost, so start at index 1.
const MECHANISM_SEGMENT_COLORS = CHART_PALETTE.slice(1, 1 + MECHANISM_ARCHETYPE_VALUES.length);

// Restrained decomposition of the hero's One-Beam total: how the active coins
// split across the tracked designs. Reuses the flat proportional-bar idiom
// (OutcomeLedger / grade-distribution bar), not a new drawn scene.
function MechanismDistribution({ counts }: { counts: Record<MechanismArchetype, number> }) {
  const segments = MECHANISM_ARCHETYPE_VALUES.map((archetype, index) => ({
    archetype,
    count: counts[archetype],
    color: MECHANISM_SEGMENT_COLORS[index],
    label: MECHANISM_ARCHETYPE_SHORT_LABELS[archetype],
  }));
  const legend = segments.map((segment) => `${segment.count} ${segment.label}`).join(", ");
  return (
    <div className="space-y-3">
      <p className="pharos-kicker">Active coins by mechanism</p>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-border/40"
        role="img"
        aria-label={`Active coins by mechanism: ${legend}.`}
      >
        {segments.map((segment) => (
          <span
            key={segment.archetype}
            aria-hidden="true"
            style={{ flexGrow: segment.count, backgroundColor: segment.color }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.archetype} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: segment.color }}
            />
            <span className="pharos-numeric text-[13px] font-semibold text-foreground">
              {segment.count}
            </span>
            <span className="text-[11px] text-muted-foreground">{segment.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MechanismExplainersHub() {
  const counts = countActiveByArchetype();
  const preLaunchCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [a, getCoinsByLifecycleStatus(a, "pre-launch").length]),
  ) as Record<MechanismArchetype, number>;
  const frozenCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [a, getCoinsByLifecycleStatus(a, "frozen").length]),
  ) as Record<MechanismArchetype, number>;
  const mechanismTotal = MECHANISM_ARCHETYPE_VALUES.reduce((sum, a) => sum + counts[a], 0);
  const upcomingTotal = MECHANISM_ARCHETYPE_VALUES.reduce((sum, a) => sum + preLaunchCounts[a], 0);
  const frozenTotal = MECHANISM_ARCHETYPE_VALUES.reduce((sum, a) => sum + frozenCounts[a], 0);

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Mechanisms", url: "/learn/mechanisms/" },
      ]}
      title="How a stablecoin holds its peg"
      subtitle="The mechanism a coin uses determines how it survives stress. These explainers map every tracked design: what produces the peg, where it tends to fail, and which Pharos signals fire first when it does."
      titleClassName="max-w-[22ch]"
    >
      <LearnHero
        beamLabel="Active coins tracked"
        beamValue={mechanismTotal}
        subKicker={`Across ${MECHANISM_ARCHETYPE_VALUES.length} designs`}
        sub={
          <div className="space-y-1 text-[13px] sm:text-right">
            <p className="pharos-numeric text-muted-foreground">
              <span className="text-foreground">{MECHANISM_ARCHETYPE_VALUES.length}</span> mechanisms
            </p>
            {upcomingTotal > 0 ? (
              <p className="pharos-numeric text-muted-foreground">
                <span className="text-foreground">+{upcomingTotal}</span> upcoming
              </p>
            ) : null}
            {frozenTotal > 0 ? (
              <p className="pharos-numeric text-muted-foreground">
                <span className="text-foreground">+{frozenTotal}</span> frozen
              </p>
            ) : null}
          </div>
        }
        ariaLabel="Mechanism coverage"
      >
        <MechanismDistribution counts={counts} />
      </LearnHero>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(buildPublicDatasetMirrorJsonLd("peg-mechanism-distribution")),
        }}
      />
      <MechanismJsonLd />
      <section aria-labelledby="mechanism-start-here-title" className="space-y-4 border-y border-border/60 py-5">
        <div className="space-y-2">
          <SectionKicker>Start Here</SectionKicker>
          <SectionHeading id="mechanism-start-here-title">
            Collateral paths to read first
          </SectionHeading>
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
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
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
                  <h2 className="pharos-display text-2xl font-bold tracking-tight text-foreground transition-colors group-hover:text-frost-blue sm:text-3xl">
                    <span className="pharos-numeric mr-3 text-[0.5em] font-semibold tracking-[0.12em] text-muted-foreground align-baseline">
                      {indexLabel}.
                    </span>
                    {getMechanismArchetypeLabel(archetype)}
                  </h2>
                  <p className="text-[15px] leading-relaxed text-muted-foreground">
                    {getMechanismArchetypeOneLiner(archetype)}
                  </p>
                  <p className="pharos-numeric text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    {countParts.join(" · ")}
                  </p>
                  <span className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
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
