import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import type { ArchetypeContent } from "./content";

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
      <RiskProfile
        items={content.riskProfile}
        kickerClass={content.visuals.kickerClass}
      />
      <WhatToWatch
        bullets={content.whatToWatch}
        kickerClass={content.visuals.kickerClass}
      />
      <RepresentativeCoins
        coins={content.representativeCoins}
        kickerClass={content.visuals.kickerClass}
      />
      <Variations
        items={content.variations}
        kickerClass={content.visuals.kickerClass}
      />
      <CrossLinksFooter
        links={content.crossLinks}
        kickerClass={content.visuals.kickerClass}
      />
    </>
  );
}

function SectionKicker({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}) {
  return <p className={cn("pharos-kicker", className)}>{children}</p>;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.75rem]">
      {children}
    </h2>
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
          <li key={i} className="relative">
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
        {items.map((item, i) => (
          <div
            key={i}
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
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>
          What to watch on Pharos
        </SectionKicker>
        <SectionHeading>Signals that matter most</SectionHeading>
      </div>
      <ol className="divide-y divide-border/40">
        {bullets.map((bullet, i) => (
          <li
            key={i}
            className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[3rem_minmax(0,1fr)] sm:gap-6"
          >
            <span className="font-mono text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <p className="text-[15px] leading-relaxed text-foreground">
              {bullet}
            </p>
          </li>
        ))}
      </ol>
    </section>
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
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>Tracked examples</SectionKicker>
        <SectionHeading>Live coins using this design</SectionHeading>
      </div>
      <ul className="divide-y divide-border/40">
        {coins.map((coin) => {
          const meta = TRACKED_META_BY_ID.get(coin.coinId);
          if (!meta) return null;
          return (
            <li key={coin.coinId}>
              <Link
                href={buildStablecoinUrl(coin.coinId)}
                className="pharos-focus-ring group grid gap-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,16ch)_minmax(0,1fr)_auto] sm:items-baseline sm:gap-8"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold uppercase tracking-[0.04em] text-foreground transition-colors group-hover:text-frost-blue">
                    {meta.symbol}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {meta.name}
                  </span>
                </div>
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                  {coin.note}
                </p>
                <ArrowUpRight
                  className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue sm:block"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
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
        {items.map((item, i) => (
          <div
            key={i}
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

function CrossLinksFooter({
  links,
  kickerClass,
}: {
  links: ArchetypeContent["crossLinks"];
  kickerClass: string;
}) {
  return (
    <section className="space-y-5 border-t border-border/60 pt-10">
      <SectionKicker className={kickerClass}>Continue reading</SectionKicker>
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link, i) => (
          <li key={i}>
            <Link
              href={link.href}
              className="pharos-focus-ring group flex items-start justify-between gap-3 border-b border-border/40 py-3 text-[15px] leading-snug text-foreground transition-colors hover:border-frost-blue/60 hover:text-frost-blue"
            >
              <span>{link.label}</span>
              <ArrowUpRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
