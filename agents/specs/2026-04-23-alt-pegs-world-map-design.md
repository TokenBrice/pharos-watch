# Alt-Pegs World Map Refactor — Design

Date: 2026-04-23
Status: Approved (brainstorm — proceeding to implementation plan)
Owner: user authored brainstorm; agent dispatch for implementation.

## Goal

Refactor the "Fiat Peg Geography" module on `/alt-pegs` to feature a real
world map with country-level coloring, and fold the current separate
"Non-geographic references" side card (Gold, Silver, CPI) into the same card
via a symbolic "celestial band" rendered above the map.

Today's implementation (`src/app/alt-pegs/static-link-hub.tsx`) uses a
stylized SVG atlas with 5 abstract region blobs. We replace it with a single
unified card where:

- Countries that are the reference currency of a tracked fiat peg are colored
  on a real world map using each peg's existing color.
- Gold, Silver, and CPI/Index cohorts render as orbital bodies above the map
  (sun, moon, abstract index glyph) — clearly off-geography but part of the
  same visual surface.

## Non-goals

- No change to mobile layout (stacked region list, < xl breakpoint).
- No new external runtime dependencies. `d3-geo` is dev-only for the build
  script.
- No per-country interactivity on the map (no hover, no tooltip) — the
  surrounding chips/pills already carry that information.
- No change to `/alt-pegs` charts, cohort history, or taxonomy data.

## Decisions captured in brainstorm

| # | Question | Decision |
|---|----------|----------|
| 1 | Coloring granularity | Per-country shading, each peg owns a territory |
| 2 | Map source & library | Static pre-rendered SVG (zero runtime deps) |
| 3 | Multi-country scope | Each peg colors its real territory only (EUR = eurozone 20; CHF = CH + LI; GBP = GB; etc.) |
| 4 | Interactivity | Static, no hover/tooltip |
| 5 | Mobile | Unchanged — stacked region list below `xl:`; celestial references stacked as cards |
| 6 | Commodity / CPI treatment | Celestial band above the map: Gold = sun, Silver = moon, CPI/Index = abstract glyph |

## Architecture

### File layout (new)

```
src/app/alt-pegs/fiat-world-atlas/
  index.ts                        — barrel export
  world-atlas.tsx                 — top-level card: celestial band + map + chips
  celestial-band.tsx              — Gold / Silver / CPI orbital band
  world-map.tsx                   — inline SVG world map + color <style> block
  region-chips.tsx                — per-region pills + per-currency chips
  mobile-region-list.tsx          — stacked region list for < xl (extracted)
src/lib/alt-peg-geography.ts      — peg → ISO country codes + helpers
scripts/build-world-map-svg.ts    — one-shot build script (dev dep only)
scripts/data/world-countries-110m.json — checked-in Natural Earth TopoJSON source
public/maps/world-countries.svg   — generated pre-rendered SVG (checked in)
```

### Files updated

- `src/app/alt-pegs/static-link-hub.tsx` — shrinks dramatically. Renders
  `<FiatWorldAtlas />` + deletes all atlas / non-geographic card scaffolding.
  `AtlasBackdrop`, `AtlasLeadLines`, `CoverageMarker`,
  `NonGeographicReferenceCard`, `MAP_REGION_LAYOUT`, `ATLAS_LANDMASSES`, and
  the stylized-blob layout are removed.
- `src/app/alt-pegs/static-link-hub.test.tsx` — updated to assert the new
  structure (card count, celestial band presence, country fills).
- `docs/alt-pegs-page.md` — updated to describe the new module.

### Data layer (`src/lib/alt-peg-geography.ts`)

```ts
export type Iso2 = string;

// Each tracked fiat peg -> the ISO-3166-1 alpha-2 codes it covers.
export const PEG_COUNTRY_MAP: Partial<Record<PegCurrency, readonly Iso2[]>> = {
  EUR: ["DE","FR","IT","ES","NL","BE","AT","PT","IE","FI","GR",
        "SK","SI","LU","EE","LV","LT","CY","MT","HR"],
  CHF: ["CH","LI"],
  GBP: ["GB"],
  JPY: ["JP"],
  BRL: ["BR"],
  CAD: ["CA"],
  MXN: ["MX"],
  ZAR: ["ZA"],
  AUD: ["AU"],
  RUB: ["RU"],
  TRY: ["TR"],
  IDR: ["ID"],
  SGD: ["SG"],
  CNH: ["CN","HK"],
  PHP: ["PH"],
  // Any new fiat peg added to the taxonomy must get an entry here.
};

// Pure helper — no React deps. Tested in isolation.
export function buildCountryColorMap(
  items: readonly AltPegLinkHubItem[],
): ReadonlyMap<Iso2, { peg: PegCurrency; colorHex: string }>;
```

Colors come from each peg's existing `AltPegLinkHubItem.colorHex`. No new
palette is introduced.

### World map SVG pipeline

- **Source:** Natural Earth 1:110m `countries` TopoJSON (public domain).
  File checked in at `scripts/data/world-countries-110m.json` (~100 KB).
- **Build script (`scripts/build-world-map-svg.ts`):** runs manually (or
  during any future regen), uses `d3-geo` `geoNaturalEarth1()` projection +
  `topojson-client` to emit `public/maps/world-countries.svg`. Each country
  path has `id={ISO_A2}` and a neutral default fill.
  - `d3-geo` and `topojson-client` are added as **devDependencies** only.
- **Runtime:** `world-map.tsx` imports the SVG contents at build time
  (statically) and injects them into the DOM. A generated `<style>` block
  maps colored country ids to `fill` values based on the current data. Zero
  JS cost at runtime beyond rendering static markup.
- **Viewbox / cropping:** `geoNaturalEarth1` centered on 0°, 15°N (or
  similar) so Antarctica is visually cropped to save vertical height while
  keeping recognizable shapes. Final aspect ~`16:8`.

### Celestial band (`celestial-band.tsx`)

Row above the map (~96 px on desktop), inline SVG, 3 bodies:

- **Gold** (left): filled golden disk with radial gradient + soft glow.
  Size scales by `Math.sqrt(coinCount / maxCoinCount)` using the same
  emphasis formula as today's region markers, so Gold dominates visually.
  Adjacent label: "Gold · 8 coins · XAUT · PAXG · KAU".
- **Silver** (center-right): smaller disk with a crescent accent.
  Label: "Silver · 1 coin · KAG".
- **CPI / Index** (right): an abstract glyph (e.g., ring-and-dot index
  marker) rendered in a neutral/indigo color.
  Label: "CPI · 3 coins · FPI · ISC · SILK".

A subtle horizontal rule separates the band from the map below, reinforcing
the "beyond geography" metaphor.

Each body is a link (`<Link href={item.href}>`) preserving the existing
drill-down behavior of today's `NonGeographicReferenceCard`.

### Region chips (`region-chips.tsx`)

- Region summary pills (Americas, Europe, Asia, Africa, Oceania) render
  above the map — unchanged from today's `RegionSummaryPill`.
- Per-currency chips (`LinkChip`) render below the map, grouped by region.
  No more "docked" floating-on-blob layout — chips live in a clean grid
  under the map with their current visual treatment.

### Mobile (`mobile-region-list.tsx`)

Rendered at `xl:hidden`. Identical stacked list as today, with an additional
section at the bottom for the three commodity / index cohorts (since they no
longer have a dedicated side card). Uses the same `FiatRegionSection`-style
treatment so mobile stays compact.

## Testing

- **`alt-peg-geography.test.ts`:** `PEG_COUNTRY_MAP` covers every
  `AltPegRegion !== "Other"` fiat in the taxonomy (regression catches any
  new fiat peg added without a geography entry). `buildCountryColorMap`
  returns expected ISO → color pairs for representative inputs.
- **`world-map.test.tsx`:** SVG contains `<path id="DE">` etc.; generated
  `<style>` block applies the right fills for a seeded data set.
- **`celestial-band.test.tsx`:** Gold/Silver/CPI render with correct coin
  counts, symbol previews, and drill-down hrefs.
- **`static-link-hub.test.tsx` updates:** asserts the one-card structure
  (no separate non-geographic side card) and that the `<FiatWorldAtlas />`
  is rendered.

## Success criteria

1. `npm test` passes (all existing + new tests).
2. `npm run lint` and `npm run build` pass.
3. Visual QA at desktop `xl:` breakpoint: world map renders with the right
   countries colored using existing peg colors, celestial band shows Gold /
   Silver / CPI with correct sizing and counts, no separate side card.
4. Mobile (< xl): stacked region list unchanged; commodity / CPI appear as
   additional stacked sections (no broken layout).
5. Page route still statically exports (no new runtime JS beyond what today
   already ships for the link hub).
6. `docs/alt-pegs-page.md` reflects the new structure.

## Risk / mitigations

- **Bundle size** — the inlined country SVG is ~40 KB gzipped for 1:110m
  geometry; acceptable for a static page. Mitigation: if it balloons, we
  can load it as a static asset instead of inlining.
- **Visual ambiguity for EUR** — eurozone spans many small countries. The
  per-country coloring is the point of the refactor; region pills above the
  map still provide the aggregated "Europe: 5 cohorts · 20 coins" frame.
- **New fiat pegs without a country mapping** — guarded by the geography
  test that asserts coverage of all `AltPegRegion !== "Other"` pegs.

## Out of scope (explicitly)

- Hover / tooltip / click-to-filter on the map.
- Per-country coin counts (we color, we don't count at country level).
- Using the map as a reserves or issuance geography view. The current copy
  ("Not issuer, reserve, or circulation geography.") stays.
- Animation or scroll-driven reveal on the celestial band.
