# Pharos Design Refinement Plan
## Date: 2026-03-05

## Executive Summary
Pharos already has a strong analytical foundation: clear branding, robust page coverage, complete metadata hygiene (titles/descriptions/canonical/favicons), and generally consistent card/table primitives. The product feels serious and data-rich, not marketing-heavy, which is appropriate for the audience. The strongest pages today are `Stability Index`, `Depeg Tracker`, and `Blacklist Tracker`, where hierarchy, intent, and data modules are well aligned.

The biggest quality gaps are refinement-level but meaningful: responsive integrity breaks on key mobile pages, uneven shell/hierarchy patterns between page families, and scannability issues on dense long-form content. Across the 30 audited routes (desktop + mobile), only 3 routes had horizontal overflow, but all 3 are important entry points (`/dependency-map`, `/flows`, `/yield`). Long pages (methodology/changelog/detail) deliver depth but need better in-page wayfinding to reduce cognitive load.

If the plan below is implemented, the site should move from “strong independent build” to “institutional-grade product polish”: more coherent journey flow, cleaner mobile behavior, stronger accessibility compliance, and faster user comprehension for both first-time and power users.

## Site Inventory
| URL | Purpose | Target Audience & Intent | Current Hierarchy Assessment | Content Density | Overall Quality |
|---|---|---|---|---|---|
| `/` | Dashboard hub for market-wide monitoring | Analysts, traders, researchers checking market state quickly | Data modules dominate; value framing is weaker on mobile because hero/context is hidden | Cluttered | Strong |
| `/stability-index` | PSI trend + components + context | Users tracking systemic stablecoin risk | Clear: headline -> history -> contributors -> methodology -> FAQ | Balanced | Strong |
| `/safety-scores` | Per-coin safety grading + contagion map | Risk-conscious users comparing downside risk | Core visual (map) is prioritized; supporting explanation is concise | Balanced | Strong |
| `/dependency-map` | Collateral/dependency graph exploration | Advanced users analyzing contagion paths | Single graph dominates; controls/legend are compact and dense | Sparse | Fair |
| `/liquidity` | DEX liquidity health and rankings | Execution-focused users evaluating redeemability/liquidity | KPI strip + leaderboard works; table depth is appropriate | Balanced | Strong |
| `/depeg` | Live depeg detection + DEWS warnings | Real-time risk monitors | Strong triage flow: warning system -> leaderboard -> recent events -> live deviation | Balanced | Strong |
| `/blacklist` | Freeze/destroy events tracker | Compliance/risk analysts | Clear: context -> KPIs -> trend -> filters -> table | Balanced | Strong |
| `/portfolio` | Personal holdings risk view | End users assessing portfolio exposure | Very sparse before interaction; relies on user setup to unlock value | Sparse | Fair |
| `/compare` | Side-by-side stablecoin comparison | Users shortlisting alternatives | Good progressive disclosure, but initial state feels tool-like over guided | Sparse | Good |
| `/cemetery` | Failed stablecoin archive + lessons | Researchers learning failure patterns | Rich content but visually heavy; many charts compete for attention | Cluttered | Good |
| `/digest` | Daily digest archive | Returning users reviewing narrative recaps | Clear archive intent; straightforward hierarchy | Balanced | Good |
| `/digest/2026-03-05` | Single digest article page | Users reading one day’s market narrative | Simple and readable; minimal supporting navigation | Balanced | Good |
| `/methodology` | Canonical scoring/methodology explainer | Power users validating model credibility | Deep and thorough; dense but structured | Cluttered | Good |
| `/methodology/stability-index-changelog` | PSI version history | Advanced users auditing model changes | Chronological list works; scanning can be faster | Balanced | Good |
| `/methodology/scoring-changelog` | Safety score version history | Advanced users auditing score evolution | High information density; needs stronger skim affordances | Cluttered | Fair |
| `/methodology/liquidity-score-changelog` | Liquidity model change history | Advanced users validating liquidity methodology | Structured but repetitive card rhythm | Balanced | Good |
| `/methodology/depeg-changelog` | Depeg + DEWS change history | Risk users tracking detector policy changes | Useful but long-form scanning is fatiguing | Balanced | Good |
| `/methodology/mint-burn-flow-changelog` | Flow scoring change history | Users tracking experimental feature maturity | Chronological clarity is good; visual monotony remains | Balanced | Good |
| `/methodology/yield-changelog` | Yield model change history | Yield/risk users validating score updates | Similar strengths/weaknesses as other changelog pages | Balanced | Good |
| `/methodology/blacklist-tracker-changelog` | Blacklist model change history | Compliance/risk users validating event logic | Clear chronology; minimal wayfinding aids | Balanced | Good |
| `/about` | Product scope, philosophy, links | New users validating trust and project intent | Good narrative arc and linkout structure | Balanced | Strong |
| `/yield` | Yield risk-adjusted rankings | Yield seekers balancing return vs risk | Core chart/table hierarchy is good but mobile overflow hurts polish | Balanced | Fair |
| `/flows` | Mint/burn pressure monitoring | Users watching redemption pressure and liquidity stress | Good module sequence; mobile title row overflows | Balanced | Fair |
| `/privacy` | Privacy policy | Trust-seeking users, legal diligence | Clear legal hierarchy and concise sections | Sparse | Good |
| `/status` | Admin-only pipeline health panel | Internal operators | Auth gate is functional but disconnected from wider IA | Sparse | Fair |
| `/stablecoin/1` | Stablecoin detail template (USDT sample) | Deep-dive coin analysis | Rich module stack; excellent depth but heavy scan load | Cluttered | Good |
| `/stablecoin/2` | Stablecoin detail template (USDC sample) | Deep-dive coin analysis | Same template quality/constraints as above | Cluttered | Good |
| `/stablecoins/usd` | USD peg landing + directory | Users browsing by peg family | Useful directory + data table; clear intent | Balanced | Good |
| `/stablecoins/eur` | EUR peg landing + directory | Users browsing non-USD alternatives | Similar to USD peg page with lighter content volume | Balanced | Good |
| `/stablecoins/gold` | Gold peg landing + directory | Commodity-peg researchers | Clear and concise; slightly sparse but functional | Sparse | Good |

Representative dynamic coverage used in this audit: `/stablecoin/{id}` via `1` and `2`, `/stablecoins/{peg}` via `usd/eur/gold`, and `/digest/{date}` via `2026-03-05`.

## Refinement Findings
### Critical
1. **Location:** `/dependency-map`, `/flows`, `/yield` (mobile title row and top visualization modules)
   **Current state:** At `390x844`, document widths exceed viewport (`419px`, `432px`, `457px`). Overflow comes from title + status badge rows and, on Yield, chart label width.
   **Issue:** Horizontal scroll on core pages is a direct professionalism and usability failure on mobile.
   **Suggested remediation:** Make title rows wrap on small screens (`flex-wrap`, `min-w-0`, `max-w-full`, `gap-y-2`), stack version badge below title under `sm`, and constrain chart tick labels on mobile (shorten/clip/thin ticks). Add a Playwright regression assertion for `scrollWidth === innerWidth` across all primary routes.
   **Expected impact:** Eliminates visible responsive breakage and immediately improves perceived quality.

2. **Location:** `/blacklist` -> transaction link control in Blacklist table
   **Current state:** Tx links are icon-only (`ExternalLink`) with no accessible label; first page load exposes 50 unnamed links.
   **Issue:** Action targets are ambiguous for assistive tech and keyboard users; this weakens trust on a compliance-critical page.
   **Suggested remediation:** Add contextual `aria-label` per row (tx hash + chain), preserve visible focus styling, and optionally add tooltip text for mouse users.
   **Expected impact:** Accessibility compliance and clearer interaction semantics with minimal visual change.

### High
1. **Location:** Global page-shell layer (custom pages vs `FeaturePageShell` pages)
   **Current state:** Some pages use the shared shell while others hand-roll breadcrumb/title/meta blocks (`/blacklist`, `/flows`, `/digest`, `/cemetery`, `/about`, `/privacy`, `/stablecoins/*`, `/status`).
   **Issue:** Cross-page rhythm, heading spacing, and badge treatment feel inconsistent; journey coherence suffers.
   **Suggested remediation:** Create shell variants (`standard`, `longform`, `auth-gated`) and migrate custom pages to shared composition tokens.
   **Expected impact:** Stronger system integrity and more professional continuity across navigation.

2. **Location:** Homepage above-the-fold on mobile (`/`)
   **Current state:** Primary hero context from `SiteHeader` is hidden under `lg`; mobile users land directly in data blocks.
   **Issue:** First-time comprehension is weaker; value proposition and “what to do first” are less explicit.
   **Suggested remediation:** Add a compact mobile intro strip with product promise, live scope stats, and one primary action.
   **Expected impact:** Faster orientation and better first-session retention.

3. **Location:** Long-form pages (`/methodology`, all methodology changelogs, `/stablecoin/{id}`)
   **Current state:** High word count and long vertical card stacks; scanning requires heavy scrolling.
   **Issue:** Discoverability of specific answers is slower than necessary, especially for repeat users.
   **Suggested remediation:** Add sticky section navigation + scrollspy on methodology/changelog pages, collapse older changelog entries by default, and surface “latest changes” summary at top. For stablecoin pages, replace the current hero section nav with a single sticky nav pattern (no duplicate nav layers).
   **Expected impact:** Quicker retrieval, lower cognitive load, stronger expert usability.

4. **Location:** Tool entry states (`/portfolio`, `/dependency-map`, `/compare` initial state)
   **Current state:** Early state is functionally correct but sparse (e.g., `/portfolio` desktop density ~21 words before user input).
   **Issue:** Users must infer next actions; first-success path is not explicit enough.
   **Suggested remediation:** Strengthen empty states with one-sentence action framing and starter actions (example portfolio, preset compare sets, quick graph tips).
   **Expected impact:** Reduced hesitation and improved activation into core workflows.

5. **Location:** Chart-heavy pages (`/cemetery`, `/safety-scores`, `/depeg`, `/stablecoin/{id}`, `/dependency-map`)
   **Current state:** Extensive use of sub-12px labels in live view.
   **Issue:** Readability drops on dense charts/tables, especially on laptop-scale and touch devices.
   **Suggested remediation:** Enforce 12px minimum for interactive labels and key axes; reduce tick count or abbreviate labels responsively.
   **Expected impact:** Better legibility and less visual strain without changing information depth.

6. **Location:** `/status` auth gate and public entry context
   **Current state:** Functional admin key form appears without breadcrumb or explanatory context/back navigation.
   **Issue:** Feels disconnected from the main product IA and can read as a dead-end route.
   **Suggested remediation:** Add minimal context copy and dashboard return link above auth card.
   **Expected impact:** Cleaner product continuity and reduced confusion for accidental visitors.

### Medium
1. **Location:** Homepage `Explore` section (`/`)
   **Current state:** Feature cards have similar visual weight and CTA prominence.
   **Issue:** Priority path is unclear; users must self-rank actions.
   **Suggested remediation:** Set one primary journey card style and keep the rest secondary.
   **Expected impact:** Clearer action hierarchy and stronger conversion into key workflows.

2. **Location:** Methodology changelog card headings (`/methodology/*-changelog`)
   **Current state:** Version, title, and date are visually compressed into dense heading blocks.
   **Issue:** Rapid scan quality is lower than it could be.
   **Suggested remediation:** Split metadata into structured header rows (version chip, title line, date line).
   **Expected impact:** Faster parsing and better visual rhythm.

3. **Location:** Top-of-page spacing patterns across custom pages
   **Current state:** Mixed `space-y` values and heading margin conventions produce subtle rhythm drift.
   **Issue:** Inconsistency accumulates into “hand-tuned” feel rather than systemized polish.
   **Suggested remediation:** Standardize page-intro spacing tokens and enforce via shared shell/utility classes.
   **Expected impact:** Cleaner consistency with minimal design change.

4. **Location:** Dense analytical detail pages (`/stablecoin/{id}`, `/cemetery`)
   **Current state:** Many high-signal modules appear back-to-back with limited grouping transitions.
   **Issue:** Visual fatigue increases during long sessions.
   **Suggested remediation:** Add section dividers, optional progressive disclosure for secondary modules, and tighter grouping of related metrics.
   **Expected impact:** Better endurance for deep analysis sessions.

5. **Location:** Filter/control patterns across data pages (`/blacklist`, `/depeg`, `/liquidity`)
   **Current state:** Filter/search/pagination placement patterns vary by page.
   **Issue:** Users relearn controls when switching pages.
   **Suggested remediation:** Normalize control bar order and action placement across all table-heavy pages.
   **Expected impact:** Lower interaction friction and stronger cross-page learnability.

6. **Location:** Data freshness messaging cross-page
   **Current state:** Some pages show explicit freshness indicators while others rely on implicit update assumptions.
   **Issue:** Trust cues are inconsistent for a real-time analytics product.
   **Suggested remediation:** Add a consistent “last updated” micro-rail component to all data-driven pages.
   **Expected impact:** Stronger confidence in data recency and platform reliability.

### Low
1. **Location:** Methodology and changelog date presentation
   **Current state:** Date formats vary (`Mar 1` vs `Mar 1, 2026`).
   **Issue:** Minor polish inconsistency.
   **Suggested remediation:** Standardize to one short format across all changelog cards.
   **Expected impact:** Cleaner editorial consistency.

2. **Location:** Mobile footer link wraps
   **Current state:** Footer nav can become visually busy on small screens with long wraps.
   **Issue:** Slightly noisy closing section.
   **Suggested remediation:** Group links by priority and collapse secondary links behind “More”.
   **Expected impact:** Cleaner page ending and easier scan.

3. **Location:** Icon-only action affordances beyond blacklist table
   **Current state:** Some icon controls rely mainly on visual convention.
   **Issue:** Discoverability can be weaker for infrequent users.
   **Suggested remediation:** Add consistent tooltip pattern for icon-only actions.
   **Expected impact:** Better affordance clarity with minimal UI overhead.

4. **Location:** Home metadata length (`/`)
   **Current state:** Meta description is long and may truncate in SERPs.
   **Issue:** Potentially weaker search snippet control.
   **Suggested remediation:** Tighten homepage meta description toward ~150-160 characters.
   **Expected impact:** More predictable search preview quality.

5. **Location:** Minor heading/badge text concatenation semantics in assistive extraction
   **Current state:** Some heading + badge compositions read as one continuous phrase in raw extraction.
   **Issue:** Minor assistive parsing roughness.
   **Suggested remediation:** Ensure badge content has explicit separators for screen-reader output.
   **Expected impact:** Slight accessibility polish gain.

## Strategic Additions
### Addition 1: Long-Form Navigator Upgrade
**What:** Sticky in-page navigation with scrollspy and jump links for methodology/changelog and stablecoin detail content.
**Where:** `/methodology`, all `/methodology/*-changelog` pages, and `/stablecoin/{id}`.
**Why:** These pages are information-rich but slow to skim; users lose time locating specific sections.
**How:** Desktop right rail + mobile bottom-sheet index for methodology/changelog pages; auto-generated from section headings; include “Latest updates” anchor on changelog pages. On stablecoin detail pages, remove the current hero nav row and replace it with one sticky section navigator to avoid redundant navigation patterns.
**Priority:** High (after Critical fixes).

### Addition 2: Trust Rail (Unified Data Freshness Strip)
**What:** Standardized top-of-page micro-rail showing last update time, data-source health, and stale status.
**Where:** All live-data routes (`/`, `/stability-index`, `/safety-scores`, `/liquidity`, `/depeg`, `/blacklist`, `/yield`, `/flows`, `/stablecoin/{id}`, `/stablecoins/{peg}`).
**Why:** A data product needs explicit recency cues everywhere; current implementation is inconsistent.
**How:** Reuse existing query timestamps and health hooks; compact component beneath breadcrumb/title; neutral by default, warning tone when stale.
**Priority:** Medium (after shell consistency work).

### Addition 3: Not Recommended
No third addition is proposed. Additional scope at this stage would likely dilute refinement quality and increase regression risk without a proportional UX payoff.

## Implementation Roadmap
1. **Stabilize core UX defects (Week 1)**
   Fix mobile overflow on `/dependency-map`, `/flows`, `/yield` and label all icon-only tx links in `/blacklist`.
   Dependency: none.

2. **Normalize layout system (Week 1-2)**
   Expand `FeaturePageShell` into variants and migrate custom page intros to shared patterns.
   Dependency: step 1 complete (avoid layering fixes twice).

3. **Improve readability and control consistency (Week 2)**
   Apply minimum typography thresholds for dense controls/charts, standardize filter/search/pagination bars, and unify date formatting.
   Dependency: step 2 for shared token usage.

4. **Deploy high-impact enhancements (Week 3)**
   Implement the long-form navigator upgrade (methodology + changelogs + stablecoin nav replacement).
   Dependency: step 2-3 to ensure consistent shells and spacing primitives.

5. **Ship trust instrumentation and regression checks (Week 3)**
   Add unified Trust Rail and automated visual/overflow checks in Playwright for primary routes.
   Dependency: step 1 and step 2 complete.

## Autonomous Delivery Spec
### Scope Guardrails
1. Refinement-only: no new routes, no net-new data sources, no scoring/model formula changes.
2. Stablecoin detail nav must be a replacement, not additive: remove hero nav row before introducing sticky nav.
3. Cemetery is excluded from the navigator upgrade scope.
4. Keep visual language aligned with existing design tokens and component primitives.

### Execution Units
| Unit | Scope | Primary File Targets | Exit Criteria |
|---|---|---|---|
| U1 | Mobile overflow + accessibility criticals | `src/components/feature-page-shell.tsx`, `src/components/feature-status-badge.tsx`, `src/app/flows/page.tsx`, `src/components/yield-scatter-plot.tsx`, `src/components/blacklist-table.tsx` | No horizontal overflow on `/dependency-map`, `/flows`, `/yield` at `390x844`; tx icon links in blacklist table have contextual `aria-label`s |
| U2 | Page-shell consistency normalization | `src/components/feature-page-shell.tsx`, `src/app/blacklist/page.tsx`, `src/app/digest/page.tsx`, `src/app/about/page.tsx`, `src/app/privacy/page.tsx`, `src/app/stablecoins/[peg]/page.tsx`, `src/app/status/client.tsx` | Header/breadcrumb/title rhythm standardized across migrated pages; no visual regression in desktop/mobile top sections |
| U3 | Long-form nav upgrade | `src/app/methodology/page.tsx`, `src/components/methodology-changelog-page.tsx`, `src/app/stablecoin/[id]/client.tsx`, `src/components/stablecoin-detail/hero-card.tsx`, `src/components/detail-section-nav.tsx` | Methodology/changelog pages have sticky scrollspy nav; stablecoin detail uses one sticky section nav with hero nav row removed |
| U4 | Readability and control consistency | `src/components/yield-scatter-plot.tsx`, relevant table/filter components on liquidity/depeg/blacklist pages, changelog page components | Minimum readable label sizing applied to dense charts; filter/search/pagination ordering consistent on table-heavy pages |
| U5 | Trust rail standardization + regression harness | stale/freshness UI components and page integrations for live-data routes; Playwright audit script/checks | Unified freshness rail visible on scoped routes; automated overflow checks pass on core route set |

### Verification Protocol (Mandatory)
1. `npm run build`
2. `npm run lint`
3. `npm test`
4. Manual visual QA at desktop + mobile for: `/`, `/dependency-map`, `/flows`, `/yield`, `/blacklist`, `/methodology`, `/methodology/scoring-changelog`, `/stablecoin/1`, `/stablecoin/2`.
5. Mobile overflow assertion (`390x844`) must pass on at least: `/dependency-map`, `/flows`, `/yield`, `/stablecoin/1`, `/methodology`.

### Evidence Required Per Unit
1. Before/after screenshots (desktop + mobile) for touched pages.
2. File list of changed components and rationale.
3. Verification command outputs summarized in PR/task notes.
4. Explicit confirmation that no forbidden scope changes occurred (guardrails above).

### Stop Conditions (Re-Plan Trigger)
1. Any change requires introducing a second section nav on stablecoin pages.
2. Any refinement causes new overflow on previously passing routes.
3. Any shell migration forces route-specific one-off styles that break token consistency.
4. Any scoped change requires backend/API schema modification.

## Cold-Start Handoff (Context Reset Safe)
### Baseline Facts To Preserve
1. Mobile overflow baseline at `390x844`:
   `/dependency-map` -> `419px`, `/flows` -> `432px`, `/yield` -> `457px`.
2. Stablecoin navigation rule:
   remove the current hero nav row, then implement one sticky section navigator (no dual-nav state).
3. Navigator scope constraint:
   Cemetery remains out of the navigator addition scope.

### Strict Execution Order
1. Execute units strictly in this order: `U1 -> U2 -> U3 -> U4 -> U5`.
2. Do not run later units before prior unit exit criteria are satisfied.

### Per-Unit Completion Checklist
For each unit (`U1`-`U5`), record all four before marking complete:
1. Files changed (exact paths).
2. Routes verified (desktop + mobile).
3. Evidence attached (before/after screenshots + command summary).
4. Exit criteria result (`pass` or `fail` with reason).

### Verification Commands (Copy/Paste)
```bash
npm run build
npm run lint
npm test
```
Required visual verification routes: `/`, `/dependency-map`, `/flows`, `/yield`, `/blacklist`, `/methodology`, `/methodology/scoring-changelog`, `/stablecoin/1`, `/stablecoin/2`.

### Implementation Log Template
Use this table in the working notes/PR to preserve decision traceability after context reset:

| Date | Unit | Agent | Decision | Risk | Status |
|---|---|---|---|---|---|
| YYYY-MM-DD | U1 | <name> | <what changed and why> | <known risk> | in_progress/completed |
