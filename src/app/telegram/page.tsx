import type { Metadata } from "next";
import Link from "next/link";
import { Bell, MessageSquare, Send } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Telegram Alerts & Digest: Real-Time Stablecoin Notifications",
  description:
    "Set up per-coin Telegram alerts for depeg events, DEWS threat level changes, and safety grade shifts. Plus get the daily Pharos stablecoin digest straight to your feed.",
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
      "Fires on depeg trigger and resolution, includes deviation in bps and price",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    description:
      "Fires on letter grade changes, delivered daily after snapshot",
  },
] as const;

const COMMANDS = [
  {
    command: "/subscribe <types> <tickers>",
    description: "Enable alert types and subscribe to coins",
    example: "/subscribe dews,depeg USDT,USDC",
  },
  {
    command: "/unsubscribe <tickers>",
    description: "Remove specific coin subscriptions",
    example: "/unsubscribe USDT",
  },
  {
    command: "/unsubscribe all",
    description: "Clear all subscriptions and disable all alerts",
    example: null,
  },
  {
    command: "/list",
    description: "Show your enabled alert types and subscribed coins",
    example: null,
  },
  {
    command: "/help",
    description: "Show command reference",
    example: null,
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

View on Pharos: pharos.watch/stablecoin/tether`,
  },
  {
    label: "Depeg triggered",
    content: `Depeg Triggered: USDC
Direction: below peg
Deviation: -112 bps
Price: $0.9888

View on Pharos: pharos.watch/stablecoin/usd-coin`,
  },
  {
    label: "Safety grade change",
    content: `Safety Grade Change: DAI
Grade: A- -> B+
Score: 71

View on Pharos: pharos.watch/stablecoin/dai`,
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
        "Two ways to get Pharos data in Telegram: a public channel for the daily digest, and a bot for per-coin real-time alerts on depeg events, DEWS threat levels, and safety grade changes.",
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
                className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
              >
                @pharoswatch
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

        {/* Per-Coin Alert Bot */}
        <Card
          className="rounded-xl border-l-[3px] border-l-amber-500"
          id="bot"
        >
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-amber-700 dark:text-amber-400" />
              Per-Coin Alert Bot
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-4">
            <p>
              <a
                href="https://t.me/PharosDigestBot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-amber-500 transition-colors"
              >
                @PharosDigestBot
              </a>{" "}
              sends you real-time alerts for the stablecoins you care about.
              Subscribe to any combination of alert types and coins.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {ALERT_TYPES.map((alert) => (
                <div
                  key={alert.key}
                  className="rounded-lg border p-3 space-y-1"
                >
                  <p className="text-foreground font-medium">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                      {alert.key}
                    </span>
                  </p>
                  <p className="text-foreground font-medium text-sm">
                    {alert.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {alert.description}
                  </p>
                </div>
              ))}
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
                  href="https://t.me/PharosDigestBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4 hover:text-emerald-500 transition-colors"
                >
                  @PharosDigestBot
                </a>{" "}
                in Telegram and send{" "}
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  /start
                </span>
                .
              </p>
            </div>

            {/* Step 2 */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                2
              </span>
              <div className="space-y-3">
                <p>Subscribe to the coins and alert types you want:</p>
                <div className="space-y-2">
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe dews,depeg USDT,USDC
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      DEWS + depeg alerts for the two largest stablecoins
                    </p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe safety USDS,frxUSD,fxUSD
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Get notified when USDS, frxUSD or fxUSD safety score changes
                    </p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">
                      /subscribe dews,depeg,safety USDT,USDC,DAI,FRAX,GHO
                    </code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      All alert types for a diversified watchlist
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
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  /list
                </span>{" "}
                at any time to check your active subscriptions.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* What Alerts Look Like */}
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle as="h2">What Alerts Look Like</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {EXAMPLE_MESSAGES.map((msg) => (
                <div key={msg.label} className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    {msg.label}
                  </p>
                  <pre className="whitespace-pre-wrap rounded-lg border bg-muted/50 p-3 text-xs font-mono leading-relaxed text-foreground">
                    {msg.content}
                  </pre>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Command Reference */}
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle as="h2">Command Reference</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Command</th>
                    <th className="pb-2 pr-4 font-medium">Description</th>
                    <th className="pb-2 font-medium">Example</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {COMMANDS.map((cmd) => (
                    <tr key={cmd.command}>
                      <td className="py-2 pr-4 align-top">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono whitespace-nowrap">
                          {cmd.command}
                        </code>
                      </td>
                      <td className="py-2 pr-4 align-top text-muted-foreground">
                        {cmd.description}
                      </td>
                      <td className="py-2 align-top">
                        {cmd.example ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono whitespace-nowrap">
                            {cmd.example}
                          </code>
                        ) : (
                          <span className="text-muted-foreground">
                            &mdash;
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Ticker matching is case-insensitive and requires an exact symbol
              match. If an unknown ticker is close to a known symbol, the bot
              will suggest the closest match.
            </p>
          </CardContent>
        </Card>
      </div>
    </FeaturePageShell>
  );
}
