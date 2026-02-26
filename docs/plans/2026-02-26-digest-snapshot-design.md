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
