# Digest Day Snapshot — Design

**Date:** 2026-02-26
**Status:** Approved

## Goal

Enrich each daily digest detail page (`/digest/YYYY-MM-DD/`) with a "data behind this digest" snapshot — the numbers Claude read before writing the editorial, plus depeg and blacklist events from that day. Over time, the archive becomes a stablecoin journal: editorial voice paired with the data that provoked it.

## Data strategy

**Zero pipeline changes.** Every data point comes from tables that already exist in D1:

| Source | What it provides | Query cost |
|--------|-----------------|------------|
| `daily_digest.input_data` (JSON column) | Total mcap, 7d delta, PSI score/band/components, yesterday's PSI, active depeg count + top 3, biggest supply mover | Free — already in the digest row |
| `depeg_events` | Episodes that started, ended, or were active on that date | Lightweight date-range filter |
| `blacklist_events` | Freeze/seize/destroy actions that occurred on that date | Lightweight date-range filter |

### `input_data` shape (stored per digest row)

```ts
interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  topDepegs: { symbol: string; bps: number; mcapUsd: number }[];
  biggestSupplyChange: {
    id: string; symbol: string; name: string;
    changeUsd: number; currentMcap: number;
  } | null;
  stabilityIndex: {
    score: number; band: string;
    components: { severity: number; breadth: number; trend: number };
  } | null;
  yesterdayIndex: { score: number; band: string } | null;
}
```

## Three design refinements

### 1. "The data behind this digest" framing

The snapshot is not a generic dashboard widget. It's editorial transparency — the exact metrics Claude saw when it wrote the editorial above. Label it that way. The reader sees sardonic commentary, then sees the numbers that provoked it. This framing justifies the data's presence and makes the page uniquely compelling.

### 2. Adaptive density

Sections only appear when they carry signal:
- **Market snapshot + PSI**: always shown (every digest has these in `input_data`).
- **Active depegs**: shown only when `activeDepegCount > 0`.
- **Blacklist activity**: shown only when the date-range query returns rows.
- **Biggest supply mover**: shown only when `biggestSupplyChange` is non-null.

Quiet market days show just the macro numbers and stability reading. When something IS happening, the relevant section materializes — its appearance itself communicates significance.

### 3. Day-over-day deltas from adjacent digest

The API returns the previous digest's `input_data` alongside the current one. The frontend computes deltas:
- PSI: "92 → 89 (BEDROCK)" instead of just "89"
- Market cap: "$234.1B (+$1.2B from yesterday)" instead of a naked number
- Band transitions highlighted when they occur

This makes each entry read as a chapter in a continuing story, not an isolated snapshot. The data is free — just one additional row lookup.

## Architecture

### New API endpoint: `GET /api/digest-snapshot?date=YYYY-MM-DD`

Single endpoint returns everything the client needs.

**Query plan:**
1. Find the digest row matching the requested date (by `generated_at` range: day start ≤ generated_at < day end).
2. Parse its `input_data` JSON.
3. Find the previous digest row (the one immediately before this date) and parse its `input_data` for deltas.
4. Query `depeg_events` for episodes active on that date: `started_at < dayEnd AND (ended_at IS NULL OR ended_at >= dayStart)`.
5. Query `blacklist_events` for that day: `timestamp >= dayStart AND timestamp < dayEnd`.

**Response shape:**

```ts
interface DigestSnapshotResponse {
  date: string;                          // YYYY-MM-DD
  inputData: DigestInputData;            // parsed from JSON column
  prevInputData: DigestInputData | null; // previous digest's data (for deltas)

  depegEvents: {
    stablecoinId: string;
    symbol: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }[];

  blacklistEvents: {
    stablecoin: string;
    chainName: string;
    eventType: string;
    address: string;
    amount: number | null;
    timestamp: number;
  }[];
}
```

**Cache:** `CACHE_PROFILES.slow` — this data is historical and immutable once the day passes.

**Registration:** Add to `router.ts` as `handleDigestSnapshot`, following existing patterns (`withErrorHandler`, URL params via `url.searchParams`).

### New hook: `useDigestSnapshot(date: string)`

- Endpoint: `/api/digest-snapshot?date=${date}`
- `staleTime: Infinity` (historical data never changes)
- `enabled: !!date`
- Returns typed `DigestSnapshotResponse`

### New client component: `<DigestSnapshot date={date} />`

Renders below the editorial text on the digest detail page.

**Sections (conditional):**

1. **Market Snapshot** (always)
   - Total stablecoin market cap with day-over-day delta
   - 7-day market cap change (absolute + %)

2. **Stability Index** (always, since every digest opens with PSI)
   - Score with day-over-day arrow (e.g., 92 → 89)
   - Condition band name
   - Components: severity, breadth, trend

3. **Biggest Supply Mover** (when non-null)
   - Coin symbol + name
   - 7d supply change (absolute USD + direction)
   - Current market cap

4. **Active Depegs** (when count > 0)
   - Count as header context
   - Top 3 by market impact: symbol, deviation bps, mcap

5. **Blacklist Activity** (when events exist for that date)
   - Count of events
   - Per event: stablecoin, chain, event type, amount if available

**Layout:** Compact stat cards. Muted, subordinate typography — the editorial is the star, the data is supporting context. Use existing shadcn primitives and Tailwind classes from `classification.ts` for band colors.

**Loading state:** Skeleton placeholders while the API call resolves. The static editorial text renders instantly (SSG); the snapshot fills in client-side.

### Digest detail page changes

The page (`src/app/digest/[date]/page.tsx`) stays a server component for the editorial. Add a `"use client"` wrapper component that:
- Renders the `<DigestSnapshot>` below the `<article>` block
- Above the prev/next navigation

## File inventory

| File | Action |
|------|--------|
| `worker/src/api/digest-snapshot.ts` | New — endpoint handler |
| `worker/src/router.ts` | Edit — add route |
| `src/hooks/use-digest-snapshot.ts` | New — TanStack Query hook |
| `src/components/digest-snapshot.tsx` | New — client component |
| `src/app/digest/[date]/page.tsx` | Edit — add `<DigestSnapshot>` |

## What we are NOT doing

- No new cron jobs or data collection.
- No changes to the digest generation prompt or `input_data` shape.
- No changes to the existing digest archive or daily-digest endpoints.
- No supply_history or dex_liquidity_history aggregation (Approach B territory — can add later if desired).

---

# Digest Day Snapshot — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich each daily digest detail page with the data Claude used to write the editorial, plus depeg and blacklist events from that day.

**Architecture:** One new API endpoint (`/api/digest-snapshot`) returns parsed `input_data` from the digest row + previous digest's `input_data` + depeg/blacklist events for the date. A client component fetches this and renders adaptive sections below the static editorial text.

**Tech Stack:** Cloudflare Worker (D1 SQL), React 19, TanStack Query, Tailwind CSS v4, shadcn/ui Skeleton

---

### Task 1: API Endpoint — `digest-snapshot.ts`

**Files:**
- Create: `worker/src/api/digest-snapshot.ts`

**Step 1: Create the endpoint handler**

```ts
// worker/src/api/digest-snapshot.ts
import { withErrorHandler, safeParse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDigestSnapshot = withErrorHandler(
  "digest-snapshot",
  async (db: D1Database, url: URL): Promise<Response> => {
    const dateParam = url.searchParams.get("date");
    if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return new Response(JSON.stringify({ error: "Missing or invalid date parameter (YYYY-MM-DD)" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Compute UTC day boundaries from the date string
    const [y, m, d] = dateParam.split("-").map(Number);
    const dayStart = Math.floor(Date.UTC(y, m - 1, d) / 1000);
    const dayEnd = dayStart + 86400;

    // 1. Find the digest row for this date + the previous one (for deltas)
    // We fetch 2 rows ending at dayEnd so we get the target + its predecessor
    const digestRows = await db
      .prepare(
        "SELECT input_data, generated_at FROM daily_digest WHERE generated_at < ? ORDER BY generated_at DESC LIMIT 2"
      )
      .bind(dayEnd)
      .all<{ input_data: string; generated_at: number }>();

    const rows = digestRows.results ?? [];
    // The first row should fall within our target day
    const targetRow = rows.find((r) => r.generated_at >= dayStart && r.generated_at < dayEnd);

    if (!targetRow) {
      return new Response(JSON.stringify({ error: "No digest found for this date" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const inputData = safeParse(targetRow.input_data, null);
    // Previous row is any row that isn't the target
    const prevRow = rows.find((r) => r !== targetRow) ?? null;
    const prevInputData = prevRow ? safeParse(prevRow.input_data, null) : null;

    // 2. Depeg events active on this date
    const depegRows = await db
      .prepare(
        "SELECT stablecoin_id, symbol, direction, peak_deviation_bps, started_at, ended_at " +
        "FROM depeg_events WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?) " +
        "ORDER BY peak_deviation_bps DESC LIMIT 20"
      )
      .bind(dayEnd, dayStart)
      .all<{
        stablecoin_id: string; symbol: string; direction: string;
        peak_deviation_bps: number; started_at: number; ended_at: number | null;
      }>();

    // 3. Blacklist events on this date
    const blacklistRows = await db
      .prepare(
        "SELECT stablecoin, chain_name, event_type, address, amount, timestamp " +
        "FROM blacklist_events WHERE timestamp >= ? AND timestamp < ? " +
        "ORDER BY timestamp DESC LIMIT 50"
      )
      .bind(dayStart, dayEnd)
      .all<{
        stablecoin: string; chain_name: string; event_type: string;
        address: string; amount: number | null; timestamp: number;
      }>();

    const response = {
      date: dateParam,
      inputData,
      prevInputData,
      depegEvents: (depegRows.results ?? []).map((r) => ({
        stablecoinId: r.stablecoin_id,
        symbol: r.symbol,
        direction: r.direction,
        peakDeviationBps: r.peak_deviation_bps,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
      blacklistEvents: (blacklistRows.results ?? []).map((r) => ({
        stablecoin: r.stablecoin,
        chainName: r.chain_name,
        eventType: r.event_type,
        address: r.address,
        amount: r.amount,
        timestamp: r.timestamp,
      })),
    };

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      },
    });
  },
);
```

**Step 2: Register the route**

In `worker/src/router.ts`, add import and route:

```ts
// Add import at top:
import { handleDigestSnapshot } from "./api/digest-snapshot";

// Add route after the digest-archive block:
if (path === "/api/digest-snapshot") {
  return handleDigestSnapshot(db, url);
}
```

**Step 3: Type-check the worker**

Run: `cd worker && npx tsc --noEmit`
Expected: clean (0 errors)

**Step 4: Commit**

```bash
git add worker/src/api/digest-snapshot.ts worker/src/router.ts
git commit -m "feat(api): add /api/digest-snapshot endpoint"
```

---

### Task 2: Frontend Hook — `use-digest-snapshot.ts`

**Files:**
- Create: `src/hooks/use-digest-snapshot.ts`

**Step 1: Create the hook**

```ts
// src/hooks/use-digest-snapshot.ts
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  topDepegs: { symbol: string; bps: number; mcapUsd: number }[];
  biggestSupplyChange: {
    id: string;
    symbol: string;
    name: string;
    changeUsd: number;
    currentMcap: number;
  } | null;
  stabilityIndex: {
    score: number;
    band: string;
    components: { severity: number; breadth: number; trend: number };
  } | null;
  yesterdayIndex: { score: number; band: string } | null;
}

export interface DigestSnapshotData {
  date: string;
  inputData: DigestInputData | null;
  prevInputData: DigestInputData | null;
  depegEvents: {
    stablecoinId: string;
    symbol: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }[];
  blacklistEvents: {
    stablecoin: string;
    chainName: string;
    eventType: string;
    address: string;
    amount: number | null;
    timestamp: number;
  }[];
}

export function useDigestSnapshot(date: string): UseQueryResult<DigestSnapshotData, Error> {
  return useQuery<DigestSnapshotData, Error>({
    queryKey: ["digest-snapshot", date],
    queryFn: () => apiFetch<DigestSnapshotData>(`/api/digest-snapshot?date=${date}`),
    staleTime: Infinity,
    enabled: !!date,
    retry: 1,
  });
}
```

**Step 2: Type-check**

Run: `npm run build`
Expected: clean

**Step 3: Commit**

```bash
git add src/hooks/use-digest-snapshot.ts
git commit -m "feat(hooks): add useDigestSnapshot hook"
```

---

### Task 3: Client Component — `digest-snapshot.tsx`

**Files:**
- Create: `src/components/digest-snapshot.tsx`

**Context for the implementer:**
- Use `formatCurrency` from `src/lib/format.ts` for money values
- Use `formatPercentChange` from `src/lib/format.ts` for % deltas
- Use `formatAddress` from `src/lib/format.ts` for blockchain addresses
- Use `PSI_BAND_CLASSES` from `src/lib/psi-colors.ts` for band text colors
- Use `Skeleton` from `@/components/ui/skeleton` for loading states
- Adaptive density: only render sections when their data is non-empty/non-null
- Day-over-day deltas: compare `inputData` vs `prevInputData` when both exist
- The component must be `"use client"` since it uses the hook

**Step 1: Create the component**

The component renders these conditional sections:
1. **Market Snapshot** (always) — mcap with delta from prev day, 7d change
2. **Stability Index** (always when present) — score arrow, band with color, components
3. **Biggest Supply Mover** (when non-null) — symbol, change, current mcap
4. **Active Depegs** (when count > 0) — top 3 by market impact
5. **Blacklist Activity** (when events exist) — count + per-event details

Design notes:
- Wrap in a section with header "The data behind this digest"
- Use a compact grid layout with subtle borders
- Muted, subordinate typography — the editorial is the star
- Skeleton loading: 2-3 placeholder rows while fetching
- On error or 404 from API: render nothing (don't break the page)

**Step 2: Type-check**

Run: `npm run build`
Expected: clean

**Step 3: Commit**

```bash
git add src/components/digest-snapshot.tsx
git commit -m "feat(ui): add DigestSnapshot client component"
```

---

### Task 4: Wire Into Digest Detail Page

**Files:**
- Modify: `src/app/digest/[date]/page.tsx`

**Step 1: Add the component to the page**

Import and render `<DigestSnapshot>` between the `<article>` and the prev/next `<nav>`:

```tsx
// Add import at top:
import { DigestSnapshot } from "@/components/digest-snapshot";

// Insert after </article> closing tag, before the <nav> block:
<DigestSnapshot date={digest.date} />
```

The page stays a server component — `DigestSnapshot` is already `"use client"` so it works as a client island within the server-rendered page.

**Step 2: Build and verify**

Run: `npm run build`
Expected: clean build, static pages generated for all digest dates

**Step 3: Manual smoke test**

Run: `npm run dev` and visit `http://localhost:3000/digest/2026-02-26/`
Expected: Editorial text renders instantly (SSG), snapshot section loads after API call resolves

**Step 4: Commit**

```bash
git add src/app/digest/[date]/page.tsx
git commit -m "feat(digest): wire DigestSnapshot into detail page"
```

---

### Task 5: Verification & Polish

**Step 1: Full build**

Run: `npm run build`
Expected: 0 errors, all digest pages generated

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors

**Step 3: Visual review**

Check the digest detail page in dev mode for:
- Loading skeleton appears briefly
- Market snapshot section renders with numbers
- PSI section shows score + band with correct color
- Sections with no data are absent (not empty shells)
- Layout doesn't break on narrow viewports
- Prev/next navigation still works
