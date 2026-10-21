import Link from "next/link";
import {
  ArrowRight,
  BellRing,
  CalendarClock,
  ExternalLink,
  Gauge,
  MoonStar,
  Send,
  Smartphone,
  ThumbsDown,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MINI_APP_HOME_DEEP_LINK,
  MINI_APP_SETUP_DEEP_LINK,
  RECOMMENDED_SETUP_DEEP_LINK,
  SETUP_DEEP_LINK,
} from "@/lib/telegram-route-constants";
import { BotSection } from "./bot-section";
import { CommandManual } from "./command-manual";
import { MiniAppScreenshotCarousel } from "./mini-app-screenshot-carousel";
import {
  DAILY_CHANGES_TIME,
  DAILY_LIVE_ALERT_CAP,
  LIVE_FREEZE_MIN_LABEL,
  MINI_APP_FEATURES,
  MINI_APP_SCREENSHOTS,
  TELEGRAM_ACTIONS,
} from "./telegram-content";

const PROSE_LINK_CLASS =
  "pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

/** Header CTAs. `#bot` is the anchor other routes link to for "get alerts". */
export function PrimaryActions() {
  return (
    <div id="bot" className="flex scroll-mt-24 flex-wrap items-center gap-x-3 gap-y-3 pt-2">
      <Button asChild size="lg" className="gap-2">
        <a href={SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
          <Send className="h-4 w-4" aria-hidden="true" />
          Open in Telegram
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </Button>
      <Button asChild size="lg" variant="outline" className="gap-2">
        <a href={MINI_APP_HOME_DEEP_LINK} target="_blank" rel="noopener noreferrer">
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          Open the Mini App
        </a>
      </Button>
      <p className="pharos-meta">Free. No sign-up beyond Telegram. Works in private chats and groups.</p>
    </div>
  );
}

const SETUP_STEPS = [
  {
    title: "Open @PharosWatchBot",
    detail: "Send /start in a private chat. A group works too; there, only admins can change settings.",
  },
  {
    title: "Follow the top 25 in one tap",
    detail: "Depeg and stress alerts for the 25 largest USD stablecoins, updated as the market moves.",
  },
  {
    title: "Adjust in Manage Alerts",
    detail: "Add or drop coins, set quiet hours, or pause. Changes save as you make them.",
  },
] as const;

/** Keeps the #getting-started anchor the HowTo JSON-LD and other routes point at. */
export function GettingStarted() {
  return (
    <BotSection
      id="getting-started"
      kicker="How it works"
      title="Start in two minutes"
      lead="One useful default now. Adjust only when you need to."
    >
      <ol className="grid gap-4 sm:grid-cols-3 sm:gap-6">
        {SETUP_STEPS.map((step, index) => (
          <li key={step.title} className="border-t border-border/55 pt-3 sm:pt-4">
            <p className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
              <span className="pharos-numeric text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              {step.title}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap gap-2.5 border-t border-border/55 pt-6">
        <Button asChild className="gap-2">
          <a href={RECOMMENDED_SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
            Follow the top 25
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </Button>
        <Button asChild variant="outline" className="gap-2">
          <a href={MINI_APP_SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
            <Smartphone className="h-4 w-4" aria-hidden="true" />
            Choose my coins
          </a>
        </Button>
      </div>
    </BotSection>
  );
}

const ALERT_CONTROLS: readonly { icon: LucideIcon; title: string; detail: string }[] = [
  {
    icon: BellRing,
    title: "Live only when it matters",
    detail: `Depegs, rising stress, severe downgrades and freezes of ${LIVE_FREEZE_MIN_LABEL} or more.`,
  },
  {
    icon: CalendarClock,
    title: "One daily Changes message",
    detail: `Smaller grade moves and reserve changes, together at ${DAILY_CHANGES_TIME} your time. Nothing changed, no message.`,
  },
  {
    icon: Gauge,
    title: `At most ${DAILY_LIVE_ALERT_CAP} a day`,
    detail: `Outside depegs, at most ${DAILY_LIVE_ALERT_CAP} live alerts a day. The rest wait for the Changes message.`,
  },
  {
    icon: ThumbsDown,
    title: "Fewer like this",
    detail: "Under every alert: mute the coin for 24 hours, pause all for 4, or turn that alert type down.",
  },
  {
    icon: MoonStar,
    title: "Quiet hours and pause",
    detail: "Silence nights in your timezone, or pause for 1, 4 or 24 hours.",
  },
  {
    icon: Users,
    title: "Group watch desks",
    detail: "Add the bot to a group to share alerts. Admins choose what it follows.",
  },
];

export function AlertControls() {
  return (
    <BotSection
      id="controls"
      kicker="Low noise"
      title="Quiet by default"
      lead="Few live alerts, one daily summary, and a one-tap way to turn anything down."
    >
      <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {ALERT_CONTROLS.map((control) => {
          const Icon = control.icon;
          return (
            <li key={control.title} className="flex min-w-0 flex-col gap-1 border-t border-border/55 pt-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                {control.title}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">{control.detail}</p>
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
              Manage Alerts, without typing commands
            </h2>
            <p className="pharos-lead">
              Tap Manage Alerts under any alert or next to the message box. One screen shows your coins and how
              quiet things are.
            </p>
          </div>
          {/* Phones see the same screens in the carousel right below, so the list starts at sm. */}
          <ul className="mt-5 hidden gap-x-8 sm:grid sm:grid-cols-2">
            {MINI_APP_FEATURES.map((feature) => (
              <li key={feature.title} className="border-t border-border/55 py-2.5">
                <p className="text-sm font-semibold text-foreground">{feature.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{feature.detail}</p>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            <Button asChild className="gap-2">
              <a href={MINI_APP_HOME_DEEP_LINK} target="_blank" rel="noopener noreferrer">
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                Open the Mini App
              </a>
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

export function CommandReference() {
  return (
    <BotSection
      id="manual"
      kicker="Commands"
      title="A short command list"
      lead="Everything also works from Manage Alerts. Type / in Telegram to open the menu."
    >
      <CommandManual />
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
          Follow the top 25 in one tap, and the next depeg or downgrade has somewhere to land.
        </p>
      </div>
      <Button asChild size="lg" className="w-fit gap-2">
        <a href={SETUP_DEEP_LINK} target="_blank" rel="noopener noreferrer">
          <Send className="h-4 w-4" aria-hidden="true" />
          Open in Telegram
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </Button>
    </section>
  );
}
