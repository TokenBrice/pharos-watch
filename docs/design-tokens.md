# Design Token System

Pharos uses a 3-layer design token architecture that separates raw values from meaning from usage.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Component Tokens  (card, table, chart, sidebar) │  ← Components reference these
├─────────────────────────────────────────────────┤
│  Semantic Tokens   (surfaces, text, severity)    │  ← Purpose-driven aliases
├─────────────────────────────────────────────────┤
│  Primitives        (color scales, spacing, type) │  ← Raw, theme-agnostic values
└─────────────────────────────────────────────────┘
```

### Layer 1: Primitives (`src/styles/tokens/primitives.css`)

Raw values with no semantic meaning. Do not reference directly in components unless a documented local visualization intentionally needs a primitive ramp before a semantic token exists.

- **Color scales** — 9 hue families (neutral, blue, green, teal, amber, orange, red, purple, pink) plus the dedicated `--p-frost-blue` brand accent (`#4BC4DE`, sampled from Figma); scale stops run 50–900 in OKLch (red extends to 950; neutral runs 50–975 with additional 850/925/950/975 stops)
- **Spacing** — 4px-based scale from `--p-space-0` to `--p-space-20`, with `--p-space-0-5` (2px) and `--p-space-1-5` (6px) half steps for tight UI alignment
- **Typography** — Font sizes (`--p-text-3xs` to `--p-text-5xl`), line heights, tracking (see [Type scale](#type-scale))
- **Radius** — `--p-radius-none` to `--p-radius-full`. Usage rule: chips, pills, avatars and dots `rounded-full`; buttons, inputs, selects and other controls `rounded-md`; top-level cards, panels, shells and dialogs `rounded-xl`; surfaces nested inside a card or panel (callouts, inner tiles, notices, stat boxes) `rounded-lg`, one step below their parent; inline tags, badges, `kbd` and inline code `rounded-sm`; table, image and chart wrappers inherit their container.

Naming: `--p-{category}-{value}` (e.g., `--p-blue-500`, `--p-space-4`)

### Layer 2: Semantic Tokens (`src/styles/tokens/semantic.css`)

Purpose-driven aliases that map primitives to meaning. These switch between light and dark mode.

| Category            | Examples                                                                                                | Notes                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Surfaces            | `--surface-base`, `--surface-raised`, `--surface-overlay`                                               | Page bg, elevated cards, modals         |
| Text                | `--text-primary`, `--text-secondary`, `--text-tertiary`                                                 | Content hierarchy                       |
| Borders             | `--border-default`, `--border-subtle`, `--border-strong`                                                | Separator hierarchy                     |
| UI State            | `--state-{positive,warn,danger,info}-{text,text-bright,text-strong,text-ink,solid,subtle,border}`      | [UI state utilities](#ui-state-utilities) |
| Severity            | `--severity-healthy` through `--severity-severe`                                                        | Peg deviation bands                     |
| PSI Bands           | `--psi-bedrock` through `--psi-meltdown`                                                                | Stability index zones                   |
| DEWS Threat Bands   | `--dews-calm` through `--dews-danger`                                                                   | DEWS threat level zones                 |
| DEWS Radar Contrast | `--dews-radar-spoke`, `--dews-radar-calm-boundary`, `--dews-radar-*-opacity`, `--dews-radar-calm-dot-*` | Theme-aware radar ring/spoke visibility |
| Score Tiers         | `--score-green`, `--score-blue`, `--score-amber`, `--score-red`                                         | Liquidity/durability                    |
| Interactive         | `--interactive-hover`, `--interactive-active`, `--interactive-focus`, `--control-pill-*`               | UI states and dense control pills       |
| Chart               | `--chart-grid-opacity`, `--chart-fill-opacity`, `--chart-primary`, `--chart-stage-*`                   | Chart-specific theming and chart stages |
| Motion              | `--motion-duration-fast`, `--motion-duration-base`, `--motion-duration-slow`, `--motion-duration-entrance`, `--motion-ease-standard`, `--motion-ease-spring`, `--motion-ease-decelerate`, `--theme-transition-duration` | Shared transition timing and theme swap |

This table covers the categories referenced most often in product code, not the full set: `semantic.css` also defines brand (`--brand-accent`), featured and homepage-zone surfaces (`--surface-featured-*`, `--surface-zone-*`), risk alert states (`--risk-alert-*`), mechanism archetype accents (`--mechanism-*`), and the elevation system (`--elevation-rest`, `--elevation-raised`, `--elevation-featured`).

#### Light-Mode Contrast Baseline (March 2026)

- `--text-secondary` and `--text-tertiary` are intentionally darker in light mode than earlier revisions to keep metadata and helper text readable on pale surfaces.
- `--ring` is blue in both themes (`blue-500` light, `blue-400` dark) to keep keyboard focus visible against neutral backgrounds.
- For status/accent text in badges and KPI callouts, use the [UI state utilities](#ui-state-utilities) (`text-state-warn` is the former `text-amber-700 dark:text-amber-400` pair) rather than spelling a two-theme palette pair.
- Avoid unscoped `text-*-300` / `text-*-400` in app code unless the element only renders on dark-only surfaces.
- DEWS radar guide lines should stay theme-tuned via tokens (`--dews-radar-spoke`, `--dews-radar-calm-boundary`); dark mode requires visibly higher alpha than `0.04` to keep axis spokes readable.
- Dense interactive controls should use the `--control-pill-*` token family rather than ad-hoc translucent button backgrounds.
- Selected pills have one style: `.pharos-control-pill-active`, `.pharos-toggle-pill[data-state="on"]` and `.pharos-pill-tab-active` all paint `--control-pill-active-bg` (the `--interactive-active` neutral), `--control-pill-active-text` and a 1px `--control-pill-active-ring`. Never a solid ink fill, and never a `.dark` hex override (tokens carry both themes). Navigation keeps its own frost-lit `.pharos-rail-tab-active`.
- Secondary mode, view and window switches (dependency-map Explore/Exposure and Watershed/Network, the exposure workspace tabs, the watershed relationship filter, the home Freezes 24h/7d window) use `.pharos-segmented` with `.pharos-segmented-item` children: one bordered track, selection from `aria-pressed` / `aria-selected`, painted with the shared active tokens. `ControlPillToggle` renders it with `variant="segmented"`.
- `--table-header-top` is the bottom edge of the sticky site chrome (60px for the 768–1023px header, 59px for the lg+ TopNav, 56px on phones); sticky table headers pin there and `scroll-padding-top` uses it.
- Stacking uses the named layers from the `@theme` block in `globals.css`, lowest first: `z-chrome` (sticky desktop header, floating page controls), `z-chrome-dock` (mobile bottom nav), `z-chrome-header` (mobile header), `z-progress` (route progress bar, just under the regime line), `z-regime` (PSI regime line and its panel), `z-modal` (dialogs, sheets, popovers, dropdowns, tooltips) and `z-toast` / `z-skip`. New fixed or portalled surfaces pick a layer instead of a numeric `z-[…]`.
- Dedicated chart stages should use the `--chart-stage-*` token family so chart canvases stay visually distinct from the outer card shell.

#### UI state utilities

UI and operational state (ok, warning, error, informational: job status, stale/degraded pills, notice banners, validation, toasts) uses one vocabulary, defined once in `semantic.css` with `light-dark()` and exposed as Tailwind utilities at the end of that file. Values are the Tailwind palette stops the product previously spelled by hand, so a migrated class renders identically.

| Tone | Hue | Typical use |
| --- | --- | --- |
| `positive` | emerald | succeeded, healthy, verified |
| `warn` | amber | stale, degraded, needs review, caution banners |
| `danger` | red | failed, error, unavailable |
| `info` | sky | running, pending, provisional, informational |

| Utility | Light / dark value | Replaces |
| --- | --- | --- |
| `text-state-{tone}` | 700 / 400 | `text-X-700 dark:text-X-400` |
| `text-state-{tone}-bright` | 700 / 300 | `text-X-700 dark:text-X-300` (text on a tint) |
| `text-state-{tone}-strong` | 800 / 200 | `text-X-800 dark:text-X-200` (callout body copy) |
| `text-state-{tone}-ink` | 950 / 100 | `text-X-950 dark:text-X-100` (callout heading/ink) |
| `bg-state-{tone}-subtle` | 500 at 10% | `bg-X-500/10` |
| `border-state-{tone}` | 500 at 30% | `border-X-500/30` |
| `{bg,border,border-l,text,fill,stroke,ring,…}-state-{tone}-solid[/N]` | 500 | `bg-X-500`, `bg-X-500/15`, `border-X-500/25`, `border-l-X-500/70` … |

- The `-solid` colour is a theme colour (`--color-state-{tone}-solid`), so it takes any utility and opacity modifier; the other roles are fixed utilities without modifiers.
- Neutral state keeps the existing neutral tokens (`text-muted-foreground`, `bg-muted/30`, `border-border/60`). `SEVERITY_TONE_CLASS` in `src/lib/severity-tone.ts` composes these utilities for pill/banner/text/bar slots.
- State utilities are not for classification scales. A colour chosen by a data band, grade, tier or category (peg-deviation severity, score tiers, PSI/DEWS bands, chain health, coverage/feature palettes, mechanism or event categories) belongs to `shared/lib/classification.ts` or the documented engine that owns it (`src/lib/severity-colors.ts`).
- `light-dark()` resolves against `color-scheme`: `:root` sets `light` and `.dark` sets `dark` (next-themes also sets it inline on `<html>`). A subtree with its own `color-scheme` (the Telegram mini-app follows the Telegram theme) resolves these tokens against that scheme, not the `.dark` class.
- ESLint `pharos/no-raw-palette-colour` bans raw palette colour classes (`text-amber-700`, `bg-red-500/10`, `border-l-sky-500/70` …) in `src/components/`, `src/app/` and `src/lib/`, except the editorial carve-outs (cemetery, digest, timeline/tape, blog, depeg event briefings, AI summaries, error/404 pages, the Daily Digest card), the Telegram mini-app (own `color-scheme`) and the flow-machine illustrations. Classification scales (grades, bands, deviation ramps, chain health, feature identity, provenance, score tiers…) live as static class maps in `shared/lib/classification/`, which the rule does not lint; import them rather than re-spelling hues. The remaining exact-shade leftovers with no faithful token are grandfathered per file in `eslint-suppressions.json`, under the same ratchet as the type-scale rule.

#### Hex Companion Variables

DOM SVG and Recharts paths rendered by the browser can use CSS variables. Literal values remain necessary for JS/runtime or external-renderer paths that cannot resolve the CSS cascade. Selected semantic status/chart colors have `-hex` companions when CSS and those non-CSS consumers both need the same token:

```css
--psi-bedrock: var(--p-green-500); /* CSS usage */
--psi-bedrock-hex: #22c55e; /* JS/Recharts usage */
```

Chart accent literals in `chart-colors.ts` match `--chart-*-hex`. Its re-exported `THREAT_BAND_HEX` uses the shared classification palette, not theme-switched `--dews-*-hex`. `severity-colors.ts` emits Tailwind classes; severity hex companions are consumed directly through CSS. Runtime exports do not each have a CSS companion.

### Layer 3: Component Tokens (in `semantic.css`)

Scoped to specific UI components. Optional — use when a component needs tokens that don't map cleanly to general semantic categories.

- **Card** — `--card-bg`, `--card-border`, `--card-shadow`, `--card-shadow-hover`, `--card-shell-bg`, `--card-shell-highlight`, `--panel-header-bg`
- **Table** — `--table-header-bg`, `--table-row-hover`, `--table-row-stripe`, `--table-border`, `--table-header-shadow`, `--table-sticky-column-*`
- **Code surface** — `--code-surface-bg`, `--code-surface-fg`, `--code-surface-muted`, `--code-surface-border` (terminal code blocks stay deliberately dark in both themes)

## Type scale

The `--p-text-*` primitives are the single source for Tailwind's `text-*` sizes: a `@theme` block in `globals.css` maps each one, so `text-xs` and `var(--p-text-xs)` cannot drift.

| Utility | Size | Line height | Use |
| --- | --- | --- | --- |
| `text-3xs` | 10px | 14px | Dense chart, legend and axis annotations only |
| `text-2xs` | 11px | 16px | Compact chips, table meta, uppercase eyebrows |
| `text-xs` | 12px | 16px | Labels (`.pharos-label`), captions, `.pharos-meta` |
| `text-sm` | 14px | 20px | Body and UI text |
| `text-base` … `text-5xl` | 16–48px | Tailwind defaults | Titles and display (`.pharos-section-title`, `.pharos-page-title`) |

- Arbitrary pixel sizes (`text-[11px]`, `sm:text-[10.5px]`) are banned in `src/components/` and `src/app/` by the ESLint rule `pharos/no-arbitrary-text-px`. Existing call sites are grandfathered per file in the root `eslint-suppressions.json` (ESLint bulk suppressions: a per-file count ratchet). A new violation fails `npm run lint`; after removing some, run `npx eslint src/app src/components --prune-suppressions` so the baseline only shrinks. Never add entries by hand or re-run `--suppress-rule` to absorb new violations.
- Map `text-[10px]` → `text-3xs`, `text-[11px]` → `text-2xs`, `text-[12px]` → `text-xs`, `text-[13px]` / `text-[15px]` → the nearest step (`text-xs`/`text-sm`, `text-sm`/`text-base`) unless a tight cell layout needs a reviewed exception. `text-[clamp(...)]` and rem display sizes on editorial/hero titles stay legal.
- One positive tracking step exists: `tracking-eyebrow` (`--p-tracking-eyebrow`, 0.08em), for uppercase eyebrows only. Sentence-case labels use normal tracking; titles use `tracking-tight`.

### Label and figure utilities

| Utility | Face | Treatment | Use |
| --- | --- | --- | --- |
| `.pharos-label` | sans | 12px, 600, sentence case, muted, normal tracking | Section labels, card kickers, stat/field labels (`dt`), group headings |
| `.pharos-kicker` | — | Legacy name of `.pharos-label` (same rule) | Rename to `.pharos-label` when touched |
| `.pharos-eyebrow` | sans | 11px, 600, UPPERCASE, `tracking-eyebrow`, muted | At most one short route/hero eyebrow above a title |
| `.pharos-numeric` | JetBrains Mono | `tabular-nums slashed-zero` | Figures, tickers, addresses, codes, timestamps |

Labels never use mono; mono never carries a label or prose. Write label strings in sentence case in source ("Top contributors", not "TOP CONTRIBUTORS" or "Top Contributors"); acronyms and tickers keep their capitals.

`.pharos-page-title`, `.pharos-display` and `.pharos-section-title` set `text-wrap: balance`; `.pharos-lead`, `.pharos-page-lead` (18–20px editorial subtitle) and `.pharos-page-deck` (16px deck under every `FeaturePageShell` H1) set `text-wrap: pretty`.

## Bridge Layer (`src/app/globals.css`)

Existing shadcn/ui variables (`--background`, `--card`, `--foreground`, etc.) are wired to semantic tokens through a bridge layer in `globals.css`. This means:

- All existing components continue working without changes
- Migration is gradual — new code uses semantic tokens, old code works through the bridge
- shadcn/ui primitives in `src/components/ui/` should **not** be edited to use tokens directly
- Bridge-level visual polish (page glow backgrounds and slot-based transition/elevation defaults) is centralized in `globals.css`
- Shared layout-safe variables that are not semantic theme tokens, such as `--mobile-utility-safe-offset`, also live in `globals.css` because they coordinate app-shell spacing rather than color or component semantics

```css
/* Bridge: shadcn var → semantic token */
:root {
  --background: var(--surface-base);
  --foreground: var(--text-primary);
  --card: var(--surface-overlay);
  --border: var(--border-default);
  /* ... */
}
```

## Utilities

Authored shell utilities live in `src/app/globals.css` under `@layer components`. They are not tokens (they consume tokens through `@apply` + `var(...)`), but they are referenced often enough from product code to be worth indexing here:

- `pharos-control-pill` — canonical small-control shell (`src/app/globals.css`). Use for time-range controls, density toggles, lens pills, hero tertiary chips, scrollspy pills, and any dense secondary action surface. See [`design-language.md`](design-language.md#control-pills) for the visual contract.

Label and figure utilities are indexed under [Type scale](#label-and-figure-utilities). Other shared utilities (`pharos-card-shell`, `pharos-focus-ring`, `pharos-interactive-card`, `pharos-chart-stage`, `pharos-table-shell`, etc.) are catalogued in [`design-language.md`](design-language.md#shared-utility-classes).

## JS Token Maps

For colors needed at JS runtime (Recharts, canvas, dynamic styles):

| File                         | Exports                                                                     | Purpose                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/chart-colors.ts`    | `CHART_PALETTE`, `CHART_BLUE`, `CHART_GREEN`, `CHART_ORANGE`, `CHART_RED`, `CHART_SLATE`, `CHART_SLATE_SOFT`, `CHART_SLATE_STRONG`, `CHART_AMBER`, `CHART_TEAL`, `CHART_HEIGHT`, `RECHARTS_TOOLTIP_STYLES` | Shared chart fill/stroke colors, chart-height utility, and tooltip styles (also has module-private `TOKEN` map) |
| `src/lib/severity-colors.ts` | `deviationColorClass()`, `deviationBorderClass()`, `deviationBgClass()`, `deviationIconName()`, `TIER_TEXT` / `TIER_PILL`, `getScoreTier()`, `getScoreColor()`, `pegScoreColor()`, `getDurabilityColor()` | Peg-deviation and score-tier Tailwind class helpers (text classes are light/dark aware) |
| `shared/lib/classification.ts` | `EVENT_LABELS`, `EVENT_BADGE_STYLES`, `EVENT_CHART_COLORS` | One freeze-event descriptor projects badge styles, labels, and solid chart fills (Freeze/red, Release/emerald, Wipe/amber); overview and detail charts share it in both themes |

`chart-colors.ts` uses the same hex values as the `--chart-*-hex` CSS custom properties in `semantic.css`; `severity-colors.ts` emits Tailwind class strings only. Some runtime-only exports, such as signal colors and brand helpers, live only in the JS maps.

## Usage Guidelines

### Do

- Reference semantic tokens in CSS/Tailwind: `var(--surface-base)`, `var(--text-secondary)`
- Import `chart-colors.ts` or shared classification palettes for Recharts colors; `severity-colors.ts` supplies Tailwind classes.
- Use the bridge vars (`--background`, `--card`, etc.) in existing code — no rush to migrate
- Add new component tokens to `semantic.css` when needed

### Don't

- Reference primitives (`--p-blue-500`) directly in components, except when a documented local visualization intentionally needs a primitive ramp before a semantic token exists
- Hardcode hex values in chart components — use the runtime maps (`PEG_BAND_HEX` belongs to `shared/lib/classification.ts`). The market-cap delta colors in `src/components/mcap-chart.tsx` are an intentional local exception.
- Edit shadcn/ui primitives in `src/components/ui/` to use tokens
- Define one-off color variables in individual component files. Exception: isometric scenes keep a local atmospheric layer in `src/components/scene/scene-tokens.module.css` (sea, earth, rock, the lighthouse, hairlines, light and dark), plus each scene's art direction. These tokens encode materials, never data ([Data Visualization: Scene Kit](./data-visualization.md#scene-kit)).

### Adding a New Token

1. If it's a raw color/spacing value → add to `primitives.css`
2. If it maps a primitive to a purpose → add to `semantic.css` `:root`, using `light-dark(light, dark)` for a colour that differs by theme (a `.dark` override only for non-colour values such as shadows, gradients or opacities)
3. If a non-CSS chart/runtime consumer needs it → add a `-hex` companion in `semantic.css` AND update the JS token map
4. If it's scoped to one component type → add as a component token in `semantic.css`
