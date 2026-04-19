# SEO Week 1 Plan Verification

Date: 2026-04-19

Plan reviewed: `agents/plans/2026-04-19-seo-week1-hygiene-schema.md`

Review mode: read-only verification before implementation. Three gpt-5.4 / xhigh subagents reviewed codebase fit, structured-data/SEO correctness, and test/docs/rollout safety. I also cross-checked current Cloudflare Pages, Google structured-data, and AI crawler primary docs, plus live Pharos endpoints.

## Verdict

Do not hand this plan directly to an implementation agent yet. The direction is useful, but several tasks are inaccurate enough to cause wasted work or failed verification.

## Required Corrections

1. Remove or rewrite Task 1.
   - `/* /404.html 404` is not a supported Cloudflare Pages `_redirects` rule for 404 rewrites.
   - `scripts/generate-redirects.ts` rewrites `public/_redirects` during `npm run build`, so a rule appended after the generated block would be dropped.
   - Current live check on `https://pharos.watch/this-route-does-not-exist-xyz` returns `HTTP/2 404`, and `out/404.html` exists.

2. Fix Task 11 Dataset distribution URL.
   - The plan points `distribution.contentUrl` at `https://api.pharos.watch/api/stablecoin/{id}` and claims it is publicly accessible.
   - Live unauthenticated request returns `401`.
   - Same-origin `https://pharos.watch/_site-data/stablecoin/{id}` returns `200`; use that if the Dataset distribution is meant to be crawlable and free.

3. Scope Dataset verification to active assets.
   - `TRACKED_STABLECOINS` is 191, but `ACTIVE_STABLECOINS` is 180 and there are 11 pre-launch assets.
   - The normal Dataset block is skipped for pre-launch pages because `stablecoin/[id]/page.tsx` returns `PreLaunchDetail` first.

4. Fix Task 13 for Pages Functions and route semantics.
   - `_headers` does not reliably cover `/admin/*` because `/admin/*` is handled by `functions/admin/[[path]].ts`.
   - The public-host admin rejection already emits `X-Robots-Tag: noindex, nofollow`.
   - Preserve `noindex,nofollow` for admin/funding unless intentionally changing those route contracts.
   - Consider `/api/admin/` too if the goal is operator-surface exclusion; the plan's "no /api path on the site" note is false for this repo.

5. Add crawlable inbound links for new taxonomy hubs.
   - Adding `/stablecoins/` and the axis hubs to the sitemap is not enough.
   - `npm run seo:check` fails indexable pages with zero inbound links or excessive click depth.
   - Add at least one existing reachable link to `/stablecoins/`; the hub can then link to backing/governance/infrastructure children.

6. Fix counts and title expectations.
   - If title copy says "Track 191 Coins", use `TRACKED_STABLECOINS.length`.
   - If using `ACTIVE_STABLECOINS.length`, expected output is 180 in this checkout.
   - `BACKING_LABELS_SHORT` is `RWA`, `Crypto`, `Algo`, not `RWA-Backed`.

7. Reorder or combine Task 3 and Task 6.
   - Breadcrumbs that point at `/stablecoins/backing/`, `/stablecoins/governance/`, and `/stablecoins/infrastructure/` depend on those pages existing.
   - The commit strategy currently puts breadcrumb changes before hub pages.

8. Add docs and verification updates.
   - Update at least `docs/architecture.md`, `docs/stablecoin-detail-page.md`, and `docs/design-language.md`.
   - Add explicit `npm run seo:check` after `npm run build`.
   - Use a JSON-LD parser for checks because `safeJsonLd()` escapes `/` as `\u002f`.

## Lower-Risk Corrections

- Task 2 should acknowledge `StablecoinLogo` is currently a client component. Use the fallback plain image/span path or remove the unnecessary `"use client"` only after checking all consumers.
- Task 5 should say Article `image` and `dateModified` are Google-recommended properties, not required properties.
- Task 6 says hub pages emit `ItemList` JSON-LD, but the provided `/stablecoins/` snippet only emits `CollectionPage`.
- Task 12 should either omit `https://farcaster.xyz/tokenbrice` from `Organization.sameAs` or place it on `founder.sameAs`; it identifies the founder, not the organization. The notes and snippet also disagree on whether it is included.
- Raw grep checks for `https://pharos.watch#organization` and API URLs will false-fail unless they unescape JSON-LD.

## Sound Sections

- Task 3's `BreadcrumbJsonLd` `items[]` API fits the current component and call-site shape.
- Task 4 SearchAction removal is reasonable because the site has no `/?q=` search handler; Google has also retired the sitelinks search box feature.
- Task 5 Article enrichment is useful, with the wording correction above.
- Task 6 taxonomy source arrays exist and are appropriate.
- Task 7 duplicate title suffix cleanup is real for the listed page metadata and slug fallback paths.
- Task 8 removing noindex `/portfolio/` from the sitemap is sound.
- Task 9 orphan `ai-summaries.json` cleanup is accurate; the six listed IDs are orphaned.
- Task 10 AI crawler names are mostly current against OpenAI, Anthropic, Cloudflare AI Crawl Control, Google, and Apple docs, with the caveat that user-triggered fetchers and extended control tokens are not all crawlers in the same sense.

## Primary Docs Checked

- Cloudflare Pages redirects, headers, and serving pages documentation.
- Google Search Central Article and Dataset structured-data documentation.
- Google Search Central sitelinks search box deprecation note.
- OpenAI crawler docs.
- Anthropic Claude crawler help article.
- Cloudflare AI Crawl Control bot reference.
- Applebot and Google-Extended crawler documentation.
