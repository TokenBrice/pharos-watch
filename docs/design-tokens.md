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
- **Typography** — Font sizes (`--p-text-xs` to `--p-text-5xl`), line heights, tracking
- **Radius** — `--p-radius-none` to `--p-radius-full`

Naming: `--p-{category}-{value}` (e.g., `--p-blue-500`, `--p-space-4`)

### Layer 2: Semantic Tokens (`src/styles/tokens/semantic.css`)

Purpose-driven aliases that map primitives to meaning. These switch between light and dark mode.

| Category            | Examples                                                                                                | Notes                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Surfaces            | `--surface-base`, `--surface-raised`, `--surface-overlay`                                               | Page bg, elevated cards, modals         |
| Text                | `--text-primary`, `--text-secondary`, `--text-tertiary`                                                 | Content hierarchy                       |
| Borders             | `--border-default`, `--border-subtle`, `--border-strong`                                                | Separator hierarchy                     |
| Severity            | `--severity-healthy` through `--severity-severe`                                                        | Peg deviation bands                     |
| PSI Bands           | `--psi-bedrock` through `--psi-meltdown`                                                                | Stability index zones                   |
| DEWS Threat Bands   | `--dews-calm` through `--dews-danger`                                                                   | DEWS threat level zones                 |
| DEWS Radar Contrast | `--dews-radar-spoke`, `--dews-radar-calm-boundary`, `--dews-radar-*-opacity`, `--dews-radar-calm-dot-*` | Theme-aware radar ring/spoke visibility |
| Score Tiers         | `--score-green`, `--score-blue`, `--score-amber`, `--score-red`                                         | Liquidity/durability                    |
| Interactive         | `--interactive-hover`, `--interactive-active`, `--interactive-focus`, `--control-pill-*`               | UI states and dense control pills       |
| Chart               | `--chart-grid-opacity`, `--chart-fill-opacity`, `--chart-primary`, `--chart-stage-*`                   | Chart-specific theming and chart stages |
| Motion              | `--motion-duration-fast`, `--motion-duration-base`, `--motion-duration-slow`, `--motion-duration-entrance`, `--motion-ease-standard`, `--motion-ease-spring`, `--motion-ease-decelerate`, `--theme-transition-duration` | Shared transition timing and theme swap |

#### Light-Mode Contrast Baseline (March 2026)

- `--text-secondary` and `--text-tertiary` are intentionally darker in light mode than earlier revisions to keep metadata and helper text readable on pale surfaces.
- `--ring` is blue in both themes (`blue-500` light, `blue-400` dark) to keep keyboard focus visible against neutral backgrounds.
- For semantic status/accent text classes used in badges and KPI callouts, use the two-theme pattern:
  - `text-*-700 dark:text-*-400`
- Avoid unscoped `text-*-300` / `text-*-400` in app code unless the element only renders on dark-only surfaces.
- DEWS radar guide lines should stay theme-tuned via tokens (`--dews-radar-spoke`, `--dews-radar-calm-boundary`); dark mode requires visibly higher alpha than `0.04` to keep axis spokes readable.
- Dense interactive controls should use the `--control-pill-*` token family rather than ad-hoc translucent button backgrounds.
- Dedicated chart stages should use the `--chart-stage-*` token family so chart canvases stay visually distinct from the outer card shell.

#### Hex Companion Variables

DOM SVG and Recharts paths rendered by the browser can use CSS variables. Literal values remain necessary for JS/runtime or external-renderer paths that cannot resolve the CSS cascade. Selected semantic status/chart colors have `-hex` companions when CSS and those non-CSS consumers both need the same token:

```css
--psi-bedrock: var(--p-green-500); /* CSS usage */
--psi-bedrock-hex: #22c55e; /* JS/Recharts usage */
```

The JS-side token maps in `chart-colors.ts` and `severity-colors.ts` use those same hex values where CSS companions exist. `chart-colors.ts` also exports palette, risk, signal, and brand colors that are JS-only and do not have one CSS companion per export.

### Layer 3: Component Tokens (in `semantic.css`)

Scoped to specific UI components. Optional — use when a component needs tokens that don't map cleanly to general semantic categories.

- **Card** — `--card-bg`, `--card-border`, `--card-shadow`, `--card-shadow-hover`, `--card-shell-bg`, `--card-shell-highlight`, `--panel-header-bg`
- **Table** — `--table-header-bg`, `--table-row-hover`, `--table-row-stripe`, `--table-border`, `--table-header-shadow`, `--table-sticky-column-*`

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

Other shared utilities (`pharos-card-shell`, `pharos-kicker`, `pharos-focus-ring`, `pharos-interactive-card`, `pharos-chart-stage`, `pharos-table-shell`, etc.) are catalogued in [`design-language.md`](design-language.md#shared-utility-classes).

## JS Token Maps

For colors needed at JS runtime (Recharts, canvas, dynamic styles):

| File                         | Exports                                                                     | Purpose                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/chart-colors.ts`    | `CHART_PALETTE`, `CHART_BLUE`, `CHART_GREEN`, `CHART_ORANGE`, `CHART_RED`, `CHART_SLATE`, `CHART_AMBER`, `CHART_TEAL`, `CHART_HEIGHT`, `RECHARTS_TOOLTIP_STYLES` | Shared chart fill/stroke colors, chart-height utility, and tooltip styles (also has module-private `TOKEN` map) |
| `src/lib/severity-colors.ts` | `deviationColorHex()`, `deviationColorClass()`, tier helpers                | Peg-deviation and score-tier helpers (text classes are light/dark aware) |

These maps use the same hex values as the `--*-hex` CSS custom properties in `semantic.css` where CSS companions exist. Some runtime-only exports, such as signal colors and brand helpers, live only in the JS maps.

## Usage Guidelines

### Do

- Reference semantic tokens in CSS/Tailwind: `var(--surface-base)`, `var(--text-secondary)`
- Import from `chart-colors.ts` or `severity-colors.ts` for Recharts colors
- Use the bridge vars (`--background`, `--card`, etc.) in existing code — no rush to migrate
- Add new component tokens to `semantic.css` when needed

### Don't

- Reference primitives (`--p-blue-500`) directly in components, except when a documented local visualization intentionally needs a primitive ramp before a semantic token exists
- Hardcode hex values in chart components — use the JS token maps
- Edit shadcn/ui primitives in `src/components/ui/` to use tokens
- Define one-off color variables in individual component files

### Adding a New Token

1. If it's a raw color/spacing value → add to `primitives.css`
2. If it maps a primitive to a purpose → add to `semantic.css` (both `:root` and `.dark`)
3. If a non-CSS chart/runtime consumer needs it → add a `-hex` companion in `semantic.css` AND update the JS token map
4. If it's scoped to one component type → add as a component token in `semantic.css`
