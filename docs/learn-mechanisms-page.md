# Learn / Mechanisms Page

Contract for the educational explainer surfaces:

- `/learn/mechanisms/` — hub listing all five archetypes
- `/learn/mechanisms/[archetype]/` — per-archetype deep explainer

Each tracked stablecoin carries a `mechanismArchetype` field. The five values (`fiat-cash`, `tbill`, `cdp`, `synthetic-delta-neutral`, `algorithmic`) each get a dedicated educational page that walks through the design, its failure modes, and which Pharos signals are most informative for that archetype.

---

## Route Shape

- **Hub shell:** `src/app/learn/mechanisms/page.tsx`
- **Archetype shell:** `src/app/learn/mechanisms/[archetype]/page.tsx`
- **Shared rendering body:** `src/app/learn/mechanisms/explainer-shell.tsx` (`ArchetypeExplainerBody`)
- **Content registry:** `src/app/learn/mechanisms/content/index.ts` (`ARCHETYPE_CONTENT`)
- **Per-archetype content modules:** `src/app/learn/mechanisms/content/{fiat-cash,tbill,cdp,synthetic-delta-neutral,algorithmic}.ts`
- **Content schema:** `src/app/learn/mechanisms/content/types.ts` (`ArchetypeContent` interface, `ARCHETYPE_VISUALS` map)
- **Slug helpers (single source of truth):** `shared/lib/classification/mechanism-archetypes.ts`
  - `MECHANISM_ARCHETYPE_LABELS`, `MECHANISM_ARCHETYPE_ONE_LINERS`
  - `getMechanismArchetypeLabel(archetype)`
  - `getMechanismExplainerPath(archetype)` returns `/learn/mechanisms/<slug>/`
- **Slug source:** `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts`
- **Diagram reuse:** `mechanismDiagramFor(archetype, "USDX")` from `src/components/stablecoin-detail/mechanism-diagrams/index.tsx`

Both routes are static-exported via `generateStaticParams()` driven by `MECHANISM_ARCHETYPE_VALUES`. No client-only state.

---

## Visual Identity

Per-archetype accent borders + kicker colors, defined once in `ARCHETYPE_VISUALS`:

| Archetype                 | Border               | Kicker pair                            |
| ------------------------- | -------------------- | -------------------------------------- |
| fiat-cash                 | `border-l-blue-500`  | `text-blue-700 dark:text-blue-400`     |
| tbill                     | `border-l-violet-500`| `text-violet-700 dark:text-violet-400` |
| cdp                       | `border-l-cyan-500`  | `text-cyan-700 dark:text-cyan-400`     |
| synthetic-delta-neutral   | `border-l-teal-500`  | `text-teal-700 dark:text-teal-400`     |
| algorithmic               | `border-l-rose-500`  | `text-rose-700 dark:text-rose-400`     |

Excludes amber (Safety Score), red/green (peg severity), emerald (PoR big4) to avoid semantic collisions.

---

## Page Anatomy

Each `/learn/mechanisms/[archetype]/` page renders, top-to-bottom:

1. **`FeaturePageShell` header** — `breadcrumbItems: [Home, Learn, <Archetype>]`, `variant="longform"`, `containerClassName="mx-auto w-full max-w-[68rem] space-y-8"`, `leadParagraphs={[subtitle, ...lead]}`.
2. **Diagram hero** — `pharos-card-shell` with accent border, renders `mechanismDiagramFor(archetype, "USDX")`.
3. **"How it works"** — `<ol>` of 3 numbered steps (titles aligned with diagram step labels).
4. **"Where the design fails"** — `<dl>` of 3–4 named failure modes with concrete historical events.
5. **"What to watch on Pharos"** — `<ul>` of 4–6 cards (`pharos-card-shell` + archetype border) pointing at specific Pharos features.
6. **"Tracked examples"** — `pharos-interactive-card` grid linking to 4–5 representative coin detail pages.
7. **"Variations"** — short prose paragraphs naming sub-flavors within the archetype.
8. **"Related"** — cross-link footer (3–5 links to `/methodology/`, sibling archetypes, taxonomy hubs).

The hub at `/learn/mechanisms/` renders the same shell plus a 2-column card grid of all five archetypes, each card embedding the matching mechanism diagram.

---

## Metadata + SEO

- Title pattern: `<Archetype> Stablecoins, Explained` (template `%s | Pharos` adds the suffix).
- Description: hand-tuned per archetype, ≤160 chars (see `DESCRIPTION_BY_ARCHETYPE` in the route module).
- Canonical: `getMechanismExplainerPath(archetype)`.
- OG image: per-archetype static PNG at `public/og-learn-<slug>.png` (1200×628). Regenerated via `node scripts/maintenance/build-og-learn-images.mjs` followed by the `svg-to-png` skill against the staged SVGs.
- JSON-LD: `BreadcrumbJsonLd` via `FeaturePageShell`. Article-level structured data is owned by future work; not in v1.

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

- **Sidebar:** `src/lib/nav-config.ts` REFERENCE group → `Mechanisms` (Lightbulb icon) → `/learn/mechanisms`
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

## Out of Scope (v1)

- No `/learn/` root index page (defer until a second `/learn/*` topic exists)
- No FAQPage / LearningResource / Course JSON-LD
- No Worker-generated dynamic OG handler
- No per-step deep-links on the diagram SVG
- No archetype risk score, quiz, or simulator
- No internationalization
