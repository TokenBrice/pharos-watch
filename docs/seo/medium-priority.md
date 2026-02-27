# SEO Recommendations: Medium Priority

> Strategic projects that expand organic reach and content surface area.
> Estimated timeline: implement over 1-3 months after critical/high items are resolved.

---

## 1. Create Per-Peg-Currency Landing Pages

**Problem:** Pharos tracks stablecoins across 16+ peg currencies (USD, EUR, GBP, JPY,
gold, silver, IDR, BRL, TRY, PHP, etc.) — a unique competitive advantage. But there
are no dedicated category pages. Users searching "gold stablecoins" or "euro stablecoin
comparison" land on CoinGecko instead, which has 16 stablecoin subcategory pages.

**Fix:** Create filterable landing pages at `/stablecoins/{peg}/`:

```
/stablecoins/usd/     → USD-pegged stablecoins
/stablecoins/eur/     → EUR-pegged stablecoins
/stablecoins/gbp/     → GBP-pegged stablecoins
/stablecoins/gold/    → Gold-pegged stablecoins
/stablecoins/silver/  → Silver-pegged stablecoins
/stablecoins/jpy/     → JPY-pegged stablecoins
(etc.)
```

Each page should include:
- H1: `"USD Stablecoins"` (or the peg currency name)
- 200-300 words of educational intro ("What are USD-pegged stablecoins?",
  characteristics of this peg type, key differences between major coins)
- Filtered table of stablecoins for that peg currency
- Links to individual coin detail pages
- Breadcrumb: Home → Stablecoins → USD
- BreadcrumbJsonLd schema
- Unique meta title/description per peg

**Implementation approach:**
- Create `src/app/stablecoins/[peg]/page.tsx` with `generateStaticParams()` returning
  all peg currencies
- Filter `TRACKED_STABLECOINS` by `flags.pegCurrency`
- Reuse the existing stablecoin table component with a pre-applied filter
- Add all generated URLs to `sitemap.ts`
- Link from homepage filter chips and from the sidebar or footer

**Target keywords:** "gold stablecoin", "euro stablecoin", "JPY stablecoin",
"best USD stablecoins", "{currency} stablecoin comparison"

---

## 2. Create Per-Chain Landing Pages

REFUSED: REASON => FOCUS ON PER-PEG LANDING PAGES

---

## 3. Create Individual Digest Pages

**Problem:** Daily digests are 150-300 words of unique editorial content each, but
they're all rendered client-side in a single list on `/digest/`. Google can't index
individual digest entries, and each entry has no unique URL, title, or schema.

**Fix:** Create individual pages at `/digest/{date}/`:

```
/digest/2026-02-26/
/digest/2026-02-25/
(etc.)
```

Each page should include:
- H1: digest title (from the AI-generated headline)
- Full digest text
- Date published
- Link to previous/next digest
- `Article` JSON-LD schema:

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Daily Stablecoin Recap — Feb 26, 2026",
  "datePublished": "2026-02-26",
  "author": {
    "@type": "Organization",
    "name": "Pharos"
  },
  "publisher": {
    "@type": "Organization",
    "name": "Pharos",
    "logo": "https://pharos.watch/pharos-icon.png"
  }
}
```

- Add all digest URLs to sitemap with `changeFrequency: "never"` (historical content)
- Keep the `/digest/` archive as the listing page
- Generate static pages from the digest archive API at build time, or
  use a data file committed to the repo

**Target keywords:** "stablecoin market recap", "stablecoin daily update",
"stablecoin news {date}"

**Bonus:** This creates a growing corpus of indexable pages (one per day) that
signals freshness to Google and provides topical authority over time.

---

## 4. Add FAQ Schema to More Pages

**Problem:** Only the About page has `FAQPage` schema (4 Q&A pairs). Several other
pages could qualify for "People Also Ask" SERP features with targeted FAQ content.

**Fix:** Add inline FAQ sections with schema to these pages:

### 4a. Risk Lab — `src/app/risk-lab/page.tsx`

Add a collapsible FAQ section below the main content:

```json
{
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How are stablecoin safety grades calculated?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Each stablecoin is graded from A+ to F across five dimensions: peg stability (25%), liquidity (20%), resilience (20%), decentralization (10%), and dependency risk (25%). The weighted composite produces the final letter grade."
      }
    },
    {
      "@type": "Question",
      "name": "What does the contagion simulation show?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The contagion simulator models cascading failures. Select a stablecoin to collapse and see which others would be affected through shared collateral, protocol dependencies, and backing chain exposure."
      }
    }
  ]
}
```

### 4b. Stability Index — `src/app/stability-index/page.tsx`

```json
{
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is the Pharos Stability Index?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The Pharos Stability Index (PSI) is a composite 0–100 score measuring overall stablecoin ecosystem health, combining weighted peg deviation, market cap concentration, and depeg event frequency into a single daily reading."
      }
    },
    {
      "@type": "Question",
      "name": "What do the condition bands mean?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Condition bands classify market state: green (healthy, PSI above 80), yellow (stressed, PSI 60–80), and red (distressed, PSI below 60). These thresholds are calibrated against historical market events."
      }
    }
  ]
}
```

### 4c. Cemetery — `src/app/cemetery/page.tsx`

```json
{
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What causes stablecoins to fail?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Common causes include algorithmic peg mechanism failure (e.g., TerraUSD), counterparty or custodian collapse, liquidity drain from bank runs, regulatory enforcement actions, and project abandonment by the development team."
      }
    }
  ]
}
```

Display these as visible, collapsible `<details>` elements so the content is
accessible to users too, not just crawlers.

---

## 5. Add `WebApplication` Schema to Root Layout

**Problem:** Pharos is an interactive web application, but Google doesn't know that
from its structured data. The `WebApplication` schema can surface the site in
application-related searches and knowledge panels.

**File:** `src/app/layout.tsx:113` — add to the existing JSON-LD array:

```typescript
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Pharos",
  url: "https://pharos.watch",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  description: siteDescription,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  creator: {
    "@type": "Person",
    name: "TokenBrice",
    url: "https://tokenbrice.xyz",
  },
},
```

---

## 6. Generate Per-Page OG Images

**Problem:** All 230+ pages share a single OG image (`og-card.png`). When someone
shares a link to the USDC detail page or the Cemetery on social media, the preview
looks identical to the homepage. Per-page images increase click-through from social
platforms.

**Fix options (pick one):**

### Option A: Static category images (low effort)
Create 4-5 themed OG images in the `/public/` directory:
- `og-dashboard.png` — for homepage
- `og-risk-lab.png` — for risk lab
- `og-cemetery.png` — for cemetery
- `og-blacklist.png` — for freeze tracker
- `og-compare.png` — for compare tool

Override per-page in metadata:
```typescript
openGraph: {
  images: [{ url: "https://pharos.watch/og-risk-lab.png", width: 1200, height: 630 }],
},
```

### Option B: Dynamic OG image generation (higher effort)
Use Next.js `opengraph-image.tsx` route convention to generate dynamic images
at build time. This can embed the coin logo, name, and grade for detail pages.

Note: with `output: "export"`, you'd need to pre-render these as static PNG files
during the build step (e.g., via a build script using Playwright or satori).

---

## 7. Dynamic-Import Chart Components (Performance)

**Problem:** Recharts (~600KB) is imported synchronously in 13+ client components.
Every page that loads any chart pays the full Recharts bundle cost upfront, even
if the chart is below the fold.

**Fix:** Wrap chart components in `next/dynamic`:

```typescript
// Example: src/app/stability-index/page.tsx
import dynamic from "next/dynamic";

const StabilityIndexClient = dynamic(() => import("./client"), {
  ssr: false,
  loading: () => (
    <div className="space-y-6">
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-[350px] w-full rounded-xl" />
    </div>
  ),
});
```

Apply this pattern to the heaviest chart pages:
- `stability-index/client` (PSI history chart)
- `compare/client` (comparison charts)
- `stablecoin/[id]/client` (detail charts)
- `homepage-client` (multiple charts)

Note: these pages already use `<Suspense>` with fallbacks, so the loading states
are already defined. The dynamic import just defers the JS bundle load.

---

## 8. Use Realistic `lastModified` Timestamps in Sitemap

**Problem:** All 230 sitemap URLs share the same `lastModified` timestamp (the build
time). This tells Google nothing about actual content freshness. Google may deprioritize
re-crawling pages it thinks haven't changed.

**File:** `src/app/sitemap.ts`

**Fix:** Use differentiated timestamps based on content type:

```typescript
// For static pages that change infrequently:
{
  url: "https://pharos.watch/about/",
  lastModified: new Date("2026-02-01"), // actual last edit date
  changeFrequency: "monthly",
  priority: 0.5,
},

// For data pages, use the build timestamp (current behavior is OK here):
{
  url: "https://pharos.watch/",
  lastModified: new Date(), // genuinely updates every build
  changeFrequency: "hourly",
  priority: 1.0,
},
```

Even better: import a build timestamp constant from a generated file that CI updates
on each deploy, so `lastModified` reflects actual deploy times rather than being
regenerated on every static build invocation.

---

## Summary Table

| # | Issue | Effort | Target Keywords |
|---|-------|--------|-----------------|
| 1 | Per-peg-currency landing pages | 1-2 days | "gold stablecoin", "euro stablecoin", "{peg} stablecoin" |
| 2 | Per-chain landing pages | 1-2 days | "stablecoins on {chain}", "{chain} stablecoin TVL" |
| 3 | Individual digest pages | 1 day | "stablecoin market recap", "stablecoin daily update" |
| 4 | FAQ schema on more pages | 2-3 hrs | "People Also Ask" features |
| 5 | WebApplication schema | 30 min | Application-related SERPs |
| 6 | Per-page OG images | 2-4 hrs (static) | Social CTR improvement |
| 7 | Dynamic-import charts | 2-3 hrs | LCP / page speed improvement |
| 8 | Realistic sitemap timestamps | 1 hr | Crawl budget efficiency |
