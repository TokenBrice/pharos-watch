# Experience Elevation: Three Synergetic Additions

> Design document for three non-feature additions that elevate Pharos from solid dashboard to premium intelligence product.

**Date:** 2026-03-08
**Status:** Design approved, pending implementation plan

---

## Table of Contents

1. [Overview](#overview)
2. [Addition 1: Narrative Intelligence Homepage](#addition-1-narrative-intelligence-homepage)
3. [Addition 2: Cinematic Motion Design System](#addition-2-cinematic-motion-design-system)
4. [Addition 3: Rich Shareable Data Cards & Dynamic OG Images](#addition-3-rich-shareable-data-cards--dynamic-og-images)
5. [Cross-Cutting Synergies](#cross-cutting-synergies)
6. [Risk & Constraints](#risk--constraints)

---

## Overview

### Problem

Pharos has an exceptional data moat — PSI, DEWS (8-signal stress decomposition), 5D report cards with dependency propagation, peg score with 4-year rolling window, mint/burn flow intensity, bank run gauge, flight-to-quality detection. No competitor computes these signals. But the presentation layer doesn't fully exploit this advantage:

1. **The homepage shows raw KPIs** — users scan 20+ numbers and synthesize the story themselves. Every crypto dashboard is a grid of KPI cards.
2. **Motion is purposeful but minimal** — fade-in cards, pulse skeletons, ping on depegs. The product feels solid but not premium. Motion is the single biggest differentiator between "good" and "exceptional."
3. **Sharing is broken** — all 148 stablecoin pages share a single generic OG image. Users screenshot ugly tables to share insights. Pharos' intelligence is locked behind navigation.

### Solution

Three synergetic additions that transform substance into experience into distribution:

| # | Addition | Effect |
|---|---------|--------|
| 1 | Narrative Intelligence Homepage | Users *understand* Pharos instantly |
| 2 | Cinematic Motion Design System | Users *feel* its quality on every interaction |
| 3 | Rich Shareable Data Cards | Users *spread* it — every share becomes a data-rich ad |

### Constraints

- No new data sources, scoring systems, or pages
- No new API endpoints for data (OG image endpoint is infrastructure, not data)
- All existing hooks and API responses are the data layer
- Static export to Cloudflare Pages remains unchanged
- Accessibility and `prefers-reduced-motion` support are non-negotiable

---

## Addition 1: Narrative Intelligence Homepage

### Concept

A new `IntelligenceBriefing` component placed above the KpiBar. It synthesizes PSI, DEWS, depeg events, mint/burn flows, and report cards into 3-5 natural-language sentences using template logic (no LLM). The homepage becomes an intelligence briefing, not a number grid.

### Data Sources

All from existing hooks — no new API calls:

| Signal | Hook | Extracted Data |
|--------|------|----------------|
| Ecosystem health | `useStabilityIndex()` | PSI score, band, 24h/7d delta, days-in-band |
| Depeg status | `usePegSummary()` | Active depeg count, coin names, deviation magnitude |
| Stress signals | `useStressSignals()` | DEWS band distribution (danger/alert/warning counts), top stressed coins |
| Capital flows | `useMintBurnFlows()` | Net 24h flow, direction, top mover, FTQ status, bank run gauge |
| Safety landscape | `useReportCards()` | Grade distribution, any recent shifts |

### Tone System

The briefing adapts language to the PSI band — sentence structure and word choice shift, not just content:

| PSI Band | Tone | Example Headline |
|----------|------|-----------------|
| BEDROCK (90-100) | Composed, confident | "The stablecoin ecosystem is rock-solid." |
| STEADY (75-89) | Calm, informative | "The stablecoin ecosystem is steady." |
| TREMOR (60-74) | Measured, watchful | "The stablecoin ecosystem shows minor stress." |
| FRACTURE (40-59) | Direct, alert | "The stablecoin ecosystem is under pressure." |
| CRISIS (20-39) | Terse, urgent | "Multiple stablecoins are in distress." |
| MELTDOWN (0-19) | Blunt, emergency | "Systemic stress across the stablecoin market." |

### Template Engine

A pure function with no side effects:

```typescript
function buildBriefing(
  psi: StabilityIndexData,
  depegs: PegSummaryData,
  dews: StressSignalsData,
  flows: MintBurnFlowsData,
  grades: ReportCardsData,
): BriefingOutput
```

**Output structure:**

```
Line 1 (headline):  PSI band statement + score + delta + temporal context
Line 2 (depegs):    Active depeg count + names, OR last event context
Line 3 (stress):    DEWS summary — danger/alert counts + top stressed coins
Line 4 (flows):     Net minting/burning amount + comparative anchor
Line 5 (optional):  FTQ trigger, bank run gauge elevation, or grade distribution shift
```

Calm markets produce 3 lines. Stressed markets produce 5. The briefing never feels padded.

### Temporal Narrative Depth

A status report says what *is*. An intelligence briefing says what is *in context of what was*. Every line includes temporal anchoring using data already present in the hook responses — no new API calls:

| Instead of | Write |
|-----------|-------|
| "The ecosystem is STEADY." | "The ecosystem is STEADY — day 14 of the current run." |
| "No active depegs." | "No active depegs. Last event ended 6 days ago (TUSD, 47 bps)." |
| "Net minting of $340M." | "Net minting of $340M — the strongest minting day in 7 days." |
| "PSI 82 (+3 24h)" | "PSI 82, up 3 points since yesterday, highest this week." |

**Data sources for temporal context (all already in hook responses):**

| Context | Source |
|---------|--------|
| "day 14 of the current run" | `psi.daysInBand` from `useStabilityIndex()` |
| "last event ended 6 days ago" | Last closed event timestamp from `usePegSummary()` |
| "strongest minting day in 7 days" | Compare `flows.net24h` against `flows.delta7d` from `useMintBurnFlows()` |
| "highest this week" | Compare `psi.score` against `psi.score - psi.delta7d` |

The user doesn't just know the state — they know whether to *care*. "STEADY" is a fact. "STEADY for 14 days" is confidence. "$340M net minting" is a number. "Strongest minting day in 7 days" tells you it's notable.

**Conditional logic examples:**

- If 0 active depegs and DEWS all CALM: lines 2-3 collapse into "All pegs stable, no stress signals."
- If FTQ triggered: line 5 appears with "Flight-to-quality in progress — capital rotating between stablecoins."
- If bank run gauge elevated: line 5 shows "Bank run gauge elevated — aggregate redemption pressure above baseline."
- If a grade shift happened (e.g., coin dropped from B to D): line 5 mentions it.
- If `daysInBand` > 30: headline uses "for over a month" instead of exact day count (avoids absurd precision).

### Layout Integration

```
SiteHeader (brand + pills — unchanged)
 |
IntelligenceBriefing         <-- NEW
 |  Headline (larger text, PSI-band-colored accent)
 |  Supporting signals (smaller text, muted)
 |  Subtle border-bottom separator
 |
KpiBar (unchanged — quantitative detail layer)
 |
...rest of homepage
```

On mobile, the briefing becomes the hero — a single readable paragraph that replaces the need to scan 8 KPI tiles to understand the market state.

### Visual Treatment

- **Background**: Subtle gradient tinted by PSI band color at very low opacity (`oklch(... / 0.04)`). Morphs smoothly on band change (ties into motion system).
- **Headline**: `text-lg sm:text-xl`, Geist Sans, with PSI band keyword bolded and colored by band.
- **Supporting lines**: `text-sm text-muted-foreground`, monospace for inline numbers.
- **Loading state**: 3-line skeleton matching text widths (not a single block).
- **Error state**: Falls back gracefully — if any hook fails, that line is omitted. If all hooks fail, the component hides entirely and KpiBar takes over as the hero.

### Component Structure

```
src/components/intelligence-briefing.tsx   — Client component
src/lib/build-briefing.ts                  — Pure template function (testable)
```

The template function is a pure function in `src/lib/` — fully unit-testable with mock data, no React dependency.

---

## Addition 2: Cinematic Motion Design System

### Philosophy

Extend Pharos' "calm by default, urgent when needed" motion from *purposeful but minimal* to *purposeful and polished*. Every new animation must pass the test: **"Does this communicate data state, or is it decoration?"** Only data-communicating motion is added.

### No New Dependencies

Pharos is CSS-native for all animations (tw-animate-css + custom keyframes). We stay CSS-native and add one custom React hook (`useCountUp`). No Framer Motion, no React Spring. Consistent with the existing approach. Total additional JS: ~2KB.

### New Motion Tokens

Added to `src/styles/tokens/semantic.css` alongside existing tokens:

```css
/* Existing */
--motion-duration-fast: 160ms;
--motion-duration-base: 220ms;
--motion-ease-standard: cubic-bezier(0.22, 1, 0.36, 1);

/* New */
--motion-duration-slow: 600ms;
--motion-duration-entrance: 400ms;
--motion-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
--motion-ease-decelerate: cubic-bezier(0.0, 0.0, 0.2, 1);
```

### Motion Primitives

#### 1. Number Count-Up

A lightweight `requestAnimationFrame`-based React hook:

```typescript
function useCountUp(target: number, opts?: {
  duration?: number;   // default: 600ms (--motion-duration-slow)
  decimals?: number;   // default: inferred from target
  prefix?: string;     // e.g., "$"
  suffix?: string;     // e.g., "%"
}): string
```

Behavior:
- Animates from 0 to target on mount
- Animates from previous to new target on value change (smooth data refresh)
- Easing: decelerate (fast start, smooth landing at final value)
- Formats via `Intl.NumberFormat` (respects existing monospace rendering)
- Returns formatted string ready for display
- When `prefers-reduced-motion` is set: returns final value immediately, no animation

Applied to: KpiBar values (PSI, mcap, volume, flow), grade scores, liquidity scores, peg score, DEWS score.

File: `src/hooks/use-count-up.ts`

#### 2. Staggered Card Entrance

CSS utility class applied to grid containers:

```css
.pharos-stagger-entrance > * {
  animation: pharos-fade-in-up var(--motion-duration-entrance)
             var(--motion-ease-standard) both;
  animation-delay: calc(var(--stagger-index, 0) * 60ms);
}

@keyframes pharos-fade-in-up {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Each child receives a CSS custom property: `style={{ '--stagger-index': i } as React.CSSProperties}`. Cards cascade in left-to-right or top-to-bottom. Max stagger: 8 items (480ms total spread). Items beyond index 8 share the last delay to prevent excessively long entrance sequences.

Applied to: homepage feature highlights (6 cards), market highlights (6 items), report card grids, methodology section cards.

#### 3. Chart Draw-In

Re-enable Recharts animations selectively with controlled configuration:

```typescript
const CHART_ANIMATION_PROPS = {
  isAnimationActive: true,
  animationDuration: 800,
  animationEasing: 'ease-out',
} as const;
```

Applied to:
- PSI history chart (area trace draws left-to-right)
- Total mcap chart (area fill grows upward)
- Peg diversity chart (bars grow upward)
- Safety overview stacked bar (segments grow)

NOT applied to:
- Scatter plots (too many data points — performance)
- Real-time feeds (data arrives incrementally, not all-at-once)
- Charts with >200 data points

Charts animate only on first render using a `hasAnimated` ref guard. Data refreshes do NOT re-trigger the draw-in — only the initial mount.

#### 4. Grade Badge Pop

```css
@keyframes pharos-grade-pop {
  0%   { transform: scale(0); opacity: 0; }
  60%  { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); }
}
```

Duration: 400ms with `--motion-ease-spring`. Triggered when the badge enters the viewport via IntersectionObserver (extending the existing `LazyCard` pattern from safety-scores). Fires once — subsequent scrolls don't re-trigger.

Applied to: report card grade badges on safety-scores page, stablecoin detail page grade display.

#### 5. Smooth Data Transitions

When hook data refreshes (every 15-30 min), values animate between states:

- **KPI numbers**: `useCountUp` handles previous-to-new automatically
- **PSI band color**: CSS `transition: background-color var(--motion-duration-base)` on briefing background and KpiBar PSI card
- **Badge colors**: CSS `transition` on `background-color` and `color` properties (already partially supported by existing transition rules in globals.css)

No JavaScript animation needed — CSS transitions handle color changes. `useCountUp` handles number changes.

#### 6. Depeg Feed Slide-In

```css
@keyframes pharos-slide-in-right {
  from { transform: translateX(20px); opacity: 0; }
  to   { transform: translateX(0); opacity: 1; }
}
```

Duration: 300ms. Applied with stagger to newly arrived events only (tracked by event ID to avoid re-animating existing items). Maximum 3 items animate simultaneously; older items appear instantly.

#### 7. Contagion Ripple (Dependency Map)

On hover of a dependency graph node, connected edges pulse outward:

- Edge stroke: `stroke-dashoffset` animates from full to 0 (draws the line)
- Connected nodes: scale 1.0 to 1.05, 200ms transition
- Depth-based delay: 100ms per hop in the graph
- Reverse on mouse-leave (edges retract, nodes scale down)

Implementation: CSS transitions on SVG elements, triggered by adding/removing a `.ripple-active` class to the graph container with `data-depth` attributes.

### Entrance Choreography

Individual animations are nice. A choreographed sequence is cinematic. The homepage doesn't just "load" — it *reveals*.

Instead of every motion primitive firing independently on mount (uncoordinated burst), a `useEntranceSequence` coordinator assigns `animation-delay` offsets relative to a shared t=0:

```
t=0ms      Intelligence briefing headline fades in
t=150ms    Briefing supporting lines stagger in (60ms each)
t=400ms    KpiBar numbers begin counting up (staggered L-to-R, 80ms offset)
t=800ms    Charts begin draw-in (triggered by scroll, not time)
```

**Implementation:** A lightweight React hook that manages a shared timeline:

```typescript
function useEntranceSequence(): {
  phase: 'briefing' | 'kpi' | 'below-fold' | 'complete';
  delayFor: (group: string, index: number) => number;
}
```

- Returns the current phase and a delay calculator for each animation group
- Numbers only start counting up after their container's entrance animation completes (no counting inside invisible elements)
- Below-fold content (charts, cards) uses IntersectionObserver — the choreography applies only to the above-fold entrance
- The coordinator is opt-in: components call `delayFor('kpi', 2)` to get their offset. Components outside the homepage ignore it entirely
- On `prefers-reduced-motion`: all phases complete instantly, `delayFor` returns 0

This is not a new animation — it's **sequencing** of existing primitives. The same fade-in, count-up, and stagger, but timed to read as one cinematic moment instead of 15 things firing at once. Pixar doesn't animate each character independently — they choreograph a scene.

File: `src/hooks/use-entrance-sequence.ts`

### Integration Map

| Component | Motion | Trigger | Sequence Phase |
|-----------|--------|---------|----------------|
| Intelligence briefing headline | Fade-in | Mount | t=0ms |
| Intelligence briefing lines | Staggered fade | Mount | t=150ms+ |
| KpiBar values | Count-up | Mount | t=400ms+ |
| Intelligence briefing background | Color morph | PSI band change | (independent) |
| Homepage feature cards | Staggered entrance | Mount | t=400ms+ |
| Market highlights grid | Staggered entrance | Mount | t=400ms+ |
| Report card grade badges | Elastic pop | Scroll into view | (scroll-triggered) |
| PSI history chart | Area trace | Scroll into view | (scroll-triggered) |
| Total mcap chart | Area trace | Scroll into view | (scroll-triggered) |
| Safety overview bars | Bar grow | Scroll into view | (scroll-triggered) |
| Depeg feed items | Slide-in-right | New event arrival | (independent) |
| Dependency map edges/nodes | Ripple + draw | Node hover | (independent) |

Items marked `(independent)` or `(scroll-triggered)` are not part of the entrance sequence — they fire based on their own triggers. The choreography only governs the initial above-fold reveal.

### Performance Guarantees

- All animations use `transform` and `opacity` only (GPU-composited properties, no layout/paint thrash)
- `will-change: transform` applied only during active animation, removed after completion
- `requestAnimationFrame` for count-up (not `setInterval` or `setTimeout`)
- Recharts animations fire once per mount via ref guard, not on every re-render
- Total additional JS: ~2KB (one hook + one small utility)
- `prefers-reduced-motion`: all animations complete instantly (duration set to 0, no motion)

### File Structure

```
src/hooks/use-count-up.ts                — Number animation hook
src/hooks/use-entrance-sequence.ts       — Homepage entrance choreographer
src/styles/tokens/semantic.css           — New motion tokens (edit)
src/app/globals.css                      — New keyframes (edit)
```

All other changes are adding classes/props to existing components — no new component files for the motion system itself.

---

## Addition 3: Rich Shareable Data Cards & Dynamic OG Images

### Architecture: Worker-Side Image Generation

The frontend is a static export — no server-side rendering available. But the Cloudflare Worker already serves the API. We add OG image generation as Worker endpoints using **Satori** (JSX to SVG) and **resvg-wasm** (SVG to PNG).

Advantages:
- Dynamic, data-fresh images (not stale build-time snapshots)
- Same D1 cache the API already reads from
- Edge-cached with 15-min TTL (matches cron interval)
- Zero impact on frontend bundle size

### Worker Endpoints

```
GET /api/og/stablecoin/:id   -> 1200x628 PNG (per-coin card)
GET /api/og/safety-scores    -> 1200x628 PNG (aggregate)
GET /api/og/depeg            -> 1200x628 PNG (aggregate)
GET /api/og/stability-index  -> 1200x628 PNG (PSI current)
```

**Request flow:**

1. Worker receives GET request
2. Fetches coin/aggregate data from D1 cache (same queries as existing API handlers)
3. Satori renders a JSX template to an SVG string
4. resvg-wasm converts SVG to PNG buffer
5. Returns PNG with cache headers
6. Cloudflare edge caches the response

### Card Template Design

Dark background, monospace numbers, semantic color — Pharos design language:

```
+------------------------------------------------------+
|                                                      |
|   PHAROS                              pharos.watch   |
|   ---------------------------------------------------+
|                                                      |
|   [Symbol Badge]  USDC - Circle                      |
|                                                      |
|   Grade    Peg        DEWS      Liquidity    PSI     |
|    A+     $1.0001    CALM (4)    94/100    82 STEADY  |
|                                                      |
|   Mcap $32.4B  |  24h Vol $1.2B  |  7d Flow +$210M  |
|                                                      |
|   [30-day peg sparkline as SVG path]                 |
|                                                      |
+------------------------------------------------------+
```

**Visual specifications:**
- Dimensions: 1200x628px (standard OG ratio 1.91:1)
- Background: `#0a0f1e` (Pharos dark base)
- Primary text: `#e8e8e8`
- Secondary text: `#8b8fa3`
- Grade badge: colored by grade tier (A+ = emerald, B = sky, C = amber, D = orange, F = red)
- Sparkline: 30-day price data rendered as SVG path (thin line, frost-blue stroke)
- Coin symbol badge: colored circle with symbol text (no external image fetches)
- Font: Geist Sans for labels, Geist Mono for all numbers

### State-Adaptive Card Treatment

The card's visual tone adapts to the coin's current health — the card itself communicates urgency before the user clicks through. This is not a separate template; it's a conditional `borderTop` color and an optional status badge on the same card:

| Coin State | Detection Logic | Card Treatment |
|------------|----------------|---------------|
| **Healthy** (grade A/B, DEWS CALM) | `dewsBand === 'CALM' && grade >= 'B-'` | Standard dark card, frost-blue accents |
| **Stressed** (DEWS ALERT or WARNING) | `dewsBand === 'ALERT' \|\| dewsBand === 'WARNING'` | Amber `border-top` (4px), subtle "ELEVATED STRESS" badge top-right |
| **Depegged** (active depeg event) | `hasActiveDepeg === true` | Red `border-top` (4px), "DEPEGGED" badge, deviation % shown prominently |
| **Danger** (DEWS DANGER) | `dewsBand === 'DANGER'` | Red `border-top` (4px), "DANGER" badge |

The condition data (DEWS band, active depeg, grade) is already fetched by the same D1 query that populates the card's metrics. Zero additional cost.

**Why this matters:** When someone shares a link to a coin that's depegging, the social card screams "look at this" instead of looking identical to a healthy coin. During a crisis, every Pharos share on Twitter/Discord carries visual urgency — free distribution with built-in emotional weight. The card becomes a signal, not just an information container.

### Aggregate Page Cards

**Safety Scores OG (`/api/og/safety-scores`):**

```
PHAROS - Safety Scores
Grade Distribution: 12 A-tier | 34 B-tier | 28 C-tier | 8 D/F
Market Safety Pulse: B+ (78/100)
Coverage: 142/148 rated
[Stacked bar showing grade distribution]
```

**Depeg OG (`/api/og/depeg`):**

```
PHAROS - Peg Monitor
3 active depegs | PSI 82 STEADY
142/148 coins at peg
DEWS: 0 danger | 2 alert | 5 warning
```

**PSI OG (`/api/og/stability-index`):**

```
PHAROS - Stability Index
PSI 82 STEADY (+3 24h)
[Mini area chart of 7-day PSI history]
6 condition bands visualization
```

These replace the current static `/public/og-*.png` files with dynamic, data-fresh versions.

### Frontend Metadata Integration

In stablecoin detail page `generateMetadata()`:

```typescript
export async function generateMetadata({ params }) {
  const coin = findCoin(params.id);
  return buildPageMetadata({
    ...existingFields,
    ogImage: `https://api.pharos.watch/api/og/stablecoin/${params.id}`,
  });
}
```

Static export works because the OG image URL is deterministic — the social crawler fetches the image from the Worker at share time, getting fresh data. This is the same pattern used by many static sites that point OG images to dynamic endpoints.

Similarly, feature pages update their `ogImage` from static PNGs to Worker endpoints:

```typescript
// safety-scores/page.tsx
ogImage: "https://api.pharos.watch/api/og/safety-scores",
```

### Client-Side Share Button

On stablecoin detail pages, report cards, and comparisons:

```
[Copy Link]  [Copy as Image]  [Download PNG]
```

**Implementation:** Fetch the Worker-generated image (already edge-cached) and use browser APIs:

```typescript
async function shareAsImage(coinId: string) {
  const res = await fetch(`/api/og/stablecoin/${coinId}`);
  const blob = await res.blob();

  // Clipboard API (modern browsers)
  if (navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
  }

  // Fallback: trigger download
  // ...
}
```

This reuses the Worker renderer — no duplicate client-side template. The compare page's existing Canvas-based renderer (`compare-share-image.ts`) remains unchanged for its specialized multi-coin comparison cards.

**Share button component:** `src/components/share-button.tsx` — reusable across detail pages, report cards, comparisons. Accepts an `ogPath` prop for the Worker endpoint.

### Dependencies

Added to `worker/package.json`:

```
satori            ~2MB   (JSX to SVG)
@resvg/resvg-wasm ~3MB   (SVG to PNG via WASM)
```

Both are Cloudflare Workers compatible (WASM support). Total Worker bundle impact: ~5MB. The Worker is currently ~2MB, staying within Cloudflare's 10MB limit for paid plans.

### Font Loading

Satori requires font files as `ArrayBuffer`. We bundle Geist Sans and Geist Mono font files (Regular + Bold weights, ~200KB total) as static assets in the Worker bundle. Loaded once at cold start, cached in module scope for subsequent requests.

```typescript
// worker/src/lib/og-fonts.ts
import geistSansRegular from '../assets/fonts/GeistSans-Regular.ttf';
import geistSansBold from '../assets/fonts/GeistSans-Bold.ttf';
import geistMonoRegular from '../assets/fonts/GeistMono-Regular.ttf';

export const OG_FONTS = [
  { name: 'Geist Sans', data: geistSansRegular, weight: 400 },
  { name: 'Geist Sans', data: geistSansBold, weight: 700 },
  { name: 'Geist Mono', data: geistMonoRegular, weight: 400 },
];
```

### Cache Strategy

```
Cache-Control: public, max-age=900, s-maxage=900
Vary: Accept
```

- 15-min TTL matches the stablecoin sync cron
- Cloudflare edge caches the PNG response automatically
- Cache key: full URL path (one image per coin per 15-min window)
- No KV/R2 needed — Cloudflare's built-in HTTP cache is sufficient
- Cold generation takes ~200-500ms; subsequent requests served from edge cache in <50ms

### File Structure

```
worker/src/api/og.ts                     — Route handler + template rendering
worker/src/lib/og-fonts.ts               — Font loading
worker/src/lib/og-templates/
  stablecoin-card.tsx                    — Per-coin JSX template
  safety-scores-card.tsx                 — Aggregate safety card
  depeg-card.tsx                         — Aggregate depeg card
  stability-index-card.tsx               — PSI card
  shared.tsx                             — Common card frame, header, sparkline
worker/assets/fonts/                     — Geist font files
src/components/share-button.tsx          — Client-side share UI
src/lib/page-metadata.ts                — Updated OG URLs (edit)
src/app/stablecoin/[id]/page.tsx         — Updated generateMetadata (edit)
src/app/safety-scores/page.tsx           — Updated metadata (edit)
src/app/depeg/page.tsx                   — Updated metadata (edit)
src/app/stability-index/page.tsx         — Updated metadata (edit)
```

---

## Cross-Cutting Synergies

### 1. Narrative feeds Motion

The intelligence briefing's background color morphs smoothly when PSI band changes — this uses the motion system's CSS transition on `background-color`. Numbers within the briefing use `useCountUp` for animated values. The briefing *demonstrates* the motion system on the most visible part of the page.

### 2. Motion feeds Shareable Cards

When a user sees numbers animate in and charts draw themselves, the data feels alive and current. The "Copy as Image" button captures a frozen moment of that aliveness. The motion creates perceived value; the share card distributes it.

### 3. Narrative feeds Shareable Cards

The homepage OG card can include the briefing headline as the card's description text. When someone shares `pharos.watch`, the social preview becomes a mini intelligence briefing — the most compelling possible preview for driving click-through.

### 4. Shared Design Language

All three additions use the same tokens:
- PSI band colors for tone-setting (briefing background, card grade color, motion color morphs)
- Monospace numbers for precision signaling (briefing inline numbers, count-up displays, card metrics)
- Dark base palette for brand consistency (card background matches site background)
- Semantic color for state communication (grade badges, DEWS threat bands, flow direction)

---

## Risk & Constraints

### Worker Bundle Size

Adding Satori + resvg-wasm (~5MB) to the Worker. Current Worker is ~2MB. Cloudflare paid plan allows 10MB per Worker. This leaves ~3MB headroom. If the Worker grows further in the future, we may need to split OG generation into a separate Worker.

**Mitigation:** Monitor bundle size. If approaching 10MB, extract OG generation into a dedicated `og-worker` with its own `wrangler.toml`, proxied from the main Worker via service bindings.

### Satori Limitations

Satori supports a subset of CSS (no `backdrop-filter`, no `box-shadow` with spread, limited gradient support). The card template must use only supported properties.

**Mitigation:** Design the card template with Satori constraints in mind. Use flat colors, simple borders, and SVG paths for visual interest instead of CSS effects. Test templates against Satori's supported property list during implementation.

### Count-Up Performance on Low-End Devices

`requestAnimationFrame` count-up on 10+ simultaneous KPI values could cause jank on low-end mobile.

**Mitigation:** Batch count-ups to start in the same frame. Use a single `requestAnimationFrame` loop that updates all active counters, not one loop per counter. Limit concurrent active counters to 8. Fall back to instant display on devices with limited animation support.

### Chart Animation + Virtual Scrolling Conflict

Recharts animations on charts inside virtualized containers (if any) could cause layout measurement issues.

**Mitigation:** Only enable chart animations on charts that are NOT inside virtualized containers. The main charts (PSI history, total mcap, peg diversity, safety overview) are all in fixed-position sections, not virtualized lists.

### OG Image Cache Invalidation

Social platform crawlers cache OG images aggressively (Twitter: up to 7 days). A stale OG image may show outdated data.

**Mitigation:** 15-min edge cache TTL ensures fresh images for new shares. For platforms with aggressive caching, this is acceptable — OG images are a snapshot, not real-time data. Users can use Twitter's Card Validator to force a refresh.

### Static Export Compatibility

The frontend is statically exported. Dynamic OG image URLs in `generateMetadata()` are embedded in HTML at build time. The URLs themselves are deterministic (`/api/og/stablecoin/:id`), so they work correctly — the social crawler fetches the image at share time, not build time.

**No risk here** — this pattern is widely used by static sites pointing OG meta to dynamic image endpoints.
