# Peg Diversity Map — Icon-Based Night-Sky Hero

**Status:** design approved
**Date:** 2026-04-23
**Scope:** `/alt-pegs` page, `FiatWorldAtlas` desktop hero only. Mobile list and cohort page links unchanged.

## Problem

The current hero shows each peg as a cluster badge of up to 3 logos + a "+N" overflow pill. Users can't see the full field of non-USD stablecoins, the cluster badges don't reflect market cap, and the ocean-floating Gold/Silver/CPI glyphs feel geographically incidental rather than deliberately non-geographic.

## Goal

Turn the hero into a night-sky landscape where every non-USD stablecoin is represented directly by its own logo, sized by market cap. Non-geographic cohorts (Gold, Silver, CPI) become celestial bodies literally above the map; geographic cohorts sit on their real country. Hovering any coin reveals cohort structure — the user learns which coins share a peg without clicking.

## Non-goals

- Not changing the `/alt-pegs` layout outside the hero.
- Not adding new data sources or on-chain calls.
- Not redesigning mobile. Mobile continues rendering `MobileRegionList` + `CelestialBand`.
- Not introducing animation libraries — CSS keyframes and transitions only.

## Design summary

```
+------------------------------------------------------------+
|                         SKY (30%)                          |
|  ☀ Gold       ☽ Silver          ✦  Index (constellation)   |
|  XAUT PAXG      KAG               FPI                      |
|  KAU XAUm …                       ISC  SILK                |
|      (ambient stars)                                       |
| ---------------- horizon glow ---------------------------- |
|                          EARTH (70%)                       |
|                                                            |
|    🇨🇦CADC            🇬🇧tGBP  🇷🇺A7A5                         |
|  🇲🇽CETES MXNB         🇪🇺 EURC + 12 siblings    🇯🇵 JPYC …  |
|                    🇨🇭 ZCHF CHFAU       🇹🇷 TRYB           |
|       🇧🇷 BRZ BRLA BRLV                  🇮🇩 IDRT IDRX      |
|                    🇿🇦 ZARP                    🇦🇺 AUDD AUDM |
+------------------------------------------------------------+
```

### Composition

- Hero container: `aspect-ratio: 1.6 / 1` on desktop (`lg+`). Hidden below `lg`.
- Sky layer: top 30%. Night gradient, ambient starfield (~80 stars, deterministic seed), celestial bodies.
- Earth layer: bottom 70%. Aspect-locked map frame (900:460) centered horizontally. Fiat emblems live inside the frame at SVG-relative percentages. Subtle horizon glow at the top edge.
- Background: vertical gradient from deep space at top through horizon band into dark earth tones at bottom.

### Celestial bodies

- **Gold → Sun.** Radiant halo + 8 rays. XAUT and PAXG fuse as the solar core (two overlapping large discs with gold rims and strong glow). KAU, XAUm, CGO, PGOLD, GGBR, DGLD orbit as gold-rimmed planets.
- **Silver → Moon.** Cool silver halo. KAG is the single moon body.
- **CPI/VAR → Constellation.** FPI (brightest), ISC, SILK linked by dashed trace lines. Each coin gets a cool blue rim and outer glow.

### Geographic fiat coins

- All non-USD fiat coins sit on the Earth layer at their peg's anchor (from the existing `PEG_ANCHORS`).
- Multiple coins per peg are packed around the anchor, largest at center.
- Every coin is wrapped in `<a href>` to its detail page.

### Size formula

```
size_px = clamp(floor + sqrt(marketCap_usd / 1_000_000) * scale, floor, ceil)
```

Defaults: `floor = 26`, `ceil = 120`, `scale = 4.0`.

Rationale: sqrt compresses a 3+ order-of-magnitude spread (micro-caps to XAUT's ~$2.6B) into a legible 26–120px range. The ceil guarantees no single coin swamps the layout. The floor guarantees every coin is clickable (≥ 26px hit target).

### Hover interaction ("Cohort Resonance")

All hover state lives in a single React context (`HoverContext`) so all emblems can derive styling from one source.

On hover (or focus) of coin `C` with peg `P`:
1. `C` scales to 1.1× with a strong accent-blue glow ring.
2. A floating tooltip card positioned below `C` shows: symbol, name, formatted market cap, peg code, "See details →".
3. All coins with the same peg `P` ("siblings") gain a softer blue rim + outer glow.
4. Dashed SVG threads render from `C` to each sibling (behind emblems).
5. All other coins dim to 55% opacity.
6. For sky cohorts (Gold/Silver/CPI), the corresponding halo/rays pulse subtly for the duration of the hover.

Leaving hover returns everything to resting state via CSS transitions (~200ms).

Keyboard focus (`:focus-visible`) triggers the same treatment. Tooltip is announced via `aria-describedby`.

### Resting state labels

- Region tags (e.g., "Europe", "Americas", "Gold · Sun · 8 coins") render at low opacity as subtle orientation anchors.
- Individual coin tooltips only appear on hover/focus.

### Legend

Small caption below the hero: "Size ∝ market cap · $2M … $500M+". Rendered as static text; no interactive legend.

### What goes away

- Country fill colors (peg-colored choropleth). Map renders as quiet slate shapes only.
- `WorldMapInteractive` country-hover tooltip. Coins provide richer interaction; keeping country hover on top of emblems creates a conflict.
- `MapEmblemClusters` (cluster badges with +N pills). Replaced by individual emblems.
- `MapDeadspotReferences` (sun/moon/CPI as ocean glyphs). Replaced by sky cohort components.

## Architecture

### Files

New:

- `src/app/alt-pegs/fiat-world-atlas/sky-layer.tsx` — sky layer container
- `src/app/alt-pegs/fiat-world-atlas/starfield.tsx` — deterministic ambient stars
- `src/app/alt-pegs/fiat-world-atlas/sun-cohort.tsx` — gold sun + planets
- `src/app/alt-pegs/fiat-world-atlas/moon-cohort.tsx` — silver moon
- `src/app/alt-pegs/fiat-world-atlas/constellation-cohort.tsx` — index stars + traces
- `src/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live.tsx` — live map frame + sky/fiat composition
- `src/app/alt-pegs/fiat-world-atlas/fiat-emblems.tsx` — renders all fiat coin emblems on the map
- `src/app/alt-pegs/fiat-world-atlas/coin-emblem.tsx` — atomic emblem (link, image, hover/focus)
- `src/app/alt-pegs/fiat-world-atlas/cohort-threads.tsx` — SVG overlay for hover threads
- `src/app/alt-pegs/fiat-world-atlas/hover-context.tsx` — shared hover state context
- `src/lib/alt-peg-hero.ts` — builds the hero data model (fiat clusters + sky cohorts)
- `src/lib/alt-peg-sizing.ts` — mcap → px size formula
- `src/lib/alt-peg-packing.ts` — arranges coins inside a peg cluster around its anchor

Rewritten:

- `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx` — renders the desktop live hero and mobile fallback

Deleted:

- Obsolete map-emblem-clusters component
- Obsolete map-deadspot-references component
- Obsolete world-map-interactive country-hover layer

### Data flow

```
useStablecoins() ─┐
                  ├─► buildPegDiversityHero(peggedAssets)
ACTIVE_STABLECOINS┤      ├─► PegCluster[]  (one per fiat peg, anchored via PEG_ANCHORS)
                  │      └─► SkyCohort[]   (sun/moon/constellation)
logosById ────────┘
                          │
              ┌───────────┴─────────────┐
              ▼                         ▼
         <EarthLayer/>               <SkyLayer/>
           └─► <FiatEmblems/>            ├─► <SunCohort/>
                 └─► <CoinEmblem/> each  ├─► <MoonCohort/>
                                         └─► <ConstellationCohort/>
                                              └─► <CoinEmblem/> each

              ╰── <HoverProvider/> wraps everything ──╯
```

### Types

```ts
// shared types live in src/lib/alt-peg-hero.ts
export interface HeroCoin {
  id: string;
  symbol: string;
  name: string;
  href: string;
  logoSrc: string;
  pegCurrency: PegCurrency;
  marketCap: number; // USD
}

export interface PlacedCoin extends HeroCoin {
  x: number; // percentage inside its layer's frame
  y: number;
  sizePx: number;
}

export interface PegCluster {
  peg: PegCurrency;
  anchor: { x: number; y: number };
  coins: PlacedCoin[]; // positioned, sorted largest-first
}

export type SkyCohortKind = 'sun' | 'moon' | 'constellation';

export interface SkyCohort {
  kind: SkyCohortKind;
  label: string;
  href: string;
  coins: PlacedCoin[];
}

export interface PegDiversityHero {
  pegClusters: PegCluster[];
  skyCohorts: SkyCohort[];
}
```

### Packing algorithm

`arrangeClusterCoins(anchor, coins)` — per cluster:

1. Sort coins by marketCap desc.
2. Place the largest at the anchor (offset 0,0).
3. For each remaining coin, compute a polar offset:
   - `radius` = `0.6 * (prevCoinSize/2 + currentSize/2)` in percentage-of-frame units, lower-bounded by 2%.
   - `angle` = next slot in a golden-angle sequence (137.5° increments) starting at -90° (north).
4. Candidate position = anchor + (radius*cos, radius*sin).
5. If candidate overlaps any already-placed coin in this cluster (center-to-center distance < sum of radii × 0.95), increment radius by 1% and retry up to 20×.

Golden-angle spiral avoids radial stripe artifacts and handles 1–15 coins per cluster cleanly. Cross-cluster overlaps (e.g., EUR bleeding into CHF) are acceptable — both clusters are "Europe" conceptually. Visual overlap is resolved by the hover dim treatment.

### Sky layout

Fixed positions within the 30% sky layer (percentages of the layer itself):

| Cohort        | Center x | Center y | Notes                          |
|---------------|---------|---------|--------------------------------|
| Sun core      | 16%     | 48%     | Halo 340px, rays at 440px      |
| Moon          | 50%     | 42%     | Halo 160px                     |
| Constellation | 82%     | 55%     | Spread across 70–95% x         |

Inside each cohort region, coins are placed by `arrangeSkyCohortCoins` which uses a simpler horizontal-row layout (no polar spiral):
- Largest coin at cohort center.
- Secondary coins placed left/right in size-descending order.
- Tertiary planets orbit at fixed offsets for the sun.

### Anchor strategy

Reuse the existing `PEG_ANCHORS` from `src/lib/alt-peg-emblems.ts` unchanged. Those values were previously tuned against the real SVG and shipping now in production. Individual coins within a peg are offset from the anchor by the packing algorithm.

If a new peg currency is added later, its anchor must be curated manually; no auto-centroid fallback in this iteration (flagged for a future follow-up).

### Size scaling constants

Defaults in `alt-peg-sizing.ts`:
```ts
export const SIZE_FLOOR = 26;
export const SIZE_CEIL = 120;
export const SIZE_SCALE = 4.0;
export const MCAP_DIVISOR = 1_000_000; // millions
```

### Hover context

```ts
interface HoverContextValue {
  hoveredCoinId: string | null;
  hoveredPeg: PegCurrency | null;
  setHoveredCoin: (coin: HeroCoin | null) => void;
}

// Derived helpers consumed by CoinEmblem
isHovered(coinId): boolean
isCohortSibling(coin): boolean
isDimmed(coin): boolean  // true when there's a hover and this coin is not sibling or self
```

Setting hover updates both `hoveredCoinId` (for thread origin) and `hoveredPeg` (derived). Siblings are every coin with the same `pegCurrency` as `hoveredPeg`.

### Cohort threads

`<CohortThreads/>` is an absolutely-positioned SVG overlay (one in SkyLayer, one in EarthLayer) that renders only when `hoveredPeg` is set and the hovered coin is in that layer.

It draws `<line>` elements with dashed stroke from the hovered coin's screen position to each sibling's position. Stroke color derives from the peg's color hex at 55% alpha. The SVG is z-indexed above the map and below emblems so threads appear behind the coins themselves.

### Motion & `prefers-reduced-motion`

- Sun halo: 4s ease-in-out pulse (0.9 → 1.0 scale on the halo, opacity 0.9 → 1.0).
- Star twinkle: individual stars fade 0.3 → 1.0 over 3–6s at staggered offsets.
- Moon halo: 5s breathing pulse (subtler).
- Hover transitions: 180ms ease-out on scale, glow, opacity.

Wrap every keyframe animation in `@media (prefers-reduced-motion: no-preference)`. When motion is reduced, static resting states are used.

### Accessibility

- Each `<CoinEmblem/>` is an `<a>` with:
  - `href` to the coin's detail page
  - `aria-label="{symbol} · {name} · ${mcap} market cap · {peg} peg"` (humanized)
  - `aria-describedby` pointing to its tooltip when hovered/focused
  - Visible `:focus-visible` outline matching the hover glow
- Tab order follows a stable reading sequence: sky (sun → moon → constellation) → fiat by region (Americas → Europe → Africa → Asia → Oceania). Coins within a region ordered by market cap desc.
- Region tags are `role="presentation"` purely decorative.
- Starfield is `aria-hidden="true"`.
- Sky halo pulse respects `prefers-reduced-motion`.

### Crawlability / SEO

Every coin emblem is a real `<a href>` rendered in static output (no client-only hydration for the link). Search crawlers reading the static HTML see the full graph of non-USD coins linked from the landing page. Sky cohort labels link to the cohort pages (`/alt-pegs/gold`, `/alt-pegs/silver`, `/alt-pegs/index`).

## Testing

Unit:
- `alt-peg-sizing.test.ts` — size formula: boundary cases (0, 1M, 100M, 2.6B), clamp behavior, zero/negative guards.
- `alt-peg-packing.test.ts` — packing: single coin at anchor, n-coin cluster no-overlap invariant, largest is closest to anchor.
- `alt-peg-hero.test.ts` — `buildPegDiversityHero` shape: every active non-USD coin appears, sky cohorts group correctly.

Component:
- `coin-emblem.test.tsx` — renders `<a>` with href + aria-label; focus/hover changes class state.
- `hover-context.test.tsx` — hovering a coin sets both id and peg; clearing resets.
- `cohort-threads.test.tsx` — renders N-1 lines for a peg with N coins when hovered.

Integration:
- `world-atlas.test.tsx` — full render with 50 coins mock; no errors, every coin present, sky cohorts present, tab order stable.

Coverage threshold: existing 66% lines applies. No new exemptions.

## Migration notes

- `PEG_ANCHORS` export in `src/lib/alt-peg-emblems.ts` stays (reused). The `buildPegEmblemClusters` function is deleted; consumers switch to `buildPegDiversityHero`.
- No D1 migration. No API changes. No new cron work.
- Existing `world-countries.svg` unchanged.

## Risks and mitigations

- **Dense EUR cluster (13 coins)** might visually overflow into adjacent regions (CHF, GBP, TRY). The packing spiral is tuned at 60% spacing to stay compact; if overflow is acceptable in preview it stays; if not, clamp the EUR cluster to a tighter radius and let the largest three carry visual weight.
- **Performance**: 50 emblems + starfield + hover overlays renders at constant cost; no reflows on hover (only class + opacity changes). Budget: paint under 16ms on desktop.
- **Motion in reduced-motion mode**: all pulses fall back to static; verify via Playwright with `forcedColors=none` + `prefersReducedMotion=reduce`.
- **Logo loading**: emblems show blank while loading. Use `loading="eager"` for the top-10 by mcap (above-the-fold hero), `loading="lazy"` for the rest.

## Deliverables

1. Spec committed at `docs/superpowers/specs/2026-04-23-peg-diversity-icon-map-design.md` (this file).
2. Implementation plan committed alongside (separate file, produced by writing-plans).
3. Feature branch or direct commits to `main` once tests pass and smoke-checked in browser.
4. PR description referencing this spec.
