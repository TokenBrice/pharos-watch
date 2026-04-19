# SEO Week 2 — llms.txt + Schema Coverage Expansion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second of three SEO/LLM-indexability deliverables: publish a build-generated `/llms.txt`, promote a real visible H1 on home + detail pages, add structured-data (Article / CollectionPage / FAQPage / HowTo / Person) coverage to pages currently missing it, and close the remaining quick wins (full-date datelines, oversized OG shrink, taxonomy editorial review, HTML Cache-Control).

**Architecture:** Surgical per-page edits on top of existing helpers (`safeJsonLd`, `buildFaqJsonLd`, `FaqSection`, `BreadcrumbJsonLd`, `buildStablecoinUrl`, `SITE_ORIGIN`). One new build script under `scripts/` (pattern copied from `scripts/generate-sitemap-dates.ts`) to emit `public/llms.txt` in the `prebuild` hook. One new exported constant `PHAROS_ORG_NODE` + `PHAROS_PERSON_TOKENBRICE_NODE` in `src/lib/json-ld.ts` for reuse across pages (Article.author, Article.publisher, Organization.founder, WebApplication.creator). No shared abstractions beyond these. Schema is inline `<script type="application/ld+json">` blocks identical in pattern to what already ships on `/methodology` and `/cemetery`.

**Tech Stack:** Next.js 16 static export, TypeScript, Tailwind (static classes only), tsx scripts, Schema.org JSON-LD, Cloudflare Pages `_headers`, pngquant or sharp (external CLI, not a dep) for the one OG shrink.

**Out of this plan (deferred):**
- Week 1 items (shipped separately before this plan starts): soft-404 on unknown `/stablecoin/[id]`, breadcrumb N-level fix, Dataset enrichment, Organization `@id`, AI-robots rules (GPTBot / ClaudeBot / etc.), title fixes, orphan route cleanup.
- Week 3–4 items: markdown content negotiation (`Accept: text/markdown`) and `/docs/*` routes.
- Task 5 from the original scope (dynamic-import `html-to-image`) — **already done** in `src/lib/chart-export.ts:7`; all consumers (`src/components/total-mcap-chart.tsx:8`, `src/components/psi-history-chart.tsx:8`) route through that helper. No work required. Task 5 is retained only as a verification step (confirm no new direct static imports creep in; confirm first-load JS hasn't regressed).

---

## Prerequisites

- [ ] Week 1 plan (2026-04-??-seo-week1-*.md) has merged to main. Specifically, the Week 1 PR is expected to add `@id: ${SITE_URL}#organization` to the `Organization` node in `src/app/layout.tsx:143-156`, which Task 10 of this plan references when building the shared Person and when linking Article.author / Article.publisher back to the Organization.
- [ ] **If Week 1 didn't land the Organization `@id`** — Task 10 below still adds it defensively (one-line additive change in `src/app/layout.tsx`). Do not remove or renumber existing Organization properties; just add `"@id": \`${SITE_URL}#organization\``. If Week 1 already added it, that step is a no-op.
- [ ] `npm install` has run and `npm run build` completes clean on `main` before branching.

---

## File Structure

Changes span 3 categories: build-time generation, schema additions, and small header/image fixes. No new shared abstractions beyond the two Person/Org JSON-LD node constants in `src/lib/json-ld.ts`.

**Created:**
- `scripts/generate-llms-txt.ts` — prebuild generator; emits `public/llms.txt`.
- `public/llms.txt` — committed to git (mirrors how `src/generated/sitemap-dates.json` is committed via `scripts/generate-sitemap-dates.ts`, though note: this is in `public/` not `src/generated/` because llms.txt must live at site root). **Decision:** generate and commit so the file is present in static export without the prebuild needing to succeed on every pull — matches existing convention used by the `_redirects` generator (`scripts/generate-redirects.ts`).

**Modified (schema / H1 / dateline):**
- `src/app/page.tsx` — promote H1; ItemList wrap; add `image` to ListItems; rename ItemList title.
- `src/app/stablecoin/[id]/page.tsx:116-118` — remove sr-only H1 (hero becomes the real H1; see `src/components/stablecoin-detail/hero-card.tsx:668,769`).
- `src/components/stablecoin-detail/hero-card.tsx` — change two `<h2>` → `<h1>` (mobile layout line 668; desktop layout line 769).
- `src/components/pre-launch-detail.tsx` — delete sr-only H1 (lines 282-284); change `<h2>` at line 315 → `<h1>` with classes preserved (pinned option A, 2026-04-19).
- `src/app/methodology/page.tsx` — add TechArticle alongside existing FAQPage.
- `src/components/methodology-changelog-page.tsx` — add TechArticle JSON-LD driven by `entries[0].date` / `effectiveAt`.
- `src/app/changelog/page.tsx` — add ItemList of Article, datePublished per entry.
- `src/app/digest/page.tsx` — add ItemList + CollectionPage JSON-LD.
- `src/app/cemetery/page.tsx:50-63` — add `url`; wrap list in CollectionPage.
- `src/app/upcoming/page.tsx` — add ItemList + CollectionPage JSON-LD.
- `src/components/stablecoin-taxonomy-shell.tsx:46-63` — wrap ItemList in CollectionPage + `about: DefinedTerm`.
- `src/app/about/api/page.tsx:249-262` — add FAQPage alongside existing BreadcrumbList.
- `src/app/telegram/page.tsx` — add FAQPage + HowTo; reuse shared Person.
- `src/components/ai-summary.tsx:11-23` — full ISO date + `<time dateTime>` wrapper.
- `src/components/funding/funding-page-sections.tsx:143-146` — same dateline treatment (flagged for review only; confirm before editing).
- `src/app/layout.tsx:143-175` — add Organization `@id` (if not present from Week 1), reference shared Person constant.
- `src/lib/json-ld.ts` — export `PHAROS_ORG_NODE` and `PHAROS_PERSON_TOKENBRICE_NODE` constants.
- `src/app/robots.ts` — add `llms.txt` reference as a second directive (decision: include `Allow: /llms.txt` explicitly; the llms.txt spec says nothing about robots, but being explicit costs nothing). Actually **do not add** — the default `Allow: /` already covers it; leave robots.ts alone.
- `public/_headers` — add `Cache-Control: public, max-age=3600` for `/llms.txt`; add HTML routes `Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400`.
- `package.json:16` — extend the `prebuild` script to call the new llms.txt generator.
- `public/og-start.png` — shrunk in place (not a code change; binary swap).

---

## Task Breakdown

Each task below has: Goal, Files touched, Implementation notes, Verification, Risk flags, Effort (S=<2h / M=2–6h / L=>6h).

---

### Task 1: Ship `public/llms.txt` via prebuild generator

**Goal:** Produce a valid llmstxt.org-spec file at `public/llms.txt` generated from `ACTIVE_STABLECOINS` and a small hand-curated top-level menu, wired into `prebuild` alongside the existing `generate-sitemap-dates.ts` / `generate-redirects.ts`.

**Files:**
- Create: `scripts/generate-llms-txt.ts`
- Modify: `package.json:16` (prebuild)
- Modify: `public/_headers` (append `/llms.txt` Cache-Control stanza)
- Create: `public/llms.txt` (generator output, committed)

- [ ] **Step 1: Draft `scripts/generate-llms-txt.ts`**

Copy `scripts/generate-sitemap-dates.ts` as a starting point. The generator reads:
- `shared/lib/stablecoins` → `ACTIVE_STABLECOINS` (name, symbol, id). Resolve via relative path from the script (use `../shared/lib/stablecoins`).
- `shared/lib/runtime-origins` → `SITE_ORIGIN`.

Output structure (llmstxt.org spec: H1, blockquote summary, H2 sections with `- [Title](url): description` bullets):

```markdown
# Pharos

> Pharos tracks {N} stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries. Data refreshes multiple times per day from the Pharos Cloudflare Worker API.

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

- [API Reference](https://pharos.watch/about/api/): Public + ops lanes, auth model, endpoint catalogue.
- [About](https://pharos.watch/about/): Project context and data sources.

## Changelog

- [Weekly Changelog](https://pharos.watch/changelog/): Release notes.
- [Daily Digest Archive](https://pharos.watch/digest/): Daily market recaps.

## Digest

(Auto-generated list of the most recent {K=20} entries from `data/digests.json`, linking to `/digest/{date}/`.)

## Stablecoins Index

(Auto-generated from `ACTIVE_STABLECOINS`, one line per coin:
`- [Name (SYMBOL)](https://pharos.watch/stablecoin/{id}/): {governance} stablecoin {backing-phrase} pegged to {pegLabel}.`

Use the same `GOVERNANCE_METADATA_PHRASES` / `BACKING_METADATA_PHRASES` pattern already present in `src/lib/page-metadata.ts:18-28`, but **redefine inline** in the script — do not import from `src/` because this script must stay build-time-only and cannot pull React. The shared source for peg labels is `@shared/lib/classification`'s `PEG_LABELS_SHORT`; importable from a tsx script since it's pure TS.)
```

**Decisions locked in this step:**
- Do **not** list every methodology sub-page as separate entries beyond the changelog list above — that would duplicate content the methodology hub already indexes.
- Do **not** include comparison pages or taxonomy pages in the stablecoins index (they are category hubs, not the primary data surface; llms.txt should point at the most authoritative entry per topic).
- The `{K}` digest count is 20. More risks bloating the file.

- [ ] **Step 2: Wire into prebuild**

Edit `package.json:16`:

```jsonc
// before
"prebuild": "tsx scripts/generate-redirects.ts && tsx scripts/generate-sitemap-dates.ts",
// after
"prebuild": "tsx scripts/generate-redirects.ts && tsx scripts/generate-sitemap-dates.ts && tsx scripts/generate-llms-txt.ts",
```

- [ ] **Step 3: Add `/llms.txt` cache header**

Edit `public/_headers`. Append at end:

```
/llms.txt
  Cache-Control: public, max-age=3600
  Content-Type: text/plain; charset=utf-8
```

(Cloudflare Pages already sets `text/plain` for .txt by default, but being explicit defends against future default changes.)

- [ ] **Step 4: Run `npm run prebuild` and commit the produced `public/llms.txt`**

Verify:
- File exists at `public/llms.txt` and begins with `# Pharos`.
- Byte count is <100 KB (191 coins × ~150 bytes ≈ 30 KB, total file well under budget).
- All URLs are absolute `https://pharos.watch/...`.
- `curl -I https://pharos.watch/llms.txt` after deploy returns 200 (post-deploy check, not blocking).

**Risks:**
- Upstream tooling discovering `llms.txt` may expect stable content — deterministic generation is important. Sort `ACTIVE_STABLECOINS` by the same order as `TRACKED_STABLECOINS` (already deterministic) or by descending market cap (requires a data fetch, which is out of scope — use the existing deterministic source order).
- Script must not introduce a runtime dep on React / Next. Import only from `shared/lib/*`.

**Effort:** M (2–4h)

---

### Task 2: Promote visible H1 on homepage + detail pages

**Goal:** Replace `<h1 class="sr-only">` with a real visible H1 on detail and home pages without breaking a11y.

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx:116-118` (remove sr-only H1 block)
- Modify: `src/components/stablecoin-detail/hero-card.tsx:668` (mobile `<h2>` → `<h1>`)
- Modify: `src/components/stablecoin-detail/hero-card.tsx:769` (desktop `<h2>` → `<h1>`)
- Modify: `src/components/pre-launch-detail.tsx:282-284` (delete sr-only H1 block)
- Modify: `src/components/pre-launch-detail.tsx:315` (`<h2>` → `<h1>`, classes preserved)
- Modify: `src/components/site-header.tsx:64,86` (`<p>Pharos</p>` → `<h1>Pharos</h1>`, classes preserved)
- Modify: `src/app/page.tsx:44` (remove sr-only H1)

- [ ] **Step 1: Detail page — promote hero name**

The hero renders the coin name twice (one per mobile/desktop layout, Tailwind hides one with `hidden lg:block` / `lg:hidden`). Both exist in the same rendered HTML tree and both currently use `<h2>`. Change both to `<h1>`. The hero already has the richest visible heading text (`{coin.name}`). Remove the sr-only H1 in `src/app/stablecoin/[id]/page.tsx:116-118`.

**Pre-launch path — PINNED option A (2026-04-19):** `src/components/pre-launch-detail.tsx` currently has an sr-only `<h1>` at lines 282-284 and a visible `<h2>{coin.name}</h2>` at line 315. Removing the sr-only H1 in `src/app/stablecoin/[id]/page.tsx:116-118` would leave pre-launch pages with zero H1. Apply the same treatment as the active-coin hero:

- Delete `src/components/pre-launch-detail.tsx:282-284` (the sr-only H1 block)
- Change `src/components/pre-launch-detail.tsx:315` from `<h2 className="break-words text-2xl font-extrabold tracking-tight sm:text-3xl">{coin.name}</h2>` to `<h1 className="break-words text-2xl font-extrabold tracking-tight sm:text-3xl">{coin.name}</h1>` (preserve all Tailwind classes verbatim)

Result: one visible H1 with coin name; consistent with active-coin pattern. "Pre-Launch Stablecoin" keyword remains visible on the page via the existing `<LaunchPhaseBadge>` nearby, so no keyword loss. The considered alternative (option B — append "— Pre-Launch Stablecoin" as visible text in the H1) was rejected as redundant with the phase badge.

- [ ] **Step 2: Homepage — PINNED option 1 (surgical)**

**PINNED 2026-04-19 — user selected option 1.** Do not implement option 2 without explicit re-approval.

`src/components/site-header.tsx` renders "Pharos" as `<p>` (lines 64, 86). Change both to `<h1>`, preserving existing Tailwind classes verbatim. Zero visual change. For reference only, the alternative was:

1. **[PINNED] Lower-risk:** Change line 64 (mobile) and line 86 (desktop) `<p className="... text-foreground">Pharos</p>` to `<h1 className="...">Pharos</h1>`. Matches semantic intent (page-defining heading), visual styling unchanged if Tailwind classes are preserved.
2. **Higher-value:** Add a visually present "Pharos Stablecoin Dashboard" heading above the KPI bar (new markup in `src/app/page.tsx`). Better for SEO (richer keywords) but introduces new UI affordance and needs design review.

**Choose option 1** for a surgical change. Keep existing Tailwind classes verbatim. Remove `src/app/page.tsx:44`'s sr-only H1. One H1 per page (the site header renders once; no risk of duplicates because mobile/desktop versions are Tailwind-hidden siblings — browsers still parse both, which means **both must become H1**, same as the detail-page approach).

**A11y test:** Manually run an axe or Lighthouse a11y pass on `/` and `/stablecoin/usdt-tether/` after change, or run existing design-invariants tests (`src/lib/__tests__/design-invariants.test.ts` is present — confirm it covers heading levels; add a test if not).

- [ ] **Step 3: Verify with a unit test if one doesn't already exist**

Grep for an existing invariant:

```bash
# grep for "h1" in src/lib/__tests__/design-invariants.test.ts
```

If a heading-level test does not exist, add one:

```ts
// src/lib/__tests__/design-invariants.test.ts (append)
import { render } from "@testing-library/react";
import HomePage from "@/app/page";
// ...
it("home page renders exactly one h1", () => {
  const { container } = render(<HomePage />);
  // Both mobile and desktop SiteHeader render -> two h1s is acceptable for
  // responsive hidden-twin patterns. Assert exactly two h1s matching "Pharos".
  const h1s = container.querySelectorAll("h1");
  expect(h1s.length).toBeGreaterThanOrEqual(1);
  for (const h1 of h1s) expect(h1.textContent).toMatch(/Pharos/);
});
```

(The test tolerates one-or-two because of the hidden-twin layout. If axe / Lighthouse later flags two H1s as problematic, wrap one in `aria-hidden="true"` — the browser parses both but screen readers ignore the hidden one.)

- [ ] **Step 4: Run `npm test` and `npm run build`**

Expected: all green. Build output contains one or two `<h1>` tags per indexed page.

**Risks:**
- **Duplicate H1 from hidden responsive twins** is the only real concern. Rich Results Test and most LLM crawlers treat the first H1 as definitive; multiple H1s are allowed in HTML5 but some SEO tools flag them. Accept the tradeoff (existing responsive-twin pattern is not worth rewriting) and document in the commit.

**Effort:** M (2–3h)

---

### Task 3: Full ISO date + `<time dateTime>` on ai-summary (and funding cost card)

**Goal:** Emit machine-readable dates on all visible "as-of" timestamps that crawlers index.

**Files:**
- Modify: `src/components/ai-summary.tsx:11-23`
- Modify: `src/components/funding/funding-page-sections.tsx:143-146` (flagged for review)

- [ ] **Step 1: Update `ai-summary.tsx`**

Replace lines 11-14 with a full ISO date in `dateTime` and a human-readable full date in visible text:

```tsx
// before
const dateline = new Date(updatedAt + "T00:00:00").toLocaleString("en-US", {
  month: "short",
  year: "numeric",
});
// after
const isoDate = updatedAt; // assume YYYY-MM-DD input format; no timezone info needed
const dateline = new Date(updatedAt + "T00:00:00Z").toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
```

And in the return block, wrap the dateline in `<time>`:

```tsx
<time className="text-xs text-muted-foreground whitespace-nowrap" dateTime={isoDate}>
  Updated {dateline}
</time>
```

Replacing the existing `<span>`. Preserve all other styling.

- [ ] **Step 2: Grep for sibling formatters**

Run the exact search that was run during planning:

```
month: "short", year: "numeric"  (multiline)
```

Only two hits: `src/components/ai-summary.tsx` (handled above) and `src/components/funding/funding-page-sections.tsx:143-146` ("Reviewed" date on cost card).

- [ ] **Step 3: Decide on funding page**

The funding "Reviewed Mar 2026"-style dateline is a visible UI element that crawlers will index. Apply the same treatment: change to a `<time dateTime="YYYY-MM">` wrapper with a full-date visible label. `lastReviewedAt` in that component is already a unix timestamp, so `new Date(lastReviewedAt * 1000).toISOString().slice(0, 10)` gives the `YYYY-MM-DD` for the `dateTime` attr.

**Skip if ambiguous.** This is a judgment call — if the surrounding UI has a "reviewed this month" meaning (vs. specific day), month+year precision is fine and should still be machine-readable: `dateTime="2026-03"` is valid ISO.

- [ ] **Step 4: Verify**

```bash
npm run lint
npm test
```

Grep the built output for `<time dateTime=`:

```bash
npm run build && grep -c "<time dateTime" out/stablecoin/*/index.html | head
```

Expect at least one match per stablecoin detail page (the AI summary is rendered via `overview-section.tsx`). If zero, the dateline didn't make it into the static export — investigate Suspense boundaries.

**Effort:** S (<1h)

---

### Task 4: Shrink `og-start.png` from 554 KB to <200 KB

**Goal:** Match the size budget of other OG images; improve first-meaningful-paint on `/start/` and reduce crawler bandwidth.

**Files:**
- Modify (binary): `public/og-start.png`

- [ ] **Step 1: Audit current OG image sizes (already done in planning)**

Confirmed during planning:
- `og-start.png`: 554 KB (over budget)
- All other 19 `og-*.png` files: 60–198 KB (within budget; none >300 KB).

Only one asset needs shrinking. No audit expansion required.

- [ ] **Step 2: Choose tooling**

Three options, in preference order:
1. `pngquant --quality=70-90 --output public/og-start.png.new public/og-start.png` (uses existing system tool; already available on Arch based on repo conventions).
2. `sharp` via a one-off tsx script (adds a devDep — avoid unless #1 unavailable).
3. Manual re-export from design source (slowest, highest quality).

- [ ] **Step 3: Shrink in place and verify**

```bash
pngquant --quality=70-90 --force --output /tmp/og-start.png /home/ahirice/Documents/git/stablecoin-dashboard/public/og-start.png
ls -la /tmp/og-start.png
# If <200KB and visually acceptable, swap:
cp /tmp/og-start.png /home/ahirice/Documents/git/stablecoin-dashboard/public/og-start.png
```

- [ ] **Step 4: Visual diff**

Open side-by-side preview (any image viewer) to confirm quality is preserved at OG-card scale (Twitter/X / Open Graph viewers render the image at ≤1200×628 CSS pixels — lossy quantization is invisible at that size).

- [ ] **Step 5: Confirm build still finds it**

```bash
npm run build
ls -la out/og-start.png
```

Should be ≤200 KB. Cache headers in `public/_headers` already cover `/og-image.png`; `og-start.png` inherits the default CSP-allowed caching.

**Risks:**
- Gradient banding in OG images can become visible after quantization. Mitigation: try `--quality=80-95` first; fall back to 70-90 only if the 80-95 output still exceeds budget.

**Effort:** S (<1h)

---

### Task 5: Verify `html-to-image` dynamic import (already done)

**Goal:** Confirm the dependency is still dynamically imported and first-load JS hasn't regressed; add a lint-level guard if practical.

**Files:**
- Verify: `src/lib/chart-export.ts:7`
- Verify: `src/components/total-mcap-chart.tsx:8`, `src/components/psi-history-chart.tsx:8`
- No code change expected.

- [ ] **Step 1: Confirm status**

Grep done during planning:

```
html-to-image
```

Single hit in `src/lib/chart-export.ts:7` as `await import("html-to-image")`. Both consumer components import only from `@/lib/chart-export`, never directly from `html-to-image`.

- [ ] **Step 2: Optional guard**

Add a micro-test or ESLint `no-restricted-imports` rule blocking direct `html-to-image` imports outside `src/lib/chart-export.ts`:

```jsonc
// eslint.config.ts (if the repo has ESLint flat config) — append
{
  files: ["src/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [{ name: "html-to-image", message: "Import from @/lib/chart-export instead to keep the module dynamic." }],
    }],
  },
}
```

**Decision:** skip the ESLint rule unless the repo's `eslint.config` already uses `no-restricted-imports`. Adding new lint rules is out of the surgical scope. Rely on code review.

- [ ] **Step 3: Build + bundle-size check**

```bash
npm run build
# Capture first-load JS for a reference route:
grep -E "First Load JS|\\/(page|stablecoin|methodology)/" .next/build-manifest.json | head -30 || true
```

More concretely, `next build` prints a table of route sizes. Compare against a pre-change baseline if one exists; otherwise, record this run's numbers as the baseline.

**Effort:** S (<1h)

---

### Task 6: Add `TechArticle` schema to methodology + changelog pages

**Goal:** Every long-form editorial methodology page emits Article/TechArticle JSON-LD so LLM summarisers can attribute, date, and compare versions.

**Files:**
- Modify: `src/app/methodology/page.tsx` (add TechArticle alongside existing FAQPage)
- Modify: `src/components/methodology-changelog-page.tsx` (emit TechArticle JSON-LD using `entries[0]` for latest `datePublished` / `dateModified`)
- Modify: `src/app/changelog/page.tsx` (emit ItemList of Article)
- Modify: `src/app/digest/page.tsx` (add CollectionPage — handled in Task 7)

- [ ] **Step 1: Methodology hub**

In `src/app/methodology/page.tsx`, after the existing FAQPage script block (line 43-65), insert a second `<script type="application/ld+json">` with:

```ts
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline: "Methodology: How Pharos Grades Stablecoins",
  description: "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests.",
  // datePublished: SAFETY_SCORE_CHANGELOG oldest entry date (or a curated constant — TokenBrice-authored methodology v1.0 date)
  datePublished: "2025-10-01", // PLACEHOLDER — resolve: check `SAFETY_SCORE_CHANGELOG.at(-1)?.date` at build time
  dateModified: SAFETY_SCORE_CHANGELOG[0].date,
  author: { "@id": `${SITE_URL}#person-tokenbrice` },
  publisher: { "@id": `${SITE_URL}#organization` },
  image: `${SITE_URL}/og-methodology.png`,
  mainEntityOfPage: `${SITE_URL}/methodology/`,
  keywords: ["stablecoin methodology", "safety score", "PegScore", "DEWS", "PSI", "liquidity score"],
}
```

**Resolve the `datePublished`:** grep `SAFETY_SCORE_CHANGELOG` for the oldest entry (`safety-score-version-data.ts` has v1.0 at the tail of the array). Wire `datePublished: SAFETY_SCORE_CHANGELOG.at(-1)!.date`.

- [ ] **Step 2: Shared methodology changelog pages**

Edit `src/components/methodology-changelog-page.tsx`. After the `BreadcrumbJsonLd` at line 48, add a new JSON-LD block using `entries[0]` / `entries.at(-1)`:

```tsx
{entries.length > 0 && (
  <script
    type="application/ld+json"
    dangerouslySetInnerHTML={{
      __html: safeJsonLd({
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: `${title} — Version History`,
        description: typeof lead === "string" ? lead : `Version history for ${title}.`,
        datePublished: entries.at(-1)!.date,
        dateModified: entries[0].date,
        author: { "@id": `${SITE_URL}#person-tokenbrice` },
        publisher: { "@id": `${SITE_URL}#organization` },
        image: `${SITE_URL}/og-card.png`,
        mainEntityOfPage: `${SITE_URL}${path}`,
      }),
    }}
  />
)}
```

Add imports:
```tsx
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

**Note:** `lead` is `ReactNode`, not always string. If not string, fall back to `${breadcrumbName} version history for Pharos.`.

This one edit covers all 9 changelog subpages (`pricing-pipeline`, `scoring`, `liquidity-score`, `stability-index`, `chain-health`, `depeg`, `yield`, `blacklist-tracker`, `mint-burn-flow`).

- [ ] **Step 3: Weekly changelog index**

Edit `src/app/changelog/page.tsx`. Before line 23's `FeaturePageShell`, add:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: safeJsonLd({
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
          headline: entry.headline ?? `Changelog — Week of ${entry.dateRange.to}`,
          datePublished: new Date(entry.dateRange.to + "T00:00:00Z").toISOString(),
          description: entry.summary.map((s) => s.label).slice(0, 3).join("; "),
          author: { "@id": `${SITE_URL}#person-tokenbrice` },
          publisher: { "@id": `${SITE_URL}#organization` },
          url: `${SITE_URL}/changelog/#week-${entry.dateRange.to}`,
        },
      })),
    }),
  }}
/>
```

(The per-week anchor `#week-...` is cosmetic; the changelog index does not have per-week subroutes today. Using a fragment URL is standards-valid for ListItem.item.url.)

Add imports to `src/app/changelog/page.tsx`:
```tsx
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

- [ ] **Step 4: Verify schema**

```bash
npm run build
# Open each output:
cat out/methodology/index.html | grep -o '"@type":"[^"]*"' | sort -u
cat out/methodology/scoring-changelog/index.html | grep -o '"@type":"[^"]*"' | sort -u
cat out/changelog/index.html | grep -o '"@type":"[^"]*"' | sort -u
```

Expected `@type` set per page:
- `/methodology/`: BreadcrumbList, FAQPage, TechArticle, Question, Answer.
- `/methodology/*-changelog/`: BreadcrumbList, TechArticle.
- `/changelog/`: ItemList, Article (×N), BreadcrumbList.

Spot-check one page in Google Rich Results Test after staging deploy.

**Risks:**
- Schema.org wants `Article.datePublished` to be ISO 8601. Both sources (`entry.date` = `YYYY-MM-DD` string, and `dateRange.to` = `YYYY-MM-DD`) are already ISO-prefixes; keep as `YYYY-MM-DD` for `TechArticle`, expand to `YYYY-MM-DDT00:00:00Z` for `Article` if Rich Results flags validation. Test both forms.
- The methodology hub `datePublished` resolution relies on `SAFETY_SCORE_CHANGELOG.at(-1)` being the oldest (ascending vs. descending order in the source). Check ordering before committing — the observed pattern is **newest-first** (v7.07, v7.06, v7.05...) so `entries.at(-1)` = oldest = v1.0-era date.

**Effort:** M (3–4h)

---

### Task 7: `CollectionPage` + `ItemList` wrappers on list pages

**Goal:** List pages emit CollectionPage + ItemList pair; each ListItem gets a `url` (and `image` where applicable).

**Files:**
- Modify: `src/app/page.tsx:33-56` (rename + `image` + CollectionPage wrap)
- Modify: `src/app/cemetery/page.tsx:42-64` (add `url`, wrap in CollectionPage)
- Modify: `src/app/upcoming/page.tsx` (add ItemList + CollectionPage; currently has none)
- Modify: `src/components/stablecoin-taxonomy-shell.tsx:46-63` (wrap in CollectionPage + `about: DefinedTerm`)

- [ ] **Step 1: Homepage**

Edit `src/app/page.tsx`. Two changes:

1. Rename the ItemList title to match the 20-item truncation:

```ts
// before (line 51)
name: "Top Tracked Stablecoins",
// after
name: "Top 20 Stablecoins by Market Cap",
```

2. Optionally add an `image` per ListItem. Logo URLs live in `src/lib/logos.ts` via `logosById`. Check the format — if logo URLs are paths or full URLs, use the full URL (`${SITE_URL}${logosById[coin.id]}` if path).

3. Wrap the ItemList in a CollectionPage envelope. Replace the current single `{"@type": "ItemList", ...}` block with an array of two nodes (CollectionPage + ItemList):

```ts
safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Pharos — Stablecoin Analytics Dashboard",
    description: `${total} stablecoins tracked by Pharos across every major chain.`,
    url: SITE_URL,
    mainEntity: { "@id": `${SITE_URL}#homepage-itemlist` },
    isPartOf: { "@id": `${SITE_URL}#organization` },
  },
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}#homepage-itemlist`,
    name: "Top 20 Stablecoins by Market Cap",
    description: `Top 20 of ${total} stablecoins tracked by Pharos.`,
    numberOfItems: itemListCount,
    itemListElement: itemListElements.map((item, i) => ({
      ...item,
      image: logosById[ACTIVE_STABLECOINS[i].id] ? `${SITE_URL}${logosById[ACTIVE_STABLECOINS[i].id]}` : undefined,
    })).filter(Boolean),
  },
])
```

(`safeJsonLd` already accepts arrays per its type signature in `src/lib/json-ld.ts:2`.)

- [ ] **Step 2: Cemetery page**

Edit `src/app/cemetery/page.tsx:47-64`. Two changes:

1. Add `url` to each ListItem — Cemetery coins do NOT have detail pages by default; they are in `DEAD_STABLECOINS`. Verify:

```bash
# Check if cemetery coins have detail routes:
ls /home/ahirice/Documents/git/stablecoin-dashboard/src/app/cemetery/[id]/ 2>/dev/null
```

If there's a `/cemetery/[id]/` or `/stablecoin/[id]/` route that matches, use `buildStablecoinUrl(coin.id)` or a cemetery-specific URL. If not, drop the `url` field — Schema.org does not require it on ListItem, and fabricating a URL is worse than omitting.

**Decision point:** grep first; if no detail route exists, leave `url` omitted. The original Week 2 scope says "add `url: buildStablecoinUrl(coin.id)` if coin has a detail page, otherwise external link" — prefer omission over external link because external links would fragment the Schema.org graph and point crawlers off-site.

2. Wrap in CollectionPage (identical pattern to homepage):

```ts
safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Stablecoin Cemetery",
    description: `${DEAD_STABLECOINS.length} defunct stablecoins documented.`,
    url: `${SITE_URL}/cemetery/`,
    mainEntity: { "@id": `${SITE_URL}/cemetery/#itemlist` },
    isPartOf: { "@id": `${SITE_URL}#organization` },
  },
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/cemetery/#itemlist`,
    name: "Stablecoin Cemetery",
    // ... existing fields
  },
])
```

- [ ] **Step 3: Upcoming page**

Edit `src/app/upcoming/page.tsx`. Currently emits zero JSON-LD beyond what `FeaturePageShell` provides. Pre-launch coins have detail pages (`src/app/stablecoin/[id]/page.tsx:100-108` handles them). Add a new JSON-LD block before `<FeaturePageShell>`:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: safeJsonLd([
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "Upcoming Stablecoins",
        description: `${PRE_LAUNCH_STABLECOINS.length} pre-launch stablecoins tracked by Pharos.`,
        url: `${SITE_URL}/upcoming/`,
        mainEntity: { "@id": `${SITE_URL}/upcoming/#itemlist` },
        isPartOf: { "@id": `${SITE_URL}#organization` },
      },
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "@id": `${SITE_URL}/upcoming/#itemlist`,
        name: "Upcoming Stablecoins",
        numberOfItems: PRE_LAUNCH_STABLECOINS.length,
        itemListElement: PRE_LAUNCH_STABLECOINS.map((coin, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: `${coin.name} (${coin.symbol})`,
          url: `${SITE_URL}${buildStablecoinUrl(coin.id)}`,
        })),
      },
    ]),
  }}
/>
```

Add imports:
```tsx
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
```

- [ ] **Step 4: Taxonomy pages**

Edit `src/components/stablecoin-taxonomy-shell.tsx:46-63`. Replace the single ItemList block with:

```tsx
{
  const inferredKind: "governance" | "backing" | "infrastructure" | null = /* derive from href prefix, e.g. "/stablecoins/cefi/" => "governance". Or surface as a prop. */ null;
  // Simpler: add a new optional `aboutTerm?: { name: string; description: string }` prop and thread through from each caller.
  return null;
}
```

**Actually, don't add complexity.** Just emit CollectionPage + ItemList without DefinedTerm, since the taxonomy shell already has a short `description` and `intro` string. Optional `about: DefinedTerm` can come later. Keep this change surgical:

```tsx
safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: `https://pharos.watch${href}`,
    mainEntity: { "@id": `https://pharos.watch${href}#itemlist` },
    isPartOf: { "@id": `https://pharos.watch#organization` },
  },
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `https://pharos.watch${href}#itemlist`,
    name: title,
    description,
    numberOfItems: coins.length,
    itemListElement: coins.map((coin, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: `${coin.name} (${coin.symbol})`,
      url: `https://pharos.watch${buildStablecoinUrl(coin.id)}`,
    })),
  },
])
```

`about: DefinedTerm` is deferred to a later pass when the taxonomy data is formally extended with a glossary-backed term definition — Week 2 ships the CollectionPage wrap only.

- [ ] **Step 5: Verify**

```bash
npm run build
# Spot-check each modified list page:
for p in "" "cemetery/" "upcoming/" "stablecoins/cefi/" "stablecoins/rwa/"; do
  echo "--- $p ---"
  grep -o '"@type":"[^"]*"' "out/${p}index.html" | sort -u
done
```

Each should show `CollectionPage` and `ItemList`.

**Risks:**
- Duplicate `@id` across pages if the "#organization" pattern gets used and Week 1 adds a *different* organization `@id`. Coordinate with Week 1 reviewer.

**Effort:** M (3–5h, most of that is verification and coordinating with Week 1's Organization `@id`)

---

### Task 8: `FAQPage` schema on latent-FAQ pages

**Goal:** Pages with Q/A-shaped content but no FAQPage markup get that markup.

**Files:**
- Modify: `src/app/about/api/page.tsx:249-262` (augment existing BreadcrumbList with FAQPage)
- Modify: `src/app/telegram/page.tsx` (new FAQ section + FAQPage markup)
- Verify: `src/app/start/page.tsx` — **no FAQ**; skip.

- [ ] **Step 1: `/about/api/` page**

The page's "Need A Key" section (lines 327-351) and "Quick Facts" (lines 290-303) are not strict FAQs — they're instructions and reference material. Rather than forcing a shape, extract the content as FAQ items where it reads as Q/A:

```ts
// Add above the return block in src/app/about/api/page.tsx
const ABOUT_API_FAQ: FaqItem[] = [
  {
    question: "How do I get a Pharos API key?",
    answer: "Join the Pharos Telegram channel (https://t.me/pharoswatch) and request one. Include your intended usage: what you are building, which endpoints you plan to call, approximate polling cadence, and expected request volume.",
  },
  {
    question: "Do I need an API key for every endpoint?",
    answer: "No. Health checks, OG images, the feedback endpoint, and the Telegram webhook do not require an X-API-Key. All other protected public routes on https://api.pharos.watch require X-API-Key, and return 401 without it.",
  },
  {
    question: "What is the difference between the public API lane and the website lane?",
    answer: "The public lane is https://api.pharos.watch and is for external integrations. The website lane is same-origin /_site-data/* on pharos.watch, used only by the Pharos web app itself. External consumers should call the public lane directly.",
  },
  {
    question: "How is admin auth handled?",
    answer: "Admin routes live behind Cloudflare Access on ops.pharos.watch and ops-api.pharos.watch. They do not use public API keys; access is granted via the Pharos Cloudflare Access team domain.",
  },
];
```

Wrap in JSON-LD. Replace the existing single `<script type="application/ld+json">` block with an array containing the existing BreadcrumbList AND `buildFaqJsonLd(ABOUT_API_FAQ)`:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: safeJsonLd([
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [ /* unchanged */ ],
      },
      buildFaqJsonLd(ABOUT_API_FAQ),
    ]),
  }}
/>
```

**Decision:** do NOT render the FAQ as visible UI on `/about/api/`. The page already has the information in its existing layout; a second visible FAQ block would duplicate content. JSON-LD only. (Google's Rich Results guidance tolerates FAQ JSON-LD without a 1:1 visible Q/A on technical-reference pages, though policies shift; verify with Rich Results Test after deploy and roll back if a warning appears.)

- [ ] **Step 2: `/telegram/` page**

The telegram page has FAQ-shaped content scattered through feature sections. Options:

1. Pull explanatory paragraphs from the page into a compact `FaqSection` rendered at the bottom, with `includeJsonLd={true}`. Reuses the existing `FaqSection` component. **Preferred.**
2. Emit FAQPage JSON-LD without visible UI (same compromise as `/about/api/` above). **Less preferred** — the telegram page has room for a visible FAQ block.

Go with option 1. Add a `TELEGRAM_FAQ: FaqItem[]` constant with 4–6 items drawn from existing copy:

```ts
const TELEGRAM_FAQ: FaqItem[] = [
  {
    question: "What alerts does Pharos send on Telegram?",
    answer: "DEWS threat-level band crossings, depeg detections and worsening milestones, safety-grade changes, and launch promotions for pre-launch assets when they go live.",
  },
  {
    question: "Can I get alerts for all tracked stablecoins at once?",
    answer: "Yes. Send /subscribe <type> all — for example, /subscribe depeg all — to subscribe to an alert type across every tracked stablecoin.",
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

Render `<FaqSection items={TELEGRAM_FAQ} includeJsonLd />` near the bottom of the page (after the Commands section or before the footer).

- [ ] **Step 3: `/start/` page**

Investigated during planning. The page is a glossary + routing map (definition lists, atlas groups), not latent FAQ. Skip.

- [ ] **Step 4: Verify**

```bash
npm run build
grep -o '"@type":"FAQPage"' out/about/api/index.html out/telegram/index.html
# Expect one match in each.
```

**Effort:** M (2–3h)

---

### Task 9: `HowTo` schema on `/telegram`

**Goal:** The three-step "Getting Started" block becomes a first-class HowTo in schema.

**Files:**
- Modify: `src/app/telegram/page.tsx` (add one JSON-LD block)

- [ ] **Step 1: Identify the three steps**

Already mapped during planning:
- Step 1 (line 367-375): Open @PharosWatchBot and send `/start`.
- Step 2 (line 376-423): Subscribe and tune with commands (multiple sub-commands — represent as a single HowToStep with an itemListElement inside, OR as three sub-steps. Keep simple: one HowToStep with a descriptive text).
- Step 3 (line 424-434): Done — alerts arrive automatically. Use /list to inspect.

- [ ] **Step 2: Add HowTo JSON-LD**

In `src/app/telegram/page.tsx`, add a new `<script type="application/ld+json">` block near the existing JSON-LD (there's already `Organization` + `WebApplication`-ish markup on the page — grep for the existing script tag to find the location):

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
      supply: [],
      tool: [{ "@type": "HowToTool", name: "Telegram" }],
      step: [
        {
          "@type": "HowToStep",
          position: 1,
          name: "Open @PharosWatchBot",
          text: "Open @PharosWatchBot in Telegram and send /start to register your chat.",
          url: "https://t.me/PharosWatchBot",
        },
        {
          "@type": "HowToStep",
          position: 2,
          name: "Subscribe and tune",
          text: "Send /subscribe <alert-types> <targets> to pick what you want. For example: /subscribe dews,depeg USDT,USDC. Use /presets for curated watchlists, /set to tune thresholds, and /mute for quiet hours.",
        },
        {
          "@type": "HowToStep",
          position: 3,
          name: "Review and iterate",
          text: "Alerts now arrive automatically when conditions change. Use /list to inspect subscriptions, /presets to discover watchlists, and /unsubscribe to remove any.",
        },
      ],
    }),
  }}
/>
```

- [ ] **Step 3: Verify**

```bash
npm run build
grep -o '"@type":"HowTo"' out/telegram/index.html
# Expect 1.
```

**Effort:** S (<1h)

---

### Task 10: Shared Person + Organization constants

**Goal:** One canonical Person (TokenBrice) and Organization (Pharos) node referenced by `@id` from Article.author, WebApplication.creator, and Organization.founder. Single source of truth in `src/lib/json-ld.ts`.

**Files:**
- Modify: `src/lib/json-ld.ts` (export `PHAROS_ORG_NODE` and `PHAROS_PERSON_TOKENBRICE_NODE`)
- Modify: `src/app/layout.tsx:130-177` (reference the constants; add `@id` to Org if Week 1 didn't)
- Optional follow-up (not in this task): wire up Article.author in Tasks 6 to reference `{"@id": "${SITE_URL}#person-tokenbrice"}` instead of duplicating the Person object inline — already accounted for in Task 6's schema templates.

- [ ] **Step 1: Extend `src/lib/json-ld.ts`**

Append to the existing file:

```ts
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const PHAROS_PERSON_TOKENBRICE_NODE = {
  "@type": "Person",
  "@id": `${SITE_URL}#person-tokenbrice`,
  name: "TokenBrice",
  url: "https://tokenbrice.xyz",
  image: `${SITE_URL}/tokenbrice.png`,
  sameAs: [
    "https://x.com/TokenBrice",
    "https://github.com/TokenBrice",
    "https://farcaster.xyz/tokenbrice", // Farcaster — user-confirmed 2026-04-19
  ],
  knowsAbout: ["stablecoins", "DeFi risk", "tokenomics", "pegged assets", "on-chain analytics"],
  affiliation: { "@id": `${SITE_URL}#organization` },
} as const;

const PHAROS_SITE_DESCRIPTION =
  "Pharos tracks stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries.";

export const PHAROS_ORG_NODE = {
  "@type": "Organization",
  "@id": `${SITE_URL}#organization`,
  name: "Pharos",
  url: SITE_URL,
  logo: `${SITE_URL}/pharos-icon.png`,
  description: PHAROS_SITE_DESCRIPTION,
  sameAs: ["https://x.com/PharosWatch", "https://github.com/TokenBrice/stablecoin-dashboard"],
  founder: { "@id": `${SITE_URL}#person-tokenbrice` },
} as const;
```

**Note:** All 3 `sameAs` URLs are user-confirmed as of 2026-04-19. No Mirror handle exists — deliberately omitted.

- [ ] **Step 2: Refactor `src/app/layout.tsx`**

Replace the inline Organization + the WebApplication.creator Person inline objects with references to the constants:

```tsx
// imports (add):
import { PHAROS_ORG_NODE, PHAROS_PERSON_TOKENBRICE_NODE } from "@/lib/json-ld";

// Replace lines 143-175 (the Organization and WebApplication nodes):
__html: safeJsonLd([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Pharos",
    url: SITE_URL,
    description: siteDescription,
    potentialAction: {
      "@type": "SearchAction",
      target: `${SITE_URL}/?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  },
  { "@context": "https://schema.org", ...PHAROS_ORG_NODE },
  { "@context": "https://schema.org", ...PHAROS_PERSON_TOKENBRICE_NODE },
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Pharos",
    url: SITE_URL,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    description: siteDescription,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    creator: { "@id": `${SITE_URL}#person-tokenbrice` },
  },
]),
```

**Note on `@id` + `@context`:** Schema.org tooling accepts a node with both `@id` and `@context` at the top level and resolves references across nodes in the same graph. Emitting the Person as a standalone top-level node (not just nested inside Org.founder) makes Article.author references resolve cleanly.

- [ ] **Step 3: Verify**

```bash
npm run build
# Global Person @id appears in the layout:
grep -c '"@id":"https://pharos.watch#person-tokenbrice"' out/index.html
# And is referenced, not duplicated, on detail + methodology pages:
grep -c 'person-tokenbrice' out/stablecoin/usdt-tether/index.html
grep -c 'person-tokenbrice' out/methodology/index.html
```

Spot-check in Google Rich Results Test.

**Risks:**
- Adding standalone Person node to every page increases HTML bytes by ~400 bytes gzipped. Acceptable.
- All 3 Person `sameAs` URLs user-confirmed; no 404 risk.

**Effort:** M (2–3h including handle verification)

---

### Task 11: HTML `Cache-Control` header

**Goal:** HTML routes get `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` — browsers always revalidate, CF edge caches for 5 minutes, serves stale up to 24h during revalidation.

**Files:**
- Modify: `public/_headers`

- [ ] **Step 1: Append to `public/_headers`**

```
/*.html
  Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400

/
  Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

**Check Cloudflare Pages semantics:** `/*.html` targets the .html files served at nested routes; the root `/` line catches the homepage. Pages serves trailing-slash routes as directory `index.html` — confirm the pattern matches. If `/*.html` doesn't match directory-index serving, switch to `/*` with a narrower header:

```
# Safer fallback
/*
  Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

BUT `/*` would also affect `.png`, `.txt`, etc. The correct Cloudflare Pages pattern for HTML-only is tricky because there's no content-type filter in `_headers`. Two options:

1. **Narrow by path:** list each top-level path explicitly (`/`, `/stablecoin/*`, `/methodology/*`, etc.).
2. **Broad wildcard + override:** `/*` with the 5min header, then override static-asset paths with longer caches (`_next/static/*` already overridden, `/favicon*` already overridden, add `og-*.png` etc.).

**Decision:** go with option 2. The existing `_headers` already has overrides for favicons, `_next/static/*`, and `og-image.png`. Extend the overrides to cover the full OG image set, then add a broad `/*` header:

```
/og-*.png
  Cache-Control: public, max-age=86400

/*
  Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400
```

Order matters in `_headers`: more-specific rules must appear before less-specific. Preserve the existing ordering; add `/og-*.png` above `/*`, add `/*` at the bottom (after all specific rules).

- [ ] **Step 2: Verify on preview deploy**

After deploying to a Pages preview URL:

```bash
curl -I https://<preview>.pages.dev/ | grep -i cache-control
curl -I https://<preview>.pages.dev/stablecoin/usdt-tether/ | grep -i cache-control
curl -I https://<preview>.pages.dev/favicon.ico | grep -i cache-control
curl -I https://<preview>.pages.dev/og-card.png | grep -i cache-control
```

Expected:
- HTML routes: `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`
- Favicon: `public, max-age=604800, immutable` (unchanged)
- OG PNG: `public, max-age=86400`

- [ ] **Step 3: Do NOT deploy to prod until preview passes**

If preview shows `Cache-Control` not applied or applied incorrectly, roll back the `_headers` change and investigate. Cloudflare Pages has documented quirks around `_headers` pattern matching — worst case the matching is per-file-extension and not path-level, which needs a different approach (response Transform Rules at the zone level).

**Risks:**
- **This is the riskiest task in the plan.** Incorrect cache semantics can serve stale KPI data to real users. Mitigations:
  - Preview-first (don't skip).
  - Keep `s-maxage=300` conservative (5 minutes).
  - `stale-while-revalidate=86400` means users get stale data for up to 24h while CF fetches fresh — acceptable for site-chrome HTML that doesn't embed live KPIs (KPIs load client-side via TanStack Query hitting the Worker API).
- If Pages' `_headers` pattern matching is whitespace-sensitive or ordering-sensitive, the override may fail silently. Plan for a rollback commit.

**Effort:** M (2–4h with preview validation)

---

### Task 12: Cemetery ListItem `url` (already folded into Task 7)

**Goal:** De-duplicate with Task 7. No independent work — Task 7 Step 2 handles it.

- [ ] **Already covered.** Skip in commit sequencing.

---

### Task 13: Taxonomy editorial uniqueness verification

**Goal:** Confirm each cohort page's intro/description is distinct enough to avoid duplicate-content penalties.

**Files:**
- Review only: `src/lib/stablecoin-taxonomy.ts:36-80` (GOVERNANCE_CONTENT), analogous BACKING_CONTENT (already inspected during planning — lines 33-91 cover both), and the INFRASTRUCTURE content block (not inspected yet — find it).

- [ ] **Step 1: Find infrastructure content**

```bash
# grep for INFRASTRUCTURE_CONTENT in src/lib/stablecoin-taxonomy.ts
```

- [ ] **Step 2: Read all three content blocks**

Flag any cohort whose `intro` + `description` overlaps >60% with another cohort's copy (rough eyeball; don't build a similarity tool).

- [ ] **Step 3: File a follow-up issue if any cohort fails the bar**

This task does NOT rewrite copy. It's verification-only. If any cohort's copy feels generic, write a single paragraph in the plan's completion notes listing the cohort + a one-sentence suggested differentiator. The rewrite itself is a separate scoped copy-edit PR.

**Effort:** S (<1h — read-only)

---

## Commit Strategy

Recommend **per-theme commits, single PR**. The tasks fall into five themes; each gets its own commit with a clear subject line. Single PR keeps Week 2 atomic for review.

1. `feat(seo): add llms.txt prebuild generator + header` — Task 1.
2. `feat(seo): promote visible H1 on home + detail + hero card` — Task 2.
3. `feat(seo): full-date ISO datelines on ai-summary + funding card` — Task 3.
4. `chore(assets): shrink og-start.png from 554KB to under 200KB` — Task 4.
5. `feat(seo): TechArticle + ItemList + CollectionPage schema on methodology / changelog / list pages` — Tasks 6, 7.
6. `feat(seo): FAQPage + HowTo schema on /about/api + /telegram` — Tasks 8, 9.
7. `feat(seo): shared Pharos Person + Organization JSON-LD nodes` — Task 10.
8. `chore(infra): HTML Cache-Control headers for Pages` — Task 11.
9. (Task 5 verification) — may fold into commit 2 or land as a trailing check commit.
10. (Task 13 review) — no commit; notes-only.

Reviewer can verify each theme independently. If any theme fails review, drop its commits and re-land the others.

---

## Final Verification Checklist

Run in the listed order from the repo root:

- [ ] `npm run lint` — zero warnings.
- [ ] `npm test` — all green (includes design-invariants and JSON-LD smoke tests if any exist).
- [ ] `npm run build` — completes without warnings; `out/` generated.
- [ ] `npm run seo:check` — existing SEO static checker passes.
- [ ] `npm run test:merge-gate` — pre-push gate passes.
- [ ] Manually validate 1 page per schema family in [Google Rich Results Test](https://search.google.com/test/rich-results) (post-preview-deploy):
  - `/` → CollectionPage, ItemList, Organization, Person, WebApplication, WebSite.
  - `/stablecoin/usdt-tether/` → Dataset, BreadcrumbList, Organization (via layout).
  - `/methodology/` → TechArticle, FAQPage, Organization.
  - `/methodology/scoring-changelog/` → TechArticle, BreadcrumbList.
  - `/changelog/` → ItemList with Article children, BreadcrumbList.
  - `/cemetery/` → CollectionPage, ItemList, FAQPage.
  - `/upcoming/` → CollectionPage, ItemList.
  - `/about/api/` → FAQPage, BreadcrumbList.
  - `/telegram/` → FAQPage, HowTo.
- [ ] `curl -I https://<preview>.pages.dev/llms.txt` → 200 + correct Content-Type + Cache-Control.
- [ ] `curl https://<preview>.pages.dev/llms.txt | head -5` → starts with `# Pharos`.
- [ ] `curl -I https://<preview>.pages.dev/` → HTML Cache-Control applied per Task 11.
- [ ] Bundle-size check: compare `next build` route-size table vs. pre-change baseline; first-load JS on detail pages should be within ±5% (no regression from Task 5 verification; no regression from schema additions which add only string literals).
- [ ] `ls -la public/og-start.png` → <200 KB.
- [ ] Preview deploy visual smoke: open `/start`, `/methodology/`, `/cemetery/` in a browser; no visual regression.

---

## Risks + Rollback

**High-risk tasks:**
- **Task 11 (HTML Cache-Control)** — staleness bugs on prod. Rollback: revert `public/_headers` commit; re-deploy. CF Pages serves from edge cache, so rollback latency is 1–2 minutes until the edge expires; `wrangler pages deployment tail` or the Pages dashboard's "purge cache" button accelerates.
- **Task 10 (shared Person)** — all `sameAs` URLs user-confirmed 2026-04-19. No fabrication risk.

**Medium-risk:**
- **Task 1 (llms.txt)** — if a downstream LLM crawler is already caching a hypothetical stub, replacing it could cause a brief "new file" re-crawl. Low-impact.
- **Task 2 (H1 promotion)** — duplicate H1 on responsive-twin layouts is allowed by HTML5 but flagged by some SEO linters. Mitigation: document the pattern in the commit; add `aria-hidden` to the hidden twin if needed.

**Low-risk:**
- Tasks 3, 4, 5, 6, 7, 8, 9, 12, 13 — additive, reversible, one commit = one rollback.

**Global rollback:** if the whole PR needs reverting, `git revert` each theme commit in reverse order. No data migration or CI state to unwind.

---

## Success Criteria

1. `/llms.txt` is live at `https://pharos.watch/llms.txt`, returns 200 with correct Content-Type, begins with `# Pharos`, and includes every active stablecoin with a descriptive one-liner.
2. Every indexable page has exactly one (or two, in responsive-twin cases) visible `<h1>`, none of them `.sr-only`.
3. Every methodology, changelog, digest-archive, cemetery, upcoming, and homepage emits a full JSON-LD graph (CollectionPage / ItemList / TechArticle / FAQPage / HowTo / Organization / Person) that passes Google Rich Results Test without errors.
4. Shared `PHAROS_ORG_NODE` and `PHAROS_PERSON_TOKENBRICE_NODE` exist in `src/lib/json-ld.ts` and are referenced by `@id` across at least 3 pages.
5. `og-start.png` is <200 KB.
6. Visible "Updated {date}" labels use `<time dateTime="YYYY-MM-DD">` on `ai-summary.tsx`.
7. HTML routes on Cloudflare Pages serve with `Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400`.
8. `npm run test:merge-gate` passes.
9. First-load JS on the detail page has not regressed (tolerance ±5%).
