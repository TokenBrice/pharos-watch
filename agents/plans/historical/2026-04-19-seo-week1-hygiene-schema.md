# SEO/LLM Indexability — Week 1: Hygiene & Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-04-19
**Goal:** Fix Pharos's P0 SEO/LLM-indexability bugs (detail pages with too little initial HTML, broken breadcrumbs, nonexistent SearchAction, incomplete Digest/Dataset schemas, orphan taxonomy hubs, duplicate title suffixes, stale AI-summary orphans, portfolio sitemap leak) plus a selected slice of P1 hygiene items (AI crawler rules, Dataset schema enrichment, Organization `@id`, noindex headers, title keywording). Also verify that the suspected soft-404 issue is already covered by the existing static `404.html` export before touching routing.
**Architecture:** Purely surgical edits to existing routes, schema emitters, static config (`public/_headers`, `src/app/robots.ts`, `src/app/sitemap.ts`), Pages Functions admin noindex headers, docs, and one shared component (`BreadcrumbJsonLd` signature change). One new Server Component for static hero strip on active detail pages. Four new taxonomy index pages plus one existing inbound link update. No worker changes.
**Tech Stack:** Next.js 16 static export, shadcn-based UI primitives, existing `safeJsonLd` / `buildStablecoinUrl` / `SITE_ORIGIN` helpers, Cloudflare Pages static headers and Pages Functions.

---

## Summary

This is plan #1 of a 3-plan sequential SEO/LLM-indexability effort. Week 1 fixes indexing hygiene that is actively misleading crawlers (too-thin active detail HTML, flat 2-item breadcrumbs, broken SearchAction, a missing `publisher.@id` anchor, taxonomy hubs that don't exist, etc.) plus the quickest-win P1 items that stand alone (AI crawler matrix, Dataset JSON-LD enrichment referencing a new `#organization` anchor, noindex `X-Robots-Tag` headers, detail-title keyword differentiation). The initially suspected soft-404 bug has been reclassified as a verification-only item: Cloudflare Pages already returns HTTP 404 for unknown routes when `out/404.html` exists, and `_redirects` cannot be used for a `404` rewrite.

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

**Recommendation: one PR with logically grouped commits (≈9 commits).** Each commit should pass `npm run lint` + `npm run build` independently so the PR stays bisectable. Bundling as one PR avoids noisy deploy churn (every merge redeploys Pages) and gives reviewers a single context to judge the schema changes together.

Proposed commit grouping (exact mapping to tasks):
1. **Noindex headers** — Task 13 (`_headers`, Pages Functions admin headers).
2. **Breadcrumb schema + taxonomy hub pages** — Tasks 3, 6 (update the shared breadcrumb API and `FeaturePageShell` prop first, create hub pages, then wire deep breadcrumb call sites).
3. **Root schema + SearchAction removal** — Tasks 4, 12 (`layout.tsx` WebSite/Organization/WebApp `@id`, sameAs expansion, drop SearchAction).
4. **Detail page static hero + Dataset enrichment** — Tasks 2, 11 (`stablecoin/[id]/page.tsx`, new server component, Dataset JSON-LD).
5. **Digest Article schema** — Task 5.
6. **Title hygiene + metadata polish** — Tasks 7, 14 (strip `| Pharos`, home/yield/chains/telegram/detail-template rewrites).
7. **Data cleanup: robots.ts matrix, ai-summaries orphans, sitemap portfolio removal** — Tasks 9, 10, 8.
8. **Docs sync** — Task 15 (`docs/architecture.md`, `docs/stablecoin-detail-page.md`, `docs/design-language.md`, and route docs touched by header/noindex behavior).
9. **404 verification note** — Task 1 (no code unless verification unexpectedly fails).

## Task Breakdown

---

### Task 1: Soft-404 verification — no `_redirects` change

**Goal:** Confirm unmatched static routes already return HTTP 404 via Next static export + Cloudflare Pages `404.html` behavior, and avoid adding an unsupported `_redirects` rule.

**Files:**
- No code changes expected.
- If verification unexpectedly fails, investigate `src/app/not-found.tsx`, `next.config.ts`, and Cloudflare Pages serving behavior before proposing a fix.

**Implementation notes:**
- Do **not** append `/* /404.html 404` to `public/_redirects`.
- Cloudflare Pages `_redirects` supports redirect status codes and `200` proxying; rewrites with other status codes such as `404` are unsupported.
- `npm run build` runs `scripts/generate-redirects.ts`, which rewrites everything after the generated redirect separator. Any line appended after the generated stablecoin ID migration block would be removed by prebuild anyway.
- Current live check on 2026-04-19 returned `HTTP/2 404` for `https://pharos.watch/this-route-does-not-exist-xyz`, and local `out/404.html` exists.

**Verification:**
- Run `npm run build`; confirm `out/404.html` exists.
- Confirm `public/_redirects` remains limited to supported redirect/proxy syntax.
- Post-deploy spot check remains: `curl -I https://pharos.watch/this-route-does-not-exist-xyz` should return `HTTP/2 404`.

**Risk flags:**
- Adding a fake `404` rewrite in `_redirects` would be ignored or stripped during prebuild, creating false confidence.
- No production code change should be made for this task unless the post-deploy check contradicts the current verified behavior.

**Effort:** XS (verification only).

- [ ] **Step 1.1: Verify local 404 artifact**

Run: `npm run build`

Expected: build succeeds and `out/404.html` exists.

- [ ] **Step 1.2: Verify live 404 status after deployment**

Run:

```bash
curl -I https://pharos.watch/this-route-does-not-exist-xyz
```

Expected: `HTTP/2 404`.

- [ ] **Step 1.3: Commit**

No commit for this task unless a documentation note is bundled with Task 15.

---

### Task 2: Detail page — promote static hero strip outside Suspense

**Goal:** Ensure `/stablecoin/{id}/` pages ship identity + classification (name, symbol, governance/backing/peg labels, description) in the initial HTML that crawlers and LLMs receive. Current behavior: entire body is inside `<Suspense>` with all-skeleton fallback — no substantive content pre-hydration.

**Scope decision — week 1 = minimal static hero, week 2 = snapshot integration.**

Rationale: the spec asks to display "last-known snapshot mcap/price/score if available from build-time data." Inspection shows no build-time snapshot file exists — every live data field (mcap, price, pegScore, dewsScore, reportCard, liquidity) flows through the TanStack Query layer in `client.tsx` via `useStablecoinDetailViewModel`. Adding a build-time snapshot would require a new prebuild script to call the public/site-data API for each active coin, persist JSON, and rebuild on data changes — a multi-day task with its own infra design decisions (staleness policy, cache-busting, rebuild cadence). That is well beyond the P0 "make initial HTML substantive" goal and orthogonal to the other week-1 items.

**Week 1 shipping scope:** a static Server Component that renders identity + classification + description outside Suspense for active detail pages. This flips the normal detail route from "too little substantive visible HTML" to "crawlable coin identity" for the 180 currently active assets. The 11 pre-launch assets already use `PreLaunchDetail`, a separate server-rendered page variant. Live metrics continue to stream in via Suspense + client hooks. The visible-to-user rendering order is preserved (hero first, then live data).

**Week 2 deferred scope:** optional build-time snapshot ingestion so the static hero also ships last-known price/mcap/score.

**Files:**
- Create: `src/components/stablecoin-detail/static-hero-strip.tsx` (new Server Component).
- Modify: `src/app/stablecoin/[id]/page.tsx` — lines 81-167.
- Leave untouched: `src/app/stablecoin/[id]/client.tsx` (already renders `HeroCard` with live data inside Suspense — this stays). `loading-shell.tsx` (unchanged).

**Implementation notes:**

The new `StaticHeroStrip` is a Server Component (no `"use client"`), importing only:
- A local plain logo renderer (`<img>` when `logoSrc` exists, fallback initial when absent). Do **not** import `StablecoinLogo`; it is currently marked `"use client"`.
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
- `StablecoinLogo` is currently marked `"use client"` in `src/components/stablecoin-logo.tsx`; keep the new static strip server-only by using plain `<img>` / fallback-initial markup in the new component.
- Double-rendering the logo + name in the static hero and then again inside `HeroCard` during hydration is intentional; document in a short component comment so future refactors don't "fix" it.

**Effort:** M (2-3h including verification + decision trace).

- [ ] **Step 2.1: Confirm logo rendering strategy**

Read `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-logo.tsx`. It currently has a `"use client"` directive. Do not import it into `StaticHeroStrip`; emit plain server markup:
- When `logoSrc` exists: `<img src={logoSrc} alt={`${coin.name} logo`} width={50} height={50} className="rounded-full object-contain" loading="lazy" />` inside the same round shell.
- When absent: a text initial fallback matching the existing shell dimensions.

- [ ] **Step 2.2: Create `src/components/stablecoin-detail/static-hero-strip.tsx`**

```tsx
import Link from "next/link";
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
  const logoShellClass =
    "inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-xs font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]";

  return (
    <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span className={logoShellClass} style={{ width: 56, height: 56 }}>
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={`${coin.name} logo`}
              width={50}
              height={50}
              className="rounded-full object-contain"
              loading="lazy"
            />
          ) : (
            <span role="img" aria-label={`${coin.name} logo`}>
              {coin.name.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
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

Implement this task in the same commit as Task 6. Within that combined commit, update `BreadcrumbJsonLd` and the `FeaturePageShell` `breadcrumbItems` prop first, create the four taxonomy hub pages, then wire deep taxonomy call sites to 4-level breadcrumbs. The deep taxonomy breadcrumbs intentionally point at `/stablecoins/backing/`, `/stablecoins/governance/`, and `/stablecoins/infrastructure/`; those parent URLs must exist before this task is considered complete.

New signature accepts `items: Array<{ name: string; url: string }>` where the array is ALL breadcrumb nodes in order (including Home and current). The component prepends an implicit `Home` entry is a bad idea — too easy to miss; require callers to pass the full chain.

To minimize churn at the many call sites that currently pass `(name, path)` for a 2-level (Home → X) crumb, provide a small helper at the call site: most 2-level callers can pass `items={[{name: "Home", url: "/"}, {name, url: path}]}`. Given the high number of call sites, consider an overload or second helper export `buildBreadcrumb(items)` — but keep it simple: a single prop, fully explicit.

After changing the component, every caller must be updated. `FeaturePageShell` (line 52) receives `breadcrumbName`/`path` from its consumers — keep FeaturePageShell's public prop names but construct the 3-level items internally (Home → Dashboard `/` → current {name} {path}). Wait, looking again: FeaturePageShell's visible UI breadcrumb says "Dashboard / {name}" — a 2-level hierarchy. That's fine for pages like `/chains/` (truly top-level) but lies for `/chains/{chain}/` which routes through `FeaturePageShell` too (line 42 of `chains/[chain]/page.tsx`).

**Decision for FeaturePageShell consumers:** keep the shell's prop API (`breadcrumbName`, `path`) unchanged, but allow an optional new prop `breadcrumbItems?: Array<{name,url}>` that, when supplied, overrides the auto-constructed 2-level crumb. Consumers that need 3+ level hierarchy pass `breadcrumbItems` explicitly. Default behavior for the majority (top-level feature pages) stays `[{Home,/},{breadcrumbName,path}]`.

Pages needing explicit N-level items:
- `chains/[chain]/page.tsx` → `[{Home,/},{Chains,/chains/},{meta.name,/chains/{chain}/}]`
- `compare/[slug]/page.tsx` → `[{Home,/},{Compare,/compare/},{page.shortTitle,page.href}]`
- `stablecoins/[peg]/page.tsx` (via `StablecoinTaxonomyShell` → `FeaturePageShell`) → `[{Home,/},{Stablecoins,/stablecoins/},{page.title,page.href}]`
- `stablecoins/backing/[backing]` / `governance/[governance]` / `infrastructure/[infrastructure]` → `[{Home,/},{Stablecoins,/stablecoins/},{Backing — or Governance — or Infrastructure,/stablecoins/backing/},{page.title,page.href}]`. This depends on Task 6's parent hub pages; implement Tasks 6 and 3 together in that order.
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

**Goal:** Add Google-recommended Article JSON-LD freshness and representative-image fields (`image`, `dateModified`) so digest pages carry stronger structured-data signals.

**Files:**
- Modify: `src/app/digest/[date]/page.tsx:58-67` for digest detail OpenGraph/Twitter image consistency.
- Modify: `src/app/digest/[date]/page.tsx:92-115` for Article JSON-LD.

**Implementation notes:**

Current Article schema lacks `image` and `dateModified`. Per spec, add:

```tsx
image: [`${SITE_URL}/og-digest.png`],
dateModified: new Date(digest.generatedAt * 1000).toISOString(),
```

Note: the spec mentions an "`/api/og/digest/${date}` endpoint if exists." Grep shows no such route in `worker/src/api/og.tsx` (only stablecoin/safety/depeg/stability-index OG routes). Use the existing digest-specific static asset `/og-digest.png` for Week 1. Defer per-digest OG generation to a later plan (out of scope).

Also update the digest detail metadata images from `/og-card.png` to `/og-digest.png` so OpenGraph/Twitter and Article JSON-LD agree on the representative digest image.

**Verification:**
- Build; parse/read `out/digest/{latest-date}/index.html`, confirm Article JSON-LD has `image: ["https://pharos.watch/og-digest.png"]` and `dateModified`, and metadata uses `/og-digest.png` for OpenGraph/Twitter images.
- Google Rich Results Test: paste a digest URL post-deploy, Article type should be valid.

**Risk flags:** None.

**Effort:** S (10 min).

- [ ] **Step 5.1: Edit digest Article schema**

First, in `generateMetadata`, change the digest detail `openGraph.images` and `twitter.images` URLs from `"/og-card.png"` to `"/og-digest.png"`.

In `src/app/digest/[date]/page.tsx`, inside the `safeJsonLd({...})` call at lines 95-114, add two fields (suggest placing `image` after `headline` and `dateModified` immediately after `datePublished`):

```tsx
"@context": "https://schema.org",
"@type": "Article",
headline: `${digest.title} (${formatted})`,
image: [`${SITE_URL}/og-digest.png`],
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
- Modify: `src/components/footer.tsx` — point the existing "Stablecoins" footer link at `/stablecoins/` so the new hub is reachable from `/`.
- Modify: `src/app/sitemap.ts` — add the 4 new URLs to `staticPages`.

**Implementation notes:**

Each new page is a Server Component using `FeaturePageShell` directly (not the heavier `StablecoinTaxonomyShell`, which is coin-list-oriented). Each links to its children cohorts. Use existing taxonomy arrays from `src/lib/stablecoin-taxonomy.ts`:
- `GOVERNANCE_TAXONOMY_PAGES`, `BACKING_TAXONOMY_PAGES`, `INFRASTRUCTURE_TAXONOMY_PAGES`, `ALL_STABLECOIN_TAXONOMY_PAGES`.
- Peg children via `PEG_TAXONOMY_PAGES` from `src/lib/peg-taxonomy.ts`.

`/stablecoins/` is the super-parent linking to all four axes (peg, backing, governance, infrastructure). Its axis card titles must be real `<Link>` anchors to the axis parent URLs, not just visual headings; otherwise `/stablecoins/backing/`, `/stablecoins/governance/`, and `/stablecoins/infrastructure/` can remain sitemap-only orphans. `/stablecoins/backing/`, `/stablecoins/governance/`, `/stablecoins/infrastructure/` each link to their specific child hubs.

Each page emits:
- A `FeaturePageShell` with title, intro, and a 2-level (for `/stablecoins/`) or 3-level (for the axis-parents) `breadcrumbItems`.
- An explicit card/grid of child cohort links with name + active-coin count.
- An `ItemList` JSON-LD pointing at the child cohort pages (mirror the pattern in `StablecoinTaxonomyShell`).
- A crawlable inbound path from an already reachable route. Updating the existing footer link is the smallest fix: `/` → footer "Stablecoins" → `/stablecoins/` → axis/peg children.

**Verification:**
- Run this verification after the combined Task 3 + Task 6 commit, not after Task 6 in isolation. The hub snippets pass `breadcrumbItems`, which requires Task 3's `FeaturePageShell` prop update.
- `npm run build` — all 4 pages generate without error.
- `out/stablecoins/index.html`, `out/stablecoins/backing/index.html`, etc. — each exists.
- Visit built HTML, confirm child cohort links render.
- Check `out/sitemap.xml` contains all 4 new URLs.
- Run `npm run seo:check`; the new hub pages must not be reported as orphaned or too deep.

**Risk flags:**
- Infrastructure hub only makes sense if `INFRASTRUCTURE_TAXONOMY_PAGES` is non-empty. It is — confirmed in `src/lib/stablecoin-taxonomy.ts:167-185`.
- `/stablecoins/` (super-parent) should not have a redirect entry in `_redirects` — confirmed by inspection (no `/stablecoins/` line in `public/_redirects`).
- If the footer link is not updated (or another existing inbound link is not added), `npm run seo:check` is expected to fail the new `/stablecoins/` hub as an indexable orphan.

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
  description: `Browse ${TOTAL} active stablecoins sorted by peg currency, collateral backing, governance model, and shared infrastructure.`,
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
        `Four ways to browse the ${TOTAL} active stablecoins Pharos tracks — by peg currency, backing type, governance model, or shared infrastructure.`,
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: "Stablecoin Taxonomies",
                url: `${SITE_URL}/stablecoins/`,
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                name: "Stablecoin taxonomy hubs",
                numberOfItems: AXES.reduce((sum, axis) => sum + axis.children.length, 0),
                itemListElement: AXES.flatMap((axis) => axis.children).map((page, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  name: page.title,
                  url: `${SITE_URL}${page.href}`,
                })),
              },
            ]),
          }}
        />
      }
    >
      <section className="grid gap-4 sm:grid-cols-2">
        {AXES.map((axis) => (
          <div key={axis.href} className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
            <h2 className="text-base font-semibold tracking-tight">
              <Link href={axis.href} className="pharos-focus-ring rounded-sm underline-offset-4 hover:underline">
                {axis.label}
              </Link>
            </h2>
            <div className="flex flex-col gap-2">
              {axis.children.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="block font-medium text-foreground">{page.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{page.coins.length} active</span>
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

Same pattern, but only BACKING_TAXONOMY_PAGES. Title: "Stablecoins by Backing Type". Breadcrumb items: Home / Stablecoins / Backing. Emit `CollectionPage` and `ItemList` JSON-LD for the child backing cohort pages.

- [ ] **Step 6.3: Create `src/app/stablecoins/governance/page.tsx`**

Same pattern with GOVERNANCE_TAXONOMY_PAGES. Title: "Stablecoins by Governance Model". Breadcrumb items: Home / Stablecoins / Governance. Emit `CollectionPage` and `ItemList` JSON-LD for the child governance cohort pages.

- [ ] **Step 6.4: Create `src/app/stablecoins/infrastructure/page.tsx`**

Same pattern with INFRASTRUCTURE_TAXONOMY_PAGES. Title: "Stablecoins by Shared Infrastructure". Breadcrumb items: Home / Stablecoins / Infrastructure. Emit `CollectionPage` and `ItemList` JSON-LD for the child infrastructure cohort pages.

- [ ] **Step 6.5: Update footer inbound link**

In `src/components/footer.tsx`, change the existing footer link labeled "Stablecoins" from `/stablecoins/usd/` to `/stablecoins/`. This gives the new hub a real inbound link from every route and lets the hub link onward to peg/backing/governance/infrastructure cohorts. Confirm the `/stablecoins/` implementation contains real anchors to `/stablecoins/backing/`, `/stablecoins/governance/`, and `/stablecoins/infrastructure/`.

- [ ] **Step 6.6: Add 4 new URLs to `src/app/sitemap.ts` `staticPages` array**

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

- [ ] **Step 6.7: Verify after Task 3 + Task 6 are both applied**

After Task 3's `FeaturePageShell` prop update and Task 6's hub pages are both in place, run `npm run build` — all 4 routes generate. Manually open each `out/stablecoins/*/index.html`. `rg "stablecoins/backing/" out/sitemap.xml` should return a match. Then run `npm run seo:check`; the new hub pages must not be orphaned.

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

**Goal:** Add explicit allow rules for major AI-search/AI-assistant crawler tokens (pro-visibility stance matches CC-BY-4.0 license) and disallow operator-only surfaces. Keep `*` rule as a fallback.

**Files:**
- Modify: `src/app/robots.ts`.

**Implementation notes:**

Per spec, produce an array form of `MetadataRoute.Robots` rules. Note on `api.pharos.watch`: that's served by the Worker on a separate subdomain; `robots.ts` only governs `pharos.watch`. The Pages site does have a same-origin operator proxy under `/api/admin/*` via `functions/api/admin/[[path]].ts`, so disallow both trailing-slash and no-trailing-slash operator paths.

AI-friendly list (exactly per spec):
- Allow: `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `ChatGPT-User`, `Claude-User`, `Perplexity-User`, `GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, `Applebot-Extended`.
- Disallow for all: `/admin`, `/admin/`, `/api/admin`, `/api/admin/`.
- Default `*` allow-all.

**Verification:**
- `npm run build`; Read `out/robots.txt`, confirm:
  - A `User-agent: GPTBot\nAllow: /` block.
  - A `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/\nDisallow: /api/admin\nDisallow: /api/admin/` block (or equivalent).
  - Sitemap URL still present.

**Risk flags:**
- If a listed bot name is misspelled, the rule is silently ignored by that bot. Cross-check with the canonical names in each vendor's published docs post-merge. The list was rechecked against OpenAI, Anthropic, Cloudflare AI Crawl Control, Google, and Apple docs on 2026-04-19.
- `ChatGPT-User`, `Claude-User`, and `Perplexity-User` are user-triggered fetchers/assistants rather than index crawlers in the same sense as `GPTBot`/`ClaudeBot`/`PerplexityBot`. Keeping explicit allow blocks is still harmless and documents the visibility posture.
- `Google-Extended` and `Applebot-Extended` are control tokens, not normal log-visible crawlers. Allowing them opts into model/grounding use according to vendor policy.

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

const OPERATOR_DISALLOW = ["/admin", "/admin/", "/api/admin", "/api/admin/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      ...AI_SEARCH_BOTS.map((bot) => ({
        userAgent: bot,
        allow: "/",
        disallow: OPERATOR_DISALLOW,
      })),
      {
        userAgent: "*",
        allow: "/",
        disallow: OPERATOR_DISALLOW,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
```

- [ ] **Step 10.2: Verify**

`npm run build`; Read `out/robots.txt`. Confirm 12 `User-agent:` blocks (11 named + `*`), each with `Allow: /`, disallows for `/admin`, `/admin/`, `/api/admin`, and `/api/admin/`, plus the sitemap URL.

---

### Task 11: Enrich Dataset JSON-LD on coin detail pages

**Goal:** Beef up active `/stablecoin/{id}/` Dataset schema with `@id`, identifiers, variables measured, a crawlable/free distribution endpoint, and publisher anchor while avoiding unverifiable provenance claims. Pre-launch detail pages stay on their separate `PreLaunchDetail` contract and do not need live Dataset markup in Week 1.

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx` — the Dataset JSON-LD block at lines 136-164.

**Implementation notes:**

Enriched fields per spec. Use the coin meta available at build time (`StablecoinMeta` from `@shared/types/core.ts`):
- `@id`: `` `${SITE_URL}${buildStablecoinUrl(id)}#dataset` ``
- `identifier`: `PropertyValue[]` — include `{ propertyID: "geckoId", value: coin.geckoId }` when present, plus one entry per `coin.contracts[]` as `{ propertyID: `contract:${chain}`, value: address }`.
- `variableMeasured`: hardcoded array of the 6 variables (price USD, marketCap USD, circulatingSupply, pegScore 0-100, dewsScore 0-100, safetyGrade).
- `dateModified`: pull from `src/generated/sitemap-dates.json` when the path is known; fallback `new Date().toISOString()`. **Problem:** the detail-page path `/stablecoin/{id}/` isn't in sitemap-dates.json (that file covers static routes only). For now, use build timestamp — acceptable for Dataset (less strict than sitemap).
- `spatialCoverage`: `{ "@type": "Place", name: "Global" }`.
- `measurementTechnique`: one-sentence description.
- `distribution`: `[{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE_URL}/_site-data/stablecoin/${id}` }]`. Use the same-origin Pages site-data URL, not `https://api.pharos.watch/api/stablecoin/${id}`. Production `api.pharos.watch` requires an API key for this route and returned `401` in verification; `/_site-data/stablecoin/{id}` is the crawlable/free website data lane and returned `200`.
- `publisher`: `{ "@id": `${SITE_URL}#organization` }` — references the anchor added in Task 12.
- Omit `sameAs` for Week 1. Google Dataset guidance uses `sameAs` for canonical duplicate descriptions of the same dataset; CoinGecko/DefiLlama/issuer URLs identify assets or sources, not the Pharos dataset itself.
- Omit `citation` for Week 1. Proof-of-reserves dashboards are useful source links, but they are not necessarily academic/data-descriptor citations for the Dataset schema.
- Omit `temporalCoverage` for Week 1 unless implementation can derive a per-coin first-observation date. A hardcoded `"2022-01-01/.."` claim is not defensible across all active assets.
- `license`, `isAccessibleForFree`, `creator`, `keywords`, `name`, `description`, `url` — keep existing.

**Verification:**
- `npm run build`; parse the Dataset JSON-LD block from `out/stablecoin/usdc-circle/index.html`. The Dataset block should contain the new fields.
- Validate schema at https://validator.schema.org/ (post-deploy).

**Risk flags:**
- If `coin.geckoId`, `coin.llamaId`, `coin.contracts`, or `coin.links` is undefined for any coin, guard access with `?.` and filter. Build will error if we try to iterate undefined.
- Do not raw-grep for literal URLs in built HTML; `safeJsonLd()` escapes `/` as `\u002f`. Parse/unescape the JSON-LD before asserting fields.
- Dataset assertions apply to active assets only. `TRACKED_STABLECOINS` includes 11 pre-launch assets that return `PreLaunchDetail` before this Dataset block.
- Do not add Dataset `sameAs`, `citation`, or `temporalCoverage` unless the implementation has semantically valid dataset-canonical/provenance/coverage values.

**Effort:** M (1.5h — careful field construction + build verification).

- [ ] **Step 11.1: Restructure Dataset schema**

In `src/app/stablecoin/[id]/page.tsx`:

Keep the existing `SITE_ORIGIN as SITE_URL` import. Do not import `API_ORIGIN` for Dataset distribution.

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
      spatialCoverage: { "@type": "Place", name: "Global" },
      measurementTechnique:
        "Aggregated supply and price from DefiLlama, CoinGecko, GeckoTerminal, Pyth, Chainlink and on-chain RPCs; normalized in a Cloudflare Worker pipeline.",
      distribution: [
        {
          "@type": "DataDownload",
          name: `${coin.name} detail JSON`,
          encodingFormat: "application/json",
          contentUrl: `${SITE_URL}/_site-data/stablecoin/${id}`,
        },
      ],
    }),
  }}
/>
```

- [ ] **Step 11.2: Verify**

`npm run build`. Read `out/stablecoin/usdc-circle/index.html`, locate the Dataset block, confirm:
- `@id` present
- `distribution[0].contentUrl` equals `https://pharos.watch/_site-data/stablecoin/usdc-circle`
- `identifier` contains geckoId + contracts
- `publisher.@id` equals `https://pharos.watch#organization`
- `sameAs`, `citation`, and `temporalCoverage` are absent unless separately justified by a verified source.

Use a JSON-LD parser/unescaper for these checks; raw HTML may contain `https:\u002f\u002f...`.

Optional live check before final deploy handoff:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://pharos.watch/_site-data/stablecoin/usdc-circle
```

Expected: `200`. Do not use `curl -I` here; the site-data Pages Function accepts `GET` and rejects `HEAD`.

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
3. Founder object: add `sameAs: ["https://farcaster.xyz/tokenbrice"]`. Farcaster identifies the founder, not the Pharos organization, so keep it off `Organization.sameAs`.
4. WebApplication object: add `"@id": `${SITE_URL}#webapp``.

**Verification:**
- `npm run build`; parse/unescape root JSON-LD from `out/index.html`, confirm three `@id` anchors present, organization `sameAs` has the five Pharos URLs, and founder `sameAs` contains the Farcaster URL.

**Risk flags:**
- Do not put founder-owned profiles in `Organization.sameAs`. Use `founder.sameAs` for `https://farcaster.xyz/tokenbrice`.

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
    sameAs: ["https://farcaster.xyz/tokenbrice"],
  },
},
```

- [ ] **Step 12.3: Edit WebApplication object (third)**

Add `"@id": `${SITE_URL}#webapp`` as second field. All other fields unchanged.

- [ ] **Step 12.4: Verify**

`npm run build`; parse/unescape root JSON-LD in `out/index.html`. Confirm three `@id` anchors, the five Pharos organization `sameAs` URLs, and `founder.sameAs` containing `https://farcaster.xyz/tokenbrice`.

---

### Task 13: X-Robots-Tag headers for noindex routes

**Goal:** Belt-and-braces noindex via HTTP header for static noindex routes and operator Pages Functions, without changing route-level follow/nofollow semantics.

**Files:**
- Modify: `public/_headers` for static routes only.
- Modify: `functions/admin/[[path]].ts` so allowed ops-host admin asset responses also carry `X-Robots-Tag: noindex, nofollow`.
- Modify: `functions/api/admin/[[path]].ts` so same-origin operator proxy responses and local JSON errors carry `X-Robots-Tag: noindex, nofollow`.
- Modify: `functions/__tests__/admin-host-gate.test.ts` to assert the header on rejected and allowed admin-host responses.
- Modify: `functions/__tests__/ops-admin-proxy.test.ts` to assert the header on representative local errors and a successful proxied response.

**Implementation notes:**

Cloudflare Pages `_headers` uses path patterns, but `_headers` does **not** apply to Pages Functions responses. Therefore:
- Use `_headers` only for static routes: `/funding/*`, `/portfolio/*`, and `/compare/`.
- Handle `/admin/*` in `functions/admin/[[path]].ts`.
- Handle `/api/admin/*` in `functions/api/admin/[[path]].ts`.

Preserve existing route semantics:
- `/funding/` metadata is `noindex,nofollow`, so use `X-Robots-Tag: noindex, nofollow`.
- `/portfolio/` metadata is `noindex,follow`, so use `X-Robots-Tag: noindex, follow`.
- `/compare/` parent metadata is `noindex,follow`; slug children are indexable and must not inherit the header.
- `/admin/*` and `/api/admin/*` are private operator surfaces; use `noindex, nofollow`.

Add these static blocks at the top of `_headers` (before the `/*` global block to keep specificity clear):

```
/funding/*
  X-Robots-Tag: noindex, nofollow

/portfolio/*
  X-Robots-Tag: noindex, follow

/compare/
  X-Robots-Tag: noindex, follow
```

In `functions/admin/[[path]].ts`, keep the existing rejected public-host response header and wrap allowed asset responses:

```ts
const response = await env.ASSETS.fetch(request);
const withHeaders = new Response(response.body, response);
withHeaders.headers.set("X-Robots-Tag", "noindex, nofollow");
return withHeaders;
```

In `functions/api/admin/[[path]].ts`, add a local helper such as:

```ts
function withNoindex(response: Response): Response {
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
```

Apply it to every local return path and the final `buildProxyResponse(...)` return. Keep upstream forwarded-header allowlists unchanged unless the implementation naturally prefers setting the header after proxy response construction.

**Verification:**
- `npm run build` produces `out/_headers` with the three static blocks.
- Function tests must assert the new header. At minimum:
  - `functions/__tests__/admin-host-gate.test.ts`: public-host 404 and ops-host asset 200 both include `X-Robots-Tag: noindex, nofollow`.
  - `functions/__tests__/ops-admin-proxy.test.ts`: non-ops 404, missing-JWT 401, method 405, and successful proxied 200 include `X-Robots-Tag: noindex, nofollow`.
- Run `npm test -- functions/__tests__/admin-host-gate.test.ts functions/__tests__/ops-admin-proxy.test.ts`.
- Post-deploy:
  - `curl -I https://pharos.watch/admin/ | grep -i x-robots-tag` → `noindex, nofollow`
  - `curl -I https://pharos.watch/funding/ | grep -i x-robots-tag` → `noindex, nofollow`
  - `curl -I https://pharos.watch/portfolio/ | grep -i x-robots-tag` → `noindex, follow`
  - `curl -I https://pharos.watch/compare/ | grep -i x-robots-tag` → `noindex, follow`
  - `curl -I https://pharos.watch/compare/usdt-vs-usdc/ | grep -i x-robots-tag` → no match

**Risk flags:**
- `/compare/` match precision is production-sensitive. If Cloudflare's matcher also applies `/compare/` to slug children, switch `/compare/` to route-level metadata only and remove the header block.
- Do not rely on `_headers` for `/admin/*` or `/api/admin/*`; those are Pages Functions boundaries.

**Effort:** S-M (30-45 min including tests).

- [ ] **Step 13.1: Prepend static noindex blocks to `public/_headers`**

Insert the 3 static blocks above before the existing global `/*` block.

- [ ] **Step 13.2: Add admin asset noindex header**

Patch `functions/admin/[[path]].ts` so both rejected and allowed asset responses return `X-Robots-Tag: noindex, nofollow`.

- [ ] **Step 13.3: Add admin proxy noindex header**

Patch `functions/api/admin/[[path]].ts` so local errors and proxied operator responses return `X-Robots-Tag: noindex, nofollow`.

- [ ] **Step 13.4: Update tests**

Add the required header assertions to `functions/__tests__/admin-host-gate.test.ts` and `functions/__tests__/ops-admin-proxy.test.ts`.

- [ ] **Step 13.5: Verify**

Run `npm run build`, `npm test -- functions/__tests__/admin-host-gate.test.ts functions/__tests__/ops-admin-proxy.test.ts`, then the post-deploy curls above after release.

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

1. **Home page** (`src/app/page.tsx`). Current: `"Pharos - Stablecoin Analytics Dashboard"` (48 chars before template; template appends " | Pharos" making 59). But this is passed as a PLAIN title (not `absolute`), so the template `"%s | Pharos"` yields `"Pharos - Stablecoin Analytics Dashboard | Pharos"` — noisy "Pharos - ... | Pharos" duplication. Fix by using `title: { absolute: "Stablecoin Analytics Dashboard — Track 191 Coins | Pharos" }`. Use `TRACKED_STABLECOINS.length` for this count because the product promise is "191 tracked coins"; `ACTIVE_STABLECOINS.length` is currently 180 because it excludes 11 pre-launch assets.

```tsx
title: {
  absolute: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOINS.length} Coins | Pharos`,
},
```

Char count at 191: "Stablecoin Analytics Dashboard — Track 191 Coins | Pharos" = 57 chars ✅.

2. **Telegram** (`src/app/telegram/page.tsx`). Current: `"Telegram Alerts & Digest: Stablecoin Notifications on Telegram"` — 64 chars pre-template, 73 after. Shorten to `"Stablecoin Telegram Alerts & Daily Digest"` (42 chars pre-template, 51 after). Final with template: "Stablecoin Telegram Alerts & Daily Digest | Pharos".

3. **Chains** (`src/app/chains/page.tsx:13`). Current: `"Chains"`. Replace with: `"Stablecoin Distribution by Chain"` — 32 chars, final "Stablecoin Distribution by Chain | Pharos" = 42 chars. Descriptive and keyword-rich.

4. **Yield** (`src/app/yield/page.tsx:17`). Current: `"Yield Intelligence"`. Replace with: `"Stablecoin Yield Intelligence"` (29 chars). Final: "Stablecoin Yield Intelligence | Pharos" (38 chars).

5. **Detail template** (`src/lib/page-metadata.ts:127`). Current: `` `${coin.name} (${coin.symbol}) Stablecoin Analytics` ``. Add a backing differentiator using `BACKING_BADGE_STYLES[coin.flags.backing].label` so titles use human-readable labels such as `RWA-Backed`, `Crypto-Backed`, and `Algorithmic`. Do **not** use `BACKING_LABELS_SHORT` here; its values are `RWA`, `Crypto`, and `Algo`.

```tsx
import { BACKING_BADGE_STYLES, PEG_LABELS_SHORT } from "@shared/lib/classification";
// ...
export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  const backingLabel = BACKING_BADGE_STYLES[coin.flags.backing]?.label ?? "";
  const title = backingLabel
    ? `${coin.name} (${coin.symbol}) — ${backingLabel} Stablecoin Analytics`
    : `${coin.name} (${coin.symbol}) Stablecoin Analytics`;
  return buildPageMetadata({
    title,
    // ...existing
  });
}
```

Char budget check: "Tether (USDT) — RWA-Backed Stablecoin Analytics" = 48 chars pre-template. Final: 57 chars. ✅. Some long-tail assets with long names can exceed 60 after adding any useful differentiator; avoid unnatural truncation in metadata unless a later SEO pass introduces a title-shortening helper.

**Verification:**
- `npm run build`; Read `out/index.html` `<title>` → matches `"Stablecoin Analytics Dashboard — Track 191 Coins | Pharos"`.
- Similarly spot-check telegram/, chains/, yield/, stablecoin/usdc-circle/.
- Confirm priority titles (home/telegram/chains/yield/top detail examples) stay near the 60-character target. Do not fail the plan solely because long coin names exceed 60.

**Risk flags:**
- Dynamic home title must use `TRACKED_STABLECOINS.length`, not `ACTIVE_STABLECOINS.length`, if the expected visible count is 191.
- `src/lib/page-metadata.ts` already imports `PEG_LABELS_SHORT`; extend that existing import rather than adding a duplicate import.

**Effort:** S (30 min).

- [ ] **Step 14.1: Edit home title (absolute)**

In `src/app/page.tsx`, change the `metadata` object's `title`:

```tsx
export const metadata: Metadata = {
  title: {
    absolute: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOINS.length} Coins | Pharos`,
  },
  // ...existing
};
```

Also keep the `openGraph.title` — it's independent. Update it to match:

```tsx
openGraph: {
  title: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOINS.length} Coins | Pharos`,
  // ...
},
```

If `src/app/page.tsx` currently imports only `ACTIVE_STABLECOINS`, change it to import both `ACTIVE_STABLECOINS` and `TRACKED_STABLECOINS` from `@shared/lib/stablecoins`.

- [ ] **Step 14.2: Edit telegram title**

In `src/app/telegram/page.tsx`, change `title: "Telegram Alerts & Digest: Stablecoin Notifications on Telegram"` to `title: "Stablecoin Telegram Alerts & Daily Digest"`.

- [ ] **Step 14.3: Edit chains title**

In `src/app/chains/page.tsx` inside `buildPageMetadata`, change `title: "Chains"` to `title: "Stablecoin Distribution by Chain"`.

- [ ] **Step 14.4: Edit yield title**

In `src/app/yield/page.tsx` inside `buildPageMetadata`, change `title: "Yield Intelligence"` to `title: "Stablecoin Yield Intelligence"`.

- [ ] **Step 14.5: Edit detail-page title template in page-metadata.ts**

In `src/lib/page-metadata.ts`:

Extend the existing classification import to include `BACKING_BADGE_STYLES`:

```tsx
import { BACKING_BADGE_STYLES, PEG_LABELS_SHORT } from "@shared/lib/classification";
```

Edit `buildStablecoinDetailMetadata` (lines 125-132):

```tsx
export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  const backingLabel = BACKING_BADGE_STYLES[coin.flags.backing]?.label ?? "";
  const title = backingLabel
    ? `${coin.name} (${coin.symbol}) — ${backingLabel} Stablecoin Analytics`
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

Confirm the priority title examples stay near the 60-character target; long-tail detail pages may exceed it because coin names vary.

---

### Task 15: Docs sync for SEO/crawl behavior

**Goal:** Keep the verified docs corpus aligned with route/crawl/schema behavior changes required by AGENTS.md.

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/README.md`
- Modify: `docs/stablecoin-detail-page.md`
- Modify: `docs/design-language.md`
- Modify route docs if implementation changes their explicit contracts, especially `docs/funding-page.md`, `docs/portfolio-page.md`, or `docs/status-dashboard.md`.

**Implementation notes:**
- `docs/architecture.md` must no longer say root JSON-LD includes `SearchAction`.
- `docs/architecture.md` must no longer say the sitemap includes the noindex `/portfolio/` tool URL.
- `docs/architecture.md` should mention the new `/stablecoins/`, `/stablecoins/backing/`, `/stablecoins/governance/`, and `/stablecoins/infrastructure/` hub routes as indexable route families.
- `docs/README.md` route index should include the new stablecoin taxonomy parent hubs, not only the dynamic child routes.
- `docs/architecture.md` should describe robots policy as allow-all plus explicit operator-surface disallows for `/admin`, `/admin/`, `/api/admin`, and `/api/admin/`.
- `docs/stablecoin-detail-page.md` should describe the static server-rendered hero strip outside Suspense for active assets, and should keep `PreLaunchDetail` as the pre-launch variant.
- `docs/design-language.md` should no longer say active detail pages use an `sr-only` h1 as the main detail heading pattern after Task 2; update the stablecoin detail section to match the visible static `h1` plus client `HeroCard` `h2` pattern.
- Do not update methodology docs; this plan does not change scoring methodology, data sources, API contracts, or pipeline behavior.

**Verification:**
- `npm run check:verified-doc-links`
- `npm run check:doc-source-paths`
- `npm run check:doc-sync`
- `npm run check:doc-counts`

**Risk flags:**
- Docs count checks may require exact tracked/active wording. Use "191 tracked" only for `TRACKED_STABLECOINS`; use "180 active" only where the active/non-pre-launch surface is meant.

**Effort:** S-M (30-45 min).

- [ ] **Step 15.1: Update architecture SEO surface docs**

Patch `docs/architecture.md` and `docs/README.md` for root JSON-LD, sitemap ownership, robots policy, and new taxonomy hubs.

- [ ] **Step 15.2: Update detail route docs**

Patch `docs/stablecoin-detail-page.md` and `docs/design-language.md` for the new active-detail static hero pattern.

- [ ] **Step 15.3: Update route-specific noindex docs if needed**

If Task 13 changes route-level header semantics beyond reinforcing existing metadata, update the relevant route docs.

- [ ] **Step 15.4: Verify docs**

Run the four doc checks listed above.

---

## Final Verification

Run all of the following before merging:

1. **Prebuild validation**: `npm run validate:prebuild` — zero errors.
2. **App build**: `npm run build` — zero errors. (This also runs the prebuild redirect and sitemap-date generators.)
3. **Static SEO gate**: `npm run seo:check` — zero errors.
4. **Unit tests**: `npm test` — pass.
5. **Critical coverage**: `npm run coverage:critical` — pass.
6. **Merge gate**: run `npm run test:merge-gate -- --staged` before committing, or `npm run test:merge-gate` after commits exist against `origin/main`. The default merge-gate mode compares `HEAD` to `origin/main` and can miss uncommitted work.
7. **Worker types (only if worker touched)**: `cd worker && npx tsc --noEmit` — pass if any worker files were touched. Week 1 should not modify `worker/`.

Manual checks on the generated `out/` directory:

8. **404 behavior**: `out/404.html` exists. Do not expect or add a `/* /404.html 404` `_redirects` line.
9. **Static hero present**: `out/stablecoin/usdc-circle/index.html` contains the coin name, symbol, classification pills, and description sentence in non-meta content.
10. **Breadcrumb**: parse JSON-LD from `out/stablecoin/usdc-circle/index.html` and confirm `BreadcrumbList` has 3 `itemListElement` entries (Home → Stablecoins → coin).
11. **Detail Dataset schema**: parse JSON-LD from `out/stablecoin/usdc-circle/index.html` and confirm Dataset has `@id`, `identifier` (≥1 entry), `distribution[0].contentUrl` = `https://pharos.watch/_site-data/stablecoin/usdc-circle`, `publisher.@id` = `https://pharos.watch#organization`, and no unjustified `sameAs`, `citation`, or `temporalCoverage`.
12. **Root Organization `@id`**: parse JSON-LD from `out/index.html`; confirm `https://pharos.watch#organization`, `https://pharos.watch#website`, and `https://pharos.watch#webapp` exist, organization `sameAs` contains the five Pharos URLs, and founder `sameAs` contains `https://farcaster.xyz/tokenbrice`.
13. **Digest Article**: parse JSON-LD from `out/digest/{any}/index.html`; Article has both `image` and `dateModified`.
14. **robots.txt**: `out/robots.txt` lists 12 user-agent blocks, disallows `/admin`, `/admin/`, `/api/admin`, and `/api/admin/`, and includes the sitemap URL.
15. **Sitemap**: `out/sitemap.xml` contains `/stablecoins/`, `/stablecoins/backing/`, `/stablecoins/governance/`, `/stablecoins/infrastructure/`, and DOES NOT contain `/portfolio/`.
16. **Titles**: Home title = `Stablecoin Analytics Dashboard — Track 191 Coins | Pharos`; detail title example = `Tether (USDT) — RWA-Backed Stablecoin Analytics | Pharos`; `/admin/`, `/status/`, `/funding/` titles have exactly one `| Pharos` suffix.
17. **ai-summaries.json**: `node -e "..."` orphan check returns empty array.
18. **Schema validation**: Post-deploy, paste 3 URLs into https://validator.schema.org/:
    - https://pharos.watch/ (WebSite + Organization + WebApp)
    - https://pharos.watch/stablecoin/usdc-circle/ (Dataset + BreadcrumbList)
    - https://pharos.watch/digest/{latest}/ (Article + BreadcrumbList)
    Expected: no errors on any.
19. **Google Rich Results**: Post-deploy, test https://search.google.com/test/rich-results/ on a detail page and a digest page — supported rich result types should validate. Dataset may not surface in the Rich Results Test the same way Article/Breadcrumb do; use validator.schema.org for Dataset syntax.

## Risks + Rollback

**Risks by task:**
- **T1 (404 verification):** adding an unsupported `_redirects` 404 rewrite would create false confidence or be stripped by prebuild. Mitigation: no `_redirects` change; verify `out/404.html` and live 404 status.
- **T2 (static hero):** visual double-hero during client hydration may look awkward for ~300 ms. Mitigation: note in component comment; week 2 can dedupe.
- **T3 (breadcrumb signature):** wide blast radius. Mitigation: TypeScript will catch missing-arg errors; run `rg BreadcrumbJsonLd` post-edit; run tests.
- **T6 (new hub pages):** new routes must be in sitemap and have inbound links or `seo:check` will flag them as orphans. Mitigation: sitemap entries plus footer link to `/stablecoins/`.
- **T10 (`robots.ts` matrix):** a typo in a bot name silently de-allows that bot (falls to `*` rule which is still allow). Low impact.
- **T11 (Dataset enrichment):** `coin.geckoId`, `coin.llamaId`, `coin.contracts`, or `coin.links` may be undefined for some active coins. Mitigation: use `?.` and conditional spreads; build will catch runtime errors. Scope Dataset verification to active/non-pre-launch assets only.
- **T12 (Org/founder sameAs):** founder-owned URLs must not be emitted as `Organization.sameAs`. Mitigation: put Farcaster on `founder.sameAs`.
- **T13 (headers):** `_headers` cannot cover Pages Functions and `/compare/` match precision must be verified in production. Mitigation: set admin headers in functions and curl `/compare/` plus a slug child post-deploy.

**Rollback plan:**

Each commit (see Commit Strategy) is standalone-revertable. To roll back:
- Revert the PR commit-by-commit via `git revert <sha>` in reverse order.
- Safe reverse commit order:
  1. Docs sync (T15)
  2. Data cleanup: robots + ai-summaries + sitemap portfolio removal (T9+T10+T8)
  3. Title hygiene + metadata polish (T7+T14)
  4. Digest Article schema (T5)
  5. Detail page static hero + Dataset enrichment (T2+T11)
  6. Root schema + SearchAction removal (T4+T12)
  7. Breadcrumb schema + taxonomy hub pages (T3+T6)
  8. Noindex headers (T13)
  9. 404 verification note if a docs-only note was committed (T1)
- Cloudflare D1 is untouched; no data rollback needed.
- Pages redeploy automatically on next push; manual rollback also available via the Pages deployment history UI.

## Success Criteria

Measurable outcomes after deployment:

1. **Soft-404 verification:** `curl -I https://pharos.watch/nonexistent-xyz` returns HTTP 404, not 200, without adding an unsupported `_redirects` catch-all. (T1)
2. **Indexable detail pages:** `curl -s https://pharos.watch/stablecoin/usdc-circle/ | grep -o "Circle"` returns ≥1 match outside `<meta>` / `<title>` tags. (T2)
3. **Correct N-level breadcrumbs:** every nested route emits a `BreadcrumbList` with the correct number of items. Verified via Google Rich Results Test on 5 sample routes (detail, digest, chains/chain, compare/slug, methodology/changelog). (T3)
4. **No lying SearchAction:** `out/index.html` contains zero `potentialAction` / `search_term_string` strings. (T4)
5. **Digest Article validates:** https://validator.schema.org/ shows no errors on any `/digest/{date}/` URL. (T5)
6. **Four new hub pages live and reachable:** `/stablecoins/`, `/stablecoins/backing/`, `/stablecoins/governance/`, `/stablecoins/infrastructure/` all return 200 and link to their children. Sitemap includes all four, and `npm run seo:check` reports no orphan/depth failures. (T6)
7. **Zero double `| Pharos` suffixes:** `out/**/*.html` titles contain at most one occurrence of `| Pharos`. Shell check: `grep -rhE "<title>[^<]* \| Pharos \| Pharos" out/` returns nothing. (T7)
8. **Zero orphan ai-summary keys:** the node orphan-check script prints `Orphans: []`. (T9)
9. **No /portfolio/ in sitemap:** `grep portfolio out/sitemap.xml` returns nothing. (T8)
10. **AI crawler matrix in robots.txt:** 12 user-agent blocks present, with `/admin`, `/admin/`, `/api/admin`, and `/api/admin/` disallowed. (T10)
11. **Dataset schema enriched:** all active/non-pre-launch detail pages' Dataset JSON-LD have `@id`, `identifier[]` (≥1), `distribution[0].contentUrl` on `https://pharos.watch/_site-data/stablecoin/{id}`, and `publisher.@id`, while omitting unverifiable `sameAs`, `citation`, and `temporalCoverage`. Schema validator clean on sample active pages. (T11)
12. **Root `#organization` anchor live:** Task 11's `publisher.@id` resolves to a real node in Task 12's root Organization schema. Root JSON-LD also has `#website`, `#webapp`, five organization `sameAs` URLs, and founder Farcaster under `founder.sameAs`. (T12)
13. **X-Robots-Tag headers:** `curl -I /admin/` and `/funding/` show `x-robots-tag: noindex, nofollow`; `/portfolio/` and `/compare/` show `noindex, follow`; `/compare/usdt-vs-usdc/` does NOT carry the header. (T13)
14. **Title hygiene:** home/yield/chains/telegram/detail priority examples match Task 14's specified strings and stay near the 60-character target; double `| Pharos` suffixes are eliminated. (T14)
15. **Docs sync:** verified docs no longer contradict root schema, sitemap, robots, detail-page h1/static hero behavior, or noindex header behavior. (T15)

## Open Questions (flag to user before merging)

1. ~~Farcaster / Mirror URLs for Organization.sameAs (Task 12)~~ — **RESOLVED 2026-04-19:** Farcaster = `https://farcaster.xyz/tokenbrice`; emit it under `founder.sameAs`, not `Organization.sameAs`. No Mirror.
2. **Compare parent noindex precision (Task 13):** Cloudflare `_headers` wildcard semantics for `/compare/` — if post-deploy check shows the header is also applied to slug children, we need to switch strategy (e.g., page-level robots meta instead of header). Flag during deployment.
3. **Static hero snapshot (Task 2):** deferred to week 2 per the split decision. User should confirm the minimal-hero scope is acceptable for week 1, or we'd need to stretch week 1 to include the snapshot pipeline.
