# SEO Week 2 - llms.txt + Schema Coverage Expansion

Status: verified and amended on 2026-04-19 after independent gpt-5.4 xhigh review.

Audit note: `agents/audits/2026-04-19-seo-week2-plan-verification.md`

## Goal

Ship the second SEO/LLM-indexability tranche safely:

- generate and publish `/llms.txt`
- keep exactly one visible H1 on the homepage and stablecoin detail pages
- expand valid, visible-content-aligned JSON-LD coverage
- shrink the oversized `/og-start.png`
- add explicit HTML cache headers without corrupting static asset cache headers
- document the build/SEO/header behavior changes

This is a static Next.js export to Cloudflare Pages. Changes must stay surgical and match existing route/component patterns.

## Assumptions

- Current `main` worktree is the source of truth.
- Week 1 may already have added some root JSON-LD IDs. If so, keep the existing IDs and do not duplicate graph nodes.
- `npm run build` runs `prebuild`, so generated `src/generated/sitemap-dates.json` exists during Next build.
- `llms.txt` is a community proposal and inference aid. It is not a Google ranking directive, not a robots replacement, and not a sitemap replacement.
- Google Rich Results Test is not a complete validator for generic Schema.org nodes. Use it only for Google-supported result types; use local parsing and Schema.org Validator for generic graph validity.

## Non-Negotiable Invariants

- Built indexable HTML pages must have exactly one raw `<h1>` tag. `aria-hidden` does not matter to `scripts/check-seo-static.mjs`.
- Do not emit `SearchAction` / `potentialAction` until the site has a real query handler.
- Do not create duplicate or comma-joined `Cache-Control` values in Cloudflare Pages `_headers`.
- Generated `public/llms.txt` must not drift from `scripts/generate-llms-txt.ts`.
- Do not remove existing verified Organization `sameAs` links unless explicitly documented.
- Do not mark up FAQ content unless the same questions and answers are visible on the page.

## Required Docs To Read First

- `docs/architecture.md`
- `docs/testing.md`
- `docs/scripts.md`
- `docs/homepage.md`
- `docs/stablecoin-detail-page.md`
- Route docs for pages touched below if they exist.

## Task Order

Recommended order:

1. Task 1 - generate `/llms.txt`
2. Task 2 - shared Organization/Person JSON-LD nodes
3. Task 3 - H1 fixes
4. Task 4 - full-date `<time>` datelines
5. Task 5 - shrink `og-start.png`
6. Task 6 - Article/ItemList/CollectionPage schema
7. Task 7 - FAQPage/HowTo schema, with visible FAQ content
8. Task 8 - Cloudflare Pages `_headers`
9. Task 9 - taxonomy copy verification
10. Task 10 - docs and final verification

Task 2 must land before Tasks 6 and 7 because those schema nodes reference `#organization`, `#website`, and `#person-tokenbrice`.

## Task 1: Generate `public/llms.txt`

### Goal

Create a deterministic `/llms.txt` file generated during `prebuild` from checked-in data and curated route lists.

### Files

- Create `scripts/generate-llms-txt.ts`
- Modify `package.json`
- Modify `public/_headers`
- Create generated output `public/llms.txt`
- Update docs in Task 10

### Implementation

Create `scripts/generate-llms-txt.ts`.

Use relative imports only. Do not import from `src/` or use `@/` aliases from this script.

Required data:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PEG_LABELS_SHORT } from "../shared/lib/classification";
import { DEAD_STABLECOINS } from "../shared/lib/dead-stablecoins";
import { SITE_ORIGIN } from "../shared/lib/runtime-origins";
import { ACTIVE_STABLECOINS } from "../shared/lib/stablecoins";
import type { BackingType, GovernanceType } from "../shared/types";
```

Read `data/digests.json` with `readFileSync` and a small local type. Do not import UI digest helpers from `src/`.

Use inline metadata phrases copied from `src/lib/page-metadata.ts`, because scripts must not import frontend modules:

```ts
const GOVERNANCE_METADATA_PHRASES: Record<GovernanceType, string> = {
  centralized: "centralized",
  "centralized-dependent": "CeFi-dependent",
  decentralized: "decentralized",
};

const BACKING_METADATA_PHRASES: Record<BackingType, string> = {
  "rwa-backed": "backed by real-world assets",
  "crypto-backed": "collateralized by crypto assets",
  algorithmic: "algorithmic stablecoin",
};
```

Add helpers:

- `absolute(path: string): string`
- `stablecoinPath(id: string): string` using `/stablecoin/${encodeURIComponent(id)}/`
- `escapeMarkdown(text: string): string` for `[` `]` and line breaks
- `descriptionForStablecoin(coin)` using governance/backing/peg labels

Output format:

```md
# Pharos

> Pharos tracks {N} active stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries. Data refreshes multiple times per day from the Pharos Cloudflare Worker API.

## Core Data

- [Dashboard homepage](https://pharos.watch/): Market overview with KPI bar, peg-score heatmap, and stablecoin list.
- [Safety Scores](https://pharos.watch/safety-scores/): Weighted Liquidity / Resilience / Decentralization / Dependency + peg-stability multiplier, A+ to F.
- [Pharos Stability Index](https://pharos.watch/stability-index/): Aggregate market-stability gauge with history chart.
- [DEWS (Depeg Early Warning System)](https://pharos.watch/depeg/): Active depegs, watch-list, and historical DEWS bands.
- [Liquidity](https://pharos.watch/liquidity/): DEX liquidity scores, pool counts, TVL depth.
- [Yield](https://pharos.watch/yield/): Yield-bearing stablecoin intelligence.
- [Chains](https://pharos.watch/chains/): Per-chain stablecoin distribution and health.
- [Flows](https://pharos.watch/flows/): Mint/burn flow dashboards.
- [Blacklist Tracker](https://pharos.watch/blacklist/): Issuer freeze events and exposure.
- [Dependency Map](https://pharos.watch/dependency-map/): Inter-stablecoin dependency graph.
- [Coverage](https://pharos.watch/coverage/): What Pharos tracks and what it does not.
- [Cemetery](https://pharos.watch/cemetery/): {M} defunct stablecoins and their causes of death.
- [Upcoming](https://pharos.watch/upcoming/): Pre-launch stablecoins Pharos is tracking.

## Methodology

- [Methodology Hub](https://pharos.watch/methodology/): Full scoring model for safety, peg, liquidity, yield, contagion.
- [Safety Scores Changelog](https://pharos.watch/methodology/scoring-changelog/): Every weight change since v1.0.
- [Depeg + DEWS Changelog](https://pharos.watch/methodology/depeg-changelog/)
- [Liquidity Score Changelog](https://pharos.watch/methodology/liquidity-score-changelog/)
- [Stability Index Changelog](https://pharos.watch/methodology/stability-index-changelog/)
- [Chain Health Changelog](https://pharos.watch/methodology/chain-health-changelog/)
- [Yield Intelligence Changelog](https://pharos.watch/methodology/yield-changelog/)
- [Blacklist Tracker Changelog](https://pharos.watch/methodology/blacklist-tracker-changelog/)
- [Mint/Burn Flow Changelog](https://pharos.watch/methodology/mint-burn-flow-changelog/)
- [Pricing Pipeline Changelog](https://pharos.watch/methodology/pricing-pipeline-changelog/)

## API

- [API Reference](https://pharos.watch/about/api/): Public and ops lanes, auth model, endpoint catalogue.
- [About](https://pharos.watch/about/): Project context and data sources.

## Changelog

- [Weekly Changelog](https://pharos.watch/changelog/): Release notes.
- [Daily Digest Archive](https://pharos.watch/digest/): Daily market recaps.

## Digest

- [Digest title](https://pharos.watch/digest/YYYY-MM-DD/): Digest short text.

## Stablecoins Index

- [Name (SYMBOL)](https://pharos.watch/stablecoin/{id}/): {governance} stablecoin {backing phrase} pegged to {pegLabel}.
```

Rules:

- Include the newest 20 digest entries from `data/digests.json`; sort by `generatedAt` descending if available, otherwise keep file order.
- Include all `ACTIVE_STABLECOINS` in existing deterministic order.
- Do not list every methodology subsection beyond the changelog list.
- Do not include comparison pages or taxonomy pages in the stablecoin index.
- All URLs must be absolute and use `SITE_ORIGIN`.
- Keep output under 100 KB.

Wire `package.json`:

```json
"prebuild": "tsx scripts/generate-redirects.ts && tsx scripts/generate-sitemap-dates.ts && tsx scripts/generate-llms-txt.ts"
```

Add a `/llms.txt` block to `public/_headers`. Include `! Cache-Control` now so Task 8's broad HTML cache rule cannot later combine with it:

```text
/llms.txt
  ! Cache-Control
  Cache-Control: public, max-age=3600
  Content-Type: text/plain; charset=utf-8
```

### Verification

```bash
npm run prebuild
test -f public/llms.txt
head -5 public/llms.txt
wc -c public/llms.txt
grep -q '^# Pharos$' public/llms.txt
grep -q 'https://pharos.watch/stablecoin/usdt-tether/' public/llms.txt
git ls-files --error-unmatch public/llms.txt
git diff --exit-code -- public/llms.txt
```

Post-deploy:

```bash
curl -Is https://pharos.watch/llms.txt | tr -d '\r' | grep -iE '^(http|content-type|cache-control):'
curl -s https://pharos.watch/llms.txt | head -5
```

## Task 2: Shared Person + Organization JSON-LD Nodes

### Goal

Create canonical Organization and Person graph nodes in `src/lib/json-ld.ts`, then reuse them in the root layout while preserving the existing root graph contract.

### Files

- Modify `src/lib/json-ld.ts`
- Modify `src/app/layout.tsx`
- Update docs in Task 10

### Implementation

In `src/lib/json-ld.ts`, add the import at the top:

```ts
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

Keep `safeJsonLd` unchanged. Add:

```ts
const PHAROS_SITE_DESCRIPTION =
  "Pharos tracks stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries.";

export const PHAROS_PERSON_TOKENBRICE_NODE = {
  "@type": "Person",
  "@id": `${SITE_URL}#person-tokenbrice`,
  name: "TokenBrice",
  url: "https://tokenbrice.xyz",
  image: `${SITE_URL}/tokenbrice.png`,
  sameAs: [
    "https://x.com/TokenBrice",
    "https://github.com/TokenBrice",
    "https://farcaster.xyz/tokenbrice",
  ],
  knowsAbout: ["stablecoins", "DeFi risk", "tokenomics", "pegged assets", "on-chain analytics"],
  affiliation: { "@id": `${SITE_URL}#organization` },
} as const;

export const PHAROS_ORG_NODE = {
  "@type": "Organization",
  "@id": `${SITE_URL}#organization`,
  name: "Pharos",
  url: SITE_URL,
  logo: `${SITE_URL}/pharos-icon.png`,
  description: PHAROS_SITE_DESCRIPTION,
  sameAs: [
    "https://x.com/PharosWatch",
    "https://github.com/TokenBrice/stablecoin-dashboard",
    "https://t.me/pharoswatch",
    "https://t.me/PharosWatchBot",
    "https://t.me/pharoswatchers",
  ],
  founder: { "@id": `${SITE_URL}#person-tokenbrice` },
} as const;
```

In `src/app/layout.tsx`:

- import the constants from `@/lib/json-ld`
- preserve `WebSite.@id`, `WebSite.inLanguage`, and `WebApplication.@id`
- do not add `potentialAction`
- emit a standalone Person node
- set `WebApplication.creator` to an `@id` reference for `${SITE_URL}#person-tokenbrice`
- preserve Organization Telegram `sameAs` entries from the existing layout

Expected root JSON-LD shape:

```tsx
safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}#website`,
    name: "Pharos",
    url: SITE_URL,
    description: siteDescription,
    inLanguage: "en",
  },
  {
    "@context": "https://schema.org",
    ...PHAROS_ORG_NODE,
    description: siteDescription,
  },
  {
    "@context": "https://schema.org",
    ...PHAROS_PERSON_TOKENBRICE_NODE,
  },
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": `${SITE_URL}#webapp`,
    name: "Pharos",
    url: SITE_URL,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    description: siteDescription,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    creator: { "@id": `${SITE_URL}#person-tokenbrice` },
  },
])
```

### Verification

```bash
npm run build
grep -q '#website' out/index.html
grep -q '#webapp' out/index.html
grep -q 'person-tokenbrice' out/index.html
! grep -q 'SearchAction' out/index.html
! grep -q 'search_term_string' out/index.html
```

Use substring greps such as `person-tokenbrice`; `safeJsonLd` escapes `/`, so raw `https://...` greps can false-negative.

## Task 3: Exactly One Visible H1 On Home + Detail Pages

### Goal

Replace sr-only-only H1 usage with visible H1s while preserving the repo invariant of exactly one raw H1 per indexable built page.

### Files

- Modify `src/app/page.tsx`
- Modify `src/components/site-header.tsx` only if needed to avoid duplicate visible title copy
- Modify `src/components/pre-launch-detail.tsx`
- Do not modify active-detail `src/components/stablecoin-detail/hero-card.tsx` headings
- Update `docs/homepage.md` in Task 10

### Implementation

Active stablecoin detail pages:

- No H1 change is needed.
- Keep `src/components/stablecoin-detail/static-hero-strip.tsx` as the canonical visible H1.
- Do not promote mobile/desktop H2 headings in `hero-card.tsx`.

Pre-launch stablecoin detail pages:

- In `src/components/pre-launch-detail.tsx`, delete the sr-only H1 block.
- Change the visible coin title from H2 to H1 with identical classes.

Homepage:

- Remove the sr-only H1 in `src/app/page.tsx`.
- Render exactly one visible H1 in the built HTML.
- Do not implement this by changing both responsive `SiteHeader` branches to H1.

Safe homepage implementation options:

1. Preferred: refactor `SiteHeader` so the `Pharos` title is rendered once as an H1 outside its mobile/desktop responsive duplicate branches, while branch-specific labels remain `span`/`p` or are removed.
2. Acceptable: render a single visible H1 from `src/app/page.tsx` before `SiteHeader`, and keep the existing `SiteHeader` labels as non-heading text.

The implementation agent should choose the least visually disruptive option after inspecting `SiteHeader`. The raw built HTML must contain exactly one `<h1>` on `/`.

### Verification

```bash
npm run build
count_h1() { grep -Eo '<h1([[:space:]>])' "$1" | wc -l | tr -d ' '; }
test "$(count_h1 out/index.html)" -eq 1
test "$(count_h1 out/stablecoin/usdt-tether/index.html)" -eq 1
test "$(count_h1 out/stablecoin/usdpt-western-union/index.html)" -eq 1
npm run seo:check
```

If `usdpt-western-union` is no longer a pre-launch ID, choose any current pre-launch page from `PRE_LAUNCH_STABLECOINS`.

## Task 4: Machine-Readable Datelines

### Goal

Use `<time datetime="...">` for visible as-of/reviewed labels that crawlers index.

### Files

- Modify `src/components/ai-summary.tsx`
- Modify `src/components/funding/funding-page-sections.tsx`

### Implementation

In `src/components/ai-summary.tsx`, current `updatedAt` is `YYYY-MM-DD`.

Use UTC display:

```tsx
const isoDate = updatedAt;
const dateline = new Date(`${updatedAt}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
```

Render:

```tsx
<time className="text-xs text-muted-foreground whitespace-nowrap" dateTime={isoDate}>
  Updated {dateline}
</time>
```

For `src/components/funding/funding-page-sections.tsx`:

- The route is `noindex`, but the visible "Costs last reviewed" label should still be semantic.
- Keep visible month/year granularity.
- Derive the month in UTC from `lastReviewedAt`.
- Render a `<time>` with `dateTime` as `YYYY-MM`.

Example:

```tsx
const reviewedDateObject = new Date(lastReviewedAt * 1000);
const reviewedDateTime = reviewedDateObject.toISOString().slice(0, 7);
const reviewedDate = reviewedDateObject.toLocaleDateString("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
```

Then:

```tsx
Costs last reviewed: <time dateTime={reviewedDateTime}>{reviewedDate}</time>.
```

### Verification

```bash
npm run lint
npm test
npm run build
grep -E '<time[^>]*datetime=' out/stablecoin/usdt-tether/index.html
grep -E '<time[^>]*datetime=' out/funding/index.html || true
```

React SSR may render `dateTime` as lowercase `datetime`; use lowercase-aware HTML checks.

## Task 5: Shrink `og-start.png`

### Goal

Reduce `public/og-start.png` from about 542 KB to under 200 KB without visible social-card degradation.

This reduces crawler/social-card bandwidth. It does not materially affect first meaningful paint because the OG image is metadata, not render-blocking content.

### Files

- Modify binary `public/og-start.png`

### Implementation

`pngquant` is installed in the current environment.

```bash
pngquant --quality=70-90 --force --output /tmp/og-start.png public/og-start.png
ls -lh /tmp/og-start.png
```

If the output is under 200 KB and visually acceptable, replace the file:

```bash
cp /tmp/og-start.png public/og-start.png
```

Use an image viewer at 1200 x 628 scale to check for banding.

### Verification

```bash
test "$(wc -c < public/og-start.png)" -le 204800
ls -lh public/og-start.png
```

## Task 6: Article, CollectionPage, and ItemList Schema

### Goal

Add useful JSON-LD to editorial/list pages without claiming unsupported Google rich-result behavior.

### Files

- Modify `src/app/methodology/page.tsx`
- Modify `src/components/methodology-changelog-page.tsx`
- Modify `src/app/changelog/page.tsx`
- Modify `src/app/digest/page.tsx`
- Modify `src/app/page.tsx`
- Modify `src/app/cemetery/page.tsx`
- Modify `src/app/upcoming/page.tsx`
- Modify `src/components/stablecoin-taxonomy-shell.tsx`

### Shared schema rules

- Use `Article` for Google-friendly article parsing. If technical semantics are useful, add `additionalType: "https://schema.org/TechArticle"`.
- Use timezone-bearing ISO strings for article dates when dates are emitted.
- Do not invent dates. If a route-level first-published date is not verified, omit `datePublished`.
- For page graphs, use `isPartOf` pointing at `${SITE_URL}#website`, not `#organization`.
- Prefer `ListItem.item` as a `WebPage` or `Thing` object.
- Use `author` and `publisher` `@id` references for `${SITE_URL}#person-tokenbrice` and `${SITE_URL}#organization` after Task 2.

### Methodology hub

In `src/app/methodology/page.tsx`:

- keep the existing FAQPage script
- add a second JSON-LD script for `Article`
- do not use only `SAFETY_SCORE_CHANGELOG` as a page-level publication model unless the implementation adds a verified page-level date
- it is acceptable to omit `datePublished`
- for `dateModified`, prefer generated `sitemapDates["/methodology/"]` if imported, otherwise omit it

Example shape:

```ts
{
  "@context": "https://schema.org",
  "@type": "Article",
  additionalType: "https://schema.org/TechArticle",
  headline: "Methodology: How Pharos Grades Stablecoins",
  description: "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests.",
  author: { "@id": `${SITE_URL}#person-tokenbrice` },
  publisher: { "@id": `${SITE_URL}#organization` },
  image: `${SITE_URL}/og-methodology.png`,
  mainEntityOfPage: `${SITE_URL}/methodology/`,
  keywords: ["stablecoin methodology", "safety score", "PegScore", "DEWS", "PSI", "liquidity score"],
}
```

### Methodology changelog pages

In `src/components/methodology-changelog-page.tsx`, add one script after `BreadcrumbJsonLd` when `entries.length > 0`.

Imports:

```tsx
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

Use:

```tsx
const articleDescription =
  typeof lead === "string" ? lead : `${breadcrumbName} version history for Pharos.`;
```

Schema:

```tsx
{
  "@context": "https://schema.org",
  "@type": "Article",
  additionalType: "https://schema.org/TechArticle",
  headline: `${title} - Version History`,
  description: articleDescription,
  datePublished: `${entries.at(-1)!.date}T00:00:00Z`,
  dateModified: `${entries[0].date}T00:00:00Z`,
  author: { "@id": `${SITE_URL}#person-tokenbrice` },
  publisher: { "@id": `${SITE_URL}#organization` },
  image: `${SITE_URL}/og-card.png`,
  mainEntityOfPage: `${SITE_URL}${path}`,
}
```

This covers all methodology changelog subpages that use the shared component.

### Changelog index

In `src/app/changelog/page.tsx`:

- import `safeJsonLd`
- import `SITE_ORIGIN as SITE_URL`
- use `FeaturePageShell`'s `preface` prop for the JSON-LD script, or wrap sibling elements in a fragment
- add an `id` of `week-${entry.dateRange.to}` to each changelog `<li>` that receives a schema URL fragment

Use an `ItemList` with `Article` children:

```ts
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Pharos Changelog",
  description: "Weekly release notes for Pharos.",
  numberOfItems: changelogs.length,
  itemListElement: changelogs.map((entry, i) => ({
    "@type": "ListItem",
    position: i + 1,
    item: {
      "@type": "Article",
      headline: entry.headline ?? `Changelog - Week of ${entry.dateRange.to}`,
      datePublished: `${entry.dateRange.to}T00:00:00Z`,
      description: entry.summary.map((s) => s.label).slice(0, 3).join("; "),
      author: { "@id": `${SITE_URL}#person-tokenbrice` },
      publisher: { "@id": `${SITE_URL}#organization` },
      url: `${SITE_URL}/changelog/#week-${entry.dateRange.to}`,
      mainEntityOfPage: `${SITE_URL}/changelog/#week-${entry.dateRange.to}`,
    },
  })),
}
```

### Digest archive

In `src/app/digest/page.tsx`, add a `CollectionPage` + `ItemList` graph via `FeaturePageShell`'s `preface` prop.

Use the existing `digests` import. Each ListItem should point to the corresponding digest detail route.

```ts
safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${SITE_URL}/digest/#collection`,
    name: "Daily Digest Archive",
    description: "Every Pharos stablecoin recap, newest first.",
    url: `${SITE_URL}/digest/`,
    mainEntity: { "@id": `${SITE_URL}/digest/#itemlist` },
    isPartOf: { "@id": `${SITE_URL}#website` },
  },
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/digest/#itemlist`,
    name: "Pharos Digest Archive",
    numberOfItems: digestEntries.length,
    itemListElement: digestEntries.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "WebPage",
        "@id": `${SITE_URL}/digest/${entry.date}/`,
        name: entry.title,
        url: `${SITE_URL}/digest/${entry.date}/`,
        description: entry.text,
      },
    })),
  },
])
```

Use a local typed `digestEntries` constant so TypeScript knows `date`, `title`, and `text` exist.

### Homepage

In `src/app/page.tsx`, replace the current single `ItemList` JSON-LD object with a `CollectionPage` + `ItemList` array.

Rules:

- Keep the list to the top 20 active stablecoins.
- Name it `"Top 20 Stablecoins by Market Cap"`.
- Use `CollectionPage.isPartOf` -> `#website`.
- Add logo image URLs only when `logosById[coin.id]` exists.
- Use `ListItem.item` as a WebPage.

Example:

```ts
safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${SITE_URL}/#collection`,
    name: "Pharos - Stablecoin Analytics Dashboard",
    description: `${total} active stablecoins tracked by Pharos across every major chain.`,
    url: SITE_URL,
    mainEntity: { "@id": `${SITE_URL}/#homepage-itemlist` },
    isPartOf: { "@id": `${SITE_URL}#website` },
  },
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/#homepage-itemlist`,
    name: "Top 20 Stablecoins by Market Cap",
    description: `Top 20 of ${total} active stablecoins tracked by Pharos.`,
    numberOfItems: itemListElements.length,
    itemListElement: itemListElements,
  },
])
```

### Cemetery

In `src/app/cemetery/page.tsx`, wrap the current ItemList in a `CollectionPage` + `ItemList` array.

Dead coins do not have detail routes. Do not fabricate internal URLs. Use `Thing` items:

```ts
item: {
  "@type": "Thing",
  name: `${coin.name} (${coin.symbol})`,
  description: coin.obituary,
}
```

Keep the existing `FaqSection` and its JSON-LD.

### Upcoming

In `src/app/upcoming/page.tsx`, add `CollectionPage` + `ItemList` via `FeaturePageShell`'s `preface` prop.

Pre-launch coins do have detail routes, so use `WebPage` items with URLs from `buildStablecoinUrl(coin.id)`.

Add imports:

```tsx
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

### Taxonomy pages

In `src/components/stablecoin-taxonomy-shell.tsx`, replace the single ItemList with `CollectionPage` + `ItemList`.

Add `SITE_ORIGIN as SITE_URL` and stop hard-coding `https://pharos.watch` if you touch these schema URLs.

Include an `about` `DefinedTerm` node on the `CollectionPage`:

```ts
about: {
  "@type": "DefinedTerm",
  name: title,
  termCode: String(filterTag),
  inDefinedTermSet: `${SITE_URL}/stablecoins/${kind}/`,
}
```

Use:

```ts
isPartOf: { "@id": `${SITE_URL}#website` }
```

### Verification

```bash
npm run build
npm run seo:check

for p in "" "cemetery/" "upcoming/" "digest/" "changelog/" "methodology/" "methodology/scoring-changelog/" "stablecoins/governance/cefi/" "stablecoins/backing/rwa/" "stablecoins/infrastructure/m0/"; do
  echo "--- $p ---"
  grep -o '"@type":"[^"]*"' "out/${p}index.html" | sort -u
done
```

Expected:

- `/` includes `CollectionPage`, `ItemList`, root `Organization`, `Person`, `WebApplication`, `WebSite`.
- `/methodology/` includes `Article` and `FAQPage`.
- `/methodology/*-changelog/` includes `Article` and `BreadcrumbList`.
- `/changelog/` includes `ItemList` and `Article`.
- `/digest/`, `/cemetery/`, `/upcoming/`, and taxonomy pages include `CollectionPage` and `ItemList`.

For generic Schema.org validation, use Schema.org Validator or a local parser. Do not rely on Google Rich Results Test for generic `CollectionPage`/`ItemList`.

## Task 7: FAQPage and HowTo Schema With Visible Content

### Goal

Add FAQ/HowTo schema only where visible content matches the marked-up content.

### Files

- Modify `src/app/about/api/page.tsx`
- Modify `src/app/telegram/page.tsx`

### `/about/api/`

Add a visible FAQ section. Do not add JSON-LD-only FAQ markup.

Imports:

```tsx
import { FaqSection } from "@/components/faq-section";
import type { FaqItem } from "@/lib/faq";
```

Add above the component:

```ts
const ABOUT_API_FAQ: FaqItem[] = [
  {
    question: "How do I get a Pharos API key?",
    answer: "Join the Pharos Telegram channel (https://t.me/pharoswatch) and request one. Include your intended usage: what you are building, which endpoints you plan to call, approximate polling cadence, and expected request volume.",
  },
  {
    question: "Do I need an API key for every endpoint?",
    answer: "No. Health checks, OG images, the feedback endpoint, and the Telegram webhook do not require an X-API-Key. All other protected public routes on https://api.pharos.watch require X-API-Key and return 401 without it.",
  },
  {
    question: "What is the difference between the public API lane and the website lane?",
    answer: "The public lane is https://api.pharos.watch and is for external integrations. The website lane is same-origin /_site-data/* on pharos.watch, used only by the Pharos web app itself. External consumers should call the public lane directly.",
  },
  {
    question: "How is admin auth handled?",
    answer: "Admin routes live behind Cloudflare Access on ops.pharos.watch and ops-api.pharos.watch. They do not use public API keys; access is granted through the Pharos Cloudflare Access team domain.",
  },
];
```

Render near the "Need A Key" and quick-facts area:

```tsx
<FaqSection items={ABOUT_API_FAQ} includeJsonLd />
```

Keep the existing BreadcrumbList script separate.

### `/telegram/` FAQ

`src/app/telegram/page.tsx` already emits `SoftwareApplication` JSON-LD. Preserve it.

Add imports:

```tsx
import { FaqSection } from "@/components/faq-section";
import type { FaqItem } from "@/lib/faq";
```

Add:

```ts
const TELEGRAM_FAQ: FaqItem[] = [
  {
    question: "What alerts does Pharos send on Telegram?",
    answer: "DEWS threat-level band crossings, depeg detections and worsening milestones, safety-grade changes, and launch promotions for pre-launch assets when they go live.",
  },
  {
    question: "Can I get alerts for all tracked stablecoins at once?",
    answer: "Yes. Send /subscribe <type> all, for example /subscribe depeg all, to subscribe to an alert type across every tracked stablecoin.",
  },
  {
    question: "How do I silence Telegram notifications during certain hours?",
    answer: "Use /mute <start>-<end> with UTC hours. For example, /mute 22-07 silences alerts between 10pm and 7am UTC. Use /unmutehours to disable quiet hours.",
  },
  {
    question: "What are preset watchlists?",
    answer: "Presets are curated coin lists like usd-top25 or mcap-ge-1b. Subscribing to a preset expands to the current list of coins it contains. Send /presets in Telegram to browse them interactively.",
  },
  {
    question: "How do I unsubscribe?",
    answer: "Send /unsubscribe <targets> to remove specific coin subscriptions, or /unsubscribe all to clear every subscription and disable all alert flags.",
  },
];
```

Render `<FaqSection items={TELEGRAM_FAQ} includeJsonLd />` near the bottom, before the final CTA.

### `/telegram/` HowTo

HowTo no longer has Google rich-result value. If kept, it is generic Schema.org / LLM-readable markup.

Add a separate HowTo JSON-LD script without removing the existing `SoftwareApplication` script.

Rules:

- Do not add `supply: []`.
- Step text must match visible "Getting Started" content.
- Use page-fragment URLs, not only external Telegram URLs.

Example:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: safeJsonLd({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "Set up Pharos stablecoin alerts on Telegram",
      description: "Subscribe to depeg, DEWS threat-level, safety-grade, and launch alerts for tracked stablecoins from the Pharos Telegram bot.",
      totalTime: "PT2M",
      tool: [{ "@type": "HowToTool", name: "Telegram" }],
      step: [
        {
          "@type": "HowToStep",
          position: 1,
          name: "Open @PharosWatchBot",
          text: "Open @PharosWatchBot in Telegram and send /start.",
          url: `${SITE_URL}/telegram/#getting-started`,
        },
        {
          "@type": "HowToStep",
          position: 2,
          name: "Subscribe and tune",
          text: "Subscribe and tune with commands like /subscribe dews,depeg USDT,USDC, /presets, /set USDT dews WARNING, and /mute 22-07.",
          url: `${SITE_URL}/telegram/#getting-started`,
        },
        {
          "@type": "HowToStep",
          position: 3,
          name: "Review active subscriptions",
          text: "Alerts arrive automatically when conditions change. Use /list to check active subscriptions and /presets to discover preset watchlists from inside Telegram.",
          url: `${SITE_URL}/telegram/#getting-started`,
        },
      ],
    }),
  }}
/>
```

Optional cleanup after Task 2:

- Change `SoftwareApplication.publisher` to an `@id` reference for `${SITE_URL}#organization`.

### Verification

```bash
npm run build
grep -o '"@type":"FAQPage"' out/about/api/index.html out/telegram/index.html
grep -o '"@type":"HowTo"' out/telegram/index.html
grep -o '"@type":"SoftwareApplication"' out/telegram/index.html
```

Do not list HowTo as a Google Rich Results Test requirement.

## Task 8: Cloudflare Pages HTML Cache Headers

### Goal

Serve HTML routes with:

```text
Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

without corrupting cache headers for static assets, `llms.txt`, or `_next/static/*`.

### Files

- Modify `public/_headers`

### Important Cloudflare Pages Semantics

Cloudflare Pages `_headers` rules inherit across all matching rules. If the same header is applied twice, values are joined with a comma. Therefore:

- Do not rely on "last matching block wins".
- Do not add a second `/*` block.
- Any specific non-HTML path that sets `Cache-Control` must detach the broad `/*` Cache-Control first with `! Cache-Control`.

### Implementation

Keep existing security headers in the single `/*` block and add:

```text
  Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

For every static override block that should not inherit the HTML cache header, add `! Cache-Control` immediately before the path's replacement value.

Final shape:

```text
/funding/*
  X-Robots-Tag: noindex, nofollow

/portfolio/*
  X-Robots-Tag: noindex, follow

/compare/
  X-Robots-Tag: noindex, follow

/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Content-Security-Policy: ...
  Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400

/favicon.ico
  ! Cache-Control
  Cache-Control: public, max-age=604800, immutable

/favicon.svg
  ! Cache-Control
  Cache-Control: public, max-age=604800, immutable

/apple-touch-icon.png
  ! Cache-Control
  Cache-Control: public, max-age=604800, immutable

/llms.txt
  ! Cache-Control
  Cache-Control: public, max-age=3600
  Content-Type: text/plain; charset=utf-8

/og-*.png
  ! Cache-Control
  Cache-Control: public, max-age=86400

/_next/static/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
```

Replace the existing `/og-image.png` block with `/og-*.png`; do not keep both.

### Verification

Local build:

```bash
npm run build
npm run seo:check
```

Preview deploy checks, with exact single `Cache-Control` values:

```bash
BASE=https://<preview>.pages.dev
for path in / /stablecoin/usdt-tether/ /llms.txt /favicon.ico /og-start.png /_next/static/REPLACE_WITH_REAL_ASSET; do
  echo "--- $path"
  curl -Is "$BASE$path" | tr -d '\r' | grep -iE '^(http|cache-control|content-type|cf-cache-status|age|etag):'
done
```

Expected:

- HTML routes: `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`
- `/llms.txt`: `public, max-age=3600`
- favicon files: `public, max-age=604800, immutable`
- OG PNGs: `public, max-age=86400`
- `_next/static/*`: `public, max-age=31536000, immutable`
- no comma-joined `Cache-Control` values

Also verify a Pages Function response is not governed by `_headers`:

```bash
curl -Is "$BASE/_site-data/health" | tr -d '\r' | grep -iE '^(http|cache-control|cf-cache-status|age|etag):' || true
```

Rollback:

- Revert the `_headers` commit.
- Purge Cloudflare Pages cache from the dashboard or with the available Cloudflare tooling.
- Re-check production headers after purge.

## Task 9: Taxonomy Editorial Uniqueness Verification

### Goal

Confirm taxonomy page copy is distinct enough to avoid thin duplicate-content patterns.

### Files

- Review only: `src/lib/stablecoin-taxonomy.ts`

### Implementation

Read:

- `GOVERNANCE_CONTENT`
- `BACKING_CONTENT`
- `INFRASTRUCTURE_CONTENT`

Flag any cohort whose `intro` + `description` overlaps another cohort by rough eyeball more than about 60%.

Current audit found the taxonomy copy distinct enough. If that remains true, add a short completion note in the implementation summary. Do not rewrite copy in this PR unless a concrete issue is found.

## Task 10: Docs, Plan Hygiene, and Final Verification

### Docs to update

At minimum:

- `docs/scripts.md`
  - Add `scripts/generate-llms-txt.ts`.
  - Add it to the CI-critical `prebuild` hook list.
- `docs/architecture.md`
  - Mention `/llms.txt` in the frontend/SEO surface.
  - Preserve the note that root JSON-LD has no `SearchAction`.
  - Mention the root Organization/Person/WebSite/WebApplication graph IDs if not already current.
- `docs/homepage.md`
  - Update route-shape/top-fold H1 and JSON-LD description.

Also update route-specific docs when changed behavior/schema is documented there:

- methodology
- digest
- cemetery
- upcoming
- telegram
- API page

Do not update methodology version/timeline docs; this PR changes metadata/schema, not scoring methodology.

### Final local verification

Run in this order:

```bash
npm run lint
npm test
npm run build
npm run seo:check
npm run test:merge-gate
```

`npm run test:merge-gate` may run Worker checks because this plan edits `package.json`, `public/`, `src/`, `shared` consumers, and docs. The deploy-impact classifier treats `package.json` as full deploy infrastructure.

### Targeted checks

```bash
# Generated llms.txt exists and is current.
npm run prebuild
git ls-files --error-unmatch public/llms.txt
git diff --exit-code -- public/llms.txt
head -5 public/llms.txt
wc -c public/llms.txt

# H1 invariant.
npm run build
count_h1() { grep -Eo '<h1([[:space:]>])' "$1" | wc -l | tr -d ' '; }
test "$(count_h1 out/index.html)" -eq 1
test "$(count_h1 out/stablecoin/usdt-tether/index.html)" -eq 1

# Root JSON-LD invariant.
grep -q '#website' out/index.html
grep -q '#webapp' out/index.html
grep -q '#organization' out/index.html
grep -q 'person-tokenbrice' out/index.html
! grep -q 'SearchAction' out/index.html
! grep -q 'search_term_string' out/index.html

# Time tags.
grep -E '<time[^>]*datetime=' out/stablecoin/usdt-tether/index.html

# Schema families.
for p in "" "cemetery/" "upcoming/" "digest/" "changelog/" "methodology/" "methodology/scoring-changelog/" "about/api/" "telegram/" "stablecoins/governance/cefi/" "stablecoins/backing/rwa/" "stablecoins/infrastructure/m0/"; do
  echo "--- $p ---"
  grep -o '"@type":"[^"]*"' "out/${p}index.html" | sort -u
done

# OG budget.
test "$(wc -c < public/og-start.png)" -le 204800
```

### Preview/prod verification

After preview deploy:

- Run the Task 8 curl checks against the preview URL.
- Run Schema.org Validator on one page per schema family:
  - `/`
  - `/methodology/`
  - `/methodology/scoring-changelog/`
  - `/changelog/`
  - `/digest/`
  - `/cemetery/`
  - `/upcoming/`
  - `/about/api/`
  - `/telegram/`
- Use Google Rich Results Test only for Google-supported features. Do not expect generic `CollectionPage`, `ItemList`, `Person`, `WebSite`, or `HowTo` reporting.

After production deploy:

- Re-run `curl -Is https://pharos.watch/...` header checks for `/`, `/stablecoin/usdt-tether/`, `/llms.txt`, `/favicon.ico`, and `/og-start.png`.
- Confirm `/llms.txt` starts with `# Pharos`.
- Confirm no duplicate `Cache-Control` values.

## Commit Strategy

Use theme commits so risky work can be reverted independently:

1. `feat(seo): add generated llms.txt`
2. `feat(seo): canonicalize root json-ld identity nodes`
3. `feat(seo): expose single visible h1 on key routes`
4. `feat(seo): add semantic datelines`
5. `chore(assets): shrink start og image`
6. `feat(seo): expand article and collection schema`
7. `feat(seo): add visible faq and telegram setup schema`
8. `chore(infra): set pages html cache headers`
9. `docs(seo): document llms schema and header changes`

Task 2 must precede Tasks 6 and 7.

## Rollback Notes

High-risk rollback:

- Task 8 `_headers`: revert that commit, purge Cloudflare Pages cache, redeploy, and verify production headers.

Medium-risk rollback:

- Task 3 H1: revert the H1 commit if `seo:check` or visual smoke fails.
- Task 2 root JSON-LD: revert if graph validation finds duplicate/conflicting IDs.

Low-risk rollback:

- Tasks 1, 4, 5, 6, 7, 9, and docs are additive or single-surface changes.

No data migrations are involved.
