# SEO Week 2 Plan Verification

Plan reviewed: `agents/plans/2026-04-19-seo-week2-llms-schema-coverage.md`

Date: 2026-04-19

Verifier: Codex with four gpt-5.4 xhigh subagents:

- repo-contract accuracy
- structured-data / SEO validity
- frontend / accessibility / content details
- validation / rollout readiness

## Verdict

Do not implement the plan as written.

The plan is directionally useful, but it has several implementation blockers that would fail `npm run seo:check`, produce incorrect Cloudflare Pages cache headers, and regress the documented root JSON-LD contract. It should be amended before a gpt-5.4 xhigh implementation pass.

## Blocking Amendments

### 1. Task 2 creates duplicate H1s

The repo's static SEO checker requires exactly one raw `<h1>` on every indexable page:

- `scripts/check-seo-static.mjs`

Active stablecoin detail pages already have a visible server-rendered H1 in:

- `src/components/stablecoin-detail/static-hero-strip.tsx`

The plan would also promote both responsive `HeroCard` headings to H1, creating three H1s on active detail pages. The homepage plan would promote both mobile and desktop `SiteHeader` twins to H1, creating two H1s.

Required amendment:

- Do not change active-detail `hero-card.tsx` H2 headings to H1.
- Keep `StaticHeroStrip` as the active detail H1.
- For pre-launch detail, remove the sr-only H1 and promote the single visible coin title to H1.
- For home, render exactly one visible H1 in the static HTML. Do not use one H1 per responsive branch.
- Change verification from `>= 1` to exact `== 1`, and keep `npm run seo:check`.

### 2. Task 11 uses the wrong Cloudflare Pages `_headers` model

The plan says Cloudflare Pages `_headers` does not merge duplicate path blocks and that the last matching block wins. Current Cloudflare Pages docs say matching rules inherit headers, and duplicate header values are joined with commas.

If `Cache-Control` is added to `/*`, it will also match favicons, OG images, `_next/static/*`, and `/llms.txt`. Those paths already have or will get specific cache rules, so the plan can produce ambiguous comma-joined cache policies.

Required amendment:

- Rewrite Task 11 around Cloudflare's inheritance model.
- If broad `/*` HTML `Cache-Control` remains, add `! Cache-Control` before replacement `Cache-Control` in every non-HTML override block.
- Replace the existing `/og-image.png` rule with `/og-*.png`; do not keep both.
- Add detaches for `/llms.txt`, favicon/apple-touch-icon/svg, `/_next/static/*`, and OG PNGs as needed.
- Verify exact header equality, not substring matches.
- Include `cf-cache-status`, `age`, and `etag` in preview/production checks for cache-risk assessment.
- Confirm `/_site-data/*` remains governed by Pages Functions responses, not `_headers`.

### 3. Task 10 regresses root JSON-LD

The current layout already emits stable `#website`, `#organization`, and `#webapp` IDs. `docs/architecture.md` explicitly says the layout intentionally does not emit `SearchAction` until the site has a real query handler.

The plan's Task 10 snippet reintroduces `potentialAction` for `/?q={search_term_string}`, drops some existing root identity fields, and risks removing existing Organization `sameAs` Telegram URLs.

Required amendment:

- Preserve `WebSite.@id`, `WebSite.inLanguage`, and `WebApplication.@id`.
- Do not add `SearchAction` / `potentialAction`.
- Only replace inline Organization/Person duplication with constants.
- Preserve existing Organization `sameAs` entries unless removal is intentional and documented.
- Put TokenBrice-owned profiles on the Person node, not on Organization.

### 4. `/digest/` schema is claimed but omitted

The plan says digest archive `CollectionPage` is handled in Task 7, but Task 7 has no step for `src/app/digest/page.tsx`.

Required amendment:

- Add an explicit Task 7 step for `/digest/` that emits `CollectionPage` plus `ItemList` over `data/digests.json`, with item URLs to `/digest/{date}/`.
- Or remove digest archive from the goal and success criteria.

### 5. `/about/api/` FAQPage would not match visible FAQ content

The plan adds JSON-LD-only FAQ content to `/about/api/`. The page currently has prose/list content for those facts, but not the exact visible FAQ questions and answers. Google FAQ guidance requires all FAQ content to be visible on the source page, and FAQ rich results are limited to well-known government or health sites.

Required amendment:

- Either render a visible `FaqSection` with the exact `ABOUT_API_FAQ` items and `includeJsonLd`, or skip `FAQPage` on `/about/api/`.
- Frame any remaining FAQPage work as generic machine-readable schema, not expected Google rich-result eligibility.

## High-Value Non-Blocking Amendments

### Schema type and validation scope

- `TechArticle` is Schema.org-valid, but Google Article guidance names `Article`, `NewsArticle`, and `BlogPosting` as supported Article object types. Prefer `@type: "Article"` plus `additionalType: "https://schema.org/TechArticle"` if the plan wants both Google-friendly Article parsing and technical-article semantics.
- Use timezone-bearing ISO strings such as `YYYY-MM-DDT00:00:00Z` for Article date fields when those fields are emitted.
- Change `CollectionPage.isPartOf` from `#organization` to `#website`.
- Prefer `ListItem.item` as a `WebPage` object with `@id`, `name`, `url`, and optional `image`, rather than putting page properties directly on `ListItem`.
- Google Rich Results Test should not be the sole validator. It will not report generic `CollectionPage`, `ItemList`, `Person`, `WebSite`, or deprecated HowTo rich-result support as the plan expects. Use Schema.org Validator or a local JSON-LD parser/assertion script for generic graph validity.

### HowTo and Telegram

- `/telegram/` already emits `SoftwareApplication` JSON-LD; preserve it.
- Google deprecated HowTo rich results and removed Rich Results Test support for HowTo. If kept, mark HowTo as generic Schema.org / LLM-readable markup, not a Google rich-result target.
- Align HowTo step text exactly with visible Getting Started copy, or add any missing visible copy before marking it up.
- Use page-fragment URLs such as `${SITE_URL}/telegram/#getting-started` for HowTo steps.

### `llms.txt`

The proposed `/llms.txt` structure is broadly consistent with the llmstxt.org proposal: root `/llms.txt`, one H1, blockquote summary, H2 sections, and Markdown link lists.

Amendments:

- Add `DEAD_STABLECOINS` and `data/digests.json` to the generator's import/read plan; the proposed content needs both.
- Add a generated-file drift check after `npm run prebuild` or `npm run build`, for example `git diff --exit-code public/llms.txt`.
- State that `llms.txt` is a community proposal / inference aid, not a Google ranking directive and not a robots/sitemap replacement.

### JSX insertion details

Several instructions say to insert a script before `<FeaturePageShell>` in pages that currently return a single `FeaturePageShell`.

Amendment:

- Use `FeaturePageShell`'s `preface` prop for changelog, upcoming, digest, and taxonomy schema where possible.
- Otherwise wrap siblings in a fragment.

### Verification commands

- `safeJsonLd` escapes `/`, so exact greps for raw `https://pharos.watch...` can false-negative. Grep for `person-tokenbrice`, `#organization`, or escaped URL forms.
- React SSR may render `dateTime` as `datetime`; verify with `grep -E '<time[^>]*datetime='` or parse HTML.
- Taxonomy verification paths are wrong. Use:
  - `out/stablecoins/governance/cefi/index.html`
  - `out/stablecoins/backing/rwa/index.html`
  - `out/stablecoins/infrastructure/m0/index.html`
- Verify H1s with exact count `1`, not `>= 1`.

### Rollout and CI expectations

Because the plan edits `package.json`, the deploy-surface classifier may treat the change as both Pages- and Worker-impacting even if Worker source is unchanged. The rollout notes should expect the combined Worker + Pages CI path and not assume a Pages-only release.

Amendment:

- Update rollout notes to expect Worker typechecks locally and the combined CI path on push if the classifier marks package/config changes as Worker-impacting.
- Add a concrete preview-deploy procedure before requiring preview-only curl checks.
- Make cache purge part of the Task 11 rollback path, not optional.

### Docs obligations

The plan changes build pipeline, public crawl surface, root JSON-LD, route schema, homepage H1 structure, and Pages headers. Add a docs task.

Likely docs touched:

- `docs/architecture.md` for `llms.txt`, root JSON-LD, crawl surface, and static header behavior.
- `docs/scripts.md` for `scripts/generate-llms-txt.ts` and the prebuild hook.
- `docs/homepage.md` for the homepage H1 and JSON-LD contract.
- Route docs for methodology, digest, cemetery, upcoming, telegram, and API page schema changes where those docs exist.
- `docs/design-language.md` only if the visible homepage H1 changes documented design structure.

## Plan Hygiene

- Remove the unavailable `superpowers:*` requirement. It is not installed in this environment and makes the plan less suited to a gpt-5.4 xhigh implementation agent.
- Add non-negotiable invariants near the top:
  - exactly one H1 per indexable built HTML page
  - no `SearchAction` until a real query handler exists
  - no duplicate `Cache-Control` on deployed responses
  - no generated `llms.txt` drift
- Fix stale references to Task 5 and Task 12 in rollback/final sections.
- Clarify whether Task 13 is read-only completion notes or an implementation commit. Current taxonomy copy is distinct enough; no rewrite task is needed from the current text.

## What Looks Sound

- `safeJsonLd` accepts arrays.
- Existing helper names and imports generally exist.
- `ACTIVE_STABLECOINS`, `PRE_LAUNCH_STABLECOINS`, `PEG_LABELS_SHORT`, and route paths mostly match the repo.
- `pngquant` is installed, and `public/og-start.png` is the only oversized OG PNG in the checked set.
- The `ai-summary.tsx` UTC full-date treatment is appropriate for its current `YYYY-MM-DD` input.

## External Sources Checked

- llms.txt proposal: https://llmstxt.org/
- Cloudflare Pages `_headers`: https://developers.cloudflare.com/pages/configuration/headers/
- Google FAQ structured data: https://developers.google.com/search/docs/appearance/structured-data/faqpage
- Google Article structured data: https://developers.google.com/search/docs/appearance/structured-data/article
- Google HowTo / FAQ changes: https://developers.google.com/search/blog/2023/08/howto-faq-changes
- Google structured data simplification update: https://developers.google.com/search/blog/2025/06/simplifying-search-results
- Schema.org TechArticle: https://schema.org/TechArticle
