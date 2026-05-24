# Learn / Mechanisms Page

Contract for the educational explainer surfaces:

- `/learn/mechanisms/` — hub listing all six archetypes
- `/learn/mechanisms/[archetype]/` — per-archetype deep explainer

The broader `/learn/`, `/learn/case-studies/`, and `/learn/glossary/` surfaces are documented in [learn-page.md](./learn-page.md). Mechanisms are one section of that learning center, not the only `/learn/*` route family.

Each tracked stablecoin carries a `mechanismArchetype` field. The six values (`fiat-cash`, `tbill`, `cdp`, `synthetic-delta-neutral`, `algorithmic`, `rwa-credit-fund`) each get a dedicated educational page that walks through the design, its failure modes, and which Pharos signals are most informative for that archetype.

---

## Route Shape

- **Hub shell:** `src/app/learn/mechanisms/page.tsx`
- **Archetype shell:** `src/app/learn/mechanisms/[archetype]/page.tsx`
- **Page-level shell (editorial display + breadcrumb):** `src/app/learn/mechanisms/explainer-page-shell.tsx` (`ExplainerPageShell`)
- **Body section renderer:** `src/app/learn/mechanisms/explainer-shell.tsx` (`ArchetypeExplainerBody`)
- **Content registry:** `src/app/learn/mechanisms/content/index.ts` (`ARCHETYPE_CONTENT`)
- **Per-archetype content modules:** `src/app/learn/mechanisms/content/{fiat-cash,tbill,cdp,synthetic-delta-neutral,algorithmic,rwa-credit-fund}.ts`
- **Content schema:** `src/app/learn/mechanisms/content/types.ts` (`ArchetypeContent` interface, `ARCHETYPE_VISUALS` map)
- **Slug helpers (single source of truth):** `shared/lib/classification/mechanism-archetypes.ts`
  - `MECHANISM_ARCHETYPE_LABELS`, `MECHANISM_ARCHETYPE_ONE_LINERS`
  - `getMechanismArchetypeLabel(archetype)`
  - `getMechanismExplainerPath(archetype)` returns `/learn/mechanisms/<slug>/`
- **Slug source:** `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts`
- **Diagram reuse:** `mechanismDiagramFor(archetype, "USDX")` from `src/components/stablecoin-detail/mechanism-diagrams/index.tsx`

The hub is a static route with no client-only state. The archetype route is static-exported via `generateStaticParams()` driven by `MECHANISM_ARCHETYPE_VALUES`.

---

## Visual Identity

These pages deliberately depart from the standard `pharos-card-shell + border-l-[3px]` dashboard chrome. Cards-with-accent-stripes were used in the v1 ship and replaced after the editorial critique — the dashboard treatment dilutes accent identity and reads as templated when repeated 6–7 times per page.

Current treatment:

- **Display title:** editorial-scale `<h1>` set in Geist Sans extra-bold at `text-[clamp(2.25rem,4.5vw,4rem)]` with `tracking-[-0.035em]`. Custom to this route family; not `pharos-page-title`.
- **Section dividers:** hairline borders (`border-border/40`, `border-border/60`) between rows in lists and definition lists — no card chrome.
- **Diagram hero:** the mechanism diagram floats freely against the page background, no wrapping card, no kicker label. The diagram is the single editorial focal point per page.
- **Per-archetype accent:** lives only in the **section kicker color** via `ARCHETYPE_VISUALS[archetype].kickerClass`. The visual differentiation between archetypes already lives in the diagram itself (loop arc for tbill, dashed flow + callout for algorithmic, return arc for cdp, split spot+perp legs for synthetic).

| Archetype                 | Kicker pair                            |
| ------------------------- | -------------------------------------- |
| fiat-cash                 | `text-blue-700 dark:text-blue-400`     |
| tbill                     | `text-violet-700 dark:text-violet-400` |
| cdp                       | `text-cyan-700 dark:text-cyan-400`     |
| synthetic-delta-neutral   | `text-teal-700 dark:text-teal-400`     |
| algorithmic               | `text-rose-700 dark:text-rose-400`     |
| rwa-credit-fund           | `text-amber-700 dark:text-amber-400`   |

Excludes red/green (peg severity) and emerald (PoR big4) to avoid semantic collisions.

---

## Page Anatomy

Each `/learn/mechanisms/[archetype]/` page renders, top-to-bottom:

1. **`ExplainerPageShell` header** — 3-level breadcrumb (`Dashboard / Learn / <Archetype>`), `BreadcrumbJsonLd`, editorial display `<h1>` (`content.headline`), subtitle (larger muted lead), and optional lead paragraphs. Wrapped in `mx-auto w-full max-w-[68rem] space-y-12`.
2. **Diagram hero** — bare diagram, centered, no card wrapper, no kicker label.
3. **"How it works"** — kicker + `<h2>` + `<ol>` of 3 steps with a left rail and small numbered chips (`-left-[1.875rem] sm:-left-[2.375rem]`). Step body capped at `max-w-[65ch]`.
4. **"Where the design fails"** — kicker + `<h2>` + `<dl>` (two-column on `sm+`, stacked on mobile). Hairline dividers between items. Body capped at `max-w-[65ch]`.
5. **"What to watch on Pharos"** — kicker + `<h2>` + `<ol>` with a 2-digit mono prefix (`01`, `02`, …) and hairline dividers. No card chrome.
6. **"Tracked examples"** — kicker + `<h2>` + `<ul>` with hairline dividers. Each row: mono ticker + name + 1-sentence note + right arrow. Hover bumps the arrow + colors the ticker `frost-blue`.
7. **"Variations"** — kicker + `<h2>` + `<dl>` (two-column on `sm+`).
8. **"Continue reading"** — section above a top border. 2-column grid of underline-on-hover row links, with `ArrowUpRight` glyph.

The hub at `/learn/mechanisms/` renders the same shell with a different headline (`Six ways a stablecoin holds its peg`), a `MechanismComparisonMatrix`, and an editorial vertical `<ol>` table of contents. Each row: numbered index (`01`–`06`) + active/upcoming/frozen/dead count context from mechanism lifecycle helpers (mono kicker) + archetype label (clamp display) + one-liner + "Read the explainer →" + the mechanism diagram on the right at `lg+`. Hairline dividers between rows.

---

## Metadata + SEO

- Title pattern: `<Archetype> Stablecoins, Explained` (template `%s | Pharos` adds the suffix).
- Description: hand-tuned per archetype, ≤160 chars (see `DESCRIPTION_BY_ARCHETYPE` in the route module).
- Canonical: `getMechanismExplainerPath(archetype)`.
- OG image: per-archetype static PNG at `public/og-learn-<slug>.png` (1200×628). Regenerated via `node scripts/maintenance/build-og-learn-images.mjs` followed by the `svg-to-png` skill against the staged SVGs.
- JSON-LD: `BreadcrumbJsonLd` rendered by `ExplainerPageShell`, plus Article JSON-LD from `buildMechanismArticleJsonLd(...)` on each archetype page.

---

## Coverage Invariant

`npm run check:archetype-explainer-coverage` (`scripts/ci/check-archetype-explainer-coverage.ts`, registered in `scripts/lib/validate-contract.mjs` immediately after `check:mechanism-archetype-coverage`) asserts, for every `MECHANISM_ARCHETYPE_VALUES`:

- non-empty label + one-liner in `mechanism-archetypes.ts`
- a non-stub content module exists in the registry
- every `representativeCoins[*].coinId` resolves via `TRACKED_META_BY_ID`
- the dynamic route `[archetype]/page.tsx` file exists and `generateStaticParams` round-trips the slug
- `src/app/sitemap.ts` enumerates `/learn/mechanisms/<slug>/`

The guard runs in `validate:prebuild` and so blocks deploy even on non-Pages-impacting changes such as a 6th archetype value being added to `MECHANISM_ARCHETYPE_VALUES`.

---

## Inbound Surfaces

- **Sidebar:** `src/lib/nav-config.ts` LEARN group → `Learn Overview`, `Mechanisms`, `Case Studies`, and `Glossary`
- **Coin detail (`src/components/key-info-card.tsx`):** "Learn how X stablecoins work" link directly below the per-coin mechanism diagram, gated on `meta.mechanismArchetype`.
- **Stablecoin detail Explore Next (`src/components/stablecoin-detail/explore-next-section.tsx`):** appended `trackerLinks` entry, gated the same way.
- **Methodology index (`src/app/methodology/page.tsx`):** single "Learn the mechanisms" callout near the top.
- **About (`src/app/about/page.tsx`):** inline link on the word "mechanisms" inside the Classification section.
- **Start Here (`src/lib/start-here-content.ts`):** single tile under the Learn / Reference group.

No footer entry. The hub is the only deep-link from `Mechanisms`-related surfaces; per-archetype pages are not surfaced anywhere in primary navigation.

---

## How to Add a New Archetype

1. Add the slug to `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts`.
2. Add the label + one-liner entries to `MECHANISM_ARCHETYPE_LABELS` and `MECHANISM_ARCHETYPE_ONE_LINERS` in `shared/lib/classification/mechanism-archetypes.ts`. The typechecker enforces exhaustiveness.
3. Add visuals to `ARCHETYPE_VISUALS` in `src/app/learn/mechanisms/content/types.ts` (pick a non-semantic accent border).
4. Author a new content module under `src/app/learn/mechanisms/content/<slug>.ts` and register it in `src/app/learn/mechanisms/content/index.ts`.
5. Add a `TITLE_BY_ARCHETYPE` and `DESCRIPTION_BY_ARCHETYPE` entry in `src/app/learn/mechanisms/[archetype]/page.tsx`.
6. Generate a new diagram component under `src/components/stablecoin-detail/mechanism-diagrams/<slug>-diagram.tsx` and wire it in `mechanismDiagramFor`.
7. Run `node scripts/maintenance/build-og-learn-images.mjs` and the `svg-to-png` skill on the new staged SVG.
8. Run `npm run check:archetype-explainer-coverage` until it passes; this is the gate.

---

## Out of Scope

- No FAQPage / LearningResource / Course JSON-LD
- No Worker-generated dynamic OG handler
- No per-step deep-links on the diagram SVG
- No archetype risk score, quiz, or simulator
- No internationalization
