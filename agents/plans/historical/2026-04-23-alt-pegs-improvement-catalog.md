# Alt-Pegs Improvement Catalog

Date: 2026-04-23

Status: Idea catalog, not an implementation plan.

Scope: Consolidated review of the current `/alt-pegs/` route from 6 specialized `gpt-5.4 xhigh` reviewers:

- UX/UI review
- Charts and data-surface review
- Persona review
- DAdvisoor-style critique based on the original feedback
- Information architecture / editorial review
- Product differentiation review

## What Already Works

- The route exists as a dedicated research surface instead of leaving the topic trapped in a cramped homepage preview.
- Current-state modules come before historical modules, which matches the route’s job and helps trust.
- The current distribution card is the strongest existing module because it quickly answers “which pegs matter now?”
- The static link hub is structurally sound and the regional grouping is a good IA choice.
- The overall tone is already mostly on-brand: dense, calm, practitioner-first, and not generic web3 marketing slop.

## Repeated Problems Across Reviews

1. The historical layer still has a trust gap.
   Users can reasonably wonder why history appears “big early,” what is coverage versus backfill, and why the page mixes different constructions without saying so clearly enough.
2. The cohort history chart is too dense for the job it is trying to do.
   It is being asked to show composition, ranking, size, and broadening all at once.
3. The route is a dedicated page, but the densest modules still do not feel like true drill-down destinations.
   The original “click to open bigger and inspect comfortably” use case is only partially solved.
4. The page explains scope more than it states a thesis.
   It describes what is on the page, but not the strongest current takeaway.
5. The page does not yet fully separate “all alt-pegs” from “fiat non-USD.”
   Commodity dominance can obscure the fiat-currency story users often expect.
6. Mobile users pay too much scroll tax before reaching the deeper explanatory modules.
7. The route still feels more like a good chart page than a signature Pharos intelligence surface.

## Consolidation Notes

- This document clusters overlapping ideas so it stays usable.
- No major idea from the six reviewers was intentionally dropped.
- When multiple reviewers pushed the same direction, the catalog merges them into one entry and lists all relevant source perspectives.

## Ranked By Impact Vs Effort

### High Impact / Small Effort

| ID | Idea | Why it matters | Source perspectives |
| --- | --- | --- | --- |
| H-S1 | Default historical views to `1Y` or `3Y`, keep `All` one click away, and remember preference | Immediately reduces the “this looks wrong” reaction and makes the page usable for more personas on first load | Personas, DAdvisoor |
| H-S2 | Rename the history modules so their unit is explicit | Removes share-vs-dollar confusion before users even read tooltips | UX/UI, IA, DAdvisoor |
| H-S3 | Add exact historical coverage / cadence notes near both charts | Fixes a central trust leak with minimal surface area | IA, Charts, Personas, DAdvisoor |
| H-S4 | Replace `Start with EUR` with chart-native next steps | The current CTA is arbitrary and weak compared to the user’s actual task | DAdvisoor, Personas |
| H-S5 | Clean up count language and split “active now” vs “historically tracked” | Avoids current confusion like “18 active pegs” versus “26 tracked” | Personas |

### High Impact / Medium Effort

| ID | Idea | Why it matters | Source perspectives |
| --- | --- | --- | --- |
| H-M1 | Add explicit `Open large chart` / preview-to-detail affordances | Directly addresses the original complaint that inspired the page | UX/UI, DAdvisoor, Charts |
| H-M2 | Add a page thesis plus a `What changed` / `What matters now` strip | Turns the route into an authored surface instead of a stack of modules | IA, Personas |
| H-M3 | Reframe the top fold around dual metrics: `all alt-pegs` and `fiat non-USD` | Separates the commodity-dominant story from the fiat-currency opportunity story | Personas, DAdvisoor |
| H-M4 | Add a `Broadening vs Concentration Board` | Best one-glance answer to the route’s real job: is the segment diversifying or still one trade? | Differentiation |
| H-M5 | Replace the primary cohort-history experience with `Top N + Other`, spotlight mode, or small multiples | Solves readability, mobile density, and historical overplotting at the same time | UX/UI, Charts, Personas, DAdvisoor |
| H-M6 | Pair total share with a synced absolute-cap companion view | Makes it obvious whether a move is share, dollars, or both | Charts |
| H-M7 | Add a leader-dependence / concentration surface | Shows whether a cohort is broad or basically one issuer with a tail | Differentiation, Charts |
| H-M8 | Make the distribution section more guided | Adds filters, context, badges, or top-preview behavior so the ranking is more than a static list | IA, Personas, UX/UI |

### High Impact / Large Effort

| ID | Idea | Why it matters | Source perspectives |
| --- | --- | --- | --- |
| H-L1 | Build a compare lab or larger cohort drill-down surface | Most direct path from “interesting overview” to “comfortable research tool” | Charts, Differentiation, DAdvisoor |
| H-L2 | Add a `Cohort Dossier` experience | Makes clicking a cohort feel like entering a purpose-built intelligence brief rather than a generic taxonomy page | Differentiation |
| H-L3 | Add a `Cohort Credibility Matrix` tying size/growth to liquidity and peg behavior | Most distinctive cross-surface synthesis idea in the set | Differentiation |

### Medium Impact / Small Effort

| ID | Idea | Why it matters | Source perspectives |
| --- | --- | --- | --- |
| M-S1 | Add a compact primer: “what counts as non-USD here?” | Helps casual and journalist users who assume this means fiat only | Personas |
| M-S2 | Simplify legends and `Other` labeling | Reduces a lot of avoidable decoding friction, especially on mobile | DAdvisoor, Personas |
| M-S3 | Tighten the hero takeaway and make the mix bar earn its space | The top fold currently reports facts without concluding much | UX/UI, DAdvisoor |
| M-S4 | Add glossary / reference-type explainers | Lowers entry cost without changing the route’s power-user posture | IA, Differentiation |
| M-S5 | Improve row-level affordance and touch discoverability | Helps the page feel intentionally interactive rather than passively inspectable | UX/UI |

### Medium Impact / Medium Effort

| ID | Idea | Why it matters | Source perspectives |
| --- | --- | --- | --- |
| M-M1 | Add a contribution view such as `Who Drove The Move?` | Strongest revisit-value chart concept besides the drill-down lab | Differentiation, Charts |
| M-M2 | Add a breadth-over-time threshold chart | Most direct metric for “is non-USD actually broadening?” | Charts |
| M-M3 | Add rank-over-time / bump or heatmap views | Better than stacked areas for historical relevance and regime shifts | Charts |
| M-M4 | Add first-seen / peak / drawdown / lifecycle context | Answers “did these even exist then?” in a structured way | Charts, DAdvisoor |
| M-M5 | Reorder or collapse the long distribution list on mobile | Cuts the “comfortable dedicated page” problem substantially on phones | Personas, UX/UI |
| M-M6 | Turn the link hub into a guided end-of-page router | Keeps crawlability while making the ending feel curated instead of appended | IA, UX/UI, Personas |
| M-M7 | Add a `Since last visit` / threshold-crossers / briefing strip | Creates concrete revisit value for frequent users | Differentiation |
| M-M8 | Add a regional fiat atlas or mosaic | Gives fiat non-USD a more memorable macro lens | Differentiation, Charts |

### Medium Impact / Large Effort

| ID | Idea | Why it matters | Source perspectives |
| --- | --- | --- | --- |
| M-L1 | Add a historical `Other` unpacker that respects hovered date, not only current rank | Repairs a subtle but important history-trust problem | Charts |
| M-L2 | Add a searchable power-user ranking table with derived history stats | Good for exact comparison, but less core than the better story surfaces above | Charts |
| M-L3 | Add a coin-size distribution beeswarm within cohorts | Rich structural view, but not as essential as concentration or contribution modules | Charts |

## Full Idea Catalog

### 1. Trust, Framing, And Historical Readability

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| T1 | Default recent history first | High | Small | Open history modules on `1Y` or `3Y`, not `All`, while preserving one-click all-time access and remembering preference | Personas |
| T2 | Coverage-start and cadence disclosure | High | Small | Show exact history start, pre-coverage shading, and a tiny note like `daily last 90d, weekly to 2y, monthly beyond` | IA, Charts, Personas, DAdvisoor |
| T3 | Explicit share-vs-dollar labeling | High | Small | Make it impossible to confuse `% of total stablecoin market` with `$ alt-peg market cap` | UX/UI, IA, DAdvisoor |
| T4 | Share + absolute-cap companion | High | Medium | Pair total share with absolute non-USD cap so early history is easier to interpret correctly | Charts |
| T5 | Trust-preserving history mode | High | Medium | Add `Share / USD / Indexed` toggles, coverage markers, and disciplined default framing | Differentiation |
| T6 | Top-N first instead of full dense history | High | Medium | Use `Top 5` or `Top 8 + Other`, spotlight mode, or small multiples before exposing the full stack | UX/UI, Charts, Personas, DAdvisoor |
| T7 | Historically aware `Other` behavior | Medium | Large | Let users see what was inside `Other` at the hovered date and avoid latest-size-only historical grouping | Charts, DAdvisoor |
| T8 | First-seen / peak / drawdown / lifecycle context | Medium | Medium | Show when cohorts became meaningful and whether older peaks still matter now | Charts, DAdvisoor |
| T9 | Sparse structural annotations | Medium | Medium | Add a few explicit callouts for early gold dominance, later fiat broadening, and methodology-relevant breaks | Personas, Charts |

### 2. Better Top Fold And Stronger Page Story

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| S1 | Add a clear thesis | High | Medium | Replace “here is the route scope” with a stronger current takeaway | IA, UX/UI |
| S2 | Add a `What changed` / `What matters now` strip | High | Medium | Use the top fold to summarize the last year and current shape before deeper charts | IA, Personas |
| S3 | Split all alt-pegs from fiat non-USD | High | Medium | Show dual headline metrics so the page does not bury the fiat story beneath gold | Personas |
| S4 | Broadening vs Concentration Board | High | Medium | Show concentration, ex-gold share, ex-top-3 share, and cohort counts above meaningful thresholds | Differentiation |
| S5 | Pharos Take Card | Medium | Small | One restrained, timestamped sentence stating the current read in plain English | Differentiation |
| S6 | Hero metrics that say something structural | Medium | Small | Replace or complement simple inventory counts with concentration or breadth metrics | DAdvisoor |
| S7 | Make the mix bar earn its space | Medium | Small | Either clarify it much better or replace it with something structurally sharper | UX/UI, DAdvisoor |

### 3. New Data Points And Replacement Chart Concepts

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| C1 | Small multiples for top cohorts | High | Medium | Replace the main dense stack with readable cohort-specific mini charts | Charts, Differentiation |
| C2 | Compare lab for pinned cohorts | High | Large | Let users pin up to a few cohorts and inspect synchronized comparisons in a larger surface | Charts |
| C3 | Contribution waterfall / `Who Drove The Move?` | Medium | Medium | Explain 30D/90D/1Y growth or decline by cohort and then by coin | Charts, Differentiation |
| C4 | Breadth-over-time thresholds | Medium | Medium | Count pegs above thresholds like `$10M`, `$100M`, `$1B` over time | Charts |
| C5 | Rank-over-time bump chart | Medium | Medium | Show which cohorts gained or lost historical relevance | Charts |
| C6 | Historical heatmap | Medium | Medium | A better dense-history visualization than many stacked slivers | Charts |
| C7 | Indexed growth mode | Medium | Medium | Compare growth rates without starting-size distortion | Charts |
| C8 | 30D momentum ranking | High | Medium | Add current change ranking so users can see what is moving now, not just what is large now | Charts |
| C9 | Peak-vs-now table | Medium | Medium | Make older bulges legible by showing peak date and drawdown explicitly | Charts |
| C10 | Cohort lifecycle lanes | Medium | Medium | Show first seen, peak, and still-active status by cohort | Charts |
| C11 | Regional fiat atlas / mosaic | Medium | Medium | Upgrade regional grouping into a real macro lens instead of leaving it in the crawlable hub only | Differentiation, Charts |
| C12 | Coin-size beeswarm within cohorts | Medium | Large | Show whether the long tail is real or just a few tiny entries under the leader | Charts |

### 4. Concentration, Breadth, And Structural Insight

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| B1 | Leader Dependence Ladder | High | Small | Show how much of each cohort is carried by its largest coin | Differentiation |
| B2 | Current concentration surface | High | Medium | Add leader share, top-3 share, coin count, and possibly chain count per cohort | Charts |
| B3 | Guided leaderboard | High | Medium | Add badges like `largest today`, `single-coin cohort`, `commodity anchor`, or `regional cluster` | IA |
| B4 | Filters by cohort type and region | Medium | Medium | Let users cut the distribution list into more meaningful slices | Personas |
| B5 | Top preview before full list | Medium | Medium | Show the top few cohorts first, then expand to the full ranked list | Personas |

### 5. Drill-Down, Navigation, And Route Flow

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| N1 | Chart cards as destinations | High | Medium | Add clear `Open large chart` or `Open detail` actions to dense modules | UX/UI, DAdvisoor |
| N2 | Cohort dossier drill-down | High | Large | Clicking a cohort opens a focused brief with top coins, dependence, movement, peg posture, liquidity posture, and next actions | Differentiation |
| N3 | Research-router CTA rail | Medium | Small | Offer direct jumps like `Open depegs`, `Open liquidity`, `Compare leaders`, `Read methodology` | Differentiation |
| N4 | Replace `Start with EUR` with contextual next steps | High | Small | Use the user’s actual analytical task to drive the CTA, not one arbitrary cohort | DAdvisoor, Personas |
| N5 | Task-oriented end-of-page hub | Medium | Medium | Keep the crawlable taxonomy, but visually lead with “where to go next” routes | IA, Personas |
| N6 | Curated compare presets | Medium | Small | Provide one-click curated cohort or coin comparisons | Differentiation |

### 6. Mobile, Interaction, And Surface Polish

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| U1 | Collapse or reorder the full distribution list on mobile | High | Medium | Reduce scroll before history and drill-down content | Personas |
| U2 | Row-wide tap targets in the ranking card | Medium | Medium | Make rows feel like intentional interactive objects instead of link fragments | UX/UI |
| U3 | Better touch discoverability on charts | Medium | Medium | Add a restrained hint, pinned latest state, or series-isolation behavior for mobile | UX/UI |
| U4 | Two-tier chart headers on small screens | Medium | Small | Reduce title / subtitle / control crowding in the chart header zone | UX/UI |
| U5 | Bring the share chart up to the route’s authored visual standard | Medium | Small | The share chart currently feels more generic than the rest of the route | UX/UI |
| U6 | Compress the static link hub visually while preserving crawlable HTML | Medium | Medium | Keep SEO value without ending the page on a dense directory feel | Personas |

### 7. Copy, Terminology, And Comprehension Aids

| ID | Idea | Impact | Effort | Summary | Reviewer sources |
| --- | --- | --- | --- | --- | --- |
| P1 | Primer: `What counts as non-USD here?` | Medium | Small | Clarify that the route includes commodities, CPI-linked, and other non-USD peg structures, not only fiat | Personas |
| P2 | Glossary / first-use help | Medium | Small | Define `alt-peg`, `cohort`, `fiat non-USD`, and `Other` at the moment they matter | IA |
| P3 | Humanize legend labels | Medium | Small | Reduce cognitive tax from labels like `REAL`, `Franc`, and long wrapped legend strings | Personas |
| P4 | Standardize denominator language everywhere | High | Small | Be explicit whenever a share is “of total stablecoin market” vs “of alt-peg market” | IA, DAdvisoor |
| P5 | Reference-type explainers | Medium | Small | Distinguish native-fiat, commodity-spot, CPI-linked, and other reference logic where comparisons get misleading | Differentiation |

## Persona And Product Tensions To Preserve

- Defaulting to `1Y` helps casual, journalist, and operator users, but analysts still need easy `All` access.
- Top-N cohort views fix readability, but long-tail users still need an opt-in dense mode.
- More editorial callouts improve comprehension, but power users will resent copy-heavy surfaces if they feel explanatory by default.
- Emphasizing fiat non-USD helps operators and newcomers, but the route should not pretend commodities are irrelevant when they dominate the segment.
- Compressing the link hub improves focus, but the route still needs its crawlable taxonomy surface intact.

## Suggested Signature Directions

If the goal is to make the route feel more unique and more “Pharos,” the strongest signature directions are:

1. `Broadening vs Concentration Board`
2. `Trust-Preserving History Mode`
3. `Who Drove The Move?`
4. `Cohort Dossier Drill-Down`
5. `Leader Dependence Ladder`

## Source Coverage Map

- UX/UI reviewer:
  Preview-to-detail affordances, row interactions, mobile header density, touch discoverability, share-chart styling, top-fold clarity.
- Charts reviewer:
  Replacement chart forms, synchronized share and absolute-cap framing, breadth/contribution/rank/heatmap ideas, `Other` handling.
- Persona reviewer:
  Default range, mobile flow, dual metrics, readability for casual users, CTA relevance, terminology clarity.
- DAdvisoor-style review:
  Sharpest critique of the original brief, especially true chart destinations, trust at the left edge of history, and research-tool behavior.
- IA / editorial reviewer:
  Thesis, narrative order, how-to-read notes, compact fact strips, guided ending, contextual trust language.
- Product differentiation reviewer:
  Distinctive Pharos angle, concentration-vs-breadth framing, signature modules, revisit value, and cross-surface synthesis.

## Shortlist If You Only Want 10 To Discuss First

1. Add explicit `Open large chart` affordances.
2. Default history to `1Y` or `3Y`, keep `All` one click away.
3. Add coverage-start / cadence / methodology notes directly on the charts.
4. Make share vs dollar framing explicit and pair them more clearly.
5. Split the headline into `all alt-pegs` and `fiat non-USD`.
6. Add a `Broadening vs Concentration Board`.
7. Replace the primary cohort-history view with `Top N + Other`, spotlight mode, or small multiples.
8. Add a `What changed` / `What matters now` strip.
9. Add a leader-dependence / concentration view.
10. Replace `Start with EUR` with contextual next-step actions.
