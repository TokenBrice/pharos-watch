import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ExternalLink, Bot, Users, Megaphone, ChevronDown } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { TelegramPulseStrip } from "./telegram-pulse-strip";

export const metadata: Metadata = buildPageMetadata({
  title: "Telegram Alerts & Digest: Stablecoin Notifications on Telegram",
  description:
    "Set up Telegram alerts for specific stablecoins, preset watchlists, or all tracked stablecoins by alert type: depeg events, depeg worsening, DEWS threat level changes, safety grade shifts, and launch promotions for pre-launch assets. Plus get the Pharos digest straight in Telegram.",
  canonical: "/telegram/",
  ogImage: `${SITE_URL}/og-telegram.png`,
});

const COIN_COUNT = ACTIVE_STABLECOINS.length;

/* -------------------------------------------------------------------------- */
/*  Data                                                                      */
/* -------------------------------------------------------------------------- */

const ALERT_EXAMPLES = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    tagline: "band boundary crossings with top stress sub-signals",
    content: `DEWS

USDT — WATCH → ALERT (score: 42)
Top signals: pool_balance_drift (0.61), supply_velocity (0.48)

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
    time: "09:41",
  },
  {
    key: "depeg",
    label: "Depeg Events",
    tagline: "trigger, worsening milestones, and resolution with price context",
    content: `Depeg Detected

USDC — below peg by 1.1% (112 bps)
Price: $0.9888 (peg: $1.00)

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    time: "09:43",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    tagline: "grade shifts after daily safety snapshot, methodology-only regrades suppressed",
    content: `Safety Grade Change

DAI — A- → B+
Score: 71 → 66

View on Pharos: pharos.watch/stablecoin/dai-makerdao`,
    time: "09:45",
  },
  {
    key: "launch",
    label: "Launch Promotions",
    tagline: "pre-launch assets moving live on Pharos, with presets intentionally excluded",
    content: `Stablecoin Launched

USDPT — US Dollar Payment Token has launched and is now tracked by Pharos

View on Pharos: pharos.watch/stablecoin/usdpt-western-union`,
    time: "09:47",
  },
] as const;

const COMMANDS = [
  { command: "/subscribe <types> all", description: "Enable alert types across all tracked stablecoins", example: "/subscribe depeg,safety all" },
  { command: "/subscribe <types> <targets>", description: "Enable alert types for coins or preset watchlists", example: "/subscribe dews,depeg USDT,USDC" },
  { command: "/status <ticker>", description: "Current peg, DEWS band, and safety grade for one coin — no subscription needed", example: "/status USDC" },
  { command: "/presets", description: "Show preset watchlists like usd-top25 or mcap-ge-1b", example: "/presets" },
  { command: "/unsubscribe <targets>", description: "Remove specific coin subscriptions or preset-expanded coins", example: "/unsubscribe usd-top25" },
  { command: "/unsubscribe all", description: "Clear all per-coin and all-stablecoin subscriptions", example: null },
  { command: "/set <ticker> <setting> <value>", description: "DEWS floor (WARNING/DANGER), safety direction (downgrade-only/upgrade-only), or depeg-step (100/250/500 bps)", example: "/set USDT dews WARNING" },
  { command: "/set all <setting> <value>", description: "Toggle dews, depeg, safety, or launch across every tracked coin", example: "/set all depeg off" },
  { command: "/mute <start>-<end>", description: "Silence Telegram notifications during UTC quiet hours", example: "/mute 22-07" },
  { command: "/unmutehours", description: "Disable quiet hours", example: null },
  { command: "/list", description: "Show global alerts, subscribed coins, settings, and quiet hours", example: null },
  { command: "/cancel", description: "Cancel a pending disambiguation prompt", example: null },
  { command: "/help", description: "Show command reference", example: null },
] as const;

/* -------------------------------------------------------------------------- */
/*  Subcomponents                                                             */
/* -------------------------------------------------------------------------- */

function AlertBubble({ content, time }: { content: string; time: string }) {
  return (
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
        {content}
      </div>
      <div className="mt-2 flex justify-end">
        <span className="text-[10px] text-white/50">{time}</span>
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
      className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
    >
      {children}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function TelegramPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Telegram Alerts"
      path="/telegram/"
      title="Telegram Alerts & Digest"
      containerClassName="mx-auto max-w-4xl"
      leadParagraphs={[]}
    >
      <div>
        {/* ================================================================= */}
        {/*  HERO: Featured alert + value prop                                */}
        {/* ================================================================= */}
        <section className="pharos-stagger-entrance flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
          {/* Left: copy + CTA */}
          <div className="flex-1 space-y-4 md:py-2" style={{ "--stagger-index": 0 } as CSSProperties}>
            <p className="text-lg font-semibold leading-snug tracking-tight text-foreground sm:text-xl">
              {COIN_COUNT} stablecoins watched.{" "}
              <span className="text-sky-600 dark:text-sky-400">You&rsquo;ll know first.</span>
            </p>
            <p className="pharos-lead max-w-lg">
              When a peg breaks, risk spikes, a safety grade shifts, or a pre-launch asset goes live,{" "}
              <TelegramLink href="https://t.me/PharosWatchBot">@PharosWatchBot</TelegramLink>{" "}
              messages you within the cron cycle &mdash; before you check Twitter.
              Free, configurable, no account needed.
            </p>
            <TelegramPulseStrip />
            <div className="flex flex-wrap gap-3 pt-1">
              <Button size="sm" asChild className="gap-2">
                <a href="https://t.me/PharosWatchBot" target="_blank" rel="noopener noreferrer">
                  <Bot className="h-4 w-4" />
                  Start PharosWatchBot
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild className="gap-2">
                <a href="https://t.me/pharoswatch" target="_blank" rel="noopener noreferrer">
                  <Megaphone className="h-4 w-4" />
                  Daily Digest
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild className="gap-2">
                <a href="https://t.me/pharoswatchers" target="_blank" rel="noopener noreferrer">
                  <Users className="h-4 w-4" />
                  Community
                </a>
              </Button>
            </div>
          </div>

          {/* Right: featured alert bubble */}
          <div className="w-full max-w-xs shrink-0 md:w-72 md:py-2" style={{ "--stagger-index": 1 } as CSSProperties}>
            <p className="pharos-kicker mb-2.5">DEWS escalation &mdash; bot-style preview</p>
            <AlertBubble content={ALERT_EXAMPLES[0].content} time={ALERT_EXAMPLES[0].time} />
          </div>
        </section>

        {/* ================================================================= */}
        {/*  THREE PRODUCT TILES                                              */}
        {/* ================================================================= */}
        <section className="pharos-stagger-entrance mt-12 grid grid-cols-1 gap-4 sm:grid-cols-3" id="products">
          {/* Alert Bot — primary */}
          <Card className="rounded-xl border-sky-500/30 bg-sky-500/[0.04] py-0 dark:border-sky-400/20 dark:bg-sky-400/[0.04]" style={{ "--stagger-index": 0 } as CSSProperties}>
            <CardContent className="flex h-full flex-col p-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500 dark:text-sky-400">
                  <Bot className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold leading-tight">Alert Bot</p>
                  <p className="text-[11px] text-muted-foreground">@PharosWatchBot</p>
                </div>
              </div>
              <p className="mt-3 flex-1 text-xs text-muted-foreground leading-relaxed">
                Per-coin or all-stablecoin alerts for DEWS changes, depegs, safety-grade moves,
                and launch promotions for pre-launch assets. Configurable thresholds and quiet hours.
              </p>
              <Button size="sm" asChild className="mt-3 w-full gap-2">
                <a href="https://t.me/PharosWatchBot" target="_blank" rel="noopener noreferrer">
                  Start Bot
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </CardContent>
          </Card>

          {/* Digest channel */}
          <Card className="rounded-xl py-0" style={{ "--stagger-index": 1 } as CSSProperties}>
            <CardContent className="flex h-full flex-col p-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Megaphone className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold leading-tight">Daily Digest</p>
                  <p className="text-[11px] text-muted-foreground">@pharoswatch</p>
                </div>
              </div>
              <p className="mt-3 flex-1 text-xs text-muted-foreground leading-relaxed">
                AI-written daily market recap every morning &mdash; peg deviations, supply shifts,
                liquidity changes, and emerging trends.{" "}
                <Link href="/digest" className="underline underline-offset-4 hover:text-sky-600 dark:hover:text-sky-400 transition-colors">
                  Browse archive &rarr;
                </Link>
              </p>
              <Button variant="outline" size="sm" asChild className="mt-3 w-full gap-2">
                <a href="https://t.me/pharoswatch" target="_blank" rel="noopener noreferrer">
                  Join Channel
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </CardContent>
          </Card>

          {/* Community */}
          <Card className="rounded-xl py-0" style={{ "--stagger-index": 2 } as CSSProperties}>
            <CardContent className="flex h-full flex-col p-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Users className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold leading-tight">Community</p>
                  <p className="text-[11px] text-muted-foreground">@pharoswatchers</p>
                </div>
              </div>
              <p className="mt-3 flex-1 text-xs text-muted-foreground leading-relaxed">
                The live crowd &mdash; readers swapping notes on fresh depegs, risk signals,
                and the market moves worth watching before the next digest lands.
              </p>
              <Button variant="outline" size="sm" asChild className="mt-3 w-full gap-2">
                <a href="https://t.me/pharoswatchers" target="_blank" rel="noopener noreferrer">
                  Join Community
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </CardContent>
          </Card>
        </section>

        {/* ================================================================= */}
        {/*  ALERT TYPES + EXAMPLE BUBBLES                                    */}
        {/* ================================================================= */}
        <section className="mt-12" id="alerts">
          <h2 className="pharos-section-title">What You Get</h2>
          <p className="mt-1.5 pharos-lead">
            Four alert types, each shown in the bot&apos;s current message style.
          </p>
          <div className="pharos-stagger-entrance mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            {ALERT_EXAMPLES.map((alert, i) => (
              <div key={alert.key} className="space-y-2.5" style={{ "--stagger-index": i } as CSSProperties}>
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {alert.label}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase text-muted-foreground">{alert.key}</code>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{alert.tagline}</p>
                </div>
                <AlertBubble content={alert.content} time={alert.time} />
              </div>
            ))}
          </div>
        </section>

        {/* ================================================================= */}
        {/*  HOW IT WORKS (cadence, volume, privacy)                          */}
        {/* ================================================================= */}
        <section className="mt-12" id="how-it-works">
          <h2 className="pharos-section-title">How It Works</h2>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="rounded-xl py-0">
              <CardContent className="p-5">
                <p className="text-sm font-semibold">Cadence</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  The dispatcher runs every 5 minutes. DEWS and depeg alerts arrive within one cycle.
                  Safety grades shift once daily after the safety snapshot, and launch alerts fire
                  within 5 minutes of a pre-launch asset going live.
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-xl py-0">
              <CardContent className="p-5">
                <p className="text-sm font-semibold">Volume</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  Expect zero alerts on a calm day, a handful during volatility. Dipping back into and
                  out of the same DEWS band in the same cycle is suppressed so you are not paged twice
                  for the same event. Every alert includes snooze buttons (1h / 4h / 24h).
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-xl py-0">
              <CardContent className="p-5">
                <p className="text-sm font-semibold">Privacy</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  We store your Telegram chat ID and the coins you follow — nothing else.
                  No personal data beyond a username if you have one. Run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/unsubscribe all</code>{" "}
                  at any time to clear your row.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-5 rounded-lg border border-border/60 bg-muted/30 p-4">
            <p className="text-sm font-semibold">DEWS bands</p>
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              Pharos scores each coin on five bands. Alerts fire when a coin enters{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">ALERT</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">WARNING</code>, or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">DANGER</code>.
              Use <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/set USDT dews WARNING</code>{" "}
              to raise the floor. See{" "}
              <Link href="/methodology#pegscore-dews-methodology" className="underline underline-offset-4 hover:text-foreground transition-colors">
                the DEWS methodology
              </Link>{" "}
              for scoring details.
            </p>
          </div>
        </section>

        {/* ================================================================= */}
        {/*  GETTING STARTED                                                  */}
        {/* ================================================================= */}
        <section className="mt-12" id="getting-started">
          <h2 className="pharos-section-title">Getting Started</h2>
          <ol className="mt-5 list-none space-y-5 text-sm text-muted-foreground leading-relaxed">
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden="true">1</span>
              <p>
                Open{" "}
                <TelegramLink href="https://t.me/PharosWatchBot">@PharosWatchBot</TelegramLink>{" "}
                in Telegram and send{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">/start</code>.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden="true">2</span>
              <div className="space-y-3 flex-1">
                <p>Subscribe and tune:</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/subscribe dews,depeg USDT,USDC</code>
                    <p className="mt-1 text-xs text-muted-foreground">Per-coin alerts for specific stablecoins</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/presets</code>
                    <p className="mt-1 text-xs text-muted-foreground">Browse preset watchlists directly inside the bot</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/subscribe dews usd-top25</code>
                    <p className="mt-1 text-xs text-muted-foreground">Follow the current top USD stablecoins without listing them one by one</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/subscribe safety mcap-ge-1b</code>
                    <p className="mt-1 text-xs text-muted-foreground">Track every active stablecoin above the chosen market-cap floor</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/subscribe safety all</code>
                    <p className="mt-1 text-xs text-muted-foreground">All-stablecoin alerts by type</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/subscribe launch USDPT</code>
                    <p className="mt-1 text-xs text-muted-foreground">Launch alerts for explicit pre-launch tickers or coin IDs</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/set USDT dews WARNING</code>
                    <p className="mt-1 text-xs text-muted-foreground">Only alert when DEWS reaches WARNING or DANGER</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/set DAI safety downgrade-only</code>
                    <p className="mt-1 text-xs text-muted-foreground">Silence upgrades; fire only on safety-grade regressions</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/set USDC depeg-step 250</code>
                    <p className="mt-1 text-xs text-muted-foreground">Worsening-depeg milestones every 250 bps</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/mute 22-07</code>
                    <p className="mt-1 text-xs text-muted-foreground">Quiet hours overnight (UTC)</p>
                  </div>
                </div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground" aria-hidden="true">3</span>
              <p>
                Done &mdash; alerts arrive automatically when conditions change. Use{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">/list</code>{" "}
                at any time to check your active subscriptions, and{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">/presets</code>{" "}
                to discover preset watchlists from inside Telegram.
              </p>
            </li>
          </ol>
        </section>

        {/* ================================================================= */}
        {/*  COMMAND REFERENCE (collapsible)                                  */}
        {/* ================================================================= */}
        <section className="mt-12" id="commands">
          <details className="pharos-card-shell overflow-hidden group">
            <summary className="flex cursor-pointer items-center justify-between px-5 py-4 text-sm font-semibold select-none hover:bg-muted/30 transition-colors [&::-webkit-details-marker]:hidden list-none">
              <span className="flex items-center gap-2.5">
                Command Reference
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">{COMMANDS.length}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-border/60 px-5 py-4 space-y-4">
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left">
                      <th scope="col" className="pb-3 pr-4 font-medium text-xs text-muted-foreground uppercase tracking-wider">Command</th>
                      <th scope="col" className="pb-3 pr-4 font-medium text-xs text-muted-foreground uppercase tracking-wider">Description</th>
                      <th scope="col" className="hidden pb-3 font-medium text-xs text-muted-foreground uppercase tracking-wider sm:table-cell">Example</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {COMMANDS.map((cmd) => (
                      <tr key={cmd.command} className="group/row hover:bg-muted/40 transition-colors">
                        <td className="py-3 pr-4 align-top">
                          <code className="inline-flex items-center rounded bg-muted px-2 py-1 text-xs font-mono text-foreground whitespace-nowrap">{cmd.command}</code>
                        </td>
                        <td className="py-3 pr-4 align-top text-muted-foreground">{cmd.description}</td>
                        <td className="hidden py-3 align-top sm:table-cell">
                          {cmd.example ? (
                            <code className="rounded bg-muted/70 px-2 py-1 text-xs font-mono text-foreground/80 whitespace-nowrap">{cmd.example}</code>
                          ) : (
                            <span className="text-muted-foreground/50">&mdash;</span>
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
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono text-foreground">all</code>{" "}
                  to follow an alert type across every tracked stablecoin. Launch alerts still require explicit tickers or coin IDs and do not support presets. Unknown tickers get a closest-match suggestion when possible.
                </p>
              </div>
            </div>
          </details>
        </section>

        {/* ================================================================= */}
        {/*  FINAL CTA                                                        */}
        {/* ================================================================= */}
        <div className="mt-12 pharos-card-shell border-t-2 border-t-sky-500/40 p-6 dark:border-t-sky-400/30 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{COIN_COUNT} pegs. Zero blind spots.</h3>
              <p className="text-sm text-muted-foreground">
                Start @PharosWatchBot for instant alerts and launch notices, join @pharoswatch for the daily digest,
                or drop into @pharoswatchers for the live community feed.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 shrink-0">
              <Button size="sm" asChild className="gap-2">
                <a href="https://t.me/PharosWatchBot" target="_blank" rel="noopener noreferrer">
                  <Bot className="h-4 w-4" />
                  Start Bot
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild className="gap-2">
                <a href="https://t.me/pharoswatch" target="_blank" rel="noopener noreferrer">
                  <Megaphone className="h-4 w-4" />
                  Digest
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild className="gap-2">
                <a href="https://t.me/pharoswatchers" target="_blank" rel="noopener noreferrer">
                  <Users className="h-4 w-4" />
                  Community
                </a>
              </Button>
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs text-muted-foreground">
          Want the methodology behind these alerts?{" "}
          <Link href="/methodology" className="underline underline-offset-4 hover:text-foreground transition-colors">
            Read the methodology page
          </Link>{" "}
          for DEWS, safety-grade, and depeg scoring details.
        </p>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "PharosWatchBot",
              applicationCategory: "FinanceApplication",
              operatingSystem: "Telegram",
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
              url: `${SITE_URL}/telegram/`,
              description:
                "Opt-in Telegram bot for stablecoin peg, DEWS, safety, and launch alerts.",
              publisher: { "@type": "Organization", name: "Pharos Watch", url: SITE_URL },
            }),
          }}
        />
      </div>
    </FeaturePageShell>
  );
}
