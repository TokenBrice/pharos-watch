# SEO Recommendations: Low Priority

> Polish, best practices, and future considerations.
> Tackle these after critical/high/medium items are shipping and indexed.

---

## 1. Add `loading="lazy"` to Below-the-Fold Coin Logos

**Problem:** Coin logos in table rows, related stablecoins grids, and cemetery cards
all load eagerly. On the homepage with 143 stablecoins, this means 143 image requests
fire on initial page load, most for rows far below the viewport.

**File:** `src/components/stablecoin-logo.tsx`

**Current:**
```tsx
<Image
  src={src}
  alt={`${name} logo`}
  width={size}
  height={size}
  className="rounded-full flex-shrink-0"
  unoptimized
/>
```

**Fix:** Add the `loading` prop:
```tsx
<Image
  src={src}
  alt={`${name} logo`}
  width={size}
  height={size}
  className="rounded-full flex-shrink-0"
  unoptimized
  loading="lazy"
/>
```

**Exception:** The homepage Pharos icon (`src/app/page.tsx:37`) and header logo
(`src/components/header.tsx:27`) already use `priority` — leave those as eager.

**Impact:** Reduces initial network waterfall; marginal LCP improvement on data-heavy
pages.

---

## 2. Add `Article` Schema to Digest Entries

**Problem:** Daily digest entries are editorial content with dates, headlines, and
authored text — but lack `Article` schema. Even without individual digest URLs (medium
priority item #3), adding Article schema to the archive page gives Google structured
signals about the content type.

**Where:** If individual digest pages exist (`/digest/{date}/`), add per-page:

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "[Digest headline]",
  "datePublished": "[ISO date]",
  "author": {
    "@type": "Organization",
    "name": "Pharos",
    "url": "https://pharos.watch"
  },
  "publisher": {
    "@type": "Organization",
    "name": "Pharos",
    "url": "https://pharos.watch",
    "logo": {
      "@type": "ImageObject",
      "url": "https://pharos.watch/pharos-icon.png"
    }
  },
  "mainEntityOfPage": "https://pharos.watch/digest/[date]/"
}
```

If digest pages don't exist yet, this is blocked by medium priority item #3.

---

## 3. Set Up Web Vitals Monitoring

**Problem:** No explicit Core Web Vitals tracking exists. GA4 provides some passive
CWV data, but there's no dedicated RUM (Real User Monitoring) pipeline to catch
regressions.

**Fix options:**

### Option A: GA4 Web Vitals (minimal)
GA4 already tracks some CWV automatically if the "Enhanced Measurement" setting is
enabled in the GA4 property. Verify this is on in the GA4 admin console.

### Option B: web-vitals library (recommended)
```bash
npm install web-vitals
```

Create `src/lib/web-vitals.ts`:
```typescript
import { onCLS, onINP, onLCP } from "web-vitals";

function sendToAnalytics(metric: { name: string; value: number; id: string }) {
  // Send to GA4 as custom event
  if (typeof gtag === "function") {
    gtag("event", metric.name, {
      value: Math.round(metric.name === "CLS" ? metric.value * 1000 : metric.value),
      event_label: metric.id,
      non_interaction: true,
    });
  }
}

export function reportWebVitals() {
  onCLS(sendToAnalytics);
  onINP(sendToAnalytics);
  onLCP(sendToAnalytics);
}
```

Call `reportWebVitals()` from a client component that loads on every page (e.g.,
the Providers component).

---

## 4. Compress OG Image

**Problem:** `/public/og-card.png` is 179KB — large for a social sharing image that
may be fetched by multiple social platform crawlers on every share.

**Fix:**
- Convert to WebP or optimized PNG (target <50KB)
- Alternatively, keep PNG but run through `pngquant` or `oxipng`:
  ```bash
  oxipng -o max public/og-card.png
  ```
- Update `_headers` cache time from 86400 (1 day) to 604800 (1 week) if the image
  changes infrequently

Also note `_headers` references `/og-image.png` (line 18) but the actual OG file
used in metadata is `/og-card.png`. The cache rule may not be applied to the correct
file. Verify which filename is canonical and update `_headers` accordingly.

---

## 5. Expand Cemetery Title Keywords

**Problem:** `"Stablecoin Cemetery — Failed & Defunct Stablecoins | Pharos"` at 67
characters gets slightly truncated. More importantly, "cemetery" is a brand term
that users don't search for — they search "failed stablecoins" or "dead stablecoins".

**File:** `src/app/cemetery/page.tsx:11`

**Current:**
```typescript
title: "Stablecoin Cemetery — Failed & Defunct Stablecoins",
```

**Alternative (shorter, keyword-optimized):**
```typescript
title: "Dead & Failed Stablecoins — The Cemetery",
```

Produces: `"Dead & Failed Stablecoins — The Cemetery | Pharos"` (53 chars).
Leads with the search keyword ("dead", "failed stablecoins") rather than the brand
term ("cemetery").

---

## 6. Add `HowTo` Schema for Methodology Content

**Problem:** The About page contains detailed methodology explanations for grading,
peg scoring, and liquidity scoring. These could match instructional search queries
like "how to evaluate stablecoin safety" if marked up with `HowTo` schema.

**Where:** `src/app/about/page.tsx`, in the methodology sections.

**Example:**
```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Evaluate Stablecoin Safety",
  "description": "A five-dimension framework for grading stablecoin risk.",
  "step": [
    {
      "@type": "HowToStep",
      "name": "Assess Peg Stability",
      "text": "Measure historical peg deviation using a composite score of mean deviation, max deviation, and time at peg. Weight: 25%."
    },
    {
      "@type": "HowToStep",
      "name": "Evaluate Liquidity",
      "text": "Score available DEX pool depth across Curve, Uniswap, and other decentralized exchanges. Weight: 20%."
    },
    {
      "@type": "HowToStep",
      "name": "Check Resilience",
      "text": "Analyze chain risk, collateral quality, and custody model for underlying asset safety. Weight: 20%."
    },
    {
      "@type": "HowToStep",
      "name": "Measure Decentralization",
      "text": "Classify governance model as CeFi, CeFi-Dependent, or DeFi based on actual infrastructure dependency. Weight: 10%."
    },
    {
      "@type": "HowToStep",
      "name": "Assess Dependency Risk",
      "text": "Map exposure to shared collateral, oracles, and protocol dependencies that could cascade during failures. Weight: 25%."
    }
  ]
}
```

**Impact:** Potential to appear in Google's HowTo rich results for instructional
stablecoin queries.

---

## 7. Improve Chart Accessibility for SEO

**Problem:** Chart containers have generic `aria-label` values like "chart showing N
data points." Search engines that process ARIA attributes get minimal content signal
from these labels.

**Fix:** Make chart aria-labels more descriptive and keyword-rich:

```tsx
// Instead of:
aria-label="PSI component breakdown chart showing 7 data points"

// Use:
aria-label="Pharos Stability Index historical scores from January 2025 to February 2026, showing daily readings between 65 and 95"
```

This doesn't need to be static — the data is available at render time. Build the
label dynamically from the chart data range and key values.

---

## 8. Add `SameAs` Links to Organization Schema

**Problem:** The Organization schema has `sameAs` pointing to X/Twitter and GitHub.
Adding more authoritative same-as references strengthens the knowledge graph entity.

**File:** `src/app/layout.tsx:133-136`

**Current:**
```typescript
sameAs: [
  "https://x.com/PharosWatch",
  "https://github.com/TokenBrice/stablecoin-dashboard",
],
```

**Add any additional official profiles as they're created:**
```typescript
sameAs: [
  "https://x.com/PharosWatch",
  "https://github.com/TokenBrice/stablecoin-dashboard",
  // Add when available:
  // "https://warpcast.com/pharos",
  // "https://www.linkedin.com/company/pharos-watch",
],
```

---

## Summary Table

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 1 | Lazy-load coin logos | 10 min | Marginal LCP improvement |
| 2 | Article schema for digests | 30 min (requires digest pages) | Rich result eligibility |
| 3 | Web Vitals monitoring | 1 hr | Regression detection |
| 4 | Compress OG image | 15 min | Faster social card loading |
| 5 | Cemetery title keywords | 5 min | Better SERP keyword match |
| 6 | HowTo schema on methodology | 30 min | Instructional rich results |
| 7 | Descriptive chart aria-labels | 1-2 hrs | Accessibility + crawlability |
| 8 | Expand Organization sameAs | 5 min | Knowledge graph signals |
