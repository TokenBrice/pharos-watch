import { Fragment, type CSSProperties } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  Clock3,
  ExternalLink,
  Megaphone,
  Smartphone,
  Users,
  Zap,
} from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FaqSection } from "@/components/faq-section";
import { CopyButton } from "@/components/copy-button";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { Button } from "@/components/ui/button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { cn } from "@/lib/utils";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import "./telegram-carousel.css";
import {
  GROWTH_SUPPORT,
  MINI_APP_FEATURES,
  MINI_APP_SCREENSHOTS,
  RECOMMENDED_SETUPS,
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
import { MiniAppScreenshotCarousel } from "./mini-app-screenshot-carousel";
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

const PROSE_LINK_CLASS = "rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

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
    <div className="relative rounded-2xl border border-border/70 bg-card/86 p-3">
      <div className="mb-3 flex items-center justify-between rounded-xl border border-border/60 bg-background/55 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-background/60 text-sky-700 dark:text-sky-300">
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
    ? "border-border/65 bg-card/78 md:col-span-2 lg:col-span-1"
    : "border-border/65 bg-card/78";

  return (
    <section
      id={anchorId}
      className={cn("pharos-card-shell pharos-interactive-card flex h-full scroll-mt-24 flex-col p-5", cardClassName)}
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
              <span className="rounded-full border border-border/60 bg-muted/45 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">
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
            <Link href="/digest/" className={PROSE_LINK_CLASS}>
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
      className="rounded-xl bg-background/36 p-4"
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
      <div className="space-y-10">
        <section
          className="pharos-card-shell relative overflow-hidden rounded-2xl px-5 py-7 sm:px-7 sm:py-9 lg:px-9 lg:py-11"
          aria-labelledby="telegram-hero-title"
        >
          <div className="space-y-8 sm:space-y-10">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)] lg:items-center">
              <div className="space-y-6">
              <div className="pharos-kicker flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
                  className="pharos-display text-balance text-4xl font-extrabold leading-[1.05] tracking-tight text-foreground sm:text-5xl"
                >
                  Risk signals should find you before{" "}
                  <em className="not-italic font-medium text-foreground/85">the timeline</em>{" "}
                  does.
                </h2>
                <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-[17px]">
                  <TelegramLink href={PHAROSWATCHBOT_BOT_URL}>@PharosWatchBot</TelegramLink> watches depegs, DEWS
                  threat bands, safety-grade changes, launch promotions, and live reserve-mix drift across the tracked
                  universe. Start with one low-noise preset, then tune thresholds as your watchlist grows. Safety alerts
                  include a reason line so you know whether to look at liquidity, peg pressure, active-depeg caps, or
                  parent caps first.
                </p>
              </div>

              </div>

              <HeroPreview />
            </div>

            <div className="grid gap-x-6 gap-y-5 border-y border-border/55 py-6 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] sm:gap-x-12 sm:py-7">
              <div className="border-b border-border/55 pb-5 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-10">
                <p className="pharos-kicker">
                  Tracked universe
                </p>
                <p className="mt-3 pharos-numeric text-[3.5rem] font-semibold leading-[0.9] text-frost-blue sm:text-[4.5rem] lg:text-[6rem]">
                  {TRACKED_STABLECOIN_COUNT.toLocaleString("en-US")}
                </p>
                <p className="mt-3 max-w-[36ch] text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                  tracked stablecoins across active, frozen, and pre-launch coverage
                </p>
              </div>
              <div>
                <p className="pharos-kicker">
                  Alert lane
                </p>
                <p className="mt-3 pharos-numeric text-3xl font-semibold leading-[0.95] text-foreground sm:text-4xl lg:text-5xl">
                  5m
                </p>
                <p className="mt-3 max-w-[36ch] text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                  dispatcher cadence for all five alert families
                </p>
              </div>
            </div>

            <div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="pharos-kicker">Recommended first command</p>
                  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-3 py-2.5 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.04)]">
                    <span aria-hidden="true" className="font-mono text-sm font-semibold text-sky-700 dark:text-sky-300">
                      ▸
                    </span>
                    <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] font-medium text-foreground sm:text-sm">
                      {RECOMMENDED_SETUP_COMMAND}
                    </code>
                    <CopyButton
                      text={RECOMMENDED_SETUP_COMMAND}
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
                  className={PROSE_LINK_CLASS}
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
          <div className="pharos-card-shell overflow-hidden">
            <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.82fr)]">
              <div className="border-b border-border/55 p-5 lg:border-b-0 lg:border-r lg:p-7">
                <div className="flex items-baseline justify-between gap-3 border-b border-border/45 pb-3">
                  <p className="pharos-kicker flex items-baseline gap-2">
                    <span>Mini App</span>
                    <span aria-hidden="true" className="text-border">/</span>
                    <span className="text-muted-foreground">Telegram</span>
                  </p>
                  <span className="pharos-numeric text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    {MINI_APP_FEATURES.length} controls
                  </span>
                </div>

                <h2 id="mini-app-title" className="mt-5 text-2xl font-semibold tracking-tight text-foreground sm:text-[1.7rem]">
                  Control every alert from the Mini App.
                </h2>
                <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
                  Open it from Telegram to follow coins, tune thresholds, and pause noise without typing commands. Deep reads like{" "}
                  <code>/why</code>, <code>/brief</code>, and <code>/top</code> still stay in chat.
                </p>

                <ol className="mt-7 grid grid-cols-1 gap-x-7 sm:grid-cols-2">
                  {MINI_APP_FEATURES.map((feature, index) => (
                    <li key={feature.title} className="flex gap-3 border-t border-border/40 py-3">
                      <span
                        aria-hidden="true"
                        className="mt-[2px] shrink-0 pharos-numeric text-[11px] font-semibold tracking-[0.08em] text-sky-700/85 dark:text-sky-300/90"
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
                <MiniAppScreenshotCarousel screenshots={MINI_APP_SCREENSHOTS} />
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
              Five alert families, each tied to a stablecoin signal Pharos already computes. Safety changes include the
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
                    href="/methodology/#pegscore-dews-methodology"
                    className={PROSE_LINK_CLASS}
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
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground pharos-numeric">
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
              <TableFrame
                tableId="pharoswatchbot-command-reference"
                testId="pharoswatchbot-command-reference-table"
                chrome="content"
                density="compact"
                className="bg-background/35"
                tableClassName="min-w-0 text-sm sm:min-w-[720px]"
                tableProps={{ "aria-label": "PharosWatchBot command reference" }}
                viewportClassName="-mx-1 px-1"
                viewportProps={{ compactBottomPadding: false, mobileScrollHint: false }}
              >
                <TableHeader>
                  <TableRow className="border-b border-border/60 text-left hover:bg-transparent">
                    <TableHead scope="col" className="h-auto whitespace-nowrap px-0 pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Command
                    </TableHead>
                    <TableHead scope="col" className="h-auto whitespace-nowrap px-0 pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Description
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="hidden h-auto whitespace-nowrap px-0 pb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground sm:table-cell"
                    >
                      Example
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {TELEGRAM_COMMAND_GROUPS.map((group) => (
                    <Fragment key={group.label}>
                      <TableRow className="border-t border-border/60 first:border-t-0 hover:bg-transparent">
                        <TableHead
                          scope="rowgroup"
                          colSpan={3}
                          className="h-auto px-0 pt-5 pb-2 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300"
                        >
                          {group.label}
                        </TableHead>
                      </TableRow>
                      {group.commands.map((cmd) => (
                        <TableRow key={cmd.command} className="group/row border-t border-border/40 transition-colors hover:bg-muted/40">
                          <TableCell className="whitespace-normal px-0 py-3 pr-4 align-top">
                            <div className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5">
                              <code className="whitespace-nowrap px-1 text-xs font-mono text-foreground">
                                {cmd.command}
                              </code>
                              <CopyButton
                                text={cmd.command}
                                className="size-6 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                              />
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-normal px-0 py-3 pr-4 align-top text-muted-foreground">{cmd.description}</TableCell>
                          <TableCell className="hidden whitespace-normal px-0 py-3 align-top sm:table-cell">
                            {cmd.example ? (
                              <code className="whitespace-nowrap rounded bg-muted/70 px-2 py-1 text-xs font-mono text-foreground/80">
                                {cmd.example}
                              </code>
                            ) : (
                              <span className="text-muted-foreground/50">-</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </TableFrame>
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

        <section className="pharos-card-shell p-6 sm:p-8">
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
              <CommandLine command={RECOMMENDED_SETUP_COMMAND} />
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
          <Link href="/methodology/" className={PROSE_LINK_CLASS}>
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
