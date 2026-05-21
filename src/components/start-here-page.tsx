import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  START_HERE_ATLAS,
  START_HERE_GLOSSARY,
  START_HERE_GOALS,
  START_HERE_SCORES,
  START_HERE_SHORTCUTS,
} from "@/lib/start-here-content";

function toDomId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const GOAL_TONE_MAP = {
  amber: {
    badge:
      "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:border-amber-400/35 dark:bg-amber-400/10 dark:text-amber-100",
    chip: "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100/92",
  },
  emerald: {
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-400/10 dark:text-emerald-100",
    chip: "border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-100/92",
  },
  violet: {
    badge:
      "border-violet-500/30 bg-violet-500/10 text-violet-800 dark:border-violet-400/35 dark:bg-violet-400/10 dark:text-violet-100",
    chip: "border-violet-500/25 bg-violet-500/10 text-violet-800 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-100/92",
  },
  frost: {
    badge: "border-frost-blue/35 bg-frost-blue/10 text-sky-900 dark:text-white",
    chip: "border-frost-blue/25 bg-frost-blue/10 text-sky-900 dark:text-white/92",
  },
} as const;

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
  tone: toneName,
  icon: Icon,
}: (typeof START_HERE_GOALS)[number] & { order: number }) {
  const goalId = toDomId(title);
  const titleId = `start-goal-${goalId}-title`;
  const tone = GOAL_TONE_MAP[toneName];

  return (
    <Link
      href={href}
      aria-label={`${title} — ${cta}`}
      aria-labelledby={titleId}
      className="pharos-focus-ring group relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-[1.4rem] border border-black/8 bg-[linear-gradient(180deg,oklch(0.995_0.006_248_/_0.92),oklch(0.945_0.01_248_/_0.98))] p-4 text-left shadow-[0_8px_24px_oklch(0_0_0_/0.08)] transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-black/14 hover:shadow-[0_12px_32px_oklch(0_0_0_/0.12)] dark:border-white/10 dark:bg-[linear-gradient(180deg,oklch(0.16_0.018_248_/_0.92),oklch(0.11_0.012_248_/_0.98))] dark:shadow-[0_8px_24px_oklch(0_0_0_/0.2)] dark:hover:border-white/16 dark:hover:shadow-[0_12px_32px_oklch(0_0_0_/0.28)] sm:p-5"
    >
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <span
            className={cn(
              "inline-flex rounded-full border px-2.5 py-1 pharos-numeric text-[11px] font-semibold tracking-[0.16em]",
              tone.badge,
            )}
          >
            {String(order + 1).padStart(2, "0")}
          </span>
          <h3
            id={titleId}
            className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl sm:leading-[1.15] xl:text-lg xl:leading-snug"
          >
            {title}
          </h3>
        </div>
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-black/8 bg-black/[0.025] text-muted-foreground transition-colors group-hover:text-foreground dark:border-white/10 dark:bg-white/[0.03]">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>

      <p className="relative text-sm leading-7 text-muted-foreground">
        <span className="sm:hidden">{mobileDescription ?? description}</span>
        <span className="hidden sm:inline">{description}</span>
      </p>

      <div className="relative flex flex-wrap gap-2">
        {destinations.map((destination, index) => (
          <span
            key={destination}
            className={cn(
              "rounded-full border border-black/8 bg-black/[0.025] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]",
              index === 0 && tone.chip,
              index > 1 && "hidden sm:inline-flex",
            )}
          >
            {destination}
          </span>
        ))}
      </div>

      <span className="relative mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground">
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

      <div className="rounded-[1.2rem] border border-black/8 bg-black/[0.03] px-4 py-3 text-sm leading-relaxed text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
        <span className="font-medium text-foreground">Already fluent in stablecoins?</span> Keyboard shortcuts
        and the full feature atlas live below — or skip straight to the dashboard.
      </div>
    </div>
  );
}

function StartHeroSection() {
  return (
    <section
      aria-label="Route planner"
      className="pharos-card-shell relative overflow-hidden rounded-[2rem] border border-black/8 bg-[linear-gradient(128deg,oklch(0.975_0.01_248_/_0.98),oklch(0.93_0.018_248_/_0.99)_56%,oklch(0.95_0.024_52_/_0.98))] px-4 py-5 text-foreground shadow-[0_28px_72px_oklch(0_0_0_/0.12)] dark:border-white/8 dark:bg-[linear-gradient(128deg,oklch(0.19_0.03_248_/_0.98),oklch(0.11_0.016_248_/_0.99)_56%,oklch(0.15_0.02_40_/_0.98))] dark:shadow-[0_34px_90px_oklch(0_0_0_/0.32)] sm:px-6 sm:py-7 lg:px-7 lg:py-8"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(oklch(0_0_0_/_0.05)_1px,transparent_1px),linear-gradient(90deg,oklch(0_0_0_/_0.04)_1px,transparent_1px)] [background-size:32px_32px] opacity-[0.18] dark:bg-[linear-gradient(oklch(1_0_0_/_0.06)_1px,transparent_1px),linear-gradient(90deg,oklch(1_0_0_/_0.05)_1px,transparent_1px)]" />

      <div className="relative grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(25rem,1.05fr)] lg:gap-8 xl:grid-cols-[minmax(0,0.6fr)_minmax(32rem,1.4fr)]">
        <div className="space-y-6 lg:self-center lg:space-y-7">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <p className="pharos-kicker text-sky-700 dark:text-frost-blue/82">New to Pharos?</p>
              <div className="h-px flex-1 bg-gradient-to-r from-frost-blue/35 to-transparent" />
            </div>

            <h2 className="flex max-w-full flex-col gap-1 text-[clamp(1.85rem,5.4vw,4.7rem)] font-extrabold leading-[1.02] tracking-[-0.05em] lg:max-w-none">
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
        <div className="relative p-1 sm:p-2">
          <div className="relative space-y-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="pharos-kicker text-sky-700 dark:text-frost-blue/82">Choose your goal</p>
                <span className="rounded-full border border-black/8 bg-white/55 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
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
      </div>

      <div className="mt-6 space-y-5 border-t border-white/10 pt-5 lg:hidden">
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

        <article className="overflow-hidden rounded-[1.4rem] border border-border/65 bg-card/58 divide-y divide-border/45">
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
              className="rounded-[1.4rem] border border-border/65 bg-card/58 p-4"
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

        <div className="flex flex-col gap-px overflow-hidden rounded-[1.4rem] border border-border/65 bg-border/40 lg:flex-row">
          {START_HERE_SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.title}
              className="flex flex-1 flex-col gap-3 bg-card/80 p-4"
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
          <p className="pharos-kicker text-[oklch(0.42_0.10_60)] dark:text-[oklch(0.82_0.13_84)]">Immersive data visualization</p>
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
          className="pharos-focus-ring group grid overflow-hidden rounded-[1.4rem] border border-[color:oklch(0.55_0.11_82)] bg-[linear-gradient(135deg,oklch(0.94_0.07_88)_0%,oklch(0.88_0.13_82)_55%,oklch(0.80_0.16_78)_100%)] text-[oklch(0.18_0.04_60)] shadow-[0_12px_28px_oklch(0.20_0.04_50_/_0.18)] transition-[border-color,box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:border-[color:oklch(0.42_0.09_70)] hover:shadow-[0_18px_44px_oklch(0.20_0.04_50_/_0.28)] dark:border-[color:oklch(0.50_0.10_84)] dark:bg-[linear-gradient(135deg,oklch(0.34_0.08_62)_0%,oklch(0.26_0.06_50)_55%,oklch(0.20_0.04_42)_100%)] dark:text-[oklch(0.92_0.05_88)] md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]"
        >
          <div className="relative aspect-[16/9] w-full overflow-hidden bg-[oklch(0.18_0.02_248)] md:aspect-auto md:h-full">
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
              <p className="pharos-kicker text-[oklch(0.42_0.10_60)] dark:text-[oklch(0.82_0.13_84)]">PharosVille</p>
              <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">
                The stablecoin universe as a working harbor
              </h3>
              <p className="text-sm leading-relaxed text-[oklch(0.30_0.05_50)] dark:text-[oklch(0.85_0.05_84)]">
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
          className="h-11 rounded-full bg-foreground px-6 text-background shadow-[0_14px_30px_oklch(0_0_0_/0.14)] hover:bg-foreground/90 sm:h-10"
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
      <GlossarySection />
      <FeatureAtlasSection />
      <PowerMovesSection />
      <PharosVilleSection />
      <ClosingCta />
    </FeaturePageShell>
  );
}
