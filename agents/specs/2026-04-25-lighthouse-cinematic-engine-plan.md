# Lighthouse Cinematic Engine Implementation Plan

Date: 2026-04-25
Status: Refined implementation plan. No application code has been changed by this plan pass.
Scope: Transform `/lighthouse/` from the current chaptered dashboard scene into a cinematic, full-page, mostly textless visualization experience.

## Review Summary

The current plan is directionally correct but not yet implementation-ready. It identifies the right source systems (`/chains`, DEWS, PSI, alt-pegs) and the right Pharos standards (`docs/data-visualization.md`), but it needs sharper contracts in five places:

- **No-text contract:** the prior version said "no visible explanatory copy" but did not define what visible text is allowed, what must move to `sr-only`, and how auditability survives.
- **Cutover path:** it did not explicitly say which current `/lighthouse/` files should be retired, replaced, or preserved.
- **Model architecture:** it named a root model but did not pin down exact model fields, floors, caps, and null behavior.
- **Layer engine:** it listed components but did not define layout geometry, z-order, mode behavior, and layer caps precisely enough for implementation.
- **Acceptance gates:** it had validation commands, but not a definition of done for first paint, responsiveness, reduced motion, and non-overclaim.

This refined plan resolves those gaps.

## Assumptions

- "Pure no text" means no persistent visible prose, headings, chapter tabs, metric cards, captions, or ledger copy in the primary cinematic viewport.
- The app must still keep one semantic `h1`, route metadata, `BreadcrumbJsonLd`, SVG `aria-label`s, keyboard labels, and an accessible data fallback.
- A small-screen fallback list may contain text below the visual stage if the scene cannot remain data-complete on narrow viewports. That is an accessibility/responsiveness exception, not part of the cinematic stage.
- The route should reuse existing public data and hooks: `useChains()`, `useStabilityIndexDetail()`, `useStressSignals()`, and `useStablecoins()`.
- No Worker endpoint, D1 migration, cron change, scoring change, new data source, or methodology bump is needed.
- The `/chains/` lighthouse and harbor language is the visual base, but `/lighthouse/` should place the lighthouse at the center of the experience, not copy the right-edge `/chains/` composition.

## Verified Current State

- `src/app/lighthouse/page.tsx` uses `createClientFeaturePage()`, which renders visible breadcrumb, page title, beta badge, and lead copy. This is incompatible with a textless cinematic first viewport.
- `src/app/lighthouse/client.tsx` already fetches chains, PSI detail, and stress signals in parallel. It should remain the orchestration point, but its output should feed a new cinematic model instead of story chapters.
- `src/app/lighthouse/lighthouse-story-shell.tsx` renders visible chapter prose, tabs, panel headers, and status pills. It should be removed from the primary route.
- `src/app/lighthouse/lighthouse-scene.tsx` is SVG-based but still has visible map labels, a selected manifest card, and a caption block. It can supply useful ideas, but the final stage should be a new renderer.
- `src/app/chains/nautical-chart.tsx` contains the strongest lighthouse base and ship vocabulary. The lighthouse geometry is nested inside the chart component, so reuse requires extraction or a route-local port.
- `src/app/chains/harbor-map.ts` and `src/app/chains/nautical-scene-math.ts` already provide the chain harbor model, log-scaled hulls, cargo capacity, depth layers, wake length, aggregate fog state, and sweep helper expected by `docs/data-visualization.md`.
- `src/components/dews-summary-model.ts` provides reusable DEWS geometry, counts, pointer behavior, and freshness helpers. The card component `DEWSSummary` should not be embedded because it brings text-heavy chrome.
- `src/lib/alt-peg-hero.ts`, `src/lib/alt-peg-sizing.ts`, and `src/lib/alt-peg-packing.ts` provide the pure alt-peg model and sizing logic. The existing atlas renderer is too page-specific and text-heavy for direct embedding.

## Target Experience

Build **Pharos Night Engine**.

The first viewport is one continuous SVG stage:

- Central Pharos lighthouse on a rocky island.
- A Fresnel lens and beam that inspect the selected market target.
- Chain harbors as ships and small islands arranged around the lighthouse.
- DEWS radar as storm/radar energy in the sky or lens field.
- Alt-peg map as a cartographic beam projection or distant peg archipelago.
- Icon-only controls and direct manipulation, with visible text deferred to explicit interaction, fallback surfaces, or assistive technology.

The scene should feel cinematic, but the data grammar must stay strict: every visible mark maps to a current Pharos field.

## No-Text Contract

### Forbidden In The Primary Stage

- Visible route title, lead paragraph, breadcrumb, beta badge, chapter tabs, chapter summaries, captions, status pills, metric cards, and persistent legends.
- Always-on SVG text labels for ship names, PSI labels, DEWS counts, alt-peg cohort names, or explanatory annotations.
- Tooltip text that appears on hover without user intent if it becomes the main reading path.

### Allowed

- `sr-only` semantic `h1`.
- `BreadcrumbJsonLd`.
- SVG `<title>` and `aria-label` values.
- Icon-only controls with accessible labels.
- Focus rings, selection rings, hit targets, logos, symbols embedded as images, colors, geometry, motion, and atmospheric marks.
- A detail drawer or overlay after explicit selection. If used, it must not be visible on first paint.
- A compact fallback list below the stage on small screens or for accessibility parity.

### Auditability Rule

Because `docs/data-visualization.md` normally expects visible labels, legends, and caveats, this route needs a compensating audit surface:

- `LighthouseA11yLedger` provides exact values in DOM.
- Optional explicit "open ledger" icon can reveal those values.
- The route docs must state that the cinematic stage suppresses persistent labels by design while preserving semantic and fallback data.

## Success Criteria

- First paint is a full immersive visual stage with the lighthouse centered and no permanent visible text inside the stage.
- The standard feature shell is gone from `/lighthouse/`; route metadata and semantic structure remain.
- No horizontal scrolling at desktop, tablet, or mobile widths.
- The visual includes the `/chains` lighthouse/harbor base, DEWS radar, and alt-peg projection in one coherent scene.
- Every primary mark maps to one existing data field and has an explicit null fallback.
- No visual implies a new score, per-chain DEWS causality, or redemption/liquidity routing that is not in the payload.
- Motion is CSS-only, reduced-motion safe, and does not carry information by itself.
- Fine pointer, coarse pointer, keyboard, and reduced-motion interaction paths are complete.
- Playwright screenshots show a nonblank, correctly framed scene at desktop, tablet, and mobile widths.

## Data Source Contract

| System | Existing Source | Use In Stage | Must Not Imply |
| --- | --- | --- | --- |
| Chain harbors | `useChains()` / `/api/chains` | ship/island rank, size, wake, health, cargo concentration | issuer redemption route, DEX depth, per-chain depeg pressure |
| PSI lens | `useStabilityIndexDetail()` | beam reach, lens brightness, lens color | a new route-level lighthouse score |
| DEWS radar | `useStressSignals()` | aggregate storm/radar field and blips | chain-specific DEWS assignment |
| Alt-pegs | `useStablecoins()` + `buildPegDiversityHero()` | peg map projection and non-USD peg islands | chain distribution or safety quality |

## Data Encoding Contract

| Layer | Field | Encoding | Scale/Fallback |
| --- | --- | --- | --- |
| Lighthouse lens | PSI `score` | beam reach and opacity | clamp 0-100; unavailable = static neutral beam |
| Lighthouse lens | PSI `band` | lens/beam hue | `PSI_HEX_COLORS`; unknown = neutral |
| Chain fleet | `totalUsd` | ship hull width or island mass | log scale via `hullWidth()` with floor/ceiling |
| Chain fleet | supply rank | angular/orbital position around lighthouse | deterministic sorted order |
| Chain fleet | `healthBand` | hull/lantern halo color | `HEALTH_HEX_FILL`; null = unrated neutral |
| Chain fleet | `dominantStablecoin.share` | pennant width, draft layer, or cargo density | clamp 0-100 |
| Chain fleet | `change7dPct` | wake direction/length | `wakeLength()` with dead zone and cap |
| Tail fleet | remaining supply and count | distant horizon lights | aggregate only |
| DEWS | highest threat band | radar hue and sweep duration | existing `highestBand()`/`sweepDuration()` fallback to calm |
| DEWS | elevated signals | blips or storm needles | use existing position helpers; malformed rows ignored |
| Alt-pegs | non-USD market cap | island/glyph size | `coinEmblemSize()` with existing floor/ceil |
| Alt-pegs | peg currency | island/glyph hue | `PEG_CHART_COLORS`; unknown = neutral |

## Recommended Architecture

```text
src/app/lighthouse/
  page.tsx                         # bespoke route shell, no FeaturePageShell chrome
  client.tsx                       # query orchestration and interaction state
  cinematic-model.ts               # pure root model
  cinematic-model.test.ts          # model invariants
  lighthouse-stage.tsx             # SVG stage renderer
  lighthouse-stage.test.tsx        # structural and interaction tests
  lighthouse-stage.css             # responsive stage + CSS keyframes
  lighthouse-a11y-ledger.tsx       # sr-only / compact fallback data
  layers/
    atmosphere-layer.tsx
    pharos-tower-layer.tsx
    harbor-fleet-layer.tsx
    dews-radar-layer.tsx
    alt-peg-projection-layer.tsx
    stage-controls-layer.tsx
```

Retire these from the primary route after replacement coverage exists:

- `lighthouse-story-shell.tsx`
- `lens-room-panel.tsx`
- `storm-watch-panel.tsx`
- `harbor-ledger.tsx`
- `dawn-orders.tsx`
- their tests, unless portions are reused by the fallback ledger

Keep or adapt:

- `client.tsx` as orchestration.
- `view-model.ts` only if preserving it reduces churn; otherwise replace with `cinematic-model.ts`.
- `lighthouse-fleet-list.tsx` only as the small-screen fallback, not as always-visible desktop content.

## Precise Model Shape

The root builder should accept raw hook data and produce a presentation-ready object:

```ts
export interface LighthouseCinematicModel {
  stage: {
    viewBox: { width: 1440; height: 900 };
    sceneLabel: string;
    mode: "watch" | "radar" | "atlas";
    selectedHarborId: string | null;
    activeTarget: { x: number; y: number } | null;
    hasCompleteData: boolean;
  };
  lens: {
    score: number | null;
    band: string | null;
    colorHex: string;
    beamReachPct: number;
    beamOpacity: number;
    sweepDurationSec: number;
  };
  harbors: {
    visible: LighthouseHarborMark[];
    tail: LighthouseTailMark | null;
    fogBand: "sun" | "fog";
    largestId: string | null;
  };
  radar: {
    highestBand: ThreatBand;
    sweepDurationSec: number;
    bandCounts: Record<ThreatBand, number>;
    elevated: LighthouseDewsMark[];
    calmDensity: number;
  };
  altPeg: {
    clusters: LighthousePegCluster[];
    skyCohorts: LighthousePegCohort[];
    visibleCoinCount: number;
  };
  fallbackRows: LighthouseLedgerRow[];
}
```

Model tests must cover:

- deterministic output for identical inputs
- sorted chain rank and selected fallback
- all size floors and ceilings
- null PSI produces neutral lens values
- unknown chain health produces neutral color
- malformed DEWS rows are ignored
- empty stablecoin list produces an empty but renderable alt-peg projection
- no field returns `NaN`, `Infinity`, or negative dimensions

## Stage Layout

Use a single root SVG with `viewBox="0 0 1440 900"` unless implementation proves another aspect ratio materially better.

Recommended coordinate system:

- Lighthouse base: `x=720`, `y=585`, scale `1.15`.
- Waterline: `y=635`.
- Main harbor orbit: ellipse centered at `(720, 600)`, radius `x=520`, `y=150`.
- Top 8 harbor marks: angular span from 205 degrees to 335 degrees, ranked by supply with largest closest to beam's default sweep path.
- Tail fleet: small lights along far horizon around `y=430`.
- DEWS radar: centered behind lens at `(720, 300)`, radius 230, low opacity except in radar mode.
- Alt-peg projection: clipped inside beam cone or placed as far archipelago between `x=180..1260`, `y=170..360`, low opacity except in atlas mode.

The stage should scale by container, not by horizontal scroll:

- desktop: full available content column, min height around `calc(100svh - 7rem)`
- tablet: preserve full viewBox and increase hit-target scale
- mobile: simplify visible harbor cap to 4 plus aggregate tail; expose fallback ledger below

## Layer Contracts

### `AtmosphereLayer`

- Draws sky, water, stars, haze, sea grid, and island shadows.
- Uses only atmospheric colors; no data color unless passed as a low-opacity ambient wash.
- No visible text.
- `aria-hidden="true"`.

### `PharosTowerLayer`

- Starts from the `/chains/` lighthouse geometry.
- Preferred path: extract a parameterized shared `PharosLighthouseBase` only if `/chains/` remains pixel-stable enough.
- Safer first path: port the geometry route-locally, then extract in a later cleanup if duplication becomes meaningful.
- Props include `origin`, `scale`, `beamTarget`, `lensColor`, `beamReachPct`, `beamOpacity`, and `reducedMotion`.
- Owns tower, rock, flame, lens rings, and beam shapes only.

### `HarborFleetLayer`

- Owns chain ships/islands, cargo marks, wakes, draft/reflection, and selected ring.
- No ship name text in the cinematic stage.
- Primary marks are focusable SVG groups with `role="button"`, `tabIndex={0}`, `aria-label`, `aria-pressed`, and `data-harbor-id`.
- The selected harbor receives redundant visual encoding: beam target, halo, focus ring, and wake emphasis.

### `DewsRadarLayer`

- Uses DEWS pure helpers and classification tokens.
- Draws rings, sweep arc, elevated blips, calm star density, and storm glows.
- Blips do not attach to ships.
- In watch mode, the radar is ambient. In radar mode, it becomes brighter and ships dim slightly.
- No labels or counts in the SVG.

### `AltPegProjectionLayer`

- Uses `buildPegDiversityHero()` output.
- Renders non-USD pegs as a projection, not a separate card.
- In watch mode, it is subtle. In atlas mode, it brightens and DEWS dims.
- Cap visible coin glyphs per cluster to avoid clutter; remaining coins aggregate into orbit dust or island lights.
- No cohort text in the SVG.

### `StageControlsLayer`

- Icon-only controls for modes: watch, radar, atlas, ledger.
- Use existing icon library patterns in implementation.
- Buttons require accessible labels and visible focus rings.
- Controls should be visually subordinate: small, edge-aligned, and not card-like.

### `LighthouseA11yLedger`

- Provides exact values hidden from the main visual stage.
- Desktop default: `sr-only`.
- Mobile or explicit ledger mode: compact list below or overlay.
- Includes: selected harbor facts, top harbor rows, PSI score/band, DEWS band counts, top non-USD peg cohorts, freshness status.

## Interaction State Machine

State lives in `client.tsx`:

```ts
type LighthouseMode = "watch" | "radar" | "atlas";

interface LighthouseInteractionState {
  mode: LighthouseMode;
  selectedHarborId: string | null;
  previewHarborId: string | null;
  pinned: boolean;
  finePointer: boolean;
}
```

Rules:

- Initial selected harbor is the largest visible harbor.
- Auto-cycle runs only in `watch` mode, only with no manual pin, and only under `prefers-reduced-motion: no-preference`.
- Hover/focus sets `previewHarborId` on fine pointers.
- Click, Enter, or Space sets `selectedHarborId` and `pinned=true`.
- Coarse pointer first tap selects/pins; route navigation, if offered, must be an explicit icon control.
- Changing to radar or atlas mode does not clear selected harbor.
- Escape exits an open ledger/detail overlay if one exists; it does not reset selection.

## Motion Plan

### Signature Motion

- **Beam sweep:** slow inspection sweep, then settle toward selected harbor.
- **Lens rotation:** subtle Fresnel glint loop keyed to PSI availability.
- **Radar sweep:** DEWS-derived duration from existing helper.

### Secondary Motion

- Ship bob and wake drift.
- Pennant flutter.
- Water shimmer and island reflection.
- Alt-peg projection shimmer or orbital drift.
- Tail-fleet lantern pulses.

### Timing Rules

- Hover/focus feedback: 160-220ms.
- Mode transitions: 260-360ms.
- Beam settle: 600-900ms, but nonblocking.
- Ambient loops: 5-18s.
- Use `cubic-bezier(0.22, 1, 0.36, 1)` or shared motion tokens. No bounce/elastic curves.

### Reduced Motion Rules

- No auto-cycle.
- No beam sweep, radar sweep, water shimmer, bobbing, flutter, or pulsing.
- Beam stays pointed at selected harbor.
- Radar rings and blips remain visible.
- Alt-peg projection remains visible.
- No element may become invisible because animation is disabled.

## Responsive Strategy

Desktop:

- Full cinematic stage inside content area.
- No persistent visible text.
- Icon controls may sit over a corner or edge.

Tablet:

- Same SVG viewBox.
- Larger hit targets.
- Cap visible harbor marks if overlap appears.

Mobile:

- Preserve the lighthouse-first stage.
- Visible harbor cap can drop to 4 plus aggregate tail.
- Show the compact fallback ledger below the stage for exact values.
- No horizontal scrolling.
- Test at 390px and 430px widths.

## Implementation Sequence

1. **Route shell cutover**
   - Replace `createClientFeaturePage()` with a bespoke route component.
   - Add `sr-only` `h1`, `BreadcrumbJsonLd`, and dynamic client loading.
   - Remove visible route title/lead/chapter chrome from first paint.

2. **Root model**
   - Add `cinematic-model.ts` and tests.
   - Compose existing harbor, DEWS, PSI, and alt-peg helpers.
   - Add explicit neutral fallbacks.

3. **Static stage**
   - Add `lighthouse-stage.tsx`, layer files, and CSS.
   - Render static atmosphere, tower, fleet, radar, and alt-peg projection.
   - Prove desktop first paint before adding motion.

4. **Interaction**
   - Wire selection, preview, mode controls, keyboard activation, and coarse-pointer behavior.
   - Add `LighthouseA11yLedger`.

5. **Motion**
   - Add beam, lens, radar, water, wake, pennant, and projection animation behind reduced-motion gates.
   - Re-test reduced motion after every animation group.

6. **Retire story components**
   - Remove story shell/panels once replacement tests pass.
   - Keep any useful formatting helpers only if they remain used by fallback ledger.

7. **Docs and route contract**
   - Update `docs/lighthouse-page.md` to describe the cinematic route, no-text contract, data sources, and fallback ledger.
   - Update `docs/architecture.md` and `docs/README.md` if they reference old route shape.
   - Do not change methodology docs unless scoring/data definitions change.

8. **Visual verification**
   - Run local dev/build artifact.
   - Capture desktop/tablet/mobile screenshots.
   - Check `/chains/` too if lighthouse extraction touched it.

## Acceptance Checklist

- [ ] `/lighthouse/` first viewport has no visible route heading, lead text, tabs, cards, captions, or legends.
- [ ] One semantic `h1` still exists.
- [ ] Root SVG has `role="img"` and a meaningful `aria-label`.
- [ ] All primary marks have keyboard parity.
- [ ] No horizontal scroll at 390px, 430px, 768px, 1024px, and desktop widths.
- [ ] Reduced-motion mode is static, legible, and nonblank.
- [ ] Chain fleet, DEWS radar, PSI lens, and alt-peg projection all render from current hooks.
- [ ] Empty/error states do not produce broken geometry or invisible content.
- [ ] No per-chain DEWS, route score, or unsupported liquidity/redemption implication appears in visual or copy.
- [ ] `docs/lighthouse-page.md` reflects the final behavior.

## Validation Commands

Targeted:

```bash
npm test -- src/app/lighthouse/cinematic-model.test.ts src/app/lighthouse/lighthouse-stage.test.tsx
npm test -- src/app/chains/nautical-scene-math.test.ts src/components/__tests__/dews-summary.test.tsx src/lib/__tests__/alt-peg-hero.test.ts
npm run check:doc-source-paths
npm run check:verified-doc-links
```

Before shipping:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run test:merge-gate
```

Visual:

- Playwright desktop screenshot for `/lighthouse/`.
- Playwright tablet screenshot for `/lighthouse/`.
- Playwright mobile screenshot for `/lighthouse/`.
- Reduced-motion screenshot for `/lighthouse/`.
- `/chains/` screenshot if shared lighthouse extraction is performed.

## Risk Register

| Risk | Why It Matters | Mitigation |
| --- | --- | --- |
| Textless scene becomes unauditable | Pharos visualizations must remain precise | Hidden ledger, explicit fallback, aria labels, route docs |
| DEWS appears chain-specific | Current data is aggregate stablecoin stress | Keep radar spatially separate from ships |
| Alt-peg projection clutters stage | Too many small marks can dilute the lighthouse | Cap visible marks, aggregate tail, brighten only in atlas mode |
| Shared lighthouse extraction regresses `/chains` | The existing chart is already shipped | Prefer route-local port first, or verify `/chains` screenshot/test |
| Animation overwhelms power users | Pharos is calm by default | One signature motion plus restrained ambient loops; reduced-motion support |
| Mobile loses data parity | Textless visuals compress poorly | Show compact fallback ledger below stage on mobile |

## Out Of Scope

- New "lighthouse score" or any new composite score.
- Per-chain DEWS attribution.
- New Worker endpoints, D1 tables, cron jobs, or upstream providers.
- Three.js, canvas, GSAP, Framer Motion, or new animation dependencies.
- Global app-shell redesign or primary navigation promotion.
