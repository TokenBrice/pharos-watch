# Learn / Mechanisms Page

Contract for the educational explainer surfaces:

- `/learn/mechanisms/` — hub listing every configured archetype
- `/learn/mechanisms/[archetype]/` — per-archetype deep explainer

The broader `/learn/case-studies/` and `/learn/glossary/` surfaces are documented in [learn-page.md](./learn-page.md). Mechanisms are one section of the Learn namespace, not the only `/learn/*` route family.

Each configured `mechanismArchetype` gets a dedicated educational page covering the design, failure modes, and relevant Pharos signals. `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts` is the canonical roster.

---

## Route Shape

- **Hub shell:** `src/app/learn/mechanisms/page.tsx`
- **Archetype shell:** `src/app/learn/mechanisms/[archetype]/page.tsx`
- **Page-level shell (editorial display + breadcrumb):** `src/app/learn/_shared/learn-page-shell.tsx` (`LearnPageShell`)
- **Body section renderer:** `src/app/learn/mechanisms/explainer-shell.tsx` (`ArchetypeExplainerBody`)
- **Content registry:** `src/lib/mechanism-explainers/index.ts` (`ARCHETYPE_CONTENT`)
- **Per-archetype content modules:** `src/lib/mechanism-explainers/`; the index owns their exhaustive registration.
- **Content schema:** `src/lib/mechanism-explainers/types.ts` (`ArchetypeContent` interface)
- **Slug helpers and labels (single source of truth):** `shared/lib/classification.ts`
  - `MECHANISM_ARCHETYPE_LABELS`, `MECHANISM_ARCHETYPE_ONE_LINERS`
  - `getMechanismArchetypeLabel(archetype)`
  - `getMechanismExplainerPath(archetype)` returns `/learn/mechanisms/<slug>/`
- **Slug source:** `MECHANISM_ARCHETYPE_VALUES` in `shared/types/core.ts`
- **Diagram reuse:** `mechanismDiagramFor(archetype, "STBL")` draws generic diagrams for Learn/OG without coin facts. Learn captions scope `algorithmic` to historical UST-style pure mint/burn and `tbill` to the NAV-accreting variant. Introductions, metadata and shared descriptors cover the wider families: current algorithmic members can hold collateral; Treasury tokens can accrue NAV or hold $1 with separate/retained yield. Coin pages instead resolve `resolveMechanismFlowTemplate(archetype, symbol, facts, override)` and `resolveWrapperLayer`: `navToken === false` selects par redemption, `liquidationEngine === false` selects CDP reserve copy, and credit funds state no redemption cadence. Coin stress uses its structural path or own dated override incident; generic precedents never become coin facts.

The hub is a static route with no client-only state. The archetype route is static-exported via `generateStaticParams()` driven by `MECHANISM_ARCHETYPE_VALUES`.

Native V10 family explainers distinguish proportional UCITS/TRS fund shares from shared-pool
operational liabilities and bridge/vault/module position claims. All use accessible desktop
and mobile three-step diagrams with actual local stress paths; none silently falls back to
cash or Treasury backing. The hub's distribution reuses the existing non-frost chart palette
modulo its length, so taxonomy growth never produces an undefined segment color. The owning
[evidence standard](./process/mechanism-overlay-evidence-standard.md#native-family-admission-and-grading)
defines admission and charged unknowns; Learn content does not duplicate numeric calibration.

---

## Visual Identity

These pages use an editorial, divider-led composition instead of repeating dashboard cards for every section.

Current treatment:

- **Display title:** the `<h1>` uses `.pharos-page-title`; section/list headings use `.pharos-display` at a smaller fixed scale.
- **Section dividers:** hairline borders (`border-border/40`, `border-border/60`) between rows in lists and definition lists — no card chrome.
- **Diagram hero:** the mechanism diagram floats freely against the page background, no wrapping card, no kicker label. The diagram is the single editorial focal point per page.
- **Per-archetype identity:** the mechanism diagrams own differentiation; the shared page chrome stays neutral.

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
9. **"Tracked universe"** (`TrackedCoinList`) — active non-commodity coins via `getActiveByArchetype`, in canonical order with variants nested. Commodity pegs and unresolved effective archetypes are excluded by `shared/lib/stablecoins/by-mechanism.ts`. Footer links to the screener plus `+N upcoming` / `+N frozen` lifecycle links.
10. **"Case studies"** (`MechanismCaseStudies`) (optional, only when a study in `CASE_STUDY_LIST` is tagged with this archetype) — kicker + `<h2>` ("When this mechanism met a stress test") + `<ul>` of matching case studies in canonical list order. Each row: mono eyebrow + title + outcome chip (`CASE_STUDY_OUTCOME_CHIPS`/`_LABELS`), linking to `/learn/case-studies/<slug>/`. Server-rendered.
11. **"Continue reading"** — section above a top border. 2-column grid of color-on-hover row links (text + bottom border turn `frost-blue` on hover), with `ArrowUpRight` glyph.

The hub at `/learn/mechanisms/` renders the same shell with its own headline, a `LearnHero` summary band, a server-rendered Start Here cluster, a `MechanismComparisonMatrix`, and an editorial ordered table of contents. The matrix and each list row link to the archetype explainer. Lifecycle helpers supply tracked, upcoming, frozen, and decommissioned context; `MECHANISM_ARCHETYPE_VALUES` determines the row count and order.

---

## Metadata + SEO

- Title: hand-tuned per archetype, all ending in `, Explained` (see `MECHANISM_EXPLAINER_TITLES` in `src/lib/mechanism-explainer-registry.ts`, imported by the route module and reused by the OG-image script); template `%s | Pharos` adds the suffix.
- Description: hand-tuned per archetype, ~150-165 chars (see `DESCRIPTION_BY_ARCHETYPE` in the route module).
- Canonical: `getMechanismExplainerPath(archetype)`.
- Methodology cross-links retain the `/methodology/` page and target its current section anchors; algorithmic and synthetic-delta-neutral explanations link to `#pegscore-dews-methodology` for PegScore/DEWS. The mechanism registry test checks these cross-reference fragments against `METHODOLOGY_SECTIONS`.
- OG image: per-archetype static PNG at `public/og-learn-<slug>.png` (1200×628). [`og-images.md`](./og-images.md#3-mechanism-explainer-cards-publicog-learn-png) owns generation and review.
- JSON-LD: `BreadcrumbJsonLd` rendered by `LearnPageShell`, `DefinedTermSet` JSON-LD on the hub, Dataset JSON-LD for the public peg-mechanism distribution mirror, plus Article JSON-LD via the `ArchetypeArticleJsonLd` component (`buildArchetypeArticleJsonLd` in `src/lib/page-metadata.ts`) on each archetype page.

---

## Coverage Invariant

Ordinary noncritical domain tests split the invariant for every `MECHANISM_ARCHETYPE_VALUES` entry:

- `src/app/learn/mechanisms/__tests__/content.test.ts` requires a trimmed label and one-liner, non-stub headline and subtitle, at least one representative coin, and `TRACKED_META_BY_ID` resolution for every representative `coinId`.
- The existing `src/app/learn/mechanisms/[archetype]/__tests__/page.test.tsx` exact static-param test imports the route module and round-trips every slug.
- `src/app/__tests__/sitemap-frozen.test.ts` requires `/learn/mechanisms/<slug>/` membership for every archetype.

These suites run in the ordinary noncritical lane. `scripts/maintenance/build-og-learn-images.ts --check` regenerates source SVGs, verifies source/local-font signatures, and compares Firefox-rendered PNGs with committed assets through `scripts/lib/og-static-runner.mts`; it is not an existence-only check.

---

## Inbound Surfaces

- **Shared navigation:** `src/lib/nav-config.ts` `Resources` menu → `Research` column → `Mechanisms`, `Case Studies`, and `Glossary` in desktop/mobile navigation and the command palette
- **Coin detail (`src/components/stablecoin-detail/peg-stability-card.tsx`):** "Learn how X stablecoins work" link directly below the per-coin mechanism diagram, plus the (?) help glyph beside the Mechanism title, which opens a short primer (the diagram's own description) with a "Read the explainer" link rather than navigating on click. Both are gated on the resolved mechanism archetype.
- **Mechanism review fold (`src/components/stablecoin-detail/peg-stability-card.tsx`):** no separate explainer link; the mechanism review's notes and sources sit in the Mechanism card's `Review notes & sources (N)` fold (`#mechanism-review`), whose card already carries the gated "Learn how X stablecoins work" link and help-glyph primer.
- **Stablecoin detail Explore Next (`src/components/stablecoin-detail/explore-next-section.tsx`):** does **not** link the explainer (`PegStabilityCard` already carries that CTA); its archetype-gated slot is a canonical `/screener/?mechanisms=<archetype>&lifecycle=active` deep-link instead.
- **Methodology index (`src/app/methodology/page.tsx`):** single "Learn how each stablecoin design produces its peg" callout near the top.
- **About (`src/app/about/page.tsx`):** inline link on the word "mechanisms" inside the Classification section.
- **Start Here (`src/lib/start-here-content.ts`):** single tile under the Learn group.

No footer entry. The hub is the only entry in the header/mobile nav rail; per-archetype pages are reachable from the command palette's `Mechanism archetypes` section (`PALETTE_MECHANISMS` in `src/components/command-palette-model.ts`) and from in-page links on methodology, cemetery, and coin-detail surfaces.

---

## How to Add a New Archetype

1. Add the slug to `MECHANISM_ARCHETYPE_VALUES` in `shared/types/stablecoin-taxonomy.ts` (re-exported through `shared/types/core.ts`, which is what route modules import).
2. Add a descriptor to `MECHANISM_ARCHETYPE_DESCRIPTORS` in `shared/lib/classification.ts`; labels, short labels, CTA nouns and one-liners derive from it. The typechecker enforces exhaustiveness.
3. Author a new content module under `src/lib/mechanism-explainers/<slug>.ts` and register it in `src/lib/mechanism-explainers/index.ts`.
4. Add a `MECHANISM_EXPLAINER_TITLES` entry in `src/lib/mechanism-explainer-registry.ts` (which also drives the OG-image roster) and a `DESCRIPTION_BY_ARCHETYPE` entry in `src/app/learn/mechanisms/[archetype]/page.tsx`.
5. For a flow that fits the three-step pattern, add a `THREE_STEP_ARCHETYPE_CONFIG` entry in `src/components/stablecoin-detail/mechanism-diagrams/three-step-archetype-diagram.tsx` and a branch in `mechanismDiagramFor` (`index.tsx`), which reuses `ThreeStepArchetypeDiagram`. Coin pages pick it up through `resolveMechanismFlowTemplate` in `mechanism-template.ts`. Only build a dedicated `<slug>-diagram.tsx` component, plus its flow copy in `mechanism-template.ts`, if the flow needs a custom layout (as `synthetic-delta-neutral` does). A variant that differs by a coin-level fact rather than by archetype adds a second config beside the first, a field on `MechanismTemplateFacts` (`types.ts`) and a case in `resolveThreeStepConfig`. Never add a per-coin entry in `coin-overrides.ts` for it; that file is sized for a handful of flagship coins.
6. Run `tsx scripts/maintenance/build-og-learn-images.ts` to generate SVGs, rasterize PNGs, and update signatures, then review the changed images per [`og-images.md`](./og-images.md#3-mechanism-explainer-cards-publicog-learn-png).
7. Run the mechanism content, exact static-param, and sitemap suites listed in Coverage Invariant; regenerate the OG asset before running `npm run check:generated-artifacts`.

---

## Out of Scope

- No FAQPage / LearningResource / Course JSON-LD
- No Worker-generated dynamic OG handler
- No per-step deep-links on the diagram SVG
- No archetype risk score, quiz, or simulator
- No internationalization
