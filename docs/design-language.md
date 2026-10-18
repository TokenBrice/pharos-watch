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

Discovery and onboarding surfaces (first-run callouts, `/about/`, `/api/` public landing, `/learn/mechanisms/`) deliberately soften their layout and use warmer framing to welcome newcomers. The data surfaces they hand off to remain practitioner-grade, so the softer treatment belongs to the _funnel_.

### Brand Personality

**Vigilant, precise, distinctive.** Pharos is a lighthouse. It watches every peg so you do not have to. The product is practitioner-built, not corporate, and should feel unmistakable rather than merely competent. It earns trust through completeness and specificity, but it should also carry a unique vibe that separates it from generic analytics dashboards.

### Emotional Design

**Calm by default, urgent when needed.** The steady state is composed and analytical, so the user feels informed and in control. When risk signals fire (depeg events, DEWS alerts, PSI band shifts), the interface shifts presentation to communicate urgency without panic.

### Surface Tiers

Pharos calibrates density and posture to surface intent across three explicit tiers. Use this table to place new work; do not blend tiers within a single surface.

| Tier           | Routes / Surfaces                                                                                                                                                     | Density | Posture                                               | Layout signal                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Discovery**  | `/about/`, `/api/` public landing, `/learn/mechanisms/`, marketing-adjacent shells                                                                         | Lowest  | Softer framing permitted; inviting presentation       | Larger rounded shells, generous whitespace, fewer controls, step explainers, route boards |
| **Analytics**  | Homepage dashboard, `/depeg/`, `/chains/`, `/liquidity/`, `/freezewatch/`, `/yield/`, `/coverage/`, `/alt-pegs/`, `/safety-scores/`, `/upcoming/`, `/digest/` archive | Default | Composed, analytical, information-rich                | `pharos-card-shell`, KPI grids, charts, sortable tables, control pills                    |
| **Power-user** | `/stablecoin/[id]/`, `/compare/`, `/screener/`, `/timeline/`, `/portfolio/`, ops admin                                                                                | Highest | Maximum information per pixel; assumes domain fluency | Dense tables, minimal chrome, hairline dividers, mono-heavy, multi-pane composition       |

The gradient runs Discovery → Analytics → Power-user. Drift between adjacent tiers is acceptable when justified by the surface's actual user intent; jumps across tiers (warm presentation on `/timeline/`, marketing-style soft chrome on `/screener/`, or dense multi-pane composition inside `/about/`) are not.

### Aesthetic Direction

- **Theme**: Light theme by default, with the same dense financial-dashboard hierarchy preserved in dark mode
- **References**: DeFi-native research products with strong data density and practical crypto analytics, but Pharos should not collapse into looking like another interchangeable dashboard
- **Brand accent**: Frost-blue `#4BC4DE`, sampled from the Figma Market Pulse frame — used sparingly for brand and interactive emphasis and the drawn beam; hero and headline figures render in neutral ink, and color on a figure comes only from a semantic scale
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

Shared evidence-shell grammar lives here; [Stablecoin Detail: Section Order](./stablecoin-detail-page.md#section-order) owns route ordering, pillar placement, rail twins, phone accordions and Control roles. [Data Visualization: Stablecoin Detail Primitives](./data-visualization.md#stablecoin-detail-primitives) owns visual encodings, scale geometry and degenerate states.

- **Shells:** `EvidenceModule` (`src/components/stablecoin-detail/evidence-module.tsx`) is a labelled `<section>` using `DETAIL_MODULE_*` density constants. `module` spans the main column, `tile` occupies a board grid track, and `strip` spans a row or replaces a degraded visual. Main modules require one visual summary of a published field; otherwise use a strip, rail card or chip. Body order is visual → verdict → chips → facts → full-width folds → footer. A strip splits visual from text at its 48rem container threshold; full modules opt into the 64rem split with `bodyLayout="split"`. Without a visual or companion content, stack. `visualFold` moves the visual to the first, initially open `#<id>-visual` fold.
- **Rail density:** `RailMetricCard` on `RailCard` (`rail-card.tsx`) has a title/status, one 2rem mono headline with its basis named, optional gauge, at most two sub-metric rows, one `Details & sources (N)` fold and a freshness stamp. It is the compact 22rem-rail grammar, not a second main-column module. Route-specific anchor/twin ownership belongs to the route contract.
- **Explicit absence:** `EvidenceStateStrip` retains an archetype-supported module's usual slot with `Not reviewed` or `Not applicable · <reason>`. Dashed neutral absence is unknown, not failure. Unavailable is dashed, hatched or “–”, never “0 %”, a cross, empty bar or green. A one-point/all-unknown visual degrades to strip/rail rather than an empty shell. A pre-launch dossier names its live surfaces once with the `pending-launch` state (`Activates at launch`), never as empty cards.
- **Headers:** `StablecoinModuleTitle` reads coin icon → ticker → module title; help follows the title outside its heading/accordion button. Nest board `h2` → module `h3` → inner `h4`. The right slot is one score pill **or** status chip, optional ops chip, and where applicable `ControlRoleTag`, passed as one fragment with the primary chip first. Chips wrap, never shrink or ellipsize: beside the title from `md`, their own row below `md`, primary only on a folded phone tile. Help keeps a 24px disc and an invisible 44px phone target. Freshness/review dates go in the footer. Cross-coin/recommendation modules keep ordinary `DetailSectionTitle`.
- **Summary:** at most one primary visual, one verdict, three chips (confidence · inheritance · scope; confidence only here) and four bounded-vocabulary `FactGrid` facts, four across at a 35rem container. Only current-state callouts stay visible. Summaries never fold from `md`; whole-module phone behavior and never-fold primary modules are route-owned.
- **Word/identifier budget:** `shared/lib/summary-budget.ts` owns the 25-word verdict / 40-word other always-visible prose limits. Raw addresses, block heights, seconds arithmetic, gate codes, evaluator keys and version pins stay in disclosures; the failure-scenario footer's `state at block` provenance stamp is the sole block-height exception. Generate verdicts from structured fields (`buildMintAuthorityVerdict`); use `deriveVerdictLine` for authored prose, whose over-budget `null` requires a structured fallback. Reviewer narrative goes in the provenance fold. Schema validation checks authored overrides; the catalog test checks generated mint verdicts.
- **Ops state:** stale feeds, sync errors and partial evidence use an amber header status chip whose tooltip/disclosure names the freshness budget and machine-readable reason (ADR-30/ADR-31). Never body callouts or raw error strings. Red/amber body callouts are for active state; resolved incidents are calm folded history.
- **Folds:** `ModuleDisclosure` is the sole detail-toggle grammar, collapsed by default at every breakpoint, including desktop. No bare native-details triangles, `matchMedia` auto-open, “Read more” links or link-styled “Show inputs”; Safety Score pillars fold too. The explicit `visualFold` is the visual-slot exception, not permission to auto-open detail. Order Scoring breakdown → domain detail → provenance, then one footer. Pass domain disclosures through `folds`, `EvidenceFooter` through `footer`, summary through `children`. Direct `ModuleDisclosure`/`EvidenceFooter` children are collected into the fold run; disclosures wrapped in another component must use `folds`. `MODULE_FOLD_RHYTHM_CLASS` makes consecutive folds one zero-gap run.
- **Provenance:** one fold merges reviewer notes and sources and stays in the DOM for crawlers. With notes, label `Review notes & sources (N)` even with no citations; sources alone use `Sources (N)`. Count both in its accessible name. The footer has live freshness/module-specific facts left and one right-aligned `Reviewed YYYY-MM-DD`, normalizing source dates to ISO. Methodology belongs at the title's help glyph, not another footer link, and score inputs in Scoring breakdown. Price Transparency's retained `View methodology` footer link puts its methodology version only in the tooltip.
- **Figure register:** `resolveFactValueStyle` (`fact-grid.tsx`) controls `FactGrid` values and rail headlines. Mono uppercase is for numbers, one-word enums, short figures plus units, or sub-labels of at most three words beside a number. Names, verdicts, prose and multi-word values are sentence-case sans, not capitals such as “PATHWAY UNRESOLVED”.


## Product Character

Pharos is a dense monitoring product: calm by default, explicit when risk rises, and precise enough for repeated professional use. Discovery pages may use more space and warmer framing, but analytics and power-user routes keep information density high.

The lighthouse metaphor is useful only when it communicates data. Decorative novelty, generic SaaS card grids, glass effects, and color without semantic meaning do not belong in the product.

## Typography

- Core UI and analytics prose use the sans token.
- Numeric values, tickers, timestamps, and compact data labels use `.pharos-numeric` or the mono token.
- Page titles use `.pharos-page-title`, with the 16px `.pharos-page-deck` description under them on every `FeaturePageShell` route (Learn and methodology keep the larger `.pharos-page-lead`). The five rail pages (Safety, Yield, Depeg, Stability, FreezeWatch) and the five Markets pages (Liquidity, Flows, Chains, Non-USD Pegs, Upcoming) use `header: "instrument"`: a one-line deck (about 105 characters, the rest folded), the same action set (`AlertsHeaderLink` where a Telegram alert family exists, then `ShareButton`), and one hero figure face (`HERO_KPI_VALUE_CLASS`); compact panel headings use `.pharos-section-title` rather than hero-scale type.
- Core analytics surfaces use three registers only: Bricolage display for page and section titles, the system sans for UI text and labels, and JetBrains Mono for figures, tickers, addresses and codes.
- Labels are sentence-case sans: `.pharos-label` (legacy name `.pharos-kicker`) introduces a short category, section or field label. It is supporting hierarchy, not body copy. `.pharos-eyebrow` is the single uppercase variant, for at most one short route or hero eyebrow above a title. Do not hand-roll `uppercase tracking-[…] font-mono` labels; the [type scale](./design-tokens.md#type-scale) owns sizes and the one tracking step. Card, section, metric and table-column titles are sentence case too ("Unfreezable market share"); page H1s, product and proper names (Market Pulse, Safety Scores, FreezeWatch, Daily Digest, Stability Index), acronyms and tickers keep their casing.
- The editorial serif resolves through `font-serif`: Newsreader inside a subtree that mounts `digestDisplay.variable`, Georgia elsewhere (not-found and error boundaries stay on Georgia so the Newsreader files never load app-wide).
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
- JavaScript chart colors come from the runtime maps in [design-tokens.md](./design-tokens.md), including `PEG_BAND_HEX` in `shared/lib/classification.ts`. The market-cap delta colors in `src/components/mcap-chart.tsx` are an intentional local palette.

## Page Shells

- Standard route hierarchy and metadata should flow through the established page-shell helpers where they fit.
- Visible slash-separated breadcrumb trails are not part of current page headers. Emit breadcrumb JSON-LD when a route needs crawlable hierarchy.
- Data-dense routes use the available page width with a sensible ultrawide ceiling. Longform prose supplies its own readable measure.
- The homepage, stablecoin detail, Digest, Cemetery, Tape, and other special surfaces own their composition in their route contracts; do not generalize their local layout into a global rule.
- A page hero supplements the route heading. It must not duplicate or replace the semantic `h1` unless the owning shell explicitly does so.

### Feature-page heroes

Feature and reference routes use one signature full-width hero with one **One Beam** answer metric in neutral ink; it and the supporting figures take color only when they encode semantic state. `FeatureHeroSplit` is the shared shell: a `split` layout (beam left, visual right) or a `stacked` layout (beam row, then a full-width visual) for scenes wider than the split column. Partial, stale or warning state goes in its `status` slot as an `OpsStatusChip` (`src/components/ops-status-chip.tsx`) with a machine-readable reason, never a body callout or a degraded-state headline; when the beam itself is computed on partial inputs, its label says so. Supporting figures use `HeroMetricRow`, and each figure appears once per page. The route owner defines the drawn metaphor and any explicit exception. Learn routes use the light-editorial treatment; Coverage and Funding use the reference treatment. Their route docs own only those route-specific calls.

Homepage exception: the homepage never renders data-health UI (no `StaleDataBanner`, `QueryFreshnessNotices`, `QueryStateNotice`, `OpsStatusChip`, amber/red health tones or retry). Present data renders as-is with at most a neutral "as of" stamp, and absent data is a neutral placeholder. Ops state lives in the admin and operator alerts. See [Homepage: Data Health](./homepage.md#data-health); ESLint enforces it.

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
| `.pharos-label` / `.pharos-eyebrow` / `.pharos-numeric` | Sentence-case label, the single uppercase eyebrow, and mono tabular figures; see [Label and figure utilities](./design-tokens.md#label-and-figure-utilities). |
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
- Product tables compose the shared primitives in `src/components/table/`, plus `src/components/data-table-shell.tsx` for sortable workspaces. Keep raw `<table>` markup under `src/` inside `src/components/table/`, the screen-reader data table in `src/components/chart-primitives/data-table.tsx`, and test fixtures; direct shadcn table imports belong only inside `src/components/table/`. Reach for a primitive before hand-rolling a grid.
- Sortable headers expose `aria-sort`; clickable rows must retain an explicit keyboard path and must not swallow nested links or buttons. Row-cursor shortcuts ignore interactive controls (including pager/sort buttons and editable descendants), leaving native keyboard activation intact.
- Stablecoin table supply values preserve unavailable observations: market cap and dependent changes display `—`, unavailable sort values remain last in either direction, and CSV exports leave those cells empty. Historical supply gaps break the mini-sparkline instead of inventing zero samples; explicit observed zero still displays `$0` and can yield a real `-100%` contraction from a positive prior observation.
- Preserve horizontal access on narrow screens rather than hiding important columns without an equivalent surface. The shared table viewport renders a mobile swipe hint above the viewport; disable it with `mobileScrollHint={false}` when the surface cannot overflow, and do not duplicate the default hint.
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
- Theme swaps run inside `document.startViewTransition` (`useThemeToggle`) so charts and chrome cross-fade together; the toggle falls back to an instant swap without the API or under reduced motion.
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
