# GA Event Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 17 custom GA4 events to understand which Pharos features people actually use vs ignore.

**Architecture:** One new file `src/lib/analytics.ts` with a typed `trackEvent()` wrapper, plus one-line additions in 10 existing files. No new dependencies.

**Tech Stack:** GA4 (gtag.js already loaded), TypeScript, React event handlers.

---

## Scope Adjustments from Design

After reading the actual code, three design-doc events were dropped:

- **`digest_opened`** — Digest archive is a static list with no click handlers. GA4 pageview covers the page visit.
- **`coin_detail_navigated`** — Navigation to `/stablecoin/[id]` is captured by GA4 automatic pageviews. Adding a `source` param would require wrapping dozens of `Link`/`router.push` calls for marginal value.
- **`report_card_viewed`** — Same as above; clicking a ReportCardMini navigates to the detail page, already captured by pageview.

Also corrected file paths from the design doc:
- `src/components/report-cards/portfolio-panel.tsx` → **`src/components/portfolio-panel.tsx`**
- `src/components/report-cards/stress-test-panel.tsx` → **`src/components/stress-test-panel.tsx`**
- `src/app/report-cards/client.tsx` → **`src/app/risk-lab/client.tsx`**

---

### Task 1: Create analytics utility

**Files:**
- Create: `src/lib/analytics.ts`

**Step 1: Create the analytics utility file**

```typescript
// src/lib/analytics.ts

// Extend Window to include gtag
declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// ---------------------------------------------------------------------------
// Event catalog — every custom event and its typed parameters
// ---------------------------------------------------------------------------

type EventMap = {
  // Tier 1 — Feature Adoption
  portfolio_coin_added: { coin_id: string };
  portfolio_shared: { coin_count: number };
  stress_test_run: { target_coin: string; target_grade: string; affected_count: number };
  comparison_created: { coin_count: number; coin_ids: string };
  comparison_exported: { method: string; coin_count: number };
  search_performed: { page: string; query_length: number };
  // Tier 2 — Feature Engagement
  filter_applied: { page: string; filter_type: string; filter_value: string };
  time_range_changed: { page: string; range: string };
  sort_changed: { page: string; sort_by: string };
  contract_copied: { coin_id: string; chain: string };
  // Tier 3 — Engagement Signals
  theme_toggled: { theme: string };
  panel_toggled: { panel: string; action: string };
  portfolio_cleared: { coin_count: number };
  portfolio_coin_removed: { coin_id: string };
  share_link_copied: { page: string; content_type: string };
};

// ---------------------------------------------------------------------------
// Core tracking function
// ---------------------------------------------------------------------------

export function trackEvent<K extends keyof EventMap>(
  name: K,
  params: EventMap[K],
): void {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", name, params);
  }
}

// ---------------------------------------------------------------------------
// Debounced search tracking (fires once after user stops typing for 1s)
// ---------------------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export function trackSearch(page: string, queryLength: number): void {
  if (searchTimer) clearTimeout(searchTimer);
  if (queryLength === 0) return;
  searchTimer = setTimeout(() => {
    trackEvent("search_performed", { page, query_length: queryLength });
  }, 1000);
}
```

**Step 2: Verify it type-checks**

Run: `npm run build`
Expected: PASS (new file is standalone, no consumers yet)

**Step 3: Commit**

```bash
git add src/lib/analytics.ts
git commit -m "feat(analytics): add typed GA4 event tracking utility"
```

---

### Task 2: Portfolio panel events

**Files:**
- Modify: `src/components/portfolio-panel.tsx`

Events: `portfolio_coin_added`, `portfolio_shared`, `portfolio_cleared`, `portfolio_coin_removed`, `panel_toggled`

**Step 1: Add import**

At `src/components/portfolio-panel.tsx:15` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track panel toggle**

At line 283, change:

```typescript
<CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => !v)}>
```

to:

```typescript
<CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => { const next = !v; trackEvent("panel_toggled", { panel: "portfolio", action: next ? "open" : "close" }); return next; })}>
```

**Step 3: Track share**

In the `handleShare` callback (line 264-274), add tracking after the successful clipboard write. Change:

```typescript
  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setToast("Link copied to clipboard");
      setTimeout(() => setToast(null), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);
```

to:

```typescript
  const handleShare = useCallback(async () => {
    const url = portfolio.shareUrl();
    if (!url) return;
    trackEvent("portfolio_shared", { coin_count: portfolio.holdings.length });
    try {
      await navigator.clipboard.writeText(url);
      setToast("Link copied to clipboard");
      setTimeout(() => setToast(null), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [portfolio]);
```

**Step 4: Track clear**

In the `handleClear` callback (line 276-278), change:

```typescript
  const handleClear = useCallback(() => {
    portfolio.clearAll();
  }, [portfolio]);
```

to:

```typescript
  const handleClear = useCallback(() => {
    trackEvent("portfolio_cleared", { coin_count: portfolio.holdings.length });
    portfolio.clearAll();
  }, [portfolio]);
```

**Step 5: Track add coin**

At line 357, change:

```typescript
onSelect={(coin) => portfolio.addCoin(coin.id, 0)}
```

to:

```typescript
onSelect={(coin) => { trackEvent("portfolio_coin_added", { coin_id: coin.id }); portfolio.addCoin(coin.id, 0); }}
```

**Step 6: Track remove coin**

At line 348, change:

```typescript
onRemove={portfolio.removeCoin}
```

to:

```typescript
onRemove={(coinId) => { trackEvent("portfolio_coin_removed", { coin_id: coinId }); portfolio.removeCoin(coinId); }}
```

**Step 7: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 8: Commit**

```bash
git add src/components/portfolio-panel.tsx
git commit -m "feat(analytics): track portfolio interactions"
```

---

### Task 3: Stress test panel events

**Files:**
- Modify: `src/components/stress-test-panel.tsx`

Events: `stress_test_run`, `panel_toggled`

**Step 1: Add import**

At `src/components/stress-test-panel.tsx:14` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track panel toggle**

At line 126, change:

```typescript
<CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => !v)}>
```

to:

```typescript
<CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen((v) => { const next = !v; trackEvent("panel_toggled", { panel: "stress_test", action: next ? "open" : "close" }); return next; })}>
```

**Step 3: Track stress test run**

The stress test fires reactively when BOTH target coin and grade are set. Track on the grade selection (since that's the final step that triggers the simulation).

At line 182-183, change:

```typescript
onChange={(e) =>
  stressTest.setGrade((e.target.value as ReportCardGrade) || null)
}
```

to:

```typescript
onChange={(e) => {
  const grade = (e.target.value as ReportCardGrade) || null;
  stressTest.setGrade(grade);
  if (grade && stressTest.targetCoinId) {
    trackEvent("stress_test_run", {
      target_coin: stressTest.targetCoinId,
      target_grade: grade,
      affected_count: stressTest.impacts.length,
    });
  }
}}
```

**Step 4: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/stress-test-panel.tsx
git commit -m "feat(analytics): track stress test simulations"
```

---

### Task 4: Compare page events

**Files:**
- Modify: `src/app/compare/client.tsx`

Events: `comparison_created`, `comparison_exported`, `time_range_changed`

**Step 1: Add import**

At `src/app/compare/client.tsx:37` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track comparison created**

At line 216-227, change `handleSelect` to fire when 2+ coins are selected:

```typescript
  const handleSelect = (slotIndex: number, coin: CoinOption) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      // If the slot already has a value, replace it; otherwise append
      if (slotIndex < prev.length) {
        next[slotIndex] = coin.id;
      } else {
        next.push(coin.id);
      }
      return next;
    });
  };
```

to:

```typescript
  const handleSelect = (slotIndex: number, coin: CoinOption) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      if (slotIndex < prev.length) {
        next[slotIndex] = coin.id;
      } else {
        next.push(coin.id);
      }
      if (next.length >= 2) {
        trackEvent("comparison_created", {
          coin_count: next.length,
          coin_ids: next.slice(0, 5).join(","),
        });
      }
      return next;
    });
  };
```

**Step 3: Track Twitter share**

In `handleTwitterShare` (line 299-328), add tracking before `window.open()`. After line 319 (`setShareLoading(false);` in finally block), before `const symbols = ...`, add:

```typescript
    trackEvent("comparison_exported", { method: "tweet", coin_count: comparisonCoins.length });
```

Specifically, change:

```typescript
    } finally {
      setShareLoading(false);
    }
    const symbols = comparisonCoins.map((c) => c.symbol).join(" vs ");
```

to:

```typescript
    } finally {
      setShareLoading(false);
    }
    trackEvent("comparison_exported", { method: "tweet", coin_count: comparisonCoins.length });
    const symbols = comparisonCoins.map((c) => c.symbol).join(" vs ");
```

**Step 4: Track web share**

In `handleWebShare` (line 330-368), add tracking at the top of the try block. Change:

```typescript
  const handleWebShare = useCallback(async () => {
    setShareLoading(true);
    try {
      const data = await buildShareData();
```

to:

```typescript
  const handleWebShare = useCallback(async () => {
    setShareLoading(true);
    trackEvent("comparison_exported", { method: "share", coin_count: comparisonCoins.length });
    try {
      const data = await buildShareData();
```

**Step 5: Track download**

In `handleDownload` (line 370-386), add tracking after `a.click()`. Change:

```typescript
      a.download = "pharos-compare.png";
      a.click();
      URL.revokeObjectURL(url);
```

to:

```typescript
      a.download = "pharos-compare.png";
      a.click();
      URL.revokeObjectURL(url);
      trackEvent("comparison_exported", { method: "download", coin_count: comparisonCoins.length });
```

**Step 6: Track time range change**

In `setRange` (line 69-81), add tracking. Change:

```typescript
  const setRange = useCallback(
    (newRange: TimeRangeOption) => {
      const params = new URLSearchParams(searchParams.toString());
```

to:

```typescript
  const setRange = useCallback(
    (newRange: TimeRangeOption) => {
      trackEvent("time_range_changed", { page: "compare", range: newRange });
      const params = new URLSearchParams(searchParams.toString());
```

**Step 7: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 8: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(analytics): track comparison and export events"
```

---

### Task 5: Peg tracker events

**Files:**
- Modify: `src/app/peg-tracker/client.tsx`

Events: `filter_applied`, `search_performed`

**Step 1: Add import**

At `src/app/peg-tracker/client.tsx:15` (after last import), add:

```typescript
import { trackEvent, trackSearch } from "@/lib/analytics";
```

**Step 2: Add tracking to filter/search callbacks**

Change lines 33-35:

```typescript
  const setPegFilter = useCallback((v: PegCurrency | "all") => setParam("peg", v), [setParam]);
  const setTypeFilter = useCallback((v: GovernanceType | "all") => setParam("type", v), [setParam]);
  const setSearchQuery = useCallback((v: string) => setParam("q", v), [setParam]);
```

to:

```typescript
  const setPegFilter = useCallback((v: PegCurrency | "all") => { trackEvent("filter_applied", { page: "peg-tracker", filter_type: "peg", filter_value: v }); setParam("peg", v); }, [setParam]);
  const setTypeFilter = useCallback((v: GovernanceType | "all") => { trackEvent("filter_applied", { page: "peg-tracker", filter_type: "type", filter_value: v }); setParam("type", v); }, [setParam]);
  const setSearchQuery = useCallback((v: string) => { trackSearch("peg-tracker", v.length); setParam("q", v); }, [setParam]);
```

**Step 3: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/peg-tracker/client.tsx
git commit -m "feat(analytics): track peg tracker filters and search"
```

---

### Task 6: Blacklist page events

**Files:**
- Modify: `src/app/blacklist/page.tsx`

Events: `filter_applied`, `search_performed`

**Step 1: Add import**

At `src/app/blacklist/page.tsx:16` (after last import), add:

```typescript
import { trackEvent, trackSearch } from "@/lib/analytics";
```

**Step 2: Add tracking to filter callbacks**

Change lines 40-51:

```typescript
  const handleStablecoinChange = useCallback((v: BlacklistStablecoin | "all") => {
    updateParams({ stablecoin: v, page: "1" });
  }, [updateParams]);
  const handleChainChange = useCallback((v: string) => {
    updateParams({ chain: v, page: "1" });
  }, [updateParams]);
  const handleEventTypeChange = useCallback((v: BlacklistEventType | "all") => {
    updateParams({ event: v, page: "1" });
  }, [updateParams]);
  const handleSearchChange = useCallback((v: string) => {
    updateParams({ q: v || "all", page: "1" });
  }, [updateParams]);
```

to:

```typescript
  const handleStablecoinChange = useCallback((v: BlacklistStablecoin | "all") => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "stablecoin", filter_value: v });
    updateParams({ stablecoin: v, page: "1" });
  }, [updateParams]);
  const handleChainChange = useCallback((v: string) => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "chain", filter_value: v });
    updateParams({ chain: v, page: "1" });
  }, [updateParams]);
  const handleEventTypeChange = useCallback((v: BlacklistEventType | "all") => {
    trackEvent("filter_applied", { page: "blacklist", filter_type: "event_type", filter_value: v });
    updateParams({ event: v, page: "1" });
  }, [updateParams]);
  const handleSearchChange = useCallback((v: string) => {
    trackSearch("blacklist", v.length);
    updateParams({ q: v || "all", page: "1" });
  }, [updateParams]);
```

**Step 3: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/blacklist/page.tsx
git commit -m "feat(analytics): track blacklist filters and search"
```

---

### Task 7: Liquidity page events

**Files:**
- Modify: `src/app/liquidity/client.tsx`

Events: `filter_applied`, `search_performed`

**Step 1: Add import**

At `src/app/liquidity/client.tsx:20` (after last import), add:

```typescript
import { trackEvent, trackSearch } from "@/lib/analytics";
```

**Step 2: Add tracking to filter/search callbacks**

Change lines 35-36:

```typescript
  const setPegFilter = useCallback((v: PegCurrency | "all") => setParam("peg", v), [setParam]);
  const setSearchQuery = useCallback((v: string) => setParam("q", v), [setParam]);
```

to:

```typescript
  const setPegFilter = useCallback((v: PegCurrency | "all") => { trackEvent("filter_applied", { page: "liquidity", filter_type: "peg", filter_value: v }); setParam("peg", v); }, [setParam]);
  const setSearchQuery = useCallback((v: string) => { trackSearch("liquidity", v.length); setParam("q", v); }, [setParam]);
```

**Step 3: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/liquidity/client.tsx
git commit -m "feat(analytics): track liquidity filters and search"
```

---

### Task 8: Risk Lab page events

**Files:**
- Modify: `src/app/risk-lab/client.tsx`

Events: `filter_applied`, `sort_changed`

**Step 1: Add import**

At `src/app/risk-lab/client.tsx:18` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track grade filter**

At line 260 and 278, the grade filter buttons call `setGradeFilter(...)`. Change to tracking wrappers.

Change line 260:

```typescript
            onClick={() => setGradeFilter("all")}
```

to:

```typescript
            onClick={() => { trackEvent("filter_applied", { page: "risk-lab", filter_type: "grade", filter_value: "all" }); setGradeFilter("all"); }}
```

Change line 278:

```typescript
                onClick={() => setGradeFilter(range)}
```

to:

```typescript
                onClick={() => { trackEvent("filter_applied", { page: "risk-lab", filter_type: "grade", filter_value: range }); setGradeFilter(range); }}
```

**Step 3: Track sort**

Change line 300:

```typescript
              onClick={() => setSortKey(opt.key)}
```

to:

```typescript
              onClick={() => { trackEvent("sort_changed", { page: "risk-lab", sort_by: opt.key }); setSortKey(opt.key); }}
```

**Step 4: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/risk-lab/client.tsx
git commit -m "feat(analytics): track risk lab filters and sort"
```

---

### Task 9: Stability Index time range events

**Files:**
- Modify: `src/app/stability-index/client.tsx`

Events: `time_range_changed`

The `setRange` functions are returned from `useTimeRangeFilter` inside `ScoreChart` and `ComponentChart` sub-components, then passed to `TimeRangeButtons` via `onChange={setRange}`. The cleanest insertion is to wrap `setRange` in those components.

**Step 1: Add import**

At `src/app/stability-index/client.tsx:23` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track score chart time range**

In `ScoreChart` (line 133), change:

```typescript
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
```

to:

```typescript
        <TimeRangeButtons options={options} value={range} onChange={(r) => { trackEvent("time_range_changed", { page: "stability-index-score", range: r }); setRange(r); }} />
```

**Step 3: Track component chart time range**

In `ComponentChart` (line 294), change:

```typescript
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
```

to:

```typescript
        <TimeRangeButtons options={options} value={range} onChange={(r) => { trackEvent("time_range_changed", { page: "stability-index-components", range: r }); setRange(r); }} />
```

**Step 4: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/stability-index/client.tsx
git commit -m "feat(analytics): track stability index time range changes"
```

---

### Task 10: Theme toggle event

**Files:**
- Modify: `src/components/theme-toggle.tsx`

Events: `theme_toggled`

**Step 1: Add import**

At `src/components/theme-toggle.tsx:6` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track theme toggle**

At line 22, change:

```typescript
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
```

to:

```typescript
      onClick={() => { const next = theme === "dark" ? "light" : "dark"; trackEvent("theme_toggled", { theme: next }); setTheme(next); }}
```

**Step 3: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/theme-toggle.tsx
git commit -m "feat(analytics): track theme toggle"
```

---

### Task 11: Contract address copy event

**Files:**
- Modify: `src/components/contract-addresses.tsx`

Events: `contract_copied`

**Step 1: Add import**

At `src/components/contract-addresses.tsx:8` (after last import), add:

```typescript
import { trackEvent } from "@/lib/analytics";
```

**Step 2: Track contract copy**

At line 36, change:

```typescript
            onClick={() => navigator.clipboard.writeText(openContract.address)}
```

to:

```typescript
            onClick={() => { navigator.clipboard.writeText(openContract.address); trackEvent("contract_copied", { coin_id: meta.id, chain: openContract.chain }); }}
```

Note: `meta` is available as a prop — it's the `StablecoinMeta` passed to the component at line 18: `export function ContractAddresses({ meta }: { meta: StablecoinMeta })`. The `meta.id` field is the stablecoin ID (e.g., `"1"` for Tether). We need to verify this field exists on `StablecoinMeta`.

Actually — looking at the type, `StablecoinMeta` has an `id` field (it's `StablecoinMeta` from `src/lib/types.ts`). If it doesn't, use `meta.symbol` instead. Check the type before implementing.

**Step 3: Verify it type-checks**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/contract-addresses.tsx
git commit -m "feat(analytics): track contract address copy"
```

---

### Task 12: Final build verification

**Step 1: Full build + type-check**

Run: `npm run build`
Expected: PASS — all 10 modified files compile cleanly.

**Step 2: Verify no regressions**

Run: `npm run dev` — spot-check the app loads and interactive features still work.

**Step 3: Final commit (if any fixups needed)**

If any type errors or issues emerged, fix and commit.

---

## Event Summary (17 events across 10 files)

| # | Event | File |
|---|-------|------|
| 1 | `portfolio_coin_added` | `src/components/portfolio-panel.tsx` |
| 2 | `portfolio_shared` | `src/components/portfolio-panel.tsx` |
| 3 | `portfolio_cleared` | `src/components/portfolio-panel.tsx` |
| 4 | `portfolio_coin_removed` | `src/components/portfolio-panel.tsx` |
| 5 | `panel_toggled` | `src/components/portfolio-panel.tsx` + `stress-test-panel.tsx` |
| 6 | `stress_test_run` | `src/components/stress-test-panel.tsx` |
| 7 | `comparison_created` | `src/app/compare/client.tsx` |
| 8 | `comparison_exported` | `src/app/compare/client.tsx` |
| 9 | `time_range_changed` | `src/app/compare/client.tsx` + `stability-index/client.tsx` |
| 10 | `filter_applied` | `peg-tracker`, `blacklist`, `liquidity`, `risk-lab` |
| 11 | `search_performed` | `peg-tracker`, `blacklist`, `liquidity` (debounced) |
| 12 | `sort_changed` | `src/app/risk-lab/client.tsx` |
| 13 | `theme_toggled` | `src/components/theme-toggle.tsx` |
| 14 | `contract_copied` | `src/components/contract-addresses.tsx` |
| 15 | `share_link_copied` | (merged into `portfolio_shared`) |

## Deferred (handled by GA4 enhanced measurement)

- **Outbound link clicks** — Enable "Outbound clicks" in GA4 Admin > Enhanced Measurement. This auto-tracks all `<a>` tags pointing to external domains.
- **Page views / navigation** — Already auto-tracked.
- **Scroll depth** — Already auto-tracked.
