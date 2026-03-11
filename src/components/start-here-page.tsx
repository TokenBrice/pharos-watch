import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight, Compass } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  START_HERE_ATLAS,
  START_HERE_FACTS,
  START_HERE_GLOSSARY,
  START_HERE_GOALS,
  START_HERE_SHORTCUTS,
} from "@/lib/start-here-content";

function toDomId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function GoalCard({
  title,
  description,
  mobileDescription,
  href,
  cta,
  destinations,
  borderClass,
  spanClass,
  icon: Icon,
}: (typeof START_HERE_GOALS)[number]) {
  const goalId = toDomId(title);
  const titleId = `start-goal-${goalId}-title`;

  return (
    <Link
      href={href}
      aria-labelledby={titleId}
      className={cn(
        "pharos-focus-ring pharos-interactive-card group flex min-w-0 flex-col gap-3 rounded-[1.25rem] border border-border/65 border-l-[3px] bg-background/58 p-3.5 text-left shadow-sm sm:p-4",
        borderClass,
        spanClass,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="pharos-kicker">Route</p>
          <h3 id={titleId} className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
            {title}
          </h3>
        </div>
        <span className="inline-flex rounded-full border border-border/60 bg-background/75 p-2 text-muted-foreground transition-colors group-hover:text-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>

      <p className="max-w-[34ch] text-sm leading-relaxed text-muted-foreground sm:max-w-[46ch]">
        <span className="sm:hidden">{mobileDescription ?? description}</span>
        <span className="hidden sm:inline">{description}</span>
      </p>

      <div className="flex flex-wrap gap-2">
        {destinations.map((destination, index) => (
          <span
            key={destination}
            className={cn(
              "rounded-full border border-border/60 bg-background/68 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground",
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

function HeroFactGrid({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {START_HERE_FACTS.map((fact) => (
        <div key={fact.label} className="rounded-[1.15rem] border border-border/60 bg-background/55 px-4 py-3">
          <p className="text-[1.5rem] font-mono font-semibold tracking-tight text-foreground sm:text-[1.65rem]">
            {fact.value}
          </p>
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{fact.label}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{fact.detail}</p>
        </div>
      ))}
    </div>
  );
}

function HeroSupportCluster({ className, factGridClassName }: { className?: string; factGridClassName?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild className="h-11 rounded-full px-5 sm:h-10">
          <Link href="/">Skip straight to the dashboard</Link>
        </Button>
        <Button asChild variant="outline" className="h-11 rounded-full border-border/60 bg-background/65 px-5 sm:h-10">
          <Link href="/methodology/">Need the formulas instead?</Link>
        </Button>
      </div>

      <div className="rounded-[1.15rem] border border-border/60 bg-background/42 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Experienced users can skip this entirely.</span> Use the
        dashboard, search, or command palette if you already know where you want to go.
      </div>

      <HeroFactGrid className={factGridClassName} />
    </div>
  );
}

export function StartHerePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Start Here"
      path="/start/"
      title="Start Here"
      containerClassName="mx-auto max-w-6xl space-y-8"
    >
      <section className="pharos-card-shell relative overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-background/82 via-card to-muted/32 px-4 py-5 shadow-[0_18px_44px_oklch(0_0_0_/0.12)] sm:px-6 sm:py-7">
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[36%] bg-gradient-to-l from-primary/8 to-transparent lg:block" />
        <div className="pointer-events-none absolute left-5 top-5 h-20 w-20 rounded-full bg-primary/10 blur-3xl" />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(24rem,1.1fr)] lg:items-start lg:gap-6">
          <div className="space-y-5 lg:space-y-6">
            <div className="space-y-3">
              <p className="pharos-kicker text-primary/80">New to Pharos?</p>
              <div className="space-y-3">
                <h2 className="max-w-[11ch] text-[clamp(1.75rem,8vw,3.6rem)] font-extrabold leading-[0.98] tracking-[-0.03em] text-foreground sm:max-w-2xl">
                  <span className="sm:hidden">Pick the fastest route into Pharos.</span>
                  <span className="hidden sm:inline">
                    Chart your route through the stablecoin market before the jargon slows you down.
                  </span>
                </h2>
                <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  <span className="sm:hidden">
                    Start with a route, learn the core terms, then branch into monitoring, research, yield, or alerts
                    only when you need more.
                  </span>
                  <span className="hidden sm:inline">
                    Pharos helps you monitor market stress, research individual stablecoins, compare risk, and set up
                    ongoing surveillance. This page shows the shortest route to value instead of asking you to decode
                    the whole product first.
                  </span>
                </p>
              </div>
            </div>

            <HeroSupportCluster className="hidden lg:block" factGridClassName="lg:grid-cols-2" />
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="pharos-kicker text-primary/80">Choose your goal</p>
                <p className="text-sm text-muted-foreground">Pick one route. You can explore the rest later.</p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/65 px-3 py-1 text-xs text-muted-foreground">
                <Compass className="h-3.5 w-3.5" />
                Optional guide
              </span>
            </div>

            <div className="pharos-stagger-entrance grid gap-3 sm:grid-cols-2">
              {START_HERE_GOALS.map((goal, index) => (
                <div key={goal.title} style={{ "--stagger-index": index } as CSSProperties}>
                  <GoalCard {...goal} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <HeroSupportCluster className="mt-5 border-t border-border/50 pt-5 lg:hidden" />
      </section>

      <section className="space-y-4">
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

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {START_HERE_GLOSSARY.map((item) => (
            <Card key={item.term} className="rounded-[1.3rem] border-border/65 bg-card/72 py-0">
              <CardHeader className="space-y-2 pb-2 pt-4">
                <p className="pharos-kicker">Signal</p>
                <CardTitle as="h3" className="text-lg tracking-tight">
                  {item.term}
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4 text-sm leading-relaxed text-muted-foreground">{item.meaning}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4">
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
              className={cn(
                "rounded-[1.4rem] border border-border/65 border-l-[3px] bg-card/58 p-4",
                group.borderClass,
              )}
            >
              <div className="space-y-2">
                <p className="pharos-kicker">{group.title}</p>
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
                      <p className="text-sm font-semibold tracking-tight text-foreground">{item.title}</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
                    </div>
                    <ArrowRight className="mt-0.5 hidden h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground sm:block" />
                  </Link>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-4">
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

        <div className="grid gap-4 lg:grid-cols-3">
          {START_HERE_SHORTCUTS.map((shortcut) => (
            <Card
              key={shortcut.title}
              className={cn(
                "rounded-[1.35rem] border border-border/65 border-l-[3px] bg-card/72 py-0",
                shortcut.borderClass,
              )}
            >
              <CardHeader className="space-y-3 pb-2 pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="pharos-kicker">Shortcut</p>
                    <CardTitle as="h3" className="text-lg tracking-tight">
                      {shortcut.title}
                    </CardTitle>
                  </div>
                  <span className="inline-flex rounded-full border border-border/55 bg-background/75 p-2 text-muted-foreground">
                    <shortcut.icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                </div>
              </CardHeader>

              <CardContent className="space-y-3 pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">{shortcut.description}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">{shortcut.detail}</p>
                {shortcut.href && shortcut.cta ? (
                  <Button asChild variant="outline" className="h-11 rounded-full border-border/65 sm:h-9">
                    <Link href={shortcut.href}>
                      {shortcut.cta}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                ) : (
                  <div className="rounded-full border border-border/60 bg-background/70 px-3 py-2 text-xs font-medium uppercase tracking-[0.11em] text-muted-foreground">
                    Works from any page
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </FeaturePageShell>
  );
}
