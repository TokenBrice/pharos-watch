# Wrapper Variant Browse IA Checkpoint

Date: 2026-04-22
Status: Approved for implementation
Source plan: `agents/plans/2026-04-22-wrapper-variant-framework-follow-up-implementation-plan.md` Phase 3A

## Decision

The owning browse surface for tracked variants remains the homepage stablecoin table on `/`, using the existing URL-backed `variant` query param.

No new dedicated route family is approved.

## Why This Owner Wins

### Candidate 1: Homepage table on `/`

Pros:

- already exists and already carries a URL-backed filter contract through `useHomepageFilters()`
- is the highest-traffic browse surface and the natural first-stop directory
- keeps discovery aligned with the flat market-cap-sorted universe instead of creating a parallel taxonomy
- avoids new sitemap, canonical, and noindex complexity

Cons:

- variant discovery is currently stronger for users who already know the detail pages than for cold users
- the owner needs explicit secondary-entry links from detail surfaces so the homepage filter is not a hidden affordance

### Candidate 2: `/stablecoins/`

Pros:

- already exists as a browse hub
- route family is already indexable and taxonomy-oriented

Cons:

- current taxonomy ownership is by peg / governance / backing / infrastructure, not parent-child product relationships
- reusing it for variants would create a second top-level browse owner instead of clarifying ownership
- it adds route and canonical ambiguity without solving a real product gap that `/` cannot solve

### Rejected exceptions

- dedicated `/stablecoins/variants/*` route family: rejected
- dedicated non-indexable variants surface: rejected

Reason: neither existing owner fails badly enough to justify a new surface.

## Owner Contract

Primary owner:

- route: `/`
- state: `?variant=<filter-tag>`
- current accepted values:
  - `variant-tracked`
  - `variant-savings-passthrough`
  - `variant-risk-absorption`

Extension rule:

- new variant-family values may be added only through a later approved family spec
- added values must stay on the same `variant` query param instead of creating a second owner

## Canonical / Sitemap / Crawl Policy

- canonical owner remains `/`
- filtered homepage states stay query-param states only and canonicalize to `/`
- filtered states do not get separate sitemap entries
- no new `noindex` route is introduced for variants
- `docs/README.md` remains the route-inventory owner for this choice

## JSON-LD / OG Ownership

- homepage route keeps the primary browse-surface metadata ownership
- no filter-specific JSON-LD or OG variant is added for homepage query states
- detail pages may add secondary links into the owning homepage filter state, but they do not become alternate browse owners

## Secondary-Surface Rules

- detail pages:
  - may link to the homepage owner using the relevant `?variant=` state
  - may keep parent/sibling relationship cards as contextual navigation only
- `/stablecoins/` taxonomy pages:
  - remain taxonomy pages, not the primary variant browse owner
  - may mention variant filters only as secondary pointers if needed
- command palette:
  - deferred

## UX Acceptance

The IA is accepted when:

1. A user can discover tracked variants from the homepage without already knowing a specific detail page.
2. Variant browse state is durable and shareable via the `variant` query param.
3. Detail pages for parents and children point clearly into the homepage owner rather than implying a second browse owner.
4. Docs and route inventory reflect that `/` owns variant browse state and that no dedicated variant route family exists.
