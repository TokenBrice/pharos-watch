import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Bot,
  ChevronDown,
  Clock3,
  ExternalLink,
  Megaphone,
  MessageSquareText,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FaqSection } from "@/components/faq-section";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  TELEGRAM_ACTIONS,
  TELEGRAM_ALERT_EXAMPLES,
  TELEGRAM_COMMAND_REFERENCE_NOTE,
  TELEGRAM_COMMANDS,
  TELEGRAM_FAQ,
  TELEGRAM_GETTING_STARTED_OPTIONS,
  TELEGRAM_HOW_IT_WORKS_CARDS,
  TELEGRAM_PAGE_DESCRIPTION,
  type TelegramActionKey,
} from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { TelegramPulseBoard, TelegramPulseStrip } from "./telegram-pulse-strip";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosWatchBot: Stablecoin Telegram Alerts",
  description: TELEGRAM_PAGE_DESCRIPTION,
  canonical: "/pharoswatchbot/",
  ogImage: `${SITE_URL}/og-pharoswatchbot.png`,
});

const COIN_COUNT = ACTIVE_STABLECOINS.length;

const TELEGRAM_ACTION_ICONS = {
  bot: Bot,
  digest: Megaphone,
  community: Users,
} as const satisfies Record<TelegramActionKey, typeof Bot>;

const ACTION_ANCHORS = {
  bot: "bot",
  digest: "channel",
  community: "community",
} as const satisfies Record<TelegramActionKey, string>;

const HERO_STATS = [
  {
    label: "Tracked universe",
    value: COIN_COUNT.toLocaleString("en-US"),
    detail: "active stablecoins watched by the same risk pipeline",
  },
  {
    label: "Alert lane",
    value: "5m",
    detail: "Telegram dispatcher cadence for DEWS, depeg, safety, and launch signals",
  },
  {
    label: "First action",
    value: "Paste",
    detail: "open the bot, then send the recommended starter command",
  },
] as const;

const RECOMMENDED_FIRST_COMMAND = "/subscribe dews,depeg usd-top25";

const RECOMMENDED_SETUPS = [
  {
    title: "First watcher setup",
    command: "/subscribe dews,depeg usd-top25",
    description: "Top USD stablecoins with DEWS and depeg coverage. Best default for most new subscribers.",
    icon: Bell,
  },
  {
    title: "Research desk setup",
    command: "/subscribe safety mcap-ge-1b",
    description: "Material safety-grade downgrades across larger coins without following every ticker manually.",
    icon: ShieldCheck,
  },
  {
    title: "Group setup",
    command: "/subscribe@PharosWatchBot dews usd-top25",
    description: "Addressed commands let a Telegram group share one alert configuration without hijacking other bots.",
    icon: MessageSquareText,
  },
] as const satisfies readonly {
  title: string;
  command: string;
  description: string;
  icon: LucideIcon;
}[];

const GROWTH_SUPPORT = [
  {
    title: "Preset watchlists",
    detail: "Top-N and market-cap cohorts keep setup short as the tracked universe grows.",
    signal: "/presets",
    icon: Terminal,
  },
  {
    title: "Noise controls",
    detail: "DEWS floors, depeg worsening steps, safety modes, quiet hours, and alert snooze keep retention healthy.",
    signal: "/set, /mute",
    icon: SlidersHorizontal,
  },
  {
    title: "Group-ready commands",
    detail: "Addressed group commands turn one Telegram chat into a shared watch desk for teams and DAOs.",
    signal: "@PharosWatchBot",
    icon: Users,
  },
  {
    title: "Delivery backpressure",
    detail: "Overflow sends are queued and drained by the Telegram lane instead of dropping subscriber alerts.",
    signal: "pending queue",
    icon: Radio,
  },
] as const satisfies readonly {
  title: string;
  detail: string;
  signal: string;
  icon: LucideIcon;
}[];

/* -------------------------------------------------------------------------- */
/*  Subcomponents                                                             */
/* -------------------------------------------------------------------------- */

function AlertBubble({ content, time }: { content: string; time: string }) {
  return (
    <div className="relative rounded-2xl rounded-tl-sm bg-[#1e3a5f] p-3 text-white shadow-md dark:bg-[#2b5278]">
      <div className="mb-2 flex items-center gap-2 border-b border-white/10 pb-2">
        <Image src="/pharos-icon.png" alt="Pharos bot avatar" width={20} height={20} className="rounded-full" />
        <span className="text-xs font-medium text-white/90">PharosWatchBot</span>
      </div>
      <div className="whitespace-pre-wrap text-xs font-mono leading-relaxed text-white/95">{content}</div>
      <div className="mt-2 flex justify-end">
        <span className="text-[10px] text-white/70">{time}</span>
      </div>
    </div>
  );
}

function TelegramLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-sky-600 dark:hover:text-sky-400"
    >
      {children}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-2 py-1.5">
      <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-xs text-foreground">
        {command}
      </code>
      <CopyButton
        text={command}
        className="size-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
      />
    </div>
  );
}

function HeroPreview() {
  const featuredAlert = TELEGRAM_ALERT_EXAMPLES[0];

  return (
    <div className="rounded-[1.25rem] border border-border/70 bg-card/86 p-3 shadow-[0_18px_44px_oklch(0_0_0_/0.18)]">
      <div className="mb-3 flex items-center justify-between rounded-xl border border-border/60 bg-background/55 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-frost-blue/15 text-sky-700 dark:text-sky-200">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight text-foreground">@PharosWatchBot</p>
            <p className="text-[11px] text-muted-foreground">live alert preview</p>
          </div>
        </div>
        <span className="rounded-md border border-green-500/25 bg-green-500/10 px-2 py-1 font-mono text-[10px] font-semibold text-green-700 dark:text-green-300">
          armed
        </span>
      </div>
      <AlertBubble content={featuredAlert.content} time={featuredAlert.time} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        {["Snooze 1h", "4h", "24h"].map((label) => (
          <span
            key={label}
            className="rounded-md border border-white/10 bg-[#2b5278]/15 px-2 py-1.5 text-[11px] font-medium text-muted-foreground dark:bg-white/5"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function SurfaceCard({ action, index }: { action: (typeof TELEGRAM_ACTIONS)[number]; index: number }) {
  const Icon = TELEGRAM_ACTION_ICONS[action.key];
  const anchorId = ACTION_ANCHORS[action.key];
  const cardClassName = action.isPrimary
    ? "border-frost-blue/35 bg-frost-blue/8 dark:bg-frost-blue/6 md:col-span-2 lg:col-span-1"
    : "border-border/65 bg-card/78";

  return (
    <section
      id={anchorId}
      className={`pharos-card-shell pharos-interactive-card flex h-full scroll-mt-24 flex-col p-5 ${cardClassName}`}
      style={{ "--stagger-index": index } as CSSProperties}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60 text-sky-700 dark:text-sky-300">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold leading-tight text-foreground">{action.title}</h2>
            {action.isPrimary ? (
              <span className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300">
                Primary
              </span>
            ) : (
              <span className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Secondary
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{action.handle}</p>
        </div>
      </div>
      <p className="mt-4 flex-1 text-sm leading-relaxed text-muted-foreground">
        {action.description}
        {action.showArchiveLink ? (
          <>
            {" "}
            <Link
              href="/digest"
              className="rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Browse archive
            </Link>
            .
          </>
        ) : null}
      </p>
      <Button variant={action.isPrimary ? "default" : "outline"} size="sm" asChild className="mt-4 w-full gap-2">
        <a href={action.href} target="_blank" rel="noopener noreferrer">
          {action.cardButtonLabel}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </Button>
    </section>
  );
}

function SetupCard({ setup, index }: { setup: (typeof RECOMMENDED_SETUPS)[number]; index: number }) {
  const Icon = setup.icon;

  return (
    <div
      className="rounded-xl border border-border/65 bg-card/78 p-4"
      style={{ "--stagger-index": index } as CSSProperties}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/55 text-sky-700 dark:text-sky-300">
          <Icon className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold text-foreground">{setup.title}</p>
      </div>
      <div className="mt-3">
        <CommandLine command={setup.command} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{setup.description}</p>
    </div>
  );
}

function GrowthSupportCard({ item, index }: { item: (typeof GROWTH_SUPPORT)[number]; index: number }) {
  const Icon = item.icon;

  return (
    <div
      className="rounded-xl border border-border/65 bg-background/36 p-4"
      style={{ "--stagger-index": index } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card text-sky-700 dark:text-sky-300">
          <Icon className="h-4 w-4" />
        </span>
        <span className="rounded-md border border-border/55 bg-muted/35 px-2 py-1 font-mono text-[10px] font-semibold text-muted-foreground">
          {item.signal}
        </span>
      </div>
      <h3 className="mt-4 text-sm font-semibold text-foreground">{item.title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function PharosWatchBotPage() {
  return (
    <FeaturePageShell
      breadcrumbName="PharosWatchBot"
      path="/pharoswatchbot/"
      title="PharosWatchBot"
      containerClassName="mx-auto max-w-6xl"
      headerActions={
        <Button asChild size="sm" className="gap-2">
          <a href="https://t.me/PharosWatchBot" target="_blank" rel="noopener noreferrer">
            Open Bot
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      }
      leadParagraphs={[
        <>
          The Pharos alert layer for people who do not want to keep a stablecoin dashboard open all day: bot alerts,
          daily digest posts, and a public watcher community in one Telegram surface.
        </>,
      ]}
    >
      <div className="space-y-12">
        <section
          className="relative overflow-hidden rounded-[1.5rem] border border-border/70 bg-[linear-gradient(135deg,oklch(0.98_0.006_248_/_0.96),oklch(0.94_0.014_248_/_0.92))] px-4 py-5 shadow-sm dark:bg-[linear-gradient(135deg,oklch(0.17_0.024_248_/_0.96),oklch(0.105_0.018_248_/_0.98))] sm:px-6 sm:py-7 lg:px-7"
          aria-labelledby="telegram-hero-title"
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.85fr)] lg:items-center">
            <div className="space-y-5">
              <div className="max-w-2xl space-y-3">
                <h2
                  id="telegram-hero-title"
                  className="max-w-[16rem] text-2xl font-black leading-[1.05] tracking-tight sm:max-w-none sm:text-3xl"
                >
                  <span className="block sm:inline">Risk signals should find you</span>{" "}
                  <span className="block sm:inline">before the timeline does.</span>
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                  <TelegramLink href="https://t.me/PharosWatchBot">@PharosWatchBot</TelegramLink> watches depegs,
                  DEWS threat bands, safety-grade changes, and launch promotions across the tracked universe. Start
                  with one low-noise preset, then tune thresholds as your watchlist grows.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {HERO_STATS.map((stat) => (
                  <div key={stat.label} className="rounded-xl border border-border/60 bg-background/55 px-2 py-2.5 sm:px-3 sm:py-3">
                    <p className="text-[9px] font-semibold uppercase leading-tight tracking-[0.04em] text-muted-foreground sm:text-[11px] sm:tracking-[0.12em]">
                      {stat.label}
                    </p>
                    <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
                      {stat.value}
                    </p>
                    <p className="mt-1 hidden text-xs leading-relaxed text-muted-foreground sm:block">{stat.detail}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-frost-blue/25 bg-frost-blue/8 p-4 dark:bg-frost-blue/6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-2">
                    <p className="pharos-kicker text-sky-700 dark:text-sky-300">Recommended first command</p>
                    <CommandLine command={RECOMMENDED_FIRST_COMMAND} />
                    <TelegramPulseStrip />
                  </div>
                  <Button asChild className="shrink-0 gap-2">
                    <a href="https://t.me/PharosWatchBot" target="_blank" rel="noopener noreferrer">
                      Open Bot
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </a>
                  </Button>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Open the bot first, then paste the command above. It subscribes you to DEWS and depeg alerts for the
                  top USD stablecoin preset.
                </p>
              </div>
            </div>

            <HeroPreview />
          </div>
        </section>

        <TelegramPulseBoard />

        <section className="space-y-4" aria-labelledby="telegram-surfaces-title">
          <div className="max-w-3xl space-y-2">
            <h2 id="telegram-surfaces-title" className="pharos-section-title">
              Bot first; digest and community when you want context
            </h2>
            <p className="pharos-lead">
              PharosWatchBot is the alert product. The digest and community are optional companion surfaces around the
              same market signals.
            </p>
          </div>
          <div className="pharos-stagger-entrance grid gap-4 md:grid-cols-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.875fr)_minmax(0,0.875fr)]">
            {TELEGRAM_ACTIONS.map((action, index) => (
              <SurfaceCard key={action.key} action={action} index={index} />
            ))}
          </div>
        </section>

        <section className="space-y-4" id="getting-started" aria-labelledby="growth-start-title">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-3xl space-y-2">
              <h2 id="growth-start-title" className="pharos-section-title">
                Give new watchers a quiet default
              </h2>
              <p className="pharos-lead">
                Growth works when the first subscription is obvious and conservative. These setup paths keep the first
                command simple before anyone needs the full manual.
              </p>
            </div>
            <Link
              href="#commands"
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-border/65 bg-background/55 px-3 text-sm font-medium text-foreground hover:bg-muted/45 sm:min-h-0 sm:py-2"
            >
              Command reference
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <div className="pharos-stagger-entrance grid gap-4 lg:grid-cols-3">
            {RECOMMENDED_SETUPS.map((setup, index) => (
              <SetupCard key={setup.command} setup={setup} index={index} />
            ))}
          </div>
        </section>

        <section className="pharos-card-shell overflow-hidden" aria-labelledby="growth-support-title">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="border-b border-border/60 p-5 lg:border-b-0 lg:border-r lg:p-6">
              <p className="pharos-kicker">Growth posture</p>
              <h2 id="growth-support-title" className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                Support more watchers without making the bot louder.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                As the watcher base grows, the job is keeping setup short, making group use natural, and protecting
                subscribers from repeated noise during volatile periods.
              </p>
              <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden="true" />
                Dedicated five-minute Telegram dispatcher with overflow queueing.
              </div>
            </div>
            <div className="pharos-stagger-entrance grid gap-3 p-4 sm:grid-cols-2 lg:p-5">
              {GROWTH_SUPPORT.map((item, index) => (
                <GrowthSupportCard key={item.title} item={item} index={index} />
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-4" id="alerts" aria-labelledby="alert-types-title">
          <div className="max-w-3xl space-y-2">
            <h2 id="alert-types-title" className="pharos-section-title">
              What the bot actually sends
            </h2>
            <p className="pharos-lead">
              Four alert families, each tied to a stablecoin signal Pharos already computes.
            </p>
          </div>
          <div className="pharos-stagger-entrance grid gap-5 md:grid-cols-2">
            {TELEGRAM_ALERT_EXAMPLES.map((alert, i) => (
              <div key={alert.key} className="space-y-2.5" style={{ "--stagger-index": i } as CSSProperties}>
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {alert.label}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase text-muted-foreground">
                      {alert.key}
                    </code>
                  </h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{alert.tagline}</p>
                </div>
                <AlertBubble content={alert.content} time={alert.time} />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4" id="how-it-works" aria-labelledby="how-it-works-title">
          <div className="max-w-3xl space-y-2">
            <h2 id="how-it-works-title" className="pharos-section-title">
              Operating model
            </h2>
            <p className="pharos-lead">
              The Telegram lane is designed around predictable cadence, low daily volume, and explicit privacy scope.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {TELEGRAM_HOW_IT_WORKS_CARDS.map((item) => (
              <div key={item.title} className="rounded-xl border border-border/65 bg-card/78 p-5">
                <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                  {item.unsubscribeCommand ? (
                    <>
                      {" "}
                      Run{" "}
                      <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">
                        {item.unsubscribeCommand}
                      </code>{" "}
                      {item.descriptionAfterCommand}
                    </>
                  ) : null}
                </p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/25 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <Zap className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">DEWS bands</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Pharos scores each coin on five bands. Alerts fire when a coin enters{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">ALERT</code>,{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">WARNING</code>, or{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">DANGER</code>. Use{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/set USDT dews WARNING</code>{" "}
                  to raise the floor. See{" "}
                  <Link
                    href="/methodology#pegscore-dews-methodology"
                    className="rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
                  >
                    the DEWS methodology
                  </Link>{" "}
                  for scoring details.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="commands" className="scroll-mt-24">
          <details className="pharos-card-shell overflow-hidden group">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold transition-colors hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2.5">
                Command Reference
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                  {TELEGRAM_COMMANDS.length}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 border-t border-border/60 px-5 py-4">
              <div className="rounded-xl border border-border/60 bg-background/35 p-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
                  <div className="space-y-2">
                    <p className="pharos-kicker">Setup flow</p>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Open <TelegramLink href="https://t.me/PharosWatchBot">@PharosWatchBot</TelegramLink>, paste a
                      command, then use <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/list</code>{" "}
                      to audit active subscriptions.
                    </p>
                  </div>
                  <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    {TELEGRAM_GETTING_STARTED_OPTIONS.map((option) => (
                      <div key={option.command}>
                        <CommandLine command={option.command} />
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left">
                      <th scope="col" className="pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Command
                      </th>
                      <th scope="col" className="pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Description
                      </th>
                      <th
                        scope="col"
                        className="hidden pb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground sm:table-cell"
                      >
                        Example
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {TELEGRAM_COMMANDS.map((cmd) => (
                      <tr key={cmd.command} className="group/row transition-colors hover:bg-muted/40">
                        <td className="py-3 pr-4 align-top">
                          <div className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5">
                            <code className="whitespace-nowrap px-1 text-xs font-mono text-foreground">
                              {cmd.command}
                            </code>
                            <CopyButton
                              text={cmd.command}
                              className="size-6 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                            />
                          </div>
                        </td>
                        <td className="py-3 pr-4 align-top text-muted-foreground">{cmd.description}</td>
                        <td className="hidden py-3 align-top sm:table-cell">
                          {cmd.example ? (
                            <code className="whitespace-nowrap rounded bg-muted/70 px-2 py-1 text-xs font-mono text-foreground/80">
                              {cmd.example}
                            </code>
                          ) : (
                            <span className="text-muted-foreground/50">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Pro tip:</span>{" "}
                  {TELEGRAM_COMMAND_REFERENCE_NOTE.beforeAll}{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono text-foreground">all</code>{" "}
                  {TELEGRAM_COMMAND_REFERENCE_NOTE.afterAll}
                </p>
              </div>
            </div>
          </details>
        </section>

        <FaqSection items={TELEGRAM_FAQ} includeJsonLd />

        <section className="pharos-card-shell border-t-2 border-t-sky-500/40 p-6 dark:border-t-sky-400/30 sm:p-8">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)] lg:items-center">
            <div className="max-w-3xl space-y-2">
              <p className="pharos-kicker">Start watching</p>
              <h2 id="start-bot-cta" className="text-xl font-semibold tracking-tight text-foreground">
                One Telegram command gets you onto the live watchtower.
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Open @PharosWatchBot, paste the recommended command, then use digest and community links only if you
                want slower context around the alerts.
              </p>
            </div>
            <div className="space-y-3">
              <CommandLine command={RECOMMENDED_FIRST_COMMAND} />
              <div className="flex flex-wrap gap-3">
                <Button size="sm" asChild className="gap-2">
                  <a href="https://t.me/PharosWatchBot" target="_blank" rel="noopener noreferrer">
                    <Bot className="h-4 w-4" />
                    Start Bot
                  </a>
                </Button>
                {TELEGRAM_ACTIONS.filter((action) => !action.isPrimary).map((action) => {
                  const Icon = TELEGRAM_ACTION_ICONS[action.key];
                  return (
                    <Button key={action.key} variant="outline" size="sm" asChild className="gap-2">
                      <a href={action.href} target="_blank" rel="noopener noreferrer">
                        <Icon className="h-4 w-4" />
                        {action.finalButtonLabel}
                      </a>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <p className="text-xs text-muted-foreground">
          Want the methodology behind these alerts?{" "}
          <Link href="/methodology" className="rounded-sm underline underline-offset-4 transition-colors hover:text-foreground">
            Read the methodology page
          </Link>{" "}
          for DEWS, safety-grade, and depeg scoring details.
        </p>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(buildTelegramPageJsonLd(SITE_URL)),
          }}
        />
      </div>
    </FeaturePageShell>
  );
}
