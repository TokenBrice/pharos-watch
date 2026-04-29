# PharosVille ClaudeVille-Informed Design Enhancement Plan

Date: 2026-04-29  
Status: reviewed implementation plan  
Scope: `/pharosville/` design and implementation planning only

## Sources Reviewed

- `/home/ahirice/Documents/git/claude-ville/agents/handover/claudeville-type-design-handover.md`
- ClaudeVille supporting notes:
  - `docs/visual-experience-crafting.md`
  - `docs/motion-budget.md`
  - `scripts/sprites/generate.md`
  - `docs/pixellab-reference.md`
  - `claudeville/src/presentation/character-mode/README.md`
  - `claudeville/src/presentation/shared/README.md`
- Pharos docs:
  - `docs/architecture.md`
  - `docs/api-reference.md`
  - `docs/testing.md`
  - `docs/worker-and-api-limits.md`
  - `docs/design-context.md`
  - `docs/design-language.md`
  - `docs/design-tokens.md`
  - `docs/data-visualization.md`
  - `docs/pharosville-page.md`
- Current PharosVille implementation:
  - `src/app/pharosville/**`
  - `public/pharosville/assets/manifest.json`
  - `scripts/pharosville/validate-assets.mjs`
  - `tests/visual/pharosville.spec.ts`
- Prior PharosVille planning notes:
  - `agents/pharosville-island-redesign-plan-2026-04-29.md`
  - `agents/pharosville-thematic-buildings-research-2026-04-29.md`

## Assumptions

- This plan is for future implementation. It should not apply code changes by itself.
- PharosVille remains a desktop-only route with the hard viewport gate: below `1280px` wide or `760px` tall, no world queries, canvas runtime, manifest fetches, or sprite decoding should mount.
- Canvas 2D remains the renderer. PixiJS/WebGL remains rejected for PharosVille because of CSP constraints already documented in `docs/architecture.md`.
- No new Worker endpoints, D1 migrations, data providers, supply overrides, methodology changes, or mobile canvas support are in scope.
- Existing Pharos design rules still govern the work: dark-first, precise, semantic color, no generic Web3 gradients/glass, and exact data in DOM.
- The current worktree already contains PharosVille implementation changes. This plan treats those files as the working baseline and avoids assumptions that earlier committed docs may still describe the live branch exactly.

## Success Criteria

- The implementation makes PharosVille more legible as an analytical world, not merely more decorative.
- Every visual cue has a stable source field, failure state, DOM equivalent, and reduced-motion fallback.
- Durable concepts remain landmarks; active stablecoins remain actors; recent or current activity becomes restrained effects; exact values stay in DOM surfaces.
- The asset manifest becomes a complete source of truth for IDs, paths, prompts or prompt references, dimensions, anchors, hitboxes, palette keys, and cache-busting version.
- Motion has an explicit budget and priority model so selection, active work, recent change, and ambient effects do not compete.
- Each encoded cue declares its primary visual channel, and the scene stays inside Pharos' 3-5 primary channel budget wherever possible.
- Building metaphors read as Pharos analytical surfaces first, not lore destinations, and their caveats prevent obvious misreads.
- Empty, small, normal, overloaded, stale, unknown-type, missing-asset, and reduced-motion states are covered by tests or visual smoke checks.

## Handover Takeaways That Best Apply

The ClaudeVille handover should not be copied literally. The useful transfer is its operating contract:

| ClaudeVille principle | PharosVille application |
| --- | --- |
| Bounded world | The stablecoin market as an island-city watched by Pharos. |
| Durable concepts as landmarks | Lighthouse for PSI, chain harbors, cemetery, and data buildings for monitoring surfaces. |
| Active entities as actors | Live stablecoins as ships with stable identity, scale, class, home docks, and risk routes. |
| Events as motion/effects | Mint/burn pressure, freeze events, exit-route depth, yield/source state, dependency concentration, recent supply change, and DEWS escalation. |
| Dense truth in DOM | Detail panel, toolbar, accessibility ledger, route links, source fields, caveats, and future inspectable ledger surfaces. |
| Manifest-first assets | `public/pharosville/assets/manifest.json` plus validation scripts should drive every renderer asset reference. |
| Motion budget | Motion communicates state only; reduced motion is deterministic and information-complete. |
| Validation habits | Asset parity, hit targets, selection sync, overloaded datasets, missing assets, reduced motion, and browser smoke checks. |

## Current PharosVille Fit

PharosVille already implements a large part of the transferable framework:

- Domain state is built through a pure world model in `src/app/pharosville/systems/pharosville-world.ts`.
- Canvas and DOM subscribe to the same `PharosVilleWorld` model through `PharosVilleWorld` and the detail/accessibility components.
- The canvas is responsible for terrain, landmarks, actors, motion, hit testing, depth order, camera, and atmosphere.
- DOM surfaces carry exact labels, facts, links, caveats, members, source fields, and screen-reader parity.
- Assets are manifest-backed, cache-busted by `style.assetVersion`, and validated for existence, dimensions, orphan PNGs, path safety, and placeholder/debug names.
- The route has meaningful visual coverage in `tests/visual/pharosville.spec.ts`, plus unit tests for world construction, hit testing, cue registry, motion, docks, layout, and canvas budget.
- The five thematic data buildings are already modeled in `src/app/pharosville/systems/data-buildings.ts` and rendered with asset sprites plus procedural effects.

The best next design enhancement is therefore not adding another layer of scenery. It is tightening the contracts that make the existing world trustworthy and more readable under load.

## Gaps To Address

1. **No single scenery brief lives beside the implementation.** `docs/pharosville-page.md` documents behavior, but there is no concise domain/scenery/landmark/actor/event/dense-UI brief in the ClaudeVille template shape.
2. **The visual cue registry is descriptive but not yet enforceable enough.** Each cue names the visual/source/DOM equivalent, but tests could also assert every encoded world node kind has a cue and every building cue maps to an existing `BuildingType`.
3. **Motion ownership is still spread across renderer functions.** Ship motion is centralized in `systems/motion.ts`, but building effects, atmosphere, lighthouse flicker, fog, glows, and pulses need a documented cue budget and shared priority rules.
4. **Manifest entries lack per-asset prompt intent and palette keys.** The manifest has style anchor, job IDs, dimensions, anchors, hitboxes, and paths. It does not yet hold the per-asset prompt text/prompt key, semantic role, palette keys, or critical-load rationale that would make asset regeneration safer.
5. **Missing assets do not fail visibly enough during local visual review.** Runtime falls back to procedural drawing for some entities, which is useful for resilience, but development should make manifest/path drift unmistakable.
6. **Relationships are under-expressed.** Ships have dock visits and risk anchors in data, but selection-scoped route/relationship highlighting could make the existing model easier to understand without adding new analytics.
7. **The DOM inspection surface is accurate but flat.** The detail panel is strong enough for parity, but better grouping could expose source/freshness, cue explanation, caveat, members, and route links without adding a new table-like surface.
8. **Validation does not yet cover all ClaudeVille failure modes.** Current coverage is good, but targeted empty/unknown/missing-asset/overloaded building-state, live reduced-motion transition, and full viewport-gate endpoint cases would reduce regressions.

## PharosVille Scenery Brief

Domain: Stablecoin market health and market-structure telemetry across Pharos-tracked assets.

Scenery metaphor: A vigilant maritime observatory island-city. The lighthouse watches systemic stability; harbors reveal chain settlement; ships embody active stablecoins; districts/buildings show major monitoring surfaces; surrounding water encodes risk and uncertainty.

Primary user question: "Where is stablecoin risk, market structure, and recent activity concentrated right now, and which exact Pharos surface should I inspect next?"

Pharos aesthetic boundary: the island-city should remain dark-first, precise, maritime, and analytical. Do not add cozy fantasy-village warmth, decorative lore copy, extra display typography, non-semantic color, generic Web3 glow/glass treatments, or RPG flavor that competes with Pharos' stablecoin-monitoring purpose.

### Landmarks

| Data concept | Landmark | Why this shape | Interaction |
| --- | --- | --- | --- |
| Pharos Stability Index | Lighthouse | Native Pharos metaphor; beam/fire maps to stability and watchfulness | Click opens PSI score, band, source link |
| Chain stablecoin supply | Harbors/docks | Chains are ports where stablecoins settle | Click opens chain supply, health, top cargo |
| Active freeze/blacklist monitoring | Frost Ward Keep | Frozen district separates active intervention from failed assets | Click opens freeze totals, recent events, gaps |
| Mint/burn pressure | Royal Mint And Burn Foundry | Issuance and destruction map naturally to press/furnace | Click opens gauge, volumes, scope caveat |
| Exit liquidity/redemption | Exit Route Gatehouse | Exit capacity maps to locks, gates, ferry routes | Click opens DEX/backstop depth and caveat |
| Yield intelligence | Yield Orchard And Moonwell | Yield is harvest-like but must not imply recommendation | Click opens coverage/source context |
| Dependency risk | Dependency Loom / Chainworks | Dependencies are woven/tensioned links | Click opens direct edges/hub concentration |
| Failed/frozen lifecycle | Cemetery | Memorial treatment already established in Pharos | Click opens cause/date/cemetery link |

Naming rule: these labels may stay stylized, but the detail title, summary, facts, and links must make the analytical surface obvious immediately. The names must never ask users to learn lore before they understand the data.

### Actors

| Entity | Sprite family | Identity cues | Movement behavior |
| --- | --- | --- | --- |
| Active stablecoin | Ship | Hull by governance class, sail logo/symbol, scale by compressed market cap | Slow deterministic water-only route through home docks and risk anchor |
| Long-tail group | Cluster marker | Count, total market cap, risk placement | Static water-zone cluster |
| Chain dock cargo | Dock flags and detail members | Chain logo flag, harbored stablecoins in DOM | Static landmark; selection can highlight associated ships |
| Cemetery entry | Tomb marker | Local cemetery logo, cause-aware marker treatment | Static memorial precinct |

### Events And Effects

| Event/state | Visual cue | Lifetime | Reduced-motion fallback |
| --- | --- | --- | --- |
| PSI band/current score | Lighthouse fire, beam, fog/unlit state | Current snapshot | Static flame/beam color |
| DEWS breadth/severity | Named risk water bands, storm/fog treatment | Current snapshot | Static water tint/zone labels |
| Peg/DEWS stress on coin | Ship risk anchor and route detour | Current snapshot | Ship freezes at representative mooring or risk patrol tile |
| Recent supply move | Wake/effect only for selected/top/recent ships | Current snapshot, capped | Static wake mark or detail fact only |
| Mint-heavy/burn-heavy flow | Press/furnace sparks/smoke | Current window | Static press/furnace glow |
| Freeze activity | Frost rings, cold mist, locks | Current and recent tracker state | Static frost/mist |
| Exit depth/concentration | Gate opening, water level, wheel/lantern | Current snapshot | Static gate/water level |
| Yield source breadth/warning | Orchard glints, well/windmill state | Current snapshot | Static glints/well tint |
| Dependency concentration | Loom threads/gears | Current report-card graph | Static thread arcs |
| Stale or missing source | Data fog/dimmed landmark | Until source recovers | Static fog and explicit DOM stale fact |

### Dense UI Split

Canvas responsibilities:

- Spatial overview, landmark recognition, actor identity, motion, terrain/risk zones, hover/selection targets, camera.

DOM responsibilities:

- Exact values, source fields, caveats, link-outs, members/top rows, freshness, keyboard instructions, screen-reader ledger, and any filtering or inspectable lists.

## Implementation Plan

### Phase 0 - Record The Contract

Goal: Make the PharosVille world contract explicit before further design changes.

Tasks:

- Move the scenery brief above into either `docs/pharosville-page.md` or a new `agents/specs/2026-04-29-pharosville-scenery-brief.md`, then reference it from `docs/pharosville-page.md`.
- Add a short "ClaudeVille transfer boundary" note: reuse contracts and validation habits, not ClaudeVille fantasy-village scenery.
- Add the Pharos aesthetic boundary from this plan: dark-first, precise, semantic color, no cozy/fantasy village warmth, no decorative lore copy, no extra typography system, and no non-semantic palette.
- Document which concepts stay out of the canvas and remain DOM-only until their mapping is clearer.

Files:

- `docs/pharosville-page.md`
- `docs/data-visualization.md`, only if the route-level exception or rule wording changes
- Optional planning artifact under `agents/specs/`

Acceptance:

- A reviewer can map every major world element to a data concept without reading renderer code.
- The doc explicitly preserves the desktop gate, Canvas 2D choice, DOM truth, and no-new-data-source boundary.

### Phase 1 - Harden World And Cue Contracts

Goal: Make encoded visuals auditable from the world model.

Tasks:

- Add a typed cue coverage test that checks:
  - every `BuildingType` has one visual cue;
  - every world node kind in `PharosVilleWorld` has a cue or a documented reason it is structural-only;
  - every cue has `sourceField`, `questionAnswered`, `failureState`, and `domEquivalent`.
- Do not infer cue coverage from cue-id suffixes. Add explicit cue targets, for example `target: { kind: "building"; buildingType }`, or a typed `Record<BuildingType, cueId>` test fixture.
- Document structural exclusions such as `area`, `effect`, and possibly `ship-cluster` when they are grouping/annotation constructs rather than first-class encoded visuals.
- Add a channel-budget field or test fixture for each cue: primary channels should be chosen from position, size, shape, color, motion, glow, and opacity. Color must not be the only load-bearing channel.
- Add source/failure metadata to `BuildingNode` or a parallel registry only where it removes duplication. Avoid broad rewrites if the existing `visualCues` model can carry it.
- Add or strengthen tests for unavailable, stale, malformed, and unknown building inputs.
- Keep `buildPharosVilleWorld()` as the adapter unless an extraction is needed for clarity; do not rename active route files solely for architecture aesthetics.

Likely files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `src/app/pharosville/systems/pharosville-world.test.ts`
- `src/app/pharosville/systems/data-buildings.ts`

Acceptance:

- `npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts src/app/pharosville/systems/pharosville-world.test.ts`
- No visual cue exists without DOM parity.
- No building state depends on color alone.
- Cue coverage is explicit and typed; suffix/string matching is not the mechanism.

### Phase 2 - Refine Landmark Legibility

Goal: Make the current landmarks read as distinct Pharos data surfaces at far, medium, and close inspection distances.

Tasks:

- Review the five data-building sprites in-browser at the default, zoomed-out, and fullscreen camera states.
- For each building, verify three-distance identity:
  - far: silhouette/placement;
  - medium: accent/effect;
  - close: detail panel title/facts/members.
- Add an analytical legibility check: a reviewer should be able to distinguish category, current state, and severity/attention level without relying only on tooltip/detail copy.
- Tune only the most ambiguous landmarks. Prefer procedural effect adjustments before regenerating PNGs.
- Ensure building statuses do not imply investment advice or complete coverage. Preserve caveats such as configured issuance-chain scope, modeled exits, and yield non-recommendation.
- Add misread prevention to building acceptance checks:
  - Exit Route Gatehouse must not imply guaranteed executable liquidity.
  - Yield Orchard must not imply a recommendation or safety ranking.
  - Dependency Loom must not imply full transitive exposure.
  - Mint/Burn Foundry must not imply complete all-chain issuance/redemption coverage.
  - Frost Ward Keep must distinguish observed freeze events from full issuer-control exposure.
- If the map reads crowded, do not add more buildings. Reduce effects, shift non-critical districts, or gate lower-priority effects to selection.

Recommended priority:

1. Frost Ward Keep and Mint/Burn Foundry because they are visually distinct and semantically sharp.
2. Exit Route Gatehouse because the data is important but easy to overclaim.
3. Dependency Loom because thread clutter can become noisy.
4. Yield Orchard because the metaphor must not read as "higher APY is better."

Likely files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `public/pharosville/assets/manifest.json`
- `public/pharosville/assets/buildings/*.png`, only if regeneration is necessary

Acceptance:

- Visual review screenshots at `1440x1000` and fullscreen show identifiable landmarks without label clutter.
- Detail panel caveats remain concise and exact.
- No new page-level design language or non-semantic palette is introduced.

### Phase 3 - Add Selection-Scoped Relationships

Goal: Express relationships already present in the model without cluttering the whole map.

Tasks:

- Derive selected relationship overlays from existing data first. Use `motionPlan.shipRoutes`, selected entity state, `ShipNode.riskTile`, `ShipNode.dockVisits`, and existing dock/ship lists before adding any new world-model relationship type.
- Initial relationship rendering is limited to:
  - selected ship to home dock;
  - selected ship to risk anchor/current route;
  - selected dock to visible ships.
- Keep building member links DOM-only unless a future implementation adds an explicit member-to-world-entity resolver. Do not draw building-to-member canvas lines from `BuildingNode.members` text rows.
- Render relationship lines only on hover/selection. Do not draw all relationships globally.
- Keep relationship geometry water-aware for ship routes. Use existing motion paths where possible.
- Do not add new detail facts unless a specific missing fact is identified; current route facts already include home dock, docking cadence, risk placement, and route source.

Likely files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/components/detail-panel.tsx`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `tests/visual/pharosville.spec.ts`

Acceptance:

- Selecting a ship makes its dock/risk relationship clearer without adding permanent visual noise.
- Selected route rendering uses existing motion-route data rather than duplicating relationship state.
- Reduced motion renders a static route/relationship marker.
- Visual tests confirm selected relationship rendering and no overlap with the detail panel.

### Phase 4 - Create A PharosVille Motion Budget

Goal: Turn the ClaudeVille motion-budget habit into a PharosVille-specific policy.

Tasks:

- Add `agents/specs/2026-04-29-pharosville-motion-budget.md` or a docs section with cue ownership:
  - `static`: terrain, idle buildings, labels, cemetery, low-priority ambience;
  - `slow`: lighthouse sweep/fire, selection ring, route highlight, water shimmer;
  - `medium`: active ship routes, building activity state;
  - `fast`: one-shot/recent effects only, capped and never continuous.
- Keep this primarily a documentation and targeted-test phase. Add a typed registry such as `systems/motion-cues.ts` only if it directly powers assertions or simplifies existing code; do not add it as architecture decoration.
- Audit building effects so every looping effect receives `motion.reducedMotion` or a time value of `0` and avoids per-frame allocations.
- Define priority when selection overlaps with active/recent effects: selection wins, then current risk, then recent change, then ambient.
- Keep normal-motion `requestAnimationFrame` only at the PharosVille shell level; no nested timers inside effect functions.
- Add a live preference transition test for `no-preference -> reduce -> no-preference`, asserting RAF cancellation, frozen samples, and resumed motion.

Likely files:

- `src/app/pharosville/systems/motion.ts`
- Optional `src/app/pharosville/systems/motion-cues.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/reduced-motion-freeze.test.ts`
- `tests/visual/pharosville.spec.ts`

Acceptance:

- Reduced motion has no running RAF loop and still communicates all encoded state.
- Dense worlds do not show competing pulses on the same entity.
- Motion budget is documented and test-covered enough to guide future additions.
- No nested timers or independent animation loops survive the transition into reduced motion.

### Phase 5 - Upgrade Asset Manifest Discipline

Goal: Make sprite regeneration and renderer references safer.

Tasks:

- Add optional v1 metadata fields first. Reserve schema v2 for a future breaking asset-loading change.
- Prefer `promptKey` over full prompt prose in the client-loaded manifest to avoid runtime payload bloat. Store full prompts in an agent spec or asset metadata note when needed.
- Proposed optional v1 fields:
  - `promptKey`;
  - `semanticRole`;
  - `paletteKeys`;
  - `criticalReason` for first-render assets;
  - optional `variants` or `sheet` metadata for future animations.
- Validate renderer/world references against manifest IDs:
  - all dock asset IDs from `chain-docks.ts`;
  - all ship hull asset IDs from `ship-visuals.ts`;
  - all building asset IDs from `data-buildings.ts`;
  - lighthouse and tombstone IDs.
- Add duplicate-content detection if feasible with file hashes, not just duplicate IDs.
- Add a development-only obvious missing-asset marker or debug flag so local visual review catches drift; keep production resilient.
- Split asset readiness into `criticalAssetsLoaded`, `deferredAssetsLoaded`, and `assetLoadErrors`. Deferred failures should use `Promise.allSettled`-style behavior, render procedural fallback plus a dev marker, and not block first render or critical visual tests.
- Keep the asset cap intentional. If animation frames are added, prefer sprite sheets with a sheet contract rather than many standalone manifest entries.
- Bump `style.assetVersion` whenever changed PNGs may be browser-cached.

Likely files:

- `public/pharosville/assets/manifest.json`
- `src/app/pharosville/systems/asset-manifest.ts`
- `src/app/pharosville/renderer/asset-manager.ts`
- `scripts/pharosville/validate-assets.mjs`
- `scripts/check-pharosville-colors.mjs`, if palette rules change

Acceptance:

- `npm run check:pharosville-assets`
- The validator fails on missing referenced asset IDs, orphan PNGs, dimension mismatch, duplicate IDs, unsafe paths, and stale prompt provenance/style version mismatches.
- Regenerating a single asset can be done from manifest instructions without hunting through renderer code.
- Critical assets are independently observable from deferred assets, and a missing deferred asset does not keep the world in a false "not ready" state.

### Phase 6 - Improve DOM Inspection Without Crowding Canvas

Goal: Preserve the Canvas/DOM separation while making the current exact-inspection surface easier to scan.

Tasks:

- Improve the existing detail panel grouping using the current `DetailModel` shape where possible:
  - source/freshness group;
  - encoded visual explanation;
  - top members;
  - caveat;
  - route links.
- Do not add a tabbed/searchable World Ledger in this implementation plan. Treat it as a separate discovery item only if power-user feedback proves the grouped detail panel and screen-reader ledger are insufficient.
- If keyboard-selectable entity browsing becomes a requirement, scope it explicitly as a separate visible DOM feature. The current plan should not claim full keyboard entity selection through an `aria-hidden` canvas.
- Do not place dense labels inside the canvas. Sparse landmark labels and hover/selection affordances only.

Likely files:

- `src/app/pharosville/components/detail-panel.tsx`
- `src/app/pharosville/components/world-toolbar.tsx`
- `src/app/pharosville/pharosville.css`
- `tests/visual/pharosville.spec.ts`

Acceptance:

- Screen-reader ledger parity remains complete for every entity and cue, and toolbar/camera keyboard controls remain functional.
- If keyboard-selectable entity browsing is added later, it is visible, selection-synced, and tested as a distinct feature.
- Canvas remains visually uncluttered at normal and overloaded dataset sizes.
- Detail copy stays concise and does not become methodology prose.

### Phase 7 - Expand Validation And Browser Review

Goal: Cover the failure modes named in the ClaudeVille handover.

Tasks:

- Add or confirm unit/visual coverage for:
  - empty dataset;
  - small dataset;
  - normal fixture;
  - overloaded dataset;
  - unknown governance/classification;
  - stale/missing source groups;
  - missing deferred asset in local/dev mode;
  - every actor/landmark selectable;
  - reduced-motion no-RAF behavior;
  - live reduced-motion preference transitions;
  - hit targets matching visible sprites/assets;
  - no world requests below the viewport gate.
- The viewport-gate request denial must cover every endpoint mounted by `PharosVilleDesktopData`: stablecoins, chains, stability detail, peg summary, stress signals, report cards, mint/burn flows, blacklist summary, DEX liquidity, redemption backstops, yield rankings, plus the manifest, sprites, and logo assets.
- Add a missing deferred asset visual/dev-mode test that waits on critical readiness, not all deferred assets.
- Keep backing-store tests focused on the main canvas until terrain/weather/minimap/offscreen caches exist. Add aggregate backing-store accounting before introducing any new offscreen cache.
- Add browser smoke screenshots for:
  - `1440x1000`;
  - fullscreen/ultrawide;
  - short-screen fallback;
  - reduced motion;
  - normal motion after several seconds.
- Keep pixel checks targeted: nonblank, water/terrain ratio, backing-store budget, and no major overlap with detail panel.

Commands:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
npm test -- src/app/pharosville
npm run test:visual -- tests/visual/pharosville.spec.ts
npm run lint
```

For broader pre-push validation:

```bash
npm run test:merge-gate
```

Acceptance:

- The enhanced world passes targeted tests and visual smoke locally.
- Any intentional screenshot change is reviewed with before/after captures in `agents/screenshots/`.
- Docs updated in the same implementation change when behavior, data mapping, asset contract, or validation expectations change.

## Proposed Sequencing

1. Phase 0 and Phase 1 first. They are low-risk and prevent future visual work from drifting.
2. Phase 4 and Phase 5 second. Motion and assets become harder to fix after more effects are added.
3. Phase 2 and Phase 3 third. Landmark and relationship polish should happen after contracts are enforceable.
4. Phase 6 last, and only if the current detail panel scanability is insufficient after the contract work.
5. Phase 7 runs throughout, with final browser review before handoff.

## Non-Goals

- No ClaudeVille fantasy village motifs.
- No new mobile canvas mode.
- No PixiJS/WebGL or CSP relaxation.
- No new API endpoints or data providers.
- No methodology version bump unless a future implementation changes methodology-visible scoring or semantics, which this plan does not require.
- No asset regeneration unless a specific sprite fails legibility or manifest completeness requirements.
- No global Pharos design-system redesign.

## Documentation Updates For Implementation

Update these when behavior changes:

- `docs/pharosville-page.md` for route contract, world mappings, visual grammar, asset validation, or visual regression expectations.
- `docs/architecture.md` if the route/data/runtime summary changes.
- `docs/data-visualization.md` if PharosVille exception requirements or visualization rules change.
- `docs/design-language.md` only if the live design baseline materially changes.
- `README.md` only if repo map or public route description changes.

## Subagent Review Notes

Three specialized subagents reviewed this plan on 2026-04-29.

UX/metaphor review:

- Validated that the plan applies ClaudeVille at the contract level rather than importing the fantasy-village aesthetic.
- Requested a stricter Pharos aesthetic boundary, a visual channel budget, analytical legibility checks, narrower relationship lines, stronger misread prevention for buildings, and deferral of the World Ledger.

Frontend architecture review:

- Recommended explicit cue targets rather than cue-id suffix matching.
- Recommended deriving selected routes from existing `motionPlan.shipRoutes` and avoiding a new relationship model unless the renderer cannot stay simple.
- Recommended optional manifest v1 metadata rather than schema v2.
- Recommended keeping the motion-budget phase mostly documentary/test-driven and keeping Phase 6 to detail-panel grouping.

Accessibility/performance/validation review:

- Found the viewport-gate test risk: it must deny every endpoint used by `PharosVilleDesktopData`, not just the original core data queries.
- Recommended live reduced-motion preference transition tests.
- Recommended critical/deferred asset readiness separation and deferred failure handling that does not block first render.
- Recommended main-canvas budget checks now, aggregate backing-store accounting only before adding offscreen caches.
