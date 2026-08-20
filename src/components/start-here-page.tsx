import type { CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { slugifyId } from "@shared/lib/format";
import {
  START_HERE_ATLAS,
  START_HERE_GLOSSARY,
  START_HERE_GOALS,
  START_HERE_SCORES,
  START_HERE_SHORTCUTS,
} from "@/lib/start-here-content";
import { WALKTHROUGH_APPEARANCES } from "@/lib/media-appearances";

/** Index boundary: glossary items before this index are foundational terms (larger type). */
const GLOSSARY_FOUNDATION_COUNT = 2;

function GoalCard({
  order,
  title,
  description,
  mobileDescription,
  href,
  cta,
  destinations,
  icon: Icon,
}: (typeof START_HERE_GOALS)[number] & { order: number }) {
  const goalId = slugifyId(title);
  const titleId = `start-goal-${goalId}-title`;

  return (
    <Link
      href={href}
      aria-label={`${title} — ${cta}`}
      aria-labelledby={titleId}
      className="pharos-focus-ring pharos-interactive-card pharos-card-shell group flex min-w-0 flex-col gap-2.5 p-4 text-left sm:p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <span className="inline-flex rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 pharos-numeric text-[11px] font-semibold tracking-[0.16em] text-muted-foreground">
            {String(order + 1).padStart(2, "0")}
          </span>
          <h3
            id={titleId}
            className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl sm:leading-[1.15] xl:text-lg xl:leading-snug"
          >
            {title}
          </h3>
        </div>
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/40 text-muted-foreground transition-colors group-hover:text-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>

      <p className="text-sm leading-7 text-muted-foreground">
        <span className="sm:hidden">{mobileDescription ?? description}</span>
        <span className="hidden sm:inline">{description}</span>
      </p>

      <div className="flex flex-wrap gap-2">
        {destinations.map((destination, index) => (
          <span
            key={destination}
            className={cn(
              "rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
              index > 1 && "hidden sm:inline-flex",
            )}
          >
            {destination}
          </span>
        ))}
      </div>

      <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
        {cta}
        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </span>
    </Link>
  );
}

function HeroEscapeHatch({ className, desktop = false }: { className?: string; desktop?: boolean }) {
  return (
    <div className={cn("space-y-3", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-2 text-sm",
          desktop && "lg:flex-col lg:items-start lg:gap-2",
        )}
      >
        <Link
          href="/"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground"
        >
          Skip straight to the dashboard
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href="/methodology/"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Need the formulas instead?
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="rounded-xl border border-black/8 bg-black/[0.03] px-4 py-3 text-sm leading-relaxed text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
        <span className="font-medium text-foreground">Already fluent in stablecoins?</span> Keyboard shortcuts
        and the full feature atlas live below — or skip straight to the dashboard.
      </div>
    </div>
  );
}

function StartHeroSection() {
  return (
    <section aria-label="Route planner" className="text-foreground">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(25rem,1.05fr)] lg:gap-8 xl:grid-cols-[minmax(0,0.6fr)_minmax(32rem,1.4fr)]">
        <div className="space-y-6 lg:self-center lg:space-y-7">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker">New to Pharos?</p>
              <div className="h-px flex-1 bg-border" />
            </div>

            <h2 className="pharos-page-title flex max-w-full flex-col gap-1 lg:max-w-none">
              <span className="block text-muted-foreground/80">Most trackers show price.</span>
              <span className="block text-foreground">Pharos shows risk.</span>
            </h2>
            <p className="max-w-xl text-base leading-8 text-muted-foreground lg:max-w-[44ch]">
              <span className="sm:hidden">
                Live risk surveillance across{" "}
                <span className="pharos-numeric text-foreground">{ACTIVE_STABLECOIN_COUNT}</span> stablecoins — peg
                stability, on-chain liquidity, dependency exposure, and issuer behavior, scored every{" "}
                <span className="pharos-numeric text-foreground">30 min</span> from DefiLlama, CoinGecko, and direct
                on-chain reads.
              </span>
              <span className="hidden sm:inline">
                Live risk surveillance across{" "}
                <span className="pharos-numeric text-foreground">{ACTIVE_STABLECOIN_COUNT}</span> stablecoins — peg
                stability, on-chain liquidity, dependency exposure, and issuer behavior, scored every{" "}
                <span className="pharos-numeric text-foreground">30 min</span> from DefiLlama, CoinGecko, and direct
                on-chain reads. Built by{" "}
                <Link
                  href="/about/"
                  className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-foreground"
                >
                  TokenBrice and a small team
                </Link>
                .
              </span>
            </p>

            {/* Trust strip — single mono line, no pill chrome */}
            <div className="space-y-1.5">
              <p
                aria-label="Pharos posture"
                className="font-mono tabular-nums text-[11px] uppercase leading-relaxed tracking-[0.18em] text-muted-foreground"
              >
                Free · Independent · Donation-funded · No fees · No ads
              </p>
              <Link
                href="/funding/"
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-sm text-foreground underline underline-offset-4 hover:text-foreground"
              >
                See the ledger
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </div>

          <div className="hidden lg:block">
            <HeroEscapeHatch desktop />
          </div>
        </div>

        {/* Goal cards */}
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="pharos-kicker">Choose your goal</p>
              <span className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {START_HERE_GOALS.length} routes
              </span>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              Pick one route. The rest can stay peripheral until you need them.
            </p>
          </div>

          <div className="pharos-stagger-entrance grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {START_HERE_GOALS.map((goal, index) => (
              <div
                key={goal.title}
                style={{ "--stagger-index": index } as CSSProperties}
              >
                <GoalCard {...goal} order={index} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-5 border-t border-border/60 pt-5 lg:hidden">
        <HeroEscapeHatch />
      </div>
    </section>
  );
}

function ScoresSection() {
  return (
    <section aria-labelledby="start-scores-title" className="mt-6 space-y-4 md:mt-8">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">How Pharos scores risk</p>
          <h2 id="start-scores-title" className="text-2xl font-semibold tracking-tight text-foreground">
            Five proprietary scores, one transparent methodology.
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Each score names its inputs and refresh cadence. Full formulas, weights, and thresholds live on{" "}
            <Link
              href="/methodology/"
              className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-foreground"
            >
              the methodology page
            </Link>
            .
          </p>
        </div>

        <article className="overflow-hidden rounded-xl border border-border/65 bg-card/58 divide-y divide-border/45">
          {START_HERE_SCORES.map((score, index) => (
            <div
              key={score.name}
              className="grid gap-x-5 gap-y-3 p-4 sm:p-5 lg:grid-cols-[3rem_minmax(0,1fr)_minmax(0,14rem)] lg:items-start"
            >
              {/* Order number — mono, hairline */}
              <p
                aria-hidden="true"
                className="pharos-numeric text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/85 lg:pt-1"
              >
                {String(index + 1).padStart(2, "0")}
              </p>

              {/* Score body */}
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono tabular-nums text-sm font-semibold uppercase tracking-[0.16em] text-foreground">
                    {score.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{score.fullName}</span>
                </div>
                <p className="text-base font-medium tracking-tight text-foreground">{score.question}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">{score.inputs}</p>
                <p className="font-mono tabular-nums text-xs leading-relaxed text-muted-foreground/85">{score.cadence}</p>
              </div>

              {/* Links — one arrow on primary, none on secondary */}
              <div className="flex flex-row flex-wrap gap-x-5 gap-y-1.5 text-sm lg:flex-col lg:items-end lg:gap-y-2 lg:text-right">
                <Link
                  href={score.methodologyHref}
                  className="pharos-focus-ring group/score-link inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-4"
                >
                  How it&rsquo;s computed
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover/score-link:translate-x-0.5" />
                </Link>
                <Link
                  href={score.surfacedHref}
                  className="pharos-focus-ring rounded-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  {score.surfacedOn}
                </Link>
              </div>
            </div>
          ))}
        </article>

        <p className="text-xs leading-relaxed text-muted-foreground/85">
          Sources: <span className="font-mono tabular-nums text-muted-foreground">DefiLlama, CoinGecko, Etherscan, TronGrid</span>,
          protocol-native APIs, and direct on-chain reads via the Pharos Worker. Full source list and pipeline diagram
          on{" "}
          <Link
            href="/about/"
            className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-foreground"
          >
            the about page
          </Link>
          .
        </p>
      </section>
  );
}

function WalkthroughSection() {
  return (
    <section aria-labelledby="start-walkthrough-title" className="mt-12 space-y-4 md:mt-16">
      <div className="max-w-3xl space-y-2">
        <p className="pharos-kicker">Prefer to watch</p>
        <h2 id="start-walkthrough-title" className="text-2xl font-semibold tracking-tight text-foreground">
          Watch someone drive Pharos end to end.
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Neither is a quick tour. Both are full sessions with someone using the dashboard live, hosted elsewhere and
          recorded without a script.
        </p>
      </div>

      <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-border/65 bg-border/40 lg:flex-row">
        {WALKTHROUGH_APPEARANCES.map((appearance) => (
          <a
            key={appearance.href}
            href={appearance.href}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring group flex min-w-0 flex-1 items-start gap-3 bg-background p-4 transition-colors hover:bg-muted/30"
          >
            <Image
              src={appearance.hostLogoSrc}
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 shrink-0 rounded-lg border border-border/60 bg-background/50"
            />
            <span className="min-w-0 space-y-1">
              <span className="flex items-start gap-1 text-sm font-semibold text-foreground">
                {appearance.title}
                <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              </span>
              <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {appearance.host}
                {appearance.durationMinutes ? ` · ${appearance.durationMinutes} min` : ""}
              </span>
              <span className="block text-sm leading-relaxed text-muted-foreground">{appearance.description}</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

function GlossarySection() {
  return (
    <section className="mt-12 space-y-3 md:mt-16">
        <div className="space-y-2">
          <p className="pharos-kicker">How to read Pharos</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="max-w-3xl space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                Learn the concepts before the acronyms.
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                You do not need every formula on day one. These are the terms that unlock most of the interface. For the
                technical model details, move to{" "}
                <Link
                  href="/methodology/"
                  className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-foreground"
                >
                  methodology
                </Link>
                .
              </p>
            </div>
            <Button asChild variant="outline" className="h-11 rounded-full border-border/65 sm:h-9">
              <Link href="/methodology/">
                Open methodology
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>

        <dl className="grid gap-x-6 gap-y-4 pt-2 md:grid-cols-2 xl:grid-cols-3">
          {START_HERE_GLOSSARY.map((item, index) => (
            <div key={item.term}>
              <dt
                className={cn(
                  "font-semibold tracking-tight text-foreground",
                  index < GLOSSARY_FOUNDATION_COUNT ? "text-base" : "text-sm",
                )}
              >
                {item.term}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>
  );
}

function FeatureAtlasSection() {
  return (
    <section className="mt-10 space-y-4 md:mt-14">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">Feature atlas</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Explore the rest of Pharos by job.</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Once you know where to start, this map helps you branch into the rest of the product without wandering.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {START_HERE_ATLAS.map((group) => (
            <article
              key={group.title}
              className="rounded-xl border border-border/65 bg-card/58 p-4"
            >
              <div className="space-y-2">
                <p className="pharos-kicker">{group.kickerLabel}</p>
                <h3 className="text-xl font-semibold tracking-tight text-foreground">{group.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{group.intro}</p>
              </div>

              <div className="mt-4 divide-y divide-border/50">
                {group.items.map((item) => (
                  <Link
                    key={item.title}
                    href={item.href}
                    className="pharos-focus-ring group flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="mt-0.5 inline-flex rounded-full border border-border/55 bg-background/75 p-2 text-muted-foreground transition-colors group-hover:text-foreground">
                      <item.icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold tracking-tight text-foreground transition-colors group-hover:underline group-hover:underline-offset-4">
                        {item.title}
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
  );
}

function PowerMovesSection() {
  return (
    <section className="mt-12 space-y-4 md:mt-16">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">Power moves</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Once you are oriented, speed the workflow up.
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These shortcuts matter more after the first visit, but they are worth learning early because they remove a
            lot of friction from repeat use.
          </p>
        </div>

        <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-border/65 bg-border/40 lg:flex-row">
          {START_HERE_SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.title}
              className="flex flex-1 flex-col gap-3 bg-background/70 p-4"
            >
              <div className="space-y-1">
                <p className="pharos-kicker">{shortcut.kickerLabel}</p>
                <p className="text-base font-semibold tracking-tight text-foreground">{shortcut.title}</p>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{shortcut.description}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{shortcut.detail}</p>
              {shortcut.href && shortcut.cta ? (
                <Button asChild variant="outline" className="mt-auto h-9 w-fit rounded-full border-border/65">
                  <Link href={shortcut.href}>
                    {shortcut.cta}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              ) : (
                <p className="mt-auto text-xs font-medium uppercase tracking-[0.11em] text-muted-foreground">
                  Works from any page
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
  );
}

function PharosVilleSection() {
  return (
    <section aria-labelledby="start-pharosville-title" className="mt-12 space-y-4 md:mt-16">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">Immersive data visualization</p>
          <h2 id="start-pharosville-title" className="text-2xl font-semibold tracking-tight text-foreground">
            See it visually on PharosVille.
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A second window onto the same data. Every tracked coin sails as a ship and the five DEWS bands become
            anchorages, breakwaters, and warning shoals — the classification you read in tables, drawn as a place.
            Best on desktop.
          </p>
        </div>

        <a
          href="https://pharosville.pharos.watch/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Explore PharosVille (opens in new tab)"
          className="pharos-focus-ring pharos-interactive-card pharos-card-shell group grid overflow-hidden text-foreground md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]"
        >
          <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted md:aspect-auto md:h-full">
            <img
              src="/pharosville-teaser.webp"
              alt="PharosVille pixel-art harbor with stablecoins as ships in DEWS zones"
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
            />
          </div>
          <div className="flex flex-col justify-between gap-4 p-5 sm:p-6">
            <div className="space-y-3">
              <p className="pharos-kicker">PharosVille</p>
              <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">
                The stablecoin universe as a working harbor
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Calm Anchorage, Ledger Mooring, Watch Breakwater, Alert Channel, Warning Shoals — the same DEWS bands
                you read in tables, drawn as a place. Pulls from the same risk feeds; no extra data.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
              Explore PharosVille
              <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
          </div>
        </a>
      </section>
  );
}

function ClosingCta() {
  return (
    <div className="mt-10 flex flex-col items-center gap-3 pt-2 pb-4 sm:flex-row sm:flex-wrap sm:justify-center md:mt-14">
        <Button
          asChild
          className="h-11 rounded-full bg-foreground px-6 text-background hover:bg-foreground/90 sm:h-10"
        >
          <Link href="/">Open the dashboard</Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="h-11 rounded-full border-border/65 px-6 sm:h-10"
        >
          <Link href="/methodology/">Read the methodology</Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          or{" "}
          <Link
            href="/stablecoins/usd/"
            className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-foreground"
          >
            browse the directory
          </Link>
        </p>
      </div>
  );
}

export function StartHerePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Start Here"
      path="/start/"
      title="Start Here"
      containerClassName="mx-auto max-w-6xl"
    >
      <StartHeroSection />
      <ScoresSection />
      <WalkthroughSection />
      <GlossarySection />
      <FeatureAtlasSection />
      <PowerMovesSection />
      <PharosVilleSection />
      <ClosingCta />
    </FeaturePageShell>
  );
}
