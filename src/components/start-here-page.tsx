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

const HERO_GOAL_OFFSETS = [
  "lg:-translate-x-3",
  "lg:translate-x-3 lg:translate-y-5",
  "lg:-translate-x-5 lg:-translate-y-3",
  "lg:translate-x-2 lg:translate-y-6",
  "lg:-translate-y-4",
] as const;

function resolveGoalTone(borderClass: string) {
  if (borderClass.includes("amber")) {
    return {
      badge: "border-amber-400/35 bg-amber-400/10 text-amber-100",
      kicker: "text-amber-200/88",
      chip: "border-amber-400/25 bg-amber-400/10 text-amber-100/92",
      glow: "bg-amber-400/12",
      line: "via-amber-300/80",
    };
  }

  if (borderClass.includes("emerald")) {
    return {
      badge: "border-emerald-400/35 bg-emerald-400/10 text-emerald-100",
      kicker: "text-emerald-200/84",
      chip: "border-emerald-400/25 bg-emerald-400/10 text-emerald-100/92",
      glow: "bg-emerald-400/12",
      line: "via-emerald-300/80",
    };
  }

  if (borderClass.includes("violet")) {
    return {
      badge: "border-violet-400/35 bg-violet-400/10 text-violet-100",
      kicker: "text-violet-200/84",
      chip: "border-violet-400/25 bg-violet-400/10 text-violet-100/92",
      glow: "bg-violet-400/14",
      line: "via-violet-300/80",
    };
  }

  return {
    badge: "border-frost-blue/35 bg-frost-blue/10 text-white",
    kicker: "text-frost-blue/88",
    chip: "border-frost-blue/25 bg-frost-blue/10 text-white/92",
    glow: "bg-frost-blue/14",
    line: "via-frost-blue/80",
  };
}

function GoalCard({
  order,
  title,
  description,
  mobileDescription,
  href,
  cta,
  destinations,
  borderClass,
  spanClass,
  icon: Icon,
}: (typeof START_HERE_GOALS)[number] & { order: number }) {
  const goalId = toDomId(title);
  const titleId = `start-goal-${goalId}-title`;
  const tone = resolveGoalTone(borderClass);

  return (
    <Link
      href={href}
      aria-labelledby={titleId}
      className={cn(
        "pharos-focus-ring group relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-[1.4rem] border border-white/10 bg-[linear-gradient(180deg,oklch(0.16_0.018_248_/_0.92),oklch(0.11_0.012_248_/_0.98))] p-4 text-left shadow-[0_22px_40px_oklch(0_0_0_/0.22)] transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-1 hover:border-white/16 hover:shadow-[0_28px_56px_oklch(0_0_0_/0.3)] sm:p-5",
        spanClass,
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent to-transparent",
          tone.line,
        )}
      />
      <div className={cn("pointer-events-none absolute -right-6 top-8 h-24 w-24 rounded-full blur-3xl", tone.glow)} />

      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.16em]",
                tone.badge,
              )}
            >
              {String(order + 1).padStart(2, "0")}
            </span>
            <p className={cn("text-[10px] font-semibold uppercase tracking-[0.18em]", tone.kicker)}>Route</p>
          </div>
          <h3
            id={titleId}
            className="max-w-[12ch] text-[1.35rem] font-semibold tracking-tight text-white sm:text-[1.5rem] sm:leading-[1.15]"
          >
            {title}
          </h3>
        </div>
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/72 transition-colors group-hover:text-white">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>

      <p className="relative max-w-[32ch] text-[0.95rem] leading-7 text-white/70 sm:max-w-[36ch]">
        <span className="sm:hidden">{mobileDescription ?? description}</span>
        <span className="hidden sm:inline">{description}</span>
      </p>

      <div className="relative flex flex-wrap gap-2">
        {destinations.map((destination, index) => (
          <span
            key={destination}
            className={cn(
              "rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/54",
              index === 0 && tone.chip,
              index > 1 && "hidden sm:inline-flex",
            )}
          >
            {destination}
          </span>
        ))}
      </div>

      <span className="relative mt-auto inline-flex items-center gap-1 text-sm font-medium text-white">
        {cta}
        <ArrowRight className="h-4 w-4 text-white/60 transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
      </span>
    </Link>
  );
}

function HeroFactGrid({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {START_HERE_FACTS.map((fact, index) => (
        <div
          key={fact.label}
          className={cn(
            "group relative overflow-hidden rounded-[1.2rem] border border-white/10 bg-[linear-gradient(180deg,oklch(0.15_0.016_248_/_0.92),oklch(0.11_0.012_248_/_0.98))] px-4 py-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.04)]",
            index % 2 === 0 ? "lg:-translate-y-2" : "lg:translate-y-3",
          )}
        >
          <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent" />
          <p className="text-[1.6rem] font-mono font-semibold tracking-tight text-white sm:text-[1.8rem]">
            {fact.value}
          </p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">{fact.label}</p>
          <p className="mt-2 text-sm leading-relaxed text-white/66">{fact.detail}</p>
        </div>
      ))}
    </div>
  );
}

function HeroSupportCluster({ className, factGridClassName }: { className?: string; factGridClassName?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          asChild
          className="h-11 rounded-full bg-white px-5 text-slate-950 shadow-[0_14px_30px_oklch(0_0_0_/0.24)] hover:bg-white/92 sm:h-10"
        >
          <Link href="/">Skip straight to the dashboard</Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="h-11 rounded-full border-white/10 bg-white/[0.03] px-5 text-white hover:bg-white/[0.08] hover:text-white sm:h-10"
        >
          <Link href="/methodology/">Need the formulas instead?</Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)]">
        <div className="rounded-[1.2rem] border border-white/10 bg-black/20 px-4 py-3">
          <p className="pharos-kicker text-frost-blue/78">Signal brief</p>
          <p className="mt-2 text-sm font-medium leading-relaxed text-white">
            Monitor first. Research second. Move only when the signal is clear.
          </p>
        </div>
        <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-relaxed text-white/70">
          <span className="font-medium text-white">Experienced users can skip this entirely.</span> Everyone else gets
          the shortest path into Pharos before touching the full product map.
        </div>
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
      <section className="pharos-card-shell relative overflow-hidden rounded-[2rem] border border-white/8 bg-[linear-gradient(128deg,oklch(0.19_0.03_248_/_0.98),oklch(0.11_0.016_248_/_0.99)_56%,oklch(0.15_0.02_40_/_0.98))] px-4 py-5 text-white shadow-[0_34px_90px_oklch(0_0_0_/0.32)] sm:px-6 sm:py-7 lg:px-7 lg:py-8">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(oklch(1_0_0_/_0.06)_1px,transparent_1px),linear-gradient(90deg,oklch(1_0_0_/_0.05)_1px,transparent_1px)] [background-size:32px_32px] opacity-[0.18]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,oklch(0.72_0.14_248_/_0.18),transparent_32%),radial-gradient(circle_at_bottom_right,oklch(0.77_0.16_70_/_0.12),transparent_28%)]" />
        <div className="pointer-events-none absolute inset-y-0 left-[48.75%] hidden w-px bg-gradient-to-b from-transparent via-white/12 to-transparent lg:block" />
        <div className="pointer-events-none absolute -left-12 top-8 h-40 w-40 rounded-full bg-frost-blue/16 blur-[110px]" />

        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,0.88fr)_minmax(25rem,1fr)] lg:items-start lg:gap-8">
          <div className="space-y-6 lg:space-y-7">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <p className="pharos-kicker text-frost-blue/82">New to Pharos?</p>
                <div className="h-px flex-1 bg-gradient-to-r from-frost-blue/35 to-transparent" />
                <p className="hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-white/38 lg:block">
                  Route deck / active surveillance
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(11rem,0.72fr)] lg:items-end">
                <div className="space-y-4">
                  <h2 className="max-w-[9ch] text-[clamp(2.95rem,8vw,6.2rem)] font-extrabold leading-[0.86] tracking-[-0.055em] text-white sm:max-w-[10ch]">
                    <span className="sm:hidden">Pick the fastest route into Pharos.</span>
                    <span className="hidden sm:inline">
                      Chart your route through the stablecoin market before the jargon slows you down.
                    </span>
                  </h2>
                  <p className="max-w-xl text-[0.98rem] leading-8 text-white/66">
                    <span className="sm:hidden">
                      Start with one route, learn the core terms, then branch into monitoring, research, yield, or
                      alerts only when you need more.
                    </span>
                    <span className="hidden sm:inline">
                      Pharos helps you monitor market stress, research individual stablecoins, compare risk, and set up
                      ongoing surveillance. This page gives you the shortest path into the product instead of asking you
                      to memorize the entire map first.
                    </span>
                  </p>
                </div>

                <div className="rounded-[1.2rem] border border-white/10 bg-black/18 px-4 py-3">
                  <p className="pharos-kicker text-white/42">Route planner</p>
                  <p className="mt-2 text-sm font-medium leading-relaxed text-white">
                    Start with a live surface, then move deeper only when the signal demands it.
                  </p>
                </div>
              </div>
            </div>

            <HeroSupportCluster className="hidden lg:block" factGridClassName="lg:grid-cols-2" />
          </div>

          <div className="relative overflow-hidden rounded-[1.8rem] border border-white/10 bg-[linear-gradient(180deg,oklch(0.15_0.016_248_/_0.72),oklch(0.1_0.012_248_/_0.94))] p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.04),0_24px_48px_oklch(0_0_0_/0.2)] sm:p-4">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,oklch(0.72_0.14_248_/_0.08),transparent_42%)]" />
            <div className="pointer-events-none absolute inset-0 hidden lg:block">
              <svg viewBox="0 0 640 520" className="h-full w-full" aria-hidden="true" preserveAspectRatio="none">
                <path
                  d="M88 136C160 112 214 118 278 162C340 204 422 210 520 172"
                  fill="none"
                  stroke="rgba(121, 193, 255, 0.36)"
                  strokeWidth="1.5"
                  strokeDasharray="4 7"
                />
                <path
                  d="M172 310C246 258 326 246 394 274C454 298 505 356 552 418"
                  fill="none"
                  stroke="rgba(137, 226, 177, 0.28)"
                  strokeWidth="1.5"
                  strokeDasharray="4 7"
                />
                <path
                  d="M76 412C136 374 224 360 304 392C374 420 442 430 520 420"
                  fill="none"
                  stroke="rgba(198, 162, 255, 0.28)"
                  strokeWidth="1.5"
                  strokeDasharray="4 7"
                />
              </svg>
            </div>

            <div className="relative space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="pharos-kicker text-frost-blue/82">Choose your goal</p>
                    <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/42">
                      5 live routes
                    </span>
                  </div>
                  <p className="max-w-sm text-sm leading-relaxed text-white/66">
                    Pick one route. The rest can stay peripheral until you need them.
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/58">
                  <Compass className="h-3.5 w-3.5" />
                  Optional guide
                </span>
              </div>

              <div className="pharos-stagger-entrance grid gap-3 sm:grid-cols-2">
                {START_HERE_GOALS.map((goal, index) => (
                  <div
                    key={goal.title}
                    style={{ "--stagger-index": index } as CSSProperties}
                    className={HERO_GOAL_OFFSETS[index]}
                  >
                    <GoalCard {...goal} order={index} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <HeroSupportCluster className="mt-6 border-t border-white/10 pt-5 lg:hidden" />
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
