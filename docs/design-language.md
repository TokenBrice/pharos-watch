# Design Language Reference

Durable UI rules for Pharos. This document records reusable invariants and ownership boundaries, not a snapshot of every route's current class list.

Use these sources together:

- [Context](#context) below defines audience, brand personality, surface tiers, and design principles.
- [design-tokens.md](./design-tokens.md) defines the primitive, semantic, component, and JavaScript token layers.
- `src/app/globals.css` owns shared application utilities and the shadcn-to-semantic-token bridge.
- `src/components/ui/` owns low-level primitives; do not edit those primitives for route-local styling.
- Route docs own intentional page-specific compositions and exceptions.

## Context

> Canonical human-facing source. The root [`DESIGN.md`](../DESIGN.md) is a compact, hand-maintained machine-readable reference for AI screen generation, not a generated artifact. Keep both aligned with the **as-built code** when brand tokens, typography, or homepage composition change: frost-blue + the drawn lighthouse identity are retained, with a global top nav replacing the retired left "watch column" sidebar.

This document owns product posture and visual or brand adjectives. [Pharos Editorial Style](./editorial-style.md) owns sentences. On mechanics, the style authority wins.

### Users

Crypto-native DeFi participants who actively monitor stablecoin health — checking market conditions, peg stability, and risk signals regularly to inform financial decisions. The core audience is power-user-leaning: they value density, precision, and speed-to-insight over softness or consumer-app hand-holding.

Discovery and onboarding surfaces (`/start/`, first-run callouts, `/about/`, `/api/` public landing, `/learn/mechanisms/`) deliberately soften their layout and use warmer framing to welcome newcomers. The data surfaces they hand off to remain practitioner-grade, so the softer treatment belongs to the _funnel_.

### Brand Personality

**Vigilant, precise, distinctive.** Pharos is a lighthouse. It watches every peg so you do not have to. The product is practitioner-built, not corporate, and should feel unmistakable rather than merely competent. It earns trust through completeness and specificity, but it should also carry a unique vibe that separates it from generic analytics dashboards.

### Emotional Design

**Calm by default, urgent when needed.** The steady state is composed and analytical, so the user feels informed and in control. When risk signals fire (depeg events, DEWS alerts, PSI band shifts), the interface shifts presentation to communicate urgency without panic.

### Surface Tiers

Pharos calibrates density and posture to surface intent across three explicit tiers. Use this table to place new work; do not blend tiers within a single surface.

| Tier           | Routes / Surfaces                                                                                                                                                     | Density | Posture                                               | Layout signal                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Discovery**  | `/start/`, `/about/`, `/api/` public landing, `/learn/mechanisms/`, marketing-adjacent shells                                                                         | Lowest  | Softer framing permitted; inviting presentation       | Larger rounded shells, generous whitespace, fewer controls, step explainers, route boards |
| **Analytics**  | Homepage dashboard, `/depeg/`, `/chains/`, `/liquidity/`, `/freezewatch/`, `/yield/`, `/coverage/`, `/alt-pegs/`, `/safety-scores/`, `/upcoming/`, `/digest/` archive | Default | Composed, analytical, information-rich                | `pharos-card-shell`, KPI grids, charts, sortable tables, control pills                    |
| **Power-user** | `/stablecoin/[id]/`, `/compare/`, `/screener/`, `/timeline/`, `/portfolio/`, ops admin                                                                                | Highest | Maximum information per pixel; assumes domain fluency | Dense tables, minimal chrome, hairline dividers, mono-heavy, multi-pane composition       |

The gradient runs Discovery → Analytics → Power-user. Drift between adjacent tiers is acceptable when justified by the surface's actual user intent; jumps across tiers (warm presentation on `/timeline/`, marketing-style soft chrome on `/screener/`, or dense multi-pane composition inside `/start/`) are not.

### Aesthetic Direction

- **Theme**: Light theme by default, with the same dense financial-dashboard hierarchy preserved in dark mode
- **References**: DeFi-native research products with strong data density and practical crypto analytics, but Pharos should not collapse into looking like another interchangeable dashboard
- **Brand accent**: Frost-blue `#4BC4DE`, sampled from the Figma Market Pulse frame — used sparingly for navigation active states, homepage metrics, and brand touches
- **Fonts**: the system UI stack for core UI, JetBrains Mono for data figures, and the tracked Bricolage Grotesque face for display. The retained `--font-geist-*` variable names are legacy tokens, not loaded Geist webfonts. Intentional non-core carve-outs include Newsreader serif for editorial surfaces and the Cemetery (its `h1`, epitaphs and record cards), Georgia serif for `AiSummary` and route error treatments, Courier New for Digest/depeg editorial body copy, and the Tape `/timeline/` mono-token wire-service stream.
- **Color use**: Semantic first — color communicates state (health, risk, trend direction), not empty decoration
- **Design bar**: Avoid generic SaaS sameness; every major surface should feel authored and recognizably Pharos

### Anti-References (what Pharos must NOT look like)

- **Web3 marketing pages**: Purple gradients, glassmorphism, buzzword-heavy, style over substance
- **Corporate fintech**: Sterile, over-polished, feels like a bank app — no personality
- **Generic SaaS dashboards**: Cookie-cutter admin panels with big empty cards, interchangeable KPI tiles, and safe pastel gradients
- **Derivative crypto analytics clones**: Anything that feels like a reskinned DefiLlama or generic trading terminal without its own point of view
- **Consumer-app over-softening**: Discovery surfaces soften their _layout and framing_, not their _data_. Charts, tables, and numbers stay analytical on every tier. No chunky illustrations or onboarding mascots belong inside data surfaces.

### Design Principles

1. **Data density over decoration** — every pixel earns its place by communicating information
2. **Calibrate density to surface intent**: Discovery surfaces breathe and lead with warmer framing; Analytics surfaces hold the default; Power-user surfaces compress. Do not apply a single density everywhere.
3. **Calm authority, not loud urgency** — steady state is composed; risk signals shift the tone
4. **Precision as personality** — monospace numbers, exact percentages, named bands — trust through specificity
5. **Semantic color only** — color communicates state (health, risk, trend), never decoration
6. **Soften the funnel, not the product**: Onboarding and discovery can welcome with warmer framing and roomier layouts; data surfaces remain crypto-native and practitioner-grade.
7. **Distinctive, not generic** — Pharos should feel authored and memorable, never like a template or a clone. When a page introduces a metaphor, _draw it_ (the Cemetery plot map, Alt-Peg Atlas, Chains Harbor) — but every shape must encode a data field: on the plot map, section is cause of death, plinth steps are peak market cap, weathering is age and a bronze plaque is an archived data page
8. **Consistency is polish** — premium feel comes from repeated precision in spacing, shell treatment, controls, and empty/error states, not from adding decorative novelty

### Stablecoin Detail Module Contract

Every scored/evidence module on `/stablecoin/[id]/` compiles to one shape, in one of three tiers:

- **Module tiers**:
  - **Evidence module / tile / strip** (`EvidenceModule`, `src/components/stablecoin-detail/evidence-module.tsx`): the main-column shell, a `<section id aria-labelledby>` at the main density tier (`DETAIL_MODULE_*`). `module` spans the column (a pillar's signature: Mint Authority, Redemption, multi-branch Collateral pricing); `tile` is one track of a pillar board's container-query tile grid (~480 px: two tracks in the 992 px column, three in the 1,472 px column); `strip` spans the grid row, used for a tile alone in its last row and for a module whose visual degraded. Every variant shares one header grammar: logo · ticker · title with the help glyph directly after the title, then the status chips, which wrap under the title rather than truncate (see Header). The body runs visual → verdict → chips → facts, then the `folds` slot and the `footer` slot, which always span the module. A strip's summary layer splits once its container reaches 48rem (`@3xl/evidence`, about 768 px): the visual on the left; verdict, chips and facts on the right; the folds and footer under both. A full-width module opts into the same split at 64rem (`bodyLayout="split"`, `@5xl/evidence`). A body without a visual, or with nothing beside it, stacks. Every main-column module carries a visual summary that encodes a published field. Content that cannot fill that slot is not a main module: it becomes a rail metric card, a compact strip or a chip.
  - **Rail metric card** (`RailMetricCard` on the `RailCard` shell, `src/components/stablecoin-detail/rail-card.tsx`): the 22rem rail density tier. Title and status chip, one 2rem mono headline with its basis always named ("vs supply", "hedge coverage"), an optional gauge, at most two sub-metric rows, one `Details & sources (N)` fold and a freshness stamp. A rail card whose content must stay reachable below `xl` mounts twice. The in-flow copy owns the anchor id at main density: an `EvidenceModule` tile for the Backing KPI and Regulatory standing (`density="main"`), a strip for Access posture. The rail copy marks itself `data-anchor-twin`.
  - **Explicit absence**: a module the archetype could carry but the coin lacks renders `EvidenceStateStrip` in its usual slot, at main or rail density: "<Title> · Not reviewed", or "<Title> · Not applicable · <reason>". It is dashed and neutral, because a missing review is unknown, not a failure. Absence is never silent.
- **Header**: `DETAIL_MODULE_*` constants + `StablecoinModuleTitle`; the title lockup is coin icon → ticker → module title so standalone screenshots retain their subject, and the module's methodology help glyph (`MethodologyHint`, or a primer popover on Mechanism) sits outside the heading, directly after the title, so the mobile accordion button never nests a control. Headings nest as group kicker `h2` → module `h3` → inner `h4`. The right slot carries status only: one score pill **or** one status chip, then an optional ops chip; a Control component adds its `ControlRoleTag`. Pass them as one fragment: the first chip is the primary. Header chips never shrink or ellipsize. At `md` and up they sit beside the title and wrap under it when both do not fit; below `md` they take their own row under the title, and a folded tile shows the primary chip only. The help glyph keeps its 24 px disc at every width, with an invisible 44 px tap target below `md`. Freshness and review dates belong in the footer. Recommendation and cross-coin modules that are not about the current asset keep an ordinary `DetailSectionTitle`.
- **Summary layer** (never folds at `md` and up): at most one primary visual, one verdict line, at most three chips (confidence · inheritance · scope; confidence appears only here), at most four bounded-vocabulary facts (`FactGrid`, the hero passport grammar; four across once the grid has 35rem), and **current-state** callouts only.
- **Summary budget** (`shared/lib/summary-budget.ts`): a verdict is at most 25 words and other always-visible prose at most 40. No raw identifiers appear outside a disclosure: contract addresses, block heights, "N seconds" arithmetic, gate codes (`D29`), evaluator keys (`chain:solana`, `bridge-meta:…`) or version pins. Generated verdicts come from structured fields (`buildMintAuthorityVerdict`); verdicts carved from authored prose go through `deriveVerdictLine`, which returns `null` rather than an over-budget line so callers fall back to structured fields; authored reviewer narrative folds into the module's `Review notes & sources (N)` fold. Authored overrides such as `mintAuthority.headline` are validated by the stablecoin schema (`npm run check:stablecoin-data`), and a whole-catalogue test keeps every generated mint verdict inside the budget.
- **Ops and pipeline state** (stale feeds, sync errors, partial evidence) renders as an amber header status chip whose tooltip or disclosure names the freshness budget and a machine-readable reason (ADR-30/ADR-31). It never renders as a body callout and never prints raw error strings.
- **Fold rule**: the summary layer never folds at `md` (768 px) and up; only the detail layer does. Breakdowns, tables, long prose, notes, sources and historical incidents fold behind named `ModuleDisclosure`s, collapsed by default at every breakpoint, desktop included. Whole-module folding is a phone-only affordance: below `md`, a tile or strip becomes an APG accordion (`<h3><button aria-expanded aria-controls>`) whose body is hidden by CSS only below `md`, so there is no hydration mismatch or desktop layout shift, and a hash target inside it unfolds it (`expandEvidenceModuleFor`). Pillar-primary modules (Safety Score, Reserves, Mechanism, Redemption, Mint Authority, multi-branch Collateral pricing, DEWS) never fold at any width. `ModuleDisclosure` is the only toggle grammar: no bare native `<details>` triangles, `matchMedia`-driven auto-open, "Read more" links, or link-styled "Show inputs". There is no sanctioned auto-open; the Safety Score pillars fold too.
- **Disclosure order and footer**: named folds run in a fixed order, Scoring breakdown → domain detail → `Review notes & sources (N)`, then one footer line. `EvidenceModule` renders them in one place, full width, after the summary layer: the domain folds come through its `folds` slot and the provenance (`EvidenceFooter`) through its `footer` slot. `children` holds summary content only (facts and current-state callouts), which a split body sets beside the visual. A `ModuleDisclosure` or `EvidenceFooter` passed directly as a child still joins the fold run; a fold rendered by any other component does not, so it must go through `folds`. Consecutive folds form one zero-gap run (`MODULE_FOLD_RHYTHM_CLASS`). The provenance fold merges reviewer notes with the source list. With notes it is always labelled `Review notes & sources`, even when the review cites no sources; with sources alone it reads `Sources (N)`. It counts both in its accessible name and stays in the DOM for crawlers. The line carries live freshness and module-specific items on the left and the right-aligned `Reviewed <YYYY-MM-DD>` stamp; footer dates are ISO whatever the source field carries. On evidence modules the methodology entry point is the (?) glyph beside the title, never a footer link, and score inputs live in the module's Scoring breakdown fold. Where a footer still carries `View methodology` (Price Transparency), the methodology version appears only in that link's tooltip. A module has one provenance fold and one date stamp.
- **Mono rule**: mono uppercase is for figures and one-word enums only: a number, a single-word enum, a short figure whose other words are units (`$662k of $25m`, `1.0 d`), or a sub-label of at most three words beside a number. Names, prose, verdicts and multi-word values render sentence case in the sans face; mono capitals on "Asset-referenced token" or "Pathway unresolved" are the anti-pattern. `resolveFactValueStyle` (`fact-grid.tsx`) applies the rule to `FactGrid` values and `RailMetricCard` headlines.
- **Unknown is never drawn as zero**: unavailable renders dashed, hatched or "–"; not-applicable renders as neutral text with its rationale. "0 %", ✕, an empty bar or green never stand in for missing data. When a visual would hold one data point or only unknown inputs, the module degrades to its strip or rail form, never to an empty shell.
- **Semantic color**: red/amber callouts are reserved for *active* state; resolved incidents render as calm folded history.
- **Drawn rails**: Mint Authority and Redemption draw their mechanism as compact rails (`MintAuthorityRail`, `RedemptionRouteRail`) — issuer → controls → supply and holder → access gate → venue → output — where every glyph encodes a published field (signer dots = threshold, clock = timelock, gate geometry = access model, arrow label = settlement). Price feed (sources → aggregator → consumer) and Freeze & seizure (power → scope → used) reuse the same station parts (`rail-station.tsx`); a rail never draws a station its data does not carry, so Freeze has no actor station. A rail that lives in tiles as well as full-width modules reads its own width rather than the viewport: the Price feed path stacks top to bottom with `RailArrow orientation="container"` until its `@container/rail` reaches 36rem, then runs left to right, and its stations take `wrap` so long names break instead of truncating. Scores sit on a `ScoreBandSpectrum`: **ordinal** band ladder for posture-derived bands (V9 mint — score cutoffs were retired in 9.1, so no marker — and the published `oracleTierQuality` order), **range** track with a score marker only where tones genuinely derive from score cutoffs (redemption 80/65/50/35). Both read "right = safer". Spectrum labels are 11 px sentence case, sized to the spectrum's own container: the full label from 36rem, the band's one-word `shortLabel` below it, wrapping at spaces and never ellipsized. Never invent band names or score ranges for a spectrum.
- **Score tones**: each module keeps its own scale. Mint pills take their tone from the posture band (numeric mint cutoffs were retired in 9.1) and show the band beside the score ("81 · Managed"); Redemption tones derive from its 80/65/50/35 cutoffs; Safety Score pillars use letter grades. Pill tooltips name which scale applies. Never recolour one scale to match another.
- **Control limiting semantics**: Economic Control is a minimum-binding-component score. `binding: true` marks membership in the eligible set, and the evaluated score is the minimum over eligible scored components, before adjustments. `resolveControlComponentRoles` (`src/lib/pillar-evidence-strips.ts`) is computed once per render and shared by Mint Authority, Price feed, Bridging and the rail Evidence index: an eligible component at that minimum is **limiting** (ties included; outlined); an eligible component above it is drawn solid with no tag; a `binding: false` component is a **diagnostic** (muted and dashed, never outlined, even at the minimum score); a `score: null` component is excluded and reads "–". An empty eligible set outlines nothing. `ControlRoleTag` (`control-role-tag.tsx`) is the single limiting/diagnostic grammar: a glyph and one word ("Limiting", "Diagnostic"), with the full published label ("Limiting input · before adjustments", "Diagnostic · not in the eligible set") in its accessible text and tooltip. Module headers use the default size; the rail Evidence index and the deployment-strip legend use `size="compact"`. No surface draws its own marker. Role labels live in `CONTROL_COMPONENT_ROLE_LABELS` (`shared/lib/classification.ts`).
- **Page spine**: the Risk section reads Mechanism → Safety Score ‖ Reserves (one `items-start` row, so opening a Reserves fold never stretches the score card) → DEWS (the live stress layer; NAV tokens and frozen archives get a "Not applicable" strip) → the pillar boards `#backing-evidence`, `#exit-evidence` and `#control-evidence` → Mint & Burn Flows. Each board opens with a plain kicker `h2` (with a trailing hairline; the pillar's grade and decomposition live on the Safety Score card), then its full-width signature modules, then its tile grid, then full-width lines (strip-form modules and explicit-absence states). The tile grid never leaves an empty track in its last row, at one, two or three tracks (`resolveBoardGridPlacement`). A board renders only when at least one child is visible at the current breakpoint. Each evidence module mounts once, in flow, under the pillar that scores it: oracle and bridge evidence sit in Control; reserves and mechanism in Backing; access enums in Exit. The `xl` rail is a compact companion in normal flow, never sticky and never a second copy of the main column: Safety summary → Backing KPI → Access posture → Evidence index (one row per evidence module in pillar order, flagging the limiting Control input) → Regulatory standing → Price Transparency → Key Links → Contracts → News. Below `xl` there is no rail: the Backing KPI and Regulatory standing twins join their board's tile grid as grid items, Access posture renders in strip form, the Evidence index is absent, and the reference cards render after the pillar evidence, never before the Safety Score. Frozen coins keep a reduced dossier: they skip the Custody, Redemption, Bridging and Regulatory absence states, while "Mint Authority · Not reviewed" still holds its slot and DEWS states that it does not apply.
- **Primitives**: `EvidenceModule` and `EvidenceStateStrip` (`evidence-module.tsx`), `RailCard` and `RailMetricCard` (`rail-card.tsx`), `FactGrid` (`fact-grid.tsx`), `EvidenceFooter` (`evidence-footer.tsx`), `ControlRoleTag` (`control-role-tag.tsx`), the station parts `StationLabel` / `RailArrow` / `RailStation` (`rail-station.tsx`), `ScoreBandSpectrum` (`score-band-spectrum.tsx`), `ThresholdGauge` and `ShareMeter` (`threshold-gauge.tsx`), and `DeploymentStrip` (`deployment-strip.tsx`), all under `src/components/stablecoin-detail/`. [data-visualization.md](./data-visualization.md#stablecoin-detail-primitives) owns their encodings and degenerate states.

## Product Character

Pharos is a dense monitoring product: calm by default, explicit when risk rises, and precise enough for repeated professional use. Discovery pages may use more space and warmer framing, but analytics and power-user routes keep information density high.

The lighthouse metaphor is useful only when it communicates data. Decorative novelty, generic SaaS card grids, glass effects, and color without semantic meaning do not belong in the product.

## Typography

- Core UI and analytics prose use the sans token.
- Numeric values, tickers, timestamps, and compact data labels use `.pharos-numeric` or the mono token.
- Page titles use `.pharos-page-title`; compact panel headings use `.pharos-section-title` rather than hero-scale type.
- `.pharos-kicker` introduces a short category or section label. It is supporting hierarchy, not body copy.
- Serif and unusually mono-heavy treatments are route-owned exceptions for editorial surfaces, Cemetery, error treatments, AI narrative, and `/timeline/`. Do not spread them into general analytics UI.
- The Cemetery's Newsreader scope is the route `h1`, epitaphs and the plot-map record card (name, editorial title, epitaph); the register's autopsy epitaph shares it. The drawn plan itself stays sans: signposts and colossus chips use sans small caps, and figures and footstone glyphs use mono.
- Letter spacing remains neutral for ordinary text. Do not scale font size continuously with viewport width.

## Color And State

- Use semantic tokens and shared classification/status helpers. Classification labels and colors belong in `shared/lib/classification.ts`.
- Freeze-event badges, overview seismograph, and per-asset charts share the event descriptor in `shared/lib/classification/badges.ts`, exposed through the classification facade: Freeze/red, Release/emerald, Wipe/amber. Legends and tooltips use `EVENT_LABELS`; chart fills use `EVENT_CHART_COLORS` in both themes. API event keys and chart stacking order are not display labels.
- Frost blue is the brand accent and a selective point of emphasis, not the default color for every metric.
- Frost never paints a gradient or a background, with one exception: the Cemetery plot map's drawn beam is a frost gradient from the lantern. On that page frost appears only on the One Beam figure and that beam, which rests on the figure and moves only on interaction.
- Health, warning, error, freshness, and score colors must represent state consistently in both themes.
- Never rely on color alone. Pair it with text, position, shape, iconography, or another redundant channel.
- JavaScript chart colors normally come from the shared runtime maps described in [design-tokens.md](./design-tokens.md), not local hex constants. Intentional local canonical palettes are the market-cap delta colors in `src/components/mcap-chart.tsx`, `PEG_BAND_HEX` in `src/components/peg-deviation-chart.tsx`, and `ANNOTATION_HEX_COLORS` in `src/components/chart-primitives/annotations.tsx`.

## Page Shells

- Standard route hierarchy and metadata should flow through the established page-shell helpers where they fit.
- Visible slash-separated breadcrumb trails are not part of current page headers. Emit breadcrumb JSON-LD when a route needs crawlable hierarchy.
- Data-dense routes use the available page width with a sensible ultrawide ceiling. Longform prose supplies its own readable measure.
- The homepage, stablecoin detail, Digest, Cemetery, Tape, and other special surfaces own their composition in their route contracts; do not generalize their local layout into a global rule.
- A page hero supplements the route heading. It must not duplicate or replace the semantic `h1` unless the owning shell explicitly does so.

### Feature-page heroes

Feature and reference routes use one signature full-width hero with one frost-blue **One Beam** metric; supporting figures stay neutral unless they encode semantic state. The route owner defines the drawn metaphor and any explicit exception. Learn routes use the light-editorial treatment; Coverage and Funding use the reference treatment. Their route docs own only those route-specific calls.

The Cemetery is the drawn-hero exception. Its hero is the full-width plot map under one sky that runs full-bleed through the page padding; the route head, including the Newsreader `h1`, sits over the plan's empty sky rather than in a separate band, and the One Beam metric is the count of recorded deaths, which the drawn beam rests on. [Cemetery and Compare](./cemetery-and-compare.md#ui-behavior) owns the details.

## Shared Utility Classes

Prefer the established utilities in `src/app/globals.css`:

| Utility | Contract |
| --- | --- |
| `.pharos-card-shell` | Default framed analytics surface using shared background, border, and elevation tokens. |
| `.pharos-interactive-card` | Clickable card hover and press motion; pair it with `.pharos-focus-ring` for the focus treatment. |
| `.pharos-control-pill` | Dense option or mode control; pair the selected state with `.pharos-control-pill-active`. |
| `.pharos-focus-ring` | Shared keyboard focus treatment for custom interactive elements. |
| `.pharos-table-shell` / `.pharos-table-toolbar` | Shared framing and controls for tabular workspaces. |
| `.pharos-chart-stage` | Inner chart surface distinct from its surrounding section. |
| `.pharos-subtle-band` | Low-emphasis grouped information without introducing another card. |
| `.pharos-empty-note` | Bounded empty-state treatment inside a data surface. |
| `.pharos-meta` | Compact secondary metadata. |
| `.pharos-prose-link` | Inline link treatment in explanatory copy. |
| `.pharos-source-list` | External source list rendered by `SourceLinkList`: CSS-masked external-link glyph, focus ring and underline on bare `<li><a>` rows. |

Check the current declarations before depending on exact padding, radius, shadow, or responsive behavior. Those implementation details belong to `src/app/globals.css` and the token files.

## Cards And Sections

- `src/components/ui/card.tsx` is a structural primitive. It currently has no resting `shadow-sm`; do not document or depend on one.
- Use cards for genuinely framed tools, repeated items, and modals. Do not place cards inside cards or turn every page section into a floating card.
- Shared resting and hover elevation comes from component tokens such as `--card-shadow` and `--card-shadow-hover` through the application utilities.
- Keep headings, actions, and content within stable responsive constraints so dynamic labels do not resize the surrounding layout.
- Use hairline dividers and unframed bands when a card would add hierarchy without adding meaning.

## Controls And Navigation

- Use icons for familiar actions, with tooltips for unfamiliar icon-only controls.
- Use pills or segmented controls for compact mutually exclusive modes, checkboxes/toggles for binary settings, and menus for larger option sets.
- Interactive controls need a visible focus state, an accessible name, and a stable hit area. Touch targets should remain usable even when desktop controls are visually compact.
- URL-backed filters must preserve unrelated query parameters and normalize deprecated aliases at the route boundary.
- Sticky UI must account for global navigation and must not obscure anchored content.

### Control Pills

`.pharos-control-pill` is the canonical compact option shell. Use `.pharos-control-pill-active` for its selected state, keep labels short enough to wrap safely, and expose group/pressed semantics appropriate to the interaction. The current visual values live in `src/app/globals.css`.

Use `ControlPillToggle` in `src/components/control-pill-toggle.tsx` for plain controlled, pressed-option groups. Callers retain labels, layout, responsive density, and state ownership. Keep radio controls, directional sort buttons, and bespoke icon/count/action or focus treatments local rather than adding modes to the primitive.

### Tape (Special)

`/timeline/` deliberately uses a wire-service treatment rather than the standard analytics card language. [tape-page.md](./tape-page.md) owns that route's aesthetic lock and exact implementation.

## Tables And Charts

- Tables are the authoritative comparison surface when users must scan, sort, or export exact values.
- Product tables compose the shared primitives in `src/components/table/`, plus `src/components/data-table-shell.tsx` for sortable workspaces. Nothing else under `src/` may emit raw `<table>` markup or import a shadcn table module directly; the only exceptions are those primitives themselves, the screen-reader data table in `src/components/chart-primitives/data-table.tsx`, and test fixtures. `npm run check:table-primitives` is a blocking PR gate for this, so reach for a primitive before hand-rolling a grid.
- Sortable headers expose `aria-sort`; clickable rows must retain an explicit keyboard path and must not swallow nested links or buttons.
- Preserve horizontal access on narrow screens rather than hiding important columns without an equivalent surface. The shared table viewport already renders a swipe hint under a horizontally scrollable table; disable it with `mobileScrollHint={false}` when the surface cannot overflow, and do not add your own swipe copy beside a table that still shows the default hint.
- Charts need explicit loading, empty, stale, and error states. Freshness and methodology context belong near the data when misreading is plausible.
- Follow [data-visualization.md](./data-visualization.md) for SVG roles, equivalent accessible data, reduced motion, view-model separation, and test invariants.

## Responsive Behavior

- Use stable grids, aspect ratios, min/max constraints, and overflow rules for fixed-format tools.
- Reflow before shrinking text. Long labels and localized text must wrap without covering adjacent controls.
- Mobile may change interaction order or density, but it must preserve the workflow and the underlying facts.
- CSS can own purely visual breakpoint changes. Use runtime viewport logic only when behavior or data fetching genuinely differs.
- Verify dense and fixed-format surfaces at common mobile widths and at 200 percent zoom.

## Accessibility And Motion

- Use semantic HTML before adding ARIA.
- Every interactive element is keyboard reachable and visibly focused.
- Loading and mutation states use the appropriate `aria-busy`, status, or alert semantics without noisy duplicate announcements.
- Respect `prefers-reduced-motion`; no information may depend on animation playing.
- Decorative graphics are hidden from assistive technology. Data graphics expose a concise name and an equivalent accessible data surface as described in [data-visualization.md](./data-visualization.md).
- Text and controls must meet the contrast baseline in both themes.

## Maintenance

When a reusable rule changes, update the owning layer rather than copying the new implementation into several docs:

1. Brand, audience, or density model: [Context](#context).
2. Token value or token architecture: [design-tokens.md](./design-tokens.md) and `src/styles/tokens/`.
3. Shared utility behavior: `src/app/globals.css` and this primitive index when its contract changes.
4. Route-specific composition: the route doc.
5. Visualization behavior: [data-visualization.md](./data-visualization.md).

Use source as truth. Avoid dated redesign history, copied route rosters, and exact class snapshots in this file.
