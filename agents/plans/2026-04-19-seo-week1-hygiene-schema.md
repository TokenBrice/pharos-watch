# SEO/LLM Indexability — Week 1: Hygiene & Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-04-19
**Goal:** Fix Pharos's P0 SEO/LLM-indexability bugs (soft-404s, skeleton-only detail pages, broken breadcrumbs, nonexistent SearchAction, incomplete Digest/Dataset schemas, orphan taxonomy hubs, duplicate title suffixes, stale AI-summary orphans, portfolio sitemap leak) plus a selected slice of P1 hygiene items (AI crawler rules, Dataset schema enrichment, Organization `@id`, noindex headers, title keywording).
**Architecture:** Purely surgical edits to existing routes, schema emitters, static config (`public/_redirects`, `public/_headers`, `src/app/robots.ts`, `src/app/sitemap.ts`), and one shared component (`BreadcrumbJsonLd` signature change). One new Server Component for static hero strip on detail pages. Four new taxonomy index pages. No new helpers, no runtime changes, no worker changes.
**Tech Stack:** Next.js 16 static export, shadcn-based UI primitives, existing `safeJsonLd` / `buildStablecoinUrl` / `SITE_ORIGIN` helpers, Cloudflare Pages static headers/redirects.

---

## Summary

This is plan #1 of a 3-plan sequential SEO/LLM-indexability effort. Week 1 fixes the indexing hygiene that is actively misleading crawlers (200-status 404 pages, skeleton-only detail HTML, flat 2-item breadcrumbs, broken SearchAction, a missing `publisher.@id` anchor, taxonomy hubs that don't exist, etc.) plus the quickest-win P1 items that stand alone (AI crawler matrix, Dataset JSON-LD enrichment referencing a new `#organization` anchor, noindex `X-Robots-Tag` headers, detail-title keyword differentiation).

## Prerequisites / Dependencies

None — this is plan #1 of 3. Later plans (week 2: internal linking + content depth; week 3: perf + image SEO) will depend on Week 1's Organization `@id` anchor (Task 12) and the enriched Dataset schema (Task 11) being live.

## Out of Scope (deferred to Week 2/3)

- Internal link graph enhancements (related-coin blocks, cohort interlinks beyond what taxonomy hubs naturally produce).
- Sitemap `image:` extensions; per-image alt-text/schema review.
- FAQ/HowTo JSON-LD expansion beyond the Dataset/Organization/WebSite anchors touched here.
- LLMS.txt or AI-specific manifest files.
- Web Vitals / CLS / LCP optimization.
- Rewriting long-tail page copy for keyword density.
- Adding a real `?q=` search handler (Task 4 removes the broken SearchAction; implementing a handler is deferred).
- **Full snapshot integration for the detail-page static hero.** See Task 2 for the week-1/week-2 split decision.
- Any non-trivial refactors to `FeaturePageShell` or `HeroCard`.

## Commit Strategy

**Recommendation: one PR with logically grouped commits (≈8 commits).** Each commit should pass `npm run lint` + `npm run build` independently so the PR stays bisectable. Bundling as one PR avoids noisy deploy churn (every merge redeploys Pages) and gives reviewers a single context to judge the schema changes together.

Proposed commit grouping (exact mapping to tasks):
1. **Redirects & noindex headers** — Tasks 1, 13 (`_redirects`, `_headers`).
2. **Breadcrumb schema fix** — Task 3 (component signature + every call site + test update).
3. **Root schema + SearchAction removal** — Tasks 4, 12 (`layout.tsx` WebSite/Organization/WebApp `@id`, sameAs expansion, drop SearchAction).
4. **Detail page static hero + Dataset enrichment** — Tasks 2, 11 (`stablecoin/[id]/page.tsx`, new server component, Dataset JSON-LD).
5. **Digest Article schema** — Task 5.
6. **Taxonomy hub pages + sitemap additions** — Task 6.
7. **Title hygiene + metadata polish** — Tasks 7, 14 (strip `| Pharos`, home/yield/chains/telegram/detail-template rewrites).
8. **Data cleanup: robots.ts matrix, ai-summaries orphans, sitemap portfolio removal** — Tasks 9, 10, 8.

## Task Breakdown

---

### Task 1: Soft-404 fix — append 404 catch-all to `_redirects`

**Goal:** Make Cloudflare Pages serve `404.html` with HTTP status 404 (not 200) for unmatched routes so crawlers deindex orphan URLs.

**Files:**
- Modify: `public/_redirects` (append single line at end, after the existing stablecoin ID migration block ending at line 356).

**Implementation notes:**
- Append `/* /404.html 404` as the last line of the file.
- This line MUST remain last — Cloudflare processes redirects top-down; any rule after the catch-all would be dead. All 301 ID-migration redirects above it already preserve live routes.
- Do not alter spacing, existing 301 rules, or comments.

**Verification:**
- After `npm run build`, inspect `out/_redirects` and confirm the last non-empty line is `/* /404.html 404`.
- Local cannot fully verify (Cloudflare Pages serves the rule, not Next's dev server). Post-deploy spot check: `curl -I https://pharos.watch/this-route-does-not-exist-xyz` should return `HTTP/2 404`.

**Risk flags:**
- If a real Next route name ever collides with `/404` path segments, Cloudflare's catch-all still fires last, so no risk.
- **Pre-existing 301s above the catch-all must stay above it** — moving any of them below would break them.

**Effort:** S (≤15 min).

- [ ] **Step 1.1: Append catch-all to `public/_redirects`**

Append exactly this line (preceded by one blank line for readability) after the final existing redirect at line 356:

```
/* /404.html 404
```

- [ ] **Step 1.2: Build and inspect `out/_redirects`**

Run: `npm run build`

Expected: build succeeds. Then check the built artifact with Read on `/home/ahirice/Documents/git/stablecoin-dashboard/out/_redirects` — confirm last line is `/* /404.html 404`.

- [ ] **Step 1.3: Commit**

Commit message: `fix(pages): serve 404 status for unmatched routes`

---

### Task 2: Detail page — promote static hero strip outside Suspense

**Goal:** Ensure `/stablecoin/{id}/` pages ship identity + classification (name, symbol, governance/backing/peg labels, description) in the initial HTML that crawlers and LLMs receive. Current behavior: entire body is inside `<Suspense>` with all-skeleton fallback — no substantive content pre-hydration.

**Scope decision — week 1 = minimal static hero, week 2 = snapshot integration.**

Rationale: the spec asks to display "last-known snapshot mcap/price/score if available from build-time data." Inspection shows no build-time snapshot file exists — every live data field (mcap, price, pegScore, dewsScore, reportCard, liquidity) flows through the TanStack Query layer in `client.tsx` via `useStablecoinDetailViewModel`. Adding a build-time snapshot would require a new prebuild script to call the public API for each of 191 coins, persist JSON, and rebuild on data changes — a multi-day task with its own infra design decisions (staleness policy, cache-busting, rebuild cadence). That is well beyond the P0 "make initial HTML substantive" goal and orthogonal to the other week-1 items.

**Week 1 shipping scope:** a static Server Component that renders identity + classification + description outside Suspense. This alone flips the page from "empty skeleton" to "crawlable coin identity" for all 191 detail pages. Live metrics continue to stream in via Suspense + client hooks. The visible-to-user rendering order is preserved (hero first, then live data).

**Week 2 deferred scope:** optional build-time snapshot ingestion so the static hero also ships last-known price/mcap/score.

**Files:**
- Create: `src/components/stablecoin-detail/static-hero-strip.tsx` (new Server Component).
- Modify: `src/app/stablecoin/[id]/page.tsx` — lines 81-167.
- Leave untouched: `src/app/stablecoin/[id]/client.tsx` (already renders `HeroCard` with live data inside Suspense — this stays). `loading-shell.tsx` (unchanged).

**Implementation notes:**

The new `StaticHeroStrip` is a Server Component (no `"use client"`), importing only:
- `StablecoinLogo` (existing — already usable server-side; verify by Read).
- `buildStablecoinDetailDescription` from `@/lib/page-metadata` (already used for `<meta name="description">` — reuse verbatim for h1 subtitle).
- Classification label maps from `@shared/lib/classification`.
- `Link` from `next/link`.

It renders:
- The `StablecoinLogo` + name + symbol (replaces the current `<h1 className="sr-only">`).
- The three classification pills (governance / backing / peg) linking to taxonomy hubs via `buildGovernanceTaxonomyUrl`, `buildBackingTaxonomyUrl`, `buildPegLandingUrl`. This matches the `HeroClassificationLine` markup in `hero-card.tsx:223-251` but without `"use client"`.
- A 1-sentence description paragraph — the same copy generated by `buildStablecoinDetailDescription(coin)` that currently only lives in `<meta>`.

In `page.tsx` (the existing active-coin branch starting at line 111):
1. Remove the `sr-only` h1 at lines 116-118 (replaced by the static hero `h1`).
2. Render `<StaticHeroStrip coin={coin} logoSrc={logosById[coin.id]} />` **outside** the `Suspense` boundary, before it.
3. Keep the existing `<Suspense>` → `StablecoinDetailClient` block; the client still renders `HeroCard` for the live-data version, so the user sees two visual hero tiers for ~1 frame during hydration. That's acceptable and matches how feature pages already work (FeaturePageShell renders static title before client charts load). If the visual stacking bothers us, week 2 can deduplicate by having the client hero skip identity repetition — NOT week 1 scope.
4. `BreadcrumbJsonLd` call (line 135) moves to use the new N-level signature (covered in Task 3).
5. Dataset `<script>` (lines 136-164) is restructured in Task 11 — leave it alone here.

**Verification:**
- Run `npm run build`, then `rg -A 20 "class=\"sr-only\"" out/stablecoin/usdc-circle/index.html | head` — the rendered HTML should contain the coin name ("USDC"), symbol ("USDC"), classification pills, and description sentence before any `<Suspense>` / skeleton markup.
- Run `rg "Circle" out/stablecoin/usdc-circle/index.html` to confirm "Circle" appears in non-meta HTML.
- Manual: Playwright navigation to `file://.../out/stablecoin/usdc-circle/index.html` and `browser_snapshot` — should show the hero rendered.

**Risk flags:**
- If `StablecoinLogo` imports any client-only hook, it'll fail as a Server Component. Verify by reading `src/components/stablecoin-logo.tsx` first — if it needs `"use client"`, keep it inside Suspense and instead use a plain `<img>` / `<Image>` server-side.
- Double-rendering the logo + name in the static hero and then again inside `HeroCard` during hydration is intentional; document in a short component comment so future refactors don't "fix" it.

**Effort:** M (2-3h including verification + decision trace).

- [ ] **Step 2.1: Confirm `StablecoinLogo` is server-compatible**

Read `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-logo.tsx`. Expected: no `"use client"` directive; uses only plain React + `Image` or `<img>`. If it has `"use client"`, fall back to emitting a plain `<img src={logoSrc} alt={`${coin.name} logo`} width={56} height={56} />` in the new component instead.

- [ ] **Step 2.2: Create `src/components/stablecoin-detail/static-hero-strip.tsx`**

```tsx
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinDetailDescription } from "@/lib/page-metadata";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import type { StablecoinMeta } from "@shared/types";

/**
 * Server-rendered identity strip shown BEFORE the Suspense boundary on
 * /stablecoin/[id] pages so crawlers and LLMs get substantive content in the
 * initial HTML. Live metrics (price, mcap, peg score, etc.) still stream in via
 * client hooks inside <Suspense>. This strip intentionally duplicates some
 * fields that HeroCard re-renders post-hydration — do not "dedupe" without
 * first moving the live-data renderer out of Suspense.
 */
export function StaticHeroStrip({
  coin,
  logoSrc,
}: {
  coin: StablecoinMeta;
  logoSrc?: string;
}) {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const governanceHref = buildGovernanceTaxonomyUrl(coin.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(coin.flags.backing);
  const description = buildStablecoinDetailDescription(coin);

  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";

  return (
    <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <StablecoinLogo src={logoSrc} name={coin.name} size={56} />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold tracking-tighter text-foreground">
              {coin.name} ({coin.symbol})
            </h1>
          </div>
          <p className="flex flex-wrap items-center gap-1.5">
            <Link href={governanceHref} className={pillClass} aria-label={`Browse ${governanceLabel} stablecoins`}>
              {governanceLabel}
            </Link>
            <Link href={backingHref} className={pillClass} aria-label={`Browse ${backingLabel} stablecoins`}>
              {backingLabel}
            </Link>
            {pegHref ? (
              <Link href={pegHref} className={pillClass} aria-label={`Browse ${pegLabel} stablecoins`}>
                {pegLabel}
              </Link>
            ) : (
              <span className={pillClass}>{pegLabel}</span>
            )}
          </p>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2.3: Wire `StaticHeroStrip` into `page.tsx`**

In `src/app/stablecoin/[id]/page.tsx`:

1. Add import at top: `import { StaticHeroStrip } from "@/components/stablecoin-detail/static-hero-strip";`
2. Delete lines 116-118 (the `<h1 className="sr-only">`).
3. Insert `<StaticHeroStrip coin={coin} logoSrc={logosById[coin.id]} />` as the first element inside the returned `<>...</>` fragment, before `<Suspense>`.

Resulting structure (high-level, not full file):

```tsx
return (
  <>
    <StaticHeroStrip coin={coin} logoSrc={logosById[coin.id]} />
    <Suspense fallback={<DetailPageShellFallback coin={coin} logoSrc={logosById[coin.id]} />}>
      <StablecoinDetailClient id={id} summary={typedSummaries[id] ?? null} coin={coin} logoSrc={logosById[coin.id]} />
    </Suspense>
    <ExploreNextSection ... />
    <BreadcrumbJsonLd ... />  {/* Task 3 will change signature */}
    <script type="application/ld+json" ... />  {/* Task 11 will restructure */}
  </>
);
```

- [ ] **Step 2.4: Verify build + HTML**

Run: `npm run build`
Expected: build succeeds. Then:
- Read `out/stablecoin/usdc-circle/index.html`.
- Grep for `"Circle"` and classification labels — must appear in HTML outside the `Suspense` skeleton block.

- [ ] **Step 2.5: Commit (part of the Task 2+11 detail-page commit, see commit strategy)**

Defer commit; bundle with Task 11's Dataset changes.

---

### Task 3: BreadcrumbJsonLd — change signature to N-level `items[]`

**Goal:** Every nested route emits a correct `BreadcrumbList` (Home → parent → current), not a flat Home → current.

**Files:**
- Modify: `src/components/breadcrumb-json-ld.tsx` (change signature).
- Modify every call site. Grep-verified call sites:
  - `src/app/stablecoin/[id]/page.tsx:135`
  - `src/app/digest/[date]/page.tsx:91`
  - `src/app/cemetery/page.tsx:46`
  - `src/app/methodology/page.tsx:42`
  - `src/app/blacklist/layout.tsx:31`
  - `src/app/flows/layout.tsx:33`
  - `src/components/feature-page-shell.tsx:52` (feeds every `FeaturePageShell` consumer including chains/[chain], compare/[slug], stablecoins/[peg], stablecoins/backing/[backing], stablecoins/governance/[governance], stablecoins/infrastructure/[infrastructure], etc.)
  - `src/components/methodology-changelog-page.tsx:48` (feeds every `*-changelog` route via `changelog-route-factory.tsx`)

**Implementation notes:**

New signature accepts `items: Array<{ name: string; url: string }>` where the array is ALL breadcrumb nodes in order (including Home and current). The component prepends an implicit `Home` entry is a bad idea — too easy to miss; require callers to pass the full chain.

To minimize churn at the many call sites that currently pass `(name, path)` for a 2-level (Home → X) crumb, provide a small helper at the call site: most 2-level callers can pass `items={[{name: "Home", url: "/"}, {name, url: path}]}`. Given the high number of call sites, consider an overload or second helper export `buildBreadcrumb(items)` — but keep it simple: a single prop, fully explicit.

After changing the component, every caller must be updated. `FeaturePageShell` (line 52) receives `breadcrumbName`/`path` from its consumers — keep FeaturePageShell's public prop names but construct the 3-level items internally (Home → Dashboard `/` → current {name} {path}). Wait, looking again: FeaturePageShell's visible UI breadcrumb says "Dashboard / {name}" — a 2-level hierarchy. That's fine for pages like `/chains/` (truly top-level) but lies for `/chains/{chain}/` which routes through `FeaturePageShell` too (line 42 of `chains/[chain]/page.tsx`).

**Decision for FeaturePageShell consumers:** keep the shell's prop API (`breadcrumbName`, `path`) unchanged, but allow an optional new prop `breadcrumbItems?: Array<{name,url}>` that, when supplied, overrides the auto-constructed 2-level crumb. Consumers that need 3+ level hierarchy pass `breadcrumbItems` explicitly. Default behavior for the majority (top-level feature pages) stays `[{Home,/},{breadcrumbName,path}]`.

Pages needing explicit N-level items:
- `chains/[chain]/page.tsx` → `[{Home,/},{Chains,/chains/},{meta.name,/chains/{chain}/}]`
- `compare/[slug]/page.tsx` → `[{Home,/},{Compare,/compare/},{page.shortTitle,page.href}]`
- `stablecoins/[peg]/page.tsx` (via `StablecoinTaxonomyShell` → `FeaturePageShell`) → `[{Home,/},{Stablecoins,/stablecoins/},{page.title,page.href}]`
- `stablecoins/backing/[backing]` / `governance/[governance]` / `infrastructure/[infrastructure]` → `[{Home,/},{Stablecoins,/stablecoins/},{Backing — or Governance — or Infrastructure,/stablecoins/backing/},{page.title,page.href}]`. NOTE: the 3rd-level Backing/Governance/Infrastructure hub pages are created in Task 6; THIS TASK must be merged AFTER Task 6 or the breadcrumbs will point to then-nonexistent pages. **Either defer the 4-level breadcrumbs to after Task 6 in the same PR (recommended), or temporarily emit 3-level crumbs skipping the hub layer until Task 6 ships.** Plan recommendation: keep Tasks 3 and 6 in the same PR (already the default per the commit strategy), and treat breadcrumb depth as a 4-level target from day one.
- `stablecoin/[id]/page.tsx` → `[{Home,/},{Stablecoins,/stablecoins/},{coin.name (coin.symbol),buildStablecoinUrl(id)}]`
- `digest/[date]/page.tsx` → `[{Home,/},{Digest,/digest/},{Weekly Recap/Daily Digest: {formatted},/digest/{date}/}]`
- `methodology/page.tsx` → `[{Home,/},{Methodology,/methodology/}]` (unchanged effective depth but explicit).
- `methodology-changelog-page.tsx` (used by all changelog routes) → `[{Home,/},{Methodology,/methodology/},{title (e.g. "Depeg Changelog"),path}]`.
- `cemetery/page.tsx` → `[{Home,/},{Cemetery,/cemetery/}]` (2-level — top-level).
- `blacklist/layout.tsx`, `flows/layout.tsx` → `[{Home,/},{Blacklist Tracker,/blacklist/}]` / `[{Home,/},{Mint/Burn Flows,/flows/}]` (2-level — top-level).

Also update existing test `src/app/methodology/page.test.tsx` if it asserts breadcrumb JSON-LD output (Read that file during the task to confirm).

**Verification:**
- `npm run build` succeeds.
- Read `out/stablecoin/usdc-circle/index.html` and confirm the `BreadcrumbList` JSON-LD has 3 items with positions 1/2/3 and correct URLs.
- Read `out/chains/ethereum/index.html` and confirm 3-item breadcrumb.
- Read `out/stablecoins/backing/rwa/index.html` (created by Task 6) and confirm 4-item breadcrumb.
- Google Rich Results Test (post-deploy): https://search.google.com/test/rich-results with any detail page URL — should show "Breadcrumbs" eligible.

**Risk flags:**
- This is a wide-reaching change (8+ call sites). Any caller missed → build error (TypeScript). Use `rg "BreadcrumbJsonLd" src/` to locate every reference before editing.
- The 4-level breadcrumbs for backing/governance/infrastructure hubs depend on Task 6 pages existing. Sequence matters **within** the PR but not across PRs since it's one PR.
- Existing test files may break if they assert the old 2-item shape. Search for test files: `rg "BreadcrumbList" src/ --type ts`.

**Effort:** M (2h — mostly mechanical edits across many files).

- [ ] **Step 3.1: Rewrite `src/components/breadcrumb-json-ld.tsx`**

```tsx
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export interface BreadcrumbItem {
  name: string;
  /** Site-relative path starting with "/", e.g. "/chains/". */
  url: string;
}

export function BreadcrumbJsonLd({ items }: { items: BreadcrumbItem[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: items.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: item.name,
            item: `${SITE_URL}${item.url}`,
          })),
        }),
      }}
    />
  );
}
```

- [ ] **Step 3.2: Update `FeaturePageShell` to accept optional `breadcrumbItems` override**

In `src/components/feature-page-shell.tsx`:

```tsx
export interface FeaturePageShellProps {
  breadcrumbName: string;
  path: string;
  /** Optional explicit breadcrumb chain (including Home). When omitted, a 2-level Home → breadcrumbName chain is emitted. */
  breadcrumbItems?: import("@/components/breadcrumb-json-ld").BreadcrumbItem[];
  // ...existing props
}
```

Replace line 52 `<BreadcrumbJsonLd name={breadcrumbName} path={path} />` with:

```tsx
<BreadcrumbJsonLd
  items={
    breadcrumbItems ?? [
      { name: "Home", url: "/" },
      { name: breadcrumbName, url: path },
    ]
  }
/>
```

- [ ] **Step 3.3: Update `methodology-changelog-page.tsx` (line 48)**

Before writing changes, Read the full file to understand its surrounding markup. Replace the call:

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Methodology", url: "/methodology/" },
    { name: breadcrumbName, url: path },
  ]}
/>
```

- [ ] **Step 3.4: Update `src/app/stablecoin/[id]/page.tsx` (line 135)**

Replace line 135 with:

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Stablecoins", url: "/stablecoins/" },
    { name: `${coin.name} (${coin.symbol})`, url: buildStablecoinUrl(id) },
  ]}
/>
```

- [ ] **Step 3.5: Update `src/app/digest/[date]/page.tsx` (line 91)**

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Digest", url: "/digest/" },
    { name: `${isWeekly ? "Weekly Recap" : "Daily Digest"}: ${formatted}`, url: `/digest/${digest.date}/` },
  ]}
/>
```

- [ ] **Step 3.6: Update `src/app/cemetery/page.tsx` (line 46)**

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Stablecoin Cemetery", url: "/cemetery/" },
  ]}
/>
```

- [ ] **Step 3.7: Update `src/app/methodology/page.tsx` (line 42)**

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Methodology", url: "/methodology/" },
  ]}
/>
```

- [ ] **Step 3.8: Update `src/app/blacklist/layout.tsx` (line 31) and `src/app/flows/layout.tsx` (line 33)**

Blacklist:

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Blacklist Tracker", url: "/blacklist/" },
  ]}
/>
```

Flows:

```tsx
<BreadcrumbJsonLd
  items={[
    { name: "Home", url: "/" },
    { name: "Mint/Burn Flows", url: "/flows/" },
  ]}
/>
```

- [ ] **Step 3.9: Pass explicit `breadcrumbItems` to `FeaturePageShell` from nested routes**

For each nested route using `FeaturePageShell`, add `breadcrumbItems` to the props:

`src/app/chains/[chain]/page.tsx` — inside the `<FeaturePageShell>`:

```tsx
breadcrumbItems={[
  { name: "Home", url: "/" },
  { name: "Chains", url: "/chains/" },
  { name: meta.name, url: `/chains/${chain}/` },
]}
```

`src/app/compare/[slug]/page.tsx`:

```tsx
breadcrumbItems={[
  { name: "Home", url: "/" },
  { name: "Compare", url: "/compare/" },
  { name: page.shortTitle, url: page.href },
]}
```

- [ ] **Step 3.10: Thread `breadcrumbItems` through `StablecoinTaxonomyShell` and `StablecoinTaxonomyPage`**

`StablecoinTaxonomyShell` currently wraps `FeaturePageShell`. Add an optional `breadcrumbItems` prop that forwards through. Update `StablecoinTaxonomyPage` (the consumer used by backing/governance/infrastructure routes) and the `stablecoins/[peg]/page.tsx` wrapper (which uses `StablecoinTaxonomyShell` directly) to pass:

For peg (`/stablecoins/{peg}/`):
```tsx
breadcrumbItems={[
  { name: "Home", url: "/" },
  { name: "Stablecoins", url: "/stablecoins/" },
  { name: page.title, url: page.href },
]}
```

For backing/governance/infrastructure (`/stablecoins/backing/{slug}/` etc.), since Task 6 adds the hub parent pages:
```tsx
breadcrumbItems={[
  { name: "Home", url: "/" },
  { name: "Stablecoins", url: "/stablecoins/" },
  { name: page.kind === "backing" ? "Backing" : page.kind === "governance" ? "Governance" : "Infrastructure",
    url: `/stablecoins/${page.kind}/` },
  { name: page.title, url: page.href },
]}
```

(`page.kind` is available on `StablecoinTaxonomyPage<T>` — see `src/lib/stablecoin-taxonomy.ts:10`.)

- [ ] **Step 3.11: Search for any remaining `BreadcrumbJsonLd` call site and update**

Run: `rg "BreadcrumbJsonLd" src/ --type tsx --type ts`
Expected: every remaining match is either the component definition itself or already-updated callers. Fix any that still pass `name=`/`path=` props.

- [ ] **Step 3.12: Update breadcrumb-related tests**

Run: `rg "BreadcrumbList" src/ --type ts --type tsx`
Read any test files surfaced and update assertions to the new N-item shape.

- [ ] **Step 3.13: Verify build + lint**

Run: `npm run lint` then `npm run build`
Expected: both succeed.

---

### Task 4: Remove broken SearchAction from root WebSite JSON-LD

**Goal:** Stop emitting a `SearchAction` that points to a nonexistent `/?q=` handler (lies to crawlers and LLMs).

**Files:**
- Modify: `src/app/layout.tsx:137-141`.

**Implementation notes:**

Delete the `potentialAction` key from the `WebSite` schema object. Task 12 will add an `@id` in the same object — do both edits in the same commit per the commit strategy (see commit #3).

**Verification:**
- Build the app; Read `out/index.html` and grep for `"potentialAction"` → zero matches expected.

**Risk flags:** None. Removing a lie.

**Effort:** S (5 min).

- [ ] **Step 4.1: Remove `potentialAction` from `layout.tsx`**

Delete lines 137-141 (the `potentialAction: { ... }` block and its trailing comma) from the WebSite object.

- [ ] **Step 4.2: Verify**

Run: `npm run build` → confirm `out/index.html` no longer contains `potentialAction` or `search_term_string`.

---

### Task 5: Digest Article — add `image` + `dateModified`

**Goal:** Bring the Article JSON-LD into Google's required-field compliance.

**Files:**
- Modify: `src/app/digest/[date]/page.tsx:92-115`.

**Implementation notes:**

Current Article schema lacks `image` and `dateModified`. Per spec, add:

```tsx
image: [`${SITE_URL}/og-card.png`],
dateModified: new Date(digest.generatedAt * 1000).toISOString(),
```

Note: the spec mentions an "`/api/og/digest/${date}` endpoint if exists." Grep shows no such route in `worker/src/api/og.tsx` (only `/api/og/stablecoin/:id`). Use the default `/og-card.png` for now. Defer per-digest OG generation to a later plan (out of scope).

**Verification:**
- Build; Read `out/digest/{latest-date}/index.html`, confirm `"image"` and `"dateModified"` fields present in the Article JSON-LD block.
- Google Rich Results Test: paste a digest URL post-deploy, Article type should be valid.

**Risk flags:** None.

**Effort:** S (10 min).

- [ ] **Step 5.1: Edit digest Article schema**

In `src/app/digest/[date]/page.tsx`, inside the `safeJsonLd({...})` call at lines 95-114, add two fields (suggest placing `image` after `headline` and `dateModified` immediately after `datePublished`):

```tsx
"@context": "https://schema.org",
"@type": "Article",
headline: `${digest.title} (${formatted})`,
image: [`${SITE_URL}/og-card.png`],
datePublished: new Date(digest.generatedAt * 1000).toISOString(),
dateModified: new Date(digest.generatedAt * 1000).toISOString(),
description: summarizeText(digest.text, 160),
// ...existing author/publisher/mainEntityOfPage
```

- [ ] **Step 5.2: Verify**

`npm run build`. Read any `out/digest/*/index.html` file. Confirm both new fields present.

---

### Task 6: Add missing taxonomy hub pages (parents of `backing` / `governance` / `infrastructure`)

**Goal:** Stop orphaning the taxonomy children. Currently `/stablecoins/backing/{slug}/` pages exist, but `/stablecoins/backing/` and its siblings 404. Same for `/stablecoins/`. Add 4 new pages + sitemap entries.

**Files:**
- Create: `src/app/stablecoins/page.tsx`
- Create: `src/app/stablecoins/backing/page.tsx`
- Create: `src/app/stablecoins/governance/page.tsx`
- Create: `src/app/stablecoins/infrastructure/page.tsx`
- Modify: `src/app/sitemap.ts` — add the 4 new URLs to `staticPages`.

**Implementation notes:**

Each new page is a Server Component using `FeaturePageShell` directly (not the heavier `StablecoinTaxonomyShell`, which is coin-list-oriented). Each links to its children cohorts. Use existing taxonomy arrays from `src/lib/stablecoin-taxonomy.ts`:
- `GOVERNANCE_TAXONOMY_PAGES`, `BACKING_TAXONOMY_PAGES`, `INFRASTRUCTURE_TAXONOMY_PAGES`, `ALL_STABLECOIN_TAXONOMY_PAGES`.
- Peg children via `PEG_TAXONOMY_PAGES` from `src/lib/peg-taxonomy.ts`.

`/stablecoins/` is the super-parent linking to all four axes (peg, backing, governance, infrastructure). `/stablecoins/backing/`, `/stablecoins/governance/`, `/stablecoins/infrastructure/` each link to their specific child hubs.

Each page emits:
- A `FeaturePageShell` with title, intro, and a 2-level (for `/stablecoins/`) or 3-level (for the axis-parents) `breadcrumbItems`.
- An explicit card/grid of child cohort links with name + tracked-coin count.
- An `ItemList` JSON-LD pointing at the child cohort pages (mirror the pattern in `StablecoinTaxonomyShell`).

**Verification:**
- `npm run build` — all 4 pages generate without error.
- `out/stablecoins/index.html`, `out/stablecoins/backing/index.html`, etc. — each exists.
- Visit built HTML, confirm child cohort links render.
- Check `out/sitemap.xml` contains all 4 new URLs.

**Risk flags:**
- Infrastructure hub only makes sense if `INFRASTRUCTURE_TAXONOMY_PAGES` is non-empty. It is — confirmed in `src/lib/stablecoin-taxonomy.ts:167-185`.
- `/stablecoins/` (super-parent) should not have a redirect entry in `_redirects` — confirmed by inspection (no `/stablecoins/` line in `public/_redirects`).

**Effort:** M (1.5h — four files, same pattern each).

- [ ] **Step 6.1: Create `src/app/stablecoins/page.tsx`**

Uses `FeaturePageShell` with a 4-card grid for Peg / Backing / Governance / Infrastructure axes:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  GOVERNANCE_TAXONOMY_PAGES,
  BACKING_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";

const TOTAL = ACTIVE_STABLECOINS.length;

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Peg, Backing, Governance & Infrastructure",
  description: `Browse ${TOTAL} tracked stablecoins sorted by peg currency, collateral backing, governance model, and shared infrastructure.`,
  canonical: "/stablecoins/",
});

const AXES = [
  { href: "/stablecoins/", label: "By Peg Currency", children: PEG_TAXONOMY_PAGES },
  { href: "/stablecoins/backing/", label: "By Backing Type", children: BACKING_TAXONOMY_PAGES },
  { href: "/stablecoins/governance/", label: "By Governance Model", children: GOVERNANCE_TAXONOMY_PAGES },
  { href: "/stablecoins/infrastructure/", label: "By Shared Infrastructure", children: INFRASTRUCTURE_TAXONOMY_PAGES },
] as const;

export default function StablecoinsHubPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Stablecoins"
      path="/stablecoins/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
      ]}
      title="Stablecoin Taxonomies"
      leadParagraphs={[
        `Four ways to browse the ${TOTAL} stablecoins Pharos tracks — by peg currency, backing type, governance model, or shared infrastructure.`,
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd({
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              name: "Stablecoin Taxonomies",
              url: `${SITE_URL}/stablecoins/`,
              isPartOf: { "@id": `${SITE_URL}#website` },
            }),
          }}
        />
      }
    >
      <section className="grid gap-4 sm:grid-cols-2">
        {AXES.map((axis) => (
          <div key={axis.href} className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
            <h2 className="text-base font-semibold tracking-tight">{axis.label}</h2>
            <div className="flex flex-col gap-2">
              {axis.children.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="block font-medium text-foreground">{page.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{page.coins.length} tracked</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>
    </FeaturePageShell>
  );
}
```

- [ ] **Step 6.2: Create `src/app/stablecoins/backing/page.tsx`**

Same pattern, but only BACKING_TAXONOMY_PAGES. Title: "Stablecoins by Backing Type". Breadcrumb items: Home / Stablecoins / Backing.

- [ ] **Step 6.3: Create `src/app/stablecoins/governance/page.tsx`**

Same pattern with GOVERNANCE_TAXONOMY_PAGES. Title: "Stablecoins by Governance Model". Breadcrumb items: Home / Stablecoins / Governance.

- [ ] **Step 6.4: Create `src/app/stablecoins/infrastructure/page.tsx`**

Same pattern with INFRASTRUCTURE_TAXONOMY_PAGES. Title: "Stablecoins by Shared Infrastructure". Breadcrumb items: Home / Stablecoins / Infrastructure.

- [ ] **Step 6.5: Add 4 new URLs to `src/app/sitemap.ts` `staticPages` array**

Insert after the existing `/about/api/` entry (line 209) or any location inside the `staticPages` array:

```tsx
{
  url: `${SITE_URL}/stablecoins/`,
  lastModified: lastEdited("/stablecoins/"),
  changeFrequency: "weekly",
  priority: 0.7,
},
{
  url: `${SITE_URL}/stablecoins/backing/`,
  lastModified: lastEdited("/stablecoins/backing/"),
  changeFrequency: "weekly",
  priority: 0.6,
},
{
  url: `${SITE_URL}/stablecoins/governance/`,
  lastModified: lastEdited("/stablecoins/governance/"),
  changeFrequency: "weekly",
  priority: 0.6,
},
{
  url: `${SITE_URL}/stablecoins/infrastructure/`,
  lastModified: lastEdited("/stablecoins/infrastructure/"),
  changeFrequency: "weekly",
  priority: 0.6,
},
```

Note: `lastEdited()` falls back to `new Date()` when the path is not in `sitemap-dates.json`. That's fine for new pages until the prebuild script regenerates dates on next build.

- [ ] **Step 6.6: Verify**

`npm run build` — all 4 routes generate. Manually open each `out/stablecoins/*/index.html`. `rg "stablecoins/backing/" out/sitemap.xml` should return a match.

---

### Task 7: Strip duplicate `| Pharos` suffix

**Goal:** Stop double-suffixing titles like "System Status | Pharos | Pharos".

**Files and exact changes:**
- `src/app/status/page.tsx:5, 9` — `"System Status | Pharos"` → `"System Status"`.
- `src/app/admin/page.tsx:5` — `"Operator Admin | Pharos"` → `"Operator Admin"`.
- `src/app/funding/page.tsx:17` — `"Funding — Pharos"` → `"Funding"` (strip em-dash suffix; template will append `| Pharos`).
- `src/app/digest/[date]/page.tsx:48` — `"Digest Not Found | Pharos"` → `"Digest Not Found"`. Line 59: `` `${digest.title} (${formatted}) | Pharos` `` → `` `${digest.title} (${formatted})` `` (this is an `openGraph.title` override; no template applied to OG, so here we want to KEEP "| Pharos" for OG but match the metadata.title which is already without suffix. Actually: `metadata.title` at line 55 is `` `${digest.title} (${formatted})` `` — no suffix — good. And `openGraph.title` at line 59 has `| Pharos` — but OpenGraph title is distinct from metadata.title and does not get the root template applied, so it's not doubled in OG. Leave the OG title unchanged; only fix cases where the root `%s | Pharos` template doubles the hardcoded suffix in `<title>`).
- `src/app/compare/[slug]/page.tsx:24` — the fallback string `"Comparison Not Found | Pharos"` passed to `buildSlugPageMetadata`. Grep to see how it's used: `src/lib/static-slug-page.ts` — if that helper sets it as `title`, strip the suffix. **This step requires reading `src/lib/static-slug-page.ts` before editing.**
- `src/app/stablecoins/[peg]/page.tsx:17`, `src/app/stablecoins/governance/[governance]/page.tsx:22`, `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx:18`, `src/app/stablecoins/backing/[backing]/page.tsx:18`, `src/app/chains/[chain]/page.tsx:21` — same pattern; fix according to `static-slug-page.ts` behavior.
- `src/app/about/page.tsx:239` — `"About Pharos: Shining a Light on Every Peg"` — this is intentional branded copy, NOT a double suffix (the word "Pharos" appears inside the title but not as `| Pharos`). Combined with the root template, final rendered `<title>` becomes "About Pharos: Shining a Light on Every Peg | Pharos" — awkward but not broken. **Decision: leave as-is unless the user wants a rewrite (out of scope).**
- `src/app/layout.tsx:52` — openGraph.title `"Stablecoin Analytics Dashboard | Pharos"` — OG title is independent, not doubled. Keep.

**Implementation notes:**
- The root template at `layout.tsx:33` is `template: "%s | Pharos"` with `default: "Stablecoin Analytics Dashboard | Pharos"`. When a page sets `title: "X | Pharos"` (string), Next.js applies the template → `"X | Pharos | Pharos"`. Fix: remove `" | Pharos"` from the per-page string.
- For not-found title strings passed through `buildSlugPageMetadata`, inspect `static-slug-page.ts` to confirm how they flow into the final metadata. If it sets them as `title: string`, strip the suffix. If as `title: { absolute: string }`, the suffix is fine (absolute titles bypass the template).

**Verification:**
- `npm run build`. Open `out/status/index.html` → `<title>` should be "System Status | Pharos" (ONE suffix, applied by template).
- Same for admin, funding.
- Check any not-found fallback page: e.g., build a missing route and confirm no double suffix.

**Risk flags:**
- If `buildSlugPageMetadata` already passes the fallback as `title: { absolute: "..." }`, stripping "| Pharos" would change final visible title. Read carefully before editing.

**Effort:** S (45 min including the `static-slug-page.ts` read).

- [ ] **Step 7.1: Read `src/lib/static-slug-page.ts` to understand fallback title handling**

Specifically look at what `buildSlugPageMetadata` does with the `fallbackTitle` string.

- [ ] **Step 7.2: Fix explicit `metadata.title` double suffixes**

- `src/app/status/page.tsx:5` change `"System Status | Pharos"` to `"System Status"`.
- `src/app/status/page.tsx:9` (openGraph.title) — leave as `"System Status | Pharos"` OR also change; grep docs pattern — decision: leave. OG title has no template, no doubling.
- `src/app/admin/page.tsx:5` change `"Operator Admin | Pharos"` to `"Operator Admin"`.
- `src/app/funding/page.tsx:17` change `"Funding — Pharos"` to `"Funding"`.

- [ ] **Step 7.3: Fix fallback titles in slug-based not-found metadata (if applicable)**

Based on findings from Step 7.1, strip `| Pharos` from fallback titles in:
- `src/app/compare/[slug]/page.tsx:24`
- `src/app/stablecoins/[peg]/page.tsx:17`
- `src/app/stablecoins/backing/[backing]/page.tsx:18`
- `src/app/stablecoins/governance/[governance]/page.tsx:22`
- `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx:18`
- `src/app/chains/[chain]/page.tsx:21`
- `src/app/digest/[date]/page.tsx:48`

If `buildSlugPageMetadata` uses `title: { absolute: "..." }`, keep the suffix. Otherwise strip.

- [ ] **Step 7.4: Verify final rendered `<title>` tags**

`npm run build`. For each fixed page, Read `out/<route>/index.html` and confirm `<title>` contains exactly ONE "| Pharos" suffix (from the template).

---

### Task 8: Remove `/portfolio/` from sitemap

**Goal:** Stop submitting a noindex-ed route to Google.

**Files:**
- Modify: `src/app/sitemap.ts` — delete lines 72-77 (the `/portfolio/` block).

**Implementation notes:**
- `/portfolio/` is noindex (confirmed in `src/app/portfolio/page.tsx:15`). Submitting it to sitemap contradicts noindex → wasted crawl budget.

**Verification:**
- `npm run build`; check `out/sitemap.xml` does not contain `portfolio`.

**Risk flags:** None.

**Effort:** S (2 min).

- [ ] **Step 8.1: Delete `/portfolio/` entry from sitemap.ts**

Remove the object at lines 72-77 of `src/app/sitemap.ts`:

```tsx
    {
      url: `${SITE_URL}/portfolio/`,
      lastModified: lastEdited("/portfolio/"),
      changeFrequency: "daily",
      priority: 0.7,
    },
```

- [ ] **Step 8.2: Verify**

Run `npm run build` and `rg "portfolio" out/sitemap.xml` → zero matches expected.

---

### Task 9: Clean up stale IDs in `data/ai-summaries.json`

**Goal:** Remove 6 orphan entries whose coin IDs no longer exist in the canonical list.

**Files:**
- Modify: `data/ai-summaries.json` — delete top-level keys for orphans.

**Implementation notes:**

Confirmed orphans via `node -e` diff: `355`, `cg-uscc`, `eura-angle`, `euroe-membrane`, `gold-vro`, `gyd-gyroscope`.

**Verification:**
- After edit, re-run the same diff: `node -e "const ids = require('./shared/data/stablecoins/canonical-order.json'); const summaries = Object.keys(require('./data/ai-summaries.json')); const orphans = summaries.filter(s => !ids.includes(s)); console.log('Orphans:', orphans);"` → should print `Orphans: []`.
- `npm run build` still succeeds (the detail page code `typedSummaries[id] ?? null` tolerates missing keys).

**Risk flags:**
- Git history preserves the removed summaries; re-adding is always possible. Safe to delete.

**Effort:** S (5 min).

- [ ] **Step 9.1: Remove orphan keys from `data/ai-summaries.json`**

Delete the top-level keys (and their value objects and trailing commas as needed) for: `355`, `cg-uscc`, `eura-angle`, `euroe-membrane`, `gold-vro`, `gyd-gyroscope`.

- [ ] **Step 9.2: Verify with diff script**

Run from repo root:

```bash
node -e "const ids = require('./shared/data/stablecoins/canonical-order.json'); const summaries = Object.keys(require('./data/ai-summaries.json')); console.log('Orphans:', summaries.filter(s => !ids.includes(s)));"
```

Expected: `Orphans: []`.

---

### Task 10: Replace `robots.ts` rules with AI crawler matrix

**Goal:** Add explicit allow rules for major AI-search crawlers (pro-visibility stance matches CC-BY-4.0 license) and disallow `/admin`. Keep `*` rule as a fallback.

**Files:**
- Modify: `src/app/robots.ts`.

**Implementation notes:**

Per spec, produce an array form of `MetadataRoute.Robots` rules. Note on `api.pharos.watch`: that's served by the Worker on a separate subdomain; `robots.ts` only governs `pharos.watch`. No `/api` path to disallow on the site itself. The spec mentions this uncertainty — confirmed: Pages site does not serve `/api`. Only disallow `/admin/`.

AI-friendly list (exactly per spec):
- Allow: `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `ChatGPT-User`, `Claude-User`, `Perplexity-User`, `GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, `Applebot-Extended`.
- Disallow for all: `/admin/`.
- Default `*` allow-all.

**Verification:**
- `npm run build`; Read `out/robots.txt`, confirm:
  - A `User-agent: GPTBot\nAllow: /` block.
  - A `User-agent: *\nAllow: /\nDisallow: /admin/` block (or equivalent).
  - Sitemap URL still present.

**Risk flags:**
- If a listed bot name is misspelled, the rule is silently ignored by that bot. Cross-check with the canonical names in each vendor's published docs post-merge. The list in the spec is accurate as of Feb 2026.

**Effort:** S (20 min).

- [ ] **Step 10.1: Rewrite `src/app/robots.ts`**

```tsx
import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";

const AI_SEARCH_BOTS = [
  "OAI-SearchBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "ChatGPT-User",
  "Claude-User",
  "Perplexity-User",
  "GPTBot",
  "ClaudeBot",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      ...AI_SEARCH_BOTS.map((bot) => ({
        userAgent: bot,
        allow: "/",
        disallow: "/admin/",
      })),
      {
        userAgent: "*",
        allow: "/",
        disallow: "/admin/",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
```

- [ ] **Step 10.2: Verify**

`npm run build`; Read `out/robots.txt`. Confirm 12 `User-agent:` blocks (11 named + `*`), each with `Allow: /` and `Disallow: /admin/`, plus the sitemap URL.

---

### Task 11: Enrich Dataset JSON-LD on coin detail pages

**Goal:** Beef up the `/stablecoin/{id}/` Dataset schema with `@id`, identifiers, variables measured, distribution endpoint, publisher anchor, and citations.

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx` — the Dataset JSON-LD block at lines 136-164.

**Implementation notes:**

Enriched fields per spec. Use the coin meta available at build time (`StablecoinMeta` from `@shared/types/core.ts`):
- `@id`: `` `${SITE_URL}${buildStablecoinUrl(id)}#dataset` ``
- `identifier`: `PropertyValue[]` — include `{ propertyID: "geckoId", value: coin.geckoId }` when present, plus one entry per `coin.contracts[]` as `{ propertyID: `contract:${chain}`, value: address }`.
- `variableMeasured`: hardcoded array of the 6 variables (price USD, marketCap USD, circulatingSupply, pegScore 0-100, dewsScore 0-100, safetyGrade).
- `dateModified`: pull from `src/generated/sitemap-dates.json` when the path is known; fallback `new Date().toISOString()`. **Problem:** the detail-page path `/stablecoin/{id}/` isn't in sitemap-dates.json (that file covers static routes only). For now, use build timestamp — acceptable for Dataset (less strict than sitemap).
- `temporalCoverage`: `"2022-01-01/.."` (fallback — per-coin first-data dates aren't trivially available at build time; a follow-up plan can wire this to a per-coin first-seen field if we track it).
- `spatialCoverage`: `{ "@type": "Place", name: "Global" }`.
- `measurementTechnique`: one-sentence description.
- `distribution`: `[{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${API_ORIGIN}/api/stablecoin/${id}` }]`. Confirmed endpoint at `worker/src/routes/dynamic-routes.ts:46` — path is `/api/stablecoin/{id}`. Use `API_ORIGIN` from `@shared/lib/runtime-origins`, not `SITE_URL`. **Note:** the Dataset page is at `pharos.watch`, but the Worker serves from `api.pharos.watch` — as captured in MEMORY.md.
- `sameAs`: build from coin links — always include `https://www.coingecko.com/en/coins/${coin.geckoId}` when `coin.geckoId` is defined, and `https://defillama.com/stablecoin/${coin.llamaId}` when `coin.llamaId` is defined, plus `coin.links?.map(l => l.url)`.
- `publisher`: `{ "@id": `${SITE_URL}#organization` }` — references the anchor added in Task 12.
- `citation`: `coin.proofOfReserves?.url` wrapped in a single-element array when present; undefined otherwise (omit field cleanly).
- `license`, `isAccessibleForFree`, `creator`, `keywords`, `name`, `description`, `url` — keep existing.

**Verification:**
- `npm run build`; Read `out/stablecoin/usdc-circle/index.html`. The Dataset JSON-LD block should contain the new fields.
- Validate schema at https://validator.schema.org/ (post-deploy).

**Risk flags:**
- If `coin.geckoId`, `coin.llamaId`, `coin.contracts`, or `coin.links` is undefined for any coin, guard access with `?.` and filter. Build will error if we try to iterate undefined.
- `distribution.contentUrl` pointing to the Worker implies the Worker exposes that route publicly without auth — confirmed (public static routes in `worker/src/routes/public-routes.ts` and dynamic routes in `dynamic-routes.ts:46`).

**Effort:** M (1.5h — careful field construction + build verification).

- [ ] **Step 11.1: Add `API_ORIGIN` import and restructure Dataset schema**

In `src/app/stablecoin/[id]/page.tsx`:

Add import:
```tsx
import { API_ORIGIN, SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

Replace the Dataset `<script>` block (lines 136-164) with:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: safeJsonLd({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": `${SITE_URL}${buildStablecoinUrl(id)}#dataset`,
      name: `${coin.name} Stablecoin Analytics`,
      description: `Live analytics for ${coin.name} (${coin.symbol}). ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoin, ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}, pegged to ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}. Price, market cap, supply trends, chain distribution, peg score, and depeg history.`,
      url: `${SITE_URL}${buildStablecoinUrl(id)}`,
      creator: { "@type": "Organization", name: "Pharos", url: SITE_URL },
      publisher: { "@id": `${SITE_URL}#organization` },
      isAccessibleForFree: true,
      license: "https://creativecommons.org/licenses/by/4.0/",
      keywords: [
        coin.symbol,
        coin.name,
        "stablecoin",
        GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance,
        BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing,
        PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency,
        "analytics",
        "peg tracking",
      ],
      identifier: [
        ...(coin.geckoId ? [{ "@type": "PropertyValue", propertyID: "geckoId", value: coin.geckoId }] : []),
        ...(coin.contracts ?? []).map((c) => ({
          "@type": "PropertyValue",
          propertyID: `contract:${c.chain}`,
          value: c.address,
        })),
      ],
      variableMeasured: [
        { "@type": "PropertyValue", name: "price", unitText: "USD" },
        { "@type": "PropertyValue", name: "marketCap", unitText: "USD" },
        { "@type": "PropertyValue", name: "circulatingSupply", unitText: coin.symbol },
        { "@type": "PropertyValue", name: "pegScore", minValue: 0, maxValue: 100 },
        { "@type": "PropertyValue", name: "dewsScore", minValue: 0, maxValue: 100 },
        { "@type": "PropertyValue", name: "safetyGrade" },
      ],
      dateModified: new Date().toISOString(),
      temporalCoverage: "2022-01-01/..",
      spatialCoverage: { "@type": "Place", name: "Global" },
      measurementTechnique:
        "Aggregated supply and price from DefiLlama, CoinGecko, GeckoTerminal, Pyth, Chainlink and on-chain RPCs; normalized in a Cloudflare Worker pipeline.",
      distribution: [
        {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: `${API_ORIGIN}/api/stablecoin/${id}`,
        },
      ],
      sameAs: [
        ...(coin.geckoId ? [`https://www.coingecko.com/en/coins/${coin.geckoId}`] : []),
        ...(coin.llamaId ? [`https://defillama.com/stablecoin/${coin.llamaId}`] : []),
        ...(coin.links?.map((l) => l.url) ?? []),
      ],
      ...(coin.proofOfReserves?.url ? { citation: [coin.proofOfReserves.url] } : {}),
    }),
  }}
/>
```

- [ ] **Step 11.2: Verify**

`npm run build`. Read `out/stablecoin/usdc-circle/index.html`, locate the Dataset block, confirm:
- `@id` present
- `distribution[0].contentUrl` equals `https://api.pharos.watch/api/stablecoin/usdc-circle`
- `identifier` contains geckoId + contracts
- `publisher.@id` equals `https://pharos.watch#organization`

Post-deploy: https://validator.schema.org/#url=https%3A%2F%2Fpharos.watch%2Fstablecoin%2Fusdc-circle%2F

---

### Task 12: Root Organization + WebSite + WebApp — add `@id` anchors, expand sameAs

**Goal:** Give other schema docs a canonical `#organization` / `#website` reference target (Task 11 uses `#organization`). Add missing social links.

**Files:**
- Modify: `src/app/layout.tsx:127-177`.

**Implementation notes:**

Changes inside the array passed to `safeJsonLd`:

1. WebSite object (first): add `"@id": `${SITE_URL}#website`` and `"inLanguage": "en"`. Remove `potentialAction` (already handled in Task 4).
2. Organization object: add `"@id": `${SITE_URL}#organization``. Expand `sameAs` to:
   - `https://x.com/PharosWatch`
   - `https://github.com/TokenBrice/stablecoin-dashboard`
   - `https://t.me/pharoswatch` (digest channel)
   - `https://t.me/PharosWatchBot` (bot)
   - `https://t.me/pharoswatchers` (community)
   - `https://farcaster.xyz/tokenbrice` (founder Farcaster — confirmed 2026-04-19)
3. WebApplication object: add `"@id": `${SITE_URL}#webapp``.

**Verification:**
- `npm run build`; Read `out/index.html`, confirm three `@id` anchors present and `sameAs` array expanded.

**Risk flags:**
- All 6 sameAs URLs are user-confirmed; no fabrication risk.

**Effort:** S (20 min).

- [ ] **Step 12.1: Edit WebSite object (first in array)**

```tsx
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_URL}#website`,
  name: "Pharos",
  url: SITE_URL,
  description: siteDescription,
  inLanguage: "en",
},
```

(Drop `potentialAction` — also covered by Task 4.)

- [ ] **Step 12.2: Edit Organization object (second in array)**

```tsx
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}#organization`,
  name: "Pharos",
  url: SITE_URL,
  logo: `${SITE_URL}/pharos-icon.png`,
  description: siteDescription,
  sameAs: [
    "https://x.com/PharosWatch",
    "https://github.com/TokenBrice/stablecoin-dashboard",
    "https://t.me/pharoswatch",
    "https://t.me/PharosWatchBot",
    "https://t.me/pharoswatchers",
  ],
  founder: {
    "@type": "Person",
    name: "TokenBrice",
    url: "https://tokenbrice.xyz",
  },
},
```

- [ ] **Step 12.3: Edit WebApplication object (third)**

Add `"@id": `${SITE_URL}#webapp`` as second field. All other fields unchanged.

- [ ] **Step 12.4: Verify**

`npm run build`; Read `out/index.html`. Confirm three `@id` anchors + expanded sameAs present.

---

### Task 13: X-Robots-Tag headers for noindex routes

**Goal:** Belt-and-braces noindex via HTTP header for `/admin/*`, `/funding/*`, `/portfolio/*`, and the `/compare/` parent only (not its slug children, which ARE indexable).

**Files:**
- Modify: `public/_headers`.

**Implementation notes:**

Cloudflare Pages `_headers` uses path patterns. The `/compare/` parent is a single file (`compare/index.html` in static export), not a directory — target just that path, not `/compare/*` (that would noindex the slug pages too). The export output makes this tricky: Next 16 static export emits `/compare/index.html` and `/compare/{slug}/index.html`. To match ONLY the parent, use `/compare/` in `_headers` (Cloudflare treats `/compare/` and `/compare/index.html` as equivalent).

Add at the top of `_headers` (before the `/*` global block to keep specificity clear):

```
/admin/*
  X-Robots-Tag: noindex, follow

/funding/*
  X-Robots-Tag: noindex, follow

/portfolio/*
  X-Robots-Tag: noindex, follow

/compare/
  X-Robots-Tag: noindex, follow
```

**Verification:**
- `npm run build` produces `out/_headers` unchanged (Pages just serves it).
- Post-deploy: `curl -I https://pharos.watch/admin/ | grep -i x-robots-tag` → should show `noindex, follow`.

**Risk flags:**
- `/compare/` match precision: if Cloudflare's matcher also matches `/compare/some-slug/`, the children inherit noindex. Verify post-deploy with `curl -I /compare/usdt-vs-usdc/` — should NOT carry the header.

**Effort:** S (15 min).

- [ ] **Step 13.1: Prepend noindex blocks to `public/_headers`**

Insert the 4 blocks above before the existing global `/*` block.

- [ ] **Step 13.2: Verify post-deploy**

Deferred to deploy-time. Local `npm run build` just copies `_headers` through.

---

### Task 14: Title length + keyword hygiene

**Goal:** Front-load primary keywords in hero page titles; add backing/governance differentiation to detail-page titles; shorten over-60-char titles.

**Files:**
- Modify: `src/app/page.tsx:14`
- Modify: `src/app/telegram/page.tsx:16`
- Modify: `src/app/chains/page.tsx:13` (the `title:` inside `buildPageMetadata({...})`)
- Modify: `src/app/yield/page.tsx:17` (same)
- Modify: `src/lib/page-metadata.ts:127` (detail-page title template in `buildStablecoinDetailMetadata`)

**Implementation notes:**

1. **Home page** (`src/app/page.tsx`). Current: `"Pharos - Stablecoin Analytics Dashboard"` (48 chars before template; template appends " | Pharos" making 59). But this is passed as a PLAIN title (not `absolute`), so the template `"%s | Pharos"` yields `"Pharos - Stablecoin Analytics Dashboard | Pharos"` — noisy "Pharos - ... | Pharos" duplication. Fix by using `title: { absolute: "Stablecoin Analytics Dashboard — Track 191 Coins | Pharos" }`. Note: "191" is currently the `ACTIVE_STABLECOINS.length` — make it dynamic to avoid drift:

```tsx
title: {
  absolute: `Stablecoin Analytics Dashboard — Track ${ACTIVE_STABLECOINS.length} Coins | Pharos`,
},
```

Char count at 191: "Stablecoin Analytics Dashboard — Track 191 Coins | Pharos" = 57 chars ✅.

2. **Telegram** (`src/app/telegram/page.tsx`). Current: `"Telegram Alerts & Digest: Stablecoin Notifications on Telegram"` — 64 chars pre-template, 73 after. Shorten to `"Stablecoin Telegram Alerts & Daily Digest"` (42 chars pre-template, 51 after). Final with template: "Stablecoin Telegram Alerts & Daily Digest | Pharos".

3. **Chains** (`src/app/chains/page.tsx:13`). Current: `"Chains"`. Replace with: `"Stablecoin Distribution by Chain"` — 32 chars, final "Stablecoin Distribution by Chain | Pharos" = 42 chars. Descriptive and keyword-rich.

4. **Yield** (`src/app/yield/page.tsx:17`). Current: `"Yield Intelligence"`. Replace with: `"Stablecoin Yield Intelligence"` (29 chars). Final: "Stablecoin Yield Intelligence | Pharos" (38 chars).

5. **Detail template** (`src/lib/page-metadata.ts:127`). Current: `` `${coin.name} (${coin.symbol}) Stablecoin Analytics` ``. Add backing differentiator using `BACKING_LABELS_SHORT` (already imported elsewhere in the project). Example final for USDC: "USDC (Circle) — RWA-Backed Stablecoin Analytics" or "USDC (Circle) — CeFi Stablecoin Analytics". Per spec, use BACKING_LABELS_SHORT:

```tsx
import { BACKING_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
// ...
export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  const backingShort = BACKING_LABELS_SHORT[coin.flags.backing] ?? "";
  const title = backingShort
    ? `${coin.name} (${coin.symbol}) — ${backingShort} Stablecoin Analytics`
    : `${coin.name} (${coin.symbol}) Stablecoin Analytics`;
  return buildPageMetadata({
    title,
    // ...existing
  });
}
```

Char budget check: "Tether (USDT) — RWA-Backed Stablecoin Analytics" = 48 chars pre-template. Final: 57 chars. ✅. Longest backing label: "RWA-Backed" (10) — safe.

**Verification:**
- `npm run build`; Read `out/index.html` `<title>` → matches `"Stablecoin Analytics Dashboard — Track 191 Coins | Pharos"`.
- Similarly spot-check telegram/, chains/, yield/, stablecoin/usdc-circle/.
- Confirm no title exceeds 60 chars visible portion.

**Risk flags:**
- Dynamic home title uses `ACTIVE_STABLECOINS.length` — make sure the import path is already present in `layout.tsx` (it is, line 15). Same constant is used elsewhere so no drift risk; CI guard `npm run check:doc-counts` handles hardcoded count drift.

**Effort:** S (30 min).

- [ ] **Step 14.1: Edit home title (absolute)**

In `src/app/page.tsx`, change the `metadata` object's `title`:

```tsx
export const metadata: Metadata = {
  title: {
    absolute: `Stablecoin Analytics Dashboard — Track ${ACTIVE_STABLECOINS.length} Coins | Pharos`,
  },
  // ...existing
};
```

Also keep the `openGraph.title` — it's independent. Update it to match:

```tsx
openGraph: {
  title: `Stablecoin Analytics Dashboard — Track ${ACTIVE_STABLECOINS.length} Coins | Pharos`,
  // ...
},
```

- [ ] **Step 14.2: Edit telegram title**

In `src/app/telegram/page.tsx`, change `title: "Telegram Alerts & Digest: Stablecoin Notifications on Telegram"` to `title: "Stablecoin Telegram Alerts & Daily Digest"`.

- [ ] **Step 14.3: Edit chains title**

In `src/app/chains/page.tsx` inside `buildPageMetadata`, change `title: "Chains"` to `title: "Stablecoin Distribution by Chain"`.

- [ ] **Step 14.4: Edit yield title**

In `src/app/yield/page.tsx` inside `buildPageMetadata`, change `title: "Yield Intelligence"` to `title: "Stablecoin Yield Intelligence"`.

- [ ] **Step 14.5: Edit detail-page title template in page-metadata.ts**

In `src/lib/page-metadata.ts`:

Add import (line 2 area): `import { BACKING_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";`.

Edit `buildStablecoinDetailMetadata` (lines 125-132):

```tsx
export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  const backingShort = BACKING_LABELS_SHORT[coin.flags.backing] ?? "";
  const title = backingShort
    ? `${coin.name} (${coin.symbol}) — ${backingShort} Stablecoin Analytics`
    : `${coin.name} (${coin.symbol}) Stablecoin Analytics`;
  return buildPageMetadata({
    title,
    description: buildStablecoinDetailDescription(coin),
    canonical: buildStablecoinUrl(coin.id),
    ogImage: buildApiOgImageUrl(`/api/og/stablecoin/${coin.id}`),
  });
}
```

- [ ] **Step 14.6: Verify**

`npm run build`. Spot-check titles on 4 pages:
- `out/index.html` → title `<title>Stablecoin Analytics Dashboard — Track 191 Coins | Pharos</title>`
- `out/telegram/index.html` → `<title>Stablecoin Telegram Alerts & Daily Digest | Pharos</title>`
- `out/chains/index.html` → `<title>Stablecoin Distribution by Chain | Pharos</title>`
- `out/stablecoin/usdt-tether/index.html` → `<title>Tether (USDT) — RWA-Backed Stablecoin Analytics | Pharos</title>`

Confirm no title exceeds ~60 visible chars.

---

## Final Verification

Run all of the following before merging:

1. **Lint**: `npm run lint` — zero errors.
2. **App build**: `npm run build` — zero errors. (This also runs the prebuild sitemap-dates generator.)
3. **Merge gate**: `npm run test:merge-gate` — the pre-push validator. Must pass.
4. **Unit tests**: `npm test` — pass (only relevant if Task 3 touched a test file).
5. **Worker types (only if touched)**: `cd worker && npx tsc --noEmit` — pass. (Week 1 doesn't modify `worker/`, so this should be a no-op check.)

Manual checks on the generated `out/` directory:

6. **404 catch-all**: last line of `out/_redirects` equals `/* /404.html 404`.
7. **Static hero present**: `out/stablecoin/usdc-circle/index.html` contains the coin name, symbol, classification pills, and description sentence BEFORE any `Suspense` skeleton markup.
8. **Breadcrumb**: `out/stablecoin/usdc-circle/index.html` contains a `BreadcrumbList` JSON-LD with 3 `itemListElement` entries (Home → Stablecoins → coin).
9. **Detail Dataset schema**: `out/stablecoin/usdc-circle/index.html` Dataset JSON-LD contains `@id`, `identifier` (≥1 entry), `distribution[0].contentUrl` = `https://api.pharos.watch/api/stablecoin/usdc-circle`, `publisher.@id` = `https://pharos.watch#organization`.
10. **Root Organization `@id`**: `out/index.html` contains `"@id":"https://pharos.watch#organization"` and expanded `sameAs`.
11. **Digest Article**: `out/digest/{any}/index.html` Article JSON-LD has both `image` and `dateModified`.
12. **robots.txt**: `out/robots.txt` lists 12 user-agent blocks and the sitemap URL.
13. **Sitemap**: `out/sitemap.xml` contains `/stablecoins/`, `/stablecoins/backing/`, `/stablecoins/governance/`, `/stablecoins/infrastructure/`, and DOES NOT contain `/portfolio/`.
14. **Titles**: Home title = `Stablecoin Analytics Dashboard — Track 191 Coins | Pharos`; detail title = `Tether (USDT) — RWA-Backed Stablecoin Analytics | Pharos`; `/admin/`, `/status/`, `/funding/` titles have exactly one `| Pharos` suffix.
15. **ai-summaries.json**: `node -e "..."` orphan check returns empty array.
16. **Schema validation**: Post-deploy, paste 3 URLs into https://validator.schema.org/:
    - https://pharos.watch/ (WebSite + Organization + WebApp)
    - https://pharos.watch/stablecoin/usdc-circle/ (Dataset + BreadcrumbList)
    - https://pharos.watch/digest/{latest}/ (Article + BreadcrumbList)
    Expected: no errors on any.
17. **Google Rich Results**: Post-deploy, test https://search.google.com/test/rich-results/ on a detail page and a digest page — Dataset, BreadcrumbList, Article eligibility confirmed.

## Risks + Rollback

**Risks by task:**
- **T1 (`_redirects` catch-all):** if mis-placed above a live 301, would break migrations. Mitigation: place LAST; verify `out/_redirects` final line post-build.
- **T2 (static hero):** visual double-hero during client hydration may look awkward for ~300 ms. Mitigation: note in component comment; week 2 can dedupe.
- **T3 (breadcrumb signature):** wide blast radius. Mitigation: TypeScript will catch missing-arg errors; run `rg BreadcrumbJsonLd` post-edit; run tests.
- **T6 (new hub pages):** new routes must be in sitemap or they're orphans. Mitigation: Step 6.5 adds them.
- **T10 (`robots.ts` matrix):** a typo in a bot name silently de-allows that bot (falls to `*` rule which is still allow). Low impact.
- **T11 (Dataset enrichment):** `coin.geckoId`, `coin.llamaId`, `coin.contracts`, `coin.links` may be undefined for some coins. Mitigation: use `?.` and conditional spreads; build will catch runtime errors.
- **T12 (Org sameAs):** all 6 URLs user-confirmed (X, GitHub, 3 Telegram, Farcaster). No invention risk.

**Rollback plan:**

Each commit (see Commit Strategy) is standalone-revertable. To roll back:
- Revert the PR commit-by-commit via `git revert <sha>` in reverse order.
- Safe order: T14 → T10 → T12 → T11 → T2 → T5 → T3 → T8 → T9 → T13 → T1. (T2 depends on no other; T3 depends on T6's hub pages if 4-level breadcrumbs were wired.)
- Cloudflare D1 is untouched; no data rollback needed.
- Pages redeploy automatically on next push; manual rollback also available via the Pages deployment history UI.

## Success Criteria

Measurable outcomes after deployment:

1. **Soft-404 fix:** `curl -I https://pharos.watch/nonexistent-xyz` returns HTTP 404, not 200. (T1)
2. **Indexable detail pages:** `curl -s https://pharos.watch/stablecoin/usdc-circle/ | grep -o "Circle"` returns ≥1 match outside `<meta>` / `<title>` tags. (T2)
3. **Correct N-level breadcrumbs:** every nested route emits a `BreadcrumbList` with the correct number of items. Verified via Google Rich Results Test on 5 sample routes (detail, digest, chains/chain, compare/slug, methodology/changelog). (T3)
4. **No lying SearchAction:** `out/index.html` contains zero `potentialAction` / `search_term_string` strings. (T4)
5. **Digest Article validates:** https://validator.schema.org/ shows no errors on any `/digest/{date}/` URL. (T5)
6. **Four new hub pages live:** `/stablecoins/`, `/stablecoins/backing/`, `/stablecoins/governance/`, `/stablecoins/infrastructure/` all return 200 and link to their children. Sitemap includes all four. (T6)
7. **Zero double `| Pharos` suffixes:** `out/**/*.html` titles contain at most one occurrence of `| Pharos`. Shell check: `grep -rhE "<title>[^<]* \| Pharos \| Pharos" out/` returns nothing. (T7)
8. **Zero orphan ai-summary keys:** the node orphan-check script prints `Orphans: []`. (T9)
9. **No /portfolio/ in sitemap:** `grep portfolio out/sitemap.xml` returns nothing. (T8)
10. **AI crawler matrix in robots.txt:** 12 user-agent blocks present. (T10)
11. **Dataset schema enriched:** all 191 detail pages' Dataset JSON-LD have `@id`, `identifier[]` (≥1), `distribution[0].contentUrl`, `publisher.@id`. Schema validator clean. (T11)
12. **Root `#organization` anchor live:** Task 11's `publisher.@id` resolves to a real node in Task 12's root Organization schema. Verified by loading `out/stablecoin/usdc-circle/index.html` and `out/index.html` side-by-side and confirming the `@id` strings match. (T12)
13. **X-Robots-Tag headers:** `curl -I /admin/`, `/funding/`, `/portfolio/` show `x-robots-tag: noindex, follow`; `curl -I /compare/usdt-vs-usdc/` does NOT. (T13)
14. **Title hygiene:** home/yield/chains/telegram/detail titles all match Task 14's specified strings, ≤60 visible chars each. (T14)

## Open Questions (flag to user before merging)

1. ~~Farcaster / Mirror URLs for Organization.sameAs (Task 12)~~ — **RESOLVED 2026-04-19:** Farcaster = `https://farcaster.xyz/tokenbrice`. No Mirror. 6 URLs total.
2. **`temporalCoverage` fallback (Task 11):** hardcoded `"2022-01-01/.."` for every coin. Fine for week 1; a future plan could thread per-coin first-seen date into `StablecoinMeta`. Any objection to the fallback?
3. **Compare parent noindex precision (Task 13):** Cloudflare `_headers` wildcard semantics for `/compare/` — if post-deploy check shows the header is also applied to slug children, we need to switch strategy (e.g., page-level robots meta instead of header). Flag during deployment.
4. **Static hero snapshot (Task 2):** deferred to week 2 per the split decision. User should confirm the minimal-hero scope is acceptable for week 1, or we'd need to stretch week 1 to include the snapshot pipeline.
