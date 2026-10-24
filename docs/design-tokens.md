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

- **Values:** `primitives.css` owns color ramps, the frost-blue brand accent, the 4px-based spacing scale (including tight half steps), and typography primitives. Read that file for exact stops and names rather than extending a copied catalog. See [Type scale](#type-scale) for selection.
- **Radius** — `--p-radius-none` to `--p-radius-full`. Usage rule: chips, pills, avatars and dots `rounded-full`; buttons, inputs, selects and other controls `rounded-md`; top-level cards, panels, shells and dialogs `rounded-xl`; surfaces nested inside a card or panel (callouts, inner tiles, notices, stat boxes) `rounded-lg`, one step below their parent; inline tags, badges, `kbd` and inline code `rounded-sm`; table, image and chart wrappers inherit their container. Use the named steps only: ESLint `pharos/no-arbitrary-radius` bans `rounded-[…]` and the bare `rounded` (write `rounded-sm`) in `src/components/`, `src/app/` and `src/lib/`, with the type-scale rule's editorial carve-outs and the shadcn `src/components/ui/` primitives exempt. Nested tiles use `.pharos-inset`.

Naming: `--p-{category}-{value}` (e.g., `--p-blue-500`, `--p-space-4`)

### Layer 2: Semantic Tokens (`src/styles/tokens/semantic.css`)

Purpose-driven aliases that map primitives to meaning. These switch between light and dark mode.

Choose semantic roles by meaning: surfaces/text/borders for hierarchy; [UI state utilities](#ui-state-utilities) for operational status; published severity, PSI, DEWS and score scales for data classification. `semantic.css` also owns brand, risk alerts, mechanism accents, interactive states, chart stages, motion and elevation. Read its definitions for exact families and theme values.

#### Contrast and interaction baseline

- Metadata and helper text must remain readable on pale surfaces. Use semantic text roles, not unscoped light palette stops; dark-only surfaces are explicit exceptions.
- Keyboard focus uses the shared visible ring in both themes. DEWS radar guides use theme-tuned `--dews-radar-*` tokens; dark mode must not make spokes disappear.
- Dense controls use `--control-pill-*`. `.pharos-control-pill-active`, on-state toggle pills and `.pharos-pill-tab-active` share elevated-neutral active fill, primary text and a hairline ring; never solid ink or a local `.dark` hex override. Navigation's frost-lit rail is separate.
- Secondary mode/view/window switches use `.pharos-segmented` with `.pharos-segmented-item`, selection exposed through `aria-pressed` / `aria-selected`; `ControlPillToggle` supports `variant="segmented"`.
- Sticky table headers and anchor scroll padding use `--table-header-top`, the bottom edge of site chrome, rather than independent offsets.
- Fixed/portalled surfaces choose named `@theme` layers in `globals.css`: chrome → chrome dock → chrome header → progress → regime → modal → toast/skip. Do not invent numeric `z-[…]`; menus, popovers and tooltips share the modal layer. Fixed or sticky rules in CSS modules use the same layers through `var(--z-index-*)` (the `@theme static` block always emits them); numeric `z-index` there stays local: `0`–`10`, or higher only inside a container that sets `isolation: isolate`.
- Inner chart canvases use `--chart-stage-*`, distinct from the outer card shell.

#### UI state utilities

UI/operational status (jobs, stale/degraded pills, notices, validation and toasts) uses the `semantic.css` vocabulary, exposed as Tailwind utilities. Theme colors resolve through `light-dark()`.

| Tone | Hue | Typical use |
| --- | --- | --- |
| `positive` | emerald | succeeded, healthy, verified |
| `warn` | amber | stale, degraded, needs review, caution banners |
| `danger` | red | failed, error, unavailable |
| `info` | sky | running, pending, provisional, informational |

| Utility | Select for |
| --- | --- |
| `text-state-{tone}` | Standard status text |
| `text-state-{tone}-bright` | Text on a tint |
| `text-state-{tone}-strong` | Callout body copy |
| `text-state-{tone}-ink` | Callout headings |
| `bg-state-{tone}-subtle` / `border-state-{tone}` | Tinted state surface / border |
| `{bg,border,text,fill,stroke,ring,…}-state-{tone}-solid[/N]` | Solid state hue with optional opacity |

- The `-solid` colour is a theme colour (`--color-state-{tone}-solid`), so it takes any utility and opacity modifier; the other roles are fixed utilities without modifiers.
- Neutral state keeps the existing neutral tokens (`text-muted-foreground`, `bg-muted/30`, `border-border/60`). Grey score bars and their track use `bg-meter-neutral`, `bg-meter-track` and `border-meter-track-border`; help glyphs and in-card links that carry the brand accent as text use `text-brand-accent-text` (sky-700 on light, frost blue on dark). `SEVERITY_TONE_CLASS` in `src/lib/severity-tone.ts` composes these utilities for pill/banner/text/bar slots.
- State utilities are not for classification scales. A colour chosen by a data band, grade, tier or category (peg-deviation severity, score tiers, PSI/DEWS bands, chain health, coverage/feature palettes, mechanism or event categories) belongs to `shared/lib/classification.ts` or the documented engine that owns it (`src/lib/severity-colors.ts`).
- `light-dark()` resolves against `color-scheme`: `:root` sets `light` and `.dark` sets `dark` (next-themes also sets it inline on `<html>`). A subtree with its own `color-scheme` (the Telegram mini-app follows the Telegram theme) resolves these tokens against that scheme, not the `.dark` class.
- ESLint `pharos/no-raw-palette-colour` bans raw palette colour classes (`text-amber-700`, `bg-red-500/10`, `border-l-sky-500/70` …) in `src/components/`, `src/app/` and `src/lib/`, except the editorial carve-outs (cemetery, digest, timeline/tape, blog, depeg event briefings, AI summaries, error/404 pages, the Daily Digest card), the Telegram mini-app (own `color-scheme`). Classification scales (grades, bands, deviation ramps, chain health, feature identity, provenance, score tiers…) live as static class maps in `shared/lib/classification/`, which the rule does not lint; import them rather than re-spelling hues. Nothing is grandfathered: there is no bulk-suppression ledger, so every new raw hue fails `npm run lint`.

#### Hex Companion Variables

DOM SVG and Recharts paths rendered by the browser can use CSS variables. Literal values remain necessary for JS/runtime or external-renderer paths that cannot resolve the CSS cascade. Selected semantic status/chart colors have `-hex` companions when CSS and those non-CSS consumers both need the same token:

```css
--psi-bedrock: var(--p-green-500); /* CSS usage */
--psi-bedrock-hex: #22c55e; /* JS/Recharts usage */
```

Chart accent literals in `chart-colors.ts` match `--chart-*-hex`. Its re-exported `THREAT_BAND_HEX` uses the shared classification palette, not theme-switched `--dews-*-hex`. `severity-colors.ts` emits Tailwind classes; severity hex companions are consumed directly through CSS. Runtime exports do not each have a CSS companion.

### Layer 3: Component Tokens (in `semantic.css`)

Add component tokens only when a component's purpose cannot be expressed by an existing semantic role. `semantic.css` owns card fill/border/elevation, table headers/rows/sticky-column treatment and the code-surface family. Code surfaces deliberately remain dark in both themes; they are not ordinary cards.

## Type scale

The `--p-text-*` primitives are the single source for Tailwind's `text-*` sizes: a `@theme` block in `globals.css` maps each one, so `text-xs` and `var(--p-text-xs)` cannot drift.

| Utility | Size | Line height | Use |
| --- | --- | --- | --- |
| `text-3xs` | 10px | 14px | Dense chart, legend and axis annotations only |
| `text-2xs` | 11px | 16px | Compact chips, table meta, uppercase eyebrows |
| `text-xs` | 12px | 16px | Labels (`.pharos-label`), captions, `.pharos-meta` |
| `text-sm` | 14px | 20px | Body and UI text |
| `text-base` … `text-5xl` | 16–48px | Tailwind defaults | Titles and display (`.pharos-section-title`, `.pharos-page-title`) |

- Arbitrary pixel sizes (`text-[11px]`, `sm:text-[10.5px]`) are banned in `src/components/`, `src/app/` and `src/lib/` by the ESLint rule `pharos/no-arbitrary-text-px`. Nothing is grandfathered. A new violation fails `npm run lint`; never reintroduce an `eslint-suppressions.json` ledger or run `--suppress-rule` to absorb new violations.
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

`globals.css` bridges shadcn variables to semantic roles (`--background` → `--surface-base`, `--foreground` → `--text-primary`, `--card` → `--surface-overlay`). Use those bridge variables in existing components; do not edit `src/components/ui/` primitives to bypass them. Shared shell polish and layout coordination such as `--mobile-utility-safe-offset` live here too, not in route-local token copies.

## Utilities

Authored shell utilities live in `src/app/globals.css` under `@layer components`. They are not tokens (they consume tokens through `@apply` + `var(...)`), but they are referenced often enough from product code to be worth indexing here:

- `pharos-control-pill` — canonical small-control shell (`src/app/globals.css`). Use for time-range controls, density toggles, lens pills, hero tertiary chips, scrollspy pills, and any dense secondary action surface. See [`design-language.md`](design-language.md#control-pills) for the visual contract.

Label and figure utilities are indexed under [Type scale](#label-and-figure-utilities). Other shared utilities (`pharos-card-shell`, `pharos-focus-ring`, `pharos-interactive-card`, `pharos-chart-stage`, `pharos-table-shell`, etc.) are catalogued in [`design-language.md`](design-language.md#shared-utility-classes).

## JS Token Maps

Use `src/lib/chart-colors.ts` for runtime chart colors/heights/tooltips, `src/lib/severity-colors.ts` for severity/score Tailwind class helpers, and `shared/lib/classification.ts` for published bands and category descriptors. These source exports are the inventory.

Chart accents in `chart-colors.ts` match `--chart-*-hex`; its `THREAT_BAND_HEX` comes from classification rather than theme-switched DEWS companions. Freeze-event labels, badges and chart fills derive from one classification descriptor (`EVENT_LABELS`, `EVENT_BADGE_STYLES`, `EVENT_CHART_COLORS`) in both themes. Runtime-only palettes need not acquire a CSS twin without a CSS consumer.

## Usage Guidelines

### Do

- Reference semantic tokens in CSS/Tailwind: `var(--surface-base)`, `var(--text-secondary)`
- Import `chart-colors.ts` or shared classification palettes for Recharts colors; `severity-colors.ts` supplies Tailwind classes.
- Use the bridge vars (`--background`, `--card`, etc.) in existing code — no rush to migrate
- Add new component tokens to `semantic.css` when needed
- Reuse the live navigation, base shimmer, chip-entry and standard toast utilities in `globals.css` and their owning components; do not add unused alternate motion or shell recipes.

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
