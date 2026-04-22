# SEO Enhancement Follow-Up Plan

Status: drafted 2026-04-19 after post-implementation verification of weeks 1–3/4.

Source audit: parallel opus verification of all three plans against both codebase and production `pharos.watch` (2026-04-19). Week 2 shipped cleanly; this follow-up closes partial items from Week 1 and completes two regressions from Week 3-4.

## Goal

Close the implementation gaps flagged during post-deploy verification without expanding scope. Task Order below is the authoritative index.

## Assumptions

- Current `main` is the source of truth; all three prior plans are committed.
- `docs/architecture.md`, `docs/data-flow-map.md`, `docs/data-pipeline.md`, `docs/worker-and-api-limits.md` exist. Pre-scrub confirmed on 2026-04-19: zero hits for `agents/|AGENTS.md|TODO|FIXME|runbook|.claude` across all four (rerun before merging to catch drift).
- The site ships one shared `Organization`/`Person`/`WebSite`/`WebApplication` graph via `src/lib/json-ld.ts`. Keep that structure.
- No new dependencies are required.

## Non-Negotiable Invariants

- Exactly one raw `<h1>` per indexable built HTML page (unchanged from Week 2).
- Organization and Person nodes both carry stable `@id` anchors; cross-references use `{ "@id": "..." }` and never inline a duplicate node.
- Do not add a second `/*` block in `public/_headers` — extend the existing block. Cloudflare Pages picks the last matching block; duplicates silently drop prior headers.
- Shipped markdown variants (methodology, changelog, stablecoin, digest, docs) must not drift from visible page content. Drift prevention requires section-file `CONTENT_MARKDOWN` exports + snapshot fixtures.
- Every doc in `PUBLIC_DOCS` must be public-ready. Grep for `agents/`, `TODO`, `FIXME`, `runbook` before adding; rewrite or exclude on hit.

## Task Order

1. Task 1 — Dataset JSON-LD: `sameAs`, `citation`, `creator.@id`
2. Task 2 — Organization `sameAs`: add Farcaster
3. Task 3 — `public/_headers`: `/admin/*` block
4. Task 4 — Static hero strip: classification pills + description
5. Task 5 — Move methodology `CONTENT_MARKDOWN` to section-file exports
6. Task 6 — Markdown snapshot fixture tests
7. Task 7 — Expand `PUBLIC_DOCS` to 20 docs

Tasks are independent; order above minimizes merge-conflict risk.

---

## Task 1: Enrich Dataset JSON-LD with `sameAs`, `citation`, `creator.@id`

### Goal

Close Week 1 Task 11 partial. Dataset on stablecoin detail pages currently has `@id`, `identifier`, `variableMeasured`, `dateModified`, `distribution`, `publisher.@id` — but is missing `sameAs`, `citation` (when `proofOfReserves.url` present), and uses a duplicate inline `Organization` for `creator` instead of an `@id` reference.

### Files

- Modify `src/app/stablecoin/[id]/page.tsx` — Dataset JSON-LD block.

### Implementation

- [ ] **Step 1.** Replace the inline `creator` Organization object with `{ "@id": \`${SITE_URL}#organization\` }`. The full Organization node is already emitted from the root graph (week 1 shipped `@id` anchors); duplicating it here is wasted bytes and creates a graph-consistency warning.

- [ ] **Step 2.** Add `sameAs` built from existing coin fields. Order: CoinGecko first (highest-authority entity link), DefiLlama second, then `coin.links?.[*].url`:

```ts
const datasetSameAs = [
  coin.geckoId ? `https://www.coingecko.com/en/coins/${coin.geckoId}` : null,
  coin.llamaId ? `https://defillama.com/stablecoin/${coin.llamaId}` : null,
  ...(coin.links?.map((l) => l.url) ?? []),
].filter(Boolean);
```

Emit `sameAs: datasetSameAs` only when the array is non-empty.

- [ ] **Step 3.** Add `citation` from `coin.proofOfReserves?.url` when present:

```ts
...(coin.proofOfReserves?.url ? { citation: [coin.proofOfReserves.url] } : {}),
```

### Verification

- `npm run build`; read `out/stablecoin/usdc-circle/index.html` and confirm Dataset contains `"sameAs"` array with ≥2 entries, `"creator":{"@id":"https://pharos.watch#organization"}`, and `"citation"` when the coin has PoR.
- `npm run test:merge-gate`.

### Effort

S (30 min).

---

## Task 2: Add Farcaster to Organization `sameAs`

### Goal

Close Week 1 Task 12 partial. The plan specified 6 URLs on `Organization.sameAs`; only 5 shipped. Farcaster (`https://farcaster.xyz/tokenbrice`) lives on the Person node but not on the Organization — the plan treated it as a joint entry.

### Files

- Modify `src/lib/json-ld.ts` — `PHAROS_ORG_NODE.sameAs`.

### Implementation

- [ ] **Step 1.** Add the Farcaster URL to the Organization `sameAs` array. Do not remove any existing entry:

```ts
sameAs: [
  "https://x.com/PharosWatch",
  "https://github.com/TokenBrice/stablecoin-dashboard",
  "https://t.me/pharoswatch",
  "https://t.me/PharosWatchBot",
  "https://t.me/pharoswatchers",
  "https://farcaster.xyz/tokenbrice",
],
```

### Verification

- `curl -s https://pharos.watch/ | grep -c 'farcaster.xyz'` returns 2 (Organization + Person).

### Effort

XS (5 min).

---

## Task 3: Add `/admin/*` block to `public/_headers`

### Goal

Close Week 1 Task 13 partial. The plan's `_headers` table included a `/admin/*` block; all other routes (`/funding/*`, `/portfolio/*`, `/compare/`) shipped. Admin currently relies on Next metadata + Cloudflare Access's 404 page, which covers it at runtime but diverges from the plan and leaves the `_headers` file internally inconsistent.

### Files

- Modify `public/_headers`.

### Implementation

- [ ] **Step 1.** Append above the `/*` catch-all:

```
/admin/*
  X-Robots-Tag: noindex, nofollow
```

Placement: immediately before the existing `/funding/*` block (more-specific first convention already used in the file).

### Verification

- `curl -sI https://pharos.watch/admin/` post-deploy shows `x-robots-tag: noindex, nofollow` (pinned at the `_headers` layer, independent of Access state).

### Effort

XS (5 min).

---

## Task 4: Complete the static hero strip on stablecoin detail pages

### Goal

Close Week 1 Task 2 partial. Only the H1 landed. The plan called for classification pills (governance / backing / peg) + a one-sentence description rendered in the static HTML outside `<Suspense>`, so crawlers and AI agents see taxonomy context without executing JS. Currently crawlers only see the coin name + symbol before the hydration skeleton.

### Files

- Create `src/components/stablecoin-detail/static-hero-strip.tsx`.
- Modify `src/app/stablecoin/[id]/page.tsx` — replace the bare `<h1>` with `<StaticHeroStrip coin={coin} />`.

### Implementation

- [ ] **Step 1.** New component `StaticHeroStrip`:
  - Renders `<h1>{coin.name} ({coin.symbol}) stablecoin analytics</h1>` (preserves current behavior).
  - Below the H1, a classification row: three `<Link>` pills to taxonomy pages (governance, backing, peg). Labels from `GOVERNANCE_LABELS`, `BACKING_LABELS`, `PEG_LABELS_SHORT` in `@shared/lib/classification`. Reuse the `pillClass` constant from `src/components/stablecoin-detail/hero-card.tsx:231` verbatim — same styling, same dimensions, no CLS on hydration.
  - One-sentence description: call `buildStablecoinDetailDescription(coin)` (already exported from `src/lib/page-metadata.ts:105`) and render it verbatim.
  - Pure server component — no TanStack Query, no client hooks.

- [ ] **Step 2.** Wire into `src/app/stablecoin/[id]/page.tsx`: replace the current `<h1>...</h1>` + dateline block with `<StaticHeroStrip coin={coin} />`. Keep the `<Suspense>` + `DetailPageShellFallback` below; the hero-card H2 stays (per Week 2 invariant, hero H2s are preserved).

- [ ] **Step 3.** Keep one H1 per page. `StaticHeroStrip` emits it; `hero-card` stays `<h2>`.

### Verification

- `grep -c '<h1' out/stablecoin/usdc-circle/index.html` → 1.
- `curl -s https://pharos.watch/stablecoin/usdc-circle/ | grep -o 'RWA-Backed\|Centralized\|US Dollar'` → hits before any `<template id="B:` hydration marker.
- `npm run test:merge-gate`.

### Risks

- CLS on hydration — match `hero-card.tsx` pill dimensions exactly.

### Effort

M (2–3h including a11y + visual QA).

---

## Task 5: Move methodology `CONTENT_MARKDOWN` to section-file exports

### Goal

Fix Week 3-4 Task A.3 regression. The plan required each methodology section `.tsx` file to export a sibling `CONTENT_MARKDOWN` constant so reviewers see the markdown counterpart next to the JSX. Current implementation inlines 11 strings inside `scripts/lib/methodology-to-markdown.ts`, defeating the drift-prevention intent.

**11 sections, not 10** — pricing-pipeline is the 11th, and its JSX lives in `src/app/methodology/sections/core-sections-pricing.tsx` (a shared file, not a per-section file under `core/`).

### Files

- Modify 11 source files (additive export — no JSX changes):
  - `src/app/methodology/sections/core/safety-scores-section.tsx`
  - `src/app/methodology/sections/core/liquidity-section.tsx`
  - `src/app/methodology/sections/core/stability-index-section.tsx`
  - `src/app/methodology/sections/core/infrastructure-section.tsx`
  - `src/app/methodology/sections/core/mint-burn-flow-section.tsx`
  - `src/app/methodology/sections/core-sections-pricing.tsx` ← pricing-pipeline exports live here
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
  - `src/app/methodology/sections/monitoring/chain-health-section.tsx`
  - `src/app/methodology/sections/monitoring/blacklist-tracker-section.tsx`
  - `src/app/methodology/sections/monitoring/contagion-stress-test-section.tsx`
  - `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`
- Modify `scripts/lib/methodology-to-markdown.ts`: replace the 11 inline `const` strings with imports.

### Implementation

- [ ] **Step 1.** For each of the 11 source files, copy the matching inline string from `scripts/lib/methodology-to-markdown.ts` verbatim into `export const CONTENT_MARKDOWN = \`...\`;` placed above the component. The constant must be a plain string literal — no JSX, no React — or the script will pull React via transitive import.

- [ ] **Step 2.** Rewrite the top of `scripts/lib/methodology-to-markdown.ts` to import the 11 constants:

```ts
import { CONTENT_MARKDOWN as SAFETY_SCORES } from "../../src/app/methodology/sections/core/safety-scores-section";
import { CONTENT_MARKDOWN as LIQUIDITY } from "../../src/app/methodology/sections/core/liquidity-section";
import { CONTENT_MARKDOWN as STABILITY_INDEX } from "../../src/app/methodology/sections/core/stability-index-section";
import { CONTENT_MARKDOWN as INFRASTRUCTURE } from "../../src/app/methodology/sections/core/infrastructure-section";
import { CONTENT_MARKDOWN as MINT_BURN_FLOW } from "../../src/app/methodology/sections/core/mint-burn-flow-section";
import { CONTENT_MARKDOWN as PRICING_PIPELINE } from "../../src/app/methodology/sections/core-sections-pricing";
import { CONTENT_MARKDOWN as PEGSCORE_DEWS } from "../../src/app/methodology/sections/monitoring/pegscore-dews-section";
import { CONTENT_MARKDOWN as CHAIN_HEALTH } from "../../src/app/methodology/sections/monitoring/chain-health-section";
import { CONTENT_MARKDOWN as BLACKLIST } from "../../src/app/methodology/sections/monitoring/blacklist-tracker-section";
import { CONTENT_MARKDOWN as CONTAGION } from "../../src/app/methodology/sections/monitoring/contagion-stress-test-section";
import { CONTENT_MARKDOWN as YIELD } from "../../src/app/methodology/sections/monitoring/yield-intelligence-section";

const SECTIONS = [SAFETY_SCORES, LIQUIDITY, STABILITY_INDEX, INFRASTRUCTURE, MINT_BURN_FLOW, PRICING_PIPELINE, PEGSCORE_DEWS, CHAIN_HEALTH, BLACKLIST, CONTAGION, YIELD];
```

Keep `buildMethodologyIndexMarkdown` and the 9-entry `CHANGELOG_REGISTRY` unchanged below these imports. Preserve the original SECTIONS order so emitted markdown byte-matches pre-change output.

- [ ] **Step 3.** Before switching, capture a baseline: `cp out/methodology/index.md /tmp/methodology-before.md` (after a clean build on `main`). After Step 2: `npm run build && diff /tmp/methodology-before.md out/methodology/index.md` must be empty.

### Verification

- `grep -l "CONTENT_MARKDOWN" src/app/methodology/sections/**/*.tsx | wc -l` → 11.
- `tsx scripts/generate-markdown-exports.ts` runs clean.
- `diff /tmp/methodology-before.md out/methodology/index.md` → empty.
- `npm run test:merge-gate`.

### Risks

- `CONTENT_MARKDOWN` must be a string literal — no JSX, no React imports — or the script will pull React via transitive import.

### Effort

M (3–5h — 11 files × ~30 lines each, plus adapter + baseline diff).

---

## Task 6: Add markdown snapshot fixture tests

### Goal

Ship Week 3-4 Task A.11 which was skipped. Without snapshot guards, a JSX edit that renames a section heading or alters prose will silently desync the shipped `.md` from the shipped HTML. Three fixtures cover the highest-churn surfaces.

### Files

- Create `scripts/__tests__/fixtures/markdown/methodology-index.md`.
- Create `scripts/__tests__/fixtures/markdown/changelog-index.md`.
- Create `scripts/__tests__/fixtures/markdown/stablecoin-usdt-tether.md`.
- Modify `scripts/__tests__/generate-markdown-exports.test.ts` — add a `describe("snapshot fixtures")` block.

### Implementation

- [ ] **Step 1.** Run the generator locally against `main`, then copy the produced outputs:

```
cp out/methodology/index.md scripts/__tests__/fixtures/markdown/methodology-index.md
cp out/changelog/index.md scripts/__tests__/fixtures/markdown/changelog-index.md
cp out/stablecoin/usdt-tether/index.md scripts/__tests__/fixtures/markdown/stablecoin-usdt-tether.md
```

- [ ] **Step 2.** Add a test block:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import { renderChangelogIndex, renderStablecoinDetail } from "../lib/markdown-renderers";

const FIXTURES = join(__dirname, "fixtures", "markdown");

describe("markdown snapshot fixtures", () => {
  it("methodology index matches fixture", () => {
    const expected = readFileSync(join(FIXTURES, "methodology-index.md"), "utf-8");
    expect(buildMethodologyIndexMarkdown()).toBe(expected);
  });

  it("changelog index matches fixture", () => {
    const expected = readFileSync(join(FIXTURES, "changelog-index.md"), "utf-8");
    expect(renderChangelogIndex()).toBe(expected);
  });

  it("stablecoin usdt-tether matches fixture", () => {
    const expected = readFileSync(join(FIXTURES, "stablecoin-usdt-tether.md"), "utf-8");
    expect(renderStablecoinDetail("usdt-tether")).toBe(expected);
  });
});
```

- [ ] **Step 3.** Document the refresh flow. When an intentional methodology/changelog edit changes output, rerun the generator and `cp` the new file over the fixture in the same commit as the JSX change. Add a one-paragraph note to `docs/testing.md` (near the existing markdown-generator section).

### Verification

- `npm test -- scripts/__tests__/generate-markdown-exports.test.ts` passes.
- Deliberately edit one word in `safety-scores-section.tsx`'s `CONTENT_MARKDOWN`, rerun tests — suite must fail with a clear diff; then revert.
- `npm run test:merge-gate`.

### Risks

None. The three targeted renderers (`buildMethodologyIndexMarkdown`, `renderChangelogIndex`, `renderStablecoinDetail`) use only stable inputs (`ChangelogEntry.date`, `ai-summaries.json`, section constants) — no `new Date()` call. Fixtures are deterministic.

### Effort

S (1–2h).

---

## Task 7: Expand `PUBLIC_DOCS` to 20 docs

### Goal

Close Week 3-4 Task B.1 scope reduction. The amended plan shipped 20 docs; production ships 16. `/docs/architecture/`, `/docs/data-flow-map/`, `/docs/data-pipeline/`, `/docs/worker-and-api-limits/` currently 404. The Final Verification Checklist explicitly probes `/docs/architecture/` — this must pass.

### Files

- Modify `shared/lib/public-docs.ts` — add 4 entries to `PUBLIC_DOCS`.
- Modify `shared/lib/__tests__/public-docs.test.ts` — update length assertion to 20.
- Modify `public/llms.txt` (regenerated by prebuild) — verify `## Docs` now lists 20 entries.

### Implementation

- [ ] **Step 1.** Rerun the pre-scrub immediately before merging (drift defense):

```bash
grep -nE "agents/|AGENTS\.md|TODO|FIXME|runbook|\.claude" \
  docs/architecture.md docs/data-flow-map.md docs/data-pipeline.md docs/worker-and-api-limits.md
```

At plan-write time (2026-04-19) this returns zero hits across all four. The existing `redactPublicDocSource` only covers `agents/` + `AGENTS.md`; if the grep finds `TODO`, `FIXME`, `runbook`, or `.claude`, either rewrite the doc or exclude it from the allowlist (do not extend the redactor for ad-hoc patterns).

- [ ] **Step 2.** Add entries to `PUBLIC_DOCS` matching the existing object shape. Group assignment: `architecture` → `system`, `data-flow-map` + `data-pipeline` → `system`, `worker-and-api-limits` → `system`. Use the same `title` / `summary` pattern already used by shipped entries.

- [ ] **Step 3.** Update the length assertion:

```ts
expect(PUBLIC_DOCS.length).toBe(20);
```

- [ ] **Step 4.** Rerun prebuild to regenerate `public/llms.txt` and `src/generated/docs-metadata.json`. Commit both.

### Verification

- `curl -sI https://pharos.watch/docs/architecture/` → 200 post-deploy.
- `curl -s https://pharos.watch/sitemap.xml | grep -c '<loc>[^<]*docs/'` ≥ 20 (exact total depends on whether the `/docs/` index is emitted by `src/app/sitemap.ts` — verify in the implementation PR).
- `curl -s -H "Accept: text/markdown" https://pharos.watch/docs/architecture/` → 200 `text/markdown`.
- `npm run test:merge-gate`.

### Risks

- The pre-scrub (Step 1) is the only real risk. If a doc leaks agent-internal language after redaction, drop it from the allowlist and file a separate rewrite task.
- `architecture.md` is the most visible of the four; give it a manual read-through before merging.

### Effort

S (1–2h including scrub + manual read).

---

## Final Verification Checklist (after all 7 tasks ship)

- [ ] `npm run test:merge-gate` passes on every commit.
- [ ] `curl -s https://pharos.watch/stablecoin/usdc-circle/ | grep -o '"sameAs":\[' | wc -l` ≥ 2 (Organization + Dataset).
- [ ] `curl -s https://pharos.watch/ | grep -o 'farcaster.xyz' | wc -l` ≥ 2 (Organization + Person).
- [ ] `curl -sI https://pharos.watch/admin/` shows `x-robots-tag: noindex, nofollow`.
- [ ] `curl -s https://pharos.watch/stablecoin/usdc-circle/` shows classification pills + description before the first `<template id="B:` hydration marker.
- [ ] `grep -l "CONTENT_MARKDOWN" src/app/methodology/sections/**/*.tsx | wc -l` = 10.
- [ ] `ls scripts/__tests__/fixtures/markdown/ | wc -l` ≥ 3.
- [ ] `curl -sI https://pharos.watch/docs/architecture/` → 200.
- [ ] `curl -s https://pharos.watch/sitemap.xml | grep -c '<loc>.*docs/'` = 21.

## Rollback

Each task is a standalone revert. Highest-risk change is Task 5 (methodology section exports); if the build regression surfaces post-merge, revert the specific commit and reopen the task — the fallback is to keep the adapter-local constants that currently ship.

## Open Questions

None outstanding — all prior open items resolved in the reviewed plan.
