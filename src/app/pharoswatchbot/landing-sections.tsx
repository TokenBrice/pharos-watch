import Link from "next/link";
import {
  ArrowRight,
  ExternalLink,
  ListChecks,
  LockKeyhole,
  MessageSquareText,
  MoonStar,
  Radio,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sunrise,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  MINI_APP_HOME_DEEP_LINK,
  MINI_APP_SETUP_DEEP_LINK,
  MINI_APP_WATCHLIST_DEEP_LINK,
  RECOMMENDED_SETUP_COMMAND,
  RECOMMENDED_SETUP_DEEP_LINK,
  SETUP_DEEP_LINK,
} from "@/lib/telegram-route-constants";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
} from "@shared/lib/telegram-delivery-policy";
import { BotSection } from "./bot-section";
import { CommandManual } from "./command-manual";
import { MiniAppScreenshotCarousel } from "./mini-app-screenshot-carousel";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { MINI_APP_FEATURES, MINI_APP_SCREENSHOTS, TELEGRAM_ACTIONS } from "./telegram-content";

const PROSE_LINK_CLASS =
  "pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

function CommandChip({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border/60 bg-background/70 py-0.5 pl-2.5 pr-0.5">
      <code className="block min-w-0 flex-1 whitespace-pre-wrap font-mono text-xs text-foreground [overflow-wrap:anywhere]">
        {command}
      </code>
      <CopyButton
        text={command}
        className="size-11 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground sm:size-8"
      />
    </div>
  );
}

/** Header CTAs. `#bot` is the anchor other routes link to for "get alerts". */
export function PrimaryActions() {
  return (
    <div id="bot" className="flex scroll-mt-24 flex-wrap items-center gap-x-3 gap-y-3 pt-2">
      <Button asChild size="lg" className="gap-2">
        <TelegramAdoptionLink href={SETUP_DEEP_LINK} placement="hero" target="_blank" rel="noopener noreferrer">
          <Send className="h-4 w-4" aria-hidden="true" />
          Open in Telegram
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </TelegramAdoptionLink>
      </Button>
      <Button asChild size="lg" variant="outline" className="gap-2">
        <TelegramAdoptionLink href={MINI_APP_HOME_DEEP_LINK} placement="miniapp_home" target="_blank" rel="noopener noreferrer">
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          Open the Mini App
        </TelegramAdoptionLink>
      </Button>
      <p className="pharos-meta">Free. No sign-up beyond Telegram. Works in private chats and groups.</p>
    </div>
  );
}

const SETUP_STEPS = [
  {
    title: "Open @PharosWatchBot",
    detail: "Telegram opens the private setup flow. A group works too, but group mutations require an admin.",
  },
  {
    title: "Approve the low-noise default",
    detail: "DEWS and depeg alerts for the current top 25 USD stablecoins. Preset membership updates as the market changes.",
  },
  {
    title: "Check and adjust",
    detail: "/list audits effective follows, /health diagnoses delivery, /set or the Mini App tunes thresholds.",
  },
] as const;

/** Keeps the #getting-started anchor the HowTo JSON-LD and other routes point at. */
export function GettingStarted() {
  return (
    <BotSection
      id="getting-started"
      kicker="How it works"
      title="Start in two minutes"
      lead="One useful default now; tune only when you need to."
    >
      <ol className="grid gap-5 sm:grid-cols-3 sm:gap-6">
        {SETUP_STEPS.map((step, index) => (
          <li key={step.title} className="border-t border-border/55 pt-4">
            <p className="pharos-numeric text-xs font-semibold text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </p>
            <p className="mt-1.5 text-sm font-semibold text-foreground">{step.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-col gap-4 border-t border-border/55 pt-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-md lg:flex-1">
          <CommandChip command={RECOMMENDED_SETUP_COMMAND} />
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button asChild className="gap-2">
            <TelegramAdoptionLink href={RECOMMENDED_SETUP_DEEP_LINK} placement="setup" target="_blank" rel="noopener noreferrer">
              Use recommended setup
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </TelegramAdoptionLink>
          </Button>
          <Button asChild variant="outline" className="gap-2">
            <TelegramAdoptionLink href={MINI_APP_SETUP_DEEP_LINK} placement="miniapp_setup" target="_blank" rel="noopener noreferrer">
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              Set up in the Mini App
            </TelegramAdoptionLink>
          </Button>
        </div>
      </div>
    </BotSection>
  );
}

const ALERT_CONTROLS: readonly { icon: LucideIcon; title: string; detail: string; command: string }[] = [
  {
    icon: ListChecks,
    title: "Preset watchlists",
    detail: "Follow cohorts like usd-top25 or mcap-ge-1b. Membership updates as the market changes.",
    command: "/presets",
  },
  {
    icon: SlidersHorizontal,
    title: "Per-coin thresholds",
    detail: "Choose the DEWS band, depeg step (100, 250 or 500 bps) and safety mode coin by coin.",
    command: "/set USDT dews WARNING",
  },
  {
    icon: MoonStar,
    title: "Quiet hours and snooze",
    detail: "Silence nights in your own timezone, or pause for 1h, 4h or 24h during a noisy market.",
    command: "/mute 22-07",
  },
  {
    icon: Sunrise,
    title: "Daily recap",
    detail: "One private summary each local day, sent only when your watched assets materially changed.",
    command: "/recap on",
  },
  {
    icon: Users,
    title: "Group watch desks",
    detail: "Add the bot to a Telegram group and address commands to it so one chat runs a shared desk.",
    command: "/subscribe@PharosWatchBot dews usd-top25",
  },
  {
    icon: MessageSquareText,
    title: "Ask on demand",
    detail: "Price, supply, DEWS band, safety grade and liquidity for any coin, plus /why, /top and /brief.",
    command: "/status USDC",
  },
];

export function AlertControls() {
  return (
    <BotSection
      id="controls"
      kicker="Low noise"
      title="Tuned to you, quiet by default"
      lead="Alerts fire only on change. Everything else is yours to tune, from the commands below or the Mini App."
    >
      <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {ALERT_CONTROLS.map((control) => {
          const Icon = control.icon;
          return (
            <li key={control.title} className="flex min-w-0 flex-col gap-2 border-t border-border/55 pt-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                {control.title}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">{control.detail}</p>
              <div className="mt-auto pt-1">
                <CommandChip command={control.command} />
              </div>
            </li>
          );
        })}
      </ul>
    </BotSection>
  );
}

export function MiniAppShowcase() {
  return (
    <section id="control" aria-labelledby="control-title" className="pharos-card-shell scroll-mt-24 p-5 sm:p-6 lg:p-7">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)] lg:items-center lg:gap-12">
        <div>
          <div className="max-w-2xl space-y-1.5">
            <p className="pharos-kicker">Mini App</p>
            <h2 id="control-title" className="pharos-section-title">
              The same alert state, without slash commands
            </h2>
            <p className="pharos-lead">
              Watchlist, presets, quiet hours, snooze and delivery health in a few taps. Deep reads like{" "}
              <code>/why</code>, <code>/brief</code> and <code>/top</code> stay in chat.
            </p>
          </div>
          <ul className="mt-6 grid gap-x-8 sm:grid-cols-2">
            {MINI_APP_FEATURES.map((feature) => (
              <li key={feature.title} className="border-t border-border/55 py-3">
                <p className="text-sm font-semibold text-foreground">{feature.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{feature.detail}</p>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button asChild className="gap-2">
              <TelegramAdoptionLink href={MINI_APP_HOME_DEEP_LINK} placement="miniapp_home" target="_blank" rel="noopener noreferrer">
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                Open the Mini App
              </TelegramAdoptionLink>
            </Button>
            <Button asChild variant="outline" className="gap-2">
              <TelegramAdoptionLink
                href={MINI_APP_WATCHLIST_DEEP_LINK}
                placement="miniapp_watchlist"
                target="_blank"
                rel="noopener noreferrer"
              >
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

export function TelegramChannels() {
  const channels = TELEGRAM_ACTIONS.filter((action) => !action.isPrimary);
  return (
    <BotSection id="channels" kicker="Also on Telegram" title="Market-wide reads, no setup">
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {channels.map((action) => (
          <div
            key={action.key}
            id={action.key === "digest" ? "channel" : "community"}
            className="flex scroll-mt-24 flex-col gap-2 border-t border-border/55 pt-4"
          >
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-foreground">
              {action.title}
              <span className="font-mono text-xs font-normal text-muted-foreground">{action.handle}</span>
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {action.description}
              {action.showArchiveLink ? (
                <>
                  {" "}
                  <Link href="/digest/" className={PROSE_LINK_CLASS}>
                    Browse the archive
                  </Link>
                  .
                </>
              ) : null}
            </p>
            <div className="mt-auto pt-1">
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <a href={action.href} target="_blank" rel="noopener noreferrer">
                  {action.cardButtonLabel}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              </Button>
            </div>
          </div>
        ))}
      </div>
    </BotSection>
  );
}

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

export function CommandReference() {
  return (
    <BotSection
      id="manual"
      kicker="Reference"
      title="Every command"
      lead="Copy any command into the bot. Filter by verb, setting or ticker."
    >
      <CommandManual />
    </BotSection>
  );
}

export function ReliabilityContract() {
  return (
    <BotSection
      id="reliability"
      kicker="Reliability and privacy"
      title="What Pharos promises, and what it does not"
      lead="Alerts are a bounded notification service, not a guaranteed emergency pager. Each message links back to Pharos so you can inspect the underlying signal."
    >
      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
        <div className="border-t border-border/55 pt-4">
          <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Radio className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Source cadence
          </dt>
          <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
            The dispatcher runs every {DISPATCH_CADENCE_LABEL}. Safety follows the live report-card publish path;
            reserve drift follows the four-hour live-reserve producer and only fires for supported live-reserve coins.
          </dd>
        </div>
        <div className="border-t border-border/55 pt-4">
          <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Bounded delivery
          </dt>
          <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Eligible alerts can send immediately or enter a retry queue. Risk alerts expire after {RISK_ALERT_TTL_LABEL};
            launch alerts after {LAUNCH_ALERT_TTL_LABEL} and admin broadcasts after {ADMIN_ALERT_TTL_LABEL}. Terminal
            and ambiguous outcomes stay visible to operators rather than being silently replayed.
          </dd>
        </div>
        <div className="border-t border-border/55 pt-4">
          <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <LockKeyhole className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Privacy
          </dt>
          <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Pharos stores your chat ID, optional username, follows, alert settings, quiet hours, snooze state, and
            short-lived command or queue metadata. Use <code>/forget</code> in a private chat for immediate deletion;
            inactive unsubscribed chats are pruned after 180 days.
          </dd>
        </div>
      </dl>
      <p className="pharos-meta mt-5">
        Adoption metrics are aggregate counts; small daily changes are hidden to avoid identifying individual chats.
        Read the full{" "}
        <Link href="/privacy/" className={PROSE_LINK_CLASS}>
          privacy policy
        </Link>{" "}
        or the{" "}
        <Link href="/methodology/" className={PROSE_LINK_CLASS}>
          methodology
        </Link>{" "}
        behind DEWS, safety grades and depeg scoring.
      </p>
    </BotSection>
  );
}

export function FinalCta() {
  return (
    <section
      aria-labelledby="final-cta-title"
      className="pharos-card-shell flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between lg:p-7"
    >
      <div className="max-w-2xl space-y-1.5">
        <h2 id="final-cta-title" className="pharos-section-title">
          Start getting alerts
        </h2>
        <p className="pharos-lead">
          Open the bot, approve one preset, and the next depeg, downgrade or freeze has somewhere to land.
        </p>
      </div>
      <Button asChild size="lg" className="w-fit gap-2">
        <TelegramAdoptionLink href={SETUP_DEEP_LINK} placement="hero" target="_blank" rel="noopener noreferrer">
          <Send className="h-4 w-4" aria-hidden="true" />
          Open in Telegram
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </TelegramAdoptionLink>
      </Button>
    </section>
  );
}
