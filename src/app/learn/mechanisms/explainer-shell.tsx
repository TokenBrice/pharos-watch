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
      <DiagramHero archetype={content.archetype} visuals={content.visuals} />
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
        accentBorder={content.visuals.accentBorder}
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

function DiagramHero({
  archetype,
  visuals,
}: {
  archetype: MechanismArchetype;
  visuals: ArchetypeContent["visuals"];
}) {
  return (
    <section
      className={cn(
        "pharos-card-shell border-l-[3px] p-5 sm:p-6",
        visuals.accentBorder,
      )}
    >
      <p className={cn("pharos-kicker", visuals.kickerClass)}>
        Mechanism diagram
      </p>
      <div className="mt-3 flex justify-center">
        {mechanismDiagramFor(archetype, "USDX")}
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
    <section className="space-y-4">
      <p className={cn("pharos-kicker", kickerClass)}>How it works</p>
      <ol className="space-y-4">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/40 font-mono text-sm font-semibold tabular-nums text-foreground"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
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
    <section className="space-y-4">
      <p className={cn("pharos-kicker", kickerClass)}>Where the design fails</p>
      <dl className="space-y-4">
        {items.map((item, i) => (
          <div key={i} className="space-y-1">
            <dt className="text-foreground font-medium">{item.headline}</dt>
            <dd className="text-sm text-muted-foreground leading-relaxed">
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
  accentBorder,
  kickerClass,
}: {
  bullets: ArchetypeContent["whatToWatch"];
  accentBorder: string;
  kickerClass: string;
}) {
  return (
    <section className="space-y-4">
      <p className={cn("pharos-kicker", kickerClass)}>
        What to watch on Pharos
      </p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {bullets.map((bullet, i) => (
          <li
            key={i}
            className={cn(
              "pharos-card-shell border-l-[3px] px-4 py-3 text-sm leading-relaxed text-muted-foreground",
              accentBorder,
            )}
          >
            {bullet}
          </li>
        ))}
      </ul>
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
    <section className="space-y-4">
      <p className={cn("pharos-kicker", kickerClass)}>Tracked examples</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {coins.map((coin) => {
          const meta = TRACKED_META_BY_ID.get(coin.coinId);
          if (!meta) return null;
          return (
            <Link
              key={coin.coinId}
              href={buildStablecoinUrl(coin.coinId)}
              className="pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col gap-1 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-foreground">
                  {meta.name}
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  ({meta.symbol})
                </span>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {coin.note}
              </p>
            </Link>
          );
        })}
      </div>
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
    <section className="space-y-3">
      <p className={cn("pharos-kicker", kickerClass)}>Variations</p>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        {items.map((item, i) => (
          <p key={i}>
            <span className="font-semibold text-foreground">{item.title}.</span>{" "}
            {item.body}
          </p>
        ))}
      </div>
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
    <section className="space-y-3 border-t border-border/60 pt-6">
      <p className={cn("pharos-kicker", kickerClass)}>Related</p>
      <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-5">
        {links.map((link, i) => (
          <li key={i}>
            <Link
              href={link.href}
              className="pharos-focus-ring inline-flex items-center gap-1 text-sm text-frost-blue hover:underline"
            >
              {link.label}
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
