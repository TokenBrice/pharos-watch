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
- the page opens on a modest signature hero: a frost-blue tracked-stablecoin figure, the editorial lede and byline, and a neutral stat strip for active, frozen, pre-launch, and source counts
- the shell's `preface` injects `AboutPage` JSON-LD (its `mentions` cover the API/data catalog, coverage matrix, data pipeline, methodology, principles, and funding); the FAQ (`FAQPage`) JSON-LD is emitted separately by `FaqSection` (`includeJsonLd`)
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
- Section cards stay flat with no per-section accent color; `frost-blue` is reserved for the brand hero numeral and inline link-hover states.
- The data pipeline section should stay flat. Use a source-group list plus a 3-step flow summary rather than nested card grids.

## Navigation Contract

- `/about/` remains a top-level route in the `Reference` group (the `NAV_GROUPS` entry keyed `"reference"`).
- `/about/` is the reference hub for low-frequency reference surfaces. `Funding`, `Methodology`, and `Coverage` sit beside it in the top-nav `Reference` group. Learn surfaces stay in the Learn group; API Access, Changelog, and System Status stay in the lighthouse menu.
- `Peg Tracker` must link to `/depeg/`, because the dedicated depeg route owns the heatmap and depeg-history surface
- `Contagion Map` must link to `/dependency-map/`
- `Systemic Risk Scoreboard` remains linked to `/safety-scores/` because the stress-panel scoreboard lives on that route
- `Methodology`, broadcast, Telegram, GitHub, and profile links are explicit CTAs; `Funding` and the public `/docs/listing-policy/` reference are inline prose links.
- Trust-policy links use `/about/#principles`, `/about/#editorial-ai-policy`, and `/about/#corrections-policy`.

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
- The DEX source roster includes pinned Uniswap V3 and PancakeSwap V3 QuoterV2/factory RPC reads as a shadow measured-depth producer. Listing the source does not imply score eligibility: deployment cohorts remain activation-pending until their replay, equivalence, drift, and shadow evidence is approved.
- The DEX source roster includes Stellar Horizon only for classic-AMM pool discovery. Soroban contract-token deployments remain an explicit native-indexer limit rather than being presented as covered by Horizon.
- The visible reference-source roster currently includes New York Fed EFFR, FRED DFF fallback, FRED and ALFRED `IUDZOS2` SONIA Compounded Index mirrors (with Bank of England IADB `IUDZOS2` fallback), CBR DailyInfo `KeyRateXML`, CBRT EVDS BIST TLREF `TP.BISTTLREF.ORAN`, and Midas NAV-oracle coverage for Yield Intelligence; keep those aligned with `docs/yield-intelligence.md` when benchmark or yield-oracle sources change.
- L2BEAT is disclosed as a static Chain Health chain-risk snapshot and Safety Score bridge-route review source, not as a live worker fetch.
- PSI copy should describe the current 30-minute cadence and the live formula inputs: active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend. It must also state that the monetary aggregate includes core stablecoins and cash equivalents while excluding tracked variants and stable-value investment products.
