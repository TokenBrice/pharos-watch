---
name: Pharos
description: Stablecoin intelligence as a calm, dense instrument — a lighthouse that watches every peg.
colors:
  frost-blue: "#4bc4de"
  control-ink: "oklch(0.19 0.01 255)"
  surface-base: "oklch(0.985 0 0)"
  surface-raised: "oklch(0.97 0 0)"
  surface-overlay: "oklch(1 0 0)"
  text-primary: "oklch(0.145 0 0)"
  text-secondary: "oklch(0.4 0.009 260)"
  text-tertiary: "oklch(0.52 0.007 260)"
  border-default: "oklch(0.922 0 0)"
  border-subtle: "oklch(0.97 0 0)"
  severity-healthy: "#22c55e"
  severity-mild: "#b45309"
  severity-moderate: "#f97316"
  severity-severe: "#ef4444"
typography:
  display:
    fontFamily: '"ABC Whyte Inktrap", Bricolage Grotesque, system-ui, -apple-system, sans-serif'
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  headline:
    fontFamily: '"ABC Whyte Inktrap", Bricolage Grotesque, system-ui, sans-serif'
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Geist Sans, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.18
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  numeric:
    fontFamily: "JetBrains Mono, SFMono-Regular, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "tabular-nums slashed-zero"
  label:
    fontFamily: "Geist Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.12em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  card:
    backgroundColor: "{colors.surface-overlay}"
    rounded: "{rounded.xl}"
    padding: "20px"
  hero-metric:
    textColor: "{colors.frost-blue}"
    typography: "{typography.numeric}"
  numeric-cell:
    textColor: "{colors.text-primary}"
    typography: "{typography.numeric}"
  control-pill:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
    height: "36px"
  control-pill-active:
    backgroundColor: "{colors.control-ink}"
    textColor: "{colors.surface-base}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
    height: "36px"
---

# Design System: Pharos

## 1. Overview

**Creative North Star: "The Lighthouse Watch"**

Pharos is a lighthouse — it watches every peg so the user doesn't have to. The interface is a calm, dense instrument for crypto-native practitioners: a Bloomberg Terminal scoped to stablecoins. It earns trust through completeness and precision, not decoration. Color stays still by default; what moves is the **frost-blue beam** (`#4bc4de`, sampled from the Figma "Market Pulse" frame), which lights live data and the lighthouse metaphor. Everything else is neutral, flat, and tabular.

This is the as-built system after the designer's Figma redesign. It is **light-default** with a full dark theme. The redesign delivered a global **top-nav** (the old left "watch column" sidebar is retired), ABC Whyte Inktrap as the licensed ink-trap display face (with Bricolage Grotesque as the tracked fallback), JetBrains Mono for every figure, flat cards, and a two-mode density (spacious default / compact). **Frost-blue and the drawn lighthouse/nautical identity were deliberately kept** — they are the brand, per PRODUCT.md's "Pharos is a lighthouse — _draw it_." Density is calibrated by surface tier: discovery breathes, the analytics core holds default, power-user tables compress.

It explicitly rejects the Web3-marketing aesthetic (purple gradients, glassmorphism, buzzwords), corporate-fintech blandness, and the generic-SaaS dashboard of interchangeable KPI tiles. Cards are flat. Accents are semantic. The lighthouse is the only metaphor, and it is drawn, not decorated.

**Source of truth.** This file is faithful to the **as-built code** and is the machine-readable mirror for AI agents generating screens. Its tokens mirror `src/styles/tokens/primitives.css` + `semantic.css` (the live source, resolved through `src/app/globals.css`). The canonical human-facing rationale lives in `docs/design-context.md` (canonical), `docs/design-language.md` (live baseline), and `docs/design-tokens.md`. The Figma inventory lives in `agents/figma-redesign/`. Regenerate this file (`/impeccable document`) when tokens or the homepage composition change.

> **History:** a Figma handoff proposed retiring frost-blue for a neutral/Radix palette; the owner's final call (2026-06-27) **kept frost-blue + the lighthouse identity** and neutralized only the global nav (sidebar → top-nav). This doc reflects that decision and the shipped code, not the superseded retirement proposal.

**Key Characteristics:**

- Light-default financial dashboard with a parallel dark theme; semantic tokens switch, hues don't.
- One brand color (frost-blue); it lights live data and the lighthouse/nautical metaphor — not chrome.
- Flat cards: fill + hairline border, no resting shadow. Depth is a hover response, not a default.
- Mono + tabular + slashed-zero on every digit-bearing cell.
- Global top-nav, full-width content (no sidebar); fixed rem type scale; two-mode density.
- Color is reinforced with structure and iconography; never the sole signal.

## 2. Colors

A near-monochrome neutral field with semantic accents that only fire on meaning. The single brand color is frost-blue; the rest of the palette is a state vocabulary, not decoration.

### Primary

- **Frost Blue** (`#4bc4de`): The lighthouse beam. Reserved for the headline market figure, the primary chart stroke (`chart-primary`), the lit longform scrollspy on methodology surfaces, the mobile-drawer active accent, and the drawn nautical/lighthouse surfaces. It is the only color allowed to draw the eye. `--brand-accent` and `--chart-primary` both resolve to it. The global top-nav does **not** use it — desktop nav active state is a neutral `bg-muted/60` — and the coin-detail pill tabs are elevated-neutral per the Figma coin template.

### Secondary (data sequence)

- Cohort and multi-series chart colors (USDT green, USDC blue, USDS+DAI orange, Others purple) and the shared `CHART_PALETTE`. Sequence colors, never UI chrome.

### Tertiary (semantic state ramp)

A single green→amber→orange→red ramp carries every risk vocabulary. The named band families — **Severity** (peg deviation), **PSI** (stability index), **DEWS** (early-warning), and **Score tiers** — all map onto these same hues; document once, reuse everywhere.

One ratified exception (owner, 2026-07-02): the **Score-tier B band is info-blue** (`blue-500` tint family in `shared/lib/report-card-core.ts`). Grades span five bands, and a green→amber jump would read B as already-degraded; blue marks "sound, not top-tier" without borrowing a warning hue. This blue belongs to grade badges only — never to state chips or controls.

- **Healthy** (`#22c55e`), **Mild** (`#b45309` on light / `#f59e0b` on dark — light darkens to amber-700 for WCAG AA), **Moderate** (`#f97316`), **Severe** (`#ef4444`). Each ships a `-hex` twin for Recharts/canvas where CSS custom properties can't reach.

### Neutral

- **Ink** (`oklch(0.145 0 0)`, `text-primary`): Primary text and the near-black `control-ink` active-control fill.
- **Secondary / Tertiary Ink** (`oklch(0.4 0.009 260)` / `oklch(0.52 0.007 260)`): Labels, captions, muted metadata. Floor for informational text is `text-muted-foreground/70` — never lighter (WCAG 1.4.3).
- **Surfaces** — Base (`oklch(0.985 0 0)`, page), Raised (`oklch(0.97 0 0)`, table headers / toolbars), Overlay (`oklch(1 0 0)`, cards & modals).
- **Borders** — Subtle (`oklch(0.97 0 0)`), Default (`oklch(0.922 0 0)`), Strong (`oklch(0.87 0 0)`): a three-step separator hierarchy carrying most of the structure in a shadowless system.

### Named Rules

**The One Beam Rule.** Frost-blue lights live data and the drawn lighthouse metaphor — not chrome, not the global nav, never a gradient or background. Its rarity is what makes it read as a signal.

**The Semantic-Color Rule.** Color encodes state, never identity or decoration. If a color isn't carrying a risk band, a data series, or the beam, it shouldn't be saturated. Inactive states never take a full-saturation accent.

## 3. Typography

**Display Font:** ABC Whyte Inktrap (licensed webfont; Bricolage Grotesque fallback) — the Figma display face. Drives `--font-display`, `.pharos-display`, `.pharos-page-title`, and the top-nav wordmark.
**Body / UI Font:** system-ui stack (the `--font-geist-sans` token name is retained from a prior Geist iteration; no Geist webfont is loaded).
**Data Font:** JetBrains Mono (variable; fallback `SFMono-Regular, ui-monospace`) — folded into `--font-geist-mono`, so every existing mono consumer (tables, `.pharos-numeric`, peg hero) inherits it.

**Character:** A three-face system on a clear contrast axis — an ink-trap grotesque for editorial display weight, a neutral humanist sans for the dense UI, and a precise mono for figures. The authored-editorial serif register (Newsreader / Georgia / Courier) is a deliberate carve-out (the `/digest/` broadsheet, the homepage Daily Digest card, Cemetery obituary plaques, detail-page AI summaries, `/depeg/[event]` incident briefings, the `/blog/` article bodies) — never general analytics.

### Hierarchy

- **Display** (ABC Whyte Inktrap, 700/800 via Bold, 1.875rem→2.25rem, line-height 1.05, tracking −0.025em): Route/page titles (`.pharos-page-title`).
- **Headline** (ABC Whyte Inktrap, 700, 1.5rem→1.875rem, tracking −0.01em): Section titles — "Market Pulse", "Stablecoin Overview" (`.pharos-display`).
- **Title** (Geist Sans, 600, 1.125rem): Card and sub-section headings.
- **Body** (Geist Sans, 400, 0.875rem, line-height 1.5): UI text and prose. Cap prose at 65–75ch; dense tables may run denser.
- **Numeric** (JetBrains Mono, 500, `tabular-nums slashed-zero`): Every digit-bearing cell — prices, percentages, basis points, market caps, scores (`.pharos-numeric`).
- **Label / Kicker** (Geist Sans, 600, 0.6875–0.75rem, UPPERCASE, tracking 0.12em, muted): Eyebrows over data groups (`.pharos-kicker`).

### Named Rules

**The Tabular-Figure Rule.** Numbers always use `.pharos-numeric` (JetBrains Mono + `tabular-nums slashed-zero`). Proportional digits in a data column are a bug — columns must align on the decimal and the zero must never read as an O.

**The Fixed-Scale Rule.** Headings use the fixed rem scale, not fluid `clamp()` (digest/editorial display is the carve-out). A heading that shrinks inside a panel looks worse, not designed. The viewport changes layout, not type size.

## 4. Elevation

Flat by default. Per the Figma redesign, cards are a fill plus a 1px border with **no resting shadow**; structure is carried by the three-step border hierarchy and tonal surface layering (Base → Raised → Overlay), not by drop shadows. Three elevation tokens exist but are responses to state, not defaults.

### Shadow Vocabulary

- **Rest** (`--elevation-rest`: `0 1px 2px oklch(0 0 0 / 6%), 0 8px 20px oklch(0 0 0 / 4%)`): Applied on card hover only, paired with a −2px lift.
- **Raised** (`--elevation-raised`): The command-palette overlay and chart tooltip. (Sticky table columns use a dedicated `--table-sticky-column-shadow`; Radix popovers/dropdowns use Tailwind `shadow-md`/`shadow-lg`.)
- **Featured** (`--elevation-featured`): The rare promoted/featured surface.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow appears only as a response to state — hover, overlay, or a deliberately featured block. If a card has a drop shadow sitting still, it's wrong. Nested cards are forbidden.

## 5. Components

Lead with the character, then specify shape, color assignment, states, and distinctive behavior. Every interactive component ships its full state set (default, hover, focus-visible, active, disabled, loading) and a `prefers-reduced-motion` alternative.

### Navigation — Top Nav (signature; replaced the sidebar)

A global top bar at `≥lg`; content runs full-width beneath it. The left "watch column" sidebar is retired.

- **Contents:** brand mark (ABC Whyte Inktrap wordmark, Bricolage fallback) · six dropdown menus (Overview / Markets / Risk / Analyze / Learn / Reference, mapped from `nav-config.ts`) · global Search (⌘K, `openCommandPalette()`) · overflow menu (Telegram Bot / What's New / API Access / health status + dark·light·system theme controls), triggered by a lighthouse glyph.
- **Behavior:** sticky `h-14`, frosted (`bg-background/85 backdrop-blur-md`), hairline bottom border. Active menu = neutral `bg-muted/60 text-foreground` (**not** frost). A `CoreTopRail` tape (registry chips + event ticker) sticks below it.
- **Mobile:** the `header.tsx` drawer (`<lg`), whose active group keeps a `border-l-frost-blue` accent. The desktop sidebar/`watch-column` lighthouse beam is gone. The stablecoin detail page uses the `LongformScrollspyNav` `pill-tabs` emphasis (Figma coin template): a rounded-full group on the neutral control fill with an elevated-neutral active pill (`.pharos-pill-tab-active`) — no frost. The frost-lit recipe (`.pharos-rail-tab-active` + `pharos-nav-beam`) survives on methodology-family longform pages.

### Cards (`.pharos-card-shell`)

- **Corner Style:** Gently curved (`rounded-xl`, 12px).
- **Background:** Overlay white (`--card-bg` → `surface-overlay`); flat charcoal block (`oklch(0.2 0.003 260)`) in dark.
- **Border:** 1px hairline `--card-border` (`border-default`).
- **Shadow Strategy:** None at rest. `.pharos-interactive-card` lifts −2px with `--elevation-rest` on hover (gated to `@media (hover: hover)`).
- **Accent stripe:** retired from card chrome (May 2026 harmonization). `border-l-[3px]` survives only for **data-driven** indicators (depeg row severity, detail hero metric accents, coin notices). Nesting cards is forbidden.

### Controls — Pills (`.pharos-control-pill`, `.pharos-toggle-pill`)

The primary interactive control on data surfaces is the pill, not a heavy CTA. Frost-blue stays out of controls.

- **Default:** `.pharos-control-pill` is `rounded-full` with `px-3 py-2`; `.pharos-toggle-pill` is `rounded-xl` with `px-3 py-1.5`. Both: 1px border, min-height 36px, muted text on translucent fill.
- **Hover:** Text → primary ink; fill warms toward `--interactive-hover`.
- **Active / On:** Near-black fill (`control-ink`), inverse text, transparent border — a quiet, confident selected state. Density toggle (spacious/compact) and lens/range controls use this language.

### Tables (the workbench)

- **Shell:** `rounded-xl`, hairline border, no shadow (`.pharos-table-shell`).
- **Header/Toolbar:** `.pharos-table-toolbar` on the panel-header fill; search · density toggle · Columns · Export CSV. The Stablecoin Overview uses the `figmaOverview` toolbar variant.
- **Rows:** subtle stripe, hover lift to `--interactive-hover`, sticky first column; right-aligned `.pharos-numeric` figures. Phone-layout boundary is `lg` (1024px) — tablets get the real workbench. From `lg` up the table **auto-fits**: low-priority columns shed to the measured container width instead of forcing horizontal scroll, and a quiet `+N columns` toolbar control reveals the full set (with scroll) on demand. Use the `src/components/table/` primitives, not raw `<table>`.

### Inputs

- **Style:** translucent fill, hairline border, `rounded`. Search is inline in the toolbar / a top-nav command field — no modal.
- **Focus:** `.pharos-focus-ring` — a 2px `ring/60` with a 2px background offset on `focus-visible`, on every interactive element including table rows.

### Signature Surfaces & the Drawn Metaphor

Pharos draws its metaphors rather than naming them (every shape encodes a data field; inline JSX SVG, semantic vars, reduced-motion-gated keyframes):

- **Market Pulse hero:** split panel — Total Market Cap as the frost-blue `hero-metric` + cohort breakdown + live area chart.
- **The lighthouse/nautical identity (kept):** Chains "harbor chart" (ships, wakes, depth lines), the `/stability-index/` PSI lighthouse scene, the On-The-Horizon constellation with its brightening beam, the Alt-Peg Atlas starfield, the Cemetery tombstones, the `/depeg/` DDR forecast timeline.

### Homepage Composition (signature surface — the locked layout)

The redesigned homepage is an ordered workbench. Sections, order, and rhythm are the contract; below-fold bands lazy-mount but the **sequence is fixed** (eight bands, owner-sanctioned 2026-07-02):

1. **Market Pulse hero** — frost-blue total market cap + cohorts + live chart.
2. **Pulse band (bento)** — Row 1: Peg Health · (Stability Index + Mint/Burn stacked) · Daily Digest editorial promo; Row 2: Biggest Supply Moves · Recent Freezes · Total Active Depegs.
3. **Saved Shortcuts** (localStorage, per-device).
4. **Stablecoin Overview** — the directory table + Browse By Peg.
5. **On The Horizon** — upcoming-stablecoins constellation.
6. **Depeg Duration Resolver overview** — DDR forecast band with accuracy-by-horizon read.
7. **Yield Intelligence overview** — risk-adjusted yield teaser for `/yield/`.
8. **Status & Telegram strip** — pipeline-health pulse + PharosWatchBot entry.

Vertical rhythm: `space-y-5`/`6` within bands, `mt-5`/`6`/`8`/`10` between them; bento gaps `gap-3` (12px); panels pad `p-5`–`p-7` (20–28px).

### Motion

Fast/State `160ms`, base `220ms`; standard easing `cubic-bezier(0.22, 1, 0.36, 1)` (decelerating; no bounce/elastic). Motion conveys state — hover lift, selection, the detail-scrollspy beam sweep, chip enter/exit — never page-load choreography. Every keyframe has a `prefers-reduced-motion: reduce` alternative.

## 6. Do's and Don'ts

### Do:

- **Do** reserve frost-blue (`#4bc4de`) for live data and the drawn lighthouse metaphor — the One Beam Rule.
- **Do** render every digit with `.pharos-numeric` (JetBrains Mono, `tabular-nums slashed-zero`).
- **Do** keep cards flat: `surface-overlay` fill + 1px `border-default`, `shadow: none` at rest; lift only on hover.
- **Do** encode state with the semantic ramp (severity / PSI / DEWS / score) and reinforce it with structure or an icon — never color alone.
- **Do** draw new metaphors (every shape encodes a data field; inline SVG, semantic vars, reduced-motion-gated) — and keep the underlying data table as the workbench beneath the hero.
- **Do** use the fixed rem type scale for headings; keep informational text at or above `text-muted-foreground/70` for WCAG AA.
- **Do** gate every animation behind `prefers-reduced-motion`.

### Don't:

- **Don't** reintroduce the left "watch column" sidebar — the global desktop nav is the full-width top-nav.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe on card chrome — it's reserved for data-driven indicators (depeg severity, detail hero accents).
- **Don't** ship Web3-marketing tropes: purple gradients, glassmorphism, gradient text, or buzzwords.
- **Don't** fall into corporate-fintech blandness or the generic-SaaS grid of interchangeable KPI tiles and big empty cards.
- **Don't** reskin DefiLlama or a generic trading-terminal clone.
- **Don't** soften data surfaces with mascots or chunky illustrations; keep the practitioner register inside the data.
- **Don't** give frost-blue (or any full-saturation accent) to controls, inactive states, the top-nav, or decoration.
- **Don't** put a resting drop shadow on a card, or nest a card inside a card.
- **Don't** use fluid `clamp()` headings (outside digest/editorial) or proportional figures in a data column.
- **Don't** reorder the homepage bands or introduce a new serif outside the authored editorial carve-out.
