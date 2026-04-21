# About Page

## Overview

The `/about/` route is the product overview for Pharos. It explains:

- why the project exists
- what the dashboard tracks directly
- what signals and scores it computes
- how the data pipeline is assembled
- where to find methodology, source code, and support channels

Primary implementation file:

- `src/app/about/page.tsx`

## Route Shell Contract

The route shell is owned directly by `src/app/about/page.tsx`.

- `metadata` sets the canonical path `/about/` plus route-specific title/description/Open Graph fields
- the page renders through `FeaturePageShell` with `breadcrumbName="About Pharos"`, `path="/about/"`, title `About Pharos`, and two lead paragraphs
- `headerSupplement` renders `AboutReferenceModule` immediately below the title/lead with six reference cards derived from `NAV_GROUPS.info` excluding `/about`: `/funding/`, `/methodology/`, `/coverage/`, `/about/api/`, `/status/`, and `/changelog/`
- the shell's `preface` injects FAQ JSON-LD describing why Pharos exists, what it tracks, how it classifies coins, and where the data comes from

## Section Contract

The page is organized into these sections, in order:

1. `Why Pharos?`
2. `Who Is Building Pharos?`
3. `Live Walkthrough`
4. `What Pharos Tracks`
5. `What Pharos Computes`
6. `Classification`
7. `Data Pipeline`
8. `Methodology`
9. `Disclaimer` (rendered as an `<aside>`, not a titled `AboutSection`)
10. `Get in Touch`

## Design And Interaction Rules

- The dedicated `Who Is Building Pharos?` section uses `lg:grid-cols-[auto_minmax(0,1fr)]` to place the contributor/logo strip beside the copy on `lg+`, stacking vertically below `lg` so the text column does not get crushed.
- `What Pharos Tracks` and `What Pharos Computes` use full-row links instead of small linked headings. This preserves larger touch targets on mobile and reduces the repeated tile-grid feel.
- CTA buttons keep `min-h-11` on mobile so the tap target does not collapse below the 44px floor.
- Accent use is reduced to a small set of section tones:
  - brand / identity: frost-blue
  - coverage / data sourcing: amber
  - computed signals: emerald
  - governance classification: violet
  - neutral/legal: zinc
- The data pipeline section should stay flat. Use a source-group list plus a 3-step flow summary rather than nested card grids.

## Navigation Contract

- `/about/` remains a top-level route, and primary navigation places it first in the `Reference` group (`NAV_GROUPS.info`).
- `/about/` is now the reference hub for low-frequency explainer surfaces. `Funding`, `Methodology`, `Coverage`, API Reference, Status, and Changelog are grouped around it in the reference module. `Start Here` is not part of the About reference module; it remains the conditional bottom-nav shortcut and footer link.
- `Peg Tracker` must link to `/depeg/`, because the dedicated depeg route owns the heatmap and depeg-history surface
- `Contagion Map` must link to `/dependency-map/`
- `Systemic Risk Scoreboard` remains linked to `/safety-scores/` because the stress-panel scoreboard lives on that route
- `Funding`, `Methodology`, broadcast, Telegram, GitHub, and profile links are surfaced as explicit CTAs rather than buried inline links

## Content Notes

- The page is public-facing product copy, so internal workflow references should stay clear and non-novelty-first.
- The `Get in Touch` copy describes Pharos as MIT-licensed open source and links to the GitHub repository.
- When adding a new major data source or externally visible feature surfaced on this page, update this document and the route copy together. The visible source roster lives in `DATA_SOURCE_GROUPS` in `src/app/about/page.tsx`; keep the route component as the current roster source instead of duplicating long provider lists here.
- Pricing copy should continue to disclose market-data sources, oracle sources, DEX-derived pricing, and protocol redemption quotes when they are externally visible in the UI.
- Reserve copy should describe issuer/protocol APIs, proof portals, dashboards, and direct on-chain/accounting reads as source families; detailed adapter coverage belongs in `docs/live-reserves.md`.
- DEX/yield source copy should describe source families and runtime blocking of dead/deprecated venues; detailed protocol lists belong in `docs/dex-liquidity.md` and `docs/yield-intelligence.md`.
- PSI copy should describe the current 30-minute cadence and the live formula inputs: active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend.
