# Homepage V2 Implementation Plan (Market Pulse + Daily Digest)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement features #1 (Market Pulse hero redesign) and #2 (Daily Digest LLM editorial) from the UX improvements design, developed on an isolated `/hometest` route before replacing the production homepage.

**Architecture:** A parallel `/hometest` page copies the current homepage structure but swaps `CategoryStats` for a new `MarketPulse` component and adds a `DailyDigest` card. The intro block becomes collapsible via localStorage. Worker-side: a new cron generates editorial text via Claude API, stored in D1, served via a new `/api/daily-digest` endpoint.

**Tech Stack:** Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Cloudflare Workers + D1, Claude Haiku API.

**Important constraints:**
- Never commit or push — user handles all git operations themselves
- Tailwind classes must be static strings (never construct dynamically)
- Classification labels/colors from `src/lib/classification.ts` only
- Supply helpers: `getCirculatingRaw/USD()` from `src/lib/supply.ts`
- Hook timing: `staleTime = cron interval`, `refetchInterval = 2x`
- API base: `https://api.pharos.watch/api/<endpoint>`
- Cloudflare Workers cron limit: 4 triggers — must piggyback on existing slot

---

## Phase 1: Staging Route + Collapsible Intro

### Task 1: Create `/hometest` staging route

**Files:**
- Create: `src/app/hometest/page.tsx`

**What to do:**
Copy `src/app/page.tsx` to `src/app/hometest/page.tsx`. This is a direct copy — same JSON-LD, same intro block, same `<HomepageClient />`. The only change: URL params in the filter sync should use `/hometest` instead of `/`. BUT — the filter URL sync lives in `HomepageClient`, not in `page.tsx`, so we leave `page.tsx` as a pure copy for now.

The staging page uses the exact same `HomepageClient` component initially. We'll swap it to our new client in a later task.

```tsx
// src/app/hometest/page.tsx — exact copy of src/app/page.tsx
import { Suspense } from "react";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { HomepageClient } from "@/components/homepage-client";

export default function HomeTestPage() {
  // ... identical to HomePage
}
```

**Verify:** `npm run build` succeeds and `/hometest/` route exists in the output.

---

### Task 2: Create the new `HomepageTestClient` component

**Files:**
- Create: `src/components/homepage-test-client.tsx`
- Modify: `src/app/hometest/page.tsx` — swap import

**What to do:**
Copy `src/components/homepage-client.tsx` to `src/components/homepage-test-client.tsx`. Rename the export to `HomepageTestClient`. Change the URL sync base path from `/` to `/hometest/`:

```tsx
// In the useEffect that syncs URL:
const newUrl = paramString ? `/hometest/?${paramString}` : "/hometest/";
```

Update `src/app/hometest/page.tsx` to import `HomepageTestClient` instead of `HomepageClient`.

**Verify:** `npm run build` succeeds. `npm run dev` → navigate to `/hometest/` → page renders identically to homepage. Filters work and URL updates correctly with `/hometest/` prefix.

---

### Task 3: Collapsible intro block

**Files:**
- Create: `src/components/collapsible-intro.tsx`
- Modify: `src/app/hometest/page.tsx` — wrap intro in new component

**What to do:**
Create a client component that wraps the intro text with collapse/expand behavior:

```tsx
// src/components/collapsible-intro.tsx
"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const STORAGE_KEY = "pharos-intro-collapsed";

interface CollapsibleIntroProps {
  title: string;
  subtitle: string;
  children: React.ReactNode; // The full description paragraph
}

export function CollapsibleIntro({ title, subtitle, children }: CollapsibleIntroProps) {
  const [collapsed, setCollapsed] = useState(true); // Default collapsed, expand if no localStorage flag
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    // First visit: no flag → show expanded. Returning: flag exists → collapsed.
    if (stored === null) {
      setCollapsed(false);
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) {
      localStorage.setItem(STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  // SSR/hydration: render expanded to avoid layout shift, then collapse on mount
  if (!mounted) {
    return (
      <div className="space-y-2 mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{subtitle}</p>
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-2 mb-6">
      <div className="flex items-center gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <button
          onClick={toggle}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={collapsed ? "Expand description" : "Collapse description"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
        </button>
      </div>
      <p className="text-muted-foreground">{subtitle}</p>
      {!collapsed && children}
    </div>
  );
}
```

In `src/app/hometest/page.tsx`, replace the static `<div className="space-y-2 mb-6">` block with:

```tsx
<CollapsibleIntro
  title="Stablecoin Analytics Dashboard"
  subtitle={`Tracking ${total} stablecoins. Every chain. Every freeze.`}
>
  <p className="text-sm text-muted-foreground">
    Pharos tracks {total} stablecoins across {PEG_CURRENCY_COUNT} peg currencies...
  </p>
</CollapsibleIntro>
```

**Verify:** `npm run build` succeeds. Dev server: first visit shows full intro with collapse chevron. Click chevron → description collapses. Refresh → stays collapsed. Clear localStorage → expands again on refresh.

---

## Phase 2: Market Pulse Component

### Task 4: Create the MarketPulse component

**Files:**
- Create: `src/components/market-pulse.tsx`

**What to do:**
Build the Market Pulse component with 3 zones as described in the design doc. This replaces `CategoryStats`.

**Props interface:**
```tsx
interface MarketPulseProps {
  data: StablecoinData[] | undefined;
  pegRates?: Record<string, number>;
  pegSummary?: { coins: PegSummaryCoin[]; summary: PegSummaryStats | null };
  blacklistEvents?: { events: BlacklistEvent[]; total: number };
  logos?: Record<string, string>;
}
```

**Zone 1 — Key Numbers** (left/top on mobile):
Uses data already available from `useStablecoins()` + `usePegSummary()` + `useBlacklistEvents()`:

| Metric | Source | Display |
|--------|--------|---------|
| Total Mcap | `getCirculatingRaw()` sum | `$312.1B ↑0.18% 7d` |
| Active Depegs | `pegSummary.summary.activeDepegCount` | `2 depegged` (red if >0, green "All stable" if 0) |
| 24h Freezes | `blacklistEvents.events` filtered by `timestamp > now - 86400` | `3 freezes` |
| CeFi Dominance | Same governance calc as CategoryStats | `91.6% CeFi` |

Each metric is a compact stat with label above, value below, optional delta.

**Zone 2 — Movers & Signals** (center):
| Signal | Source | Display |
|--------|--------|---------|
| Biggest Depeg | `pegSummary.summary.worstCurrent` | `FDUSD -85bps` with severity color |
| Biggest Supply Change (7d) | `useStablecoins()` max abs(current - prevWeek) | `USDe ↑$420M` |
| USDT/USDC Split | Same as CategoryStats dominance card | `USDT $183B · USDC $74B` |

**Zone 3 — Recent Activity Ticker** (right/bottom on mobile):
Shows last 3 events from combined blacklist + depeg sources, sorted by recency:
- Blacklist events: `"{stablecoin} froze {truncatedAddress} on {chainName} — {timeAgo}"`
- Active depegs: `"{symbol} depegged {deviation}bps — active"`

**Layout:**
- Desktop: Single card/section, 3-column grid (`lg:grid-cols-3`)
- Mobile: Stack vertically (`grid-cols-1`)
- Use subtle dividers between zones on desktop

**Skeleton state:** When `data` is undefined, show a skeleton matching the 3-zone layout dimensions.

**Important implementation details:**
- Use `getCirculatingRaw()` from `src/lib/supply.ts` for mcap (NOT `getCirculatingUSD()`)
- Use `formatCurrency()` from `src/lib/format.ts`
- Use `GOVERNANCE_TIER_COLORS` from `src/lib/classification.ts` for the CeFi bar
- Governance split detail (CeFi/Dep/DeFi breakdown with bar + percentages) becomes a hoverable tooltip or expandable detail under the CeFi Dominance metric
- Alt-peg breakdown removed from here (it's covered by PegDiversityChart lower on the page)
- Time ago formatting: simple relative time helper (no external dep) — `"2h ago"`, `"30min ago"`, `"just now"`

**Verify:** `npm run build` succeeds. Component type-checks.

---

### Task 5: Wire MarketPulse into HomepageTestClient

**Files:**
- Modify: `src/components/homepage-test-client.tsx`

**What to do:**
1. Import `MarketPulse` instead of `CategoryStats`
2. The test client already calls `usePegSummary()` and `useStablecoins()`. Add `useBlacklistEvents()`:
   ```tsx
   import { useBlacklistEvents } from "@/hooks/use-blacklist-events";
   // ...
   const { data: blacklistData } = useBlacklistEvents();
   ```
3. Replace `<CategoryStats data={data?.peggedAssets} pegRates={pegRates} />` with:
   ```tsx
   <MarketPulse
     data={data?.peggedAssets}
     pegRates={pegRates}
     pegSummary={pegSummaryData ?? undefined}
     blacklistEvents={blacklistData ?? undefined}
     logos={logos}
   />
   ```
4. Remove the `MarketHighlights` component from the test page — its data (Biggest Depegs + Fastest Movers) is now integrated into MarketPulse Zone 2. If we want to keep "Fastest Movers" as a standalone, we can keep MarketHighlights but remove BiggestDepegs from it and just show FastestMovers. **Decision: keep MarketHighlights for now** — Market Pulse Zone 2 covers "Biggest Depeg" and "Biggest Supply Change", but the full top-5 depegs list and the Growing/Shrinking 3+3 lists are still valuable below the charts.

**Verify:** `npm run build` succeeds. Dev server → `/hometest/` shows the new Market Pulse instead of the 4 CategoryStats cards. Data populates correctly.

---

### Task 6: Polish MarketPulse responsive layout

**Files:**
- Modify: `src/components/market-pulse.tsx`

**What to do:**
After seeing the initial render, refine:
- Spacing, font sizes, color consistency
- Mobile stacking behavior
- Skeleton dimensions match loaded content
- Hover states on expandable governance detail
- Ensure the recent activity ticker truncates addresses properly (`0x1a2b...3c4d`)
- Verify severity colors match existing conventions (red for >=50bps, amber for >=10bps, from `market-highlights.tsx`)

This is an iteration task — inspect visually, adjust, rebuild, repeat.

**Verify:** `npm run build` succeeds. Visual inspection on desktop and mobile viewport (dev tools responsive mode). No layout shifts on data load.

---

## Phase 3: Daily Digest (Worker-side)

### Task 7: D1 migration for daily_digest table

**Files:**
- Create: `worker/migrations/0018_daily_digest.sql`

**What to do:**
```sql
-- Daily editorial digest generated by LLM
CREATE TABLE daily_digest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,
  digest_text TEXT NOT NULL,
  input_data TEXT NOT NULL
);

CREATE INDEX idx_daily_digest_generated_at ON daily_digest(generated_at);
```

**Verify:** Run `cd worker && npx wrangler d1 migrations apply stablecoin-db --local` to test the migration locally. Should succeed without errors.

---

### Task 8: Create the daily digest cron job

**Files:**
- Create: `worker/src/cron/daily-digest.ts`

**What to do:**
Create a cron job that:
1. Checks if the latest digest is less than 1 hour old → skip if so
2. Collects structured data from existing cache entries:
   - Total mcap + 7d delta (from `stablecoins` cache)
   - Active depeg count + worst deviation (from `peg-summary` cache, which also contains `depeg-events`)
   - Freeze count in last 24h (from `blacklist_events` table)
   - Biggest supply change 7d (from `stablecoins` cache)
3. Calls Claude API (`claude-haiku-4-5`) with structured data + editorial prompt
4. Stores result in `daily_digest` table
5. Cleans up rows older than 7 days

```tsx
// worker/src/cron/daily-digest.ts
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 200;

interface DigestInput {
  totalMcapB: number;
  mcapDelta7dPct: number;
  activeDepegCount: number;
  worstDepeg: { symbol: string; bps: number } | null;
  freezes24h: number;
  biggestSupplyChange: { symbol: string; deltaM: number } | null;
  trackedCount: number;
}

const SYSTEM_PROMPT = `You write the daily editorial summary for Pharos, a stablecoin analytics dashboard. Your tone is concise, slightly editorial, never alarmist, and always factual. You write 2-4 sentences max summarizing the last 24 hours in stablecoin markets. No emojis, no clickbait, no hedging. When nothing happened, acknowledge the calm with personality. Reference specific coins and numbers from the data provided.`;

function buildUserPrompt(input: DigestInput): string {
  const lines = [
    `Total stablecoin market cap: $${input.totalMcapB.toFixed(1)}B (${input.mcapDelta7dPct >= 0 ? "+" : ""}${input.mcapDelta7dPct.toFixed(2)}% 7d)`,
    `Tracked stablecoins: ${input.trackedCount}`,
    `Active depegs: ${input.activeDepegCount}`,
  ];
  if (input.worstDepeg) {
    lines.push(`Worst current depeg: ${input.worstDepeg.symbol} at ${input.worstDepeg.bps > 0 ? "+" : ""}${input.worstDepeg.bps}bps`);
  }
  lines.push(`Address freezes in last 24h: ${input.freezes24h}`);
  if (input.biggestSupplyChange) {
    const sign = input.biggestSupplyChange.deltaM >= 0 ? "+" : "";
    lines.push(`Biggest supply change (7d): ${input.biggestSupplyChange.symbol} ${sign}$${Math.abs(input.biggestSupplyChange.deltaM).toFixed(0)}M`);
  }
  return `Write the daily digest based on this data:\n\n${lines.join("\n")}`;
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    console.log("[daily-digest] No ANTHROPIC_API_KEY configured, skipping");
    return { metadata: "skipped: no API key" };
  }

  // Check if latest digest is <1h old
  const latest = await db.prepare(
    "SELECT generated_at FROM daily_digest ORDER BY generated_at DESC LIMIT 1"
  ).first<{ generated_at: number }>();

  const nowSec = Math.floor(Date.now() / 1000);
  if (latest && (nowSec - latest.generated_at) < 3600) {
    console.log("[daily-digest] Latest digest is fresh, skipping");
    return { metadata: "skipped: fresh" };
  }

  // Collect structured data from cache
  const stablecoinsCache = await getCache(db, "stablecoins");
  const pegSummaryCache = await getCache(db, "peg-summary");

  if (!stablecoinsCache) {
    console.warn("[daily-digest] No stablecoins cache, skipping");
    return { metadata: "skipped: no data" };
  }

  const stablecoins = JSON.parse(stablecoinsCache.value);
  const peggedAssets = stablecoins.peggedAssets ?? [];
  // (compute totalMcap, delta, biggest supply change from peggedAssets)
  // (compute activeDepegCount, worstDepeg from pegSummary cache)
  // (count 24h freezes from blacklist_events table)

  // ... data collection logic (see implementation) ...

  const input: DigestInput = { /* populated from above */ };

  // Call Claude API
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const result = await response.json();
  const digestText = result.content?.[0]?.text ?? "";

  if (!digestText) {
    throw new Error("Empty digest from Claude API");
  }

  // Store in D1
  await db.prepare(
    "INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, ?, ?)"
  ).bind(nowSec, digestText, JSON.stringify(input)).run();

  // Clean up old digests (>7 days)
  const cutoff = nowSec - 7 * 86400;
  await db.prepare("DELETE FROM daily_digest WHERE generated_at < ?").bind(cutoff).run();

  console.log(`[daily-digest] Generated: "${digestText.substring(0, 80)}..."`);
  return { itemCount: 1, metadata: `generated ${digestText.length} chars` };
}
```

The data collection logic (computing mcap totals, finding worst depeg, counting freezes) should use the same `getCirculatingRaw`-style logic that exists in the frontend. Import the shared supply helpers from `../../../src/lib/supply` (the worker already does this pattern — see `sync-bluechip.ts` importing from `../../../src/lib/bluechip`).

**Important:** The `ANTHROPIC_API_KEY` must be added to the `Env` interface in `worker/src/index.ts` and as a secret in `wrangler.toml`. Do NOT add it as a plain `[vars]` — use `npx wrangler secret put ANTHROPIC_API_KEY`.

**Verify:** `cd worker && npx tsc --noEmit` succeeds.

---

### Task 9: Wire the daily digest cron into the worker

**Files:**
- Modify: `worker/src/index.ts` — add `ANTHROPIC_API_KEY` to Env, piggyback cron on existing slot

**What to do:**
1. Add `ANTHROPIC_API_KEY?: string;` to the `Env` interface
2. Import `generateDailyDigest` from `./cron/daily-digest`
3. Piggyback on the `"0 */2 * * *"` slot (every 2 hours — runs alongside `syncFxRates`). This is the least loaded slot and hourly generation is the target cadence, so every-2-hours is fine (design doc says "run at minute 0 of each hour" but every 2h is sufficient and avoids needing a new cron slot):

```tsx
case "0 */2 * * *":
  ctx.waitUntil(logCronRun(db, "sync-fx-rates", () => syncFxRates(db)));
  ctx.waitUntil(logCronRun(db, "daily-digest", () =>
    generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null)
  ));
  break;
```

**Verify:** `cd worker && npx tsc --noEmit` succeeds.

---

### Task 10: Create the `/api/daily-digest` endpoint

**Files:**
- Create: `worker/src/api/daily-digest.ts`
- Modify: `worker/src/router.ts` — add route

**What to do:**

```tsx
// worker/src/api/daily-digest.ts
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";

export const handleDailyDigest = withErrorHandler("daily-digest", async (db: D1Database): Promise<Response> => {
  const row = await db.prepare(
    "SELECT digest_text, generated_at FROM daily_digest ORDER BY generated_at DESC LIMIT 1"
  ).first<{ digest_text: string; generated_at: number }>();

  if (!row) {
    return new Response(JSON.stringify({ digest: null }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=300, max-age=60",
      },
    });
  }

  return new Response(JSON.stringify({
    digest: row.digest_text,
    generatedAt: row.generated_at,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=3600, max-age=300",
    }, row.generated_at, 7200),
  });
});
```

In `worker/src/router.ts`, add:
```tsx
import { handleDailyDigest } from "./api/daily-digest";
// ...
if (path === "/api/daily-digest") {
  return handleDailyDigest(db);
}
```

**Verify:** `cd worker && npx tsc --noEmit` succeeds.

---

## Phase 4: Daily Digest (Frontend)

### Task 11: Create the `useDailyDigest` hook

**Files:**
- Create: `src/hooks/use-daily-digest.ts`

**What to do:**
Follow the existing hook pattern with `useApiQuery`:

```tsx
"use client";

import { useApiQuery, CRON_1H } from "@/hooks/use-api-query";

interface DailyDigestData {
  digest: string | null;
  generatedAt: number | null;
}

export function useDailyDigest() {
  return useApiQuery<DailyDigestData>(
    ["daily-digest"],
    "/api/daily-digest",
    CRON_1H,
  );
}
```

Uses `CRON_1H` (1 hour staleTime, 2 hour refetch) since digests are generated every 2 hours.

**Verify:** `npm run build` succeeds.

---

### Task 12: Create the DailyDigest component

**Files:**
- Create: `src/components/daily-digest.tsx`

**What to do:**
Editorial-styled card that renders the LLM-generated digest:

```tsx
"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";

function timeAgo(epochSec: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - epochSec) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

export function DailyDigest() {
  const { data, isLoading } = useDailyDigest();

  // Don't render anything if no digest available (graceful fallback)
  if (!isLoading && (!data || !data.digest)) return null;

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardContent className="py-5 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="py-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Daily Digest
          </p>
          {data!.generatedAt && (
            <span className="text-[10px] text-muted-foreground">
              Updated {timeAgo(data!.generatedAt)}
            </span>
          )}
        </div>
        <p className="text-sm leading-relaxed italic text-foreground/90">
          {data!.digest}
        </p>
      </CardContent>
    </Card>
  );
}
```

**Design notes:**
- `border-dashed` gives a subtle editorial/newspaper feel
- Italic text differentiates it from data displays
- Muted "Updated Xh ago" timestamp
- Skeleton: 3 lines of varying width
- If no digest exists (API returns `null`), component renders nothing — no empty card

**Verify:** `npm run build` succeeds.

---

### Task 13: Wire DailyDigest into HomepageTestClient

**Files:**
- Modify: `src/components/homepage-test-client.tsx`

**What to do:**
Add `<DailyDigest />` immediately after `<MarketPulse>`, before `<TotalMcapChart>`:

```tsx
import { DailyDigest } from "@/components/daily-digest";
// ...
<MarketPulse ... />
<DailyDigest />
<TotalMcapChart />
```

The component manages its own data fetching via `useDailyDigest()` — no props needed from the parent.

**Verify:** `npm run build` succeeds. Dev server → `/hometest/` shows the digest card between Market Pulse and the mcap chart. (The digest will be empty/hidden until the worker generates one — that's correct behavior per the fallback design.)

---

## Phase 5: Integration Testing & Polish

### Task 14: End-to-end visual verification

**Files:** None — this is a verification task

**What to do:**
1. Run `npm run dev`
2. Navigate to `/hometest/`
3. Verify visually:
   - Collapsible intro works (first visit = expanded, clicking collapses, persists on refresh)
   - Market Pulse shows 3 zones with real data
   - Mobile responsive layout stacks correctly (use dev tools)
   - Daily Digest card renders (or gracefully hides if no data)
   - Charts, filters, table, summaries all work as before
   - No console errors
4. Compare with `/` (original homepage) — everything below Market Pulse should be identical
5. Run `npm run build` — full static export succeeds with no errors

---

### Task 15: Final type-check and build verification

**Files:** None

**What to do:**
```bash
npm run build          # Frontend build + type-check
cd worker && npx tsc --noEmit  # Worker type-check
```

Both must pass with zero errors.

---

## Phase 6: Promotion (when ready)

> **Not part of this implementation session.** When the user is satisfied with `/hometest/`:

### Task 16: Promote hometest to homepage (deferred)

**What to do:**
1. Copy the final `HomepageTestClient` content back into `HomepageClient` (or rename)
2. Update `src/app/page.tsx` to use the collapsible intro + new client
3. Delete `src/app/hometest/page.tsx` and `src/components/homepage-test-client.tsx`
4. Update URL sync path back from `/hometest/` to `/`
5. Remove `CategoryStats` component if fully replaced
6. Final `npm run build` verification

---

## File Summary

| Action | File | Phase |
|--------|------|-------|
| Create | `src/app/hometest/page.tsx` | 1 |
| Create | `src/components/homepage-test-client.tsx` | 1 |
| Create | `src/components/collapsible-intro.tsx` | 1 |
| Create | `src/components/market-pulse.tsx` | 2 |
| Modify | `src/components/homepage-test-client.tsx` | 2 |
| Create | `worker/migrations/0018_daily_digest.sql` | 3 |
| Create | `worker/src/cron/daily-digest.ts` | 3 |
| Modify | `worker/src/index.ts` | 3 |
| Create | `worker/src/api/daily-digest.ts` | 3 |
| Modify | `worker/src/router.ts` | 3 |
| Create | `src/hooks/use-daily-digest.ts` | 4 |
| Create | `src/components/daily-digest.tsx` | 4 |
| Modify | `src/components/homepage-test-client.tsx` | 4 |

**No existing files are deleted or destructively modified.** The original homepage (`page.tsx`, `HomepageClient`, `CategoryStats`) remain untouched.
