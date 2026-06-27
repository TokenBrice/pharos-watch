---
name: Pharos
description: Stablecoin intelligence as a quiet, neutral instrument — monochrome by default, color only where it carries signal.
colors:
  accent-purple: "#8e4ec6"
  info-blue: "#0090ff"
  surface-base: "#fcfcfc"
  surface-raised: "#ffffff"
  surface-sunken: "#f0f0f0"
  text-primary: "#202020"
  text-secondary: "#646464"
  text-muted: "#8d8d8d"
  border-default: "#00000014"
  border-subtle: "#0000000d"
  status-success: "#30a46c"
  status-alert: "#ffe629"
  status-warning: "#f76b15"
  status-danger: "#e5484d"
typography:
  display:
    fontFamily: "Bricolage Grotesque, system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
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
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.08em"
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
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.xl}"
    padding: "20px"
  metric-primary:
    textColor: "{colors.info-blue}"
    typography: "{typography.numeric}"
  numeric-cell:
    textColor: "{colors.text-primary}"
    typography: "{typography.numeric}"
  pill:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
    height: "36px"
  pill-active:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.surface-base}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
    height: "36px"
  badge-category:
    textColor: "{colors.accent-purple}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
---

# Design System: Pharos

## 1. Overview

**Creative North Star: "The Quiet Instrument"**

Pharos is a precision instrument for crypto-native practitioners — a Bloomberg Terminal scoped to stablecoins. The interface is **monochrome by default**: a neutral Radix-gray field where the chrome recedes and the data leads. Color is rationed and it always means something — a Radix **status** hue (peg health, risk, trend), the **info-blue** that marks the primary live metrics, or a **quiet purple** categorical tag. Nothing is colored for decoration. The mood is calm authority: composed in the steady state, sharper only when a risk signal fires.

This system was rebuilt from a professional designer's Figma against a real Radix-based component library (Card / Button / Table / Badge / Form / SegmentedControl / Dropdown). It is **light-default** with a full dark theme. Headings carry an ink-trap display face (Bricolage Grotesque, standing in for the design's commercial ABC Whyte Inktrap) on editorial and section moments; the dense UI runs on Geist; every digit is JetBrains Mono with tabular figures and a slashed zero. Navigation is a **global top-nav with full-width content** — there is no sidebar. Density is a two-mode toggle (spacious default, compact), calibrated further by surface tier: discovery breathes, analytics holds default, power-user tables compress.

It explicitly rejects the Web3-marketing aesthetic (purple *gradients*, glassmorphism, buzzwords), corporate-fintech blandness, and the generic-SaaS dashboard of interchangeable KPI tiles. Cards are flat. Accents are semantic.

**Source of truth.** This file is faithful to the **Figma redesign + owner decisions (2026-06-27)** — the design source of truth — and is the machine-readable mirror for AI agents generating screens. The canonical human-facing rationale lives in `docs/design-context.md` (canonical), `docs/design-language.md`, and `docs/design-tokens.md`. The Figma inventory and token extraction live in `agents/figma-redesign/` (`README.md`, `frames/`, `refs/`). Regenerate this file (`/impeccable document`) when the Figma or the homepage composition changes.

**Known code divergences (migration punch-list — code → Figma).** The live tokens in `src/styles/tokens/*.css` have not finished migrating; this spec describes the target, and the gaps below are the work to close:
- **Accent token:** code still ships `--brand-accent`/`--chart-primary` = frost-blue `#4bc4de`; Figma retires the frost-blue "lighthouse" identity. Primary metrics should resolve to **info-blue** (`#0090ff` / `#70b8ff` on dark); neutralize the brand accent and reintroduce **purple** (`#8e4ec6`) as the categorical tag.
- **Status hues:** code uses Tailwind hexes (`#22c55e`/`#f97316`/`#ef4444`); migrate to **Radix** (`#30a46c`/`#f76b15`/`#e5484d`, plus yellow `#ffe629`). Badge fills move to ~16% alpha tints; route Grade/Type recolors through `shared/lib/classification.ts`.
- **Dead lighthouse CSS:** `pharos-lighthouse-sweep`, `pharos-nav-beam`, `pharos-rail-tab-active`, `pharos-brand-beam`, the "watch column" sidebar rules — the sidebar is removed; these are unrendered and should be trimmed.

**Key Characteristics:**
- Monochrome neutral base (Radix gray); color appears only as status, the primary metric, or a categorical tag.
- Global top-nav, full-width content. No sidebar.
- Flat cards: fill + hairline border, no resting shadow. Depth is a hover response.
- Mono + tabular + slashed-zero on every digit-bearing cell.
- Fixed rem type scale (10/12/14/16/18/20/24/32/36/40/48/56); two-mode density (spacious / compact).
- Color is reinforced with structure and iconography; never the sole signal.

## 2. Colors

A near-monochrome Radix-gray field with rationed, always-semantic accents. Three accent jobs: **status** (the risk/health ramp), **info-blue** (primary live metrics), and **purple** (a minor categorical tag).

### Primary (semantic accents)
- **Info Blue** (`#0090ff`, on-dark `#70b8ff`): The primary live-metric signal — Total Market Cap and the Stability Index reading/sparkline. Radix info; used where a single headline number must read as "the live pulse." Not a brand fill, not a gradient.
- **Quiet Purple** (`#8e4ec6`, purple-10 `#8145b5`, on-dark `#d19dff`): A *minor* categorical accent — readiness stages (the "Auditing" horizon cluster), the active Chart-Your-Route entry card, and select category tags. Never global chrome, never a CTA, never a gradient. Badge fills use a ~16% alpha tint.

### Status ramp (Radix)
The peg-health / risk vocabulary. Each maps to a named band (Severity, PSI, DEWS, Score tiers) and ships an on-dark twin.
- **Good** (`#30a46c`, on-dark `#3dd68c`) · **Alert** (`#ffe629` / `#f5e147`) · **Warning** (`#f76b15`, on-dark `#ffa057`) · **Danger** (`#e5484d`, on-dark `#ff9592`). The Peg Health bar reads GOOD → ALERT → WARNING → DANGER across these four.

### Neutral
- **Ink** (`#202020`, dark `#ffffff`/`#eeeeee`): Primary text.
- **Secondary / Muted Ink** (`#646464` / `#8d8d8d`): Labels, captions, metadata. Informational text never goes below the muted floor (WCAG 1.4.3).
- **Surfaces** — Base (page, `#fcfcfc`; dark `#0f0f0f`/`#111111`), Raised (cards & panels, `#ffffff`; dark `#202020`), Sunken (table headers, control wells, `#f0f0f0`).
- **Borders** — black @ 5–12% on light (`#0000000d`–`#00000014`); white @ 6–12% on dark. A hairline hierarchy carries most structure in a shadowless system.

### Named Rules
**The Monochrome-Default Rule.** The interface is neutral. A color only appears if it is carrying a status, the primary metric, or a categorical tag. If an element is saturated for any other reason, it's wrong.

**The Quiet-Purple Rule.** Purple is a categorical accent at the edges (readiness, the active entry card, category tags) — never the page's chrome, never a button fill, never a gradient. Its restraint is the point; a purple-forward Pharos reads as the Web3-marketing template it rejects.

**The Semantic-Status Rule.** The Radix status ramp encodes state only. Inactive states never take a full-saturation hue; badges sit on ~16% alpha tints and route through `shared/lib/classification.ts`.

## 3. Typography

**Display Font:** Bricolage Grotesque (variable, ink-trap; fallback `system-ui`) — stands in for the Figma's commercial ABC Whyte Inktrap. Editorial and display moments: the wordmark, "Daily Digest," section headers.
**Body / UI Font:** Geist (medium / semibold; fallback `system-ui` stack) — body, UI, controls, and large numerals.
**Data Font:** JetBrains Mono (variable; fallback `SFMono-Regular, ui-monospace`) — table figures, data labels, mono captions. Folded into `--font-geist-mono`, so every mono consumer inherits it.

**Character:** A three-face system on a clear contrast axis — an ink-trap grotesque for display weight, a neutral grotesque sans for the dense UI, and a precise mono for figures. The authored-editorial serif register (Newsreader / Georgia) is a deliberate carve-out (the `/digest/` broadsheet, the Daily Digest card, Cemetery plaques, detail-page AI summaries) — never general analytics.

### Hierarchy
Fixed rem scale: 10/12/14/16/18/20/24/32/36/40/48/56 with matched line-heights.
- **Display** (Bricolage, 800, ~2–2.5rem, line-height 1.05, tracking −0.02em): Page/route titles, wordmark.
- **Headline** (Bricolage, 700, 1.5rem, tracking −0.01em): Section titles — "Market Pulse", "Stablecoin Overview", "On The Horizon".
- **Title** (Geist, 600, 1.125rem): Card and panel headings.
- **Body** (Geist, 400, 0.875rem, line-height 1.5): UI text and prose. Cap prose at 65–75ch; dense tables run denser.
- **Numeric** (JetBrains Mono, 500, `tabular-nums slashed-zero`): Every digit-bearing cell — prices, bps, percentages, market caps, scores.
- **Label / Kicker** (JetBrains Mono, 500, 0.6875–0.75rem, often UPPERCASE, tracking ~0.08em, muted): Data-group eyebrows (MARKET COHORTS, SUPPLY UP).

### Named Rules
**The Tabular-Figure Rule.** Numbers always use the mono face with `tabular-nums slashed-zero`. Proportional digits in a data column are a bug — columns align on the decimal; the zero never reads as an O.

**The Fixed-Scale Rule.** Headings use the fixed rem scale, not fluid `clamp()`. A heading that shrinks inside a panel looks worse, not designed. The viewport changes layout, not type size.

## 4. Elevation

Flat by default. Cards are a fill plus a 1px hairline with **no resting shadow**; structure is carried by the border hierarchy and tonal surface layering (Base → Raised → Sunken), not drop shadows. The Figma defines a small shadow vocabulary used only on state and frosted chrome.

### Shadow & Effect Vocabulary
- **Shadow x-small** (`shadow-universal/x-small`): Card hover, paired with a −2px lift.
- **Shadow medium** (`shadow-universal/medium`): Dropdowns, popovers, the Columns menu.
- **Background blur** (`background-blur`): Reserved for frosted chrome — the sticky top-nav / overlays. Purposeful, never a decorative glass card.
- **Device frame** (`shadow-component/device-frame`): Marketing/device mockups only.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow appears only as a response to state — hover, an overlay, or a deliberately featured block. A card with a drop shadow sitting still is wrong. Nested cards are forbidden.

## 5. Components

Lead with character, then spec. Every interactive component ships its full state set (default, hover, focus-visible, active, disabled, loading) and a `prefers-reduced-motion` alternative.

### Top Navigation (signature — replaces the sidebar)
A single global top bar; content runs full-width beneath it.
- **Contents:** brand mark · six dropdown menus (Terminal / Track / Monitor / Analyze / Docs / Resources, sourced from `nav-config.ts`) · global Search (⌘K, `openCommandPalette()`) · theme toggle (dark · light · system) · overflow menu (Telegram Bot / What's New / health status).
- **Behavior:** sticky, frosted (`background-blur`), hairline bottom border. A secondary **stat rail** sticks below it — Tracked · Active · Pegs · Chains plus recent-event labels.
- **Mobile:** the `header.tsx` drawer. **No sidebar, no lighthouse beam, no active-route wash** — that identity is retired.

### Cards
- **Corner Style:** Gently curved (`rounded-xl`, 12px).
- **Background:** Raised white (`surface-raised`); flat `#202020` block in dark.
- **Border:** 1px hairline (black ~8% / white ~12%).
- **Shadow Strategy:** None at rest; hover lifts −2px with `shadow-universal/x-small` (gated to `@media (hover: hover)`).
- **Internal structure:** hairline dividers, not nested cards.

### Controls — Pills, Segmented Control, Dropdowns
Controls stay neutral; purple and info-blue never enter them.
- **Pill / chip:** `rounded-full`, 1px border, `px-3 py-2`, min-height 36px, muted text. Hover → primary ink. **Active/selected:** near-black ink fill, inverse text, transparent border — a quiet confident state.
- **Segmented control:** the density toggle (spacious / compact) and similar two-/three-way switches.
- **Dropdown / menu:** the Columns selector and nav menus — `shadow-universal/medium`, hairline border. Plus a plain **Export CSV** button.

### Badges
- **Style:** status or category text on a ~16% alpha tint of its own hue; `rounded-sm`. Grade/Type colors come from `shared/lib/classification.ts`.
- **Prohibited:** `border-left`/`border-right` accent stripes (retired app-wide) — depth comes from the tint + full hairline.

### Tables (the workbench)
- **Shell:** `rounded-xl`, hairline border, no shadow.
- **Toolbar:** search · density toggle (spacious/compact) · Columns dropdown · Export CSV, on the sunken header fill.
- **Rows:** subtle stripe, hover to the interactive-hover tint; sticky first column; right-aligned mono figures. Pagination (Previous / Next, "Showing 1–20 of N"). A **Browse By Peg** facet strip sits beneath.

### Inputs
- **Style:** translucent fill on the sunken surface, hairline border, `rounded`. Search is inline in the toolbar — no modal.
- **Focus:** a 2px ring with a 2px background offset on `focus-visible`, on every interactive element including table rows.

### Signature Surfaces
- **Market Pulse hero:** split panel — Total Market Cap as the **info-blue** `metric-primary` + Market-Cohorts list on the left; live cohort area chart on the right (cohort colors: USDT green, USDC blue, USDS+DAI orange, Others purple).
- **Stability Index card:** standalone PSI reading ("92.48 · Steady") with an info-blue sparkline.
- **On The Horizon:** readiness clusters (Announced / Testnet / Auditing / Beta / Launching); **Auditing reads purple**.
- **Chart Your Route:** rotating entry-point cards; the active card takes the **purple** categorical accent.

### Homepage Composition (signature surface — the locked layout)
The homepage is an ordered workbench. Sections, order, and rhythm are the contract; below-fold bands lazy-mount but the **sequence is fixed**:
1. **Market Pulse** — info-blue total market cap + cohorts + live chart.
2. **Pulse band (bento)** — Row 1: Peg Health · (Stability Index + Mint/Burn stacked) · Daily Digest (editorial serif promo); Row 2: Biggest Supply Moves · Recent Freezes (24h/7d) · Total Active Depegs.
3. **Shortcuts** — saved entry chips + Edit (localStorage, per-device).
4. **Stablecoin Overview** — the directory table + Browse By Peg.
5. **On The Horizon** — readiness constellation.
6. **Chart Your Route** — rotating discovery cards.

Vertical rhythm: `space-y-5`/`6` within bands, `mt-5`/`6`/`8`/`10` between them; bento gaps `gap-3` (12px); panels pad 20–28px.

### Motion
Fast/State `160ms`, base `220ms`; standard easing `cubic-bezier(0.22, 1, 0.36, 1)` (decelerating; no bounce/elastic). Motion conveys state — hover lift, selection, menu open, chip enter/exit — never page-load choreography. Every keyframe has a `prefers-reduced-motion: reduce` alternative.

## 6. Do's and Don'ts

### Do:
- **Do** keep the interface monochrome (Radix gray); spend color only on status, the primary metric (info-blue), or a categorical purple tag.
- **Do** use the Radix status ramp — Good `#30a46c` · Alert `#ffe629` · Warning `#f76b15` · Danger `#e5484d` (+ on-dark twins) — with badges on ~16% alpha tints, routed through `shared/lib/classification.ts`.
- **Do** keep purple minor and categorical (readiness, active entry card, category tags), flat, never a CTA.
- **Do** render every digit with JetBrains Mono + `tabular-nums slashed-zero`.
- **Do** keep cards flat: `surface-raised` fill + 1px hairline, no resting shadow; lift only on hover.
- **Do** use the global top-nav with full-width content; keep the fixed rem type scale and the two-mode density (spacious / compact).
- **Do** gate every animation behind `prefers-reduced-motion`.

### Don't:
- **Don't** reintroduce frost-blue `#4bc4de` as a brand accent, or the lighthouse beam / "watch column" sidebar — that identity is retired.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe (retired app-wide).
- **Don't** ship Web3-marketing tropes: purple **gradients**, glassmorphism cards, gradient text, or buzzwords. (Purple as a flat categorical tag is fine; purple as chrome or gradient is not.)
- **Don't** fall into corporate-fintech blandness or the generic-SaaS grid of interchangeable KPI tiles.
- **Don't** reskin DefiLlama or a generic trading-terminal clone.
- **Don't** soften data surfaces with mascots or chunky illustrations.
- **Don't** give info-blue or purple to controls, inactive states, or decoration.
- **Don't** put a resting drop shadow on a card, or nest a card inside a card.
- **Don't** use fluid `clamp()` headings or proportional figures in a data column.
- **Don't** reorder the homepage bands, or introduce a new serif outside the authored editorial carve-out.
