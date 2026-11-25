import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import type { MechanismArchetype } from "@shared/types/stablecoin-taxonomy";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import {
  MECHANISM_ARCHETYPE_SHORT_LABELS,
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import {
  countActiveByArchetype,
  getActiveByArchetype,
  getCoinsByLifecycleStatus,
} from "@shared/lib/stablecoins/by-mechanism";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import { isQuarantinedStablecoinMeta } from "@shared/lib/stablecoins/status";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { JsonLdScript } from "@/components/json-ld-script";
import { SeeAlsoFooter } from "@/components/see-also-footer";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { MechanismJsonLd } from "@/lib/mechanism-json-ld";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { getLogoSrc, logosById } from "@/lib/logos";
import { MECHANISM_ACCENT_VAR } from "@/lib/mechanism-matrix";
import { cn } from "@/lib/utils";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { Term } from "@/components/term";
import { LearnHero } from "../_shared/learn-hero";
import { LearnPageShell } from "../_shared/learn-page-shell";
import { SectionHeading, SectionKicker } from "../_shared/section-primitives";
import { MechanismComparisonMatrix } from "./comparison-matrix";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";

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
});

// Non-frost sequence fallback if a new archetype ships before a dedicated
// `--mechanism-*` token is registered. CHART_PALETTE[0] is frost.
const MECHANISM_SEGMENT_FALLBACK_COLORS = CHART_PALETTE.slice(1);

function pickRepresentativeActiveCoins(
  archetype: MechanismArchetype,
  limit = 3,
): StablecoinMeta[] {
  const activeCoins = getActiveByArchetype(archetype).filter(
    (coin) => !isQuarantinedStablecoinMeta(coin),
  );
  const activeById = new Map(activeCoins.map((coin) => [coin.id, coin]));
  const picked: StablecoinMeta[] = [];
  const seen = new Set<string>();

  for (const rep of ARCHETYPE_CONTENT[archetype]?.representativeCoins ?? []) {
    const meta = activeById.get(rep.coinId);
    if (!meta || seen.has(meta.id)) continue;
    picked.push(meta);
    seen.add(meta.id);
    if (picked.length >= limit) return picked;
  }

  for (const coin of activeCoins) {
    if (seen.has(coin.id)) continue;
    picked.push(coin);
    seen.add(coin.id);
    if (picked.length >= limit) break;
  }

  return picked;
}

// Restrained decomposition of the hero's One-Beam total: how the active coins
// split across the tracked designs. Reuses the flat proportional-bar idiom
// (OutcomeLedger / grade-distribution bar), not a new drawn scene.
function MechanismDistribution({ counts }: { counts: Record<MechanismArchetype, number> }) {
  const segments = MECHANISM_ARCHETYPE_VALUES.map((archetype, index) => ({
    archetype,
    count: counts[archetype],
    color:
      MECHANISM_ACCENT_VAR[archetype] ??
      MECHANISM_SEGMENT_FALLBACK_COLORS[index % MECHANISM_SEGMENT_FALLBACK_COLORS.length],
    label: MECHANISM_ARCHETYPE_SHORT_LABELS[archetype],
  }));
  const activeSegments = segments.filter((segment) => segment.count > 0);
  const legend = segments.map((segment) => `${segment.count} ${segment.label}`).join(", ");
  return (
    <div className="space-y-3">
      <p className="pharos-label">Breakdown by design</p>
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-border/40"
        role="img"
        aria-label={`Active coins by mechanism: ${legend}.`}
      >
        {activeSegments.map((segment) => (
          <span
            key={segment.archetype}
            aria-hidden="true"
            className="min-w-[3px] first:rounded-l-full last:rounded-r-full"
            style={{ flexGrow: segment.count, backgroundColor: segment.color }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.archetype} className="pharos-chart-legend-chip">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: segment.color }}
            />
            <span
              className={cn(
                "pharos-numeric font-semibold",
                segment.count > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {segment.count}
            </span>
            <span className="text-muted-foreground">{segment.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MechanismExplainersHub() {
  const counts = countActiveByArchetype();
  // Launched rows are live, not upcoming: the /upcoming/ projection excludes
  // them too, so they must not inflate this route's "+N upcoming".
  const preLaunchCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [
      a,
      getCoinsByLifecycleStatus(a, "pre-launch").filter((coin) => !isLaunchedAwaitingData(coin)).length,
    ]),
  ) as Record<MechanismArchetype, number>;
  const frozenCounts: Record<MechanismArchetype, number> = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [a, getCoinsByLifecycleStatus(a, "frozen").length]),
  ) as Record<MechanismArchetype, number>;
  const mechanismTotal = MECHANISM_ARCHETYPE_VALUES.reduce((sum, a) => sum + counts[a], 0);
  const upcomingTotal = MECHANISM_ARCHETYPE_VALUES.reduce((sum, a) => sum + preLaunchCounts[a], 0);
  const frozenTotal = MECHANISM_ARCHETYPE_VALUES.reduce((sum, a) => sum + frozenCounts[a], 0);
  // Coins with an unresolved mechanism sit in no design: name the gap to each
  // lifecycle census instead of letting the hub disagree with it silently.
  const activeAll = ACTIVE_STABLECOINS.length;
  const upcomingAll = PRE_LAUNCH_STABLECOINS.filter((coin) => !isLaunchedAwaitingData(coin)).length;
  const frozenAll = FROZEN_STABLECOINS.length;
  const unresolvedTotal = activeAll - mechanismTotal + upcomingAll - upcomingTotal + frozenAll - frozenTotal;
  const renderOfTotal = (shown: number, total: number) =>
    shown === total ? null : (
      <>
        {" of "}
        <span className="pharos-numeric">{total}</span>
      </>
    );

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Mechanisms", url: "/learn/mechanisms/" },
      ]}
      title="How a stablecoin holds its peg"
      subtitle="The mechanism a coin uses determines how it survives stress. These explainers map every tracked design: what produces the peg, where it tends to fail, and which Pharos signals fire first when it does."
    >
      <LearnHero
        beamLabel="Active coins by mechanism"
        beamValue={mechanismTotal}
        subKicker={`Across ${MECHANISM_ARCHETYPE_VALUES.length} designs`}
        sub={
          <div className="space-y-1 text-xs sm:text-right">
            <p className="text-muted-foreground">
              <span className="pharos-numeric font-medium text-foreground">{MECHANISM_ARCHETYPE_VALUES.length}</span> mechanisms
            </p>
            {mechanismTotal !== activeAll ? (
              <p className="text-muted-foreground">
                <span className="pharos-numeric font-medium text-foreground">{mechanismTotal}</span> of{" "}
                <span className="pharos-numeric">{activeAll}</span> active
              </p>
            ) : null}
            {upcomingTotal > 0 ? (
              <p className="text-muted-foreground">
                <span className="pharos-numeric font-medium text-foreground">+{upcomingTotal}</span>
                {renderOfTotal(upcomingTotal, upcomingAll)} upcoming
              </p>
            ) : null}
            {frozenTotal > 0 ? (
              <p className="text-muted-foreground">
                <span className="pharos-numeric font-medium text-foreground">+{frozenTotal}</span>
                {renderOfTotal(frozenTotal, frozenAll)} frozen
              </p>
            ) : null}
            {unresolvedTotal > 0 ? (
              <p className="text-muted-foreground">
                <span className="pharos-numeric font-medium text-foreground">{unresolvedTotal}</span> pending mechanism classification
              </p>
            ) : null}
          </div>
        }
        ariaLabel="Mechanism coverage"
      >
        <MechanismDistribution counts={counts} />
      </LearnHero>
      <JsonLdScript json={safeJsonLd(buildPublicDatasetMirrorJsonLd("peg-mechanism-distribution"))} />
      <MechanismJsonLd />
      <section aria-labelledby="mechanism-start-here-title" className="space-y-5">
        <div className="space-y-2">
          <SectionKicker>Start here</SectionKicker>
          <SectionHeading id="mechanism-start-here-title">
            Collateral paths to read first
          </SectionHeading>
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
            Three high-signal explainers for readers comparing <Term slug="rwa">off-chain collateral</Term>,{" "}
            <Term slug="nav">NAV</Term> fund gates, and <Term slug="algorithmic">reflexive peg mechanics</Term>.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURED_MECHANISM_PATHS.map((item) => {
            const activeCount = counts[item.archetype];
            return (
              <Link
                key={item.archetype}
                href={getMechanismExplainerPath(item.archetype)}
                className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col p-5"
              >
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: MECHANISM_ACCENT_VAR[item.archetype] }}
                    />
                    <span>{MECHANISM_ARCHETYPE_SHORT_LABELS[item.archetype]}</span>
                  </span>
                  <span>
                    <span className="pharos-numeric font-semibold text-foreground">{activeCount}</span>{" "}
                    active
                  </span>
                </div>
                <h3 className="mt-3 text-base font-semibold leading-snug tracking-tight text-foreground transition-colors group-hover:text-brand-accent-text">
                  {item.label}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
                <span className="mt-auto inline-flex items-center gap-1 pt-4 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                  Read the explainer
                  <ArrowUpRight
                    className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            );
          })}
        </div>
      </section>
      <MechanismComparisonMatrix />
      <section aria-labelledby="mechanism-directory-heading" className="space-y-4">
        <div className="space-y-2">
          <SectionKicker>All designs</SectionKicker>
          <SectionHeading id="mechanism-directory-heading">
            Mechanism explainers
          </SectionHeading>
        </div>
        <ol className="divide-y divide-border/60">
          {MECHANISM_ARCHETYPE_VALUES.map((archetype: MechanismArchetype, index: number) => {
            const count = counts[archetype];
            const preLaunch = preLaunchCounts[archetype];
            const frozen = frozenCounts[archetype];
            const dead = ARCHETYPE_CONTENT[archetype]?.decommissioned?.length ?? 0;
            const countEntries: Array<{ key: string; figure: string; suffix: string }> = [
              { key: "active", figure: String(count), suffix: "tracked" },
            ];
            if (preLaunch > 0) countEntries.push({ key: "upcoming", figure: `+${preLaunch}`, suffix: "upcoming" });
            if (frozen > 0) countEntries.push({ key: "frozen", figure: `+${frozen}`, suffix: "frozen" });
            if (dead > 0) countEntries.push({ key: "dead", figure: `+${dead}`, suffix: "dead" });
            const indexLabel = String(index + 1).padStart(2, "0");
            const repCoins = pickRepresentativeActiveCoins(archetype, 3);
            return (
              <li key={archetype}>
                <Link
                  href={getMechanismExplainerPath(archetype)}
                  className="pharos-focus-ring group -mx-3 grid gap-6 rounded-xl px-3 py-8 transition-colors hover:bg-muted/30 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12 lg:py-10"
                >
                  <div className="flex flex-col gap-3">
                    <h3 className="pharos-display text-2xl font-bold tracking-tight text-foreground transition-colors group-hover:text-brand-accent-text sm:text-3xl">
                      <span className="pharos-numeric mr-3 align-baseline text-sm font-semibold text-muted-foreground sm:text-base">
                        {indexLabel}.
                      </span>
                      {getMechanismArchetypeLabel(archetype)}
                    </h3>
                    <p className="max-w-[68ch] text-base leading-relaxed text-muted-foreground">
                      {getMechanismArchetypeOneLiner(archetype)}
                    </p>
                    {repCoins.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {repCoins.map((coin) => {
                          const logoSrc = getLogoSrc(logosById, coin.id);
                          return (
                            <span
                              key={coin.id}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-xs text-foreground"
                            >
                              {logoSrc ? (
                                <img
                                  src={logoSrc}
                                  alt=""
                                  aria-hidden="true"
                                  width={20}
                                  height={20}
                                  className="h-5 w-5 shrink-0 rounded-full"
                                  loading="lazy"
                                />
                              ) : null}
                              <span className="pharos-numeric font-medium">{coin.symbol}</span>
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {countEntries.map((entry, entryIndex) => (
                        <span key={entry.key}>
                          {entryIndex > 0 ? <span aria-hidden="true"> · </span> : null}
                          <span className="pharos-numeric font-medium text-foreground/85">{entry.figure}</span>{" "}
                          {entry.suffix}
                        </span>
                      ))}
                    </p>
                    <span className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                      Read the explainer
                      <ArrowUpRight
                        className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </span>
                  </div>
                  <div aria-hidden="true" className="flex items-center justify-center">
                    {mechanismDiagramFor(archetype, "STBL")}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      </section>
      <SeeAlsoFooter route="/learn/mechanisms/" />
    </LearnPageShell>
  );
}
