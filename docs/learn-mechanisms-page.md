# Learn / Mechanisms Page

Contract for the educational explainer surfaces:

- `/learn/mechanisms/` — hub listing all six archetypes
- `/learn/mechanisms/[archetype]/` — per-archetype deep explainer

The broader `/learn/case-studies/` and `/learn/glossary/` surfaces are documented in [learn-page.md](./learn-page.md). Mechanisms are one section of the Learn namespace, not the only `/learn/*` route family.

Each tracked stablecoin carries a `mechanismArchetype` field. The six values (`fiat-cash`, `tbill`, `cdp`, `synthetic-delta-neutral`, `algorithmic`, `rwa-credit-fund`) each get a dedicated educational page that walks through the design, its failure modes, and which Pharos signals are most informative for that archetype.

---

## Route Shape

- **Hub shell:** `src/app/learn/mechanisms/page.tsx`
- **Archetype shell:** `src/app/learn/mechanisms/[archetype]/page.tsx`
- **Page-level shell (editorial display + breadcrumb):** `src/app/learn/_shared/learn-page-shell.tsx` (`LearnPageShell`)
- **Body section renderer:** `src/app/learn/mechanisms/explainer-shell.tsx` (`ArchetypeExplainerBody`)
- **Content registry:** `src/app/learn/mechanisms/content/index.ts` (`ARCHETYPE_CONTENT`)
- **Per-archetype content modules:** `src/app/learn/mechanisms/content/{fiat-cash,tbill,cdp,synthetic-delta-neutral,algorithmic,rwa-credit-fund}.ts`
- **Content schema:** `src/app/learn/mechanisms/content/types.ts` (`ArchetypeContent` interface, `ARCHETYPE_VISUALS` map)
- **Slug helpers (single source of truth):** `shared/lib/classification/mechanism-archetypes.ts`
  - `MECHANISM_ARCHETYPE_LABELS`, `MECHANISM_ARCHETYPE_ONE_LINERS`
  - `getMechanismArchetypeLabel(archetype)`
  - `getMechanismExplainerPath(archetype)` returns `/learn/mechanisms/<slug>/`
- **Slug source:** `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts`
- **Diagram reuse:** `mechanismDiagramFor(archetype, "STBL")` from `src/components/stablecoin-detail/mechanism-diagrams/index.tsx`

The hub is a static route with no client-only state. The archetype route is static-exported via `generateStaticParams()` driven by `MECHANISM_ARCHETYPE_VALUES`.

---

## Visual Identity

These pages deliberately depart from the standard `pharos-card-shell + border-l-[3px]` dashboard chrome. Cards-with-accent-stripes were used in the v1 ship and replaced after the editorial critique — the dashboard treatment dilutes accent identity and reads as templated when repeated 6–7 times per page.

Current treatment:

- **Display title:** the `<h1>` uses `.pharos-page-title` — the homepage ABC Whyte Inktrap display face at the fixed `text-3xl/sm:text-4xl` scale (aligned 2026-07-01; previously a bespoke Geist Sans clamp). Section/list headings use the `.pharos-display` recipe at a fixed `text-2xl/sm:text-3xl` scale so the page title stays the largest type on the page.
- **Section dividers:** hairline borders (`border-border/40`, `border-border/60`) between rows in lists and definition lists — no card chrome.
- **Diagram hero:** the mechanism diagram floats freely against the page background, no wrapping card, no kicker label. The diagram is the single editorial focal point per page.
- **Per-archetype accent:** collapsed to neutral per the 2026-07-02 owner ruling — `ARCHETYPE_VISUALS[archetype].kickerClass` is an empty string for all six archetypes, so `.pharos-kicker`'s muted treatment applies uniformly. The visual differentiation between archetypes lives entirely in the diagram itself (return arc for fiat-cash redeem and cdp, dashed reflexive arc for algorithmic, quarterly-redemption arc for rwa-credit-fund, split spot+perp legs for synthetic; tbill is the plain forward three-step flow).

---

## Page Anatomy

Each `/learn/mechanisms/[archetype]/` page renders, top-to-bottom:

1. **`LearnPageShell` header** — 3-level JSON-LD breadcrumb (`Home / Mechanisms / <Archetype>`, schema.org only via `BreadcrumbJsonLd` — no visible breadcrumb UI), editorial display `<h1>` (`content.headline`), subtitle (larger muted lead), and optional lead paragraphs. Wrapped in `mx-auto w-full max-w-[68rem] space-y-12`.
2. **Diagram hero** — bare diagram, centered, no card wrapper, no kicker label.
3. **"How it works"** — kicker + `<h2>` + `<ol>` of 3 steps with a left rail and small numbered chips (`-left-[1.875rem] sm:-left-[2.375rem]`).
4. **"Tracked examples"** (`RepresentativeCoins`) — kicker + `<h2>` + `<ul>` with hairline dividers. Each row: logo + mono ticker + name + 1-sentence note + right arrow. Hover bumps the arrow + colors the ticker `frost-blue`.
5. **"Decommissioned"** (optional, only when `content.decommissioned` is non-empty) — kicker + `<h2>` + `<ul>` of dead designs (name + date + obituary), with a link to `/cemetery/`.
6. **"Where the design fails"** — kicker + `<h2>` + `<dl>` (two-column on `sm+`, stacked on mobile). Hairline dividers between items.
7. **"Variations"** — kicker + `<h2>` + `<dl>` (two-column on `sm+`).
8. **"What to watch on Pharos"** — kicker + `<h2>` + `<ol>` with a 2-digit mono prefix (`01`, `02`, …) and hairline dividers. No card chrome.
9. **"Tracked universe"** (`TrackedCoinList`) — kicker + `<h2>` + `<ul>` of all active coins via `getActiveByArchetype` (variants nested). Each row: mono ticker + name + right arrow (no note). Footer links to the screener plus `+N upcoming` / `+N frozen` deep-links.
10. **"Case studies"** (`MechanismCaseStudies`) (optional, only when a study in `CASE_STUDY_LIST` is tagged with this archetype) — kicker + `<h2>` ("When this mechanism met a stress test") + `<ul>` of matching case studies in canonical list order. Each row: mono eyebrow + title + outcome chip (`CASE_STUDY_OUTCOME_CHIPS`/`_LABELS`), linking to `/learn/case-studies/<slug>/`. Server-rendered.
11. **"Continue reading"** — section above a top border. 2-column grid of color-on-hover row links (text + bottom border turn `frost-blue` on hover), with `ArrowUpRight` glyph.

The hub at `/learn/mechanisms/` renders the same shell with a different headline (`Six ways a stablecoin holds its peg`), a `LearnHero` header band (frost active-coin One-Beam + an active-coins-by-mechanism distribution bar; see `docs/design-language.md` → Learn-group hero calls), a server-rendered "Start Here" cluster for high-signal collateral/failure-mode paths, a `MechanismComparisonMatrix`, and an editorial vertical `<ol>` table of contents. The matrix links each mechanism label directly to its archetype explainer so the first comparison surface is also a crawlable deep-link hub. Each table-of-contents row: numbered index (`01`–`06`) + tracked/upcoming/frozen/dead count context from mechanism lifecycle helpers (mono kicker) + archetype label (fixed `.pharos-display`) + one-liner + "Read the explainer →" + the mechanism diagram on the right at `lg+`. Hairline dividers between rows.

---

## Metadata + SEO

- Title: hand-tuned per archetype, all ending in `, Explained` (see `TITLE_BY_ARCHETYPE` in the route module); template `%s | Pharos` adds the suffix.
- Description: hand-tuned per archetype, ~150-165 chars (see `DESCRIPTION_BY_ARCHETYPE` in the route module).
- Canonical: `getMechanismExplainerPath(archetype)`.
- OG image: per-archetype static PNG at `public/og-learn-<slug>.png` (1200×628). Regenerated via `node scripts/maintenance/build-og-learn-images.mjs` followed by the `svg-to-png` skill against the staged SVGs.
- JSON-LD: `BreadcrumbJsonLd` rendered by `ExplainerPageShell`, `DefinedTermSet` JSON-LD on the hub, Dataset JSON-LD for the public peg-mechanism distribution mirror, plus Article JSON-LD via the `ArchetypeArticleJsonLd` component (`buildArchetypeArticleJsonLd` in `src/lib/page-metadata.ts`) on each archetype page.

---

## Coverage Invariant

`npm run check:archetype-explainer-coverage` (`scripts/ci/check-archetype-explainer-coverage.ts`, registered in `scripts/lib/validation-command-registry.mjs` immediately after `check:mechanism-archetype-coverage`) asserts, for every `MECHANISM_ARCHETYPE_VALUES`:

- non-empty label + one-liner in `mechanism-archetypes.ts`
- a non-stub content module exists in the registry
- every `representativeCoins[*].coinId` resolves via `TRACKED_META_BY_ID`
- the dynamic route `[archetype]/page.tsx` file exists and `generateStaticParams` round-trips the slug
- `src/app/sitemap.ts` enumerates `/learn/mechanisms/<slug>/`

The guard runs in `validate:prebuild` and so blocks deploy even on non-Pages-impacting changes such as a 6th archetype value being added to `MECHANISM_ARCHETYPE_VALUES`.

---

## Inbound Surfaces

- **Sidebar:** `src/lib/nav-config.ts` LEARN group → `Mechanisms`, `Case Studies`, and `Glossary`
- **Coin detail (`src/components/key-info-card.tsx`):** "Learn how X stablecoins work" link directly below the per-coin mechanism diagram, gated on `meta.mechanismArchetype`.
- **Stablecoin detail Explore Next (`src/components/stablecoin-detail/explore-next-section.tsx`):** does **not** link the explainer (`key-info-card` already carries that CTA); its archetype-gated slot is a canonical `/screener/?mechanisms=<archetype>&lifecycle=active` deep-link instead.
- **Methodology index (`src/app/methodology/page.tsx`):** single "Learn how each stablecoin design produces its peg" callout near the top.
- **About (`src/app/about/page.tsx`):** inline link on the word "mechanisms" inside the Classification section.
- **Start Here (`src/lib/start-here-content.ts`):** single tile under the Learn / Reference group.

No footer entry. The hub is the only deep-link from `Mechanisms`-related surfaces; per-archetype pages are not surfaced anywhere in primary navigation.

---

## How to Add a New Archetype

1. Add the slug to `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts`.
2. Add the label + one-liner entries to `MECHANISM_ARCHETYPE_LABELS` and `MECHANISM_ARCHETYPE_ONE_LINERS` in `shared/lib/classification/mechanism-archetypes.ts`. The typechecker enforces exhaustiveness.
3. Add a `{ kickerClass: "" }` entry to `ARCHETYPE_VISUALS` in `src/app/learn/mechanisms/content/types.ts` (kept empty per the 2026-07-02 neutral-hue ruling; do not add a color unless that ruling is revisited).
4. Author a new content module under `src/app/learn/mechanisms/content/<slug>.ts` and register it in `src/app/learn/mechanisms/content/index.ts`.
5. Add a `TITLE_BY_ARCHETYPE` and `DESCRIPTION_BY_ARCHETYPE` entry in `src/app/learn/mechanisms/[archetype]/page.tsx`.
6. For a flow that fits the three-step pattern, add a `THREE_STEP_ARCHETYPE_CONFIG` entry and a branch in `renderArchetype` in `src/components/stablecoin-detail/mechanism-diagrams/` (reuse `ThreeStepArchetypeDiagram`). Only build a dedicated `<slug>-diagram.tsx` component if the flow needs a custom layout (as `synthetic-delta-neutral` does).
7. Run `node scripts/maintenance/build-og-learn-images.mjs` and the `svg-to-png` skill on the new staged SVG.
8. Run `npm run check:archetype-explainer-coverage` until it passes; this is the gate.

---

## Out of Scope

- No FAQPage / LearningResource / Course JSON-LD
- No Worker-generated dynamic OG handler
- No per-step deep-links on the diagram SVG
- No archetype risk score, quiz, or simulator
- No internationalization
