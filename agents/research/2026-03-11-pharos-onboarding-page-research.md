# Pharos Onboarding Page Research - 2026-03-11

## Scope

This document covers research only for a new public page intended to help first-time users discover, understand, and use Pharos. It does not propose implementation details at the component level yet.

Working name: `Pharos Onboarding`

Recommended user-facing label: `Start Here` or `New to Pharos`

Reason: "Onboarding" is a useful internal name, but "Start Here" is clearer and less product-internal in the UI.

## Sources Reviewed

- `src/lib/nav-config.ts`
- `src/app/page.tsx`
- `src/components/homepage-client.tsx`
- `src/components/feature-highlights.tsx`
- `src/app/about/page.tsx`
- `src/app/methodology/page.tsx`
- `src/app/compare/page.tsx`
- `src/app/compare/client.tsx`
- `src/components/compare-empty-state.tsx`
- `src/app/portfolio/page.tsx`
- `src/app/portfolio/client.tsx`
- `src/components/portfolio-empty-state.tsx`
- `src/components/empty-state-surface.tsx`
- `src/components/sidebar.tsx`
- `src/components/header.tsx`
- `src/components/command-palette.tsx`
- `src/app/stability-index/page.tsx`
- `src/app/safety-scores/page.tsx`
- `src/app/yield/page.tsx`
- `src/app/liquidity/page.tsx`
- `src/app/depeg/page.tsx`
- `src/app/flows/page.tsx`
- `src/app/blacklist/page.tsx`
- `src/app/dependency-map/page.tsx`
- `src/app/digest/page.tsx`
- `src/app/cemetery/page.tsx`
- `src/app/telegram/page.tsx`
- `docs/architecture.md`
- `docs/design-language.md`
- `agents/audits/2026-03-07-design-audit-pharos-watch.md`
- `/home/ahirice/.agents/skills/onboard/SKILL.md`

## Current Product Surface

Pharos already has a large public surface:

- `156` tracked stablecoins
- `16` main navigation destinations across `4` nav groups plus the dashboard
- multiple discovery layers beyond the nav:
  - homepage table + filters
  - stablecoin detail pages
  - taxonomy landing pages by peg, backing, and governance
  - command palette
  - compare and portfolio presets
  - Telegram alerts and digest channel

The product is not lacking explanations at the page level. It is lacking a site-level "how to start" layer that translates the system into beginner jobs.

## Main Finding

The onboarding problem is not "users do not know what Pharos does."

The onboarding problem is "new users do not know where to begin, what each feature is for, or which metrics matter first."

Today Pharos behaves like a strong research terminal with many well-built destinations, but it expects users to self-route too early.

## First-Time User Friction

### 1. Too many valid starting points

A new user can begin from:

- the homepage dashboard
- the stablecoin directory table
- a stablecoin detail page
- the nav groups
- command palette
- a shared link to a compare page, digest, or depeg tracker

That is flexible for power users, but ambiguous for first-timers.

### 2. High jargon density very early

Pharos introduces several internal terms quickly:

- PSI
- DEWS
- peg score
- safety score
- dependency risk
- PYS
- bank run gauge

Each term is defensible, but the system currently assumes too much context too soon.

### 3. Feature discovery is broad, not guided

The homepage exposes many modules and the sidebar has good taxonomy, but neither answers the beginner question:

"I am here for one specific job. Where do I go first?"

### 4. Documentation exists, but is not beginner sequencing

`About` and `Methodology` are useful references. They are not the right first stop for most users because they explain the system, not the fastest path to value.

### 5. Local onboarding exists, but only inside specific tools

`Compare` and `Portfolio` already use strong first-run empty states. That pattern proves the product benefits from guided entry, but it is only present after the user has already chosen a tool.

## Onboarding Goal

The page should not try to teach every feature in full.

It should do five things:

1. Explain what Pharos is in one plain sentence.
2. Help users self-identify their goal in under 30 seconds.
3. Teach the minimum vocabulary needed to read the product.
4. Route users to the right page in one click.
5. Surface the rest of the feature set as optional exploration, not required reading.

## Recommended Product Framing

The cleanest framing is:

`Pharos helps you monitor the stablecoin market, research individual coins, compare risk, and set up ongoing surveillance.`

That framing is easier for new users than listing every feature independently.

## Primary User Jobs

The onboarding page should be organized around user intent, not the current menu taxonomy.

### 1. "Is the market calm or stressed right now?"

Best destinations:

- Dashboard
- Stability Index
- Depeg Tracker
- Daily Digest

### 2. "I need to understand one stablecoin."

Best destinations:

- Stablecoin detail page
- Safety Scores
- DEX Liquidity
- Dependency Map

### 3. "I want to compare several stablecoins."

Best destinations:

- Compare
- Portfolio
- Safety Scores

### 4. "I want to monitor risk continuously."

Best destinations:

- Telegram Alerts
- Depeg Tracker
- Blacklist Tracker
- Mint/Burn Flows

### 5. "I want yield without losing sight of risk."

Best destinations:

- Yield Intelligence
- Safety Scores
- Stablecoin detail page

## Recommended Information Architecture

### Section 1: Hero and Path Selection

Purpose:

- state the product value plainly
- reduce decision fatigue immediately
- route users into a first action

Content:

- short title
- one-sentence value proposition
- 4 or 5 "choose your goal" cards
- one lightweight note that advanced users can skip this page and use search/nav directly

Recommended CTA card set:

- `Check market health`
- `Research one stablecoin`
- `Compare several coins`
- `Find safer yield`
- `Set up alerts`

This should be the main above-the-fold experience.

### Section 2: What Pharos Tracks

Purpose:

- build trust quickly
- answer "how broad is this?"

Content:

- tracked stablecoin count
- update cadence
- coverage areas:
  - peg behavior
  - liquidity
  - safety grades
  - dependency risk
  - blacklist events
  - mint/burn flows
  - yield

This should stay compact. It is a credibility strip, not a full feature dump.

### Section 3: How To Read Pharos

Purpose:

- remove jargon friction

Content:

- a mini glossary in plain English

Recommended glossary set:

- `Peg score`: how tightly a coin has held its target
- `DEWS`: early warning stress score before a full depeg
- `Safety score`: overall risk grade across key dimensions
- `Liquidity score`: how much on-chain depth and trading support a coin has
- `Dependency risk`: how much a coin relies on other stablecoins or upstream collateral
- `PYS`: risk-adjusted yield score
- `PSI`: market-wide stablecoin health score

This section should explain meaning, not formulas. Formulas belong in `Methodology`.

### Section 4: Guided Paths

Purpose:

- convert feature discovery into simple workflows

Recommended path modules:

- `In 60 seconds`
  - Dashboard -> Stability Index -> Depeg Tracker
- `Due diligence on one coin`
  - search coin -> detail page -> Safety Scores -> Liquidity -> Dependency Map
- `Build a shortlist`
  - Compare -> Portfolio -> Telegram Alerts
- `Yield with guardrails`
  - Yield -> Safety Scores -> coin detail

Each path should show:

- who it is for
- what they will learn
- 3-step route
- main CTA

### Section 5: Feature Map

Purpose:

- make the full product legible without overwhelming the hero

Recommended grouping:

- `Monitor`
  - Dashboard
  - Stability Index
  - Depeg Tracker
  - Daily Digest
  - Telegram Alerts
- `Research`
  - Stablecoin detail
  - Safety Scores
  - DEX Liquidity
  - Dependency Map
  - stablecoin directories
- `Operate`
  - Compare
  - Portfolio
  - Mint/Burn Flows
  - Blacklist Tracker
  - Yield Intelligence
- `Learn`
  - Methodology
  - About
  - Cemetery

This section is where the page should ensure all major features are represented.

### Section 6: Power Features and Shortcuts

Purpose:

- help users graduate from novice to efficient use

Content:

- command palette (`Ctrl/Cmd+K`)
- taxonomy browsing by peg, backing, governance
- compare presets
- portfolio presets
- Telegram delivery options

This should sit lower on the page. It is not the beginner entry point, but it helps adoption after the first visit.

## Recommended Feature Directory

This is the minimum route inventory the onboarding page should reference directly.

| Feature | Why a new user would use it first |
|---|---|
| Dashboard | Fastest overview of the stablecoin market |
| Stablecoin detail | Best single-page due diligence surface for one coin |
| Stability Index | Best answer to "how stressed is the market?" |
| Depeg Tracker | Best answer to "who is drifting right now?" |
| Safety Scores | Best cross-market risk ranking |
| DEX Liquidity | Best slippage and depth view |
| Yield Intelligence | Best yield-vs-risk entry point |
| Compare | Best side-by-side decision tool |
| Portfolio | Best personal exposure view |
| Dependency Map | Best systemic-risk exploration surface |
| Mint/Burn Flows | Best issuance and redemption surveillance view |
| Blacklist Tracker | Best issuer intervention monitoring view |
| Daily Digest | Best daily narrative summary |
| Telegram Alerts | Best ongoing monitoring setup |
| Methodology | Best deep reference for formulas and scoring logic |
| About | Best source for project scope and data provenance |
| Cemetery | Best context for historical failure patterns |

## Content Strategy Recommendations

### Use plain-English task language

Prefer:

- `Check market health`
- `Research a stablecoin`
- `Find safer yield`
- `Set up alerts`

Avoid making the primary navigation of the onboarding page revolve around internal model names.

### Teach concepts before acronyms

Example:

- first say `early warning signal`
- then introduce `DEWS`

This reduces beginner drop-off without dumbing down the product.

### Keep the first screen action-oriented

The hero should behave like a routing layer, not a product essay.

The first meaningful CTA should appear immediately, before any long explanation.

### Keep advanced detail behind optional disclosure

If the page tries to fully explain every score, it will collapse into a second methodology page.

That is the wrong direction.

## UX Pattern Recommendations

The page should borrow from the existing structured onboarding surfaces already used in `Compare` and `Portfolio`:

- one strong headline
- 3-step explainer cards
- clear preset or path buttons
- preview panel on the right at desktop
- optional reassurance/support note below

The page should not be a plain longform article.

Recommended patterns:

- intent cards
- path cards
- mini previews
- compact glossary cards
- grouped feature directory
- sticky section jump rail only if the page grows long enough to need it

## What The Page Should Not Do

### 1. It should not become a second homepage

The homepage already does live market overview. The onboarding page should focus on orientation.

### 2. It should not become a second methodology page

Use plain language and link out for formulas.

### 3. It should not present 16 equal-priority feature cards above the fold

That recreates the current problem.

### 4. It should not be mandatory

Experienced users should be able to skip it entirely.

### 5. It should not hide the product behind a tour

This page should be a guide, not a gate.

## Placement Recommendations

Primary placement options:

1. Add a `Start Here` route in nav or footer.
2. Link it from the homepage hero area.
3. Link it from `About`.
4. Expose it in command palette search.

Recommended minimum placement:

- homepage link
- footer link
- command palette inclusion

I would not make it the default landing page. The dashboard should remain the public front door.

## Suggested Future Copy Direction

### Hero example

`New to Pharos? Start with the path that matches what you need.`

Support line:

`Pharos helps you monitor stablecoin stress, research individual assets, compare risk, and set alerts without digging through a dozen disconnected tools.`

### Path examples

- `I want the market overview`
- `I want to research one coin`
- `I want to compare options`
- `I want yield with risk context`
- `I want alerts and monitoring`

## Implementation Notes For Later

When implementation starts, the page should likely:

- live at `/onboarding/` or `/start/`
- use a custom hero rather than a generic longform shell
- reuse `EmptyStateSurface` patterns or extract a broader onboarding surface from it
- manually curate the path cards, even if the lower feature directory can draw from `nav-config.ts`
- link out aggressively rather than embedding too much live product complexity

## Recommended Deliverable Shape

If implemented well, the page should feel like:

- a welcome layer
- a route planner
- a vocabulary primer
- a feature atlas

in that order.

That sequence is important. New users need orientation before they need completeness.

## Bottom Line

Pharos is already rich enough that beginners need a routing page.

The best version of `Pharos Onboarding` is not a tutorial. It is a fast optional orientation surface that answers:

- what Pharos is for
- where I should begin
- what the main scores mean
- which tool fits my job

If the page does that well, it will make the existing product feel easier without flattening its depth.
