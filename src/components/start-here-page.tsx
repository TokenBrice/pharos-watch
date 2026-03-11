import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight, Compass, MoveRight } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  START_HERE_ATLAS,
  START_HERE_FACTS,
  START_HERE_GLOSSARY,
  START_HERE_GOALS,
  START_HERE_PATHS,
  START_HERE_SHORTCUTS,
} from "@/lib/start-here-content";

function GoalCard({
  title,
  description,
  href,
  cta,
  destinations,
  borderClass,
  spanClass,
  icon: Icon,
}: (typeof START_HERE_GOALS)[number]) {
  return (
    <Link
      href={href}
      className={`pharos-focus-ring group flex flex-col gap-3 rounded-[1.35rem] border border-[oklch(0.86_0.015_248_/_0.95)] bg-[linear-gradient(180deg,oklch(0.985_0.008_248_/_0.96),oklch(0.955_0.012_248_/_0.98))] p-4 text-left shadow-[0_12px_28px_oklch(0_0_0_/0.08)] transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[oklch(0.78_0.03_248_/_0.95)] hover:bg-[linear-gradient(180deg,oklch(0.99_0.01_248_/_0.98),oklch(0.965_0.014_248_/_1))] dark:border-white/10 dark:bg-[linear-gradient(180deg,oklch(0.18_0.02_248_/_0.9),oklch(0.14_0.015_248_/_0.98))] dark:shadow-[0_18px_36px_oklch(0_0_0_/0.18)] dark:hover:border-white/20 dark:hover:bg-[linear-gradient(180deg,oklch(0.2_0.02_248_/_0.92),oklch(0.16_0.015_248_/_0.98))] ${borderClass} ${spanClass}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker text-slate-500 dark:text-slate-300/72">Route</p>
          <h3 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">{title}</h3>
        </div>
        <span className="inline-flex rounded-full border border-black/6 bg-white/75 p-2 text-slate-500 transition-colors group-hover:text-slate-900 dark:border-white/10 dark:bg-black/18 dark:text-slate-300/74 dark:group-hover:text-white">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
      <p className="max-w-[48ch] text-sm leading-relaxed text-slate-700 dark:text-slate-300/80">{description}</p>
      <div className="flex flex-wrap gap-2">
        {destinations.map((destination) => (
          <span
            key={destination}
            className="rounded-full border border-black/7 bg-black/[0.035] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-slate-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200/74"
          >
            {destination}
          </span>
        ))}
      </div>
      <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-slate-950 dark:text-slate-50">
        {cta}
        <ArrowRight className="h-4 w-4 text-slate-500 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-950 dark:text-slate-300/76 dark:group-hover:text-slate-50" />
      </span>
    </Link>
  );
}

function HeroFactGrid({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {START_HERE_FACTS.map((fact) => (
        <div
          key={fact.label}
          className="rounded-[1.2rem] border border-black/7 bg-white/72 px-4 py-3 shadow-[0_8px_18px_oklch(0_0_0_/0.04),inset_0_1px_0_oklch(1_0_0_/0.75)] dark:border-white/10 dark:bg-white/[0.045] dark:shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]"
        >
          <p className="text-[1.65rem] font-mono font-semibold tracking-tight text-slate-950 dark:text-white">{fact.value}</p>
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-300/74">{fact.label}</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300/70">{fact.detail}</p>
        </div>
      ))}
    </div>
  );
}

function HeroSupportCluster({ className, factGridClassName }: { className?: string; factGridClassName?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild className="h-10 rounded-full bg-slate-950 px-5 text-white shadow-[0_12px_24px_oklch(0_0_0_/0.12)] hover:bg-slate-900 dark:bg-white dark:text-slate-950 dark:shadow-[0_16px_30px_oklch(0_0_0_/0.24)] dark:hover:bg-white/90">
          <Link href="/">Skip straight to the dashboard</Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="h-10 rounded-full border-black/10 bg-white/70 px-5 text-slate-900 hover:bg-white hover:text-slate-950 dark:border-white/15 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.1] dark:hover:text-white"
        >
          <Link href="/methodology/">Need the formulas instead?</Link>
        </Button>
      </div>

      <div className="rounded-[1.2rem] border border-black/7 bg-white/62 px-4 py-3 text-sm leading-relaxed text-slate-700 shadow-[inset_0_1px_0_oklch(1_0_0_/0.7)] dark:border-white/10 dark:bg-black/10 dark:text-slate-300/72 dark:shadow-none">
        <span className="font-medium text-slate-950 dark:text-white">Experienced users can skip this entirely.</span>{" "}
        Use the dashboard, search, or command palette if you already know where you want to go.
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
      leadParagraphs={[
        "Use this page as your route planner. Pick the job you came for, learn the minimum vocabulary, then jump directly into the right Pharos surface.",
      ]}
    >
      <section className="pharos-card-shell relative overflow-hidden rounded-[1.85rem] border border-black/7 bg-[linear-gradient(145deg,oklch(0.985_0.012_248_/_0.98),oklch(0.95_0.018_248_/_0.98))] px-5 py-6 shadow-[0_18px_44px_oklch(0_0_0_/0.08)] sm:px-6 sm:py-7 dark:border-white/10 dark:bg-[linear-gradient(145deg,oklch(0.2_0.03_248_/_0.94),oklch(0.15_0.02_248_/_0.98))] dark:shadow-[0_30px_70px_oklch(0_0_0_/0.22)]">
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_top,oklch(0.78_0.06_195_/_0.22),transparent_62%)] lg:block dark:bg-[radial-gradient(circle_at_top,oklch(0.57_0.08_192_/_0.18),transparent_62%)]" />
        <div className="pointer-events-none absolute left-6 top-6 h-20 w-20 rounded-full bg-sky-500/12 blur-2xl dark:bg-sky-500/10" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(25rem,1.1fr)] lg:items-start">
          <div className="space-y-5 lg:space-y-6">
            <div className="space-y-3">
              <p className="pharos-kicker text-sky-700 dark:text-sky-200/80">New to Pharos?</p>
              <div className="space-y-3">
                <h2 className="max-w-2xl text-[clamp(2rem,4vw,3.6rem)] font-extrabold leading-[0.98] tracking-[-0.03em] text-slate-950 dark:text-white">
                  Chart your route through the stablecoin market before the jargon slows you down.
                </h2>
                <p className="max-w-2xl text-sm leading-relaxed text-slate-700 dark:text-slate-200/78">
                  Pharos helps you monitor market stress, research individual stablecoins, compare risk, and set up
                  ongoing surveillance. This page shows the shortest route to value instead of asking you to decode the
                  whole product first.
                </p>
              </div>
            </div>

            <HeroSupportCluster className="hidden lg:block" factGridClassName="lg:grid-cols-2" />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="pharos-kicker text-sky-700 dark:text-sky-200/80">Choose your goal</p>
                <p className="mt-1 text-sm text-slate-700 dark:text-slate-200/72">Pick one route. You can explore the rest later.</p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-black/8 bg-white/62 px-3 py-1 text-xs text-slate-600 shadow-[inset_0_1px_0_oklch(1_0_0_/0.7)] dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200/70 dark:shadow-none">
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

        <HeroSupportCluster className="mt-6 lg:hidden" />
      </section>

      <section className="space-y-4">
        <div className="space-y-2">
          <p className="pharos-kicker">How to read Pharos</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="max-w-3xl space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">Learn the concepts before the acronyms.</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                You do not need every formula on day one. These are the terms that unlock most of the interface. For
                the technical model details, move to{" "}
                <Link href="/methodology/" className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors">
                  methodology
                </Link>
                .
              </p>
            </div>
            <Button asChild variant="outline" className="h-9 rounded-full border-border/65">
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
          <p className="pharos-kicker">Common routes</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Start with a workflow, not a feature list.</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These are the shortest guided paths through the product depending on what you are trying to decide.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {START_HERE_PATHS.map((path) => (
            <Card
              key={path.title}
              className={`rounded-[1.4rem] border border-border/65 bg-[linear-gradient(180deg,oklch(1_0_0_/_0.02),transparent)] py-0 ${path.borderClass}`}
            >
              <CardHeader className="space-y-3 pb-3 pt-4">
                <div className="space-y-1">
                  <p className="pharos-kicker">Workflow</p>
                  <CardTitle as="h3" className="text-xl tracking-tight">
                    {path.title}
                  </CardTitle>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">{path.audience}</p>
              </CardHeader>
              <CardContent className="space-y-4 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  {path.steps.map((step, index) => (
                    <div key={step} className="flex items-center gap-2">
                      <span className="rounded-full border border-border/55 bg-background/72 px-3 py-1.5 text-xs font-medium text-foreground">
                        {step}
                      </span>
                      {index < path.steps.length - 1 ? <MoveRight className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                    </div>
                  ))}
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">{path.outcome}</p>
                <Button asChild variant="outline" className="h-9 rounded-full border-border/65">
                  <Link href={path.href}>
                    {path.cta}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">Feature atlas</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Every major Pharos surface, grouped by job.</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Once you know where to start, this map helps you branch into the rest of the product without wandering.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {START_HERE_ATLAS.map((group) => (
            <Card key={group.title} className={`rounded-[1.45rem] border border-border/65 py-0 ${group.borderClass}`}>
              <CardHeader className="space-y-2 pb-3 pt-4">
                <p className="pharos-kicker">{group.title}</p>
                <CardTitle as="h3" className="text-xl tracking-tight">
                  {group.title}
                </CardTitle>
                <p className="text-sm leading-relaxed text-muted-foreground">{group.intro}</p>
              </CardHeader>
              <CardContent className="grid gap-3 pb-4">
                {group.items.map((item) => (
                  <Link
                    key={item.title}
                    href={item.href}
                    className="pharos-focus-ring pharos-interactive-card flex items-start gap-3 rounded-[1rem] border border-border/60 bg-background/50 px-4 py-3"
                  >
                    <span className="mt-0.5 inline-flex rounded-full border border-border/55 bg-background/75 p-2 text-muted-foreground">
                      <item.icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold tracking-tight text-foreground">{item.title}</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="max-w-3xl space-y-2">
          <p className="pharos-kicker">Power moves</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Once you are oriented, speed the workflow up.</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These shortcuts matter more after the first visit, but they are worth knowing early because they remove a
            lot of friction from repeat use.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {START_HERE_SHORTCUTS.map((shortcut) => (
            <Card key={shortcut.title} className={`rounded-[1.35rem] border border-border/65 py-0 ${shortcut.borderClass}`}>
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
                  <Button asChild variant="outline" className="h-9 rounded-full border-border/65">
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
