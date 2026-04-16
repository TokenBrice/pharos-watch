# Reference Pages Remediation Plan

**Date**: 2026-04-16
**Scope**: About, Methodology, Coverage, API Reference, Status, Changelog
**Objective**: Maximize transparency, context, and capability communication across all Reference pages.

---

## Audit Summary

| Page | Critical | Major | Minor | Total |
|------|----------|-------|-------|-------|
| Methodology | 1 | 5 | 8 | 14 |
| About | 0 | 4 | 8 | 12 |
| Coverage | 0 | 4 | 8 | 12 |
| API Reference | 0 | 3 | 8 | 11 |
| Status | 0 | 3 | 8 | 11 |
| Changelog | 0 | 3 | 8 | 11 |
| **Total** | **1** | **22** | **48** | **71** |

---

## Cross-Cutting Patterns

Before individual fixes, these patterns recur across multiple pages:

| Pattern | Pages Affected | Fix Strategy |
|---------|---------------|--------------|
| **Missing cross-references** | Methodology (sections siloed), Changelog (no methodology links), About (4 missing product surfaces) | Add inline links at point of mention |
| **JSON-LD/structured data issues** | Methodology (wrong weights), About (FAQ too long), Coverage (FAQ invisible) | Fix factual errors, trim long answers, render FAQ visibly |
| **Mobile information gaps** | Methodology ("How to Read" hidden), Coverage (scrollspy label hidden) | Show condensed versions on mobile instead of hiding |
| **Hidden scrollbar removing scroll affordance** | API Reference sidebar, Changelog week nav | Replace `scrollbar-none` with thin styled scrollbar |
| **Missing explanatory copy for technical concepts** | Status (circuit breakers), Coverage (available vs headline), About (SMIDGE) | Add brief contextual definitions |
| **Accessibility gaps** | API Reference (no aria-current), Coverage (color-only badges), Changelog (time element) | Add ARIA attributes, secondary visual indicators |
| **Uncollapsible walls of text** | Methodology (Liquidity Score, PegScore+DEWS) | Move implementation detail into `<details>` collapsibles |
| **Hero/fallback copy exposing internals** | Status (debug strings in fallback), API Reference (backtick markdown in hero lanes) | Rewrite to user-facing language, render inline markdown |

---

## Implementation Steps

### Phase 1: Critical + High-Impact Majors (factual errors, trust-breaking issues)

#### 1.1 Fix Liquidity Score weight discrepancy in FAQ JSON-LD [CRITICAL]

**File**: `src/app/methodology/page.tsx` line 57
**Problem**: FAQ JSON-LD states weights as "TVL depth (35%), volume activity (20%), pool quality (22.5%), durability (15%), and pair diversity (7.5%)". Production weights in `shared/lib/liquidity-score-weights.ts` are 30/20/20/20/10. The technical details table and worked example both show the correct 30/20/20/20/10. Search engines and AI assistants are being served wrong data.
**Fix**: Replace the FAQ answer string with: `"The liquidity score is a composite 0–100 metric combining TVL depth (30%), volume activity (20%), pool quality (20%), durability (20%), and pair diversity (10%). Volume uses log-scale scoring. Pool quality is adjusted for mechanism type, balance health, and pair quality."`
**Verify**: `grep -n "35%" src/app/methodology/page.tsx` returns no matches after fix.

#### 1.2 Add cross-references between methodology sections [MAJOR]

**Files**: All 11 section files under `src/app/methodology/sections/`
**Problem**: Zero cross-section links despite heavy interdependencies (Safety Scores→PegScore, DEWS→Mint/Burn, PYS→Safety Scores, etc.).
**Fix**: Add a "Related" or "See also" note at the end of each section's summary content (before the technical details collapsible), linking to dependent/upstream sections using anchor IDs. Specific links needed:

| Section | Links To (verified anchor IDs) |
|---------|----------|
| Safety Scores (`#safety-scores-methodology`) | PegScore+DEWS (`#pegscore-dews-methodology`), Liquidity Score (`#liquidity-methodology`), Infrastructure (`#infrastructure-methodology`) |
| PegScore+DEWS (`#pegscore-dews-methodology`) | Mint/Burn Flow (`#mint-burn-flow-methodology`), Liquidity Score (`#liquidity-methodology`) |
| Yield Intelligence (`#yield-intelligence-methodology`) | Safety Scores (`#safety-scores-methodology`), Liquidity Score (`#liquidity-methodology`) |
| Stability Index (`#stability-index-methodology`) | PegScore+DEWS (`#pegscore-dews-methodology`), Safety Scores (`#safety-scores-methodology`) |
| Contagion Stress Test (`#contagion-stress-test-methodology`) | Safety Scores (`#safety-scores-methodology`) |
| Chain Health (`#chain-health-score`) | Liquidity Score (`#liquidity-methodology`) |

**Pattern**: Use a consistent `<p>` with `text-xs text-muted-foreground` and link styling. Example: `See also: <a href="#pegscore-dews-methodology">PegScore + DEWS</a> · <a href="#liquidity-methodology">Liquidity Score</a>`
**Verify**: Manual review that all links resolve to correct section anchors. IDs sourced from `MethodologySectionShell id=` props in each section file.

#### 1.3 Trim Liquidity Score top-level prose [MAJOR]

**File**: `src/app/methodology/sections/core/liquidity-section.tsx` lines 20-103
**Problem**: 15 consecutive `<p>` elements (lines 20-103) appear at top level before the `MethodologyFacts` block (line 104). These are visible in both Reader and Analyst modes because they are not inside a `<MethodologyDetails>` collapsible. The section already has the correct structured rhythm below (MethodologyFacts at line 104, WorkedExample at line 130, and `<LiquidityTechnicalDetails />` component at line 146), so the structure is sound — the issue is that too much implementation detail (pool identity resolution, deduplication, provider quirks) sits above the fold.
**Fix**: Keep the first 2-3 paragraphs (summary of what Liquidity Score measures and its five components) at top level. Move paragraphs about pool-matching, deduplication, protocol-native sources, and provider-specific behavior (roughly lines 28-103) into a new `<MethodologyDetails summary="Pool Matching & Deduplication">` collapsible, placed between the remaining summary paragraphs and the existing `MethodologyFacts`.
**Verify**: In Reader mode, the section should show ~3 summary paragraphs + facts + preconditions. Pool-matching detail should be collapsed. Analyst mode opens it.

#### 1.4 Trim PegScore+DEWS top-level prose [MAJOR]

**File**: `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx` lines 24-68
**Problem**: ~10 `<p>` elements (lines 24-68) appear at top level before the section's MethodologyFacts (line 70). The section already has the full structured rhythm below: MethodologyFacts (lines 70-97), WorkedExample (line 98), and a comprehensive MethodologyDetails collapsible (line 112, ~370 lines of PegScore formula, DEWS signals, threat bands). The structure is complete — the issue is only that too many paragraphs of depeg confirmation rules, trust gates, and native-peg corroboration detail sit above the fold in Reader mode.
**Fix**: Keep the first 2-3 paragraphs (summary of what PegScore and DEWS measure, their relationship). Move the remaining detail paragraphs (~lines 35-68) into a new `<MethodologyDetails summary="Depeg Confirmation & Trust Gates">` collapsible before the MethodologyFacts block.
**Verify**: Reader mode shows concise summary + facts + preconditions + worked example. Technical prose about confirmation rules is collapsed. The existing `MethodologyDetails` for formulas/signals (line 112) remains unchanged.

#### 1.5 Complete the Blacklist Tracker methodology section [MAJOR]

**File**: `src/app/methodology/sections/monitoring/blacklist-tracker-section.tsx`
**Problem**: Only section with no `MethodologyFacts`, no `WorkedExample`, no `MethodologyDetails`, no preconditions block. Two paragraphs only. Every other computational section follows a structured rhythm.
**Fix**: Add the standard section components:
- `MethodologyFacts` with: Data sources (Etherscan events), Tracked events (freeze/unfreeze/wipe), Chains covered (EVM + Tron), Update frequency
- Preconditions & Failure Modes block (minimum data: event logs, failure: falls back to last-known state)
- `WorkedExample` showing how a blacklist event is detected and reconciled
- `MethodologyDetails` with technical notes on the reconciled freeze ledger, cross-chain consolidation, and backlog sync
**Verify**: Section now matches the structural pattern of other sections (summary → facts → preconditions → worked example → technical details).

#### 1.6 Enrich mobile Reader Guide with reading rhythm steps [MAJOR]

**File**: `src/app/methodology/page.tsx` lines 85-97 (mobile Reader Guide) and lines 108-131 (desktop "How to Read" card)
**Problem**: The four-step reading rhythm (Summary → Quick Facts → Worked Examples → Technical Notes) is only shown on the desktop card (`hidden ... md:block` at line 108). The mobile Reader Guide (lines 85-97, visible via `md:hidden`) has the mode toggle and a brief description, but does not explain the section rhythm. Showing both cards on mobile would create redundancy.
**Fix**: Enrich the existing mobile Reader Guide card (lines 85-97) by appending a compact 2×2 grid or vertical list of the 4 reading steps (reuse data from `METHODOLOGY_READING_STEPS`). Keep the desktop card desktop-only. This avoids duplication while ensuring mobile users learn the page rhythm.
**Verify**: On mobile viewport, the Reader Guide card contains the mode toggle AND the four reading steps in a compact layout. The desktop "How to Read" card remains hidden on mobile.

---

### Phase 2: Remaining Majors (content gaps, UX issues)

#### 2.1 About: Fix Blacklist Tracker description fragment [MAJOR]

**File**: `src/app/about/page.tsx` line 279
**Problem**: Description reads "issuer-intervention events for the live blacklist-tracked..." — a sentence fragment with no subject/verb.
**Fix**: Rewrite to: "Tracks issuer-intervention events (freeze, unfreeze, wipe) across supported EVM and Tron networks, with a reconciled freeze ledger for major blacklist totals."
**Verify**: Description reads as a complete, standalone sentence.

#### 2.2 About: Add DEWS link [MAJOR]

**File**: `src/app/about/page.tsx` lines 366-370
**Problem**: DEWS is the only computed feature without an `href`. Users cannot navigate to where DEWS data is surfaced.
**Fix**: Add `href: "/depeg/"` (DEWS data is surfaced on the depeg tracker page) or link to the methodology section `href: "/methodology/#pegscore-dews-methodology"`. Prefer `/depeg/` since that's where users can see live DEWS data.
**Verify**: DEWS feature row is now clickable and navigates to the correct page.

#### 2.3 About: Add missing product surface links [MAJOR]

**File**: `src/app/about/page.tsx`
**Problem**: No mention of `/start`, `/portfolio`, `/compare`, or `/yield`. These are significant product surfaces absent from the transparency page.
**Fix**: Add four new items to the existing feature arrays. Each needs a `title`, `description`, `href`, and `icon` (lucide-react). Insert into existing arrays to match topical grouping:
- Add to `computedFeatures` array (near Safety Grades / Stability Index entries):
  - `{ title: "Stablecoin Comparison", description: "Side-by-side analysis of any tracked stablecoins across safety, liquidity, peg stability, and yield metrics.", href: "/compare/", icon: ArrowLeftRight }`
  - `{ title: "Risk-Adjusted Yield", description: "Yield opportunities scored against protocol safety, so high APY from risky vaults is flagged rather than promoted.", href: "/yield/", icon: TrendingUp }`
- Add to `trackedFeatures` array (near Portfolio-adjacent entries):
  - `{ title: "Portfolio Audit", description: "Analyze your stablecoin holdings against Pharos safety, liquidity, and peg data to spot concentration risk.", href: "/portfolio/", icon: Briefcase }`
- Add a "Getting Started" CTA link in the "Why Pharos?" section text pointing to `/start/` (inline link, not a new feature row)
**Verify**: All four routes appear, link correctly, and use icons already imported from lucide-react (verify icon name availability).

#### 2.4 About: Trim JSON-LD FAQ data-sources answer [MAJOR]

**File**: `src/app/about/page.tsx` lines 403-406
**Problem**: Single FAQ answer is 1,500+ characters of unstructured text. Search engines truncate or penalize.
**Fix**: Replace with concise summary: "Pharos aggregates data from DefiLlama, CoinGecko, on-chain RPC nodes, block explorers (Etherscan, Tronscan), protocol-native APIs, and curated sources like Bluechip. Details on all data sources are available on the About page."
**Verify**: FAQ answer is under 300 characters.

#### 2.5 Coverage: Make FAQ visible on the page [MAJOR]

**File**: `src/app/coverage/page.tsx` and `src/app/coverage/coverage-page-sections.tsx`
**Problem**: Three well-written FAQ entries exist only as JSON-LD structured data (built via `buildFaqJsonLd()` at line 51). Transparency-focused users cannot see them.
**Fix**: Extract the raw Q&A data into a shared constant array (e.g., `COVERAGE_FAQ_ITEMS = [{ q: "...", a: "..." }, ...]`) defined in `page.tsx`. Pass this array to both `buildFaqJsonLd()` for the JSON-LD and to a new visible `<CoverageFaqSection items={COVERAGE_FAQ_ITEMS} />` component rendered at the bottom of the client page. The visible FAQ should use `<details>/<summary>` elements styled with the existing card treatment.
**Verify**: FAQ section is visible on the page. JSON-LD output is unchanged (same content). Both consume the same source array.

#### 2.6 Coverage: Explain available vs headline distinction [MAJOR]

**File**: `src/app/coverage/coverage-page-sections.tsx` lines 224-228
**Problem**: Users see two counts (Available, Headline) but don't understand the difference. Thresholds are buried in code.
**Fix**: Add a brief inline explanation near the matrix card description: "Available counts all coins with any data for a feature. Headline counts apply stricter thresholds — for example, pricing requires ≥3 independent sources, and reserve coverage requires live composition feeds." Also add a tooltip on the "Available" and "Headline" column headers in the matrix.
**Verify**: A user encountering both counts for the first time can understand the distinction without leaving the page.

#### 2.7 Coverage: Add secondary visual indicator to badges [MAJOR]

**File**: `src/app/coverage/coverage-badge.tsx` and supporting coverage.ts
**Problem**: Six badge tones rely primarily on color hue. Users with color vision deficiency may not distinguish emerald from amber.
**Fix**: Add a small leading icon or shape to each badge tone category:
- Emerald (best): checkmark or filled circle
- Sky (good): open circle
- Amber (partial): half-filled circle or warning triangle
- Violet (legacy/unusual): diamond
- Rose (problematic): × or minus
- Slate (N/A): dash
These can be tiny (10-12px) SVG icons prepended to the badge text. Note: the badge's current minimum width is `min-w-[4.75rem]` at `text-[11px]` — adding an icon may require increasing `min-w` slightly to avoid text truncation.
**Verify**: Badges are distinguishable with color vision simulation (protanopia/deuteranopia). Badge layout remains compact.

#### 2.8 Coverage: Simplify filter bar [MAJOR]

**File**: `src/app/coverage/coverage-page-sections.tsx` lines 260-298 and `src/lib/coverage-page-config.ts` lines 160-178
**Problem**: 14 filter pills with no grouping causes decision paralysis. Mix of noun phrases and negatives increases cognitive load.
**Fix**: Group the `FILTER_OPTIONS` array into visual clusters separated by subtle `border-r border-border/40` dividers. Based on actual filter keys in the config:
- **Quality tier** (first): All coins, Fully available, Fully headline
- **Feature presence** (middle): Redemption, Yield, Reserves, Live Reserves, DEX Liquidity, Blacklist
- **Coverage gaps** (last): No Safety, No DEX, No Reserves, Weak price, No Price
Add a `group?: string` field to filter option type and render a `<div>` per group within the existing `flex flex-wrap gap-2` container.
**Verify**: Filter bar has visible grouping. Existing filter behavior unchanged. Mobile wrapping still works.

#### 2.9 API Reference: Add dedicated Rate Limits section [MAJOR]

**File**: `docs/api-reference.md`
**Problem**: Global rate limit (300 req/60s per IP) is buried inside the `POST /api/feedback` section (~line 2196). Per-key limit (default 120/min) is only in admin docs. Developers won't discover limits until hitting 429.
**Fix**: Add a new `## Rate Limits` section after `## Polling Guidance` (~line 126) documenting:
- Global limit: 300 requests per 60 seconds per IP hash
- Per-key limit: varies (default 120/min)
- 429 response format with example JSON
- Retry guidance (Retry-After header, exponential backoff)
**Note**: Adding a `## Rate Limits` heading creates a new top-level section in the rendered API reference page. Verify that `loadApiReferenceDocument()` in `src/lib/api-reference-doc.ts` handles new `##` sections correctly (it should — the parser treats all `##` headings as section boundaries at line 76-78). Also verify the new section appears in the sidebar navigation.
**Verify**: A developer reading the public API section encounters rate limits before any endpoint documentation. The new section appears in the sidebar nav.

#### 2.10 Status: Add circuit breaker explanation [MAJOR]

**File**: `src/components/status/circuit-breaker-table.tsx`
**Problem**: No introductory copy about what circuit breakers are, what states mean, or what user-facing impact an open breaker has.
**Fix**: Add an intro paragraph before the table: "Circuit breakers protect data quality by temporarily disabling a data source after repeated failures. **Closed** means the source is healthy. **Half-open** means Pharos is cautiously retesting after a failure period. **Open** means the source is disabled — affected features will show cached data until the source recovers."
**Verify**: A non-technical visitor can understand the circuit breaker table after reading the intro.

#### 2.11 Status: Fix RefreshCountdown messaging [MAJOR]

**File**: `src/components/status/refresh-countdown.tsx` and `src/components/status/public-status-hero.tsx` (line 158, `key={lastUpdated}`)
**Problem**: The countdown counts up via `elapsedSeconds` and displays `Math.max(0, 60 - elapsed)`. At zero it stays indefinitely. The component is keyed on `lastUpdated` in the parent — when react-query polling fires and `lastUpdated` changes, the component remounts and the countdown resets. So the countdown is a visual indicator of "time since last fetch," not a trigger. However, it misleadingly implies auto-refresh.
**Fix**: Do NOT call `onRefresh()` at zero — this would cause an infinite refetch loop since react-query already manages polling. Instead, replace the countdown display with honest messaging: show "Updated Xs ago" (updating every second via the existing timer), and label the manual button "Refresh now" instead of relying on a countdown-to-zero affordance. This accurately reflects the data flow: react-query polls periodically, and the button offers a manual override.
**Verify**: The status hero shows "Updated Xs ago" that counts up and resets when data arrives. Manual "Refresh now" button still works. No infinite refetch loop.

#### 2.12 Status: Fix hero fallback copy [MAJOR → Minor per severity, but grouped here for proximity]

**File**: `src/components/status/public-status-hero.tsx` lines 111-112
**Problem**: Fallback messages expose internal debug language: "no human-readable warning string was attached."
**Fix**: Replace with user-facing copy:
- Degraded fallback: "Some data pipelines are experiencing delays. Check the sections below for details."
- Stale fallback: "System health data is outdated. Check the sections below for current status."
**Verify**: No internal/debug language visible in any hero state.

#### 2.13 Changelog: Render summary tags as labeled pills, not color-only dots [MAJOR]

**File**: `src/components/changelog-entry-card.tsx` lines 126-129
**Problem**: Tags are only 1.5px color dots with `aria-hidden`. Zero information for screen readers, and too small for color distinction.
**Fix**: Replace the `size-1.5` dot with a small labeled pill showing the tag name (e.g., "feature", "coverage", "infra") using the existing `TAG_COLOR` map for coloring. Use `text-[10px] uppercase tracking-wide` for the label.
**Verify**: Each summary item shows a readable tag label. Screen readers announce the category.

#### 2.14 Changelog: Add methodology cross-references [MAJOR]

**Files affected** (7 total):
- `src/data/changelogs/types.ts` — add optional `href?: string` to `SummaryItem`
- `src/components/changelog-entry-card.tsx` — render label as `<a>` when `href` is present
- `src/data/changelogs/2026-03-08.ts` — contains "Liquidity Score v5.0", "Safety Score v6.0"
- `src/data/changelogs/2026-03-16.ts` — contains "PYS v2 formula"
- `src/data/changelogs/2026-03-24.ts` — contains "v6.93 scoring"
- `src/data/changelogs/2026-04-04.ts` — scan for methodology version references
- `src/data/changelogs/2026-04-12.ts` — scan for methodology version references

**Problem**: Entries mention methodology versions but never link to the corresponding methodology changelog pages.
**Fix**: Add an optional `href` field to `SummaryItem` type. In `changelog-entry-card.tsx`, when `item.href` is present, wrap the label text in an `<a>` element. Then update each entry file: scan for methodology version mentions and add `href` values pointing to the appropriate changelog route (e.g., `/methodology/liquidity-score-changelog/`, `/methodology/scoring-changelog/`). Do this incrementally — update one entry, verify it renders, then continue.
**Verify**: Clicking a methodology version reference navigates to the correct changelog page. Type-check passes.

#### 2.15 Changelog: Fix `<time>` element semantics [MAJOR]

**File**: `src/components/changelog-entry-card.tsx` line 92
**Problem**: `dateTime={isoDate(dateRange.from)}` uses the start date, but a changelog entry's meaningful date is the end/release date.
**Fix**: Change to `dateTime={isoDate(dateRange.to)}`. The end date represents when the work was published.
**Verify**: `<time>` element's datetime attribute uses the `to` date.

---

### Phase 3: Minor Issues (polish, accessibility, consistency)

#### 3.1 Methodology: Fix sections that break Reader mode contract

**Files**:
- `src/app/methodology/sections/core/stability-index-section.tsx` line 67 — remove `defaultOpen` from `MethodologyDetails`
- `src/app/methodology/sections/core-sections-pricing.tsx` lines 142-145 — remove `defaultOpen` from `MethodologyDetails`
**Problem**: Two sections start fully expanded, contradicting Reader mode's collapsed-by-default promise.
**Fix**: Remove `defaultOpen` prop. Keep `primary` if it serves a non-open purpose.
**Verify**: On page load in Reader mode, these sections have their technical details collapsed.

#### 3.2 Methodology: Add version labels to Infrastructure and Contagion sections

**Files**:
- `src/app/methodology/sections/core/infrastructure-section.tsx`
- `src/app/methodology/sections/monitoring/contagion-stress-test-section.tsx`
**Fix**: Add `version` and `changelogPath` props to their `MethodologySectionShell` wrappers. Even if there's no dedicated changelog page yet, a version label (e.g., "v1.0") signals that the methodology is tracked.

#### 3.3 Methodology: Differentiate Stability Index and Liquidity Score accent colors

**Files**:
- `src/app/methodology/sections/core/stability-index-section.tsx` line 28
- `src/app/methodology/sections/core/liquidity-section.tsx` line 15
**Fix**: Change Liquidity Score from `border-l-cyan-500` to `border-l-sky-500`. Note: `sky-500` is used for formula code block borders *within* sections (e.g., `stability-index-section.tsx` line 73, `core-sections-pricing.tsx` line 229), but at a different visual level (inline code vs section card border), so this does not create a meaningful collision. Also update the corresponding Liquidity Score changelog accent at `src/app/methodology/liquidity-score-changelog/page.tsx` line 19.

#### 3.4 Methodology: Show mobile scrollspy label

**File**: `src/components/longform-scrollspy-nav.tsx` lines 164-167
**Fix**: Change from `hidden sm:block` to always visible, using a more compact form on mobile (e.g., just "Sections:" instead of "Jump to Section").

#### 3.5 API Reference: Render inline markdown in hero lane descriptions

**File**: `src/app/about/api/page.tsx` lines 319-322
**Problem**: Backtick-quoted strings in lane descriptions render as literal backticks.
**Fix**: Use `renderInlineMarkdown()` (already defined in the same file) for lane descriptions instead of plain `<p>`.

#### 3.6 API Reference: Add `aria-current` to active sidebar items

**File**: `src/components/api-reference-sidebar.tsx`
**Fix**: Add `aria-current="true"` to the active sidebar link/button alongside the existing visual styling.

#### 3.7 API Reference: Fix "Base Contract" label

**File**: `src/app/about/api/page.tsx` lines 354-358
**Fix**: Rename "Base Contract" kicker to "Getting Started" or "API Conventions".

#### 3.8 API Reference: Replace `scrollbar-none` with thin scrollbar

**File**: `src/components/api-reference-layout.tsx` line 101
**Fix**: Replace `lg:scrollbar-none` with `lg:scrollbar-thin` (Tailwind scrollbar plugin) or custom CSS for a subtle scrollbar.

#### 3.9 API Reference: Show specific endpoint name on mobile nav

**File**: `src/components/api-reference-mobile-nav.tsx` lines 14-21
**Fix**: When a subsection is active, show the subsection label (endpoint name) instead of the parent section name.

#### 3.10 Status: Add skeleton loading state

**File**: `src/app/status/client.tsx` line 120
**Fix**: Replace "Loading system status..." text with a skeleton layout matching the hero + sections structure.

#### 3.11 Status: Add timezone display to timestamps

**Files**: `src/components/status/public-status-hero.tsx`, `src/components/status/public-transition-timeline.tsx`
**Fix**: Pass `{ timeZoneName: 'short' }` to `toLocaleString()` calls, or standardize to UTC with a `(UTC)` suffix.

#### 3.12 Status: Remove dead code in format.ts

**File**: `src/components/status/format.ts`
**Fix**: Verify no consumers exist, then delete the file. If consumers exist elsewhere, keep it.

#### 3.13 Changelog: Add visible label to week nav

**File**: `src/components/changelog-week-nav.tsx`
**Fix**: Add a "Jump to:" text prefix before the week pills, using `text-xs text-muted-foreground`.

#### 3.14 Changelog: Link commit hashes to GitHub

**File**: `src/components/changelog-entry-card.tsx` lines 160-165
**Fix**: Wrap commit hashes in `<a href="https://github.com/TokenBrice/stablecoin-dashboard/commit/{hash}">` links. Use existing `INLINE_EXTERNAL_LINK_CLASS` or similar subtle styling.
**Note**: Confirm the repo URL — use the same origin as the existing GitHub link in the page header.

#### 3.15 Changelog: Fix `formatDateRange` year handling across year boundaries

**File**: `src/components/changelog-entry-card.tsx` lines 46-48
**Fix**: When `from` and `to` dates are in different years, include the year on the `from` date too.

#### 3.16 Coverage: Group status legend by feature

**File**: `src/app/coverage/coverage-page-sections.tsx` lines 321-337 and `src/lib/coverage-page-config.ts` lines 222-299
**Fix**: Group the 18 legend entries by feature category (Price, Safety, DEX, Reserves, etc.) with small headings.

#### 3.17 Coverage: Add "last updated" timestamp to matrix

**File**: `src/app/coverage/coverage-page-sections.tsx`
**Fix**: Surface `dataUpdatedAt` from the coverage query as a small timestamp in the matrix card header.

#### 3.18 Coverage: Add pre-launch context link

**File**: `src/app/coverage/page.tsx` line 49
**Fix**: Add link to `/upcoming` after the pre-launch exclusion note.

#### 3.19 About: Expand SMIDGE acronym

**File**: `src/app/about/page.tsx` line 294
**Fix**: Add parenthetical: "SMIDGE (Security, Management, Insurance, Decentralization, Governance, Escrow)"

#### 3.20 About: Clarify Systemic Risk Scoreboard vs Safety Grades relationship

**File**: `src/app/about/page.tsx` lines 348, 360-362
**Fix**: Add "(part of Safety Scores)" to the Systemic Risk Scoreboard description to clarify it's a sub-feature.

#### 3.21 About: Move Live Walkthrough section

**File**: `src/app/about/page.tsx` lines 570-589
**Fix**: Move after the team section (after line ~539) or to the end of the page before the disclaimer.

---

## Implementation Order

1. **Phase 1** (Critical + high-impact Majors): Steps 1.1-1.6 — fix factual errors and structural content issues
2. **Phase 2** (Remaining Majors): Steps 2.1-2.15 — content gaps, UX issues, accessibility
3. **Phase 3** (Minor polish): Steps 3.1-3.21 — consistency, accessibility, polish

## Out of Scope (deferred)

These items were identified but are not included in this plan:

- **RSS/Atom feed for changelog** — Significant new infrastructure; should be a separate feature ticket
- **API Reference h4 heading support** — No current document uses h4; latent issue only
- **Changelog totalCommits derivation from array** — Low risk given current authoring process
- **Uptime bar timezone handling** — Complex edge case with O(days×transitions) performance; needs dedicated investigation
- **Coverage sort not resetting with filter** — Debatable UX; could be intentional
- **Duplicated mobile/desktop diagram pattern** — Maintenance burden but working correctly; refactor separately
- **About trailing slash inconsistency** — Needs broader URL normalization strategy
- **API Reference syntax highlighting** — Adding `shiki` or a CSS highlighter is a nontrivial dependency for a cosmetic improvement. Code blocks already have dark bg + monospace + language labels. Deferring per CLAUDE.md simplicity principle.
