# Design Language Reference (Live Baseline)

This document reflects the current UI baseline in the codebase and was re-verified on **March 24, 2026**.

Use this as the visual source of truth for product-facing design decisions. For token definitions (primitive, semantic, component), see [`design-tokens.md`](design-tokens.md). The bridge layer lives in `src/app/globals.css`.

---

## Visual Direction

Pharos ships as a **light-default financial dashboard**:

- Dense data presentation
- Conservative card-and-table surfaces
- Small, meaningful color accents (risk, status, category)
- Heavy use of monospace for numeric trust and scanability

The default theme on load is light, with a user toggle for dark mode.

Light mode keeps the same hierarchy as dark mode, but status/accent text is calibrated one step darker to preserve readability on pale surfaces (typical pattern: `text-*-700 dark:text-*-400`).

### Typography carve-out

Newsreader serif is reserved for authored editorial/tombstone surfaces: the `/digest/**` route, the homepage `DailyDigest` preview card, Cemetery obituary plaques (`cemetery-tombstones.tsx`), and depeg event editorial display text. The detail-page `AiSummary` component uses Georgia serif (`font-serif`) for its AI-authored narrative paragraph. The root error boundary (`page-error-editorial.tsx`) shares the Georgia register for its kicker and title — deliberately not Newsreader, because `error.tsx` sits in every route's preload graph and importing the digest font there preloaded its CSS app-wide. The `/timeline/` route is a further carve-out: the mono token dominates the wire-service event stream (see `### Tape (Special)` below). Every other dashboard panel on Pharos — including the homepage Market Snapshot, Core Monitoring band, Research Surfaces band, and all stablecoin-detail cards — uses the sans token at all weights. Do not introduce new serif usage outside the existing authored editorial, error, `AiSummary`, and Cemetery carve-outs, and do not extend the Tape mono treatment to general analytics surfaces; a Vitest invariant in `src/lib/__tests__/design-invariants.test.ts` currently guards component-level drift under `src/components/**`, while route-level files still require manual review.

### Homepage Hero Tagline

The `HomeAltHero` tagline reads `Backing, freeze risk, liquidity, and peg stress — all in one place.` It sits under the `Market Pulse` page heading and ships as the homepage's single raw `h1` surface across breakpoints.

### Hero signals rail (stablecoin detail)

On `lg+`, the detail hero's right column surfaces a four-pill `HeroSignalsRail` (Safety / Peg / Liquidity / DEWS) that quick-jumps to `#report-card` and `#liquidity`. It replaces the duplicated `SafetyGradeHero` block that used to sit opposite the Safety Score card. Mobile (`<lg`) continues to render `SafetyGradeHero` because the Safety Score card is far down scroll on narrow screens.

### Breadcrumbs

Visible slash-separated breadcrumb trails are retired from page headers. Routes that need crawlable hierarchy should keep emitting `BreadcrumbJsonLd` through `FeaturePageShell`, `LearnPageShell`, or a page-local JSON-LD block, but the hierarchy should not render as `Dashboard / current page` UI above the title.

---

## Global App Shell

### Root + Fonts

- Body carries four font variables/classes: `geistSans`, `geistMono`, `jetbrainsMono`, `bricolageDisplay` (+ `antialiased`); scoped utilities `pharos-font-sans` / `pharos-font-mono`. The display token `--font-pharos-display` is resolved on `body` so it can see the Next-provided `--font-bricolage` fallback variable.
- Sans / UI token: Geist Sans (system-first fallback)
- Mono / data token: **JetBrains Mono** (Figma redesign), folded into `--font-geist-mono` so every `.pharos-numeric` / table figure inherits it
- Display token (`--font-display`, `.pharos-display`, `.pharos-page-title`): **ABC Whyte Inktrap** for headings + the top-nav wordmark when licensed files are installed at `public/fonts/abc-whyte-inktrap/`; **Bricolage Grotesque** remains the tracked fallback for clean builds.
- Default corner radius token: `--radius: .5rem`
- Body background wires two radial-glow layers via `--page-glow-top` and `--page-glow-bottom`; both tokens are currently set to `none` in every theme, so no glow renders (disabled in the June 2026 chrome refresh)

### Layout Structure

Public pages use this shell:

```tsx
{
  /* Desktop primary nav (≥lg) — replaces the retired left "watch column" sidebar */
}
<TopNav />;
{
  /* sticky h-14 full-width bar, lg:flex */
}
<header
  className="lg:hidden sticky top-[3px] z-[56] border-b border-border/80 bg-background"
  style={{ boxShadow: "var(--elevation-rest)" }}
/>;
{
  /* mobile header */
}
<CoreTopRail />;
{
  /* live tape (registry chips + ticker), sticky below the nav */
}
<div className="flex min-h-screen">
  {/* No sidebar / no sidebar spacer — content is full-width */}
  <div className="flex-1 flex flex-col min-w-0">
    <main id="main-content" className="pharos-mobile-utility-safe flex-1 mx-auto w-full max-w-[120rem] px-4 py-6 md:py-7 lg:px-5 xl:px-9">
      {/* route content */}
    </main>

    <footer className="border-t border-border/70 py-1 sm:py-2" />
  </div>
</div>;
```

### Chrome Patterns

- Desktop nav: sticky full-width `TopNav` (`h-14`, `lg:flex`); the left sidebar is retired, so the `--sidebar-width-*` tokens and `SidebarSpacer` are now legacy/inert
- Mobile header height: `h-14`
- Mobile utility dock: fixed bottom-right dock on `<640px` with shared feedback + scroll-to-top placement; the dock stays hidden until the first scroll so it does not cover top-fold content and is suppressed on `/` so the homepage footer can match the compact Figma frame
- Main content and footer reserve bottom safe space via `pharos-mobile-utility-safe` + `--mobile-utility-safe-offset`
- Main content width: non-home routes are full-bleed like the homepage (`w-full` + horizontal padding) rather than the old breakpoint-capped `container`, so data-dense tables and grids use the available viewport. A `max-w-[120rem]` ceiling with `mx-auto` keeps content centered and sane on ultrawide displays. Prose that previously relied on the `container` cap for its measure now keeps a readable line length at width: editorial blocks like the `AiSummary` body flow into newspaper columns (`lg:columns-2 2xl:columns-3`, with a `max-w-[72ch]` single-column cap below `lg`) so the text fills the full-width card instead of leaving an empty half. Longform shells (methodology/privacy/digest) already carry their own measure and are unaffected.
- Main container padding:
  - Mobile: `px-4`
  - Vertical rhythm: `py-6` (`md:py-7`)
  - Desktop: `lg:px-5`, `xl:px-9` (matches the homepage shell)
- Footer is a compact two-row chip surface: a short one-line legal copy plus `Changelog`, `Methodology`, `API`, and `Sitemap` on the first row; `Independent`, `Funding`, `MIT`, `Privacy Policy`, and the monochrome social icons on the second row. Footer chips use small square rounded controls with muted fill, not tiny outline labels.
- The homepage footer uses an edge-aligned container and suppresses floating feedback/scroll controls so the footer reads as the final visible band beneath the Horizon panel.

---

## Page Shell Variants

### Standard Analytics Pages

Most routes use:

- Wrapper: `space-y-6`
- Title block: `space-y-2.5`
- Title row outer layer: `flex max-w-full flex-wrap items-start justify-between gap-x-3 gap-y-3`
- Title row inner text/action layer: `flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2`

### Feature-Page Hero (`FeatureHeroSplit`)

The redesigned-homepage hero composition is available as a shared shell, `src/components/feature-hero-split.tsx` (`FeatureHeroSplit`), modeled on the locked `HomeAltHero` recipe (the homepage component itself is unchanged). It renders a single flat `pharos-card-shell` split `lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]`: a frost-blue "One Beam" headline figure (`.pharos-numeric text-frost-blue`) plus a `pharos-kicker` sub-metric block on the left, a drawn metaphor or staged chart in the right slot, hairline `border-border/50` dividers, and a corner `CardExpandButton`. The route `h1` still comes from `FeaturePageShell`; a hero is rendered as its first child, not a title replacement.

Per-page hero approach and One Beam calls (owner-settled 2026-06-28, including the design follow-up):

- **`/yield/`** — uses `FeatureHeroSplit` (its sole consumer): beam = highest risk-adjusted (PYS) APY; right slot = the risk×yield scatter. The risk-budget control stays a re-skinned slider (the sanctioned non-pill control); other filters use `pharos-control-pill`.
- **`/alt-pegs/`** — the `FiatWorldAtlas` is the **sole full-width hero** (its own atlas chrome, not `FeatureHeroSplit`); the split frost market-cap beam was dropped on owner follow-up so the celestial atlas leads alone. The atlas title and a reference link are de-frosted.
- **`/upcoming/`** — a **full-width constellation hero**: a `pharos-card-shell` with a header carrying the frost launch-count "One Beam" + the soonest launch, and the full-width `UpcomingHorizonHero` constellation below (adapted from the untouched homepage constellation). The split shell was dropped on follow-up to give the circles full width, and the redundant per-phase count list was removed (the per-circle count labels are the legend). Sort uses `pharos-control-pill`.
- **`/liquidity/`** — the `FeatureHeroSplit` hero was **reverted on follow-up** (the short left column left dead space against the tall exit-route map): the page keeps its KPI-stat grid (aggregate DEX depth as the lead stat) above the full-width exit-route-map card. The two intro education cards plus the FAQ (and its `FAQPage` JSON-LD) remain removed; filters live in the table toolbar as `pharos-control-pill`s.
- **`/flows/`** — deliberately **opts out** of the One Beam: the hero stays a flat `pharos-card-shell` whose net-flow headline and Bank Run Gauge keep the semantic green→red ramp (net flow is a directional state, never recolored frost). The radial cyan/emerald hero gradient was removed, the gauges moved to a workbench band below the hero, and the `FlowMachineScene` metaphor is preserved.
- **`/chains/`** — keeps its existing sequential bands (no `FeatureHeroSplit`); only the Total Stablecoin Supply metric was recolored to the frost beam, and its "Top N chains hold X%" frost badge is intentionally retained as an owner override.

Risk-tab calls (owner-settled 2026-06-30):

- **`/safety-scores/`** — uses `FeatureHeroSplit`: beam = ecosystem-average safety score; right slot = a compact A/B/C/D/F/NR grade-distribution bar (semantic grade swatches from `getSafetyGradeMetadata`, never frost), reusing the Peg-Health/DDR distribution-bar chrome in `pharos-chart-stage`. The frost-on-active-control leak in the inspection board was neutralized.
- **`/depeg/`** — **full-width DDR hero**: a `pharos-card-shell` beam band (frost active-depeg count + DEWS-alert count + a semantic worst-live-deviation pill), with `DepegResolverModule` (the DDR forecast timeline) rendered as a **sibling below the beam card** — not inside it — so its per-event forecast cards stay flat top-level surfaces (no card nesting). DEWS radar + DDRR ledger demoted to a secondary band. `DepegResolverRowCard`/`StateOnlyCard` flattening also reaches the stablecoin-detail DDR card (canon-consistent flat-card harmonization).
- **`/freezewatch/`** — **full-width freeze-meter hero**: frost freezable-share-of-tracked-supply beam + freezable value/coins sub-metrics in the header; `FreezableSupplyMeter` full-width below; `BlacklistStats` KPIs became a flat bento (data-quality tone reduced to a data-driven left-stripe). Filters → `pharos-control-pill`.
- **`/compliance/`** — **full-width hero** (table-first): frost MiCA-authorized count beam + GENIUS-tracked / authorization-rate / assessed-rows sub-metrics + a neutral GENIUS regime-state badge; the two compliance tables are the workbench beneath, with a `pharos-table-toolbar` carrying `pharos-control-pill` regime/type/peg filters.
- **`/cemetery/`** — 🚫 memorial **carve-out**, untouched except a light consistency polish: title → `pharos-page-title`, sort → `pharos-control-pill`, stat digits → `.pharos-numeric`. Tombstones, cause palette, flower interaction, and obituary typography are unchanged.

Reference-group hero calls (owner-settled 2026-07-01):

- **`/coverage/`** — a **full-width signature hero** (no `FeatureHeroSplit`; the 10-row feature-breadth bar list is too tall and would strand dead space beside a sparse left column, the documented `/liquidity/` failure). Compact header strip carries the frost "One Beam" = the active-coin universe count, with neutral `.pharos-numeric` avg-reach % and tracked-surfaces sub-metrics; the existing feature-breadth stacked-bar chart is reused full-width beneath as the drawn metaphor, and the MatrixTable stays the workbench. The sort control stays a `<select>` (grouped options) but is reskinned to the pill/token visual; filter quick-picks already use `pharos-control-pill`.
- **`/about/`** — a **modest hero** (light/editorial page; no metaphor): a single frost "One Beam" = `TRACKED_STABLECOIN_COUNT`, the editorial lede preserved verbatim, and a neutral `.pharos-numeric` stat strip. The former `AboutReferenceModule` reference-card block was removed so the signature leads under the intro (see `docs/about-page.md`).
- **`/funding/`** — a **full-width hero strip**: the frost "One Beam" = the monthly running cost (`costs.json` total); the coverage % stays neutral (a directional funding-progress figure, never recolored frost). The resting `shadow-sm` was neutralized to flat `pharos-card-shell`, previous-month chips adopt the pill control visual, and figures use `.pharos-numeric`. The progress-bar fill and the Giveth "recommended" tile are the sanctioned frost keeps.
- **`/methodology/`** — **no hero**: it stays a longform carve-out (see below). Only its control + numeric *grammar* was aligned — the reader/analyst and show-your-work toggles adopt the pill control language and stray figures move to `.pharos-numeric` — while the 76rem measure, section shells, and `LongformScrollspyNav` are untouched.

Learn-group hero calls (owner-settled 2026-07-01):

- **Shared shell:** the Learn hubs use `src/app/learn/_shared/learn-hero.tsx` (`LearnHero`) — a lighter flat `pharos-card-shell` header band (frost "One Beam" figure + muted sub-metrics + optional full-width slot), **not** `FeatureHeroSplit`. These are Category-C editorial surfaces where a drawn metaphor is not forced, so the split shell would strand dead space (the `/liquidity/` lesson). Titles were brought to homepage parity: `LearnPageShell`'s `h1` now uses `.pharos-page-title` (ABC Whyte Inktrap display face, fixed scale) and its section/list headings use the `.pharos-display` recipe at a fixed `text-2xl/sm:text-3xl` scale — previously Geist Sans at a fluid clamp. This shell is shared, so the face change also reaches the mechanism and case-study detail pages.
- **`/learn/`** — the `OutcomeLedger` is promoted into a flat `pharos-card-shell` hero band and deliberately **opts out** of the One Beam: its survived/wounded/died figures keep the semantic ramp (a directional death count, never recolored frost). The three numbered module links are the workbench beneath.
- **`/learn/mechanisms/`** — `LearnHero` with the neutral active-coin total as the frost beam plus a restrained active-coins-by-mechanism distribution bar (reuses the flat proportional-bar idiom; non-frost `CHART_PALETTE` sequence tones, index 0 skipped because it resolves to frost). The six mechanism diagrams and the "at a glance" comparison matrix remain the workbench.
- **`/learn/glossary/`** — `LearnHero` with the term count as the frost beam; the A–Z jump rail restyled to a cohesive pill chip rail. Keeps the `FeaturePageShell` longform narrow measure.
- **`/learn/case-studies/`** — 🚫 editorial **carve-out**, polished within register: a restrained `LearnHero` (neutral archive count as the frost beam, semantic survived/wounded/died breakdown beside it) and the outcome/mechanism filter chips migrated off frost onto `pharos-toggle-pill` / `pharos-control-pill-active`. Archive rows keep their row layout + outcome chips (no card/rank conversion — see Longform Pages).

### Longform Pages

- Privacy: `mx-auto w-full space-y-6 max-w-2xl`
- Methodology: `mx-auto w-full max-w-[76rem] space-y-8`
- Digest archive: `mx-auto max-w-4xl`
- Digest detail shell: `mx-auto max-w-4xl`, with editorial body copy constrained to `max-w-[68ch]`
- Learn case-study pages: detail articles use the standard sans token with a sticky wayfinding rail on long reads; the hub's priority studies use a lighter editorial card treatment but are not nested cards, and archive rows keep outcome chips plus archetype accents rather than ordinal ranking. The hub gained a restrained `LearnHero` header band and neutral `pharos-toggle-pill` filter chips (2026-07-01) but keeps this editorial register — no ordinal ranking, no row→card conversion.

### Start Here (Special)

The `/start/` orientation route keeps the shared title shell, then shifts into a broader planning-board layout:

Behavioral contract: [Start Page](./start-page.md)

- Wrapper: `mx-auto max-w-6xl space-y-8`
- Hero shell: large rounded plotting-board surface with editorial onboarding copy on the left and a route board on the right
- Route board: uniform goal cards in `sm:grid-cols-2 xl:grid-cols-3`
- Mobile top fold compresses the hero copy so the first route card stays visible above the fold
- Desktop hero keeps the route board on the right while the left column stacks headline copy and `HeroEscapeHatch`
- Desktop support content under the headline stays in a clean vertical stack: CTA row first, then the experienced-user note
- Follow-up sections use glossary cards, flattened feature-atlas groups, and shortcut cards instead of one long prose stream

### Home Dashboard (Special)

Home keeps a single visible page `h1` owned by `HomeAltHero`; the rest of the top fold is composed of:

Behavioral contract: [Homepage](./homepage.md)

- Hero market snapshot: `HomeAltHero` renders the `Market Pulse` heading, total-market figure, cohort rows, and viewport-gated chart in one `pharos-card-shell`
- Core top rail: the live tape is mounted directly below the desktop `TopNav` on every standard page, and below the mobile `Header` only on the homepage. The horizontal core-nav pill strip is retired; the grouped top nav owns wayfinding. On desktop, the tape is sticky below the fixed top nav (`lg:top-14` on `/`, `lg:top-[calc(3px+3.5rem)]` elsewhere) so the registry chips and event ticker remain visible across Reference, Learn, and analytics pages. Interior mobile routes suppress the tape to avoid crowding the first viewport.
- Shortcuts module: the homepage saved-shortcuts panel uses one unified bordered shell with internal hairline dividers. Desktop (`lg+`) presents twelve route shortcuts in a six-column, two-row grid; each default route carries a distinct icon-tile category tint while the cells stay neutral. If a smaller saved list exists, the view backfills from the default route set while edit mode preserves the actual saved list. Smaller breakpoints render only the saved shortcuts so the surface does not overtake the dashboard stack.
- Snapshot shell: PSI-dominant first card + four supporting desktop KPI panels; mobile and tablet collapse to a 2x2 compact tile grid that includes net mint/burn flow
- Snapshot PSI lead card always renders the three compact delta pills (`24h`, `7d`, `30d`) beside the score/band lockup
- Market Pulse Daily Digest promo: desktop-only compact editorial card in the equal-height first-row trio with Peg Health and the PSI/Mint-Burn block. Peg Health uses a full-height metric/distribution stack so the status bar and four health rows occupy the available card height instead of collapsing into the top half. The digest card uses a Newsreader masthead, grey icon+text CTA pills, a teal bottom glow, and a clipped layered article preview using the current daily digest title plus short text. Placeholder/funny promo copy is not allowed.
- Market Pulse hero chart: the custom SVG reserves enough top and right-side gutter for edge labels to stay optically framed inside the card shell.
- Market Pulse hero chart neutrals: the total-market envelope uses a soft slate fill/line, while `Non-USD share` uses a darker dashed grey stroke and matching dashed legend marker so the 2-3% non-USD series cannot be mistaken for the large envelope.
- Market Pulse expand affordance: card headers use a compact module-jump button (`CardExpandButton`) rather than a bare glyph. The control keeps a rounded outer square with muted fill, a hairline border, and an inset rounded tile carrying a small right-arrow icon so the action reads as "open the associated module" without competing with card data.
- Market Pulse lower event trio: desktop uses a compact 232px equal-height row for Biggest Supply Moves, Recent Freezes, and Total Active Depegs. These cards surface only the top homepage rows (three supply up/down rows, four recent freezes, four active depegs) so the second band stays aligned with the Figma workbench without a dead bottom band; mobile keeps the stack content-height, with the active-depegs list suppressed below `sm`.
- Digest preview: broadsheet split with a mono masthead, hairline `Executive Summary` label, newspaper-style `Newsreader` title on the left, and the lead paragraph plus CTA rail on the right at desktop. The lazy boundary may reserve space before mount, but the loaded preview itself stays content-height so the page-discovery board follows without a dead desktop band.
- Upcoming horizon module: a server-rendered `On the Horizon` panel below the main stablecoin board (`home-alt-upcoming-horizon-constellation.tsx`) that summarizes the pre-launch universe. It keeps the analytics `pharos-card-shell` treatment with a frost mono kicker and an approach rail, but represents phases with the actual upcoming coin logos instead of count-only badges. At `xl+` each stage is a circular constellation on its own phase-colored tinted disc (`PHASE_FIELD`, hues mirroring `PHASE_DOT`) so the five zones read as distinct; the disc diameter scales with total phase count even when visible dots are capped behind a `+N` tracker link, so Announced is the largest cluster and sparse stages are smaller. Labels sit below with a `PHASE_DOT` chip and count. Below `xl` the phases stack as compact labelled lanes; mobile lanes cap visible logos to one clipped row and rely on the count label for the full total so the homepage footer remains in-frame. Each visible logo links to its detail page, the module links to `/upcoming/`, and there is no separate nearest-launches strip or edge accent stripe.

### Stablecoin Detail (Special)

Active detail pages keep one server-rendered semantic `h1` for crawlers and assistive tech, while the visible identity lives in the client hero:

- Server `h1`: `sr-only`
- Client HeroCard mobile `h2`: `text-2xl font-black tracking-tighter`
- Client HeroCard desktop `h2`: `text-3xl font-black tracking-tighter`
- Section and block titles across the detail route use `text-lg font-semibold tracking-tight`
- Detail metadata badges that qualify a section title (for example liquidity source coverage) sit inline with the title instead of dropping onto a separate row
- The `Contract Deployments` block shows a one-row, six-item icon preview on mobile with a `Show all` toggle; `sm+` renders labeled rows (chain logo + name link + truncated address + copy + explorer) in a 1/2/3-column grid with a nine-row preview and its own `Show all` toggle — the bare icon wall was retired in the June 2026 mythos pass (recognition fails past the top-10 chain logos)
- A "verification passport" strip docks at the bottom of the hero card behind a hairline `border-t`: identity-document fields in two scan clusters — how the token works (Mechanism, Redeemability, Minting, Freeze, Record, Chains), then who stands behind it (Jurisdiction, MiCA, GENIUS, Attestor, Issued) — with the field name in small muted letters above a mono all-caps value, each linking to the section that proves the fact. Flat document fields, not pills; data-driven text tones only (attestor tier ladder via `POR_TIER_STYLES.textCls`, freeze amber/emerald); snap-scroll carousel below `lg`, edge-to-edge distributed wrap (`justify-between` at ≥6 facts) on `lg+`. See `docs/stablecoin-detail-page.md` `### Hero passport strip` for the field/anchor contract.
- `LongformScrollspyNav` renders once as a sticky horizontal pill banner: a single inline row of section pills with no caption label. The active pill reuses the core-rail frost recipe (`.pharos-rail-tab` / `.pharos-rail-tab-active` + `.pharos-nav-beam` activation sweep + lit `text-frost-blue` icon), so the lit section reads strongly and stays theme-stable; active detection is scroll-position based (the last heading above the line just under the sticky nav) so the lit pill tracks the section being read without lag, and the active pill auto-scrolls into view in the overflow row on narrow viewports. On `lg+` the banner stays full-width with the pill row centered above the full-width dossier stream instead of reserving a side rail column
- A single `Explore Next` hub at the end of the page, replacing the older stack of repeated research/compare/related link grids with one consolidated crawlable route cluster

This is intentionally denser than standard feature pages.

### Digest Article (Special)

Digest entries use a distinctive **"intelligence briefing"** editorial aesthetic that deliberately departs from the standard Geist-based UI:

- `h1`: Newsreader display face via `digestDisplay.className` with `text-[clamp(2.2rem,5vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.04em]`
- Executive summary card ahead of body copy
- Editorial prose constrained to `max-w-[68ch]`
- Homepage digest preview switches to a split desktop layout so the title block and italic executive-summary paragraph can use the full container width; dedicated digest pages keep the `max-w-[68ch]` editorial measure.

#### Archive Front Page (`/digest/`)

The archive index reads as a single newspaper front page rather than a standard feature shell (it does not use `FeaturePageShell`):

- **Nameplate** (`DigestNameplate`): a centered broadsheet masthead — hairline-flanked eyebrow, oversized `digestDisplay` (Newsreader) wordmark carrying the page `h1`, and a ruled dateline strip (`border-t-2 border-foreground/70` above, hairline below) reading `Issue #<latest daily edition> · <date> · Written by Claude Opus 4.8`. The on-page breadcrumb is omitted for the full-bleed masthead; `BreadcrumbJsonLd` is still emitted for SEO.
- **Sectioned wire**: `WireSectionRule` hairline-flanked labels separate `Today's Lead` (the daily preview, rendered with `DailyDigest hideMasthead` since the nameplate already carries the edition + date), `The Week in Review` (latest weekly teaser), and `Archive` (month-filtered wire table). The weekly recap appears once — the old sans-serif "Weekly market recaps" card grid was removed; older weeklies live in the wire table (`Weekly #N` badge + subtle `bg-muted/25` fill, no edge stripe).
- **Colophon** (`DigestColophon`): a one-line mono small-caps footer (`Pharos Digest · Watching the peg · RSS · Methodology · Privacy · Not financial advice`) replaces the standard site footer. The global `Footer` is suppressed across the whole `/digest` subtree via `GlobalFooterChrome`; dated detail pages keep their richer `EditorialColophon` (with citation), and the detail masthead credits `Editor: Claude Opus 4.8`.

#### Editorial Typography System

The digest feature employs a dual-font hierarchy that evokes newspaper headlines over wire-service dispatches:

| Element       | Font                                                       | Rationale                                          |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| **Headlines** | `font-serif` + route-local `Newsreader` usage where needed | Editorial authority — magazine headline gravitas   |
| **Body copy** | `Courier New` italic                                       | Raw urgency — telegrams, terminals, raw intel      |
| **Metadata**  | `Courier New` upright                                      | Systematic precision — timestamps, edition numbers |

This pairing creates a "broadsheet newspaper" aesthetic that signals both authority and real-time urgency. It is one of three intentional non-Geist text treatments in Pharos, alongside the stablecoin-detail `AiSummary` Georgia serif paragraph and the `/timeline/` wire-service stream documented in `### Tape (Special)` below.

**Implementation**: Import styles from `@/lib/digest`:

- `EDITORIAL_BODY_STYLE` — Courier italic for prose
- `EDITORIAL_META_STYLE` — Courier upright for labels

### Tape (Special)

The `/timeline/` event stream uses a deliberate **wire-service / terminal aesthetic** that diverges from the standard `pharos-card-shell` analytics surface. Where Digest is the broadsheet, Timeline is the syslog: mono-token typography everywhere, hairline dividers in place of card chrome, severity expressed as text color, per-class background tints (hue signals class, text-color signals severity), and row time prefixes that use `HH:MM` on larger screens and compact relative tokens on mobile.

This is an intentional non-sans-token treatment alongside the Digest/depeg editorial system (Newsreader serif + Courier italic) and the stablecoin-detail `AiSummary` Georgia paragraph. Tape is distinct from both: it leans on the mono token as the primary typeface across the stream, not serif for editorial gravitas.

The absence of `pharos-card-shell` on event rows, day groups, the currently-open band, pinned linked-event block, and the filter row is **intentional, not an oversight**. The filter row is a flat wire-control surface with hairline `border-y` dividers and shared control primitives, not a card shell.

The canonical contract — rules, structured row layout, day-separator format, and the Aesthetic Lock against harmonization — lives in [tape-page.md](./tape-page.md) under `## Visual Identity` and `## Aesthetic Lock`. Update both docs together when the wire-service treatment changes.

### Cemetery (Special)

The Stablecoin Cemetery (`/cemetery/`) employs a **unique memorial aesthetic** that is intentionally divergent from standard Pharos UI patterns:

- **Tombstone visualizations**: Custom SVG-based tombstones with varying shapes (arch, hammer, cross), sizes (by peak market cap), and weathering effects (by age)
- **Theme-aware memorial palette**: Uses bespoke stone/zinc accents and cause colors for the memorial atmosphere, while tombstone SVGs and cards still adapt through semantic CSS variables and light/dark Tailwind classes
- **Cause-of-death color system**: Algorithmic failure (red), counterparty failure (amber), liquidity drain (orange), regulatory (blue), abandoned (zinc)
- **Interactive memorial**: "Press F to pay respects" with persistent flower accumulation

This is a **one-off artistic treatment** — the patterns are not intended for reuse on other pages. The bespoke memorial colors and components serve the specific narrative of memorializing failed stablecoins.

---

## Typography

### Heading Scale

| Role                      | Live class pattern                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard page title       | `min-w-0 text-3xl sm:text-4xl font-extrabold tracking-tight leading-[1.05]`                                                                     |
| Shared page title utility | `pharos-page-title`                                                                                                                             |
| Digest article title      | Newsreader via `digestDisplay.className`, `text-[clamp(2.2rem,5vw,3.5rem)]`, `font-semibold`, `leading-[0.92]`, `tracking-[-0.04em]`            |
| Homepage digest hero      | `Newsreader`, `font-semibold`, `text-[clamp(2.8rem,6vw,5rem)]`, `leading-[0.88]`, `tracking-[-0.045em]`                                         |
| Home logotype label       | `sr-only md:not-sr-only md:font-mono md:text-[1.02rem] md:font-semibold md:uppercase md:tracking-[0.16em] md:text-foreground` (hidden below md) |
| Primary section heading   | `leading-none font-semibold`                                                                                                                    |
| Secondary section heading | `text-lg font-semibold` or `text-lg font-semibold tracking-tight`                                                                               |
| Table/section kicker      | `text-[12px] sm:text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground`                                                    |
| Subsection heading        | `text-foreground font-medium`                                                                                                                   |

### Body + Supporting Text

| Role               | Live class pattern                                                          |
| ------------------ | --------------------------------------------------------------------------- |
| Standard body copy | `text-sm text-muted-foreground`                                             |
| Shared lead copy   | `pharos-lead`                                                               |
| Small metadata     | `text-xs text-muted-foreground`                                             |
| Shared metadata    | `pharos-meta`                                                               |
| Card micro-labels  | `text-xs uppercase tracking-wide`                                           |
| Footer legal group | `flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground` |

**Contrast floor:** informational text and meaningful icon affordances never drop below `text-muted-foreground/70` — lower alpha lands under the 3:1 contrast ratio on the light theme (WCAG 1.4.3/1.4.11). Alpha below `/70` is reserved for decorative `aria-hidden` separators (`·`, `/`, rules), disabled controls, loading skeletons, and chart internals that carry their own theme tuning.

### Numeric Language

Numbers are consistently mono/tabular where precision matters:

- `font-mono`
- `tabular-nums`

---

## Spacing and Layout Rhythm

### Common Vertical Rhythm

- Section rhythm: `space-y-6`
- Header block rhythm: `space-y-2.5`
- Longform rhythm: `space-y-8`
- Card prose rhythm: `space-y-6 text-sm text-muted-foreground leading-relaxed`

### Common Grids

- KPI grid (dense analytics): `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5`
- Home snapshot desktop partition: `hidden lg:grid grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,0.92fr))] divide-x divide-border/30`

### Chip/Pill Layout

- Chips are frequently wrapped in `flex flex-wrap gap-2`
- Category links and peg links prioritize `rounded-full` micro-surfaces.

### Onboarding / Access Surfaces

First-run compare, portfolio, and gated status states now share a structured onboarding surface:

- Large rounded shell with dark gradient backdrop
- `pharos-kicker` eyebrow + one decisive title
- 3 step explainer cards
- CTA row using rounded-full buttons
- Preview panel shell on the right at desktop, stacked on mobile
- Optional footnote/support panel at the bottom of the text column

The dedicated `/start/` route extends the same language into a full-page onboarding pattern:

- large hero shell with route-selection cards instead of a single preview panel
- compact fact blocks embedded in the copy column
- glossary cards beneath the hero
- flattened feature-atlas groups plus shortcut cards for optional progressive discovery

---

## Shared Utility Classes

Live production now leans on a broader shared utility layer for finish-level consistency:

- `pharos-kicker`
- `pharos-focus-ring`
- `pharos-card-shell`
- `pharos-interactive-card`
- `pharos-page-title`
- `pharos-lead`
- `pharos-section-title`
- `pharos-meta`
- `pharos-control-pill` / `pharos-control-pill-active`
- `pharos-toggle-pill`
- `pharos-chart-stage`
- `pharos-chart-legend-chip`
- `pharos-table-shell`
- `pharos-table-toolbar`
- `pharos-table-sticky-primary` / `pharos-table-sticky-metric`
- `pharos-panel-header`
- `pharos-subtle-band`
- `pharos-empty-note`

Current high-use areas:

- Homepage snapshot and explore cards
- Peg filter pills
- CTA links with custom focus treatment
- chart legends, chart stages, and comparison controls
- stablecoin/comparison table wrappers and toolbars

### Shared Tables

Use the Pharos-owned table primitives in `src/components/table/` for visible product tables instead of raw `<table>` markup or direct shadcn `Table` composition. The default `@/components/table` barrel is server-safe; client-only affordances such as settings menus and source links live under `@/components/table/client`. The primitives preserve semantic table slots without shadcn's nested overflow wrapper, so table shells, viewport overflow, density classes, striping, sticky headers, test ids, and row naming stay consistent.

Current component roles:

| Component              | Use when                                                                                                   | Notes                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TableFrame`           | Standard children-first row tables, status/admin tables, embedded detail tables, and static content tables | Keep route-specific rows/cells as children; pass `tableId` for stable selectors and fallback table naming; `data-testid` defaults to `${tableId}-table`. |
| `DataTableShell`       | Sortable/paginated analytics tables that already have column descriptors and custom row children           | Compatibility layer over `TableFrame`; still supports route-owned top slots and pagination.                                                              |
| `MatrixTable`          | Comparison/coverage matrices with sticky row headers or metric columns                                     | Do not force matrix behavior into row-table APIs.                                                                                                        |
| `VirtualTableFrame`    | Virtualized large tables such as the homepage stablecoin overview                                          | Keep domain-specific row rendering, preference keys, and actions in the route wrapper; share only the shell, viewport, and table element.                |
| `TableToolbarFrame`    | Generic table toolbar layout with title/meta/actions                                                       | Use this before creating route-local toolbar chrome.                                                                                                     |
| `TableControlsToolbar` | Shared density/settings/export toolbar for client tables                                                   | Import from `@/components/table/client`; pass route-specific column pickers through `columnsSlot`.                                                       |
| `TableSettingsMenu`    | Optional density, column, or custom table settings popovers                                                | Import from `@/components/table/client`; column visibility remains caller-owned.                                                                         |
| `TableSkeletonRows`    | Loading rows that preserve table semantics and density classes                                             | Use inside `TableFrame`/`VirtualTableFrame` rather than standalone `div.pharos-table-shell` skeletons.                                                   |
| `TableSourceLink`      | External source links inside table cells or row details                                                    | Import from `@/components/table/client`; keeps focus, truncation, external-link icon, and optional row-click propagation behavior consistent.            |

Content/reference tables should stay static: no sorting, export, toolbar, or pagination unless the route explicitly needs those controls. Tables with captions keep caption-based accessible names; unnamed framed tables derive a fallback label from `tableId`. Accessibility-only chart data tables may remain specialized.

---

## Contextual Explainability

Computed metrics now use a shared contextual-methodology pattern instead of relying only on page-level intros or `/methodology` as a separate destination.

Current pattern:

- compact help trigger attached directly to the metric label
- desktop behavior: click-to-open popover with short definition + methodology links (a popover, not a tooltip, so keyboard focus can reach the links)
- mobile behavior: bottom sheet with the same content
- score-card footers may add `View methodology` and `Version history` actions when the surface is interpretation-heavy

Use this on:

- composite scores (`Safety Score`, `Liquidity Score`, `PYS`, `DEWS`)
- baseline-relative or Pharos-native signals (`Pressure Shift vs 30D`, `Bank Run Gauge`)
- opaque sub-dimensions where the label alone is insufficient (`Resilience`, `Dependency Risk`)

Do not use this on every metric indiscriminately. The trigger is reserved for values where local interpretation meaningfully improves user decision-making.

---

## Cards

### Base Card Primitive

Default card composition in production:

- `data-slot="card"`
- `bg-card text-card-foreground flex flex-col gap-4 rounded-xl border py-4 shadow-sm`
- card surfaces use the tokenized flat fill + hairline border treatment; homepage/bento dark surfaces resolve to the charcoal `--card-bg` block fill with no shell gradient or drop shadow
- `pharos-card-shell` is the promoted authored-surface wrapper for major route modules, tables, and feature cards

### Card Header + Title

- Header: `@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4`
- Tight variants add `pb-1`, `pb-1.5`, or `pb-2`
- Titles: mostly `leading-none font-semibold`
- Shared route and chart surfaces increasingly use `pharos-panel-header` for a restrained header band instead of ad-hoc muted strips

### Accent Border Palette (Live)

The decorative per-card colored left stripe (`border-l-[3px] border-l-*-500`) has been **retired from analytics, discovery, and methodology surfaces** (May 2026 harmonization). KPI stat cards (`MetricStatCard` with no `borderColorClass`), feature/section cards (`/about`, `/funding`, `/methodology` and its changelogs), the `/status` sections, the `/liquidity`, `/depeg`, `/freezewatch` heroes, the `/cemetery` autopsy box, the digest snapshot cards, and the stablecoin-detail Yield Intelligence + blacklist cards now render as flat homepage-style cards (`rounded-xl border bg-card shadow-sm`, no colored edge, neutral `pharos-kicker` eyebrows).

`border-l-[3px]` (with a semantic color) remains reserved for **data-driven indicators**, not card chrome:

- depeg table row severity accents (`rowAccentClass` → `border-l-red-500` / `border-l-orange-500` / `border-l-amber-500`)
- stablecoin-detail hero metric accents (`accentClass` in `hero-card-metrics`)
- internal admin status sections (`StatusSection` still accepts an optional `accentClassName`)
- stablecoin-detail per-coin notices (`coin-notice.tsx`): the danger/warning/info alert stripe is severity-keyed data, deliberately kept through the June 2026 mythos review and normalized to the same 3px weight

The desktop **top-nav** (`top-nav.tsx`) active state is a neutral `bg-muted/60` fill, not a stripe — the old left "watch column" sidebar was retired in the Figma redesign. The frost lit-tab survives on the **detail-page scrollspy** (`LongformScrollspyNav`: `.pharos-rail-tab-active` + `.pharos-nav-beam` + lit `text-frost-blue`); the **mobile drawer** (`header.tsx`) keeps `border-l-2 border-l-frost-blue` on the active route group. See `### Navigation Active vs Inactive` below.

### Interactive Card Pattern

`pharos-interactive-card` is the richer hover-lift utility used on the about-page feature grid. Homepage callouts currently stay on lighter `pharos-card-shell` variants without the extra interactive-card class. Following the May 2026 harmonization these surfaces no longer carry a colored left stripe.

```tsx
className = "pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col p-4";
```

### Logo Containers

Tracked token logos now render inside a shared neutral container:

- `rounded-full border border-border/60 bg-background/80`
- subtle inset highlight
- image shrunk slightly inside the wrapper so transparent/low-quality upstream assets do not collapse into the page background

---

## Badges and Chips

### Version Badge

Secondary version pill:

- `bg-background/35 text-muted-foreground border-border/60`

### Micro Chips

Common chip form:

- `inline-flex items-center rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent transition-colors`

### Control Pills

The preferred finish-level control language is now the shared pill system:

- base: `pharos-control-pill`
- selected: `pharos-control-pill pharos-control-pill-active`
- used on time-range controls, density toggles, lens pills, and lightweight route context summaries
- pills should feel dense and precise, not marketing-chip playful

`pharos-control-pill` is the **canonical small-control shell** for any dense, secondary action surface — defined in `src/app/globals.css`. Following the May 2026 detail-page pass, this includes the hero tertiary metric chips, per-section freshness stamps, and the longform scrollspy. (The former chains/freezable hero pills were absorbed into the flat hero passport strip in June 2026 — see `### Stablecoin Detail (Special)`.) New surfaces should reach for this utility before constructing ad-hoc rounded-full button shells.

### Proof-of-Reserves Attestor Tier Ladder

`POR_TIER_STYLES` in `shared/lib/classification/badges.ts` defines a 5-tier categorical color ladder used for the per-coin proof-of-reserves badge on detail pages. The ladder maps directly to `AttestorTier` from `shared/types/core.ts`:

| Tier       | Color           | Token classes                                                                    | Meaning                                         |
| ---------- | --------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `big4`     | emerald         | `bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30` | Big-4 firm independent attestation              |
| `regional` | blue            | `bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30`             | Licensed regional CPA / auditor                 |
| `niche`    | muted / neutral | `bg-muted/40 text-muted-foreground border-border/60`                             | Single-jurisdiction or small-practice attestor  |
| `self`     | amber           | `bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30`         | Issuer self-attestation, no third-party signoff |
| `none`     | red             | `bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30`                 | No attestation surface published                |

This is the canonical 5-tier categorical ladder for evidence-quality badges. Reuse `POR_TIER_STYLES` rather than redefining the palette inline. The ladder degrades cleanly to a 3-tier emerald / amber / red flatten for severity-style surfaces; do not introduce a competing "audit quality" palette.

### Freshness Stamps

`FreshnessIndicator` from `src/components/status/freshness-indicator.tsx` is the canonical "Updated X ago" affordance across the dashboard. It computes age client-side from a `updatedAtMs` prop, switches into a stale tone once `staleAfterMs` is exceeded, and pauses ticking while the document is hidden. As of the May 2026 detail-page pass it also renders inside the Safety Score card header on the stablecoin detail route, paired with the per-card `pharos-control-pill` chrome.

When adding a new freshness stamp:

- always pass `updatedAtMs` from the originating cache snapshot, not `Date.now()` at render
- match `staleAfterMs` to the producer cron interval (see CLAUDE.md hook timing rule)
- prefer the small inline form inside `CardHeader`; avoid stacking a new "last updated" line of body copy on the same surface

---

## Tables

### Base Table Styling

- Table: `w-full caption-bottom text-sm`
- Major table surfaces should prefer `pharos-table-shell` over a plain rounded border wrapper
- Toolbars should prefer `pharos-table-toolbar` with a brief explanatory line rather than a bare row of buttons
- Row: `hover:bg-muted/40 data-[state=selected]:bg-muted border-b transition-colors`
- Table rows now also take a subtle left-edge accent and a small horizontal nudge on hover; risk rows preserve their own semantic border color on hover

### Header Variants

- Standard header: `[&_tr]:border-b` with a theme-aware header band and token-driven shadow
- Sticky directory header (peg pages): sticky top header with restrained blur and `--table-header-shadow`
- Stablecoin detail history tables (depeg + mint/burn) use a rounded bordered shell (`rounded-xl border overflow-hidden`) with the muted header treatment and a footer row pairing mono range copy with outline `Previous` / `Next` controls

### Mobile Directory Table Handling

- Toolbar becomes a vertical stack on mobile instead of a cramped inline row
- `Columns` and `Export CSV` keep large tap targets on mobile; density and range controls also stay pill-based instead of collapsing into tiny tabs
- Density controls collapsed to two modes in the Figma redesign — **spacious** (default for the main overview table) and **compact**; legacy `list` / `comfortable` prefs migrate to the nearest of these on read
- Table keeps a deliberate horizontal-scroll affordance via helper copy and a dynamic inline min-width: the sum of per-column content minimums (`COLUMN_MIN_WIDTH_PX`) for the visible column set, with a 420px floor. The viewport's `overflow-x-auto` self-degrades — no scrollbar when the columns fit, horizontal scroll when they don't — so fixed-layout cells never squeeze below content width. The mobile/desktop column boundary is `lg` (1024px); the 7d sparkline renders from `lg` up. Below `lg` the price column is pinned to its content width (`w-[88px]`) so fixed-layout leftover sharing cannot inflate it past the 390px first viewport and clip the fourth peg-price decimal at rest
- Bottom spacing is preserved so the mobile utility dock never sits on the last visible rows

### Sortable Head Pattern

Sortable heads consistently include:

- `cursor-pointer`
- `hover:bg-muted/50 transition-colors`

Numeric columns remain right-aligned (`text-right`) and collapse progressively by breakpoint (`hidden sm:table-cell`, `hidden md:table-cell`, etc.).

### Clickable Rows

Interactive rows use:

- `group cursor-pointer`
- `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none`

---

## Charts

### Live Chart Container Pattern

- Height: `h-[250px] sm:h-[350px]`
- Recharts container keeps `min-width: 0; min-height: 0`
- Chart-heavy home modules now reserve height through matching skeletons or client-ready mount guards before `ResponsiveContainer` renders
- Premium chart framing now uses `pharos-chart-stage`: a dedicated bordered stage inside the card, rather than letting charts float directly on the card background
- Legends should prefer compact chips (`pharos-chart-legend-chip`) when the chart needs persistent series context outside the tooltip

### Axis + Grid (Observed)

From production rendered charts:

- Tick text: `font-size: 12`, `font-family: var(--font-mono, monospace)`, `fill: var(--color-muted-foreground)`
- X axis keeps extra breathing room through `tickMargin={10}`
- The shared `MonoYAxis` primitive defaults to `width={68}` and `tickMargin={8}` for cleaner number alignment
- Grid lines: `stroke="var(--color-border)"`, `strokeDasharray="2 6"`, verticals off by default

### Area Chart Styling (Observed)

- Areas use gradient fills (e.g. `fill="url(#psiScoreGradient)"`)
- Stroke widths are typically `1.5` or `2`
- Tooltips should use the shared elevated card treatment (`PharosChartTooltip`) with uppercase label treatment and mono values

### Loading Fallbacks

Common chart skeletons:

- Default chart skeleton (`ChartSkeleton`): `pharos-chart-stage pharos-crossfade-layer skeleton-shimmer relative w-full overflow-hidden`, with `h-[250px] sm:h-[350px]` applied via the `className` prop (the shared `CHART_HEIGHT` default)
- Bare shimmer placeholder (`Skeleton variant="default"`): `rounded-md bg-accent animate-pulse`
- Blacklist hero chart uses `h-[220px] sm:h-[280px]`
- Yield scatter plot uses `h-[420px]` (compact) or `h-[600px] sm:h-[850px]` (full) inside a bordered chart stage

---

## Interaction and State Patterns

### Navigation Active vs Inactive

The global desktop nav is the **top-nav** (`src/components/top-nav.tsx`, ≥`lg`) — the left "watch column" sidebar was retired in the Figma redesign. Active state is **neutral, not frost**:

- Active menu trigger: `bg-muted/60 text-foreground` (`aria-current`).
- Inactive trigger: `text-muted-foreground hover:bg-muted/40 hover:text-foreground`.
- The bar is sticky `h-14`, frosted (`bg-background/85 backdrop-blur-md`) with a hairline bottom border; the brand wordmark uses `.pharos-display`; global Search (`⌘K`, `openCommandPalette()`) and an overflow menu (Telegram / What's New / status + dark·light·system theme) sit on the right, the overflow triggered by a lighthouse glyph — the one brand-metaphor touch in the chrome.

The frost lit-tab survives where a **reading position** is tracked, not on the global nav:

- **Detail-page scrollspy** (`LongformScrollspyNav`): the active section pill reuses the frost recipe — `.pharos-rail-tab-active` + the `.pharos-nav-beam` activation sweep + a lit `text-frost-blue` icon (reduced-motion gated).
- **Mobile drawer** (`header.tsx`, `<lg`): the active route group keeps a `border-l-2 border-l-frost-blue` accent.

The `CoreTopRail` (`src/components/core-top-rail.tsx`) below the nav is now a live tape (registry chips + event ticker), not a nav pill strip — the horizontal core-nav pills were retired and folded into the Terminal menu.

The mobile drawer (`header.tsx`) keeps its own active treatment (`border-border/70 bg-muted/60` links, `border-l-2 border-l-frost-blue` group accents) and was intentionally left unchanged in this pass.

### Focus Treatment

Two dominant focus patterns:

- `focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`
- `focus-visible:ring-[3px] focus-visible:ring-ring/50`

### Loading States

- Skeletons are the default loading surface (`data-slot="skeleton"` + `animate-pulse`)
- Page-level loading uses skeleton shells (`PageLoadingShell` / `PageLoadingChartBlock` in `src/components/page-loading-skeleton.tsx`), built from `Skeleton` (`data-slot="skeleton"`); there is no frost-blue spinner.

### Live/Event Indicator

Depeg live indicator uses animated ping:

- `animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75`

### Data Availability Banner

When data streams are missing:

- `rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground`

The current pattern is a titled trust banner with dataset-specific copy, for example:

- `Waiting for initial data`
- `Affected: report cards.`
- `Last successful update: Mar 24, 1:01 PM GMT+1.`

---

## Responsive Behavior

### Breakpoint Behavior in Production

- `sm`:
  - Compacts/expands table columns
  - Converts details/nav patterns
- `md`:
  - Masthead tagline becomes visible as a single `whitespace-nowrap` line.
  - Snapshot KPI grid expands; other dense-data grids transition between mobile and desktop layouts
- `lg`:
  - `TopNav` becomes active (`lg:flex`); mobile header / drawer hides (`lg:hidden`)
  - Tablet portrait (sub-`lg`) intentionally falls back to the mobile drawer because the top-nav has too many groups to remain legible at that width
  - Main horizontal padding increases (`lg:px-6`)
  - Larger grid splits and extra table columns
- `xl`:
  - Additional dense table columns
  - Home KPI grid keeps the wide five-panel snapshot module intact

### Mobile-Specific UX

- Category browse collapses into `details` (`sm:hidden`)
- `--table-header-top: 56px` is set on mobile for sticky header offset alignment
- Bottom utility controls are consolidated into one dock on mobile instead of separate floating widgets

---

## Accessibility Baseline

Live app-wide patterns:

- Skip link present on every page: `sr-only focus:not-sr-only ...`
- Structured breadcrumb JSON-LD on content routes that need crawlable hierarchy
- Focus-visible rings on sidebar links, buttons, table rows, and chips
- Keyboard-ready clickable rows on interactive tables
- Color is reinforced with structure and iconography for key status states

---

## Draw the Metaphor

When a page introduces a metaphor, render it — don't just name it. The Stablecoin Cemetery draws actual tombstones with arched caps, crosses, and flower scatter. The Alt-Peg Atlas draws a starfield with celestial bands and constellation cohorts. The Chains Harbor Chart draws ships with flags, cargo, wakes, and depth lines. On `/depeg/`, the Depeg Duration Resolver (DDR) draws each open event as a forecast timeline — the deviation path _so far_ (peak → now spark), the verdict at a pulsing **NOW** marker, and the projected resolution band (median diamond + IQR over the 6h/24h/7d/30d landmark axis) reaching into the future — while its Reviewer (DDRR) draws a track-record timeline where every graded past call seats above the rail (correct) or below it (miss), so accuracy reads at a glance. The kill-vs-anchor tug-of-war and the DDRR calibration ledger remain beneath these as the "why" and the honesty check.

Rules that keep this from drifting into decoration:

- **Every shape encodes a data field.** No ornamental geometry. If a shape doesn't vary with a number, remove it.
- **Inline JSX SVG, semantic CSS variables, hex fallbacks.** No external `.svg` assets, no runtime SVG libraries.
- **CSS keyframes only, gated on `@media (prefers-reduced-motion: no-preference)`.** No framer-motion.
- **Mobile preserves the metaphor,** not feature removal. Visualization canvases should fit their container without page-level horizontal scrolling; use simplified lists only when the visual cannot remain legible.
- **The underlying data table remains.** The metaphor is a hero. The table is the workbench.

---

## Maintenance Rule

If a deployed class pattern changes in production, update this document immediately after release. This file is intended to describe what users currently see, not aspirational or historical styles.
