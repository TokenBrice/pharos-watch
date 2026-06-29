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
- `src/app/about/content.ts` for the visible source roster and reusable section copy

## Route Shell Contract

The route shell is owned directly by `src/app/about/page.tsx`.

- `metadata` sets the canonical path `/about/` plus route-specific title/description/Open Graph fields
- the page renders through `FeaturePageShell` with `breadcrumbName="About Pharos"`, `path="/about/"`, title `About Pharos`, and two lead paragraphs
- `headerSupplement` renders `AboutReferenceModule` immediately below the title/lead with reference cards derived from the `NAV_GROUPS` entry keyed `"reference"` (`NAV_GROUPS.find((g) => g.key === "reference")`) excluding `/about`: `/methodology/`, `/coverage/`, and `/funding/`. Learn surfaces such as `/learn/mechanisms/` live in the separate Learn group; API, changelog, and status live in the lighthouse overflow menu.
- the shell's `preface` injects FAQ JSON-LD describing why Pharos exists, what it tracks, how it classifies coins, and where the data comes from
- the same FAQ items render visibly near the bottom of the page, before the disclaimer, so the `FAQPage` JSON-LD matches user-visible Q&A content
- the public trust material lives inline on `/about/`: `#principles` states the editorial/product principles, `#editorial-ai-policy` states the AI-content policy, and `#corrections-policy` states the corrections path.

## Section Contract

The page is organized into these sections, in order:

1. `Why Pharos?`
2. `Principles, AI Policy, and Corrections`
3. `Who Is Building Pharos?`
4. `Live Walkthrough`
5. `What Pharos Tracks`
6. `What Pharos Computes`
7. `Companion Experiences`
8. `Classification`
9. `Data Pipeline`
10. `Methodology`
11. `About Pharos FAQ`
12. `Disclaimer` (rendered as an `<aside>`, not a titled `AboutSection`)
13. `Get in Touch`

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

- `/about/` remains a top-level route in the `Reference` group (the `NAV_GROUPS` entry keyed `"reference"`).
- `/about/` is the reference hub for low-frequency reference surfaces. `Funding`, `Methodology`, and `Coverage` are grouped around it in the reference module. Learn surfaces such as Mechanisms stay in the Learn navigation group; API Access, Changelog, and System Status stay in the lighthouse overflow menu; `Start Here` remains the conditional bottom-nav shortcut.
- `Peg Tracker` must link to `/depeg/`, because the dedicated depeg route owns the heatmap and depeg-history surface
- `Contagion Map` must link to `/dependency-map/`
- `Systemic Risk Scoreboard` remains linked to `/safety-scores/` because the stress-panel scoreboard lives on that route
- `Funding`, `Methodology`, broadcast, Telegram, GitHub, and profile links are surfaced as explicit CTAs rather than buried inline links
- Standalone `/about/principles/`, `/about/editorial/`, and `/about/style/` routes were retired; link to `/about/#principles`, `/about/#editorial-ai-policy`, or `/about/#corrections-policy` when a trust-policy anchor is needed.

## Content Notes

- The page is public-facing product copy, so internal workflow references should stay clear and non-novelty-first.
- The `Get in Touch` copy describes Pharos as MIT-licensed open source and links to the GitHub repository.
- When adding a new major data source or externally visible feature surfaced on this page, update this document and the route copy together. The visible source roster lives in `DATA_SOURCE_GROUPS` in `src/app/about/content.ts`; keep that module as the current roster source instead of duplicating long provider lists here.
- Pricing copy should continue to disclose market-data sources, oracle sources, DEX-derived pricing, and protocol redemption quotes when they are externally visible in the UI.
- Supply & Price copy should disclose scoped FX-par redemption quotes and curated fail-closed on-chain supply repairs when they affect public `priceSource` or `supplySource` fields.
- Reserve copy should describe issuer/protocol APIs, proof portals, dashboards, and direct on-chain/accounting reads as source families; detailed adapter coverage belongs in `docs/live-reserves.md`.
- Regulatory register copy should disclose both EU MiCA register/NCA sources and U.S. GENIUS implementation-watch sources when `/compliance/` surfaces them.
- EUR stablecoin reference copy should disclose eurostablecoins.xyz when its coverage API is used for EUR-specific market-availability labels, chain-gap audits, or MiCA issuer cross-checks.
- DEX/yield source copy should describe source families, explicitly label optional gated sources such as vaults.fyi when they are not default live ranking inputs, and describe runtime blocking of dead/deprecated venues; detailed protocol lists belong in `docs/dex-liquidity.md` and `docs/yield-intelligence.md`.
- The visible reference-source roster currently includes New York Fed EFFR, FRED DFF fallback, FRED and ALFRED `IUDZOS2` SONIA Compounded Index mirrors (with Bank of England IADB `IUDZOS2` fallback), CBR DailyInfo `KeyRateXML`, CBRT EVDS BIST TLREF `TP.BISTTLREF.ORAN`, and Midas NAV-oracle coverage for Yield Intelligence; keep those aligned with `docs/yield-intelligence.md` when benchmark or yield-oracle sources change.
- L2BEAT is disclosed as a static Chain Health chain-risk snapshot and Safety Score bridge-route review source, not as a live worker fetch.
- PSI copy should describe the current 30-minute cadence and the live formula inputs: active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend.
