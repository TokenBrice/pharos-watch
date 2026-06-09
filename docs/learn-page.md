# Learn Pages

Contract for the broader learning-center surfaces:

- `/learn/case-studies/` - long-form depeg/failure retrospective index
- `/learn/case-studies/[slug]/` - static case-study article pages
- `/learn/glossary/` - alphabetized, methodology-version-pinned Pharos vocabulary

Mechanism explainers remain documented in [learn-mechanisms-page.md](./learn-mechanisms-page.md). This page covers the adjacent learning surfaces that sit beside them under `/learn/*`. There is no `/learn/` overview route; the sidebar Learn section links directly to the thematic pages.

---

## Route Shape

- **Case-study hub:** `src/app/learn/case-studies/page.tsx`
- **Case-study detail route:** `src/app/learn/case-studies/[slug]/page.tsx`
- **Case-study shell/body:** `src/app/learn/case-studies/case-study-page-shell.tsx`, `src/app/learn/case-studies/case-study-body.tsx`
- **Case-study content registry:** `src/app/learn/case-studies/content/index.ts`
- **Case-study schema:** `src/app/learn/case-studies/content/types.ts`
- **Glossary route:** `src/app/learn/glossary/page.tsx`
- **Glossary content/schema:** `src/app/learn/glossary/content.ts`

The case-study detail route is static-exported through `generateStaticParams()` from `CASE_STUDY_ORDER`. Unknown slugs return `notFound()`, while `generateMetadata()` returns non-indexing metadata for invalid slugs.

---

## Case Studies

`CASE_STUDY_LIST` in `src/app/learn/case-studies/content/index.ts` is the canonical display, sitemap, and static-param order. The hub renders the list as editorial rows with an outcome chip (`survived`, `wounded`, `died`) and archetype accent from `ARCHETYPE_VISUALS`.

Each detail page renders:

1. `CaseStudyPageShell` breadcrumb/header
2. `CaseStudyArticleJsonLd`
3. `CaseStudyBody`, including the fact strip, optional Pharos chart widgets, authored timeline, explanation sections, and related links from the content module

Case-study JSON-LD lives in `case-study-json-ld.tsx`: the hub emits an `ItemList`; detail pages emit an `Article` with image `public/og-learn-case-<slug>.png`.

Reverse lookup helpers in the content registry let other surfaces deep-link into case studies:

- `CASE_STUDY_BY_COIN_ID`
- `CASE_STUDY_BY_CEMETERY_ID`
- `CASE_STUDY_BY_DEPEG_SLUG`
- `caseStudySlugForEvent(coinId, tsMs)`

---

## Glossary

Glossary entries live in `src/app/learn/glossary/content.ts`. Each entry owns:

- stable `id`, used as the on-page anchor and `seeAlso` reference
- Title-Case display `term`
- alphabetical `letter`
- authored `definition`
- `methodologyAnchor`
- `methodologyVersion`
- optional historical `example`
- optional `seeAlso` entry IDs

`/learn/glossary/` groups entries with `groupGlossaryByLetter()`, renders a sticky A-Z jump rail, and keeps each entry's methodology/version links inline. The page metadata uses canonical `/learn/glossary/` and `public/og-editorial-learn.png`.

---

## Sitemap + Inbound Surfaces

`src/app/sitemap.ts` includes `/learn/glossary/`, `/learn/mechanisms/`, every mechanism archetype page, `/learn/case-studies/`, and every case-study slug.

Primary inbound surfaces:

- Sidebar Learn group in `src/lib/nav-config.ts`, with direct links to Mechanisms, Case Studies, and Glossary
- Start Here content in `src/lib/start-here-content.ts`
- Mechanism pages' Continue Reading links into relevant case studies
- Depeg event pages, via `CASE_STUDY_BY_DEPEG_SLUG`
- Stablecoin detail/chart annotations, via `caseStudySlugForEvent`
- About, methodology, and taxonomy pages linking into mechanism explainers or glossary definitions

---

## Maintenance Checks

- `npm run check:archetype-explainer-coverage` covers mechanism explainer completeness.
- `src/app/learn/case-studies/__tests__/content.test.ts` checks case-study content invariants and internal links.
- `npm run check:generated-artifacts` verifies case-study OG PNGs through `scripts/maintenance/build-og-case-studies.mjs --check` and editorial OG cards through `scripts/maintenance/build-og-editorial.mjs --check`.
- `npm run seo:check` verifies sitemap coverage, OG references, and crawlability after a Pages build.
