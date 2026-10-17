---
name: Pharos
description: Stablecoin intelligence as a calm, dense instrument — a lighthouse that watches every peg.
colors:
  frost-blue: "#4bc4de"
  control-active: "oklch(0.91 0.005 260)"
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
    fontFamily: '"Bricolage Grotesque", system-ui, -apple-system, sans-serif'
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  headline:
    fontFamily: '"Bricolage Grotesque", system-ui, sans-serif'
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.18
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
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
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "normal"
  eyebrow:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.25
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
    backgroundColor: "{colors.surface-overlay}"
    rounded: "{rounded.xl}"
    padding: "20px"
  hero-metric:
    textColor: "{colors.text-primary}"
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
    backgroundColor: "{colors.control-active}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
    height: "36px"
---

# Design System: Pharos

## 1. Overview

**Creative North Star: "The Lighthouse Watch"**

A calm, dense instrument for crypto-native stablecoin research. Pharos earns trust through verifiable facts, precision and completeness. Discovery surfaces breathe; analytics keep a composed workbench; power-user surfaces compress. Light is the default, with the same hierarchy in dark mode.

**Brand mark vs. drawn identity.** The avatar-scale mark is a circular star/beacon emblem, not a miniature lighthouse. The drawn lighthouse/nautical identity remains part of the product. Do not reconcile these deliberately different scales of identity.

**Source of truth.** This is a compact, **hand-maintained** Impeccable mirror, not a generated artifact. [Design context](docs/design-language.md#context) owns intent; `src/styles/tokens/primitives.css`, `src/styles/tokens/semantic.css` and `src/app/globals.css` own implementation. Update this mirror when those owners change, retaining YAML frontmatter and the six named sections. Route docs own composition.

**Tooling deviation (owner decision 13).** `.impeccable/design.json` retains v2 extensions and self-contained component previews, but deliberately omits `narrative`: the live panel synthesizes it from this file. Do not restore that duplicate if using `/impeccable document`; reconcile proposed output manually rather than replacing this hand-maintained reference.

**Key Characteristics:**

- Light-default, full dark theme; one hierarchy in both.
- Frost-blue beam/brand emphasis, neutral chrome, semantic data colors.
- Flat surfaces at rest; mono tabular figures; fixed type scale.
- Global top navigation, full-width workbench, spacious/compact density.
- Color reinforced by structure, text or iconography.

## 2. Colors

### Primary

Frost-blue (`#4bc4de`) lights the primary chart stroke and drawn nautical identity. Methodology-family scrollspy and the mobile drawer have explicit navigation accents; the global top nav and detail pill tabs remain neutral.

### Secondary (data sequence)

Use `CHART_PALETTE` from `src/lib/chart-colors.ts` for sequences, never UI chrome.

### Tertiary (semantic state ramp)

Severity, PSI, DEWS and grades use their own published scales from `shared/lib/classification.ts`, not an interchangeable local ramp. Grade B is info-blue (`REPORT_CARD_GRADE_COLORS` / `REPORT_CARD_GRADE_RANGE_METADATA` in `shared/lib/classification/grades.ts`): sound, not top-tier. That grade exception is not a state-chip or control color.

### Neutral

Surfaces layer base → raised → overlay; borders supply separator hierarchy without resting shadows. Use text-role tokens and retain the informational contrast floor (`text-muted-foreground/70`); decorative marks are not a precedent for lighter text. Selected controls use elevated-neutral `--control-pill-active-bg` with primary text, never solid ink. Exact values and theme pairs belong to [Design Tokens](docs/design-tokens.md).

### Named Rules

**The One Beam Rule.** Frost-blue is selective signal, not decoration, a general background or a gradient. The Cemetery's drawn beam is the explicit gradient exception; that route uses frost on the recorded-deaths figure and beam only.

**The Semantic-Color Rule.** Saturation encodes a risk band, data series or the beam. Inactive controls never take a full-saturation accent; every state remains readable without color.

## 3. Typography

Bricolage Grotesque is the tracked display face (`--font-bricolage` → `--font-display`). UI uses the system sans; the legacy `--font-geist-sans` name does not load Geist. Figures use JetBrains Mono through `--font-geist-mono`.

Newsreader, Georgia and Courier are authored-editorial, Cemetery, AI-summary and route-error carve-outs, not general analytics fonts. The Cemetery drawing itself keeps sans signposts and mono figures; its Newsreader belongs to the heading, epitaphs and record cards. Licensed ABC Whyte files are local-only, never referenced by clean builds.

### Hierarchy

Use `.pharos-page-title` for route titles, `.pharos-display` / `.pharos-section-title` for section headings, the sans token for UI/body, and `.pharos-numeric` for figures. `.pharos-label` (legacy `.pharos-kicker`) is sentence-case sans with normal tracking. `.pharos-eyebrow` is the one uppercase register: at most one short route/hero eyebrow, with `tracking-eyebrow`. [Type scale](docs/design-tokens.md#type-scale) owns sizes and usage.

### Named Rules

**The Tabular-Figure Rule.** Data columns use `.pharos-numeric` with `tabular-nums slashed-zero`; proportional figures must not disturb alignment.

**The Three-Register Rule.** Core analytics uses Bricolage display, system sans labels/prose and JetBrains Mono figures. Mono does not carry labels or prose. Use scale utilities, not arbitrary pixel text sizes.

**The Fixed-Scale Rule.** Viewport changes layout, not heading size. Use fixed rem steps; digest/editorial display is the fluid-type carve-out. Bound long prose to 65–75ch.

## 4. Elevation

### Shadow Vocabulary

`semantic.css` owns the elevation values: `--elevation-rest` is a card-hover response, `--elevation-raised` serves overlays/chart tooltips, and `--elevation-featured` is for a deliberately promoted surface. Sticky table columns use their dedicated shadow, not the overlay token.

### Named Rules

**The Flat-By-Default Rule.** Cards rest as fill plus hairline border, without shadow. Depth responds to hover, overlay or explicit featured state. Never nest cards; use an unframed band or divider for inner hierarchy.

## 5. Components

Every interactive component needs default, hover, focus-visible, active, disabled and loading states. Reuse `src/app/globals.css` utilities and `src/components/ui/` primitives; route-local styling must not change low-level primitives.

### Navigation — Top Nav (signature; replaced the sidebar)

Desktop has a global top bar, neutral selected menu, global search and full-width content; never restore the left watch-column sidebar. `src/lib/nav-config.ts` owns menu contents. The mobile drawer owns its frost accent. Detail `LongformScrollspyNav` uses neutral pill tabs; methodology-family longform may use the frost-lit rail recipe.

### Cards (`.pharos-card-shell`)

Use the shared overlay fill, hairline border and `rounded-xl` shell. `.pharos-interactive-card` adds hover-only lift on hover-capable devices; pair focus treatment with `.pharos-focus-ring`. Accent stripes do not decorate card chrome; existing data-driven severity, hero-metric and notice indicators are explicit exceptions.

### Controls — Pills (`.pharos-control-pill`, `.pharos-toggle-pill`)

Compact controls use shared pill shells with a stable hit area, muted default text, primary hover text and visible keyboard focus. On/selected state uses `--control-pill-active-bg`, `--control-pill-active-text` and a hairline `--control-pill-active-ring`, never ink fill or frost. [Control Pills](docs/design-language.md#control-pills) owns primitive selection and pressed/group semantics.

### Tables (the workbench)

Compose `src/components/table/` primitives and shared table shells/toolbars. Figures align right and use mono; headers expose sorting, rows retain a keyboard path and nested links remain operable. Responsive autofit sheds low-priority columns with a visible reveal control, not inaccessible data. [Tables and Charts](docs/design-language.md#tables-and-charts) owns unavailable values, exports and raw-table exceptions.

### Inputs

Translucent fill, hairline border, shared radius and `.pharos-focus-ring`. Search belongs in the established toolbar/command-palette workflow; do not invent a route-local modal.

### Signature Surfaces & the Drawn Metaphor

Draw a metaphor only when every shape encodes a published field. Keep underlying exact data accessible and deterministic geometry separate from rendering. [Data Visualization](docs/data-visualization.md#scene-kit) owns the shared scene kit, encodings, equivalent data surfaces and reduced-motion rules.

### Homepage Composition (signature surface — the locked layout)

[Homepage](docs/homepage.md#route-shape) owns section order, responsive composition and density. Do not copy its route roster here or reorder its bands through a general design change. Hero figures are neutral ink unless a semantic scale or an explicit route exception supplies color.

### Motion

Motion conveys state, not page-load choreography. `semantic.css` owns timing/easing. Standard motion decelerates without overshoot; `--motion-ease-spring` is restricted to `.pharos-chip-animate-in` and `.pharos-grade-pop`. Every animation has a reduced-motion alternative that leaves all facts visible.

## 6. Do's and Don'ts

### Do:

- Use semantic tokens, shared classification scales and the fixed type hierarchy.
- Keep exact values, unknown states, freshness and methodology reachable.
- Draw only data-backed metaphors, with equivalent accessible information.
- Preserve keyboard access, visible focus, both themes and reduced motion.

### Don't:

- Use purple gradients, glassmorphism, gradient text or buzzword-driven Web3 marketing.
- Substitute corporate-fintech sterility, generic SaaS KPI grids, or a reskinned analytics clone for Pharos's authored workbench.
- Soften data with mascots or chunky illustrations; soften discovery layout instead.
- Decorate chrome with frost, colored side stripes, nested cards or resting shadows.
- Introduce serif outside authored carve-outs, fluid analytics headings or proportional data columns.
