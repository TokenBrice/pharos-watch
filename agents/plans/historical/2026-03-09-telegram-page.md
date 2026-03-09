# /telegram Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a `/telegram` page under the Tools section showcasing the Pharos Telegram channel (daily digest) and alert bot (per-coin subscriptions), then consolidate all Telegram references across the site to point here.

**Architecture:** Static Next.js page using `FeaturePageShell` with `max-w-4xl` container (content page, not dashboard). Cards for each section. No client component needed — pure static markup.

**Tech Stack:** Next.js metadata, FeaturePageShell, Card/CardContent/CardHeader/CardTitle from shadcn, lucide-react icons (Send, Bell, MessageSquare), Link from next/link.

---

### Task 1: Create the /telegram page

**Files:**
- Create: `src/app/telegram/page.tsx`

**Step 1: Create the page file**

```tsx
import Link from "next/link";
import { Send, Bell, MessageSquare } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata = buildPageMetadata({
  title: "Telegram Alerts & Digest: Real-Time Stablecoin Notifications",
  description:
    "Set up per-coin Telegram alerts for depeg events, DEWS threat level changes, and safety grade shifts. Plus get the daily Pharos stablecoin digest straight to your feed.",
  canonical: "/telegram/",
});

const ALERT_TYPES = [
  {
    type: "dews",
    label: "DEWS Threat Level",
    description:
      "Fires when a coin's Depeg Early Warning score crosses a threat band boundary (e.g. Calm to Elevated). Includes the top two stress sub-signals driving the move.",
  },
  {
    type: "depeg",
    label: "Depeg Events",
    description:
      "Fires when a coin depegs (price deviates beyond threshold) and again when it recovers. Includes deviation in basis points, price, and duration on resolution.",
  },
  {
    type: "safety",
    label: "Safety Grade Changes",
    description:
      "Fires when a coin's safety letter grade changes (e.g. A- to B+). Delivered daily after the grade snapshot, so you're never surprised by a downgrade.",
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

// Realistic alert message previews (what users actually receive)
const EXAMPLE_MESSAGES = [
  {
    label: "DEWS band escalation",
    text: `DEWS Band Change: USDT
Calm -> Elevated (score: 34)

Top stress signals:
  pool_balance_drift: 0.42
  supply_velocity: 0.38

View on Pharos: pharos.watch/stablecoin/tether`,
  },
  {
    label: "Depeg triggered",
    text: `Depeg Triggered: USDC
Direction: below peg
Deviation: -112 bps
Price: $0.9888

View on Pharos: pharos.watch/stablecoin/usd-coin`,
  },
  {
    label: "Safety grade change",
    text: `Safety Grade Change: DAI
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
      <div className="space-y-8">
        {/* --- Daily Digest Channel --- */}
        <Card className="rounded-xl border-l-[3px] border-l-sky-500">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Send className="h-5 w-5 text-sky-600 dark:text-sky-400" />
              <CardTitle as="h2">Daily Digest Channel</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-3">
            <p>
              Every morning, Pharos generates an AI-written stablecoin market recap covering supply shifts,
              peg deviations, liquidity changes, and emerging trends. The digest is posted automatically to the
              public Telegram channel.
            </p>
            <p>
              <a
                href="https://t.me/pharoswatch"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors font-medium"
              >
                Join @pharoswatch on Telegram&nbsp;&rarr;
              </a>
            </p>
            <p className="text-xs text-muted-foreground/70">
              The full archive is also available on the{" "}
              <Link href="/digest" className="underline underline-offset-4 hover:text-foreground transition-colors">
                Digest page
              </Link>.
            </p>
          </CardContent>
        </Card>

        {/* --- Alert Bot: What it does --- */}
        <Card className="rounded-xl border-l-[3px] border-l-amber-500">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              <CardTitle as="h2">Per-Coin Alert Bot</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-4">
            <p>
              <a
                href="https://t.me/PharosDigestBot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-amber-500 transition-colors font-medium"
              >
                @PharosDigestBot
              </a>{" "}
              lets you subscribe to real-time alerts for the stablecoins you care about.
              Pick one or more alert types, pick your coins, and the bot handles the rest.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {ALERT_TYPES.map((alert) => (
                <div key={alert.type} className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1.5">
                  <p className="font-medium text-foreground flex items-center gap-1.5">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{alert.type}</code>
                    <span className="text-xs">{alert.label}</span>
                  </p>
                  <p className="text-xs leading-relaxed">{alert.description}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* --- Getting Started --- */}
        <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
          <CardHeader>
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              <CardTitle as="h2">Getting Started</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-5">
            <div className="space-y-4">
              <div className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-600 dark:text-emerald-400">1</span>
                <div className="space-y-1">
                  <p className="text-foreground font-medium">Open the bot</p>
                  <p>
                    Start a chat with{" "}
                    <a
                      href="https://t.me/PharosDigestBot"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground underline underline-offset-4 hover:text-emerald-500 transition-colors"
                    >
                      @PharosDigestBot
                    </a>{" "}
                    on Telegram and send <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">/start</code>.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-600 dark:text-emerald-400">2</span>
                <div className="space-y-2">
                  <p className="text-foreground font-medium">Subscribe to alerts</p>
                  <p>Pick your alert types and coins in a single command. Copy-paste any of these to get started:</p>
                  <div className="space-y-2">
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
                      <code className="text-xs font-mono text-foreground">/subscribe dews,depeg USDT,USDC</code>
                      <p className="text-xs mt-1 text-muted-foreground/70">DEWS + depeg alerts for the two largest stablecoins</p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
                      <code className="text-xs font-mono text-foreground">/subscribe safety DAI,FRAX</code>
                      <p className="text-xs mt-1 text-muted-foreground/70">Get notified when DAI or FRAX safety grades change</p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
                      <code className="text-xs font-mono text-foreground">/subscribe dews,depeg,safety USDT,USDC,DAI,FRAX,GHO</code>
                      <p className="text-xs mt-1 text-muted-foreground/70">All alert types for a diversified watchlist</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-600 dark:text-emerald-400">3</span>
                <div className="space-y-1">
                  <p className="text-foreground font-medium">Done</p>
                  <p>
                    Alerts arrive automatically. DEWS and depeg alerts are checked every 15 minutes.
                    Safety grade changes are delivered daily. Use{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">/list</code>{" "}
                    anytime to see what you&apos;re tracking.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* --- Example Alert Messages --- */}
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle as="h2">What Alerts Look Like</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Each alert includes the key data points and a direct link back to the coin&apos;s page on Pharos.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {EXAMPLE_MESSAGES.map((msg) => (
                <div key={msg.label} className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">{msg.label}</p>
                  <pre className="rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] font-mono leading-relaxed text-foreground whitespace-pre-wrap">{msg.text}</pre>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* --- Command Reference --- */}
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle as="h2">Command Reference</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Command</th>
                    <th className="pb-2 pr-4 font-medium">Description</th>
                    <th className="pb-2 font-medium">Example</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {COMMANDS.map((cmd) => (
                    <tr key={cmd.command}>
                      <td className="py-2 pr-4">
                        <code className="text-xs font-mono text-foreground">{cmd.command}</code>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{cmd.description}</td>
                      <td className="py-2">
                        {cmd.example ? (
                          <code className="text-xs font-mono text-muted-foreground">{cmd.example}</code>
                        ) : (
                          <span className="text-muted-foreground/50">&mdash;</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Ticker matching is case-insensitive. If a symbol matches multiple coins (e.g. &quot;USD&quot;),
              the bot will ask you to pick from a numbered list.
            </p>
          </CardContent>
        </Card>
      </div>
    </FeaturePageShell>
  );
}
```

**Step 2: Verify the build passes**

Run: `npm run build`
Expected: Clean build, no type errors. The page should appear at `/telegram/`.

**Step 3: Commit**

```bash
git add src/app/telegram/page.tsx
git commit -m "feat: add /telegram page showcasing alert bot and digest channel"
```

---

### Task 2: Add Telegram Alerts to the Tools sidebar section

**Files:**
- Modify: `src/lib/nav-config.ts`

**Step 1: Add the Send import and nav item**

Add `Send` to the lucide-react import on line 1-18, then add the nav entry to the Tools section after the Dependency Map entry (line 67):

```typescript
{ href: "/telegram", label: "Telegram Alerts", icon: Send, description: "Bot commands & digest channel" },
```

The Tools section should look like:

```typescript
{
  label: "Tools",
  items: [
    { href: "/portfolio", label: "Portfolio Audit", icon: Wallet, description: "Personal stablecoin risk view" },
    { href: "/compare", label: "Compare", icon: ArrowLeftRight, description: "Side-by-side comparison" },
    { href: "/dependency-map", label: "Dependency Map", icon: Network, description: "Stablecoin collateral dependency graph" },
    { href: "/telegram", label: "Telegram Alerts", icon: Send, description: "Bot commands & digest channel" },
  ],
},
```

**Step 2: Verify the build passes**

Run: `npm run build`
Expected: Clean build. Sidebar now shows "Telegram Alerts" under Tools.

**Step 3: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "feat(nav): add Telegram Alerts to Tools sidebar section"
```

---

### Task 3: Repoint existing CalloutBanners to /telegram

Update the three pages that currently link directly to `t.me/PharosDigestBot` or `t.me/pharoswatch` to link to `/telegram` instead, giving users full context before jumping to Telegram.

**Files:**
- Modify: `src/app/depeg/page.tsx` (lines 81-91)
- Modify: `src/app/safety-scores/page.tsx` (lines 64-74)
- Modify: `src/app/digest/page.tsx` (lines 30-40)

**Step 1: Update depeg page CalloutBanner**

Replace the current CalloutBanner (lines 81-91) with:

```tsx
<CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
  Get instant Telegram alerts for depeg events and DEWS threat level changes.{" "}
  <Link
    href="/telegram#bot"
    className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
  >
    Set up alerts&nbsp;&rarr;
  </Link>
</CalloutBanner>
```

Also update the imports: add `Link` from `next/link` if not already imported, and remove unused `target="_blank"` / `rel="noopener noreferrer"` attrs (it's now an internal link).

**Step 2: Update safety-scores page CalloutBanner**

Replace the current CalloutBanner (lines 64-74) with:

```tsx
<CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
  Get notified when a safety grade changes.{" "}
  <Link
    href="/telegram#bot"
    className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
  >
    Set up alerts&nbsp;&rarr;
  </Link>
</CalloutBanner>
```

`Link` is already imported on line 2.

**Step 3: Update digest page CalloutBanner**

Replace the current CalloutBanner (lines 30-40) with:

```tsx
<CalloutBanner icon={<Send className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
  Get the daily digest straight to your feed.{" "}
  <Link
    href="/telegram#channel"
    className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
  >
    Join the Pharos Telegram channel&nbsp;&rarr;
  </Link>
</CalloutBanner>
```

`Link` is already imported on line 2. Remove the `Send` import from lucide-react if it becomes unused (check — it's still used as the icon prop, so keep it).

**Step 4: Verify the build passes**

Run: `npm run build`
Expected: Clean build. All three CalloutBanners now link to `/telegram`.

**Step 5: Commit**

```bash
git add src/app/depeg/page.tsx src/app/safety-scores/page.tsx src/app/digest/page.tsx
git commit -m "refactor: repoint Telegram CalloutBanners to /telegram hub page"
```

---

### Task 4: Fix @PharosWatcher -> @PharosDigestBot on the about page

**Files:**
- Modify: `src/app/about/page.tsx` (line 380)

**Step 1: Fix the bot handle**

Replace line 380:

```
Telegram bot (@PharosWatcher) for per-coin alerts on DEWS state changes, depeg events, and safety grade changes.
```

With:

```
Telegram bot (@PharosDigestBot) for per-coin alerts on DEWS state changes, depeg events, and safety grade changes.
```

**Step 2: Verify the build passes**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/app/about/page.tsx
git commit -m "fix(about): correct bot handle from @PharosWatcher to @PharosDigestBot"
```
