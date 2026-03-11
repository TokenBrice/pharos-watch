# Pharos Onboarding Page - Implementation Plan

**Date:** 2026-03-11  
**Status:** Proposed  
**Research doc:** [2026-03-11-pharos-onboarding-page-research.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/2026-03-11-pharos-onboarding-page-research.md)  
**Primary systems affected:** frontend route structure, navigation/discovery surfaces, static metadata/docs  
**Risk level:** Low to medium, because this is a new static page plus a few discovery touchpoints, but it changes public information architecture

## Purpose

This plan prepares the implementation of a new public page that helps first-time users understand what Pharos does, what the major scores mean, and where to start based on their goal.

The page should reduce confusion without flattening the product into a tutorial.

It is explicitly **not**:

- a modal tour
- a forced first-run flow
- a second homepage
- a second methodology page

## Product Decisions

These decisions are recommended for implementation unless the product direction changes before execution.

### Route and naming

- Internal project name: `Pharos Onboarding`
- Public label: `Start Here`
- Route: `/start/`

Reasoning:

- short, easy to share
- more user-friendly than `/onboarding/`
- distinct from the homepage without sounding internal

### Visibility and indexing

- public and indexable
- included in sitemap
- optional, never forced

### Content model

- fully static and server-rendered
- no live API dependencies
- curated copy, not auto-generated from nav config

Reasoning:

- keeps the page fast and reliable under static export
- avoids stale loading/error states on what should be a calm entry page
- lets the team sequence the product intentionally instead of mirroring the raw nav

### Discovery strategy

The page should be discoverable from:

- homepage
- desktop sidebar
- mobile drawer
- footer
- command palette

But it should remain secondary to the dashboard as the primary front door.

## Scope

In scope:

- new onboarding route at `/start/`
- static onboarding content and page composition
- homepage callout linking to the new page
- sidebar/mobile-drawer/footer discovery touchpoints
- sitemap inclusion
- architecture/design-language documentation updates

Out of scope:

- guided tours, tooltip onboarding, or localStorage progress tracking
- user-specific completion state
- major homepage redesign beyond a compact CTA/callout
- methodology or scoring changes
- new analytics infrastructure
- custom OG image generation for the route

## UX Goals

The page must help a new user answer four questions quickly:

1. What is Pharos for?
2. Where should I start?
3. What do the main scores mean?
4. Which page matches my job?

Success means a first-time user can choose a path in under 30 seconds.

## Recommended Information Architecture

## Section 1 - Hero and Goal Selector

Above the fold:

- one direct headline
- one plain-English support line
- 4 or 5 route-by-goal cards

Recommended goal cards:

- `Check market health`
- `Research one stablecoin`
- `Compare several coins`
- `Find safer yield`
- `Set up alerts`

Each card should:

- explain the goal in one line
- list the destination page(s)
- include one decisive CTA

## Section 2 - What Pharos Tracks

Compact trust strip only:

- tracked stablecoin count
- peg coverage count
- update cadence
- short list of what is covered:
  - peg stress
  - liquidity
  - safety grades
  - dependency risk
  - blacklist events
  - mint/burn flows
  - yield

This should feel like a credibility panel, not a feature dump.

## Section 3 - How To Read Pharos

Plain-English glossary for the minimum vocabulary needed to navigate the product.

Recommended glossary items:

- `Peg score`
- `DEWS`
- `Safety score`
- `Liquidity score`
- `Dependency risk`
- `PYS`
- `PSI`

Constraint:

- explain meaning, not formulas
- link to `/methodology/` for deeper detail

## Section 4 - Guided Paths

Recommended path modules:

- `In 60 seconds`
  - Dashboard -> Stability Index -> Depeg Tracker
- `Research one coin`
  - search/detail -> Safety Scores -> Liquidity -> Dependency Map
- `Build a shortlist`
  - Compare -> Portfolio -> Telegram Alerts
- `Yield with guardrails`
  - Yield -> Safety Scores -> stablecoin detail

Each module should include:

- intended user
- what they will learn
- 3-step route
- final CTA

## Section 5 - Feature Atlas

Group the feature set by job, not by current nav taxonomy.

Recommended groups:

- `Monitor`
- `Research`
- `Operate`
- `Learn`

Every major feature page should appear here at least once.

## Section 6 - Shortcuts

Compact bottom section for power adoption:

- `Ctrl/Cmd+K` command palette
- browse by peg/backing/governance
- compare presets
- portfolio presets
- Telegram alerts and digest delivery

This is optional discovery, not first-fold content.

## Content and Component Strategy

## Preferred implementation shape

Create a small dedicated content module and a single page-composition component:

- [src/app/start/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/start/page.tsx)
- [src/components/start-here-page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/start-here-page.tsx)
- [src/lib/start-here-content.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/start-here-content.ts)

Reasoning:

- keeps the page maintainable without over-fragmenting it
- gives the content a single source of truth
- makes future copy changes easier than editing JSX spread across many files

## Reuse guidance

Reuse existing visual language where possible:

- `FeaturePageShell` for breadcrumb/title framing if it fits cleanly
- `pharos-card-shell`
- `pharos-focus-ring`
- `pharos-kicker`
- existing onboarding/access-surface visual language from `EmptyStateSurface`

Do not create new global tokens unless implementation proves they are necessary.

## Discovery Touchpoints

## Homepage

Add a compact CTA/callout near the top of the homepage so first-time users see the route early.

Preferred target:

- [src/components/homepage-client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/homepage-client.tsx)

Constraint:

- this CTA should support the dashboard, not compete with it
- it should stay compact and not push the live table materially lower

## Sidebar and mobile drawer

Add `Start Here` as a secondary nav item rather than as a new primary analytics destination.

Preferred implementation:

- add the route to `BOTTOM_NAV_ITEMS` in [src/lib/nav-config.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/nav-config.ts)
- update [src/components/header.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/header.tsx) to render bottom-nav items in the mobile drawer as a small secondary section

Effect:

- desktop sidebar gets the link automatically
- command palette indexes it automatically
- mobile users can discover it in the drawer without bloating the main grouped nav

## Footer

Add `Start Here` to the footer primary links in [src/components/footer.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/footer.tsx).

## Sitemap

Add `/start/` to [src/app/sitemap.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/sitemap.ts).

No `robots` change is needed.

## Metadata Strategy

Use [src/lib/page-metadata.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/page-metadata.ts) to build route metadata.

Recommended title:

- `Start Here: How to Use Pharos`

Recommended description:

- concise overview of market monitoring, research, comparison, alerts, and yield tools

Initial OG image:

- reuse default site OG card for now

Custom onboarding OG artwork is optional follow-up, not launch scope.

## Documentation Updates Required

Implementation must update:

- [docs/architecture.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
- [docs/design-language.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/design-language.md)

Recommended doc notes:

- new `src/app/start/` route in the curated file tree
- any new shared onboarding-page pattern if one emerges beyond the current first-run empty-state surfaces

No methodology docs should change.

## File-Level Plan

### New files

- [src/app/start/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/start/page.tsx)
- [src/components/start-here-page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/start-here-page.tsx)
- [src/lib/start-here-content.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/start-here-content.ts)

### Updated files

- [src/components/homepage-client.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/homepage-client.tsx)
- [src/lib/nav-config.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/nav-config.ts)
- [src/components/header.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/header.tsx)
- [src/components/footer.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/footer.tsx)
- [src/app/sitemap.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/sitemap.ts)
- [docs/architecture.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
- [docs/design-language.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/design-language.md)

Potentially updated only if implementation needs it:

- [src/components/command-palette.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/command-palette.tsx)

Expected default: no direct change needed if nav config integration is clean.

## Execution Phases

## Phase 1 - Content Model and Route Shell

Goal:

- establish the route
- define the static content source
- wire metadata

Deliverables:

- `/start/` page exists and exports cleanly
- content arrays/constants live in a dedicated module
- page composes without API hooks or client-only state

## Phase 2 - Core Onboarding Sections

Goal:

- build the actual onboarding experience

Deliverables:

- hero goal selector
- trust strip
- glossary
- guided paths
- feature atlas
- shortcuts section

Constraint:

- keep the first meaningful CTA above the fold on mobile

## Phase 3 - Discovery Touchpoints

Goal:

- make the page easy to find without overloading the primary nav

Deliverables:

- homepage callout
- sidebar secondary item
- mobile drawer secondary item
- footer link
- command palette discoverability via nav integration
- sitemap entry

## Phase 4 - Docs and QA

Goal:

- bring repo docs and verification in line with shipped behavior

Deliverables:

- architecture and design-language docs updated
- route verified on desktop and mobile
- navigation/discovery checks completed

## Acceptance Criteria

- `/start/` clearly explains what Pharos is for in plain language.
- A new user can choose a goal-driven path without reading long prose first.
- The page explains core terms without duplicating methodology detail.
- All major Pharos features are represented somewhere in the page.
- The page is reachable from homepage, sidebar, mobile drawer, footer, and command palette.
- The page has no loading, empty, or error states tied to live data.
- The page feels visually consistent with existing Pharos onboarding/access surfaces.
- The dashboard remains the main landing page and onboarding remains optional.

## Verification Standard

Implementation must finish with:

```bash
npm run build
npm run lint
npm test
```

Recommended route checks:

- `/`
- `/start/`
- `/about/`

Recommended UX checks:

- desktop sidebar shows `Start Here`
- mobile drawer shows `Start Here`
- footer includes `Start Here`
- command palette returns `Start Here`
- homepage CTA to `/start/` is visible without dominating the fold
- `/start/` renders correctly at `1440x1200`
- `/start/` renders correctly at `390x844`

Recommended screenshot set:

- homepage desktop/mobile
- onboarding page desktop/mobile
- mobile drawer open with `Start Here` visible

## Risks and Guardrails

### Risk: the page becomes a second methodology page

Guardrail:

- keep copy task-oriented
- link out for formulas

### Risk: the page becomes too long and list-heavy

Guardrail:

- prioritize routing over completeness above the fold
- keep the feature atlas below the guided paths

### Risk: discovery changes bloat navigation

Guardrail:

- treat `Start Here` as a secondary item
- avoid adding it to the main analytics groups

### Risk: homepage CTA competes with live market content

Guardrail:

- keep the CTA compact
- place it as a lightweight support module, not a dominant hero replacement

## Bottom Line

The implementation should be straightforward if it stays disciplined:

- static page
- curated content
- strong first-fold routing
- limited but intentional discovery touchpoints

That is enough to make Pharos easier for first-time users without turning the product into a guided app.
