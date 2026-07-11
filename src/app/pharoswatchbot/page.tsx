import { Fragment, type SVGProps } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Bot, ChevronDown, ExternalLink, LockKeyhole, Radio, ShieldCheck, Smartphone } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FaqSection } from "@/components/faq-section";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
} from "@shared/lib/telegram-delivery-policy";
import "./telegram-carousel.css";
import { TELEGRAM_ALERT_FAMILIES } from "@shared/lib/telegram-alert-families";
import {
  MINI_APP_FEATURES,
  MINI_APP_SCREENSHOTS,
  RECOMMENDED_SETUPS,
  TELEGRAM_ACTIONS,
  TELEGRAM_ALERT_EXAMPLES,
  TELEGRAM_COMMAND_COUNT,
  TELEGRAM_COMMAND_GROUPS,
  TELEGRAM_COMMAND_REFERENCE_TIPS,
  TELEGRAM_FAQ,
  TELEGRAM_HERO_FAMILY_BLURBS,
  TELEGRAM_PAGE_DESCRIPTION,
  TELEGRAM_PARAM_LEGEND,
} from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { MiniAppScreenshotCarousel } from "./mini-app-screenshot-carousel";
import { TelegramHeroMetric } from "./telegram-hero-metric";
import { TelegramPulseBoard } from "./telegram-pulse-strip";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  MINI_APP_HOME_DEEP_LINK,
  MINI_APP_SETUP_DEEP_LINK,
  MINI_APP_WATCHLIST_DEEP_LINK,
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

const PROSE_LINK_CLASS =
  "pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

// Reliability copy derives from the shared delivery policy so the public
// contract cannot drift from production TTL/cadence constants (TGB-028).
function formatPolicyDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const DISPATCH_CADENCE_LABEL = formatPolicyDuration(TELEGRAM_DISPATCH_INTERVAL_SEC);
const RISK_ALERT_TTL_LABEL = formatPolicyDuration(PENDING_TTL_SEC);
const LAUNCH_ALERT_TTL_LABEL = formatPolicyDuration(TELEGRAM_ALERT_TTL_SEC.launch);
const ADMIN_ALERT_TTL_LABEL = formatPolicyDuration(TELEGRAM_ALERT_TTL_SEC.adminBroadcast);

// Same drawn lighthouse as the top-nav overflow trigger; local copy keeps the
// hero self-contained.
function LighthouseGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M10 4h4" />
      <path d="M9 8h6" />
      <path d="M10 8 8 21" />
      <path d="M14 8l2 13" />
      <path d="M7 21h10" />
      <path d="M9 14h6" />
      <path d="m4 7 3 1" />
      <path d="m20 7-3 1" />
      <path d="M12 4v4" />
    </svg>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-2 py-1.5">
      <code className="block min-w-0 flex-1 whitespace-pre-wrap px-1 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
        {command}
      </code>
      <CopyButton
        text={command}
        className="size-11 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
      />
    </div>
  );
}

function AlertBubble({ content, time }: { content: string; time: string }) {
  return (
    <div className="rounded-lg rounded-tl-sm bg-[#1e3a5f] p-3 text-white dark:bg-[#2b5278]">
      <div className="mb-2 flex items-center gap-2 border-b border-white/10 pb-2">
        <Image src="/pharos-icon.png" alt="" width={20} height={20} className="rounded-full" />
        <span className="text-xs font-medium text-white/90">PharosWatchBot</span>
      </div>
      <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-white/95">{content}</div>
      <div className="mt-2 flex justify-end">
        <span className="text-[10px] text-white/75">{time}</span>
      </div>
    </div>
  );
}

function AlertExamples() {
  return (
    <section id="alerts" className="scroll-mt-24 space-y-5" aria-labelledby="alert-types-title">
      <div className="max-w-2xl space-y-2">
        <h2 id="alert-types-title" className="pharos-section-title">
          What lands in your chat
        </h2>
        <p className="pharos-lead">
          Real examples from all six families, shown exactly as the bot sends them. Safety changes name the score
          driver; reserve alerts only cover coins with live reserve tracking, while freeze alerts follow the verified tape.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {TELEGRAM_ALERT_EXAMPLES.map((alert, index) => {
          const isLastOdd = index === TELEGRAM_ALERT_EXAMPLES.length - 1 && TELEGRAM_ALERT_EXAMPLES.length % 2 === 1;
          return (
            <article
              key={alert.key}
              className={
                isLastOdd
                  ? "rounded-lg border border-border/65 bg-card p-3.5 sm:p-4 md:col-span-2 md:grid md:grid-cols-2 md:items-start md:gap-5"
                  : "rounded-lg border border-border/65 bg-card p-3.5 sm:p-4"
              }
            >
              <div className={isLastOdd ? "mb-3 md:mb-0" : "mb-3"}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{alert.label}</h3>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-muted-foreground">
                    {alert.key}
                  </code>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{alert.tagline}</p>
              </div>
              <AlertBubble content={alert.content} time={alert.time} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SetupSection() {
  return (
    <section
      id="getting-started"
      className="scroll-mt-24 border-y border-border/65 py-7 sm:py-9"
      aria-labelledby="setup-title"
    >
      <div className="grid gap-7 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:gap-12">
        <div className="space-y-2">
          <h2 id="setup-title" className="pharos-section-title">
            Start in two minutes
          </h2>
          <p className="pharos-lead">Open the bot, approve one useful default, then tune only when you need to.</p>
        </div>
        <div className="space-y-5">
          <ol className="space-y-4">
            <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
              <span aria-hidden="true" className="pharos-numeric pt-0.5 text-xs font-semibold text-muted-foreground">
                01
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Open @PharosWatchBot</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Telegram opens the private setup flow. A group works too, but group mutations require an admin.
                </p>
              </div>
            </li>
            <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
              <span aria-hidden="true" className="pharos-numeric pt-0.5 text-xs font-semibold text-muted-foreground">
                02
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Use the low-noise default</p>
                <div className="mt-2 max-w-2xl">
                  <CommandLine command={RECOMMENDED_SETUP_COMMAND} />
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  DEWS and depeg alerts for the current top 25 USD stablecoins. Preset membership updates as the market
                  changes.
                </p>
              </div>
            </li>
            <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
              <span aria-hidden="true" className="pharos-numeric pt-0.5 text-xs font-semibold text-muted-foreground">
                03
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Check and adjust</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Use <code>/list</code> to audit effective follows, <code>/health</code> for this chat&rsquo;s delivery
                  diagnostic, and <code>/set</code> or the Mini App to tune thresholds.
                </p>
              </div>
            </li>
          </ol>
          <div className="flex flex-wrap gap-2.5">
            <Button asChild size="sm" className="gap-2">
              <TelegramAdoptionLink href={RECOMMENDED_SETUP_DEEP_LINK} placement="setup" target="_blank" rel="noopener noreferrer">
                Use recommended setup
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </TelegramAdoptionLink>
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-2">
              <TelegramAdoptionLink href={MINI_APP_SETUP_DEEP_LINK} placement="miniapp_setup" target="_blank" rel="noopener noreferrer">
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                Set up in the Mini App
              </TelegramAdoptionLink>
            </Button>
          </div>
          <details className="group border-t border-border/55 pt-3">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              Other starter setups
              <ChevronDown
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </summary>
            <div className="grid gap-4 pb-1 pt-3 sm:grid-cols-2">
              {RECOMMENDED_SETUPS.slice(1).map((setup) => (
                <div key={setup.command} className="min-w-0 border-t border-border/55 pt-3">
                  <p className="text-sm font-semibold text-foreground">{setup.title}</p>
                  <div className="mt-2">
                    <CommandLine command={setup.command} />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{setup.description}</p>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

function MiniAppSection() {
  return (
    <section id="mini-app" className="scroll-mt-24 space-y-6" aria-labelledby="mini-app-title">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,0.66fr)] lg:items-start lg:gap-12">
        <div>
          <h2 id="mini-app-title" className="pharos-section-title">
            The same alert state, without slash commands
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The Telegram Mini App manages watchlists, presets, settings, snooze, and delivery health. Deep reads like
            <code> /why</code>, <code>/brief</code>, and <code>/top</code> stay in chat.
          </p>
          <ul className="mt-6 grid gap-x-7 sm:grid-cols-2">
            {MINI_APP_FEATURES.slice(0, 4).map((feature) => (
              <li key={feature.title} className="border-t border-border/55 py-3">
                <p className="text-sm font-semibold text-foreground">{feature.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.detail}</p>
              </li>
            ))}
          </ul>
          <details className="group border-t border-border/55">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              All {MINI_APP_FEATURES.length} Mini App controls
              <ChevronDown
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </summary>
            <ul className="grid gap-x-7 pb-2 sm:grid-cols-2">
              {MINI_APP_FEATURES.slice(4).map((feature) => (
                <li key={feature.title} className="border-t border-border/55 py-3">
                  <p className="text-sm font-semibold text-foreground">{feature.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.detail}</p>
                </li>
              ))}
            </ul>
          </details>
          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button asChild size="sm" className="gap-2">
              <TelegramAdoptionLink href={MINI_APP_HOME_DEEP_LINK} placement="miniapp_home" target="_blank" rel="noopener noreferrer">
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                Open Mini App
              </TelegramAdoptionLink>
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-2">
              <TelegramAdoptionLink href={MINI_APP_WATCHLIST_DEEP_LINK} placement="miniapp_watchlist" target="_blank" rel="noopener noreferrer">
                Open watchlist
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </TelegramAdoptionLink>
            </Button>
          </div>
        </div>
        <MiniAppScreenshotCarousel screenshots={MINI_APP_SCREENSHOTS} />
      </div>
    </section>
  );
}

function ReliabilityContract() {
  return (
    <section className="border-y border-border/65 py-7 sm:py-9" aria-labelledby="reliability-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="max-w-2xl">
          <h2 id="reliability-title" className="pharos-section-title">
            What Pharos promises, and what it does not
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Alerts are a bounded notification service, not a guaranteed emergency pager. Each message links back to
            Pharos so you can inspect the underlying signal.
          </p>
        </div>
      </div>
      <dl className="mt-6 grid gap-x-8 sm:grid-cols-3">
        <div className="border-t border-border/55 py-4">
          <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Radio className="h-4 w-4" aria-hidden="true" /> Source cadence
          </dt>
          <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The dispatcher runs every {DISPATCH_CADENCE_LABEL}. Safety follows the live report-card publish path;
            reserve drift follows the four-hour live-reserve producer and only fires for supported live-reserve coins.
          </dd>
        </div>
        <div className="border-t border-border/55 py-4">
          <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Bounded delivery
          </dt>
          <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Eligible alerts can send immediately or enter a retry queue. Risk alerts expire after {RISK_ALERT_TTL_LABEL};
            launch alerts after {LAUNCH_ALERT_TTL_LABEL} and admin broadcasts after {ADMIN_ALERT_TTL_LABEL}. Terminal
            and ambiguous outcomes stay visible to operators rather than being silently replayed.
          </dd>
        </div>
        <div className="border-t border-border/55 py-4">
          <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <LockKeyhole className="h-4 w-4" aria-hidden="true" /> Privacy
          </dt>
          <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Pharos stores your chat ID, optional username, follows, alert settings, quiet hours, snooze state, and
            short-lived command or queue metadata. Use <code>/forget</code> in a private chat for immediate deletion;
            inactive unsubscribed chats are pruned after 180 days.
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Adoption metrics above are aggregate counts; small daily changes are hidden to avoid identifying individual
        chats. Read the full{" "}
        <Link href="/privacy/" className={PROSE_LINK_CLASS}>
          privacy policy
        </Link>
        .
      </p>
    </section>
  );
}

function CommandReference() {
  return (
    <section id="commands" className="scroll-mt-24" aria-labelledby="command-reference-title">
      <details className="group border-y border-border/65">
        <summary className="pharos-focus-ring flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-md py-3 text-left [&::-webkit-details-marker]:hidden">
          <span>
            <span id="command-reference-title" className="block text-base font-semibold text-foreground">
              Command Reference
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {TELEGRAM_COMMAND_COUNT} commands, parameter syntax, examples, and group-chat notes
            </span>
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-7 border-t border-border/55 py-6">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Parameter syntax</h3>
            <dl className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {TELEGRAM_PARAM_LEGEND.map((entry) => (
                <div
                  key={entry.token}
                  className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] items-baseline gap-3"
                >
                  <dt className="font-mono text-xs font-semibold text-foreground [overflow-wrap:anywhere]">
                    {entry.token}
                  </dt>
                  <dd className="text-xs leading-relaxed text-muted-foreground">{entry.meaning}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="space-y-7" aria-label="PharosWatchBot command reference">
            {TELEGRAM_COMMAND_GROUPS.map((group) => (
              <section
                key={group.label}
                aria-labelledby={`command-group-${group.label.toLowerCase().replaceAll(" ", "-")}`}
              >
                <h3
                  id={`command-group-${group.label.toLowerCase().replaceAll(" ", "-")}`}
                  className="font-mono text-xs font-semibold uppercase text-muted-foreground"
                >
                  {group.label}
                </h3>
                <dl className="mt-2 divide-y divide-border/45 border-y border-border/55">
                  {group.commands.map((cmd) => (
                    <div
                      key={cmd.command}
                      className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(12rem,0.9fr)_minmax(0,1.4fr)] sm:gap-5"
                    >
                      <dt className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1 rounded-lg bg-muted px-1 py-0.5">
                          <code className="min-w-0 flex-1 whitespace-pre-wrap px-1 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                            {cmd.command}
                          </code>
                          <CopyButton
                            text={cmd.command}
                            className="size-11 shrink-0 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                          />
                        </div>
                      </dt>
                      <dd className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                        {cmd.description}
                        {cmd.example ? (
                          <span className="mt-1.5 block">
                            <span className="sr-only">Example: </span>
                            <code className="whitespace-pre-wrap font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                              {cmd.example}
                            </code>
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Command tips</h3>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              {TELEGRAM_COMMAND_REFERENCE_TIPS.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}

function MoreTelegramSurfaces() {
  const secondaryActions = TELEGRAM_ACTIONS.filter((action) => !action.isPrimary);
  return (
    <section className="space-y-4" aria-labelledby="telegram-context-title">
      <div>
        <h2 id="telegram-context-title" className="pharos-section-title">
          Need context instead of another alert?
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The digest and community are optional. They do not change your bot subscriptions.
        </p>
      </div>
      <div className="grid gap-x-8 sm:grid-cols-2">
        {secondaryActions.map((action) => (
          <div
            key={action.key}
            id={action.key === "digest" ? "channel" : "community"}
            className="scroll-mt-24 border-t border-border/55 py-4"
          >
            <h3 className="text-sm font-semibold text-foreground">{action.title}</h3>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{action.handle}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {action.description}
              {action.showArchiveLink ? (
                <Fragment>
                  {" "}
                  <Link href="/digest/" className={PROSE_LINK_CLASS}>
                    Browse archive
                  </Link>
                  .
                </Fragment>
              ) : null}
            </p>
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-foreground underline underline-offset-4"
            >
              {action.cardButtonLabel}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in new tab)</span>
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function PharosWatchBotPage() {
  return (
    <FeaturePageShell
      breadcrumbName="PharosWatchBot"
      path="/pharoswatchbot/"
      title="PharosWatchBot"
      containerClassName="mx-auto max-w-6xl"
    >
      <div className="space-y-6 sm:space-y-14">
        <section id="bot" className="scroll-mt-24" aria-labelledby="telegram-hero-title">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,0.66fr)] lg:items-start lg:gap-12">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">
                Free Telegram alerts for {TRACKED_STABLECOIN_COUNT.toLocaleString("en-US")} tracked stablecoins
              </p>
              <h2
                id="telegram-hero-title"
                className="pharoswatchbot-hero-title mt-3 max-w-xl text-balance font-display font-extrabold text-foreground"
              >
                Stablecoin alerts, before you have to check.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Six alert families, from depeg events to issuer freezes, sent to your Telegram chat. Start with one
                preset; tune later.
              </p>
              <div className="mt-6 flex flex-wrap gap-2.5">
                <Button asChild className="gap-2">
                  <TelegramAdoptionLink
                    href={SETUP_DEEP_LINK}
                    placement="hero"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Bot className="h-4 w-4" aria-hidden="true" />
                    Open Bot
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </TelegramAdoptionLink>
                </Button>
                <Button asChild variant="outline" className="gap-2">
                  <Link href="#alerts">
                    See alert examples
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>
            <div aria-label="The six alert families" className="pharoswatchbot-watch">
              <span aria-hidden="true" className="pharoswatchbot-watch-beam" />
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 pb-2.5">
                <p className="pharos-kicker !tracking-normal flex items-center gap-2">
                  <LighthouseGlyph className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  Six alert families
                </p>
                <TelegramHeroMetric />
              </div>
              <ul>
                {TELEGRAM_ALERT_FAMILIES.map((family) => (
                  <li key={family.key} className="border-t border-border/55 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-semibold text-foreground">{family.label}</p>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-muted-foreground">
                        {family.key}
                      </code>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {TELEGRAM_HERO_FAMILY_BLURBS[family.key]}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <AlertExamples />
        <SetupSection />
        <TelegramPulseBoard />
        <MiniAppSection />
        <ReliabilityContract />
        <MoreTelegramSurfaces />
        <div className="space-y-4" aria-label="PharosWatchBot reference">
          <CommandReference />
          <details className="group border-b border-border/65">
            <summary className="pharos-focus-ring flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-md py-3 text-left [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-base font-semibold text-foreground">Frequently Asked Questions</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Privacy, groups, presets, quiet hours, and unsubscribing
                </span>
              </span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </summary>
            <div className="border-t border-border/55 py-6">
              <FaqSection items={TELEGRAM_FAQ} title="Detailed answers" includeJsonLd />
            </div>
          </details>
        </div>

        <p className="text-xs text-muted-foreground">
          Methodology for DEWS, safety-grade, and depeg scoring lives on the{" "}
          <Link href="/methodology/" className={PROSE_LINK_CLASS}>
            methodology page
          </Link>
          .
        </p>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(buildTelegramPageJsonLd(SITE_URL)) }}
        />
      </div>
    </FeaturePageShell>
  );
}
