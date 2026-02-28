# Digest Broadsheet & Wire Archive — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the digest archive page and homepage digest block with a broadsheet newspaper aesthetic for today's digest, and a wire-service archive table with month navigation for historical digests.

**Architecture:** The broadsheet component (`DailyDigest`) is shared between the homepage and `/digest/` page, accepting a `showArchiveLink` prop to control the footer link. The wire table is a new section in `DigestArchiveClient` that fetches enriched data (PSI + mcap) from the existing archive API. The API enrichment parses the already-stored `input_data` JSON column — no new DB queries.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, TanStack Query, Cloudflare Workers + D1

**Design doc:** `docs/plans/2026-02-28-digest-broadsheet-design.md`

---

### Task 1: Enrich the digest-archive API with PSI + mcap data

**Files:**
- Modify: `worker/src/api/digest-archive.ts`

**Step 1: Add `input_data` to the SQL query**

In `worker/src/api/digest-archive.ts`, update the SELECT statement and type to include `input_data`:

```typescript
const rows = await db.prepare(
  "SELECT digest_text, digest_title, generated_at, digest_extended, input_data FROM daily_digest ORDER BY generated_at DESC LIMIT 365"
).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null; input_data: string | null }>();
```

**Step 2: Parse input_data and extract PSI + mcap**

Update the `.map()` to extract fields from `input_data`:

```typescript
const digests = (rows.results ?? []).map((r) => {
  let psiScore: number | null = null;
  let psiBand: string | null = null;
  let totalMcapUsd: number | null = null;
  if (r.input_data) {
    try {
      const input = JSON.parse(r.input_data) as {
        stabilityIndex?: { score: number; band: string } | null;
        totalMcapUsd?: number;
      };
      psiScore = input.stabilityIndex?.score ?? null;
      psiBand = input.stabilityIndex?.band ?? null;
      totalMcapUsd = input.totalMcapUsd ?? null;
    } catch { /* malformed input_data, skip */ }
  }
  return {
    digestText: r.digest_text,
    digestTitle: r.digest_title ?? null,
    digestExtended: r.digest_extended ?? null,
    generatedAt: r.generated_at,
    psiScore,
    psiBand,
    totalMcapUsd,
  };
});
```

**Step 3: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add worker/src/api/digest-archive.ts
git commit -m "feat(api): enrich digest-archive with PSI score, band, and total mcap"
```

---

### Task 2: Update the frontend hook and types for enriched archive data

**Files:**
- Modify: `src/hooks/use-digest-archive.ts`

**Step 1: Add new fields to the interface**

Update the `DigestArchiveData` interface in `src/hooks/use-digest-archive.ts`:

```typescript
interface DigestArchiveData {
  digests: {
    digestText: string;
    digestTitle: string | null;
    digestExtended: string | null;
    generatedAt: number;
    psiScore: number | null;
    psiBand: string | null;
    totalMcapUsd: number | null;
  }[];
}
```

**Step 2: Verify frontend type-checks**

Run: `npm run build`
Expected: Build succeeds (existing consumers don't reference the new fields yet, so no breakage)

**Step 3: Commit**

```bash
git add src/hooks/use-digest-archive.ts
git commit -m "feat(hooks): add PSI and mcap fields to digest archive type"
```

---

### Task 3: Redesign the DailyDigest component as a broadsheet

This is the shared broadsheet component used on both the homepage and the `/digest/` page.

**Files:**
- Modify: `src/components/daily-digest.tsx`

**Step 1: Rewrite the component**

Replace the full content of `src/components/daily-digest.tsx`. Key design elements:

- **Masthead**: "PHAROS DAILY DIGEST" centered, uppercase, `tracking-[0.25em] text-sm font-semibold text-muted-foreground`. Full date below in regular weight. Top and bottom thin horizontal rules (`border-t border-b border-border`).
- **Headline**: Digest title in serif (`Georgia`), `text-2xl sm:text-3xl font-bold`.
- **Body**: Extended text paragraphs only (serif italic, `text-[1.1rem] leading-relaxed text-foreground/90 italic`). The `text` field (tweet) is **never** rendered.
- **Footer**: Conditional "Read all previous recaps →" link, controlled by `showArchiveLink` prop (default `true`).
- Accept a `showArchiveLink?: boolean` prop so the `/digest/` page can hide the link.
- Keep exporting `formatDateline` — it's imported by other files.

Date formatting for the masthead: use `toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })` to produce "Saturday, February 28, 2026".

```typescript
"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";

export function formatDateline(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMasthead(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const SERIF = { fontFamily: "Georgia, 'Times New Roman', serif" };

export function DailyDigest({ showArchiveLink = true }: { showArchiveLink?: boolean }) {
  const { data, isLoading } = useDailyDigest();

  if (!isLoading && (!data || !data.digest)) return null;

  if (isLoading) {
    return (
      <div className="border-t border-b border-border py-6 space-y-3">
        <Skeleton className="h-3 w-48 mx-auto" />
        <Skeleton className="h-3 w-36 mx-auto" />
        <Skeleton className="h-6 w-72 mt-4" />
        <Skeleton className="h-4 w-full mt-2" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      {/* Masthead */}
      <div className="border-t border-b border-border py-3 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          Pharos Daily Digest
        </p>
        {data?.generatedAt && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatMasthead(data.generatedAt)}
          </p>
        )}
      </div>

      {/* Headline + Body */}
      <div className="py-5 space-y-3">
        <h2 className="text-2xl sm:text-3xl font-bold" style={SERIF}>
          {data?.digestTitle || "Signal & Noise"}
        </h2>

        {data?.digestExtended && data.digestExtended.split("\n\n").map((para, i) => (
          <p
            key={i}
            className="text-[1.1rem] leading-relaxed text-foreground/90 italic"
            style={SERIF}
          >
            {para}
          </p>
        ))}

        {showArchiveLink && (
          <Link
            href="/digest/"
            className="inline-block mt-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            Read all previous recaps &rarr;
          </Link>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify it builds**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/daily-digest.tsx
git commit -m "feat(ui): redesign DailyDigest as broadsheet with masthead and serif headline"
```

---

### Task 4: Update the homepage to use the broadsheet

The homepage currently renders the digest inline in `HomepageClient` (lines 123-165 of `src/components/homepage-client.tsx`) with its own Card wrapper, chevron toggle, and inline rendering of `digestData.digest` (the tweet text). Replace all of that with the new `DailyDigest` component.

**Files:**
- Modify: `src/components/homepage-client.tsx`

**Step 1: Replace the inline digest section**

In `src/components/homepage-client.tsx`:

1. Remove imports no longer needed: `ChevronDown` (line 5), `useDailyDigest` (line 21), `formatDateline` (line 22), `Card`/`CardHeader`/`CardTitle`/`CardContent` (line 27 — but check if Card is used elsewhere in the file; it isn't), `cn` (line 31 — check if used elsewhere; it isn't).
2. Remove the `DIGEST_STORAGE_KEY` constant and `useDigestOpen` hook (lines 35-54).
3. Remove `digestData` from the component (line 63) and `digestOpen`/`toggleDigest` (line 66).
4. Replace the entire `<SectionErrorBoundary name="digest">` block (lines 123-165) with:

```tsx
<SectionErrorBoundary name="digest">
  <DailyDigest />
</SectionErrorBoundary>
```

5. Add import: `import { DailyDigest } from "@/components/daily-digest";`

**Step 2: Verify it builds**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/homepage-client.tsx
git commit -m "feat(homepage): use broadsheet DailyDigest, remove inline digest rendering"
```

---

### Task 5: Redesign the digest archive page with broadsheet + wire table

**Files:**
- Modify: `src/components/digest-archive-client.tsx`
- Modify: `src/app/digest/page.tsx`

**Step 1: Rewrite `digest-archive-client.tsx` as the wire table**

Replace the full content. The component now renders:
1. The `DailyDigest` broadsheet (with `showArchiveLink={false}`)
2. A decorative "ARCHIVE" divider
3. A month picker `<select>`
4. Wire-service rows: date | title | PSI pill | mcap | chevron

Key implementation details:

- Import `DailyDigest` from `@/components/daily-digest`.
- Import `PSI_BAND_CLASSES` from `@/lib/psi-colors` for the PSI badge text color.
- Import `formatCurrency` from `@/lib/format` for the mcap column.
- Import `ChevronRight` from `lucide-react` for the row chevron.
- Use `tsToDateSlug` (existing helper) for link URLs.
- Build month options from the digest list: group by `YYYY-MM`, format as "February 2026", default to the most recent month.
- Filter displayed digests by selected month.
- For the wire table, skip the first digest (today's) since it's shown in the broadsheet above. Compare the date slug of each digest against the latest one — if it matches, skip it.
- Month picker: a native `<select>` with classes `text-sm bg-transparent border border-border rounded px-2 py-1 text-foreground`.
- Wire row layout on desktop: `flex items-center gap-4` with date fixed-width, title flex-1 truncated, PSI pill and mcap on the right.
- Wire row layout on mobile: title wraps below date, PSI + mcap on a second line.
- PSI pill: `text-xs font-mono font-medium px-1.5 py-0.5 rounded` with the band's text color class from `PSI_BAND_CLASSES` and `bg-muted/50` background.
- Date: format as "27 FEB" using `toLocaleDateString("en-US", { day: "numeric", month: "short" }).toUpperCase()`. Use monospace: `font-mono text-xs text-muted-foreground w-14 shrink-0`.

```typescript
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/use-digest-archive";
import { DailyDigest } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { PSI_BAND_CLASSES } from "@/lib/psi-colors";
import { formatCurrency } from "@/lib/format";
import { CRON_24H } from "@/hooks/use-api-query";

function tsToDateSlug(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function tsToMonthKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 7); // "2026-02"
}

function formatMonthLabel(key: string): string {
  const [y, m] = key.split("-");
  const date = new Date(Number(y), Number(m) - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatWireDate(ts: number): string {
  return new Date(ts * 1000)
    .toLocaleDateString("en-US", { day: "numeric", month: "short" })
    .toUpperCase();
}

export function DigestArchiveClient() {
  const { data, isLoading, dataUpdatedAt } = useDigestArchive();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  // Build month options from digest dates
  const monthOptions = useMemo(() => {
    if (!data?.digests.length) return [];
    const seen = new Set<string>();
    const options: { key: string; label: string }[] = [];
    for (const d of data.digests) {
      const key = tsToMonthKey(d.generatedAt);
      if (!seen.has(key)) {
        seen.add(key);
        options.push({ key, label: formatMonthLabel(key) });
      }
    }
    return options; // already sorted newest-first from API
  }, [data]);

  // Default to most recent month
  const activeMonth = selectedMonth ?? monthOptions[0]?.key ?? null;

  // Filter digests for wire table: exclude today's (shown in broadsheet) and filter by month
  const latestSlug = data?.digests[0] ? tsToDateSlug(data.digests[0].generatedAt) : null;
  const wireDigests = useMemo(() => {
    if (!data?.digests || !activeMonth) return [];
    return data.digests.filter((d) => {
      if (tsToDateSlug(d.generatedAt) === latestSlug) return false;
      return tsToMonthKey(d.generatedAt) === activeMonth;
    });
  }, [data, activeMonth, latestSlug]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        {/* Broadsheet skeleton */}
        <div className="border-t border-b border-border py-6 space-y-3">
          <Skeleton className="h-3 w-48 mx-auto" />
          <Skeleton className="h-3 w-36 mx-auto" />
          <Skeleton className="h-6 w-72 mt-4" />
          <Skeleton className="h-4 w-full mt-2" />
          <Skeleton className="h-4 w-4/5" />
        </div>
        {/* Wire skeleton */}
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-20 ml-auto" />
          </div>
        ))}
      </div>
    );
  }

  if (!data || data.digests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        No digests yet. Check back tomorrow.
      </p>
    );
  }

  return (
    <div>
      <StaleDataBanner
        queries={[{ label: "Digests", dataUpdatedAt, staleTime: CRON_24H }]}
      />

      {/* Broadsheet: today's digest */}
      <DailyDigest showArchiveLink={false} />

      {/* Archive divider */}
      <div className="flex items-center gap-3 my-6">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Archive
        </span>
        <div className="flex-1 border-t border-border" />
      </div>

      {/* Month picker */}
      {monthOptions.length > 1 && (
        <div className="mb-4">
          <select
            value={activeMonth ?? ""}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="text-sm bg-transparent border border-border rounded px-2 py-1 text-foreground"
          >
            {monthOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Wire table */}
      <div>
        {wireDigests.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No other digests this month.
          </p>
        )}
        {wireDigests.map((d) => (
          <Link
            key={d.generatedAt}
            href={`/digest/${tsToDateSlug(d.generatedAt)}/`}
            className="flex items-center gap-3 sm:gap-4 py-2.5 border-b border-border/30 hover:bg-muted/20 transition-colors -mx-2 px-2 rounded"
          >
            <span className="font-mono text-xs text-muted-foreground w-14 shrink-0">
              {formatWireDate(d.generatedAt)}
            </span>
            <span className="text-sm font-medium truncate flex-1">
              {d.digestTitle || "Signal & Noise"}
            </span>
            {d.psiBand && d.psiScore != null && (
              <span
                className={`text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-muted/50 shrink-0 hidden sm:inline ${PSI_BAND_CLASSES[d.psiBand] ?? ""}`}
              >
                {d.psiBand} {d.psiScore.toFixed(1)}
              </span>
            )}
            {d.totalMcapUsd != null && (
              <span className="text-xs font-mono text-muted-foreground shrink-0 hidden sm:inline">
                {formatCurrency(d.totalMcapUsd, 0)}
              </span>
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Update the digest page layout**

In `src/app/digest/page.tsx`, simplify the page. Remove the h1, remove the three intro paragraphs and Telegram link (relocate to a footer note below the archive). Keep the breadcrumb. The intro content moves to a small muted note below the wire table.

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestArchiveClient } from "@/components/digest-archive-client";

export const metadata: Metadata = {
  title: "Daily Digest Archive: Pharos Stablecoin Recaps",
  description:
    "Browse the full archive of Pharos daily stablecoin market recaps. Sardonic commentary backed by hard data.",
  alternates: {
    canonical: "/digest/",
  },
  openGraph: {
    title: "Daily Digest Archive: Pharos Stablecoin Recaps",
    description:
      "Browse the full archive of Pharos daily stablecoin market recaps. Sardonic commentary backed by hard data.",
    url: "/digest/",
  },
};

export default function DigestArchivePage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Daily Digest Archive" path="/digest/" />
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-foreground">Daily Digest Archive</span>
      </nav>

      <DigestArchiveClient />

      <p className="text-xs text-muted-foreground text-center max-w-2xl mx-auto pt-4">
        Each day Pharos generates a market recap covering peg deviations, supply movements, and emerging
        trends across the stablecoin landscape. Also published on the{" "}
        <a href="https://t.me/pharoswatch" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">
          Pharos Telegram channel
        </a>.
      </p>
    </div>
  );
}
```

**Step 3: Verify it builds**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Visual check**

Run: `npm run dev`
Check both pages:
- Homepage: broadsheet with masthead, serif headline, extended body, "Read all previous recaps" link
- `/digest/`: broadsheet at top, "ARCHIVE" divider, month picker, wire rows with date/title/PSI/mcap/chevron

**Step 5: Commit**

```bash
git add src/components/digest-archive-client.tsx src/app/digest/page.tsx
git commit -m "feat(ui): wire-service archive table with month picker and PSI/mcap columns"
```

---

### Task 6: Clean up unused code

**Files:**
- Modify: `src/components/daily-digest.tsx` (if anything leftover)
- Check: `src/components/digest-archive-summary.tsx` — verify the homepage summary card (violet border, 3 stats) is unaffected

**Step 1: Verify no dead imports or unused exports**

Run: `npm run lint`
Expected: No new warnings

**Step 2: Verify `digest-archive-summary.tsx` still works**

This is the small violet-bordered card on the homepage — it should be completely unaffected. Confirm it doesn't import from `daily-digest.tsx` or `digest-archive-client.tsx` in a way that would break.

**Step 3: Run full build + type-check**

Run: `npm run build`
Expected: Clean build

**Step 4: Commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: clean up unused digest imports"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `docs/digest-pipeline.md` — update the Frontend section to describe the new broadsheet + wire layout

**Step 1: Update the digest pipeline docs**

In `docs/digest-pipeline.md`, update the Frontend section to describe:
- The broadsheet component (masthead, serif headline, extended body)
- The wire table on `/digest/` (month picker, date/title/PSI/mcap rows)
- That `text` field is never rendered on the website
- The enriched archive API response (new `psiScore`, `psiBand`, `totalMcapUsd` fields)

**Step 2: Commit**

```bash
git add docs/digest-pipeline.md
git commit -m "docs: update digest pipeline for broadsheet and wire archive redesign"
```
