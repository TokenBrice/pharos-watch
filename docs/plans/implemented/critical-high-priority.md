# SEO Recommendations: Critical & High Priority

> Issues that block indexation or significantly degrade ranking potential.
> Estimated timeline: complete within 1-2 weeks.

---

## 1. Submit to Google Search Console (CRITICAL)

**Problem:** `site:pharos.watch` returns zero results. The site is not indexed at all.
The technical SEO (robots.txt, meta robots, sitemap) is all correct — Google simply
hasn't discovered the site.

**Fix (manual, not code):**
1. Go to https://search.google.com/search-console
2. Add property → URL prefix → `https://pharos.watch`
3. Verify via DNS TXT record (preferred for Cloudflare) or HTML file upload
4. Submit sitemap: `https://pharos.watch/sitemap.xml`
5. Use "URL Inspection" to request indexing for the top 10 pages manually:
   - `/`
   - `/risk-lab/`
   - `/liquidity/`
   - `/blacklist/`
   - `/stability-index/`
   - `/cemetery/`
   - `/compare/`
   - `/digest/`
   - `/about/`
   - `/stablecoin/1/` (USDT as representative coin page)
6. Repeat for Bing: https://www.bing.com/webmasters

**Expected impact:** Unlocks all organic search traffic. Nothing else matters until this is done.

---

## 2. Add `/stability-index/` to Sitemap (HIGH)

**Problem:** The stability index page exists and is linked from navigation, but is
missing from `sitemap.xml`. This means Google's sitemap-based discovery skips it entirely.

**File:** `src/app/sitemap.ts`

**Fix:** Add the missing entry after the risk-lab entry (line 49):

```typescript
    {
      url: "https://pharos.watch/stability-index/",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
```

The full `staticPages` array should include 9 entries after the fix.

---

## 3. Add "stablecoin" Keyword to Homepage Title (HIGH)

**Problem:** The default title is `"Shining a Light on Every Peg | Pharos"` — poetic
but contains zero search keywords. No one searches for "shining a light on every peg."
The word "stablecoin" doesn't appear in the homepage `<title>` at all.

**File:** `src/app/layout.tsx:37-40`

**Current:**
```typescript
title: {
  template: "%s | Pharos",
  default: "Shining a Light on Every Peg | Pharos",
},
```

**Recommended fix:**
```typescript
title: {
  template: "%s | Pharos",
  default: "Stablecoin Analytics Dashboard | Pharos",
},
```

Also update the matching OG title on line 57:
```typescript
title: "Stablecoin Analytics Dashboard | Pharos",
```

**Alternatives** (pick one):
- `"Stablecoin Tracker — Market Data & Peg Analytics | Pharos"` (55 chars, keyword-dense)
- `"Stablecoin Dashboard — Peg Tracking & Risk Analysis | Pharos"` (58 chars)

The tagline "Shining a Light on Every Peg" can live in the meta description or as
a subtitle on the page itself — it just shouldn't consume the `<title>` tag.

---

## 4. Add "stablecoin" Keyword to Coin Detail Page Titles (HIGH)

**Problem:** 222 coin detail pages have titles like `"USDC (USDC) | Pharos"`. These
titles contain no keyword context. Someone searching "USDC stablecoin analytics" won't
see any relevance signal in the title.

**File:** `src/app/stablecoin/[id]/page.tsx:39`

**Current:**
```typescript
title: `${coin.name} (${coin.symbol})`,
```

**Recommended fix:**
```typescript
title: `${coin.name} (${coin.symbol}) — Stablecoin Analytics`,
```

This produces titles like:
- `"Tether (USDT) — Stablecoin Analytics | Pharos"` (49 chars)
- `"USD Coin (USDC) — Stablecoin Analytics | Pharos"` (50 chars)
- `"Dai (DAI) — Stablecoin Analytics | Pharos"` (44 chars)

Also update the matching OG title on line 45:
```typescript
title: `${coin.name} (${coin.symbol}) — Stablecoin Analytics`,
```

---

## 5. Shorten Risk Lab Title (HIGH)

**Problem:** `"Risk Lab — Stablecoin Safety Grades & Contagion Simulation | Pharos"`
is 76 characters — Google truncates at ~60. The important words get cut off.

**File:** `src/app/risk-lab/page.tsx:11,17`

**Current:**
```typescript
title: "Risk Lab — Stablecoin Safety Grades & Contagion Simulation",
```

**Recommended fix:**
```typescript
title: "Risk Lab — Stablecoin Safety Grades",
```

Produces: `"Risk Lab — Stablecoin Safety Grades | Pharos"` (53 chars).

The contagion simulation is still described in the meta description (line 8), which
has room for it.

---

## 6. Add Introductory Text to Thin Content Pages (HIGH)

**Problem:** Five data-heavy pages have fewer than 50 words of crawlable static text.
Google sees a heading, a one-liner subtitle, and then a wall of client-rendered
charts/tables that are invisible to crawlers on first pass. These pages risk being
classified as thin content.

### 6a. Stability Index — `src/app/stability-index/page.tsx:32-34`

**Current:**
```tsx
<h1 ...>Pharos Stability Index</h1>
<p className="text-sm text-muted-foreground">
  Historical stablecoin market health scores, component breakdowns, and condition band analysis.
</p>
```

**Add after the `<p>` (inside the same `<div className="space-y-2">`)**:
```tsx
<p className="text-sm text-muted-foreground max-w-2xl">
  The Pharos Stability Index (PSI) is a composite 0–100 score measuring overall
  stablecoin ecosystem health. It combines weighted peg deviation, market cap
  concentration, and depeg event frequency into a single daily reading. Condition
  bands — green, yellow, and red — flag when the market shifts from calm to stressed.
</p>
```

### 6b. Risk Lab — `src/app/risk-lab/page.tsx:34-36`

**Current:**
```tsx
<h1 ...>Risk Lab</h1>
<p className="text-sm text-muted-foreground">
  Safety grades and contagion simulation for every tracked stablecoin.
</p>
```

**Add after the `<p>`:**
```tsx
<p className="text-sm text-muted-foreground max-w-2xl">
  Every tracked stablecoin receives a letter grade (A+ through F) computed from five
  risk dimensions: peg stability, liquidity, resilience, decentralization, and
  dependency risk. The contagion simulator models cascading failures — pick a
  stablecoin to collapse and see which others are affected through shared collateral
  and protocol dependencies.
</p>
```

### 6c. Liquidity — `src/app/liquidity/page.tsx:34-37`

**Current:**
```tsx
<h1 ...>DEX Liquidity</h1>
<p className="text-sm text-muted-foreground">
  Liquidity scores, pool depth, and protocol breakdowns for {TRACKED_STABLECOINS.length} stablecoins
  across decentralized exchanges.
</p>
```

**Add after the `<p>`:**
```tsx
<p className="text-sm text-muted-foreground max-w-2xl">
  Each stablecoin is assigned a 0–100 liquidity score based on available DEX pool
  depth, trading volume, and protocol diversity across Curve, Uniswap, Fluid, and
  other decentralized exchanges. Higher scores indicate deeper markets and tighter
  spreads — critical for large trades without slippage.
</p>
```

### 6d. Blacklist — `src/app/blacklist/page.tsx`

The blacklist page renders its subtitle from the client component. But the layout
file (`src/app/blacklist/layout.tsx`) wraps it and can hold static text.

**File:** `src/app/blacklist/layout.tsx:25-28`

**Current:**
```tsx
<>
  <BreadcrumbJsonLd name="Freeze & Blacklist Tracker" path="/blacklist/" />
  {children}
</>
```

This one is trickier since the actual heading/subtitle lives in the client page.tsx.
Add a `<noscript>` or visually-hidden SEO text block inside the layout:

```tsx
<>
  <BreadcrumbJsonLd name="Freeze & Blacklist Tracker" path="/blacklist/" />
  <p className="sr-only">
    Monitor real-time freeze and blacklist events for USDC, USDT, EURC, PAXG, and
    XAUT across Ethereum, Tron, and L2 chains. Centralized stablecoin issuers can
    freeze addresses at will — this tracker documents every on-chain event as it happens.
  </p>
  {children}
</>
```

### 6e. Digest — `src/app/digest/page.tsx:32-34`

**Current:**
```tsx
<h1 ...>Daily Digest Archive</h1>
<p className="text-sm text-muted-foreground">
  Every daily recap, newest first.
</p>
```

**Add after the `<p>`:**
```tsx
<p className="text-sm text-muted-foreground max-w-2xl">
  Each day Pharos generates a market recap covering notable peg deviations, supply
  movements, and emerging trends across tracked stablecoins. Browse the full archive
  to spot patterns and track how the stablecoin ecosystem evolves over time.
</p>
```

---

## 7. Add Privacy Policy & Legal Disclaimers (HIGH)

**Problem:** Pharos is a financial data platform (YMYL category) running Google
Analytics without a privacy policy or cookie consent. Missing legal pages are a
significant E-E-A-T negative for YMYL sites. Google's quality raters explicitly check
for these.

**Fix — three additions:**

### 7a. Privacy policy page

Create `src/app/privacy/page.tsx` covering:
- What data GA4 collects (anonymized analytics, no PII)
- No user accounts, no wallet connections, no personal data stored
- Cloudflare's automatic analytics
- Data retention policy
- Contact information

Add to sitemap.ts with `priority: 0.3, changeFrequency: "yearly"`.

### 7b. Financial disclaimer in footer

Add a one-liner to the footer component:
```
Pharos provides data and analytics only — not financial advice. Always do your own research.
```

### 7c. Add to About page

Add a short "Disclaimer" section at the bottom of the about page stating Pharos is
informational only, not a licensed financial advisor, and data is provided as-is.

---

## 8. Build Initial Backlink Profile (HIGH)

**Problem:** Zero external sites reference pharos.watch. Even with perfect on-page SEO,
Google won't rank a domain with no authority signals. This is especially true for YMYL
content.

**Fix (manual outreach, not code):**

### Quick wins (week 1):
- Submit to crypto tool aggregators (DeFi Pulse, DappRadar tool lists, Allium's
  analytics directory)
- Add to GitHub awesome-lists (awesome-defi, awesome-stablecoins)
- Post the Cemetery data on crypto Twitter — it's unique content no one else has
- Share Stability Index methodology on DeFi-focused forums (Governance forums, etc.)

### Ongoing (month 1-3):
- Pitch "Dead Stablecoins" data to crypto media (The Block, DL News, CoinDesk) —
  this is genuinely unique editorial content
- Write guest analysis posts using Pharos data on DeFi publications
- Announce Risk Lab / contagion simulator as a press release — novel tool
- Engage with projects whose stablecoins Pharos tracks (they may link back)
- Cross-promote via TokenBrice's existing audience and credibility

---

## Summary Table

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 1 | Google Search Console submission | Manual (no code) | 30 min |
| 2 | Add `/stability-index/` to sitemap | `src/app/sitemap.ts` | 5 min |
| 3 | Homepage title keyword | `src/app/layout.tsx` | 5 min |
| 4 | Coin detail title keyword | `src/app/stablecoin/[id]/page.tsx` | 5 min |
| 5 | Shorten Risk Lab title | `src/app/risk-lab/page.tsx` | 5 min |
| 6 | Intro text on 5 thin pages | 5 page files | 1-2 hrs |
| 7 | Privacy policy + disclaimers | New page + footer + about | 2-3 hrs |
| 8 | Backlink outreach | Manual (no code) | Ongoing |
