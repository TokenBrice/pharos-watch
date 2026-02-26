# Detail Hero Card Polish — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine the stablecoin detail hero card's spacing, typography, and divider hierarchy for a more intentional, professional feel.

**Architecture:** CSS-only changes across two files. The hero card in `client.tsx` gets structural reflow (left column grouping, stats grid tightening, divider consistency). The section nav in `detail-section-nav.tsx` gets tighter spacing and an active tab underline.

**Tech Stack:** Tailwind CSS v4, React/Next.js (JSX class changes only)

**Design doc:** `docs/plans/2026-02-26-hero-card-polish-design.md`

---

### Task 1: Card wrapper and breadcrumb bar

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:143` (Card className)
- Modify: `src/app/stablecoin/[id]/client.tsx:145` (breadcrumb bar)

**Step 1: Add gap-0 to Card and tighten breadcrumb bar**

In `client.tsx`, line 143, change:
```tsx
<Card className="rounded-xl">
```
to:
```tsx
<Card className="rounded-xl gap-0">
```

Line 145, change:
```tsx
<div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border/40">
```
to:
```tsx
<div className="flex items-center justify-between px-5 pt-3 pb-2.5 border-b border-border/30">
```

**Step 2: Lighten section nav wrapper border**

Line 330, change:
```tsx
<div className="border-t border-border/40">
```
to:
```tsx
<div className="border-t border-border/30">
```

**Step 3: Run type-check**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx
git commit -m "style(detail-hero): tighten card wrapper and breadcrumb bar"
```

---

### Task 2: Left column — identity zone reflow

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:165-216`

**Step 1: Reduce column gap and group identity + classification**

Line 165, change:
```tsx
<div className="lg:w-[45%] flex flex-col gap-4">
```
to:
```tsx
<div className="lg:w-[45%] flex flex-col gap-3">
```

Wrap the identity row (lines 167-188) and classification line (lines 191-197) in a grouping div. The result should be:

```tsx
{/* Identity + classification group */}
<div className="flex flex-col gap-1.5">
  {/* Identity row */}
  <div className="flex flex-wrap items-center gap-3">
    {/* ...logo, h1, symbol, badge — unchanged... */}
  </div>

  {/* Classification line */}
  <p className="text-sm text-muted-foreground">
    {/* ...governance · backing · peg — unchanged... */}
  </p>
</div>
```

**Step 2: Add price zone border and shrink gauge**

Line 200, change:
```tsx
<div className="flex items-center gap-4 mt-auto">
```
to:
```tsx
<div className="flex items-center gap-4 mt-auto border-t border-border/30 pt-3">
```

Line 204, change:
```tsx
className="w-full max-w-[140px]"
```
to:
```tsx
className="w-full max-w-[110px]"
```

**Step 3: Inset vertical column divider**

Line 219, change:
```tsx
<div className="hidden lg:block w-px bg-border/40" />
```
to:
```tsx
<div className="hidden lg:block w-px bg-border/30 my-3" />
```

**Step 4: Run type-check**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 5: Commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx
git commit -m "style(detail-hero): reflow left column identity zone"
```

---

### Task 3: Stats grid — padding, dividers, min-height

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:225-316`

**Step 1: Update all four cell containers**

For each of the four stat cells, apply these class changes:

**Market Cap cell** (line 225), change:
```tsx
<div className="p-3 border-b border-r border-border/40">
```
to:
```tsx
<div className="px-3.5 py-2.5 min-h-[76px] border-b border-r border-border/30">
```

**Supply cell** (line 237), change:
```tsx
<div className="p-3 border-b border-border/40">
```
to:
```tsx
<div className="px-3.5 py-2.5 min-h-[76px] border-b border-border/30">
```

**Peg Score cell (with data)** (line 268), change:
```tsx
<div className="p-3 border-r border-border/40">
```
to (the `border-l-2` color is dynamic based on score):
```tsx
<div className={`px-3.5 py-2.5 min-h-[76px] border-r border-border/30 ${pegScoreResult?.pegScore != null ? `border-l-2 ${pegScoreColor(pegScoreResult.pegScore).replace("text-", "border-l-")}` : ""}`}>
```

Wait — that dynamic class construction violates Tailwind purge rules. Instead, use a helper to map score to a static border class. Since `pegScoreColor` returns `text-green-500`, `text-amber-500`, or `text-red-500`, we need a parallel border mapping.

Better approach: compute the border class before the JSX:

Before the return statement (around line 115, after pegScoreResult is computed), add:
```tsx
const pegScoreBorderClass = (() => {
  const score = pegScoreResult?.pegScore;
  if (score == null) return "";
  if (score >= 90) return "border-l-2 border-l-green-500";
  if (score >= 70) return "border-l-2 border-l-amber-500";
  return "border-l-2 border-l-red-500";
})();
```

Then the Peg Score cell becomes:
```tsx
<div className={`px-3.5 py-2.5 min-h-[76px] border-r border-border/30 ${pegScoreBorderClass}`}>
```

**Peg Score cell (NAV token)** (line 287), change:
```tsx
<div className="p-3 border-r border-border/40">
```
to:
```tsx
<div className="px-3.5 py-2.5 min-h-[76px] border-r border-border/30">
```

**Liquidity cell** (line 294): This needs a similar dynamic border. Add before the return:
```tsx
const liqBorderClass = (() => {
  const liq = liquidityMap?.[id];
  if (liq == null || liq.liquidityScore === null) return "";
  const score = liq.liquidityScore;
  if (score >= 80) return "border-l-2 border-l-emerald-500";
  if (score >= 60) return "border-l-2 border-l-blue-500";
  if (score >= 40) return "border-l-2 border-l-amber-500";
  return "border-l-2 border-l-red-500";
})();
```

Then line 294 becomes:
```tsx
<div className={`px-3.5 py-2.5 min-h-[76px] ${liqBorderClass}`}>
```

**Step 2: Update active depeg warning**

Line 321, change:
```tsx
<div className="px-3 pt-3 border-t border-border/40 text-xs">
```
to:
```tsx
<div className="px-3.5 pt-2.5 pb-2.5 border-t border-border/30 text-xs bg-red-500/5">
```

**Step 3: Run type-check**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx
git commit -m "style(detail-hero): tighten stats grid padding, dividers, and score accents"
```

---

### Task 4: Stats grid — typography refinements

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:227-315`

**Step 1: Add leading-none to stat values**

Market Cap value (line 227), change:
```tsx
<div className="text-xl font-bold font-mono tracking-tight leading-tight">{formatCurrency(mcap)}</div>
```
to:
```tsx
<div className="text-xl font-bold font-mono tracking-tight leading-none">{formatCurrency(mcap)}</div>
```

Supply value (line 239), change:
```tsx
<div className="text-xl font-bold font-mono tracking-tight leading-tight">{formatSupply(supply)} <span className="text-base text-muted-foreground">{coin.symbol}</span></div>
```
to:
```tsx
<div className="text-xl font-bold font-mono tracking-tight leading-none">{formatSupply(supply)} <span className="text-sm text-muted-foreground">{coin.symbol}</span></div>
```

Peg Score value (line 272), change:
```tsx
<div className={`text-xl font-bold font-mono tracking-tight leading-tight ${pegScoreColor(pegScoreResult.pegScore)}`}>
  {pegScoreResult.pegScore}<span className="text-base text-muted-foreground">/100</span>
```
to:
```tsx
<div className={`text-xl font-bold font-mono tracking-tight leading-none ${pegScoreColor(pegScoreResult.pegScore)}`}>
  {pegScoreResult.pegScore}<span className="text-sm text-muted-foreground">/100</span>
```

Liquidity value (line 304), change:
```tsx
<div className={`text-xl font-bold font-mono tracking-tight leading-tight ${getScoreColor(score)}`}>
  {Math.round(score)}<span className="text-base text-muted-foreground">/100</span>
```
to:
```tsx
<div className={`text-xl font-bold font-mono tracking-tight leading-none ${getScoreColor(score)}`}>
  {Math.round(score)}<span className="text-sm text-muted-foreground">/100</span>
```

**Step 2: Tighten sub-value spacing and add tabular-nums**

Market Cap change % (line 228), change:
```tsx
<p className={`text-xs font-mono mt-1 ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
```
to:
```tsx
<p className={`text-xs font-mono tabular-nums mt-0.5 ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
```

Supply change % (line 240), change:
```tsx
<p className="text-xs font-mono mt-1">
```
to:
```tsx
<p className="text-xs font-mono tabular-nums mt-0.5">
```

Peg Score sub-value (line 275), change:
```tsx
<p className="text-xs text-muted-foreground font-mono mt-1">
```
to:
```tsx
<p className="text-xs text-muted-foreground font-mono mt-0.5">
```

Liquidity TVL (line 307), change:
```tsx
<p className="text-xs text-muted-foreground font-mono mt-1">
```
to:
```tsx
<p className="text-xs text-muted-foreground font-mono mt-0.5">
```

**Step 3: Run type-check**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx
git commit -m "style(detail-hero): refine stat typography and score suffix sizing"
```

---

### Task 5: Section nav — tighter spacing and active underline

**Files:**
- Modify: `src/components/detail-section-nav.tsx:62,70-74`

**Step 1: Tighten nav container spacing**

Line 62, change:
```tsx
<div className="flex gap-1 p-1.5">
```
to:
```tsx
<div className="flex gap-0.5 p-1">
```

**Step 2: Add active tab underline**

Lines 70-74, change:
```tsx
className={cn(
  "px-3 py-2 text-sm font-medium whitespace-nowrap rounded-lg transition-colors",
  activeId === section.id
    ? "text-foreground bg-muted"
    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
)}
```
to:
```tsx
className={cn(
  "px-3 py-2 text-sm font-medium whitespace-nowrap rounded-lg transition-colors",
  activeId === section.id
    ? "text-foreground bg-muted border-b-2 border-foreground/60"
    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
)}
```

**Step 3: Run type-check**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add src/components/detail-section-nav.tsx
git commit -m "style(detail-hero): tighten section nav and add active underline"
```

---

### Task 6: Visual verification

**Step 1: Start dev server and inspect**

Run: `npm run dev`

Open a stablecoin detail page (e.g., `/stablecoin/tether`) and verify:

- [ ] Breadcrumb bar is slightly more compact
- [ ] Left column identity + classification read as a single zone
- [ ] Price zone has a subtle top border separating it from identity
- [ ] Gauge is narrower (110px vs 140px)
- [ ] Vertical divider has inset (doesn't touch top/bottom edges)
- [ ] Stats grid cells have uniform height
- [ ] Score cells (Peg Score, Liquidity) have colored left accent borders
- [ ] `/100` suffix is smaller than before
- [ ] Change percentages don't shift layout (tabular-nums)
- [ ] Active depeg warning (if visible) has faint red background
- [ ] Section nav tabs are slightly tighter
- [ ] Active tab has a bottom underline accent
- [ ] All horizontal dividers in the card use the same opacity

**Step 2: Check responsive behavior**

Resize to mobile width and verify:
- [ ] Left column stacks above stats grid cleanly
- [ ] Price zone border-top works on mobile
- [ ] Stats grid 2x2 remains intact
- [ ] Section nav scrolls horizontally

**Step 3: Check dark mode**

Toggle to dark mode and verify:
- [ ] Divider opacity `/30` is visible but subtle
- [ ] Score accent borders are visible
- [ ] Active depeg `bg-red-500/5` is perceptible
- [ ] No contrast issues

**Step 4: Final commit if any adjustments needed**

```bash
git add -A && git commit -m "style(detail-hero): visual adjustments from inspection"
```
