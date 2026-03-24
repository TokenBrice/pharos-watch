# Pharos Product Refinement Recommendations

Date: 2026-03-24

Scope:
- Broad repo/doc review
- Live-site pass across homepage, Start Here, Compare, Depeg, and stablecoin detail surfaces
- Focus on refinements, not net-new features

## Current Product Read

Pharos already has strong product depth, unusually good methodology discipline, and more trust-oriented surface area than most crypto dashboards. The main opportunities are not missing datasets; they are presentation and workflow refinements that make the existing system feel more authoritative, legible, and continuous.

Observed strengths:
- Distinctive product voice and visual system
- Serious methodology and documentation posture
- Strong research surface breadth across monitoring, detail, compare, coverage, and taxonomy
- Existing building blocks for freshness, coverage, and confidence already exist in code

Observed gaps:
- Trust signals are present but fragmented across banners, coverage, detail sections, and methodology links
- Homepage and major route top folds still ask users to interpret too much before they know what action to take
- Cross-surface movement works, but the product still feels like a set of excellent pages more than one continuous research workspace

## Top Three Refinement Additions

### 1. Elevate a product-wide trust layer

Turn existing freshness, coverage, confidence, and provenance signals into a compact, consistent language across the app.

Why this matters:
- Pharos competes on trust, not just feature count
- The raw inputs already exist: `StaleDataBanner`, `DataHealthBanner`, coverage matrix, price transparency, methodology/version links
- Today the product sometimes falls back to generic copy like "Some data is not yet available", which undersells how much Pharos actually knows about data quality

What this means in practice:
- Route-level confidence/freshness strip in hero/top-fold areas
- More precise copy for partial or unavailable datasets
- Consistent "live / delayed / partial / structural-only" language
- Clear last-successful timestamps and completeness summaries where they matter most

### 2. Tighten information hierarchy on the homepage and major route entrances

Make each top-level surface more decisive about its job:
- homepage = live triage
- detail page = research dossier
- compare = decision surface
- coverage/methodology/about = trust surfaces

Why this matters:
- The product is now broad enough that users can feel "impressed but slightly overloaded"
- The homepage in particular is strong, but still carries too many competing priorities in the first scroll
- The detail page is dense and valuable, but its first-render and section framing can feel more like a polished dossier than a loaded app view

What this means in practice:
- Sharper top-fold framing and section priority
- More disciplined route-specific intros
- Reduce generic repeated copy and duplicated bottom-of-page navigation language
- Improve first-render perception on high-value landing pages

### 3. Improve workflow continuity across surfaces

Refine how state and context survive movement between homepage, detail, compare, taxonomy, and coverage pages.

Why this matters:
- Pharos is increasingly a working surface, not just a reading surface
- Users should feel like they are carrying an investigation forward, not starting over on each page
- Existing pieces already support this direction: compare-from-here, explore-next, Start Here, command palette, taxonomy routes

What this means in practice:
- Preserve filter/search/sort context when moving out of tables and back
- Keep compare intent and recent selection context warmer across pages
- Make "next best move" cues more context-aware and less generic
- Reduce reset friction for repeated research sessions

## Recommendation Order

1. Product-wide trust layer
2. Homepage and route-entrance hierarchy pass
3. Cross-surface workflow continuity

## Why these three

They improve credibility, clarity, and repeat-use behavior without expanding scope. They also compound: better trust cues make the hierarchy clearer, and better hierarchy makes workflow continuity more valuable.
