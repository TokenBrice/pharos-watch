import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import {
  getActiveByArchetype,
  getCoinsByLifecycleStatus,
  nestVariants,
} from "@shared/lib/stablecoins/by-mechanism";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isQuarantinedStablecoinMeta } from "@shared/lib/stablecoins/status";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import {
  MECHANISM_ARCHETYPE_VALUES,
  type MechanismArchetype,
} from "@shared/types/stablecoin-taxonomy";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { CaseStudy } from "@shared/types/editorial-content";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import {
  CASE_STUDY_OUTCOME_CHIP_BASE,
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/lib/case-study-outcomes";
import { getLogoSrc, logosById } from "@/lib/logos";
import { MECHANISM_ACCENT_VAR, MECHANISM_MATRIX } from "@/lib/mechanism-matrix";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import { cn } from "@/lib/utils";
import { RelatedCoinsList } from "../_shared/related-coins-list";
import {
  CrossLinksFooter,
  NumberedListSection,
  SectionHeading,
  SectionKicker,
} from "../_shared/section-primitives";
import type { ArchetypeContent, ArchetypeDecommissioned } from "@/lib/mechanism-explainers";
import type { GlossarySlug } from "@/lib/glossary";
import { MechanismDependencyValue } from "./comparison-matrix";
import { renderMechanismProse, stripEngineVersionPrefixes } from "./explainer-prose";

const DEAD_LOGO_BY_ID = new Map(
  DEAD_STABLECOINS.map((d) => [
    d.id,
    d.logo ? `/logos/cemetery/${d.logo}` : null,
  ]),
);

const TRACKED_COINS_INITIAL_PARENT_LIMIT = 18;

export function ArchetypeExplainerBody({
  content,
}: {
  content: ArchetypeContent;
}) {
  const { archetype } = content;
  // Quarantined coins leave the listing immediately; frozen examples remain.
  const representativeCoins = content.representativeCoins.filter((coin) => {
    const meta = TRACKED_META_BY_ID.get(coin.coinId);
    return !meta || !isQuarantinedStablecoinMeta(meta);
  });
  const trackedCoins = getActiveByArchetype(archetype);
  // Launched rows are live, not upcoming: the /upcoming/ projection excludes
  // them too, so they must not inflate this section's "+N upcoming".
  const preLaunchCount = getCoinsByLifecycleStatus(archetype, "pre-launch")
    .filter((coin) => !isLaunchedAwaitingData(coin)).length;
  const frozenCount = getCoinsByLifecycleStatus(archetype, "frozen").length;
  const { parents, childrenByParentId } = nestVariants(trackedCoins);
  const hasTrackedUniverse = parents.length > 0 || preLaunchCount > 0 || frozenCount > 0;
  const hasDecommissioned = Boolean(content.decommissioned && content.decommissioned.length > 0);
  // Auto-generated from the case-study registry: every study tagged with this
  // archetype, in canonical list order. Server-rendered, so the full registry
  // never reaches a client bundle.
  const studies = CASE_STUDY_LIST.filter((study) => study.archetype === archetype);

  const sections: Array<{ id: string; label: string }> = [
    { id: "how-it-works", label: "How it works" },
    ...(representativeCoins.length > 0 ? [{ id: "examples", label: "Examples" }] : []),
    ...(hasDecommissioned ? [{ id: "decommissioned", label: "Decommissioned" }] : []),
    ...(content.riskProfile.length > 0 ? [{ id: "risk-profile", label: "Failure modes" }] : []),
    ...(content.variations.length > 0 ? [{ id: "variations", label: "Variations" }] : []),
    ...(content.whatToWatch.length > 0 ? [{ id: "what-to-watch", label: "What to watch" }] : []),
    ...(hasTrackedUniverse ? [{ id: "tracked-coins", label: "Tracked universe" }] : []),
    ...(studies.length > 0 ? [{ id: "case-studies", label: "Case studies" }] : []),
  ];

  return (
    <>
      <ArchetypeFactStrip archetype={archetype} activeCount={trackedCoins.length} />
      <LongformScrollspyNav
        sections={sections}
        navAriaLabel="Mechanism explainer sections"
        emphasis="pill-tabs"
        edgeFade
      />
      <DiagramHero archetype={archetype} />
      <HowItWorks archetype={archetype} steps={content.howItWorks} />
      <RelatedCoinsList
        coins={representativeCoins}
        kicker="Tracked examples"
        heading="Tracked coins using this design"
        id="examples"
      />
      {hasDecommissioned && content.decommissioned ? (
        <Decommissioned items={content.decommissioned} />
      ) : null}
      <RiskProfile items={content.riskProfile} />
      <Variations items={content.variations} />
      <WhatToWatch bullets={content.whatToWatch} />
      {hasTrackedUniverse ? (
        <TrackedCoinList
          archetype={archetype}
          trackedCoinCount={trackedCoins.length}
          parents={parents}
          childrenByParentId={childrenByParentId}
          preLaunchCount={preLaunchCount}
          frozenCount={frozenCount}
        />
      ) : null}
      {studies.length > 0 ? <MechanismCaseStudies studies={studies} /> : null}
      <PrevNextArchetypePager archetype={archetype} />
      <CrossLinksFooter
        links={content.crossLinks.map((link) => ({
          ...link,
          label: stripEngineVersionPrefixes(link.label),
        }))}
      />
    </>
  );
}

function ArchetypeFactStrip({
  archetype,
  activeCount,
}: {
  archetype: MechanismArchetype;
  activeCount: number;
}) {
  const row = MECHANISM_MATRIX[archetype];
  const screenerHref = `/screener/?mechanisms=${archetype}&lifecycle=active`;

  return (
    <section aria-label="Mechanism summary" className="pharos-card-shell p-5 sm:p-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <dt className="pharos-label">Collateral</dt>
          <dd className="text-sm font-medium leading-snug text-foreground">
            {row.collateralLocation}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="pharos-label">Redemption</dt>
          <dd className="text-sm font-medium leading-snug text-foreground">
            {row.redemptionRight}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="pharos-label">Primary failure mode</dt>
          <dd className="text-sm font-medium leading-snug text-foreground">
            {row.primaryFailureMode}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="pharos-label">Tracked active</dt>
          <dd className="space-y-1 text-sm text-foreground">
            <p className="font-medium leading-snug">
              <span className="pharos-numeric font-semibold">{activeCount}</span>{" "}
              {activeCount === 1 ? "active coin" : "active coins"}
            </p>
            <Link
              href={screenerHref}
              className="pharos-prose-link inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              <span>Filter in screener</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            </Link>
          </dd>
        </div>
      </dl>
      <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/50 pt-4 text-xs">
        <div className="inline-flex items-center gap-2">
          <dt className="pharos-label">Governance</dt>
          <dd>
            <MechanismDependencyValue value={row.governanceDep} />
          </dd>
        </div>
        <div className="inline-flex items-center gap-2">
          <dt className="pharos-label">Oracle</dt>
          <dd>
            <MechanismDependencyValue value={row.oracleDep} />
          </dd>
        </div>
        <div className="inline-flex items-center gap-2">
          <dt className="pharos-label">Jurisdiction</dt>
          <dd>
            <MechanismDependencyValue value={row.jurisdictionDep} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function DiagramHero({ archetype }: { archetype: MechanismArchetype }) {
  return (
    <section
      aria-label="Mechanism diagram"
      className="pharos-card-shell flex justify-center p-5 sm:p-6"
    >
      <div className="flex w-full max-w-2xl flex-col items-center">
        {mechanismDiagramFor(archetype, "STBL")}
        {archetype === "algorithmic" ? (
          <p className="mt-3 max-w-[68ch] text-center text-sm text-muted-foreground">
            Diagram: historical UST-style pure mint/burn, not the collateralized variants below.
          </p>
        ) : archetype === "tbill" ? (
          <p className="mt-3 max-w-[68ch] text-center text-sm text-muted-foreground">
            Diagram: the NAV-accreting variant. Par-stable $1 tokens distribute or retain yield separately.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function HowItWorks({
  archetype,
  steps,
}: {
  archetype: MechanismArchetype;
  steps: ArchetypeContent["howItWorks"];
}) {
  const seenSlugs = new Set<GlossarySlug>();
  const accentColor = MECHANISM_ACCENT_VAR[archetype];
  return (
    <section id="how-it-works" className="scroll-mt-36 space-y-6">
      <div className="space-y-2">
        <SectionKicker>How it works</SectionKicker>
        <SectionHeading>The flow, step by step</SectionHeading>
      </div>
      <ol className="ml-3.5 space-y-7 border-l border-border/50 pl-6 sm:ml-4 sm:pl-8">
        {steps.map((step, i) => (
          <li key={step.title} className="relative">
            <span
              aria-hidden="true"
              className="pharos-numeric absolute -left-[2.375rem] top-0 inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold sm:-left-[2.875rem]"
              style={{
                color: `color-mix(in oklab, ${accentColor} 50%, var(--foreground))`,
                borderColor: `color-mix(in oklab, ${accentColor} 45%, transparent)`,
                backgroundColor: `color-mix(in oklab, ${accentColor} 12%, var(--background))`,
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
                {step.title}
              </h3>
              <p className="max-w-[68ch] text-base leading-relaxed text-foreground/90">
                {renderMechanismProse(step.body, seenSlugs)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RiskProfile({
  items,
}: {
  items: ArchetypeContent["riskProfile"];
}) {
  const seenSlugs = new Set<GlossarySlug>();
  return (
    <section id="risk-profile" className="scroll-mt-36 space-y-6">
      <div className="space-y-2">
        <SectionKicker>Where the design fails</SectionKicker>
        <SectionHeading>Known failure modes</SectionHeading>
      </div>
      <dl className="divide-y divide-border/40">
        {items.map((item) => (
          <div
            key={item.headline}
            className="grid gap-2 py-5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,18ch)_minmax(0,1fr)] sm:gap-8"
          >
            <dt className="text-base font-semibold tracking-tight text-foreground">
              {item.headline}
            </dt>
            <dd className="max-w-[68ch] text-base leading-relaxed text-foreground/90">
              {renderMechanismProse(item.body, seenSlugs)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function WhatToWatch({
  bullets,
}: {
  bullets: ArchetypeContent["whatToWatch"];
}) {
  const seenSlugs = new Set<GlossarySlug>();
  return (
    <NumberedListSection
      id="what-to-watch"
      items={bullets.map((bullet) => renderMechanismProse(bullet, seenSlugs))}
      kicker="What to watch on Pharos"
      heading="Signals that matter most"
      framed
    />
  );
}

function Variations({
  items,
}: {
  items: ArchetypeContent["variations"];
}) {
  const seenSlugs = new Set<GlossarySlug>();
  return (
    <section id="variations" className="scroll-mt-36 space-y-6">
      <div className="space-y-2">
        <SectionKicker>Variations</SectionKicker>
        <SectionHeading>Sub-flavors within the archetype</SectionHeading>
      </div>
      <dl className="divide-y divide-border/40">
        {items.map((item) => (
          <div
            key={item.title}
            className="grid gap-2 py-5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,22ch)_minmax(0,1fr)] sm:gap-8"
          >
            <dt className="text-base font-semibold tracking-tight text-foreground">
              {item.title}
            </dt>
            <dd className="max-w-[68ch] text-base leading-relaxed text-foreground/90">
              {renderMechanismProse(item.body, seenSlugs)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Decommissioned({
  items,
}: {
  items: ArchetypeDecommissioned;
}) {
  return (
    <section id="decommissioned" className="scroll-mt-36 space-y-6">
      <div className="space-y-2">
        <SectionKicker>Decommissioned</SectionKicker>
        <SectionHeading>Designs that broke and stayed broken</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {items.map((item) => {
          const logoSrc = item.coinId ? DEAD_LOGO_BY_ID.get(item.coinId) : null;
          return (
            <li
              key={`${item.name}-${item.date}`}
              className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14ch)_minmax(0,8ch)_minmax(0,1fr)] sm:items-baseline sm:gap-8 sm:py-5"
            >
              <span className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-foreground">
                {logoSrc ? (
                  <img
                    src={logoSrc}
                    alt=""
                    aria-hidden="true"
                    width={20}
                    height={20}
                    className="h-5 w-5 shrink-0 rounded-full opacity-70 grayscale"
                    loading="lazy"
                  />
                ) : null}
                <span className="min-w-0 leading-tight">{item.name}</span>
              </span>
              <span className="pharos-numeric text-xs text-muted-foreground">
                {item.date}
              </span>
              <p className="max-w-[68ch] text-base leading-relaxed text-foreground/90">
                {item.obituary}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="max-w-[68ch] pt-2 text-base text-muted-foreground">
        Full obituaries, peak market caps, and post-mortems in the{" "}
        <Link
          href="/cemetery/"
          className="pharos-prose-link font-medium text-foreground"
        >
          stablecoin cemetery
        </Link>
        .
      </p>
    </section>
  );
}

function TrackedCoinCard({
  coin,
  variants,
}: {
  coin: StablecoinMeta;
  variants: readonly StablecoinMeta[];
}) {
  const logoSrc = getLogoSrc(logosById, coin.id);
  return (
    <li className="pharos-inset flex flex-col justify-between gap-2.5 p-3">
      <Link
        href={buildStablecoinUrl(coin.id)}
        className="pharos-focus-ring group flex items-center gap-2.5 rounded-md"
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
        <span className="min-w-0 flex-1">
          <span className="pharos-numeric block truncate text-sm font-semibold text-foreground transition-colors group-hover:text-brand-accent-text">
            {coin.symbol}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {coin.name}
          </span>
        </span>
        <ArrowUpRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand-accent-text"
          aria-hidden="true"
        />
      </Link>
      {variants.length > 0 ? (
        <ul
          aria-label={`${coin.symbol} variants`}
          className="flex flex-wrap gap-1.5 border-t border-border/40 pt-2"
        >
          {variants.map((variant) => (
            <li key={variant.id}>
              <Link
                href={buildStablecoinUrl(variant.id)}
                title={variant.name}
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/55 hover:text-foreground"
              >
                <span aria-hidden="true">↳</span>
                <span className="pharos-numeric">{variant.symbol}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TrackedCoinList({
  archetype,
  trackedCoinCount,
  parents,
  childrenByParentId,
  preLaunchCount,
  frozenCount,
}: {
  archetype: MechanismArchetype;
  trackedCoinCount: number;
  parents: readonly StablecoinMeta[];
  childrenByParentId: Record<string, StablecoinMeta[]>;
  preLaunchCount: number;
  frozenCount: number;
}) {
  const screenerHref = `/screener/?mechanisms=${archetype}&lifecycle=active`;
  const visibleParents = parents.slice(0, TRACKED_COINS_INITIAL_PARENT_LIMIT);
  const hiddenParents = parents.slice(TRACKED_COINS_INITIAL_PARENT_LIMIT);
  const hiddenCoinCount = hiddenParents.reduce(
    (sum, parent) => sum + 1 + (childrenByParentId[parent.id]?.length ?? 0),
    0,
  );

  const lifecycleHeaderParts: Array<{ key: string; node: React.ReactNode }> = [];
  if (preLaunchCount > 0) {
    lifecycleHeaderParts.push({
      key: "pre-launch",
      node: (
        <Link
          href={`/screener/?mechanisms=${archetype}&lifecycle=pre-launch`}
          className="pharos-prose-link text-muted-foreground"
        >
          <span className="pharos-numeric font-medium text-foreground">+{preLaunchCount}</span>{" "}
          upcoming
        </Link>
      ),
    });
  }
  if (frozenCount > 0) {
    lifecycleHeaderParts.push({
      key: "frozen",
      node: (
        <Link
          href={`/screener/?mechanisms=${archetype}&lifecycle=frozen`}
          className="pharos-prose-link text-muted-foreground"
        >
          <span className="pharos-numeric font-medium text-foreground">+{frozenCount}</span>{" "}
          frozen
        </Link>
      ),
    });
  }

  return (
    <section id="tracked-coins" className="scroll-mt-36 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <SectionKicker>Tracked universe</SectionKicker>
          <SectionHeading>
            {trackedCoinCount === 1
              ? "1 tracked stablecoin in this archetype"
              : `${trackedCoinCount} tracked stablecoins in this archetype`}
          </SectionHeading>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:justify-end">
          {lifecycleHeaderParts.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {lifecycleHeaderParts.map((part, i) => (
                <span key={part.key}>
                  {i > 0 ? <span aria-hidden="true"> · </span> : null}
                  {part.node}
                </span>
              ))}
            </p>
          ) : null}
          <Link
            href={screenerHref}
            className="pharos-control-pill pharos-focus-ring gap-1.5 text-foreground"
          >
            <span>See all in the screener</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {visibleParents.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {visibleParents.map((parent) => (
            <TrackedCoinCard
              key={parent.id}
              coin={parent}
              variants={childrenByParentId[parent.id] ?? []}
            />
          ))}
        </ul>
      ) : null}

      {hiddenParents.length > 0 ? (
        <DisclosurePanel
          variant="inset"
          summary={
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span>
                Show{" "}
                <span className="pharos-numeric font-semibold">{hiddenCoinCount}</span>{" "}
                more tracked {hiddenCoinCount === 1 ? "stablecoin" : "stablecoins"}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                (<span className="pharos-numeric">{trackedCoinCount}</span> total)
              </span>
            </span>
          }
        >
          <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {hiddenParents.map((parent) => (
              <TrackedCoinCard
                key={parent.id}
                coin={parent}
                variants={childrenByParentId[parent.id] ?? []}
              />
            ))}
          </ul>
        </DisclosurePanel>
      ) : null}
    </section>
  );
}

function MechanismCaseStudies({
  studies,
}: {
  studies: readonly CaseStudy[];
}) {
  return (
    <section id="case-studies" className="scroll-mt-36 space-y-6">
      <div className="space-y-2">
        <SectionKicker>Case studies</SectionKicker>
        <SectionHeading>When this mechanism met a stress test</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {studies.map((study) => (
          <li key={study.slug}>
            <Link
              href={`/learn/case-studies/${study.slug}/`}
              className="pharos-focus-ring group -mx-3 grid gap-2 rounded-lg px-3 py-4 transition-colors hover:bg-muted/35 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
            >
              <div className="space-y-1">
                <p className="pharos-label">{study.eyebrow}</p>
                <h3 className="text-base font-semibold tracking-tight text-foreground transition-colors group-hover:text-brand-accent-text sm:text-lg">
                  {study.title}
                </h3>
              </div>
              <span
                className={cn(
                  CASE_STUDY_OUTCOME_CHIP_BASE,
                  "shrink-0 items-center self-start sm:self-baseline",
                  CASE_STUDY_OUTCOME_CHIPS[study.outcome],
                )}
              >
                {CASE_STUDY_OUTCOME_LABELS[study.outcome]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrevNextArchetypePager({
  archetype,
}: {
  archetype: MechanismArchetype;
}) {
  const index = MECHANISM_ARCHETYPE_VALUES.indexOf(archetype);
  const count = MECHANISM_ARCHETYPE_VALUES.length;
  if (index === -1 || count < 2) return null;
  const prev = MECHANISM_ARCHETYPE_VALUES[(index - 1 + count) % count];
  const next = MECHANISM_ARCHETYPE_VALUES[(index + 1) % count];

  return (
    <nav
      aria-label="Mechanism explainer pager"
      className="grid gap-3 sm:grid-cols-2"
    >
      <Link
        href={getMechanismExplainerPath(prev)}
        className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col gap-1 px-5 py-4"
      >
        <span className="pharos-label inline-flex items-center gap-1.5">
          <ArrowLeft
            className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5"
            aria-hidden="true"
          />
          Previous mechanism
        </span>
        <span className="text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
          {getMechanismArchetypeLabel(prev)}
        </span>
      </Link>
      <Link
        href={getMechanismExplainerPath(next)}
        className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex flex-col gap-1 px-5 py-4 sm:items-end sm:text-right"
      >
        <span className="pharos-label inline-flex items-center gap-1.5">
          Next mechanism
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
        <span className="text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
          {getMechanismArchetypeLabel(next)}
        </span>
      </Link>
    </nav>
  );
}
