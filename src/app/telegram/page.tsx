import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Send, ExternalLink, Bot } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Telegram Alerts & Digest: Stablecoin Notifications on Telegram",
  description:
    "Set up Telegram alerts for specific stablecoins or all tracked stablecoins by alert type: depeg events, depeg worsening, DEWS threat level changes, and daily safety grade shifts. Plus get the Pharos digest straight in Telegram.",
  canonical: "/telegram/",
  ogImage: "https://pharos.watch/og-telegram.png",
});

const ALERT_TYPES = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    description:
      "fires on band boundary crossings, includes top 2 stress sub-signals",
  },
  {
    key: "depeg",
    label: "Depeg Events",
    description:
      "fires on trigger, worsening milestones, and resolution with deviation and price context",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    description:
      "fires on grade changes after the daily safety snapshot, with methodology-only regrades suppressed",
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
    time: "09:41",
  },
  {
    label: "Depeg triggered",
    content: `Depeg Triggered: USDC
Direction: below peg
Deviation: -112 bps
Price: $0.9888

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    time: "09:43",
  },
  {
    label: "Safety grade change",
    content: `Safety Grade Change: DAI
Grade: A- -> B+
Score: 71

View on Pharos: pharos.watch/stablecoin/dai-makerdao`,
    time: "09:45",
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
        "A public channel for the daily digest, and a bot for per-coin or all-stablecoin alerts covering DEWS changes, depegs, and safety-grade moves.",
      ]}
    >
      <div>
        {/* --- Product overview: Digest channel + Alert bot --- */}
        <div className="space-y-4">
          {/* Daily Digest Channel */}
          <Card className="rounded-xl" id="channel">
            <CardHeader>
              <CardTitle as="h2">Daily Digest Channel</CardTitle>
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
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
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
          <Card className="rounded-xl" id="bot">
            <CardHeader>
              <CardTitle as="h2">Alert Bot</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-5">
              <p>
                <a
                  href="https://t.me/PharosWatchBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
                >
                  @PharosWatchBot
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>{" "}
                sends you cron-driven alerts for the stablecoins you care about.
                DEWS and depeg alerts are near-real-time within the bot&apos;s cron cadence. Safety alerts are checked after the daily safety snapshot. You can subscribe per coin or follow all tracked stablecoins by alert type, with optional per-coin settings and quiet hours.
              </p>

              {/* Alert Types — flat definition list */}
              <div className="space-y-2.5">
                <p className="pharos-kicker">Alert Types</p>
                <dl className="space-y-1.5">
                  {ALERT_TYPES.map((alert) => (
                    <div key={alert.key} className="text-xs leading-relaxed">
                      <dt className="inline">
                        <span className="font-medium text-foreground">{alert.label}</span>
                        <code className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-mono uppercase">{alert.key}</code>
                      </dt>
                      {" "}<dd className="inline text-muted-foreground">&mdash; {alert.description}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* --- Getting Started (bare section, semantic ordered list) --- */}
        <section className="mt-12" id="getting-started">
          <h2 className="text-lg font-semibold leading-none tracking-tight">
            Getting Started
          </h2>
          <ol className="mt-5 list-none space-y-5 text-sm text-muted-foreground leading-relaxed">
            {/* Step 1 */}
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden="true">
                1
              </span>
              <p>
                Open{" "}
                <a
                  href="https://t.me/PharosWatchBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
                >
                  @PharosWatchBot
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>{" "}
                in Telegram and send{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  /start
                </code>
                .
              </p>
            </li>

            {/* Step 2 */}
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden="true">
                2
              </span>
              <div className="space-y-3 flex-1">
                <p>Subscribe and tune:</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe dews,depeg USDT,USDC
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Per-coin alerts for specific stablecoins
                    </p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe safety all
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      All-stablecoin alerts by type
                    </p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /set USDC depeg-step 250
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Worsening-depeg milestones every 250 bps
                    </p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /mute 22-07
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Quiet hours overnight (UTC)
                    </p>
                  </div>
                </div>
              </div>
            </li>

            {/* Step 3 */}
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden="true">
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
            </li>
          </ol>
        </section>

        {/* --- What Alerts Look Like (bare section) --- */}
        <section className="mt-10" id="examples">
          <h2 className="text-lg font-semibold leading-none tracking-tight">
            What Alerts Look Like
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Real alerts from @PharosWatchBot:
          </p>
          <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
            {EXAMPLE_MESSAGES.map((msg) => (
              <div key={msg.label} className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {msg.label}
                </p>
                <div className="relative">
                  {/* Telegram-style message bubble (intentional Telegram brand colors) */}
                  <div className="relative rounded-2xl rounded-tl-sm p-3 bg-[#1e3a5f] text-white shadow-md dark:bg-[#2b5278]">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-white/10">
                      <Image
                        src="/pharos-icon.png"
                        alt="Pharos bot avatar"
                        width={20}
                        height={20}
                        className="rounded-full"
                      />
                      <span className="text-xs font-medium text-white/90">PharosWatchBot</span>
                    </div>
                    <div className="whitespace-pre-wrap text-xs font-mono leading-relaxed text-white/95">
                      {msg.content}
                    </div>
                    <div className="mt-2 flex justify-end">
                      <span className="text-[10px] text-white/50">{msg.time}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* --- Command Reference (card — table benefits from containment) --- */}
        <Card className="mt-8 rounded-xl">
          <CardHeader>
            <CardTitle as="h2">Command Reference</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left">
                    <th scope="col" className="pb-3 pr-4 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Command
                    </th>
                    <th scope="col" className="pb-3 pr-4 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Description
                    </th>
                    <th scope="col" className="hidden pb-3 font-medium text-xs text-muted-foreground uppercase tracking-wider sm:table-cell">
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
                      <td className="hidden py-3 align-top sm:table-cell">
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

        {/* --- Final CTA --- */}
        <div className="mt-10 pharos-card-shell p-6 sm:p-8">
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
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
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
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </FeaturePageShell>
  );
}
