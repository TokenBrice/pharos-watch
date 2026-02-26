# Kill Peg Tracker Page — Merge into Homepage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete the standalone `/peg-tracker` route and integrate its two most valuable widgets (live peg deviation heatmap + recent depeg events feed) directly into the homepage.

**Architecture:** The homepage `HomepageClient` already fetches `usePegSummary` (heatmap data) — we only need to add `useDepegEvents` and local filter state. Navigation references to `/peg-tracker` are removed from header, footer, sitemap, about page, and market highlights. Orphaned components (stats bar, leaderboard, timeline, summary card) are deleted. The heatmap + depeg feed are placed at the bottom of the homepage, between "Key Movements" (`MarketHighlights`) and the `PegDiversityChart`.

**Safety note — peg data used elsewhere:** `usePegSummary`, `useDepegEvents`, `peg-score.ts`, and `severity-colors.ts` are shared libraries used across many pages. They are NOT touched. Only the peg-tracker *route files* and four *components exclusively used by that route* are deleted. All other peg-related features are unaffected:
- Peg Score column in the main stablecoin table (`stablecoin-table.tsx`) — data comes from `usePegSummary` prop passed by `HomepageClient`, unchanged
- Peg score on individual coin pages (`stablecoin/[id]/client.tsx`) — fetches its own `usePegSummary`, unchanged
- Peg data on Compare page (`compare/client.tsx`) — own hook calls, unchanged
- Portfolio panel (`portfolio-panel.tsx`) — own hook calls, unchanged
- Depeg history on coin detail pages (`depeg-history.tsx`) — uses `useDepegEvents` independently, unchanged

**Tech Stack:** Next.js 16 static export, React 19, TypeScript strict, TanStack Query, shadcn/ui, Tailwind v4.

---

## File Map

**Modify:**
- `src/components/homepage-client.tsx` — core integration
- `src/components/header.tsx` — remove nav item
- `src/components/footer.tsx` — remove footer link
- `src/app/sitemap.ts` — remove sitemap entry
- `src/app/about/page.tsx` — update dead link
- `src/components/market-highlights.tsx` — remove dead "View tracker →" link

**Delete (route):**
- `src/app/peg-tracker/page.tsx`
- `src/app/peg-tracker/client.tsx`
- `src/app/peg-tracker/error.tsx`

**Delete (orphaned components, only used by peg-tracker route):**
- `src/components/peg-tracker-stats.tsx`
- `src/components/peg-tracker-summary.tsx`
- `src/components/peg-leaderboard.tsx`
- `src/components/depeg-timeline.tsx`

**Keep (reused on homepage):**
- `src/components/peg-heatmap.tsx`
- `src/components/depeg-feed.tsx`

---

### Task 1: Update `HomepageClient` — wire heatmap + depeg feed

**File:** `src/components/homepage-client.tsx`

**Step 1: Read the file** (already done above — proceed)

**Step 2: Replace the import block**

Remove `PegTrackerSummary` import. Add `useState`, `useDepegEvents`, `PegHeatmap`, `DepegFeed`, and the two filter types.

Old imports to change:
```tsx
import { useMemo } from "react";
// ...
import { PegTrackerSummary } from "@/components/peg-tracker-summary";
```

New imports (add/change):
```tsx
import { useMemo, useState } from "react";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { PegHeatmap } from "@/components/peg-heatmap";
import { DepegFeed } from "@/components/depeg-feed";
import type { PegSummaryCoin, PegCurrency, GovernanceType } from "@/lib/types";
// Remove: import { PegTrackerSummary } from "@/components/peg-tracker-summary";
```

**Step 3: Add data fetching + filter state inside `HomepageClient`**

After the existing `const { data: reportCardsData } = useReportCards();` line, add:

```tsx
const { data: eventsData } = useDepegEvents();
const [pegFilter, setPegFilter] = useState<PegCurrency | "all">("all");
const [typeFilter, setTypeFilter] = useState<GovernanceType | "all">("all");

const filteredPegCoins = useMemo(
  () =>
    (pegSummaryData?.coins ?? []).filter((c) => {
      if (pegFilter !== "all" && c.pegCurrency !== pegFilter) return false;
      if (typeFilter !== "all" && c.governance !== typeFilter) return false;
      return true;
    }),
  [pegSummaryData, pegFilter, typeFilter],
);
```

Note: `pegSummaryData` already exists (line 34: `const { data: pegSummaryData } = usePegSummary()`). The `isLoading` variable is already available from `useStablecoins()` at line 32 — reuse it for the heatmap skeleton (close enough; both resolve in the same cron window).

**Step 4: Add heatmap + depeg feed sections in the JSX**

Insert the two blocks **between the "Key Movements" section and `<PegDiversityChart />`**. The current JSX order at the bottom of the return is:

```tsx
<section>
  <h2 …>Key Movements</h2>
  <MarketHighlights … />
</section>

<PegDiversityChart />

<p className="text-xs …">  {/* footer blurb */}
```

After the change it becomes:

```tsx
<section>
  <h2 …>Key Movements</h2>
  <MarketHighlights … />
</section>

<section>
  <PegHeatmap
    coins={filteredPegCoins}
    logos={logos}
    isLoading={isLoading}
    pegFilter={pegFilter}
    typeFilter={typeFilter}
    onPegFilterChange={setPegFilter}
    onTypeFilterChange={setTypeFilter}
  />
</section>

<DepegFeed
  events={eventsData?.events ?? []}
  logos={logos}
/>

<PegDiversityChart />

<p className="text-xs …">  {/* footer blurb — unchanged */}
```

Note: `onSearchChange` is intentionally omitted — the homepage already has its own search in the main table. The `PegHeatmap` component declares `onSearchChange?` as optional, so this is valid without any component changes.

**Step 5: Remove `<PegTrackerSummary />` from the feature cards grid**

Find:
```tsx
<PegTrackerSummary />
```
Delete that line. The grid now has 5 items. The `grid-cols-2 lg:grid-cols-3` class produces a 5th cell that's slightly uneven but acceptable. No grid class change needed.

**Step 6: Verify the file compiles**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors (or only pre-existing unrelated errors).

**Step 7: Commit**

```bash
git add src/components/homepage-client.tsx
git commit -m "feat(homepage): integrate peg heatmap and depeg feed"
```

---

### Task 2: Remove navigation references

**Files:** `src/components/header.tsx`, `src/components/footer.tsx`, `src/app/sitemap.ts`

**Step 1: Remove from header `NAV_ITEMS` array**

In `src/components/header.tsx`, delete the line:
```tsx
{ href: "/peg-tracker", label: "Peg Tracker", icon: Activity },
```

Also remove the `Activity` import from lucide-react (it's only used for this item). The import line is:
```tsx
import { Activity, ClipboardCheck, Droplets, Info, LayoutDashboard, Menu, ShieldBan, Skull, createLucideIcon } from "lucide-react";
```
Remove `Activity,` from it.

**Step 2: Remove from footer**

In `src/components/footer.tsx`, delete:
```tsx
<Link href="/peg-tracker" className="hover:text-foreground transition-colors">Peg Tracker</Link>
```

**Step 3: Remove from sitemap**

In `src/app/sitemap.ts`, delete:
```ts
{
  url: "https://pharos.watch/peg-tracker/",
  lastModified: new Date(),
  changeFrequency: "daily",
  priority: 0.8,
},
```

**Step 4: Commit**

```bash
git add src/components/header.tsx src/components/footer.tsx src/app/sitemap.ts
git commit -m "chore: remove peg-tracker from nav, footer, and sitemap"
```

---

### Task 3: Fix dead links in about page and market highlights

**Step 1: Fix `src/app/about/page.tsx`**

The about page at line 200 links to `/peg-tracker`:
```tsx
<Link href="/peg-tracker" className="font-bold underline underline-offset-4 hover:text-emerald-500 transition-colors">
  Peg Tracker
</Link>
```

Change it to link to the homepage:
```tsx
<Link href="/" className="font-bold underline underline-offset-4 hover:text-emerald-500 transition-colors">
  Peg Tracker
</Link>
```

**Step 2: Fix `src/components/market-highlights.tsx`**

At line 74–77, there's a "View tracker →" link:
```tsx
<Link
  href="/peg-tracker"
  className="text-xs font-normal normal-case tracking-normal text-muted-foreground hover:text-foreground transition-colors"
>
```

Since the content is now on the same page (homepage), remove the entire `<Link>` element. Keep the section heading text. Read the surrounding context first to make the edit cleanly.

**Step 3: Commit**

```bash
git add src/app/about/page.tsx src/components/market-highlights.tsx
git commit -m "chore: fix dead peg-tracker links in about page and market highlights"
```

---

### Task 4: Delete orphaned components and the peg-tracker route

**Step 1: Delete orphaned component files**

These components are only imported in `src/app/peg-tracker/client.tsx`, which is itself being deleted:
```bash
rm src/components/peg-tracker-stats.tsx
rm src/components/peg-tracker-summary.tsx
rm src/components/peg-leaderboard.tsx
rm src/components/depeg-timeline.tsx
```

**Step 2: Delete the peg-tracker route**

```bash
rm src/app/peg-tracker/page.tsx
rm src/app/peg-tracker/client.tsx
rm src/app/peg-tracker/error.tsx
rmdir src/app/peg-tracker
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: kill /peg-tracker page — content merged into homepage"
```

---

### Task 5: Full build verification

**Step 1: Run type-check**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1
```

Expected: clean (zero errors).

**Step 2: Run build**

```bash
npm run build 2>&1 | tail -30
```

Expected: successful static export with no errors. The `/peg-tracker` route should NOT appear in the page list.

**Step 3: If errors occur**

- Missing import → add it
- Unused import → remove it
- Type error → fix the prop type
- Do NOT proceed to done until build is clean
