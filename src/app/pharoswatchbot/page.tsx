import { Fragment, type CSSProperties } from "react";
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
  Smartphone,
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
import {
  TELEGRAM_ACTIONS,
  TELEGRAM_ALERT_EXAMPLES,
  TELEGRAM_COMMAND_COUNT,
  TELEGRAM_COMMAND_GROUPS,
  TELEGRAM_COMMAND_REFERENCE_TIPS,
  TELEGRAM_FAQ,
  TELEGRAM_HOW_IT_WORKS_CARDS,
  TELEGRAM_PAGE_DESCRIPTION,
  TELEGRAM_PARAM_LEGEND,
  type TelegramActionKey,
} from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { TelegramPulseBoard, TelegramPulseStrip } from "./telegram-pulse-strip";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  MINI_APP_HOME_DEEP_LINK,
  MINI_APP_WATCHLIST_DEEP_LINK,
  PHAROSWATCHBOT_BOT_URL,
  RECOMMENDED_SETUP_COMMAND,
  RECOMMENDED_SETUP_DEEP_LINK,
  SETUP_DEEP_LINK,
} from "./telegram-route-constants";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosWatchBot: Stablecoin Telegram Alerts",
  description: TELEGRAM_PAGE_DESCRIPTION,
  canonical: "/pharoswatchbot/",
  ogImage: `${SITE_URL}/og-pharoswatchbot.png`,
});

const COIN_COUNT = TRACKED_STABLECOIN_COUNT;
const BOT_URL = PHAROSWATCHBOT_BOT_URL;

const MINI_APP_FEATURES = [
  { title: "Watchlist", detail: "Followed coins, alert toggles, live risk context." },
  { title: "Global alerts", detail: "DEWS, depeg, safety, and launches in one panel." },
  { title: "Per-coin tuning", detail: "DEWS bands, depeg steps, safety modes." },
  { title: "Presets", detail: "One-tap cohorts like USD Top 25." },
  { title: "Quiet hours", detail: "Mute nights, snooze bursts, resume cleanly." },
  { title: "Delivery health", detail: "See whether Telegram can still reach you." },
  { title: "Coin search", detail: "Find and add stablecoins fast." },
  { title: "Bot sync", detail: "Commands and app share one alert state." },
  { title: "Deep links", detail: "Jump straight to settings, presets, or a coin." },
  { title: "Launch alerts", detail: "Catch tracked pre-launch assets going live." },
] as const satisfies readonly { title: string; detail: string }[];

const MINI_APP_SCREENSHOTS = [
  {
    title: "Home",
    src: "/featured/telegram-mini-app/home.png",
    alt: "PharosWatchBot Mini App home screen with watcher state, snooze controls, quiet hours, and last delivery",
    width: 583,
    height: 1280,
  },
  {
    title: "Watchlist",
    src: "/featured/telegram-mini-app/watchlist.png",
    alt: "PharosWatchBot Mini App watchlist screen with per-coin alert toggles",
    width: 583,
    height: 1280,
  },
  {
    title: "Presets",
    src: "/featured/telegram-mini-app/presets.png",
    alt: "PharosWatchBot Mini App presets screen with followed and available preset watchlists",
    width: 583,
    height: 1280,
  },
  {
    title: "Settings",
    src: "/featured/telegram-mini-app/settings.png",
    alt: "PharosWatchBot Mini App settings screen with global alerts, depeg step, and quiet hours",
    width: 583,
    height: 1280,
  },
] as const satisfies readonly { title: string; src: string; alt: string; width: number; height: number }[];

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

const RECOMMENDED_FIRST_COMMAND = RECOMMENDED_SETUP_COMMAND;

const RECOMMENDED_SETUPS = [
  {
    title: "First watcher setup",
    command: "/subscribe dews,depeg usd-top25",
    description: "Top 25 USD stablecoins, DEWS plus depeg. The safe default if you're not sure where to start.",
    icon: Bell,
  },
  {
    title: "Research desk setup",
    command: "/subscribe safety mcap-ge-1b",
    description: "Safety-grade downgrades with reason lines, on coins above $1B mcap. Material moves without per-ticker work.",
    icon: ShieldCheck,
  },
  {
    title: "Group setup",
    command: "/subscribe@PharosWatchBot dews usd-top25",
    description: "Address commands to the bot so a shared Telegram group runs one watch desk without colliding with other bots.",
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
    title: "Dynamic presets",
    detail: "Top-N and market-cap cohorts subscribe to a moving list with one command. No re-subscribing as the universe changes.",
    signal: "/presets",
    icon: Terminal,
  },
  {
    title: "Noise controls",
    detail: "Raise the DEWS floor, set depeg milestones, mute upgrades, schedule quiet hours in your /timezone, snooze on the fly.",
    signal: "/set, /mute",
    icon: SlidersHorizontal,
  },
  {
    title: "Shared group state",
    detail: "One Telegram chat, one shared subscription. Pending ticker selections stay scoped to whoever started them.",
    signal: "@PharosWatchBot",
    icon: Users,
  },
  {
    title: "No dropped alerts",
    detail: "Overflow gets queued, not silently dropped. Even when Telegram throttles, alerts arrive in order.",
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
  const featuredAlert = TELEGRAM_ALERT_EXAMPLES.find((alert) => alert.key === "safety") ?? TELEGRAM_ALERT_EXAMPLES[0];

  return (
    <div className="relative rounded-[1.25rem] border border-border/70 bg-card/86 p-3 shadow-[0_24px_60px_oklch(0_0_0_/0.22)]">
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
        <span className="inline-flex items-center gap-1.5 rounded-md border border-green-500/30 bg-green-500/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-green-700 dark:text-green-300">
          <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-green-500/70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
          </span>
          live
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
      className="min-w-0 rounded-xl border border-border/65 bg-card/78 p-4"
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
          <a href={SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
            Open Bot
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      }
      leadParagraphs={[
        <>
          The Pharos alert layer for people who don&rsquo;t want a stablecoin dashboard open all day. Bot alerts first;
          daily digest and a watcher community when you want context.
        </>,
      ]}
    >
      <div className="space-y-14">
        <section
          className="relative overflow-hidden rounded-[1.5rem] border border-border/70 bg-[linear-gradient(135deg,oklch(0.98_0.006_248_/_0.96),oklch(0.94_0.014_248_/_0.92))] px-5 py-7 shadow-sm dark:bg-[linear-gradient(135deg,oklch(0.17_0.024_248_/_0.96),oklch(0.105_0.018_248_/_0.98))] sm:px-7 sm:py-9 lg:px-9 lg:py-11"
          aria-labelledby="telegram-hero-title"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--brand-accent)_20%,var(--brand-accent)_60%,transparent)] opacity-70"
          />
          <div className="space-y-8 sm:space-y-10">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)] lg:items-center">
              <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground sm:text-[11px]">
                <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
                  <span className="absolute inset-0 animate-ping rounded-full bg-[var(--brand-accent)]/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--brand-accent)]" />
                </span>
                <span>Telegram alert layer</span>
                <span aria-hidden="true" className="text-border">·</span>
                <span>5m cadence</span>
                <span aria-hidden="true" className="text-border">·</span>
                <span>Live</span>
              </div>

              <div className="space-y-4">
                <h2
                  id="telegram-hero-title"
                  className="text-balance text-4xl font-black leading-[0.98] tracking-[-0.02em] text-foreground sm:text-5xl lg:text-[3.5rem] xl:text-[3.875rem]"
                >
                  Risk signals should find you before{" "}
                  <em className="font-serif font-medium italic tracking-normal text-foreground/85">the timeline</em>{" "}
                  does.
                </h2>
                <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-[17px]">
                  <TelegramLink href={BOT_URL}>@PharosWatchBot</TelegramLink> watches depegs, DEWS
                  threat bands, safety-grade changes, and launch promotions across the tracked universe. Start with one
                  low-noise preset, then tune thresholds as your watchlist grows. Safety alerts include a reason line so
                  you know whether to look at liquidity, peg pressure, active-depeg caps, or parent caps first.
                </p>
              </div>

              </div>

              <HeroPreview />
            </div>

            <div className="grid gap-x-6 gap-y-5 border-y border-border/55 py-6 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] sm:gap-x-12 sm:py-7">
              <div className="border-b border-border/55 pb-5 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-10">
                <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
                  Tracked universe
                </p>
                <p className="mt-3 font-mono text-[3.5rem] font-semibold leading-[0.9] tabular-nums text-foreground sm:text-[4.5rem] lg:text-[6rem]">
                  {COIN_COUNT.toLocaleString("en-US")}
                </p>
                <p className="mt-3 max-w-[36ch] text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                  tracked stablecoins across active, frozen, and pre-launch coverage
                </p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
                  Alert lane
                </p>
                <p className="mt-3 font-mono text-3xl font-semibold leading-[0.95] tabular-nums text-foreground sm:text-4xl lg:text-5xl">
                  5m
                </p>
                <p className="mt-3 max-w-[36ch] text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                  dispatcher cadence for all four alert families
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-frost-blue/30 bg-frost-blue/8 p-5 dark:bg-frost-blue/6 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="pharos-kicker text-sky-700 dark:text-sky-300">Recommended first command</p>
                  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-3 py-2.5 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.04)]">
                    <span aria-hidden="true" className="font-mono text-sm font-semibold text-sky-700 dark:text-sky-300">
                      ▸
                    </span>
                    <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] font-medium text-foreground sm:text-sm">
                      {RECOMMENDED_FIRST_COMMAND}
                    </code>
                    <CopyButton
                      text={RECOMMENDED_FIRST_COMMAND}
                      className="size-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                    />
                  </div>
                  <TelegramPulseStrip />
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Button asChild size="lg" className="gap-2">
                    <a href={RECOMMENDED_SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                      Use Recommended Setup
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="lg" className="gap-2">
                    <a href={MINI_APP_HOME_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                      <Smartphone className="h-4 w-4" aria-hidden="true" />
                      Open Mini App
                    </a>
                  </Button>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Opens a Telegram confirmation that preloads DEWS and depeg alerts on the top 25 USD stablecoins.
                Tune later with /set, or{" "}
                <a
                  href={MINI_APP_WATCHLIST_DEEP_LINK}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  open the Mini App
                </a>{" "}
                to manage alerts visually.
              </p>
            </div>
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

        <section className="space-y-4" id="mini-app" aria-labelledby="mini-app-title">
          <div className="pharos-card-shell overflow-hidden border-frost-blue/30 bg-frost-blue/8 dark:bg-frost-blue/6">
            <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.82fr)]">
              <div className="border-b border-border/55 p-5 lg:border-b-0 lg:border-r lg:p-7">
                <div className="flex items-baseline justify-between gap-3 border-b border-border/45 pb-3">
                  <p className="pharos-kicker flex items-baseline gap-2 text-sky-700 dark:text-sky-300">
                    <span>Mini App</span>
                    <span aria-hidden="true" className="text-border">/</span>
                    <span className="text-muted-foreground">Telegram</span>
                  </p>
                  <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground tabular-nums">
                    10 controls
                  </span>
                </div>

                <h2 id="mini-app-title" className="mt-5 text-2xl font-semibold tracking-tight text-foreground sm:text-[1.7rem]">
                  Control every alert from the Mini App.
                </h2>
                <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
                  Open it from Telegram to follow coins, tune thresholds, and pause noise without typing commands.
                </p>

                <ol className="mt-7 grid grid-cols-1 gap-x-7 sm:grid-cols-2">
                  {MINI_APP_FEATURES.map((feature, index) => (
                    <li key={feature.title} className="flex gap-3 border-t border-border/40 py-3">
                      <span
                        aria-hidden="true"
                        className="mt-[2px] shrink-0 font-mono text-[11px] font-semibold tabular-nums tracking-[0.08em] text-sky-700/85 dark:text-sky-300/90"
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-snug text-foreground">{feature.title}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="mt-7 flex flex-wrap items-center gap-2.5 border-t border-border/40 pt-5">
                  <Button asChild size="sm" className="gap-2">
                    <a href={MINI_APP_HOME_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                      <Smartphone className="h-4 w-4" aria-hidden="true" />
                      Open Mini App
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="sm" className="gap-2">
                    <a href={MINI_APP_WATCHLIST_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                      Open watchlist
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </a>
                  </Button>
                </div>
              </div>
              <div className="flex min-h-[560px] flex-col p-5 lg:min-h-0 lg:p-7">
                <div className="telegram-mini-app-stage flex flex-1 flex-col gap-3">
                  <div
                    className="telegram-mini-app-carousel flex flex-1 overflow-hidden rounded-2xl border border-border/65 shadow-[0_18px_42px_oklch(0_0_0_/0.24)]"
                    aria-label="Mini App screenshots"
                  >
                    <div className="telegram-mini-app-carousel-track flex h-full w-full">
                      {MINI_APP_SCREENSHOTS.map((screenshot, idx) => (
                        <figure
                          key={screenshot.title}
                          className="flex min-w-full flex-col bg-[oklch(0.16_0.02_248)]"
                        >
                          <div className="min-h-0 flex-1 p-3">
                            <Image
                              src={screenshot.src}
                              alt={screenshot.alt}
                              width={screenshot.width}
                              height={screenshot.height}
                              loading={screenshot.title === "Home" ? "eager" : "lazy"}
                              sizes="(min-width: 1024px) 340px, (min-width: 640px) 70vw, 88vw"
                              className="mx-auto h-full max-h-[calc(100svh-9rem)] w-auto rounded-xl object-contain lg:max-h-[560px]"
                            />
                          </div>
                          <figcaption className="flex items-baseline gap-2 border-t border-white/8 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/65">
                            <span className="tabular-nums text-sky-300">{String(idx + 1).padStart(2, "0")}</span>
                            <span aria-hidden="true" className="text-white/25">·</span>
                            <span>{screenshot.title}</span>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-center gap-2" aria-hidden="true">
                    <span className="telegram-mini-app-dot telegram-mini-app-dot-1 h-[3px] w-7 rounded-full bg-muted-foreground/30" />
                    <span className="telegram-mini-app-dot telegram-mini-app-dot-2 h-[3px] w-7 rounded-full bg-muted-foreground/30" />
                    <span className="telegram-mini-app-dot telegram-mini-app-dot-3 h-[3px] w-7 rounded-full bg-muted-foreground/30" />
                    <span className="telegram-mini-app-dot telegram-mini-app-dot-4 h-[3px] w-7 rounded-full bg-muted-foreground/30" />
                  </div>
                </div>
                <style>
                  {`
                    @keyframes telegramMiniAppCarousel {
                      0%, 19% { transform: translateX(0); }
                      25%, 44% { transform: translateX(-100%); }
                      50%, 69% { transform: translateX(-200%); }
                      75%, 94% { transform: translateX(-300%); }
                      100% { transform: translateX(0); }
                    }
                    @keyframes telegramMiniAppDotA { 0%, 19% { opacity: 1; } 25%, 94% { opacity: 0.32; } 100% { opacity: 1; } }
                    @keyframes telegramMiniAppDotB { 0%, 19% { opacity: 0.32; } 25%, 44% { opacity: 1; } 50%, 100% { opacity: 0.32; } }
                    @keyframes telegramMiniAppDotC { 0%, 44% { opacity: 0.32; } 50%, 69% { opacity: 1; } 75%, 100% { opacity: 0.32; } }
                    @keyframes telegramMiniAppDotD { 0%, 69% { opacity: 0.32; } 75%, 94% { opacity: 1; } 100% { opacity: 0.32; } }

                    .telegram-mini-app-carousel-track {
                      animation: telegramMiniAppCarousel 20s cubic-bezier(0.65, 0, 0.35, 1) infinite;
                    }
                    .telegram-mini-app-dot {
                      animation-duration: 20s;
                      animation-iteration-count: infinite;
                      animation-timing-function: cubic-bezier(0.65, 0, 0.35, 1);
                      opacity: 0.32;
                    }
                    .telegram-mini-app-dot-1 { animation-name: telegramMiniAppDotA; background: oklch(0.72 0.14 248 / 0.85); }
                    .telegram-mini-app-dot-2 { animation-name: telegramMiniAppDotB; background: oklch(0.72 0.14 248 / 0.85); }
                    .telegram-mini-app-dot-3 { animation-name: telegramMiniAppDotC; background: oklch(0.72 0.14 248 / 0.85); }
                    .telegram-mini-app-dot-4 { animation-name: telegramMiniAppDotD; background: oklch(0.72 0.14 248 / 0.85); }

                    .telegram-mini-app-stage:hover .telegram-mini-app-carousel-track,
                    .telegram-mini-app-stage:hover .telegram-mini-app-dot {
                      animation-play-state: paused;
                    }

                    @media (prefers-reduced-motion: reduce) {
                      .telegram-mini-app-carousel-track,
                      .telegram-mini-app-dot {
                        animation: none;
                      }
                      .telegram-mini-app-dot-1 { opacity: 1; }
                    }
                  `}
                </style>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4" id="alerts" aria-labelledby="alert-types-title">
          <div className="max-w-3xl space-y-2">
            <h2 id="alert-types-title" className="pharos-section-title">
              What the bot actually sends
            </h2>
            <p className="pharos-lead">
              Four alert families, each tied to a stablecoin signal Pharos already computes. Safety changes include the
              driver so an alert points to the part of the risk stack that moved.
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

        <section className="space-y-4" id="getting-started" aria-labelledby="setup-title">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-3xl space-y-2">
              <h2 id="setup-title" className="pharos-section-title">
                Three setups to start with
              </h2>
              <p className="pharos-lead">
                Pick the closest match, paste the command, tune later. Full command list is one click below.
              </p>
            </div>
            <Link
              href="#commands"
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-border/65 bg-background/55 px-3 text-sm font-medium text-foreground hover:bg-muted/45 sm:min-h-0 sm:py-2"
            >
              Full command list
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
              <p className="pharos-kicker">Built-in defaults</p>
              <h2 id="growth-support-title" className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                Noise stays low as your watchlist grows.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Presets shrink setup. Per-alert controls cap repeated pages. Group commands keep shared channels clean.
                Volatility doesn&rsquo;t translate to spam.
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
                <h3 className="text-sm font-semibold text-foreground">Reading DEWS alerts</h3>
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
                  {TELEGRAM_COMMAND_COUNT}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-5 border-t border-border/60 px-5 py-5">
              <div className="rounded-xl border border-border/60 bg-background/35 p-4 sm:p-5">
                <p className="pharos-kicker">Parameter syntax</p>
                <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {TELEGRAM_PARAM_LEGEND.map((entry) => (
                    <div key={entry.token} className="flex items-baseline gap-3">
                      <dt className="shrink-0 font-mono text-xs font-semibold text-foreground">{entry.token}</dt>
                      <dd className="text-xs leading-relaxed text-muted-foreground">{entry.meaning}</dd>
                    </div>
                  ))}
                </dl>
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
                  <tbody>
                    {TELEGRAM_COMMAND_GROUPS.map((group) => (
                      <Fragment key={group.label}>
                        <tr className="border-t border-border/60 first:border-t-0">
                          <th
                            scope="rowgroup"
                            colSpan={3}
                            className="pt-5 pb-2 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300"
                          >
                            {group.label}
                          </th>
                        </tr>
                        {group.commands.map((cmd) => (
                          <tr key={cmd.command} className="group/row border-t border-border/40 transition-colors hover:bg-muted/40">
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
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                <p className="pharos-kicker">Tips</p>
                <ul className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                  {TELEGRAM_COMMAND_REFERENCE_TIPS.map((tip) => (
                    <li key={tip} className="flex gap-2">
                      <span aria-hidden="true" className="text-muted-foreground/60">·</span>
                      <span>{tip}</span>
                    </li>
                  ))}
                </ul>
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
                Open the bot with the recommended setup.
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Digest and community are right here if you want slower context after.
              </p>
            </div>
            <div className="space-y-3">
              <CommandLine command={RECOMMENDED_FIRST_COMMAND} />
              <div className="flex flex-wrap gap-3">
                <Button size="sm" asChild className="gap-2">
                  <a href={RECOMMENDED_SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                    <Bot className="h-4 w-4" />
                    Start Bot
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild className="gap-2">
                  <a href={MINI_APP_HOME_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                    <Smartphone className="h-4 w-4" />
                    Try the Mini App
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
          Methodology for DEWS, safety-grade, and depeg scoring lives on the{" "}
          <Link href="/methodology" className="rounded-sm underline underline-offset-4 transition-colors hover:text-foreground">
            methodology page
          </Link>
          .
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
