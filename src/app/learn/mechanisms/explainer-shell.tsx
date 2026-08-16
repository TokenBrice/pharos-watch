import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  getActiveByArchetype,
  getCoinsByLifecycleStatus,
  nestVariants,
} from "@shared/lib/stablecoins/by-mechanism";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { CASE_STUDY_LIST } from "@/app/learn/case-studies/content";
import {
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/lib/case-study-outcomes";
import { RelatedCoinsList } from "../_shared/related-coins-list";
import {
  CrossLinksFooter,
  NumberedListSection,
  SectionHeading,
  SectionKicker,
} from "../_shared/section-primitives";
import type { ArchetypeContent, ArchetypeDecommissioned } from "./content";

const DEAD_LOGO_BY_ID = new Map(
  DEAD_STABLECOINS.map((d) => [
    d.id,
    d.logo ? `/logos/cemetery/${d.logo}` : null,
  ]),
);

export function ArchetypeExplainerBody({
  content,
}: {
  content: ArchetypeContent;
}) {
  return (
    <>
      <DiagramHero archetype={content.archetype} />
      <HowItWorks
        steps={content.howItWorks}
        kickerClass={content.visuals.kickerClass}
      />
      <RepresentativeCoins
        coins={content.representativeCoins}
        kickerClass={content.visuals.kickerClass}
      />
      {content.decommissioned && content.decommissioned.length > 0 ? (
        <Decommissioned
          items={content.decommissioned}
          kickerClass={content.visuals.kickerClass}
        />
      ) : null}
      <RiskProfile
        items={content.riskProfile}
        kickerClass={content.visuals.kickerClass}
      />
      <Variations
        items={content.variations}
        kickerClass={content.visuals.kickerClass}
      />
      <WhatToWatch
        bullets={content.whatToWatch}
        kickerClass={content.visuals.kickerClass}
      />
      <TrackedCoinList
        archetype={content.archetype}
        kickerClass={content.visuals.kickerClass}
      />
      <MechanismCaseStudies
        archetype={content.archetype}
        kickerClass={content.visuals.kickerClass}
      />
      <CrossLinksFooter
        links={content.crossLinks}
        kickerClass={content.visuals.kickerClass}
      />
    </>
  );
}

function DiagramHero({ archetype }: { archetype: MechanismArchetype }) {
  return (
    <section
      aria-label="Mechanism diagram"
      className="-mx-2 flex justify-center py-2 sm:-mx-4 sm:py-4"
    >
      <div className="w-full max-w-3xl">
        {mechanismDiagramFor(archetype, "STBL")}
      </div>
    </section>
  );
}

function HowItWorks({
  steps,
  kickerClass,
}: {
  steps: ArchetypeContent["howItWorks"];
  kickerClass: string;
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>How it works</SectionKicker>
        <SectionHeading>The flow, step by step</SectionHeading>
      </div>
      <ol className="space-y-7 border-l border-border/40 pl-6 sm:pl-8">
        {steps.map((step, i) => (
          <li key={step.title} className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[1.875rem] top-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-background font-mono text-[11px] font-semibold tabular-nums text-muted-foreground sm:-left-[2.375rem] sm:h-7 sm:w-7 sm:text-xs"
            >
              {i + 1}
            </span>
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
                {step.title}
              </h3>
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                {step.body}
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
  kickerClass,
}: {
  items: ArchetypeContent["riskProfile"];
  kickerClass: string;
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>
          Where the design fails
        </SectionKicker>
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
            <dd className="text-[15px] leading-relaxed text-muted-foreground">
              {item.body}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function WhatToWatch({
  bullets,
  kickerClass,
}: {
  bullets: ArchetypeContent["whatToWatch"];
  kickerClass: string;
}) {
  return (
    <NumberedListSection
      items={bullets}
      kicker="What to watch on Pharos"
      heading="Signals that matter most"
      kickerClass={kickerClass}
    />
  );
}

function RepresentativeCoins({
  coins,
  kickerClass,
}: {
  coins: ArchetypeContent["representativeCoins"];
  kickerClass: string;
}) {
  return (
    <RelatedCoinsList
      coins={coins}
      kickerClass={kickerClass}
      kicker="Tracked examples"
      heading="Live coins using this design"
    />
  );
}

function Variations({
  items,
  kickerClass,
}: {
  items: ArchetypeContent["variations"];
  kickerClass: string;
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>Variations</SectionKicker>
        <SectionHeading>Sub-flavors within the archetype</SectionHeading>
      </div>
      <dl className="space-y-5">
        {items.map((item) => (
          <div
            key={item.title}
            className="grid gap-2 sm:grid-cols-[minmax(0,22ch)_minmax(0,1fr)] sm:gap-8"
          >
            <dt className="text-base font-semibold tracking-tight text-foreground">
              {item.title}
            </dt>
            <dd className="text-[15px] leading-relaxed text-muted-foreground">
              {item.body}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Decommissioned({
  items,
  kickerClass,
}: {
  items: ArchetypeDecommissioned;
  kickerClass: string;
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>Decommissioned</SectionKicker>
        <SectionHeading>Designs that broke and stayed broken</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {items.map((item) => {
          const logoSrc = item.coinId ? DEAD_LOGO_BY_ID.get(item.coinId) : null;
          return (
            <li
              key={`${item.name}-${item.date}`}
              className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14ch)_minmax(0,8ch)_minmax(0,1fr)] sm:gap-8 sm:py-5"
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
              <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
                {item.date}
              </span>
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                {item.obituary}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="pt-2 text-[15px] text-muted-foreground">
        Full obituaries, peak market caps, and post-mortems in the{" "}
        <Link
          href="/cemetery/"
          className="pharos-focus-ring font-medium text-foreground underline-offset-4 hover:text-frost-blue hover:underline"
        >
          stablecoin cemetery
        </Link>
        .
      </p>
    </section>
  );
}

function TrackedCoinRow({
  coin,
  indented = false,
}: {
  coin: StablecoinMeta;
  indented?: boolean;
}) {
  return (
    <li>
      <Link
        href={buildStablecoinUrl(coin.id)}
        className={cn(
          "pharos-focus-ring group grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14ch)_minmax(0,1fr)_auto] sm:items-baseline sm:gap-6",
          indented && "sm:pl-6",
        )}
      >
        <div className="flex items-baseline gap-2">
          {indented ? (
            <span
              aria-hidden="true"
              className="font-mono text-xs text-muted-foreground"
            >
              ↳
            </span>
          ) : null}
          <span className="font-mono text-sm font-semibold uppercase tracking-[0.04em] text-foreground transition-colors group-hover:text-frost-blue">
            {coin.symbol}
          </span>
        </div>
        <span className="text-sm text-muted-foreground">{coin.name}</span>
        <ArrowUpRight
          className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue sm:block"
          aria-hidden="true"
        />
      </Link>
    </li>
  );
}

function TrackedCoinList({
  archetype,
  kickerClass,
}: {
  archetype: MechanismArchetype;
  kickerClass: string;
}) {
  // No build-time supply map for the explainer pages; canonical registry order
  // is roughly supply-descending and matches what the screener defaults to
  // before the runtime supply query lands.
  const coins = getActiveByArchetype(archetype);
  const preLaunchCount = getCoinsByLifecycleStatus(archetype, "pre-launch")
    .length;
  const frozenCount = getCoinsByLifecycleStatus(archetype, "frozen").length;
  const { parents, childrenByParentId } = nestVariants(coins);
  const trackedCoinCount = coins.length;
  const screenerHref = `/screener/?mechanisms=${archetype}`;

  if (parents.length === 0 && preLaunchCount === 0 && frozenCount === 0) {
    return null;
  }

  const lifecycleFooterParts: Array<{ key: string; node: React.ReactNode }> = [];
  if (preLaunchCount > 0) {
    lifecycleFooterParts.push({
      key: "pre-launch",
      node: (
        <Link
          href={`/screener/?mechanisms=${archetype}&lifecycle=pre-launch`}
          className="pharos-focus-ring underline-offset-4 hover:text-frost-blue hover:underline"
        >
          +{preLaunchCount} upcoming
        </Link>
      ),
    });
  }
  if (frozenCount > 0) {
    lifecycleFooterParts.push({
      key: "frozen",
      node: (
        <Link
          href={`/screener/?mechanisms=${archetype}&lifecycle=frozen`}
          className="pharos-focus-ring underline-offset-4 hover:text-frost-blue hover:underline"
        >
          +{frozenCount} frozen
        </Link>
      ),
    });
  }

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>Tracked universe</SectionKicker>
        <SectionHeading>
          {trackedCoinCount === 1
            ? "1 tracked stablecoin in this archetype"
            : `${trackedCoinCount} tracked stablecoins in this archetype`}
        </SectionHeading>
      </div>
      {parents.length > 0 ? (
        <ul className="divide-y divide-border/40">
          {parents.map((parent) => {
            const children = childrenByParentId[parent.id] ?? [];
            return (
              <li key={parent.id}>
                <ul className="divide-y divide-border/40">
                  <TrackedCoinRow coin={parent} />
                  {children.map((child) => (
                    <TrackedCoinRow key={child.id} coin={child} indented />
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="space-y-1.5 pt-2 text-[15px]">
        <p>
          <Link
            href={screenerHref}
            className="pharos-focus-ring inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            See all in the screener
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </p>
        {lifecycleFooterParts.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {lifecycleFooterParts.map((part, i) => (
              <span key={part.key}>
                {i > 0 ? <span aria-hidden="true"> · </span> : null}
                {part.node}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function MechanismCaseStudies({
  archetype,
  kickerClass,
}: {
  archetype: MechanismArchetype;
  kickerClass: string;
}) {
  // Auto-generated from the case-study registry: every study tagged with this
  // archetype, in canonical list order. Server-rendered, so the full registry
  // never reaches a client bundle.
  const studies = CASE_STUDY_LIST.filter((study) => study.archetype === archetype);
  if (studies.length === 0) {
    return null;
  }

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>Case studies</SectionKicker>
        <SectionHeading>When this mechanism met a stress test</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {studies.map((study) => (
          <li key={study.slug}>
            <Link
              href={`/learn/case-studies/${study.slug}/`}
              className="pharos-focus-ring group grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
            >
              <div className="space-y-1">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  {study.eyebrow}
                </p>
                <h3 className="text-base font-semibold tracking-tight text-foreground transition-colors group-hover:text-frost-blue sm:text-lg">
                  {study.title}
                </h3>
              </div>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center self-start rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] sm:self-baseline",
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
