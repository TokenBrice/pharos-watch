# Lighthouse Concept Page Implementation Plan

Date: 2026-04-25
Status: Living implementation plan. The first-step `/lighthouse/` route is already in progress in the worktree; this document now separates the baseline landing implementation from the later epic story expansion.
Scope: New public concept page using Pharos visualization language

## Assumptions

- The page should be product-facing and understandable, not an internal art experiment.
- The first version should reuse existing public data and hooks. No Worker endpoint, D1 migration, cron job, scoring change, or new data provider.
- The page should be made of Pharos visualizations only. It can use compact source, legend, caveat, loading, and freshness surfaces, but it should not become another table workbench.
- The screenshot direction is a useful target for mood and composition: chains as ships, the lighthouse as Pharos inspection, and a night harbor as the overall scene.
- The page must stay honest about data relationships. It must not imply per-chain DEX routes, per-chain redemption exits, or causal PSI-to-chain effects that current payloads do not provide.

## Recommended Concept

Build **Night Watch: Fleet Under the Beam**.

The page is a visual story of what Pharos is watching right now. A lighthouse beam scans the stablecoin fleet. Ships represent the largest chain harbors by stablecoin supply. The beam is an inspection/selection device, not an extra safety score. The surrounding sky, water, fog, wakes, and labels explain current market structure using existing Pharos metrics.

This is stronger than a generic "Pharos Watch Deck" because it creates one memorable first paint, while still reusing the exact visualization vocabulary already shipped on `/chains` and `/stability-index`.

## Why This Works

- Pharos already owns the lighthouse metaphor through the brand and PSI.
- `/chains` already owns ships, harbors, cargo, wakes, draft, and dominance.
- The new page can synthesize those into a single story only if the mapping is explicit and narrower than the underlying workbench routes.
- The visual should answer: "Where is stablecoin supply concentrated, what is the market condition, and which harbor is currently being inspected?"

## Concepts Considered

1. **Night Watch / Fleet Under the Beam**
   - Best option.
   - One strong SVG hero: lighthouse, beam, top chain ships, health/fog, wakes, cargo, selected-harbor manifest.
   - Data story is clear if beam = inspection/selection.

2. **Pharos Watch Deck**
   - Lower risk because it can compose existing scenes: PSI, DEWS, harbor, atlas, flows, cemetery.
   - Weaker as a product page because it risks becoming a visual index rather than a new data story.

3. **Safe Passage Map**
   - Good if framed as chain risk navigation.
   - Risky if it starts mixing chain health, DEWS, PSI, liquidity, and redemption into one implied route score.

4. **Convoy Manifest**
   - Visually appealing but semantically weak.
   - Ships already mean chain deployments in Pharos; repurposing them for stablecoins would blur the glossary.

## Route Recommendation

Use `/lighthouse/` with page title `Pharos Lighthouse`.

Alternatives:

- `/beacon/`: less collision with PSI, but less literal and less searchable.
- `/pharos-story/`: clear as a story route, but weaker as a product surface.
- Avoid `/pharos/`: too close to brand/about semantics.

## V1 Data Scope

Use a deliberately narrow first version:

- `useChains()` from `/api/chains`
- `useStablecoins()` only if `/api/chains` lacks complete top-cargo rows; do not add it just to enrich decorative labels
- `useStabilityIndexDetail()` for global market condition copy, watch label, and later Lens Room readiness
- existing query metadata and `StaleDataBanner` style freshness semantics

Defer from v1:

- `useStressSignals()`: wait for the epic story pass unless the v1 implementation already has an honest aggregate-only use. DEWS should not appear as per-chain weather or causal pressure.
- `useDexLiquidity()`: useful, but chain supply and DEX chain TVL are different universes; using both in one fleet can imply route links that are not present.
- `useRedemptionBackstops()`: per-coin route data does not naturally map to chain ships.
- `useReportCards()`: powerful but broad; could drive a later "inspection plate" chapter.
- `useMintBurnFlows()`: useful for traffic/current direction, but it adds another universe and cadence.

## Encoding Contract

Primary scene channels, capped at 5:

| Scene Element | Data Field | Encoding |
| --- | --- | --- |
| Ship hull width | `ChainSummary.totalUsd` | log-scaled width with floor and ceiling |
| Ship order / x-position | supply rank | top chains arranged left to right by supply |
| Hull or halo color | `healthBand` | centralized chain health color tokens |
| Pennant width | dominant stablecoin share | wider pennant means more concentrated cargo |
| Wake length / direction | `change7dPct` | signed 7d supply movement, clamped |

Secondary context:

- Lighthouse beam target = selected chain, auto-cycled unless user selects/focuses.
- Sky or fog wash = aggregate chain health or PSI band, but use one source per wash. Do not combine them into an invented score.
- Small star/radar marks = aggregate DEWS pressure only in the later epic story pass, and only if they do not compete with ship encodings.
- Source/freshness rail = per-query status, not one fake global freshness label.

## Interaction

- Selection state lives in `client.tsx`, not inside the SVG scene.
- Fine pointer: hover/focus previews a ship; click pins/selects the inspected ship.
- Coarse pointer: first tap previews/pins; navigation stays on explicit route links.
- Keyboard: primary ships are focusable SVG groups or buttons; Enter/Space selects. Separate links handle route navigation.
- Auto-cycle: beam sweeps between visible ships every 7-10 seconds only under `prefers-reduced-motion: no-preference`, and yields to user selection.

## Responsive Plan

The first paint must not require horizontal scrolling.

- Desktop/tablet: one fit-to-container SVG hero with a stable aspect ratio.
- Mobile: same route renders a simplified fit-to-container harbor with 3-4 representative ships, an aggregate fleet marker, the lighthouse, beam, and compact legend.
- Full detail appears in a parallel list immediately below, modeled after `HarborList`: supply, health, dominant cargo, 7d wake, and selected state.
- Avoid copying the current `/chains` chart viewport behavior if it relies on horizontal scrolling for legibility.

## Accessibility And Motion

- SVG root: `role="img"` plus a stateful `aria-label`, for example: `Pharos Lighthouse watching 8 chain harbors, largest Ethereum, market condition STEADY`.
- Decorative layers use `aria-hidden="true"`.
- Interactive ships expose `aria-label` with chain name, supply, health, dominant cargo, and 7d change.
- Color is never load-bearing; each color-coded state has text or geometry.
- All animations are opt-in under `@media (prefers-reduced-motion: no-preference)`.
- Reduced motion freezes beam sweep, wake drift, ship bobbing, and flame flicker while preserving static labels and selected ship.

## File Plan

Create:

- `src/app/lighthouse/page.tsx`
- `src/app/lighthouse/client.tsx`
- `src/app/lighthouse/view-model.ts`
- `src/app/lighthouse/presentational.tsx` only if repeated loading/empty/error fragments justify a separate file
- `src/app/lighthouse/lighthouse-scene.tsx`
- `src/app/lighthouse/lighthouse-scene.css`
- `src/app/lighthouse/lighthouse-fleet-list.tsx`
- `src/app/lighthouse/view-model.test.ts`
- `src/app/lighthouse/lighthouse-scene.test.tsx`
- `docs/lighthouse-page.md`

Potentially change:

- `src/app/sitemap.ts` if public/indexable.
- `scripts/generate-llms-txt.ts` if this should be part of the public explanatory surface.
- `scripts/smoke-ui.mjs` to include `/lighthouse/` in local overflow smoke coverage.
- `docs/README.md` and `docs/architecture.md` to document the route.
- `docs/data-visualization.md` only if the implementation creates a reusable rule beyond the current lighthouse/harbor guidance.
- `src/lib/nav-config.ts` only if the route should be globally navigable. Prefer linking from About/Home first unless the page becomes a core product surface.

## View-Model Requirements

`buildLighthouseSceneModel(...)` should be pure TypeScript and own:

- chain sorting and visible fleet cap
- top-cargo enrichment fallback
- hull width scale
- pennant width scale
- wake scale and sign
- aggregate fleet marker
- beam target resolution
- aggregate health/fog state
- accessible scene summary string
- empty/error-friendly fallback model

Tests:

- top chains sort by `totalUsd`
- hull width is monotonic, floored, and capped
- pennant width is monotonic and capped
- wake length is sign-preserving and clamps at extreme changes
- missing health, missing dominant cargo, empty chains, and null PSI do not produce `NaN`
- deterministic layout for the same input
- selected id fallback chooses the first visible chain

## Implementation Phases

1. **Model first**
   - Build `view-model.ts` and tests.
   - Reuse math patterns from `src/app/chains/nautical-scene-math.ts`.

2. **Static scene**
   - Render lighthouse, top ships, waterline, labels, and selected manifest.
   - No animation until the static composition is legible.

3. **Interaction and mobile**
   - Add selected state, keyboard/touch parity, compact mobile SVG, and fallback fleet list.

4. **Motion and polish**
   - Add beam sweep, wake drift, flame/fog movement, all behind reduced-motion gates.

5. **Route integration**
   - Add metadata, docs, sitemap/LLM/smoke coverage only after the route shape is stable.

## Validation Plan

Targeted:

```bash
npm test -- src/app/lighthouse/view-model.test.ts src/app/lighthouse/lighthouse-scene.test.tsx
npm run check:doc-source-paths
npm run check:verified-doc-links
```

If added to LLM/public route indexes:

```bash
npm run check:llms-txt
```

Before shipping:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
npm run test:merge-gate
```

## Resolved Decisions

Resolved for the current stack:

- `/lighthouse/` should be a public, indexable route once it has route docs, sitemap coverage, LLM index coverage, and smoke coverage. It is a product-facing concept page, not an internal lab page.
- Do not add it to primary navigation in the first release. Link it from docs/about/home only after the visual route is validated, and promote it to nav later only if it becomes a durable product surface.
- In v1, PSI should affect copy/watch context only. Do not use PSI as the ambient sky/fog wash while chain health already controls harbor atmosphere.
- DEWS should wait for the epic story pass. When added, it should be aggregate horizon weather or signal flags only, not per-chain risk weather.

## Subagent Synthesis

- Visual/narrative pass ranked Night Watch as the strongest concept and warned that beam semantics must be inspection/selection, not both inspection and safety.
- Data pass identified `/api/chains` as the backbone and warned about universe mismatches between chains, report cards, DEX liquidity, stress signals, and redemption backstops.
- Implementation pass recommended route-local files under `src/app/lighthouse/`, a pure view-model, existing hooks, public route docs/index updates, and Pages validation.
- Responsive/accessibility pass required a fit-to-container first paint, a parallel mobile list, SVG/CSS-only rendering, reduced-motion safeguards, and explicit copy to prevent metaphor collision.

## Next-Stage Epic Story Direction

Status: Post-v1 preparation. Do not replace the first-step harbor scene; extend it into a chaptered story once the current `/lighthouse/` route is stable.

Recommended title: **The Watch at Pharos**.

The page should feel like taking the night watch inside the Great Lighthouse of Alexandria. The user ascends from the harbor to the lens room, reads market weather from the horizon, and ends at the harbor master's ledger where the story resolves back into exact Pharos data. This should feel almost game-like through inspection, discovery, state changes, and chapter progression, not through invented points, quests, battles, or fake danger states.

### Success Criteria

- The first viewport remains a fit-to-container, immediately legible lighthouse harbor scene with no horizontal scrolling.
- The page has a clear beginning, middle, and end: harbor below, lens room, storm watch, ledger, and onward routes.
- Every dramatic element maps to one existing data source and exposes its exact numeric reading nearby.
- The current v1 model, scene, fleet list, and freshness surfaces remain useful and are not discarded.
- The result feels distinct from a normal dashboard while still reading as Pharos: precise, data-dense, calm by default, urgent only when the underlying state is urgent.

### Narrative Chapters

1. **Harbor Below**
   - Keep the existing `Night Watch: Fleet Under the Beam` scene.
   - Role: establish the live market geography.
   - Data: `/api/chains`.
   - Interaction: select a chain harbor, pin the beam, inspect supply, dominant cargo, health, and 7d wake.

2. **Lens Room**
   - Show the lighthouse mechanism that powers the beam.
   - Role: explain current market condition without turning the beam into a hidden safety score.
   - Data: `/api/stability-index?detail=true`, through existing `useStabilityIndexDetail()`.
   - Encoding: PSI score controls light reach/brightness; PSI band controls lens color; PSI components appear as calibrated shutter slats or lens rings.
   - Constraint: the beam still means inspection globally. Only this chapter may explicitly say the light source is PSI.

3. **Storm Watch**
   - Place DEWS pressure as distant horizon weather, radar marks, or signal flags.
   - Role: show market stress as aggregate weather beyond the harbor.
   - Data: `useStressSignals()` or current stress-signal aggregate helpers only if the payload supports an honest summary.
   - Encoding: count/severity of aggregate alert states controls horizon flashes or signal flags.
   - Constraint: do not draw storm lines toward specific chains unless the data is actually chain-specific.

4. **Harbor Master's Ledger**
   - Turn the selected scene state into dense product utility.
   - Role: pay off the visual story with exact values, freshness, and navigation.
   - Data: same chain model plus query metadata and route links.
   - Encoding: compact manifest panels, source/freshness rail, and explicit caveats.
   - Constraint: this is not a decorative fallback; it is the linear, assistive-tech-first version of the scene.

5. **Dawn Orders**
   - End with action paths into the product.
   - Role: route users to deeper workbenches after the story.
   - Links: selected chain detail, `/chains/`, `/stability-index/`, `/depeg/`, and possibly `/start/`.
   - Constraint: avoid a marketing CTA block. It should feel like a control-room handoff.

### Interaction Model

- Use a route-local `chapter` state with keyboard-accessible chapter controls.
- Use scroll position only as progressive enhancement. The controls must be sufficient without scroll-driven animation.
- Fine pointer:
  - hover/focus previews a ship or chapter hotspot
  - click pins the inspected harbor or advances a chapter
  - explicit `Open` links navigate to workbench routes
- Coarse pointer:
  - first tap previews/pins
  - second tap on an explicit action navigates
- Keyboard:
  - chapter controls are normal buttons or tabs
  - ships remain focusable and expose exact labels
  - Enter/Space selects; route navigation stays on explicit links
- Ambient auto-cycle may continue only in Harbor Below, under `prefers-reduced-motion: no-preference`, and must stop once the user pins a selection.

### Data-To-Metaphor Contract

| Story Element | Meaning | Allowed Data |
| --- | --- | --- |
| Tower | Pharos product and monitoring vantage point | Static brand metaphor only |
| Beam | Current inspection target / selected harbor | selected chain id |
| Light brightness or reach | Market condition | PSI score only |
| Lens color | Market condition band | PSI band only |
| Ships / harbors | Chain-level stablecoin supply distribution | `/api/chains` |
| Hull mass | Chain supply | `ChainSummary.totalUsd` |
| Cargo / pennant / draft | Dominant stablecoin concentration | `dominantStablecoin.share` / derived cargo fields |
| Wake | Recent chain supply movement | `change7dPct` |
| Fog or sky wash | One aggregate state at a time | either chain-health aggregate or PSI, not a blend |
| Storm flashes / signal flags | Aggregate market stress | DEWS/stress-signal aggregate only |
| Ledger | Exact product data and caveats | query data plus freshness metadata |

### Implementation Shape

Keep the route-local architecture and add layers instead of replacing the scene:

- Extend `src/app/lighthouse/view-model.ts` with a `story` or `chapters` model after v1 lands.
- Add `src/app/lighthouse/lighthouse-story-shell.tsx` for chapter controls and layout.
- Add `src/app/lighthouse/lens-room-panel.tsx` for PSI lens/shutter visuals.
- Add `src/app/lighthouse/storm-watch-panel.tsx` only if stress-signal data can be summarized honestly.
- Add `src/app/lighthouse/harbor-ledger.tsx` by evolving the selected manifest and fleet list.
- Keep CSS in `src/app/lighthouse/lighthouse-scene.css` or split to `lighthouse-story.css` if the file becomes hard to scan.

Model first:

- `buildLighthouseStoryModel(...)` should compose the current scene model plus optional PSI and stress chapters.
- The model should explicitly mark unavailable chapters rather than fabricating placeholders.
- Tests should cover null PSI, missing stress data, empty chain data, selected id fallback, chapter availability, and no-`NaN` geometry.

### Visual Direction

- Use Alexandria as structure, not costume: stone tower, lens, harbor, horizon, ledger.
- Avoid generic Web3 lighting, purple glass, decorative sci-fi, or cosplay details that do not encode data.
- Prefer dark stone, moonlit water, frost-blue accents, PSI semantic colors, and precise mono numeric overlays.
- Keep the scene authored and memorable, but keep cards and panels dense, restrained, and Pharos-native.

### Accessibility And Motion Requirements

- Every chapter must have a static equivalent with equal information content.
- Animated beam, water, flame, fog, lens shutters, and horizon signals must be gated behind `prefers-reduced-motion: no-preference`.
- Color is never load-bearing; pair color with labels, geometry, or numeric text.
- SVG scenes need chapter-specific `aria-label`s.
- Interactive marks need exact labels: name, supply, share, band, and movement.
- The ledger must appear in normal DOM order after the scene and remain useful without JavaScript animation.

### Avoid

- Do not make the lighthouse judge coins unless an exact Pharos score behind that judgment is shown.
- Do not turn ships into stablecoins; ships already mean chain harbors in Pharos.
- Do not draw redemption routes, liquidity exits, contagion arcs, or causal paths unless the current payload supports them.
- Do not mix chain health, PSI, DEWS, liquidity, and redemption into one hidden composite score.
- Do not hide source/freshness/caveat information below spectacle.

### Next Implementation Order

1. Let the current first-step route stabilize and pass its local tests.
2. Add chapter shell state and static copy without new data sources.
3. Add the Lens Room using PSI data already fetched by the client.
4. Add the Ledger handoff and route links.
5. Add Storm Watch only if the stress-signal aggregate can be represented without false causality.
6. Run Playwright/mobile screenshots before any publish decision, because this page depends on first-paint composition.

## Precise Baseline Acceptance Gate

Before starting the epic expansion, the current v1 route should meet this gate:

- Route renders under `FeaturePageShell` via `createClientFeaturePage`.
- First paint shows the harbor/lighthouse scene and at least a hint of the manifest/fleet list below on desktop and mobile.
- Scene uses no horizontal scroll wrapper.
- Ships are selectable with pointer and keyboard.
- Navigation to chain detail happens only through explicit route links, not accidental SVG group activation.
- Auto-cycle pauses after user selection and is disabled under reduced motion.
- Empty/error states do not throw and do not render misleading fake ships.
- `StaleDataBanner` receives separate query metadata for chains and PSI.
- The route doc explains the metaphor and caveats without becoming methodology documentation.
- Sitemap, LLM index, public docs registry, docs index, and smoke coverage are updated only if the route is public/indexed in the same stack.

Minimum local validation for this gate:

```bash
npm test -- src/app/lighthouse/view-model.test.ts src/app/lighthouse/lighthouse-scene.test.tsx src/app/lighthouse/page.test.tsx
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run check:llms-txt
```

If route indexing or smoke files changed, also run:

```bash
npm run build
npm run seo:check
npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local
```

## Epic Expansion Specification

The epic page should be implemented as a deterministic story model plus route-local presentation components. The model owns chapter availability and exact copy inputs; components should not infer availability from partial payloads.

### Story Model Shape

Add a pure builder after v1:

```ts
buildLighthouseStoryModel({
  scene,
  stabilityIndex,
  stressSignals,
  activeChapterId,
  selectedId,
}): LighthouseStoryModel
```

Expected model fields:

- `chapters`: ordered chapters with `id`, `label`, `kicker`, `summary`, `status`, and `ariaLabel`.
- `activeChapter`: resolved chapter, falling back to `harbor`.
- `harbor`: the existing `LighthouseSceneModel`.
- `lens`: nullable PSI lens model with score, band, component slats, light reach, and caveat.
- `storm`: nullable DEWS aggregate model with band counts and freshness caveat.
- `ledger`: selected-harbor facts plus action links.
- `dawnOrders`: route links with labels, hrefs, and why they are relevant.
- `unavailableReasons`: explicit reasons for omitted chapters, for example `psi-unavailable` or `stress-signals-unavailable`.

Do not compute new risk, safety, passage, route, redemption, or liquidity scores in this model.

### Chapter Availability Rules

| Chapter | Required Data | If Missing |
| --- | --- | --- |
| Harbor Below | non-empty `/api/chains` rows | render empty harbor state plus source/error copy |
| Lens Room | `stabilityIndex.current` | show disabled chapter with "PSI unavailable" copy; do not invent neutral PSI |
| Storm Watch | `stressSignals.signals` with at least one parsed entry | hide or disable chapter; do not show decorative storms |
| Harbor Master's Ledger | selected or fallback visible ship | render empty ledger state if no chains |
| Dawn Orders | static route links plus selected chain when available | omit selected-chain link only |

### PSI Lens Encoding

Use only fields from `StabilityIndexCurrent`:

- `score`: light reach and numeric label.
- `band`: lens color through existing PSI color helpers.
- `components.severity`: first shutter/slat.
- `components.breadth`: second shutter/slat.
- `components.stressBreadth`: optional third shutter/slat; label as DEWS contribution only if present.
- `components.trend`: fourth shutter/slat.
- `computedAt` and methodology version: compact source/freshness line.

Clamp component visuals independently. Do not normalize the components into a new total beyond the published PSI score.

### DEWS Storm Encoding

Use aggregate counts only:

- `DANGER`, `ALERT`, and `WARNING` counts can drive three horizon signal intensities.
- `updatedAt`, `oldestComputedAt`, and query metadata drive the freshness/caveat rail.
- `malformedRows` can show a compact caveat if non-zero.

Do not place DEWS marks on chain ships, do not connect them to selected harbors, and do not imply the selected chain caused the storm.

### Component Plan For Epic Pass

Create only after the baseline route lands:

- `src/app/lighthouse/story-model.ts`
- `src/app/lighthouse/story-model.test.ts`
- `src/app/lighthouse/lighthouse-story-shell.tsx`
- `src/app/lighthouse/lens-room-panel.tsx`
- `src/app/lighthouse/storm-watch-panel.tsx`
- `src/app/lighthouse/harbor-ledger.tsx`
- `src/app/lighthouse/dawn-orders.tsx`
- `src/app/lighthouse/lighthouse-story.css` only if story styles make `lighthouse-scene.css` difficult to scan

Prefer route-local components over shared abstractions until a second route needs the same pattern.

### Layout Contract

- Top fold: story controls and the harbor scene, with the next content peeking below.
- Desktop: two-zone composition is allowed only if the scene remains dominant and the ledger does not become a nested card stack.
- Mobile: chapter controls become a horizontally scrollable tab row or compact segmented control; the scene still scales to container width.
- No visible feature tutorial copy. Labels should name the data state, not explain how to use the page.
- No cards inside cards. Use unframed full-width story bands or single shells for repeated ledger rows.

### Epic Interaction Details

- `activeChapterId` should live in `client.tsx` or a route-local story shell, not inside the SVG.
- Chapter controls should be `button` or tab semantics. They must work without scroll observation.
- Optional scroll sync can update active chapter only after the controls work.
- Ship selection is global across chapters: choosing a harbor in Chapter 1 updates the ledger and selected-chain action in later chapters.
- The selected ship remains selected when moving between chapters.
- Reduced motion freezes ambient animation and disables auto-advance; it should not remove content or chapter controls.

### Epic Tests

Add focused tests before polishing animation:

- `story-model.test.ts`: chapter ordering, active fallback, PSI null handling, DEWS null handling, band count aggregation, no NaN values.
- `lighthouse-story-shell.test.tsx`: chapter controls switch visible chapter and expose accessible names.
- `lens-room-panel.test.tsx`: PSI score/band/components render as exact text and clamped visuals.
- `storm-watch-panel.test.tsx`: warning/alert/danger counts render and missing stress data disables the chapter.
- Existing v1 tests must remain green.

### Visual QA Checklist

Use Playwright screenshots before shipping the epic pass:

- Desktop 1440x1000: first paint shows harbor, tower, selected state, and next-section hint.
- Laptop 1280x800: no overlap between header, scene labels, caption, and ledger.
- Mobile 390x844: no horizontal scrolling; scene labels do not collide; chapter controls remain tappable.
- Reduced motion emulation: no animated beam sweep, fog drift, water drift, or auto-cycle.
- Light mode: semantic labels and PSI/DEWS colors remain readable.

### Shipping Boundary

The epic pass is still Pages-only unless it adds or changes Worker/API data. If it only consumes existing hooks and edits route/docs/static indexes, the expected gate is Pages build, SEO, UI smoke, and merge gate. If it adds any new endpoint, cron, cache, D1 table, or methodology behavior, stop and write a separate backend/methodology plan first.
