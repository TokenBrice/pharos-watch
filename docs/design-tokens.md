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

Raw values with no semantic meaning. Never reference directly in components.

- **Color scales** — 9 hues (neutral, blue, green, teal, amber, orange, red, purple, pink), each with 50–900 lightness stops in OKLch (neutral and red extend to 950; neutral has additional 850/925/975 stops)
- **Spacing** — 4px-grid scale from `--p-space-0` to `--p-space-20`
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
| Interactive         | `--interactive-hover`, `--interactive-active`, `--interactive-focus`                                    | UI states                               |
| Chart               | `--chart-grid-opacity`, `--chart-fill-opacity`, `--chart-primary`                                       | Chart-specific theming                  |
| Motion              | `--motion-duration-fast`, `--motion-duration-base`, `--motion-ease-standard`                            | Shared transition timing                |

#### Light-Mode Contrast Baseline (March 2026)

- `--text-secondary` and `--text-tertiary` are intentionally darker in light mode than earlier revisions to keep metadata and helper text readable on pale surfaces.
- `--ring` is blue in both themes (`blue-500` light, `blue-400` dark) to keep keyboard focus visible against neutral backgrounds.
- For semantic status/accent text classes used in badges and KPI callouts, use the two-theme pattern:
  - `text-*-700 dark:text-*-400`
- Avoid unscoped `text-*-300` / `text-*-400` in app code unless the element only renders on dark-only surfaces.
- DEWS radar guide lines should stay theme-tuned via tokens (`--dews-radar-spoke`, `--dews-radar-calm-boundary`); dark mode requires visibly higher alpha than `0.04` to keep axis spokes readable.

#### Hex Companion Variables

Recharts (and other SVG/canvas libraries) require literal hex color strings — CSS `var()` doesn't work in SVG attributes rendered by React. For every semantic color used in charts, there's a `-hex` companion:

```css
--psi-bedrock: var(--p-green-500); /* CSS usage */
--psi-bedrock-hex: #22c55e; /* JS/Recharts usage */
```

The JS-side token maps in `chart-colors.ts` and `severity-colors.ts` use the same hex values.

### Layer 3: Component Tokens (in `semantic.css`)

Scoped to specific UI components. Optional — use when a component needs tokens that don't map cleanly to general semantic categories.

- **Card** — `--card-bg`, `--card-border`, `--card-shadow`, `--card-shadow-hover`
- **Table** — `--table-header-bg`, `--table-row-hover`, `--table-row-stripe`, `--table-border`
- **Sidebar** — `--sidebar-bg`, `--sidebar-border`, `--sidebar-item-hover`

## Bridge Layer (`globals.css`)

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

## JS Token Maps

For colors needed at JS runtime (Recharts, canvas, dynamic styles):

| File                         | Exports                                                                     | Purpose                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/chart-colors.ts`    | `CHART_PALETTE`, `CHART_BLUE`, `PSI_BAND_COLORS`, `RECHARTS_TOOLTIP_STYLES` | Chart fill/stroke colors (also has module-private `TOKEN` map)           |
| `src/lib/severity-colors.ts` | `deviationColorHex()`, `deviationColorClass()`, tier helpers                | Peg-deviation and score-tier helpers (text classes are light/dark aware) |

These maps use the same hex values as the `--*-hex` CSS custom properties in `semantic.css`.

## Usage Guidelines

### Do

- Reference semantic tokens in CSS/Tailwind: `var(--surface-base)`, `var(--text-secondary)`
- Import from `chart-colors.ts` or `severity-colors.ts` for Recharts colors
- Use the bridge vars (`--background`, `--card`, etc.) in existing code — no rush to migrate
- Add new component tokens to `semantic.css` when needed

### Don't

- Reference primitives (`--p-blue-500`) directly in components
- Hardcode hex values in chart components — use the JS token maps
- Edit shadcn/ui primitives in `src/components/ui/` to use tokens
- Define one-off color variables in individual component files

### Adding a New Token

1. If it's a raw color/spacing value → add to `primitives.css`
2. If it maps a primitive to a purpose → add to `semantic.css` (both `:root` and `.dark`)
3. If it's used in Recharts → add a `-hex` companion in `semantic.css` AND update the JS token map
4. If it's scoped to one component type → add as a component token in `semantic.css`
