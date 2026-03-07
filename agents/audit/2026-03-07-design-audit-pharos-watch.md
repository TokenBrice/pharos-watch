# Pharos Design Audit

Audit date: March 7, 2026  
Site audited: `https://pharos.watch`  
Evidence: desktop captures at `1440x2000` and mobile captures at `390x844` saved under `output/playwright/pharos-audit/`

## Scope

- Audited every public route template in `src/app`, plus the live `404` page.
- Dynamic templates were checked on multiple live instances:
  - Stablecoin detail: `USDT`, `USDC`, `USDe`, `XAUT`
  - Peg directory: `USD`, `Gold`
  - Digest entry: `2026-03-07`
- Reviewed the live site in both desktop and mobile layouts.

## First Impression

- First 5 seconds: credible, technical, serious, and clearly not a scammy crypto landing page.
- The dark shell, restrained accent color, mono numerics, and dense tables communicate competence quickly.
- The downside is immediate: it feels like a strong beta for power users, not yet a fully polished institutional research product.
- The biggest emotional drag is not style gimmicks. It is unfinished behavior: blank-state tools, mobile overlays, and long text blocks where users expect quicker scanability.

## Executive Summary

Pharos already has a stronger design foundation than most niche crypto dashboards. It does **not** read as generic AI slop. The product has a coherent dark-first shell, consistent navigation, disciplined typography choices, good data density, and a few standout surfaces, especially `Liquidity`, `Stability Index`, `Flows`, `Cemetery`, and the stablecoin detail template. The design tone matches the brand: sober, analytical, and competence-first.

The site's main weakness is that the experience still swings between "serious research terminal" and "unfinished internal tool." I found **25 issues total: 2 Critical, 14 Major, 9 Minor**. The most damaging problems are the mobile floating feedback button covering real content, weak empty states on `Compare`, `Portfolio`, and `Status`, and hierarchy problems caused by long prose blocks and overloaded utility surfaces. The trajectory is clear: keep the existing visual language, but tighten hierarchy, reduce dead space, make mobile-safe interaction choices, and give empty states the same care as the flagship data pages.

## Positive Foundations

- The desktop sidebar and mobile sheet navigation are logically grouped and easy to understand.
- `Geist` plus `Geist Mono` is a strong base for a data product; numerics feel trustworthy.
- Iconography is consistent. Lucide usage is clean, and the `Cemetery` tombstone treatment gives the brand a memorable visual signature.
- `Liquidity`, `Stability Index`, and the stablecoin detail pages feel like real product pages, not placeholders.
- Keyboard basics are present: the skip link is visible on focus and focus rings are not missing.

## Severity-Rated Findings

| Severity | Location | Category | Problem | Recommended Fix |
|---|---|---|---|---|
| Critical | All mobile pages; especially `/`, `/stablecoins/usd`, `/yield`, `/depeg`, `/methodology`, `/privacy` | Responsiveness, Trust | The fixed `Feedback` button sits on top of body copy, charts, filters, and table edges. On mobile home it covers digest prose; on directory pages it intrudes into the right edge of the data table; on chart pages it lands inside the visualization area. | On `<640px`, replace the floating pill with a `44px` icon docked inside a mobile utility bar or footer rail. If it stays fixed, reserve a `56-64px` right-bottom safe zone for content and auto-hide the button while scrolling down. |
| Critical | `/compare`, `/portfolio`, `/status` | Hierarchy, Trust | These pages expose large dark voids with minimal instructional content. They feel unfinished rather than intentionally minimal, which materially hurts trust. | Replace the blank regions with structured onboarding panels: a 3-step explainer, one sample scenario, and a visual preview of the resulting output. Keep pre-result dead space below `160px` before the next explanatory module. |
| Major | `/` home; especially mobile | Hierarchy, Content Priority | The digest excerpt takes over the homepage too early. On mobile the landing experience becomes an essay before users reach the stablecoin directory, which is the site's core utility. | On mobile, move the directory above the digest preview. Cap the homepage excerpt to `60-90 words` mobile and `120-160 words` desktop, then push the full write-up behind `Read today's digest`. |
| Major | `/` home top KPI band | Hierarchy, Trust | The KPI row gives nearly equal emphasis to every metric, so the eye has no obvious first stop. It also lacks a stronger "why trust this data" strip near the masthead. | Make PSI the dominant hero stat by allowing it to span more width, compress the other KPIs into a secondary row, and add a compact trust strip such as `Updated 5m ago | Sources: DefiLlama, CoinGecko, on-chain events`. |
| Major | `/digest`, `/digest/2026-03-07`, homepage digest block | Typography | The editorial copy is readable but too wide and too italic-heavy for long passages. On desktop, lines run too long; on mobile, the paragraph block feels dense and slow. | Constrain longform copy to `max-width: 68ch`, reduce the amount of italic text, and introduce a short bullet summary card before the full narrative. |
| Major | Global footer on all pages; especially mobile | Navigation, Hierarchy | The footer repeats too many top-level routes plus category links. It reads as an overloaded sitemap, not a purposeful page ending, and it adds friction on short mobile pages. | Reduce the top footer nav to `5-6` core destinations, move categories into a dedicated browse page or a smaller sheet, and increase vertical separation between utility links, socials, and the disclaimer. |
| Major | `/methodology` and all methodology changelog pages | Hierarchy, Typography, Spacing | These pages are extremely dense, with repeated full-width cards, tiny jump tabs, and long sections that visually look too similar. The result is technically thorough but hard to scan. | Convert the jump nav into a sticky section rail, constrain prose blocks to `760-820px`, use larger section breaks, and collapse secondary details by default instead of making every block equally prominent. |
| Major | `/blacklist` > `Blacklisted Funds Over Time` | Chart Design, Hierarchy | The chart reads like two bright cyan blocks on a dark canvas rather than a deliberate analysis graphic. It looks placeholder-like and under-annotated. | Reduce chart height to about `280px` desktop / `220px` mobile, use grouped or stacked bars with distinct series styling, and add clearer y-axis labeling and annotations for the two spikes. |
| Major | `/yield` > `Yield vs Safety` | Chart Design, Hierarchy | The scatter plot feels under-populated and visually empty for the amount of space it occupies. The main insight is weaker than the card title suggests. | Reduce the plot height to `220-260px`, enlarge data points to `6-8px`, default the visible domain to the populated score range, and add a compact legend or quadrant explainer card beside it. |
| Major | `/dependency-map` on mobile | Responsiveness | The graph is technically responsive, but it becomes too small to interpret comfortably. Users can see that something exists, but not meaningfully read it. | Under `640px`, offer an `Expand graph` full-screen landscape modal or switch to a ranked list of top dependency links beneath the chart. |
| Major | `/stablecoin/usdt-tether` and the shared detail template on mobile | Responsiveness, Spacing | The hero packs token name, price, market cap, supply, peg score, liquidity score, radar, tabs, and feedback affordance into one dense fold. It remains usable, but it is near the upper limit of comfortable mobile density. | Collapse secondary KPIs into a `More stats` drawer, keep only `price`, `peg`, `mcap`, and the primary score above the fold, and make the tab rail sticky once the user scrolls. |
| Major | `/stablecoins/usd`, `/stablecoins/gold` on mobile | Responsiveness, Interaction | The table is intentionally horizontal-scrollable, but the toolbar, frozen first column, and floating feedback button all compete for the right edge. | Keep the table utilities in a sticky top row, add at least `56px` of protected space on the right when a floating control exists, and visually separate the table from the footer. |
| Major | `/status` | Trust, Hierarchy | The page is publicly reachable yet visually reads like an internal operator screen left exposed. The form sits low in a large empty field with little explanation. | If the route is intentionally public, redesign it as a secure access page with a higher card position, clear explanation, support path, and stronger framing. If it is not meant for public users, remove it from discoverable routing. |
| Major | `/portfolio` | Trust, Onboarding | The page presents a single input and a large empty void. There is no assurance about where data is stored, no example portfolio, and no reason for first-time users to continue. | Add sample portfolios (`Majors`, `Yield-heavy`, `RWA-heavy`), a short `stored locally only` note, and a preview of the risk breakdown users will get after entering holdings. |
| Major | `/compare` | Hierarchy, Onboarding | The dashed compare well is visually bigger than the actual guidance, but it does not teach the interaction. The quick-comparison cards below do more real work than the primary empty area. | Preload one default comparison or show a table preview skeleton inside the empty area. Turn quick comparisons into prominent, clickable chips or segmented presets directly above the empty state. |
| Major | `/safety-scores` on mobile | Spacing, Hierarchy | Grade distribution, contagion simulation, filters, and the score grid all compete in the same fold. The transition from controls to cards feels compressed. | Increase the spacing between simulator controls and the grid, collapse secondary filters into `More filters`, and surface the first row of score cards sooner. |
| Major | Mobile home and digest surfaces | Typography, Responsiveness | Long serif/italic digest copy is elegant on desktop but too heavy in narrow viewports, where it becomes a wall of text between utility sections. | Switch the mobile digest teaser to a shorter sans summary with one emphasized takeaway and a link to the full article. Keep the full editorial treatment on the dedicated digest page. |
| Minor | `/about` | Component Consistency, Color | The feature cards are consistent, but too many of them have equal visual weight and colored accents. The page feels informative yet slightly monotonous. | Promote `1-2` cards to hero status, flatten the rest into simpler rows or grouped blocks, and reserve accent borders for truly priority modules. |
| Minor | `/privacy` desktop | Spacing, Typography | The content is clear but visually under-framed. The page leaves a large field of unused space to the right and below, which makes it feel lightly finished. | Keep the narrow reading column, but add a small secondary column or callout card with contact/privacy highlights, or reduce the perceived emptiness with a lighter section rhythm. |
| Minor | `/does-not-exist` | Trust, Navigation | The 404 page has strong mood but too few recovery routes. The user gets one exit path back to the dashboard and little else. | Add search, `top tools`, and `latest digest` links, plus one `Browse stablecoins` recovery path. |
| Minor | Feature status badges across pages | Consistency, Color | `Mature`, `Experimental`, version badges, and score/status badges all share similar visual weight. The color system works, but semantics blur together. | Reserve amber strictly for experimental surfaces, green for mature, and keep version badges neutral. Reduce the number of badge styles used in the first screen of a page. |
| Minor | Global microcopy in footers, legends, methodology labels, card metadata | Typography, Accessibility | A lot of functional metadata sits at `11-12px` and often at reduced opacity. It looks refined, but some of it is too faint for effortless scanning. | Raise the minimum functional microcopy size to `13px` on mobile and avoid using opacity lower than about `0.7` for anything users need to understand, not just decorative metadata. |
| Minor | Non-data accents across cards and callouts | Color Consistency | The system uses cyan, amber, violet, teal, blue, rose, and orange on many card edges and badges. The palette is individually nice but too broad for non-data surfaces. | Cap the non-data accent palette to `frost blue`, `emerald`, `amber`, and `rose`. Use extra hues only when they encode real meaning. |
| Minor | Token logos across directories and detail pages | Imagery Consistency | Asset logos are inherently mixed-quality and some disappear into dark backgrounds or look lower fidelity than neighboring assets. | Render every token icon inside a consistent `28px` contained badge with a neutral ring/background so source-asset quality varies less visibly. |
| Minor | Initial render on some chart pages; observed with live console warnings on home | Micro-details, Perceived Quality | Recharts emits sizing warnings during initial render. Users do not see the console, but issues like this often correlate with brief visual instability or awkward loading transitions. | Reserve exact chart heights from first paint, remove negative dimension states, and align skeletons more closely to final chart shapes. |
| Minor | Mobile footer | Navigation | Short pages end with a dense stack of repeated links plus the category accordion. It extends the "exit area" without adding enough new value. | On mobile, keep utility links and social actions, but trim duplicate route links if the hamburger menu already covers primary navigation. |

## Page-by-Page Audit

Scoring scale: `1 = actively untrustworthy`, `10 = polished, flagship-quality product page`

| Route | Score | Notes |
|---|---:|---|
| `/` | 7.0 | Strong shell and trustworthy data tone. Mobile hierarchy is the main problem because the digest teaser takes over too early. |
| `/about` | 7.0 | Clear, useful, credible. Slightly over-carded and too visually even. |
| `/blacklist` | 6.5 | Serious and useful, but the hero chart feels visually underdesigned relative to the table. |
| `/cemetery` | 8.0 | One of the most memorable and differentiated pages. Good brand character without sacrificing clarity. |
| `/compare` | 5.0 | Structure is clear, but the first-run experience looks unfinished and under-guided. |
| `/depeg` | 7.5 | Dense but coherent. Strong use of scoring color and hierarchy. Mobile still suffers from floating control overlap. |
| `/dependency-map` | 7.0 | Strong desktop presence. Mobile graph readability drops sharply without an alternate view. |
| `/digest` | 7.0 | Good editorial tone. Preview copy should be shorter and more structured. |
| `/digest/2026-03-07` | 7.5 | Stronger than the archive page, but prose width and italic density should be refined. |
| `/flows` | 8.0 | One of the strongest pages. Good headline, strong top summary, clear data storytelling. |
| `/liquidity` | 8.0 | Best-in-class page in the current system: clear KPI summary, strong leaderboard, restrained hierarchy. |
| `/methodology` | 6.0 | Thorough and credible, but visually exhausting. Needs a stronger reading architecture. |
| `/methodology/scoring-changelog` | 6.0 | Functional but list-heavy; hierarchy is too flat for long change histories. |
| `/methodology/depeg-changelog` | 6.0 | Same structural issue as the other changelog pages: informative but visually monotonous. |
| `/methodology/blacklist-tracker-changelog` | 6.0 | Same pattern: solid information, low scanability. |
| `/methodology/liquidity-score-changelog` | 6.0 | Dense, technically useful, and visually repetitive. |
| `/methodology/stability-index-changelog` | 6.0 | Clear data, weak pacing and low differentiation between entries. |
| `/methodology/mint-burn-flow-changelog` | 6.0 | Same recurring hierarchy problem as the other changelog routes. |
| `/methodology/yield-changelog` | 6.0 | Useful content, but not enough visual structure for repeated long-form updates. |
| `/portfolio` | 4.5 | Reads like an unfinished tool screen, not a launched product page. |
| `/privacy` | 6.0 | Clean and readable, but too visually sparse to feel deliberately designed. |
| `/safety-scores` | 7.0 | Good desktop information density. Mobile spacing and filter compression need refinement. |
| `/stability-index` | 8.0 | Strong top card, strong chart hierarchy, and one of the clearest flagship pages. |
| `/status` | 4.0 | The weakest page from a trust perspective. Publicly visible but framed like a private internal panel. |
| `/yield` | 7.0 | Promising and credible, but the hero chart needs stronger visual explanation. |
| `/stablecoin/usdt-tether` | 8.0 | Strong detail template with good score framing. Mobile fold is a little too dense. |
| `/stablecoin/usdc-circle` | 8.0 | Same strengths as the shared template; trustworthy and well structured. |
| `/stablecoin/usde-ethena` | 8.0 | Shared template holds up well even on more complex assets. |
| `/stablecoin/xaut-tether` | 8.0 | Shared template still works, though logo and category treatments vary in quality. |
| `/stablecoins/usd` | 7.5 | Strong directory page. Mobile interaction edge cases keep it out of the 8+ range. |
| `/stablecoins/gold` | 7.5 | Same strengths as the USD directory; visually solid and credible. |
| `/does-not-exist` | 6.0 | Mood is good, recovery options are too thin. |

## Design System Recommendations

The current system is fundamentally sound. The goal is not a redesign from scratch. It is a tighter, more opinionated version of what already exists.

### Type

| Token | Recommendation | Usage |
|---|---|---|
| `--type-00` | `12/16` | quiet metadata only |
| `--type-0` | `13/18` | functional microcopy, chip labels, legends |
| `--type-1` | `15/22` | default body copy |
| `--type-2` | `17/26` | longform digest body |
| `--type-3` | `20/28` | card headings, section intros |
| `--type-4` | `24/32` | secondary page titles |
| `--type-5` | `32/38` | standard page titles |
| `--type-6` | `40/44` | flagship hero metrics only |

- Keep `Geist` for UI and `Geist Mono` for numerics.
- Use serif only for dedicated digest longform pages, not homepage teasers.
- Make `15px` the default interface body size instead of leaning so often on `14px`.

### Color

| Role | Recommendation |
|---|---|
| Base background | `oklch(0.085 0.015 260)` |
| Raised surface | `oklch(0.22 0.01 260)` |
| Overlay/card | `oklch(0.14 0.01 260)` |
| Primary text | `oklch(0.985 0 0)` |
| Secondary text | `oklch(0.80 0.01 260)` |
| Muted text | `oklch(0.70 0.01 260)` |
| Brand accent | Frost blue only for navigation, focus, and primary links |
| Success | Emerald / green |
| Warning | Amber |
| Danger | Red |
| Experimental only | Violet |

- Stop using many accent hues on card edges unless they encode meaning.
- Keep charts colorful where data demands it; simplify non-data UI surfaces.

### Spacing

| Token | Recommendation |
|---|---|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `20px` |
| `--space-6` | `24px` |
| `--space-8` | `32px` |
| `--space-10` | `40px` |
| `--space-12` | `48px` |
| `--space-16` | `64px` |

- Use `24px` as the default gap between stacked major modules.
- Use `32-40px` between title blocks and dense data sections.
- Reduce giant dead zones on sparse tool pages by replacing empty height with instructional modules.

### Radius

| Token | Recommendation |
|---|---|
| Small controls | `8px` |
| Standard cards | `12px` |
| Pills | `9999px` |

- Keep the current rounded look, but avoid mixing too many radius personalities in a single fold.

### Shadow

| Token | Recommendation |
|---|---|
| Resting card | `0 1px 2px rgba(0,0,0,0.30), 0 10px 30px rgba(0,0,0,0.22)` |
| Hover card | `0 2px 6px rgba(0,0,0,0.32), 0 18px 44px rgba(0,0,0,0.28)` |
| Floating action | reserve for one control only | 

- Use heavy shadows sparingly. The site already has enough depth without extra glow.

## Priority Roadmap

### Phase 1 - Quick wins

- Remove or redesign the mobile floating feedback button so it never overlaps content.
- Rewrite the empty states for `Compare`, `Portfolio`, and `Status`.
- Shorten the homepage digest preview and move the stablecoin directory higher on mobile.
- Simplify the footer hierarchy and trim duplicate links.
- Reduce the height of the weakest hero charts on `Blacklist` and `Yield`.

### Phase 2 - Structural improvements

- Redesign `Methodology` and all changelog pages around a stronger reading layout.
- Create mobile-specific alternates for charts that collapse poorly, especially `Dependency Map`.
- Rebuild the stablecoin detail mobile fold with fewer above-the-fold stats.
- Introduce a more opinionated homepage hierarchy with one dominant hero stat and one trust strip.
- Standardize empty-state modules as reusable components instead of page-specific one-offs.

### Phase 3 - Polish and delight

- Normalize token logos inside consistent containers.
- Tighten badge semantics and reduce color noise on non-data surfaces.
- Improve longform editorial rhythm on digest pages.
- Expand the `404` and sparse legal/support pages with clearer recovery paths.
- Refine loading states so charts reserve final height from first paint.

## Before / After Descriptions

### 1. Mobile feedback button

**Current state:** a fixed pill-shaped button sits in the bottom-right corner on nearly every mobile page. It overlaps digest text, chart corners, table edges, and filter panels.  
**Desired end state:** on mobile, feedback becomes a compact icon inside a bottom utility rail or footer dock. It never overlaps live content. If it remains floating, it auto-hides on downward scroll and only reappears when the user scrolls upward or reaches the page end.

### 2. Compare and Portfolio empty states

**Current state:** both pages open into a large dark field with one control row and almost no teaching. The user sees space before value.  
**Desired end state:** each page opens with a structured onboarding module containing:
- one-sentence value proposition
- 3-step usage guidance
- one or two preset examples
- a visual preview of the output layout

The page should feel intentionally staged, not unfinished.

### 3. Homepage mobile hierarchy

**Current state:** after the KPI cards, the homepage quickly becomes a long digest article preview. The primary stablecoin directory is pushed too far down.  
**Desired end state:** mobile home should lead with the market snapshot, then the searchable stablecoin directory, then a compact digest teaser. The teaser should be short enough to scan in under 10 seconds and should link clearly to the full digest page.

### 4. Methodology readability

**Current state:** methodology content is technically rich but visually repetitive: similar cards, dense labels, and long vertical runs with little pacing.  
**Desired end state:** the page becomes a structured reference system with:
- sticky section nav
- constrained reading width
- stronger section separators
- formulas and thresholds in dedicated callout blocks
- secondary details collapsed by default

The page should feel like a polished research manual, not a long settings screen.

### 5. Status page trust framing

**Current state:** the public route shows a sparse admin login card floating in a large empty field, which reads as accidental exposure.  
**Desired end state:** if the page remains public, it should look like a deliberate secure access screen: headline, explanation, support contact, and one elevated access card positioned in the upper-middle of the viewport. If it is not meant for users, it should be removed from public-facing discovery entirely.

## Competitive Context

Relative to current crypto analytics standards set by products like DeFiLlama, Artemis, Token Terminal, and Nansen, Pharos is already ahead on visual identity and tonal consistency. It feels more authored than many dashboards in the category, especially on `Cemetery`, `Digest`, and the stablecoin detail pages.

Where it trails stronger peers is not branding. It is product finish:

- best-in-class analytics products handle empty states more intentionally
- they protect mobile content from floating controls more carefully
- they separate editorial prose from operational dashboards more decisively
- they use whitespace and control grouping to make dense screens feel less fatiguing

Patterns worth adopting:

- Sticky filter/control rails adjacent to tables, not floating near them
- Guided presets for comparison and portfolio tooling
- Narrower longform reading columns with short executive summaries above the prose
- Mobile-specific alternate views for complex charts instead of pure shrink-to-fit behavior

## Bottom Line

Pharos already has the bones of a professional, trustworthy analytics product. The next step is not "make it prettier." The next step is to eliminate the small set of behaviors that make certain pages feel beta or internal. Once the mobile overlay issue, empty-state quality, and longform/dashboard hierarchy are fixed, the rest of the system is strong enough to support a genuinely top-tier finish.
