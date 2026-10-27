# Learn Pages

Contract for `/learn/case-studies/`, `/learn/case-studies/[slug]/`, `/learn/mechanisms/`, and `/learn/mechanisms/[archetype]/`. These are static educational surfaces, not scoring engines. `/learn/` redirects to Case Studies; `/learn/glossary/` redirects to the A–Z [Definitions](./methodology-page.md#definitions) on `/methodology/`. Keep those redirects in `public/_redirects`.

## Route Shape

`src/app/learn/_shared/learn-page-shell.tsx` owns the shared editorial shell; [feature-page heroes](./design-language.md#feature-page-heroes) owns its design grammar. Case-study routes live under `src/app/learn/case-studies/`; mechanism routes under `src/app/learn/mechanisms/`. Both generate static params from their canonical registries. Invalid case-study slugs return `notFound()` and non-indexing metadata, not an empty article.

## Case Studies

`CASE_STUDY_LIST` in `src/lib/case-studies/index.ts` owns display, sitemap and static-param order. Authored JSON records use `CaseStudyContentSchema` in `shared/types/editorial-content.ts`; root and nested TypeScript shapes derive from that schema through type-only readonly views, not a separate frontend model. The evergreen Start Here set is excluded from the remaining archive rows so an article appears only once; the archive is editorial, not an ordinal ranking.

The `<title>` is the optional search-phrased `metaTitle` (at most 52 characters, before the ` | Pharos` suffix), falling back to the editorial `title`; the H1 always stays the editorial `title`. A `metaTitle` makes no claim the article body does not support (the USDe study argues no peg break, so its title avoids "depeg"). The hub title and description count `CASE_STUDY_LIST` and its `CASE_STUDY_OUTCOME_COUNTS`, the same tally the hub hero renders.

Visible article metadata credits Pharos, links to `/about/#editorial-ai-policy`, and displays authored `datePublished` in UTC alongside reading time. Article JSON-LD agrees with organization authorship. Git modification dates are not human review or substantive-update dates; no individual reviewer is implied. The hub emits ItemList JSON-LD; articles and hub entries share `/og-editorial-learn.png`.

`CASE_STUDY_BY_DEPEG_SLUG` and `caseStudySlugForEvent(coinId, tsMs)` provide reverse lookups. An optional `depegEventSlug` is a lookup key, not proof that the corresponding event route exists. Client surfaces must use generated `src/lib/case-study-client-index.ts`, not import the full content registry. Its compact coin-id and cemetery-id maps have no server-registry counterpart. Articles, chart widgets and ordinary links remain the supported surfaces; there is no live chart-annotation hook.

## Mechanisms

`MECHANISM_ARCHETYPE_VALUES` (defined in `shared/types/stablecoin-taxonomy.ts`, re-exported through `shared/types/core.ts`) owns the exhaustive archetype roster and static-route order. `ARCHETYPE_CONTENT` in `src/lib/mechanism-explainers/index.ts` registers content using `ArchetypeContent`. Labels, descriptors and canonical paths derive from `shared/lib/classification.ts`, not route-local copies. The hub has no client-only state.

Tracked examples and lifecycle counts use `shared/lib/stablecoins/by-mechanism.ts`: active coins appear in canonical order with variants nested; commodity pegs participate only in their explicitly resolved `commodity-claim` family; unresolved effective archetypes are excluded. Hub counts and upcoming/frozen links use the same admission policy. Relevant case studies retain canonical study order.

### Diagram Scope

`mechanismDiagramFor(archetype, "STBL")` supplies generic Learn diagrams without coin facts. Algorithmic captions scope the historical pure mint/burn example; Treasury captions scope the NAV-accreting example. Introductions and metadata cover the wider families: algorithmic members may hold collateral, and Treasury tokens may accrue NAV or hold par with separate/retained yield.

Coin pages instead use `resolveMechanismFlowTemplate` and `resolveWrapperLayer`: `navToken === false` selects par redemption, `liquidationEngine === false` selects CDP reserve copy, and credit funds imply no redemption cadence. Generic precedents never become coin facts; coin stress uses its structural path or its own dated override incident.

Native-family explainers distinguish proportional UCITS/TRS fund shares, shared-pool operational liabilities, and bridge/vault/module position claims. Desktop and mobile diagrams must expose actual local stress paths rather than silently falling back to cash/Treasury backing. [Native-family admission and grading](./process/mechanism-overlay-evidence-standard.md#native-family-admission-and-grading) owns evidence and charged unknowns; Learn does not duplicate numeric calibration. The hub distribution cycles the non-frost palette safely as taxonomy grows.

### Metadata + SEO

`MECHANISM_EXPLAINER_TITLES` in `src/lib/mechanism-explainer-registry.ts` owns titles; `DESCRIPTION_BY_ARCHETYPE` in the archetype route owns descriptions. Canonicals use `getMechanismExplainerPath`. Methodology links target current `METHODOLOGY_SECTIONS` anchors, including `#pegscore-dews-methodology` for PegScore/DEWS. The registry test checks fragments.

The shared shell emits Breadcrumb JSON-LD. The hub adds DefinedTermSet and distribution Dataset JSON-LD; archetype pages add Article JSON-LD through `buildArchetypeArticleJsonLd` in `src/lib/page-metadata.ts`, which delegates to `buildArticleJsonLd` so author and publisher reference the root `#organization` node rather than an inline Organization. Metadata uses `/og-editorial-learn.png`; [OG images](./og-images.md#3-mechanism-explainer-cards-publicog-learn-png) owns the inert legacy-image policy. There is no quiz, simulator, archetype risk score, per-step SVG deep link, Worker OG handler or FAQ/Course schema.

### How to Add a New Archetype

1. Extend `MECHANISM_ARCHETYPE_VALUES` and the exhaustive `MECHANISM_ARCHETYPE_DESCRIPTORS` in `shared/lib/classification.ts`; derived labels and CTA nouns must stay consistent.
2. Author `src/lib/mechanism-explainers/<slug>.ts`, register it, and add its title and route description.
3. Prefer a `THREE_STEP_ARCHETYPE_CONFIG` entry in `src/components/stablecoin-detail/mechanism-diagrams/three-step-archetype-diagram.tsx` plus a `mechanismDiagramFor` branch. Add a dedicated diagram and `mechanism-template.ts` flow only for a genuinely different layout. Coin-fact variations add config, `MechanismTemplateFacts` and `resolveThreeStepConfig` handling, not per-coin entries in `coin-overrides.ts`.
4. Use the shared Learn card; run the content, exact-static-param, sitemap and generated-artifact checks below. Existing bespoke PNGs stay unchanged for old inbound URLs.

## Sitemap + Inbound Surfaces

`src/app/sitemap.ts` includes both hubs and every registered detail route. `scripts/maintenance/generate-sitemap-dates.ts` derives article modification dates from the Git commit history of each study's JSON plus its shared renderer and `shared/types/editorial-content.ts` schema, never deploy-time `now` or checkout mtime; a scanned source without history fails generation. Article `dateModified` reads that date (else `datePublished`); no Updated byline is shown.

Shared navigation links directly to Mechanisms and Case Studies. Mechanism pages link to relevant studies; event pages use study reverse lookups. Coin-detail Mechanism cards gate the explainer CTA and help primer on the resolved archetype; their review fold does not duplicate that link. Explore Next instead uses `/screener/?mechanisms=<archetype>&lifecycle=active`. Preserve methodology/About entry links and command-palette archetype discovery without inventing additional route families.

## Maintenance Checks

- `src/app/__tests__/static-content-route-contracts.test.tsx`: exact registered static params; `src/app/__tests__/sitemap-frozen.test.ts`: canonical public route inventory.
- `src/app/learn/case-studies/__tests__/content.test.ts`: coin references, chart reachability, chronology, deviation consistency, widget relationships and event lookups. `npm run check:editorial-content` owns metadata/body shapes, registration, filenames, tracked/cemetery identities and internal links.
- `src/lib/__tests__/term-markup.test.ts`: glossary marker parsing/visible labels and AI-summary corpus integrity.
- `npm run check:generated-artifacts -- --only=case-study-client-index`: client-safe projection. The `og-editorial` artifact owns the shared Learn card's SVG/font signatures and Firefox-rendered PNG checks; legacy bespoke PNGs are inert.
- `npm run seo:check`: sitemap, OG references and crawlability after a Pages build.
