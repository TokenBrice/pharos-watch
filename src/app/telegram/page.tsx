import type { Metadata } from "next";
import Link from "next/link";
import { Bell, MessageSquare, Send, ExternalLink, Bot } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Telegram Alerts & Digest: Stablecoin Notifications on Telegram",
  description:
    "Set up Telegram alerts for specific stablecoins or all tracked stablecoins by alert type: depeg events, depeg worsening, DEWS threat level changes, and daily safety grade shifts. Plus get the Pharos digest straight in Telegram.",
  canonical: "/telegram/",
});

const ALERT_TYPES = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    description:
      "Fires on band boundary crossings, includes top 2 stress sub-signals",
  },
  {
    key: "depeg",
    label: "Depeg Events",
    description:
      "Fires on trigger, worsening milestones, and resolution with deviation and price context",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    description:
      "Fires on grade changes after the daily safety snapshot, with methodology-only regrades suppressed",
  },
] as const;

const FOLLOW_MODES = [
  {
    key: "per-coin",
    label: "Per-Coin Follows",
    description:
      "Build a watchlist and mix alert types per stablecoin, with thresholds and modes where needed.",
    example: "/subscribe dews,depeg USDT,USDC",
  },
  {
    key: "all-coins",
    label: "All-Stablecoin Follows",
    description:
      "Turn one alert type on across every tracked stablecoin with a single command, then switch it off later with /set all.",
    example: "/subscribe safety all",
  },
] as const;

const COMMANDS = [
  {
    command: "/subscribe <types> all",
    description: "Enable alert types across all tracked stablecoins",
    example: "/subscribe depeg,safety all",
    common: true,
  },
  {
    command: "/subscribe <types> <tickers>",
    description: "Enable alert types and subscribe to coins",
    example: "/subscribe dews,depeg USDT,USDC",
    common: true,
  },
  {
    command: "/unsubscribe <tickers>",
    description: "Remove specific coin subscriptions",
    example: "/unsubscribe USDT",
    common: false,
  },
  {
    command: "/unsubscribe all",
    description: "Clear all per-coin and all-stablecoin subscriptions",
    example: null,
    common: false,
  },
  {
    command: "/set <ticker> <setting> <value>",
    description: "Tune per-coin thresholds and modes",
    example: "/set USDC depeg-step 250",
    common: false,
  },
  {
    command: "/set all <setting> <value>",
    description: "Turn global all-stablecoin alert types on or off",
    example: "/set all depeg off",
    common: false,
  },
  {
    command: "/mute <start>-<end>",
    description: "Silence Telegram notifications during UTC quiet hours",
    example: "/mute 22-07",
    common: false,
  },
  {
    command: "/unmutehours",
    description: "Disable quiet hours",
    example: null,
    common: false,
  },
  {
    command: "/list",
    description: "Show global alerts, subscribed coins, settings, and quiet hours",
    example: null,
    common: true,
  },
  {
    command: "/cancel",
    description: "Cancel a pending disambiguation prompt",
    example: null,
    common: false,
  },
  {
    command: "/help",
    description: "Show command reference",
    example: null,
    common: true,
  },
] as const;

const EXAMPLE_MESSAGES = [
  {
    label: "DEWS band escalation",
    content: `DEWS Band Change: USDT
WATCH -> ALERT (score: 42)

Top stress signals:
  pool_balance_drift: 0.61
  supply_velocity: 0.48

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
    color: "amber",
  },
  {
    label: "Depeg triggered",
    content: `Depeg Triggered: USDC
Direction: below peg
Deviation: -112 bps
Price: $0.9888

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    color: "red",
  },
  {
    label: "Safety grade change",
    content: `Safety Grade Change: DAI
Grade: A- -> B+
Score: 71

View on Pharos: pharos.watch/stablecoin/dai-makerdao`,
    color: "emerald",
  },
] as const;

export default function TelegramPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Telegram Alerts"
      path="/telegram/"
      title="Telegram Alerts & Digest"
      containerClassName="mx-auto max-w-4xl"
      leadParagraphs={[
        "Two ways to get Pharos data in Telegram: a public channel for the daily digest, and a bot for per-coin alerts or all-stablecoin alert-type follows covering DEWS changes, depegs, worsening depegs, and daily safety-grade moves.",
      ]}
    >
      <div className="space-y-6">
        {/* Daily Digest Channel */}
        <Card className="rounded-xl border-l-[3px] border-l-sky-500" id="channel">
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <Send className="h-5 w-5 text-sky-700 dark:text-sky-400" />
              Daily Digest Channel
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
            <p>
              The{" "}
              <a
                href="https://t.me/pharoswatch"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                @pharoswatch
                <ExternalLink className="h-3 w-3" />
              </a>{" "}
              channel posts an AI-written daily recap of the stablecoin market
              every morning &mdash; covering peg deviations, supply shifts,
              liquidity changes, and emerging trends.
            </p>
            <p>
              Join the channel to get the digest straight to your Telegram feed.
              For the full searchable archive, visit the{" "}
              <Link
                href="/digest"
                className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                digest page
              </Link>
              .
            </p>
          </CardContent>
        </Card>

        {/* Alert Bot */}
        <Card
          className="rounded-xl border-l-[3px] border-l-amber-500"
          id="bot"
        >
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-amber-700 dark:text-amber-400" />
              Alert Bot
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-5">
            <p>
              <a
                href="https://t.me/PharosWatchBot"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-amber-500 transition-colors"
              >
                @PharosWatchBot
                <ExternalLink className="h-3 w-3" />
              </a>{" "}
              sends you cron-driven alerts for the stablecoins you care about.
              DEWS and depeg alerts are near-real-time within the bot&apos;s cron cadence. Safety alerts are checked after the daily safety snapshot. You can subscribe per coin or follow all tracked stablecoins by alert type, with optional per-coin settings and quiet hours.
            </p>
            
            {/* Follow Modes */}
            <div className="space-y-3">
              <p className="pharos-kicker">Follow Modes</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {FOLLOW_MODES.map((mode) => (
                  <div
                    key={mode.key}
                    className="rounded-lg border p-3 space-y-2 bg-background/50"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {mode.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {mode.description}
                    </p>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono text-foreground">
                      {mode.example}
                    </code>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Alert Types */}
            <div className="space-y-3">
              <p className="pharos-kicker">Alert Types</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {ALERT_TYPES.map((alert) => (
                  <div
                    key={alert.key}
                    className="rounded-lg border p-4 space-y-2 bg-background/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase">
                        {alert.key}
                      </span>
                    </div>
                    <p className="text-foreground font-medium text-sm">
                      {alert.label}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {alert.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Getting Started */}
        <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
              Getting Started
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-5">
            {/* Step 1 */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                1
              </span>
              <p>
                Open{" "}
                <a
                  href="https://t.me/PharosWatchBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-emerald-500 transition-colors"
                >
                  @PharosWatchBot
                  <ExternalLink className="h-3 w-3" />
                </a>{" "}
                in Telegram and send{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  /start
                </code>
                .
              </p>
            </div>

            {/* Step 2 */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                2
              </span>
              <div className="space-y-4 flex-1">
                <p>Pick a follow mode, then add any tuning you want:</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3 space-y-1.5 bg-background/50">
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe dews,depeg USDT,USDC
                    </code>
                    <p className="text-xs text-muted-foreground">
                      DEWS + depeg alerts for the two largest stablecoins
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 space-y-1.5 bg-background/50">
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe safety all
                    </code>
                    <p className="text-xs text-muted-foreground">
                      Safety-grade alerts for every tracked stablecoin
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 space-y-1.5 bg-background/50">
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /set all safety off
                    </code>
                    <p className="text-xs text-muted-foreground">
                      Turn global safety stream off without touching your watchlist
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 space-y-1.5 bg-background/50">
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /set USDC depeg-step 250
                    </code>
                    <p className="text-xs text-muted-foreground">
                      Add worsening-depeg follow-ups every additional 250 bps
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 space-y-1.5 bg-background/50">
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /set DAI safety downgrade-only
                    </code>
                    <p className="text-xs text-muted-foreground">
                      Only notify on safety downgrades, ignore upgrades
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 space-y-1.5 bg-background/50">
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /mute 22-07
                    </code>
                    <p className="text-xs text-muted-foreground">
                      Silence notifications overnight (UTC 22:00-07:00)
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                3
              </span>
              <p>
                Done &mdash; alerts arrive automatically when conditions change.
                Use{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  /list
                </code>{" "}
                at any time to check your active subscriptions.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* What Alerts Look Like */}
        <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
          <CardHeader>
            <CardTitle as="h2">What Alerts Look Like</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Real alert messages from @PharosWatchBot look like this:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {EXAMPLE_MESSAGES.map((msg) => (
                <div key={msg.label} className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {msg.label}
                  </p>
                  {/* Telegram Message Bubble Style */}
                  <div className="relative">
                    {/* Message bubble */}
                    <div 
                      className={`
                        relative rounded-2xl rounded-tl-sm p-3 
                        bg-[#1e3a5f] dark:bg-[#2b5278]
                        text-white
                        shadow-md
                      `}
                    >
                      {/* Bot header */}
                      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-white/10">
                        <img
                          src="/pharos-icon.png"
                          alt=""
                          className="h-5 w-5 rounded-full"
                        />
                        <span className="text-xs font-medium text-white/90">PharosWatchBot</span>
                      </div>
                      {/* Message content */}
                      <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed text-white/95">
                        {msg.content}
                      </pre>
                      {/* Time indicator */}
                      <div className="mt-2 flex justify-end">
                        <span className="text-[10px] text-white/50">09:41</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Command Reference */}
        <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
          <CardHeader>
            <CardTitle as="h2">Command Reference</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left">
                    <th className="pb-3 pr-4 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Command
                    </th>
                    <th className="pb-3 pr-4 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Description
                    </th>
                    <th className="pb-3 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Example
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {COMMANDS.map((cmd) => (
                    <tr 
                      key={cmd.command} 
                      className="group hover:bg-muted/40 transition-colors"
                    >
                      <td className="py-3 pr-4 align-top">
                        <code className="inline-flex items-center rounded bg-muted px-2 py-1 text-xs font-mono text-foreground whitespace-nowrap">
                          {cmd.command}
                        </code>
                      </td>
                      <td className="py-3 pr-4 align-top text-muted-foreground">
                        {cmd.description}
                      </td>
                      <td className="py-3 align-top">
                        {cmd.example ? (
                          <code className="rounded bg-muted/70 px-2 py-1 text-xs font-mono text-foreground/80 whitespace-nowrap">
                            {cmd.example}
                          </code>
                        ) : (
                          <span className="text-muted-foreground/50">
                            &mdash;
                          </span>
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
                Ticker matching is case-insensitive. Exact Pharos coin IDs also work, which is useful when a ticker is ambiguous. Use{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono text-foreground">
                  all
                </code>{" "}
                to follow an alert type across every tracked stablecoin. Unknown tickers get a closest-match suggestion when possible.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Final CTA */}
        <div className="pharos-card-shell p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">Ready to get started?</h3>
              <p className="text-sm text-muted-foreground">
                Join @pharoswatch for daily digests or chat with @PharosWatchBot for instant alerts.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                size="sm"
                asChild
                className="gap-2"
              >
                <a
                  href="https://t.me/pharoswatch"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Send className="h-4 w-4" />
                  Join Channel
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
              <Button
                size="sm"
                asChild
                className="gap-2"
              >
                <a
                  href="https://t.me/PharosWatchBot"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Bot className="h-4 w-4" />
                  Start Bot
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </FeaturePageShell>
  );
}
