# Hero Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 3-card stats layout + flat header on the stablecoin detail page with a single unified hero card containing a 2-column layout (identity+price | 2x2 stats grid).

**Architecture:** Server component (`page.tsx`) renders the card wrapper, breadcrumb, identity row, and classification line. Client component (`client.tsx`) renders the price/gauge area and the 2x2 stats grid inside the same card. DetailSectionNav moves inside the card as a bottom bar.

**Tech Stack:** React 19, Next.js 16, Tailwind CSS v4, shadcn/ui Card

---

### Task 1: Restructure server-side hero (page.tsx)

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx:83-145`

**Context:** Currently lines 95-142 render: breadcrumb row → logo/name/badges row → description paragraph, all in a `<div className="space-y-6">`. The client component is mounted below in a separate `<div className="mt-4">`. We need to wrap everything in a single Card and restructure.

**Step 1: Replace the hero markup**

Replace lines 95-145 (from `<div className="space-y-6">` through `<div className="mt-4">` and its closing tag) with the new unified card structure:

```tsx
<Card className="rounded-xl">
  {/* Top bar: breadcrumb + compare */}
  <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border/40">
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
      <span>/</span>
      <span className="text-foreground">{coin.name}</span>
    </nav>
    <Link
      href={`/compare/?coins=${coin.symbol.toLowerCase()}`}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeftRight className="h-3.5 w-3.5" />
      Compare
    </Link>
  </div>

  {/* Hero body: identity left, stats right — filled by client */}
  <StablecoinDetailClient
    id={id}
    summary={typedSummaries[id] ?? null}
    coin={coin}
    logoSrc={typedLogos[coin.id]}
    tags={tags}
  />
</Card>
```

Key changes:
- Import `Card` from `@/components/ui/card` (already imported in client, add to page)
- Remove the outer `<div className="space-y-6">` and `<div className="mt-4">` wrappers
- Pass `coin`, `logoSrc`, and `tags` as props to the client so it can render the identity section inside the card body (this avoids a server/client boundary splitting the card)
- The description paragraph (`"USDC is a Centralized..."`) is replaced by the classification line rendered inside the client

**Step 2: Update client component props**

In `client.tsx`, update the component signature:

```tsx
import type { StablecoinMeta } from "@/lib/types";

interface StablecoinDetailClientProps {
  id: string;
  summary: SummaryData | null;
  coin: StablecoinMeta;
  logoSrc?: string;
  tags: string[];
}

export default function StablecoinDetailClient({ id, summary, coin, logoSrc, tags }: StablecoinDetailClientProps) {
```

This also means removing the `TRACKED_META_BY_ID` lookup inside the client (line 56: `const meta = TRACKED_META_BY_ID.get(id)`) — use `coin` prop instead. Keep `meta` as an alias: `const meta = coin;`

**Step 3: Verify the build compiles**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds (may have runtime data issues — that's fine at this stage)

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/page.tsx src/app/stablecoin/\[id\]/client.tsx
git commit -m "refactor(detail): wrap hero in single Card, pass coin props to client"
```

---

### Task 2: Build the 2-column hero body in client.tsx

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:114-236`

**Context:** Currently the client renders `DetailSectionNav` → 3-card grid (lines 122-233). Replace with the 2-column hero layout inside the card, then DetailSectionNav as the card's bottom bar.

**Step 1: Replace the overview section with the new hero layout**

Delete the current `<section id="overview">` block (the 3-card grid, lines 124-236) and replace with:

```tsx
{/* Hero body: 2-column layout */}
<div className="px-5 py-4">
  <div className="flex flex-col lg:flex-row lg:items-stretch gap-6">

    {/* LEFT: Identity + Price */}
    <div className="lg:w-[45%] flex flex-col gap-4">
      {/* Identity row */}
      <div className="flex flex-wrap items-center gap-3">
        {logoSrc ? (
          <Image
            src={logoSrc}
            alt={`${coin.name} logo`}
            width={48}
            height={48}
            className="rounded-full flex-shrink-0"
            unoptimized
          />
        ) : (
          <div
            className="flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground"
            style={{ width: 48, height: 48 }}
          >
            {coin.name.charAt(0).toUpperCase()}
          </div>
        )}
        <h1 className="text-2xl font-extrabold tracking-tighter">{coin.name}</h1>
        <span className="text-lg text-muted-foreground font-mono">{coin.symbol}</span>
        <BluechipHeaderBadge stablecoinId={coin.id} />
      </div>

      {/* Classification line */}
      <p className="text-sm text-muted-foreground">
        {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}
        {" · "}
        {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}
        {" · "}
        {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
      </p>

      {/* Price + Gauge */}
      {coinData && (
        <div className="flex items-center gap-4 mt-auto">
          {coinData.price != null && pegRef > 0 && (
            <PegGauge
              deviationBps={Math.round(((coinData.price - pegRef) / pegRef) * 10000)}
              className="w-full max-w-[140px]"
            />
          )}
          <div>
            <div className="text-2xl font-bold font-mono tracking-tight">
              {formatNativePrice(coinData.price, meta?.flags.pegCurrency ?? "USD", pegRef)}
            </div>
            <p className="text-sm text-muted-foreground font-mono">
              {formatPegDeviation(coinData.price, pegRef)}
            </p>
          </div>
        </div>
      )}
    </div>

    {/* Vertical divider (desktop only) */}
    <div className="hidden lg:block w-px bg-border/40" />

    {/* RIGHT: 2×2 Stats Grid */}
    <div className="lg:flex-1">
      <div className="grid grid-cols-2">
        {/* Top-left: Market Cap */}
        <div className="p-3 border-b border-r border-border/40">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Market Cap</p>
          <div className="text-xl font-bold font-mono tracking-tight leading-tight">{formatCurrency(mcap)}</div>
          <p className={`text-xs font-mono mt-1 ${mcap >= prevDay ? "text-green-500" : "text-red-500"}`}>
            {prevDay > 0 ? formatPercentChange(mcap, prevDay) : "N/A"} <span className="text-muted-foreground">24h</span>
          </p>
        </div>

        {/* Top-right: Supply */}
        <div className="p-3 border-b border-border/40">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Supply</p>
          <div className="text-xl font-bold font-mono tracking-tight leading-tight">{formatSupply(supply)}</div>
          <p className={`text-xs font-mono mt-1 ${mcap >= prevWeek ? "text-green-500" : "text-red-500"}`}>
            {prevWeek > 0 ? formatPercentChange(mcap, prevWeek) : "N/A"} <span className="text-muted-foreground">7d</span>
          </p>
        </div>

        {/* Bottom-left: Peg Score (hidden for NAV tokens) */}
        {!isNavToken ? (
          <div className="p-3 border-r border-border/40">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Peg Score</p>
            {pegScoreResult?.pegScore != null ? (
              <>
                <div className={`text-xl font-bold font-mono tracking-tight leading-tight ${pegScoreColor(pegScoreResult.pegScore)}`}>
                  {pegScoreResult.pegScore}<span className="text-base text-muted-foreground">/100</span>
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  {pegScoreResult.pegPct.toFixed(1)}% at peg
                </p>
                <p className="text-xs text-muted-foreground">
                  {pegScoreResult.eventCount} event{pegScoreResult.eventCount !== 1 ? "s" : ""}
                </p>
              </>
            ) : (
              <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
            )}
          </div>
        ) : (
          <div className="p-3 border-r border-border/40">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Type</p>
            <div className="text-sm font-medium text-muted-foreground">NAV Token</div>
          </div>
        )}

        {/* Bottom-right: Liquidity Score */}
        <div className="p-3">
          {(() => {
            const liq = liquidityMap?.[id];
            const hasLiq = liq != null && (liq.liquidityScore !== null || liq.poolCount > 0);
            const score = liq?.liquidityScore ?? 0;
            const textColor = hasLiq ? getScoreColor(score) : "";
            return hasLiq ? (
              <>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Liquidity</p>
                <div className={`text-xl font-bold font-mono tracking-tight leading-tight ${textColor}`}>
                  {Math.round(score)}<span className="text-base text-muted-foreground">/100</span>
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  {formatCurrency(liq!.totalTvlUsd)} TVL
                </p>
                <p className="text-xs text-muted-foreground">
                  {liq!.poolCount} pool{liq!.poolCount !== 1 ? "s" : ""} · {liq!.chainCount} chain{liq!.chainCount !== 1 ? "s" : ""}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Liquidity</p>
                <div className="text-xl font-bold font-mono tracking-tight text-muted-foreground">N/A</div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Footer line: chain count + 30d change + active depeg */}
      <div className="flex items-center justify-between px-3 pt-3 border-t border-border/40 text-xs text-muted-foreground">
        <span>{coinData?.chains?.length ?? 0} chain{(coinData?.chains?.length ?? 0) !== 1 ? "s" : ""}</span>
        <div className="flex items-center gap-3">
          {prevMonth > 0 && (
            <span className={`font-mono ${mcap >= prevMonth ? "text-green-500" : "text-red-500"}`}>
              {formatPercentChange(mcap, prevMonth)} <span className="text-muted-foreground">30d</span>
            </span>
          )}
          {pegScoreResult?.activeDepeg && (
            <span className="text-red-500 font-medium">Active depeg</span>
          )}
        </div>
      </div>
    </div>
  </div>
</div>
```

**Step 2: Add required imports to client.tsx**

Add at the top of `client.tsx`:

```tsx
import Image from "next/image";
import { GOVERNANCE_LABELS, BACKING_LABELS, PEG_LABELS_SHORT } from "@/lib/classification";
```

Remove the now-unused `Card`, `CardContent`, `CardHeader`, `CardTitle` imports (they're no longer used in the client for the hero — check if they're used elsewhere in the file for other sections before removing).

**Step 3: Verify the build compiles**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx
git commit -m "feat(detail): replace 3-card hero with 2-column unified layout"
```

---

### Task 3: Move DetailSectionNav inside the card

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`
- Modify: `src/components/detail-section-nav.tsx`

**Context:** Currently `DetailSectionNav` is rendered at the top of the client component (line 122), outside the Card. It needs to move inside the Card as a bottom bar, with the `sticky top-0` behavior adjusted to stick below the card's top edge.

**Step 1: Move the nav inside the card body**

In `client.tsx`, move `<DetailSectionNav sections={DETAIL_SECTIONS} />` to be the last element inside the Card's body (after the hero layout div), wrapped with a border-top:

```tsx
{/* Section nav as card bottom bar */}
<div className="border-t border-border/40">
  <DetailSectionNav sections={DETAIL_SECTIONS} />
</div>
```

The closing `</Card>` tag will come after this in page.tsx (since Card wraps the client component).

**Step 2: Update DetailSectionNav styling**

In `src/components/detail-section-nav.tsx`, update the nav's className to remove the background (it inherits from the card) and adjust the sticky positioning:

Change line 60-61 from:
```tsx
className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border overflow-x-auto scrollbar-none"
```
to:
```tsx
className="sticky top-0 z-20 bg-card/95 backdrop-blur overflow-x-auto scrollbar-none"
```

The `border-b` is removed since the nav is at the bottom of the card (the card's own border provides the bottom edge). Changed `bg-background` to `bg-card` so it blends with the card when sticky.

**Step 3: Verify the build compiles and check visually**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx src/components/detail-section-nav.tsx
git commit -m "feat(detail): move section nav inside hero card as bottom bar"
```

---

### Task 4: Handle the AiSummary placement

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`

**Context:** Currently `{summary && <AiSummary {...summary} />}` is inside the overview section (line 235), below the 3-card grid. It should move outside the hero card, back into the normal page flow between the hero card and the report-card section.

**Step 1: Move AiSummary outside the card**

In `client.tsx`, the return structure should now be:

```tsx
return (
  <>
    {supplyError && (
      <div className="...">Supply history is temporarily unavailable.</div>
    )}

    {/* Hero body rendered inside Card (Card wrapper comes from page.tsx) */}
    <div className="px-5 py-4">
      {/* ...2-column hero layout... */}
    </div>
    <div className="border-t border-border/40">
      <DetailSectionNav sections={DETAIL_SECTIONS} />
    </div>

    {/* Everything below is OUTSIDE the card — rendered after </Card> in page.tsx */}
    {/* We need to close the card in page.tsx and continue content after it */}
  </>
);
```

Wait — there's a structural issue. The Card wraps the client component in `page.tsx`. But AiSummary and the remaining sections need to be OUTSIDE the card. The simplest fix: have the client component return a Fragment where the hero content is the first child (rendered inside the Card) and sections after it are separate.

Actually, the cleanest approach: **split the client return into two parts**. The client renders everything. In `page.tsx`, the Card only wraps the top portion. Restructure `page.tsx` to:

```tsx
<Card className="rounded-xl">
  {/* breadcrumb top bar */}
  ...
</Card>
<StablecoinDetailClient id={id} summary={...} coin={coin} logoSrc={...} tags={tags} />
```

And in the client, the hero body + section nav are wrapped in their own Card:

```tsx
return (
  <div className="space-y-6">
    <Card className="rounded-xl">
      {/* Hero body: 2-column layout */}
      <div className="px-5 py-4">...</div>
      {/* Section nav bottom bar */}
      <div className="border-t border-border/40">
        <DetailSectionNav sections={DETAIL_SECTIONS} />
      </div>
    </Card>

    {/* Overview section content (outside card) */}
    <section id="overview">
      {summary && <AiSummary {...summary} />}
    </section>

    <section id="report-card">...</section>
    <section id="chart">...</section>
    ...
  </div>
);
```

This means the Card import stays in `client.tsx` and the breadcrumb top bar also moves into the client. Update `page.tsx` to simply:

```tsx
<StablecoinDetailClient id={id} summary={...} coin={coin} logoSrc={...} tags={tags} />
```

And the client handles the entire layout including the Card wrapper, breadcrumb, and all sections.

**Step 2: Move breadcrumb into client component**

Add the breadcrumb + compare link as the first element inside the Card in client.tsx. Import `ArrowLeftRight` from lucide-react and `Link` from next/link (already imported).

**Step 3: Verify the build compiles**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/page.tsx src/app/stablecoin/\[id\]/client.tsx
git commit -m "refactor(detail): consolidate hero card fully in client component"
```

---

### Task 5: Clean up and verify

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx` — remove unused imports (Badge, getFilterTags, FILTER_TAG_LABELS if no longer used)
- Modify: `src/app/stablecoin/[id]/client.tsx` — remove unused Card sub-component imports (CardHeader, CardTitle if unused)

**Step 1: Remove unused imports from page.tsx**

Check which imports are still needed. Remove:
- `getFilterTags`, `FILTER_TAG_LABELS` — tags are now rendered as text in client
- `Badge` — no longer used
- `GOVERNANCE_LABELS`, `BACKING_LABELS`, `PEG_LABELS`, `PEG_LABELS_SHORT` — moved to client
- `ArrowLeftRight` — moved to client

Keep: `Image` (still used for logo? Check — if logo rendering moved to client, remove too), `Link` (still used for not-found state and related stablecoins).

**Step 2: Remove unused imports from client.tsx**

Remove `CardHeader`, `CardTitle` if not used anywhere in the file.

**Step 3: Full build + visual check**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds, no type errors

Start dev server and visually check:
- Desktop: 2-column layout, identity left, stats right, section nav at bottom
- Verify all data renders: market cap, supply, price, peg score, liquidity
- Verify NAV tokens hide peg score
- Verify coins without liquidity data show N/A

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/page.tsx src/app/stablecoin/\[id\]/client.tsx
git commit -m "chore(detail): clean up unused imports after hero redesign"
```

---

### Task 6: Visual polish and mobile responsive check

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`

**Step 1: Verify mobile layout**

Use agent-browser to screenshot at 375px and 768px viewport widths. Confirm:
- At 375px: single column, identity stacks above stats, 2×2 grid still works
- At 768px: may start showing 2-column or still stacked — verify it looks good

**Step 2: Adjust spacing if needed**

Tweak padding, gaps, font sizes based on visual review. Common adjustments:
- `text-xl` → `text-lg` for stat values on mobile
- `gap-6` → `gap-4` for tighter mobile spacing
- Ensure PegGauge doesn't overflow on small screens

**Step 3: Final commit**

```bash
git add src/app/stablecoin/\[id\]/client.tsx
git commit -m "feat(detail): hero responsive polish"
```
